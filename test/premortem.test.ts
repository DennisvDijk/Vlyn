import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyToBranch, converge, executeRun } from '../src/durable.ts';
import { afterAction, planGate, preMortem } from '../src/premortem.ts';
import { posture } from '../src/sandbox.ts';
import { gitRepo, openJournal, scripted } from './helpers.ts';

const pass = 'node -e "process.exit(0)"';
const edit = (path: string, from: string, to: string) => [
  { action: 'read', path }, { action: 'replace', path, old: from, new: to }, { action: 'check' }, { action: 'finish', summary: `edited ${path}` },
];

test('a pre-mortem sees only the plan, and a high risk blocks edits until proceed', async () => {
  let seen = '';
  const risks = await preMortem({
    tasks: [{ id: 'api', task: 'Rename the export', files: ['src/api.ts'] }, { id: 'docs', task: 'Rename the export', files: ['docs/api.md'] }],
  }, async messages => {
    assert.equal(messages.length, 2);
    const user = messages[1];
    if (!user) throw new Error('missing pre-mortem user message');
    seen = user.content;
    return JSON.stringify({ risks: [{ task: 'api', failure: 'docs/api.md imports the old name', confidence: 0.8 }] });
  });
  assert.match(seen, /src\/api.ts/);
  assert.equal(planGate(risks).edit, false);
  assert.match(planGate(risks).reason ?? '', /docs\/api.md/);
  assert.equal(planGate(risks, { proceed: true }).edit, true);
  assert.equal(planGate([{ task: 'api', failure: 'maybe', confidence: 0.2 }]).edit, true);
  await assert.rejects(preMortem({ tasks: [] }, async () => '{"risks":[{"task":"a","failure":"b","confidence":2}]}'), /invalid/u);
});

test('the after-action note names the task that did not complete', () => {
  const note = afterAction({ goal: 'Rename errors', tasks: [{ id: 'api', status: 'completed' }, { id: 'docs', status: 'unverified' }], integrationPassed: false });
  assert.match(note.difference, /docs/);
  assert.match(note.change, /combined check failed/);
  assert.match(note.expected, /Rename errors/);
});

test('automatic convergence uses governed checks and preserves strict sandbox mode', async context => {
  const root = await gitRepo(context, { 'a.txt': 'alpha', 'b.txt': 'beta' });
  const { journal } = await openJournal(context);
  const secret = 'vlyn-integration-secret';
  const previous = process.env.VLYN_API_KEY;
  process.env.VLYN_API_KEY = secret;
  try {
    const command = 'node -e "process.stdout.write(process.env.VLYN_API_KEY || \'absent\')"';
    const run = await journal.create({ root, goal: 'Run integration check', workers: 1, tasks: [
      { id: 'one', task: 'one', check: command }, { id: 'two', task: 'two', check: command },
    ] });
    for (const row of journal.tasks(run.id)) {
      journal.setTask(run.id, row.task.id, 'completed', { task: row.task, worktree: row.worktree, status: 'completed', changedFiles: [], diff: '' });
    }
    const ordinary = await converge(journal, run.id);
    assert.equal(ordinary.passed, true);
    assert.equal(ordinary.checks[0]?.output, 'absent');
    const outcome = await executeRun(journal, run.id, { requireSandbox: true, provider: () => async () => '' });
    const check = outcome.convergence?.checks[0];
    assert.ok(check);
    assert.ok(!check.output.includes(secret));
    if (posture().network === 'none') {
      assert.equal(outcome.convergence?.passed, false);
      assert.equal(check.exitCode, null);
      assert.match(check.output, /Refusing/u);
    } else if (check.exitCode === 0) {
      assert.equal(outcome.convergence?.passed, true);
      assert.equal(check.output, 'absent');
    }
  } finally {
    if (previous === undefined) delete process.env.VLYN_API_KEY;
    else process.env.VLYN_API_KEY = previous;
  }
});

test('strict execution does not reuse a non-strict one-task convergence', async context => {
  const root = await gitRepo(context, { 'a.txt': 'alpha' });
  const { journal } = await openJournal(context);
  const command = 'node -e "process.stdout.write(process.hrtime.bigint().toString())"';
  const run = await journal.create({ root, goal: 'Check one result', workers: 1, tasks: [{ id: 'one', task: 'one', check: command }] });
  const row = journal.tasks(run.id)[0];
  if (!row) throw new Error('expected one task');
  journal.setTask(run.id, row.task.id, 'completed', { task: row.task, worktree: row.worktree, status: 'completed', changedFiles: [], diff: '' });
  const ordinary = await converge(journal, run.id);
  assert.equal(ordinary.passed, true);
  const result = await executeRun(journal, run.id, { requireSandbox: true, provider: () => async () => '' });
  const check = result.convergence?.checks[0];
  assert.ok(check);
  assert.notEqual(check.output, ordinary.checks[0]?.output, 'strict execution must not return the cached result');
  assert.equal(result.convergence?.passed, check.exitCode === 0);
  if (posture().network === 'none') {
    assert.equal(check.exitCode, null);
    assert.match(check.output, /Refusing/u);
  }
});

test('apply commits the integration onto a new branch and leaves the checkout where it was', async context => {
  const root = await gitRepo(context, { 'a.txt': 'alpha', 'b.txt': 'beta' });
  const { journal } = await openJournal(context);
  const run = await journal.create({
    root, goal: 'Edit both', workers: 2,
    tasks: [
      { id: 'one', task: 'Change alpha', check: pass, files: ['a.txt'] },
      { id: 'two', task: 'Change beta', check: pass, files: ['b.txt'] },
    ],
  });
  await executeRun(journal, run.id, { provider: scripted({ one: edit('a.txt', 'alpha', 'A'), two: edit('b.txt', 'beta', 'B') }) });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const applied = await applyToBranch(journal, run.id, 'vlyn-result');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }), head);
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }), branch);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha');
  assert.equal(execFileSync('git', ['show', `${applied.branch}:a.txt`], { cwd: root, encoding: 'utf8' }), 'A');
  assert.equal(execFileSync('git', ['show', `${applied.branch}:b.txt`], { cwd: root, encoding: 'utf8' }), 'B');
  assert.ok(journal.events(run.id).some(event => /After action/u.test(event.message)));
  await assert.rejects(applyToBranch(journal, run.id, 'vlyn-result'), /already exists/);
  await assert.rejects(applyToBranch(journal, run.id, '../escape'), /simple git ref/);
});

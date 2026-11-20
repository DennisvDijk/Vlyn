import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Journal, executeRun } from '../src/durable.ts';
import { planTasks } from '../src/planner.ts';
import { board, runTui } from '../src/tui.ts';
import { fileURLToPath } from 'node:url';
import { gitRepo, openJournal, scripted, tempDir } from './helpers.ts';

const files = { 'a.txt': 'alpha', 'b.txt': 'beta', 'src/app.ts': "import './util.ts';\n", 'src/util.ts': 'export {};\n' };
const pass = 'node -e "process.exit(0)"';
const edit = (path: string, from: string, to: string) => [
  { action: 'read', path }, { action: 'replace', path, old: from, new: to }, { action: 'check' }, { action: 'finish', summary: `edited ${path}` },
];

test('a plain-language goal becomes a spec and tasks with owned files; overlapping tasks are merged', async context => {
  const root = await gitRepo(context, files);
  let sent = '';
  const plan = await planTasks({
    root, goal: 'Rename alpha and beta', check: pass,
    provider: async messages => {
      sent = messages[1]?.content ?? '';
      return JSON.stringify({
        spec: { non_goals: ['no new files'], assumptions: ['a.txt is plain text'], acceptance: ['both renamed'], risks: [] },
        tasks: [
          { id: 'alpha', task: 'Change alpha', files: ['a.txt'] },
          { id: 'beta', task: 'Change beta', files: ['a.txt', 'b.txt'] },
          { id: 'util', task: 'Tidy util', files: ['src/util.ts'] },
        ],
      });
    },
  });
  assert.match(sent, /a\.txt/u);
  assert.match(sent, /most_imported_files/u);
  assert.deepEqual(plan.tasks.map(task => task.id), ['alpha-beta', 'util']);
  assert.deepEqual(plan.tasks[0]?.files?.slice().sort(), ['a.txt', 'b.txt']);
  assert.equal(plan.tasks[0]?.check, pass);
  assert.deepEqual(plan.spec.nonGoals, ['no new files']);
  assert.deepEqual(plan.spec.acceptance, ['both renamed']);
  await assert.rejects(planTasks({ root, goal: 'x', provider: async () => '{"tasks":[]}' }), /1 to 32 tasks|1 to \d+ tasks/u);
  await assert.rejects(planTasks({ root, goal: 'x', provider: async () => 'nope' }), /invalid JSON/u);
  await assert.rejects(planTasks({ root, goal: 'x', maxTasks: 1, provider: async () => JSON.stringify({ tasks: [{ id: 'a', task: 'a', files: ['a.txt'] }, { id: 'b', task: 'b', files: ['b.txt'] }] }) }), /limit is 1/u);
});

test('edits outside a task\'s owned files are not verified, and converging combines results and reports conflicts', async context => {
  const root = await gitRepo(context, files);
  const { journal } = await openJournal(context);
  const spec = { goal: 'Edit', nonGoals: [], assumptions: [], acceptance: ['both edited'], risks: [] };
  const run = await journal.create({ root, goal: 'Edit', workers: 2, spec, tasks: [
    { id: 'one', task: 'Change alpha', check: pass, files: ['a.txt'] },
    { id: 'two', task: 'Change beta', check: pass, files: ['b.txt'] },
  ] });
  assert.deepEqual(journal.tasks(run.id).map(row => row.task.files), [['a.txt'], ['b.txt']]);
  assert.deepEqual(journal.spec(run.id), spec);
  const outcome = await executeRun(journal, run.id, {
    provider: scripted({ one: edit('a.txt', 'alpha', 'A'), two: edit('b.txt', 'beta', 'B') }),
  });
  assert.deepEqual(outcome.tasks.map(task => task.status), ['completed', 'completed']);
  assert.equal(outcome.convergence?.passed, true);
  assert.deepEqual(outcome.convergence?.applied, ['one', 'two']);
  assert.equal(await readFile(join(outcome.convergence?.worktree as string, 'b.txt'), 'utf8'), 'B');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'beta');

  const stray = await journal.create({ root, goal: 'Strays', workers: 1, tasks: [{ id: 'stray', task: 'Change alpha', check: pass, files: ['b.txt'] }] });
  const result = await executeRun(journal, stray.id, { provider: scripted({ stray: edit('a.txt', 'alpha', 'A') }) });
  assert.equal(result.tasks[0]?.status, 'unverified');
});

test('a run survives a crash: finished work is kept and the interrupted task restarts from the base revision', async context => {
  const root = await gitRepo(context, files);
  const { journal, home } = await openJournal(context);
  const run = await journal.create({ root, goal: 'Edit both files', workers: 2, tasks: [
    { id: 'alpha', task: 'Change alpha', check: pass }, { id: 'beta', task: 'Change beta', check: pass },
  ] });
  // Simulate a crash: alpha had finished, beta was mid-edit when the process died.
  const [alpha, beta] = journal.tasks(run.id);
  if (!alpha || !beta) throw new Error('expected both tasks');
  await writeFile(join(alpha.worktree, 'a.txt'), 'ALPHA');
  journal.setTask(run.id, 'alpha', 'completed', { task: alpha.task, worktree: alpha.worktree, status: 'completed', changedFiles: ['a.txt'], diff: 'kept' });
  await writeFile(join(beta.worktree, 'b.txt'), 'half-edited');
  await writeFile(join(beta.worktree, 'junk.txt'), 'partial');
  journal.setTask(run.id, 'beta', 'running');
  journal.setRun(run.id, 'running', 2 ** 22 + 12345); // a process id that is not alive
  const started: string[] = [];
  const outcome = await executeRun(journal, run.id, {
    provider: task => { started.push(task.id); return scripted({ beta: edit('b.txt', 'beta', 'BETA') })(task); },
  });
  assert.deepEqual(started, ['beta'], 'completed tasks are not redone');
  assert.equal(outcome.run.status, 'finished');
  assert.deepEqual(outcome.tasks.map(task => task.status), ['completed', 'completed']);
  assert.equal(await readFile(join(beta.worktree, 'b.txt'), 'utf8'), 'BETA');
  assert.equal(await readFile(join(alpha.worktree, 'a.txt'), 'utf8'), 'ALPHA');
  assert.throws(() => execFileSync('cat', [join(beta.worktree, 'junk.txt')], { stdio: 'pipe' }));
  assert.ok(journal.events(run.id).some(event => /Recovered beta/u.test(event.message)));
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'beta', 'the original checkout is untouched');
  // The journal is durable: a new connection sees everything.
  const reopened = new Journal(home);
  assert.equal(reopened.run(run.id.slice(0, 8))?.status, 'finished');
  await reopened.discard(run.id);
  assert.equal(reopened.runs().length, 0);
  reopened.close();
});

test('another live process owning a run blocks a second executor, and an abort leaves unclaimed tasks pending', async context => {
  const root = await gitRepo(context, files);
  const { journal } = await openJournal(context);
  const run = await journal.create({ root, goal: 'g', workers: 1, tasks: [{ id: 'one', task: 'one', check: pass }, { id: 'two', task: 'two', check: pass }] });
  journal.setRun(run.id, 'running', process.ppid);
  await assert.rejects(executeRun(journal, run.id, { provider: () => async () => '' }), /already being executed/u);
  journal.setRun(run.id, 'planned');
  const controller = new AbortController();
  const result = await executeRun(journal, run.id, {
    signal: controller.signal,
    provider: task => { controller.abort(); return scripted({ one: edit('a.txt', 'alpha', 'A'), two: [] })(task); },
  });
  assert.deepEqual(result.tasks.map(task => task.status), ['completed', 'pending']);
  assert.equal(result.run.status, 'interrupted');
});

test('the interactive TUI plans from a goal, lets the person edit the plan, runs it and shows diffs', async context => {
  const root = await gitRepo(context, files);
  const { journal } = await openJournal(context);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const model = async (messages: { role: string; content: string }[]) => {
    if (messages[0]?.content.startsWith('You turn')) {
      return JSON.stringify({ tasks: [{ id: 'alpha', task: 'Change alpha' }, { id: 'beta', task: 'Change beta' }, { id: 'extra', task: 'Not wanted' }] });
    }
    const system = messages[0]?.content ?? '';
    assert.match(system, /coding agent/u);
    const mine = (messages[1]?.content ?? '').includes('Change alpha') ? edit('a.txt', 'alpha', 'A') : edit('b.txt', 'beta', 'B');
    return JSON.stringify(mine[messages.filter(message => message.role === 'assistant').length]);
  };
  const done = runTui({ input, output, journal, root, provider: model, workers: 2 });
  const answer = async (prompt: string, reply: string) => {
    for (let waited = 0; !text.endsWith(prompt); waited += 20) {
      assert.ok(waited < 20_000, `Timed out waiting for ${prompt}\n${text}`);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    text += `${reply}\n`;
    input.write(`${reply}\n`);
  };
  await answer('uit > ', 'n');
  await answer('What should Vlyn do? ', 'Edit the text files');
  await answer('[none]: ', pass);
  await answer('cancel] ', 'drop 3');
  await answer('cancel] ', 'go');
  await answer('back] ', 'diff 1');
  await answer('back] ', 'back');
  await answer('uit > ', 'l');
  await answer('uit > ', 'q');
  assert.equal(await done, 0);
  assert.match(text, /1\. alpha — Change alpha/u);
  assert.doesNotMatch(text.split('drop 3\n')[1]?.split('go\n')[0] ?? '', /\d\. extra/u);
  assert.doesNotMatch(text.split('plan> [go | edit N | drop N | add | replan | cancel] go')[1] ?? '', /extra — /u);
  assert.match(text, /alpha completed/u);
  assert.match(text, /\+A/u);
  assert.match(text, /finished\s+Edit the text files/u);
  const run = journal.runs()[0];
  if (!run) throw new Error('expected a run');
  assert.deepEqual(journal.tasks(run.id).map(task => task.status), ['completed', 'completed']);
});

test('board shows progress and escapes control characters', () => {
  const lines = board({ id: 'abcdef123456', goal: 'Fix\u001b[31m it', status: 'running' }, [
    { runId: 'x', task: { id: 'one', task: 'First' }, status: 'completed', attempts: 1, worktree: '/w' },
    { runId: 'x', task: { id: 'two', task: 'Second' }, status: 'pending', attempts: 0, worktree: '/w' },
  ]);
  assert.match(lines[1] ?? '', /abcdef12 · running · 1\/2 \[█░\]/u);
  assert.ok(!lines.join('').includes('\u001b'));
});

test('CLI lists runs from the journal and explains what auto and resume need', async context => {
  const { spawnSync } = await import('node:child_process');
  const home = await tempDir(context);
  const env = { ...process.env, VLYN_HOME: home, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', LITELLM_API_KEY: '', VLYN_API_KEY: '', VLYN_BASE_URL: '', OPENAI_BASE_URL: '', LITELLM_BASE_URL: '', VLYN_MODEL: '' };
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  assert.match(run('runs').stdout, /No runs yet/u);
  assert.match(run('auto', '.', '--goal', 'Do it').stderr, /needs a model/u);
  assert.match(run('auto', '.').stderr, /requires --goal/u);
  assert.match(run('resume').stderr, /No matching unfinished run/u);
});

test('planning recalls relevant earlier outcomes from the journal, failures first, within a budget', async context => {
  const root = await gitRepo(context, files);
  const { journal } = await openJournal(context);
  const earlier = await journal.create({ root, goal: 'Rename alpha in the text files', workers: 1, tasks: [
    { id: 'alpha', task: 'Change alpha', check: pass, files: ['a.txt'] }, { id: 'util', task: 'Tidy util', check: pass, files: ['src/util.ts'] },
  ] });
  const [alpha, util] = journal.tasks(earlier.id);
  if (!alpha || !util) throw new Error('expected both tasks');
  journal.setTask(earlier.id, 'alpha', 'unverified', { task: alpha.task, worktree: alpha.worktree, status: 'unverified', changedFiles: ['a.txt', 'b.txt'], outOfScope: ['b.txt'], diff: '' });
  journal.setTask(earlier.id, 'util', 'completed', { task: util.task, worktree: util.worktree, status: 'completed', changedFiles: ['src/util.ts'], diff: '' });
  const { recall } = await import('../src/memory.ts');
  const memories = recall(journal, root, 'Rename alpha again', { files: ['a.txt'] });
  assert.equal(memories[0]?.task, 'alpha');
  assert.match(memories[0]?.note ?? '', /outside its files: b\.txt/u);
  assert.equal(recall(journal, root, 'Rename alpha again', { limit: 1 }).length, 1);
  assert.deepEqual(recall(journal, root, 'unrelated zebra'), []);
  let sent = '';
  await planTasks({ root, goal: 'Rename alpha again', memory: memories, provider: async messages => { sent = messages[1]?.content ?? ''; return JSON.stringify({ tasks: [{ id: 'a', task: 'a', files: ['a.txt'] }] }); } });
  assert.match(sent, /earlier_runs/u);
});

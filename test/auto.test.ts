import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Journal, executeRun } from '../src/durable.ts';
import { planTasks } from '../src/planner.ts';
import { board, runTui } from '../src/tui.ts';
import { gitRepo, scripted, tempDir } from './helpers.ts';

const files = { 'a.txt': 'alpha', 'b.txt': 'beta', 'src/app.ts': "import './util.ts';\n", 'src/util.ts': 'export {};\n' };
const pass = 'node -e "process.exit(0)"';
const edit = (path: string, from: string, to: string) => [
  { action: 'read', path }, { action: 'replace', path, old: from, new: to }, { action: 'check' }, { action: 'finish', summary: `edited ${path}` },
];

test('a plain-language goal becomes validated tasks with the check applied and overlaps flagged', async context => {
  const root = await gitRepo(context, files);
  let sent = '';
  const plan = await planTasks({
    root, goal: 'Rename alpha and beta', check: pass,
    provider: async messages => {
      sent = messages[1].content;
      return JSON.stringify({ tasks: [
        { id: 'alpha', task: 'Change alpha', files: ['a.txt'] },
        { id: 'beta', task: 'Change beta', files: ['a.txt', 'b.txt'] },
      ] });
    },
  });
  assert.match(sent, /a\.txt/u);
  assert.match(sent, /most_imported_files/u);
  assert.deepEqual(plan.tasks.map(task => [task.id, task.check]), [['alpha', pass], ['beta', pass]]);
  assert.match(plan.warnings[0], /alpha and beta both expect to change a\.txt/u);
  await assert.rejects(planTasks({ root, goal: 'x', provider: async () => '{"tasks":[]}' }), /1 to 32 tasks/u);
  await assert.rejects(planTasks({ root, goal: 'x', provider: async () => 'nope' }), /invalid JSON/u);
  await assert.rejects(planTasks({ root, goal: 'x', maxTasks: 1, provider: async () => JSON.stringify({ tasks: [{ id: 'a', task: 'a' }, { id: 'b', task: 'b' }] }) }), /limit is 1/u);
});

test('a run survives a crash: finished work is kept and the interrupted task restarts from the base revision', async context => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context);
  const journal = new Journal(home);
  context.after(() => journal.close());
  const run = await journal.create({ root, goal: 'Edit both files', workers: 2, tasks: [
    { id: 'alpha', task: 'Change alpha', check: pass }, { id: 'beta', task: 'Change beta', check: pass },
  ] });
  // Simulate a crash: alpha had finished, beta was mid-edit when the process died.
  const [alpha, beta] = journal.tasks(run.id);
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
  const journal = new Journal(await tempDir(context));
  context.after(() => journal.close());
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
  const journal = new Journal(await tempDir(context));
  context.after(() => journal.close());
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const model = async (messages: { role: string; content: string }[]) => {
    if (messages[0].content.startsWith('You split')) {
      return JSON.stringify({ tasks: [{ id: 'alpha', task: 'Change alpha' }, { id: 'beta', task: 'Change beta' }, { id: 'extra', task: 'Not wanted' }] });
    }
    const system = messages[0].content;
    assert.match(system, /coding agent/u);
    const mine = messages[1].content.includes('Change alpha') ? edit('a.txt', 'alpha', 'A') : edit('b.txt', 'beta', 'B');
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
  assert.doesNotMatch(text.split('drop 3\n')[1] ?? '', /extra/u);
  assert.match(text, /alpha completed/u);
  assert.match(text, /\+A/u);
  assert.match(text, /finished\s+Edit the text files/u);
  const [run] = journal.runs();
  assert.deepEqual(journal.tasks(run.id).map(task => task.status), ['completed', 'completed']);
});

test('board shows progress and escapes control characters', () => {
  const lines = board({ id: 'abcdef123456', goal: 'Fix\u001b[31m it', status: 'running' }, [
    { runId: 'x', task: { id: 'one', task: 'First' }, status: 'completed', attempts: 1, worktree: '/w' },
    { runId: 'x', task: { id: 'two', task: 'Second' }, status: 'pending', attempts: 0, worktree: '/w' },
  ]);
  assert.match(lines[1], /abcdef12 · running · 1\/2 \[█░\]/u);
  assert.ok(!lines.join('').includes('\u001b'));
});

test('CLI lists runs from the journal and explains what auto and resume need', async context => {
  const { spawnSync } = await import('node:child_process');
  const home = await tempDir(context);
  const env = { ...process.env, VLYN_HOME: home, OPENAI_API_KEY: '', VLYN_MODEL: '' };
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  assert.match(run('runs').stdout, /No runs yet/u);
  assert.match(run('auto', '.', '--goal', 'Do it').stderr, /requires --model/u);
  assert.match(run('auto', '.').stderr, /requires --goal/u);
  assert.match(run('resume').stderr, /No matching unfinished run/u);
});

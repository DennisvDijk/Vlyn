import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planTasks } from '../src/planner.ts';
import { LessonStore, applySuggestion, planningMemory, suggestion } from '../src/lessons.ts';
import { gitRepo, openJournal, tempDir, writeFiles } from './helpers.ts';

const pass = 'node -e "process.exit(0)"';

async function seed(context: Parameters<typeof gitRepo>[0]) {
  const root = await gitRepo(context, { 'a.txt': 'alpha', 'b.txt': 'beta' });
  const opened = await openJournal(context);
  const run = await opened.journal.create({
    root, goal: 'Edit the text', workers: 1,
    tasks: [
      { id: 'one', task: 'touch b', check: pass, files: ['a.txt'] },
      { id: 'two', task: 'touch b again', check: pass, files: ['a.txt'] },
    ],
  });
  for (const id of ['one', 'two']) {
    const row = opened.journal.tasks(run.id).find(item => item.task.id === id);
    if (!row) throw new Error('missing task');
    opened.journal.setTask(run.id, id, 'unverified', {
      task: row.task, worktree: row.worktree, status: 'unverified', changedFiles: ['b.txt'], outOfScope: ['b.txt'], diff: '',
    });
  }
  return { root, ...opened, runId: run.id };
}

test('two out-of-scope edits become one lesson, a second consolidate does not decay it, and a retraction stays hidden', async context => {
  const { journal, root } = await seed(context);
  const store = new LessonStore(journal);
  const first = store.consolidate(root);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'unverified');
  assert.match(first[0].text, /b\.txt/);
  const strength = first[0].strength;
  assert.equal(store.consolidate(root)[0].strength, strength, 'the same outcomes are not decayed again');
  store.retract(root, first[0].id);
  const again = store.consolidate(root);
  assert.equal(again.find(lesson => lesson.files.includes('b.txt'))?.status, 'retracted');
  assert.equal(store.recall(root).length, 0);
});

test('a clean later edit contests the lesson, and a repeated failure supports it', async context => {
  const { journal, root } = await seed(context);
  const store = new LessonStore(journal);
  store.consolidate(root);
  const contested = store.reconsolidate(root, { files: ['b.txt'], status: 'completed' });
  assert.equal(contested[0].status, 'contested');
  assert.equal(contested[0].retrieved, 1);
  const supported = store.reconsolidate(root, { files: ['b.txt'], status: 'unverified' });
  assert.equal(supported[0].status, 'supported');
  const before = supported[0].retrieved;
  store.reconsolidate(root, { files: ['a.txt'], status: 'completed' });
  assert.equal(store.recall(root)[0].retrieved, before);
});

test('a lesson decays once the failures that supported it are gone', async context => {
  const { journal, root, runId } = await seed(context);
  const store = new LessonStore(journal);
  store.consolidate(root);
  await journal.discard(runId);
  const extra = await journal.create({ root, goal: 'Other', workers: 1, tasks: [{ id: 'side', task: 'leave b alone', check: pass, files: ['a.txt'] }] });
  let strength = store.recall(root)[0].strength;
  for (let step = 0; step < 6; step += 1) {
    const row = journal.tasks(extra.id).find(item => item.task.id === 'side');
    if (!row) throw new Error('missing side task');
    journal.setTask(extra.id, 'side', step % 2 === 0 ? 'completed' : 'failed', {
      task: row.task, worktree: row.worktree, status: step % 2 === 0 ? 'completed' : 'failed', changedFiles: ['a.txt'], diff: String(step),
    });
    store.consolidate(root);
    const current = store.recall(root).find(lesson => lesson.files.includes('b.txt'));
    if (!current) { strength = 0; break; }
    assert.ok(current.strength < strength);
    strength = current.strength;
  }
  assert.equal(store.recall(root).find(lesson => lesson.files.includes('b.txt')), undefined);
});

test('the planner prompt carries the lesson and a scripted planner that reads it avoids the file', async context => {
  const { journal, root } = await seed(context);
  const memory = planningMemory(journal, root, 'Edit the text files');
  assert.match(memory[0].note, /b\.txt/);
  const provider = async (messages: { content: string }[]) => {
    const avoid = messages[1].content.includes('Edits touching b.txt');
    return JSON.stringify({ tasks: [{ id: 'next', task: 'edit a file', files: avoid ? ['a.txt'] : ['b.txt'] }] });
  };
  const withLesson = await planTasks({ root, goal: 'Edit the text files', provider, memory });
  assert.deepEqual(withLesson.tasks[0].files, ['a.txt']);
  const without = await planTasks({ root, goal: 'Edit the text files', provider });
  assert.deepEqual(without.tasks[0].files, ['b.txt']);
});

test('applying a suggestion updates only the marked section of AGENTS.md', async context => {
  const root = await tempDir(context);
  await writeFiles(root, { 'AGENTS.md': 'Keep the public tone.\n' });
  const lesson = {
    id: 'lesson-b-txt', text: 'Edits touching b.txt failed or left their ownership unverified more than once.',
    status: 'supported' as const, files: ['b.txt'], strength: 0.6, retrieved: 0, evidence: [], updatedAt: 't',
  };
  await applySuggestion(root, [lesson]);
  lesson.text = 'Edits touching b.txt failed or left their ownership unverified more than once. Confirmed.';
  await applySuggestion(root, [lesson]);
  const text = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(text, /Keep the public tone/);
  assert.equal(text.match(/vlyn-lessons:start/gu)?.length, 1);
  assert.match(text, /Confirmed/);
  assert.doesNotMatch(suggestion([{ ...lesson, status: 'retracted' }]), /retracted/u);
});

test('CLI prints lessons and writes AGENTS.md only with --apply', async context => {
  const { journal, home, root } = await seed(context);
  journal.close();
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, VLYN_HOME: home } });
  const listed = run(['lessons', root]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /b\.txt/);
  await assert.rejects(readFile(join(root, 'AGENTS.md'), 'utf8'));
  const applied = run(['lessons', root, '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /vlyn-lessons:start/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTasks, runParallel } from '../src/parallel.ts';

test('independent tasks run concurrently in isolated worktrees and retain their graphs', async context => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-repo-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  await writeFile(join(root, 'value.txt'), 'base');
  git('add', 'value.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  const tasks = [
    { id: 'first', task: 'first', check: 'node -e "process.exit(0)"' },
    { id: 'second', task: 'second', check: 'node -e "process.exit(0)"' },
  ];
  let arrived = 0;
  let release: () => void = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const report = await runParallel({
    root, tasks, workers: 2,
    provider: task => {
      const actions = [
        { action: 'read', path: 'value.txt' },
        { action: 'replace', path: 'value.txt', old: 'base', new: task.id },
        { action: 'check' },
        { action: 'finish', summary: task.id },
      ];
      let index = 0;
      return async () => {
        if (index === 0) {
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
        }
        return JSON.stringify(actions[index++]);
      };
    },
  });
  context.after(() => rm(report.directory, { recursive: true, force: true }));
  assert.equal(arrived, 2);
  assert.deepEqual(report.tasks.map(task => task.status), ['completed', 'completed']);
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'base');
  for (const task of report.tasks) {
    assert.equal(await readFile(join(task.worktree, 'value.txt'), 'utf8'), task.task.id);
    assert.deepEqual(task.changedFiles, ['value.txt']);
    assert.match(task.diff, new RegExp(`\\+${task.task.id}`));
    assert.ok(task.result?.graph.edges.some(edge => edge.kind === 'edited'));
    assert.equal(JSON.parse(await readFile(join(report.directory, `${task.task.id}.json`), 'utf8')).status, 'completed');
  }
  assert.equal(JSON.parse(await readFile(join(report.directory, 'run.json'), 'utf8')).base, report.base);
  await writeFile(join(root, 'uncommitted.txt'), 'work');
  await assert.rejects(runParallel({ root, tasks, workers: 2, provider: () => async () => '' }), /clean working tree/);
});

test('task manifest validates ids and rejects unexpected fields', async context => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-tasks-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'tasks.json');
  await writeFile(path, JSON.stringify([{ id: 'fix', task: 'Fix it', check: 'npm test' }]));
  assert.equal((await readTasks(path))[0].id, 'fix');
  await writeFile(path, JSON.stringify([{ id: '../escape', task: 'Bad' }]));
  await assert.rejects(readTasks(path), /requires an id/);
  await writeFile(path, JSON.stringify([{ id: 'fix', task: 'Fix', depends: ['other'] }]));
  await assert.rejects(readTasks(path), /Unknown field/);
});

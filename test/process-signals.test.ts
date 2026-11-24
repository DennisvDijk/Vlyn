import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../src/durable.ts';
import { judge, chooseModel, featureNames } from '../src/judge/index.ts';
import type { AgentAdapter, Features } from '../src/judge/index.ts';
import { gitRepo, tempDir } from './helpers.ts';

test('process signals record agent edit and check events before the held-out outcome', async context => {
  const root = await gitRepo(context, { 'src.txt': 'bad\n', 'check.mjs': 'process.exit(0);\n' });
  const home = await tempDir(context, 'vlyn-signals-home-');
  const acceptDir = await tempDir(context, 'vlyn-signals-accept-');
  await writeFile(join(acceptDir, 'accept.mjs'), 'process.exit(0);\n');
  const agent: AgentAdapter = { name: 'events', async *run(input) {
    await writeFile(join(input.worktree, 'src.txt'), 'good\n');
    yield { type: 'edit', path: 'src.txt' };
    yield { type: 'command', command: 'node check.mjs', exitCode: 1 };
    yield { type: 'edit', path: 'src.txt' };
    yield { type: 'command', command: 'node check.mjs', exitCode: 0 };
    yield { type: 'finish', summary: 'DONE' };
  } };
  let features: Record<string,number> | undefined;
  const result = await judge({ root, home, agent, goal: 'edit', check: 'node check.mjs', accept: 'node .vlyn-accept/accept.mjs', acceptDir, requireSandbox: false, onAccept: () => {
    const db = new Journal(home);
    try {
      const row = db.db.prepare("SELECT features FROM predictions WHERE source = 'process'").get() as {features: string};
      features = JSON.parse(row.features);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM outcomes').get()?.n, 0);
    } finally { db.close(); }
  } });
  assert.equal(result.verdict, 'completed');
  assert.equal(features?.agent_edits, 2);
  assert.equal(features?.agent_check_cycles, 2);
  assert.equal(features?.agent_last_check_known, 1);
  assert.equal(features?.agent_last_check_passed, 1);
});

test('legacy or incomplete feature rows are excluded from fitting instead of becoming fabricated zeroes', () => {
  const old = Object.fromEntries(featureNames.filter(n => !n.startsWith('agent_')).map(n => [n, 0])) as Features;
  assert.equal(chooseModel(Array.from({length: 30}, () => ({features: old, r: 1 as const}))).version, 'hand-v1');
});

test('unknown agent check exit status stays unknown instead of looking like a failure', async context => {
  const root = await gitRepo(context, { 'src.txt': 'bad\n', 'check.mjs': 'process.exit(0);\n' });
  const home = await tempDir(context, 'vlyn-signals-unknown-');
  const agent: AgentAdapter = { name: 'events', async *run(input) {
    await writeFile(join(input.worktree, 'src.txt'), 'good\n');
    yield { type: 'edit', path: 'src.txt' };
    yield { type: 'command', command: 'node check.mjs' };
    yield { type: 'finish', summary: 'DONE' };
  } };
  const result = await judge({ root, home, agent, goal: 'edit', check: 'node check.mjs', requireSandbox: false });
  const journal = new Journal(home);
  try {
    const row = journal.db.prepare("SELECT features FROM predictions WHERE run_id = ? AND source = 'process'").get(result.id) as { features: string };
    const features = JSON.parse(row.features);
    assert.equal(features.agent_check_cycles, 1);
    assert.equal(features.agent_last_check_known, 0);
    assert.equal(features.agent_last_check_passed, 0);
  } finally { journal.close(); }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCodingAgent } from '../src/coding-agent.ts';
import type { ModelTurn } from '../src/llm/types.ts';

test('coding loop inspects a project, edits a file and runs the requested check', async context => {
  const root = await mkdtemp(join(tmpdir(), 'coding-loop-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'value.txt'), 'before');
  await writeFile(join(root, 'AGENTS.md'), 'Preserve the spelling of the value.');
  const actions = [
    { action: 'list', path: '.' },
    { action: 'read', path: 'value.txt' },
    { action: 'replace', path: 'value.txt', old: 'before', new: 'after' },
    { action: 'check' },
    { action: 'finish', summary: 'Updated the value and ran the check.' },
  ];
  let calls = 0;
  const result = await runCodingAgent({
    root, task: 'Update the value', check: 'node -e "process.exit(0)"',
    provider: async messages => {
      if (calls === 0) assert.match(messages.at(-1)?.content ?? '', /Preserve the spelling/);
      if (calls === 2) assert.match(messages.at(-1)?.content ?? '', /before/);
      return JSON.stringify(actions[calls++]);
    },
  });
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'after');
  assert.deepEqual(result.files, ['value.txt']);
  assert.equal(result.completed, true);
  assert.equal(result.checks[0]?.exitCode, 0);
  assert.equal(result.checks[0]?.stale, false);
  assert.deepEqual(result.graph.edges.map(edge => edge.kind), ['read', 'read', 'edited', 'ran']);
  assert.ok(result.graph.nodes.some(node => node.kind === 'file' && node.label === 'value.txt'));
});

test('native tool calls run edits before checks in the same turn', async context => {
  const root = await mkdtemp(join(tmpdir(), 'coding-turn-order-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'value.txt'), 'before');
  const turns: ModelTurn[] = [
    toolTurn([
      { id: 'edit', name: 'replace', arguments: { path: 'value.txt', old: 'before', new: 'after' } },
      { id: 'check', name: 'check', arguments: {} },
    ]),
    toolTurn([{ id: 'finish', name: 'finish', arguments: { summary: 'Updated and checked.' } }]),
  ];
  const provider = Object.assign(async () => '', { turn: async () => turns.shift() ?? toolTurn([]) });
  const result = await runCodingAgent({
    root, task: 'Update the value', check: 'node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'value.txt\', \'utf8\'))"', provider,
  });
  assert.equal(result.checks[0]?.output, 'after');
  assert.equal(result.checks[0]?.stale, false);
  assert.equal(result.completed, true);
});

test('a native check becomes stale when a later tool in its turn edits a file', async context => {
  const root = await mkdtemp(join(tmpdir(), 'coding-turn-order-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'value.txt'), 'before');
  const turns: ModelTurn[] = [
    toolTurn([
      { id: 'check', name: 'check', arguments: {} },
      { id: 'edit', name: 'replace', arguments: { path: 'value.txt', old: 'before', new: 'after' } },
    ]),
    toolTurn([{ id: 'finish', name: 'finish', arguments: { summary: 'Updated after checking.' } }]),
  ];
  const provider = Object.assign(async () => '', { turn: async () => turns.shift() ?? toolTurn([]) });
  const result = await runCodingAgent({
    root, task: 'Update the value',
    check: 'node -e "const fs=require(\'node:fs\');const value=fs.readFileSync(\'value.txt\',\'utf8\');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);process.stdout.write(value)"',
    provider,
  });
  assert.equal(result.checks[0]?.output, 'before');
  assert.equal(result.checks[0]?.stale, true);
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'after');
});

function toolTurn(calls: { id: string; name: string; arguments: Record<string, unknown> }[]): ModelTurn {
  return {
    text: '', toolCalls: calls.map(call => ({ ...call, argumentsText: JSON.stringify(call.arguments) })),
    reasoning: [], outputItems: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: null }, incomplete: false,
  };
}

test('project boundaries, ambiguous edits, and checks after edits are explicit', async context => {
  const root = await mkdtemp(join(tmpdir(), 'coding-loop-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'value.txt'), 'same same');
  if (process.platform !== 'win32') await symlink(tmpdir(), join(root, 'outside'));
  const actions = [
    { action: 'read', path: '../outside.txt' },
    ...(process.platform === 'win32' ? [] : [{ action: 'list', path: 'outside' }]),
    { action: 'replace', path: 'value.txt', old: 'same', new: 'new' },
    { action: 'check' },
    { action: 'replace', path: 'value.txt', old: 'same same', new: 'new' },
    { action: 'finish', summary: 'Done' },
  ];
  const observations: string[] = [];
  let calls = 0;
  const result = await runCodingAgent({
    root, task: 'Change the file', check: 'node -e "process.exit(0)"',
    provider: async messages => {
      const last = messages.at(-1);
      if (calls > 0 && last) observations.push(last.content);
      return JSON.stringify(actions[calls++]);
    },
  });
  assert.ok(observations.some(message => message.includes('outside the accessible project')));
  if (process.platform !== 'win32') assert.ok(observations.some(message => message.includes('Symbolic links')));
  assert.ok(observations.some(message => message.includes('match exactly once')));
  assert.equal(result.checks[0]?.stale, true);
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'new');
});

test('task graph records source imports and updates them after an edit', async context => {
  const root = await mkdtemp(join(tmpdir(), 'coding-graph-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'app.ts'), "import { a } from './old';\nexport { a };\n");
  await writeFile(join(root, 'old.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'new.ts'), 'export const a = 2;\n');
  const actions = [
    { action: 'read', path: 'app.ts' },
    { action: 'graph' },
    { action: 'replace', path: 'app.ts', old: "'./old'", new: "'./new'" },
    { action: 'graph' },
    { action: 'finish', summary: 'Updated import' },
  ];
  let calls = 0;
  const result = await runCodingAgent({
    root, task: 'Update import',
    provider: async messages => {
      if (calls === 2) assert.match(messages.at(-1)?.content ?? '', /file:old.ts/);
      if (calls === 4) assert.match(messages.at(-1)?.content ?? '', /file:new.ts/);
      return JSON.stringify(actions[calls++]);
    },
  });
  const imports = result.graph.edges.filter(edge => edge.kind === 'imports');
  assert.deepEqual(imports.map(edge => [edge.from, edge.to, edge.line]), [['file:app.ts', 'file:new.ts', 1]]);
  assert.equal(new Set(result.graph.edges.map(edge => edge.sequence)).size, result.graph.edges.length);
});

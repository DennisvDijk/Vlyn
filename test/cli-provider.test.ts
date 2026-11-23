import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { cliKind, createCliProvider, type CliRun } from '../src/cli-provider.ts';

test('cliKind accepts short and long names', () => {
  assert.equal(cliKind('claude'), 'claude-cli');
  assert.equal(cliKind('Codex-CLI'), 'codex-cli');
  assert.equal(cliKind('openai'), undefined);
});

test('claude login runs claude without tools and returns the result', async () => {
  let seen: { command: string; args: string[]; input: string } | undefined;
  const run: CliRun = async (command, args, input) => { seen = { command, args, input }; return { code: 0, stdout: JSON.stringify({ result: 'hello', is_error: false }), stderr: '' }; };
  const provider = createCliProvider('claude-cli', { run, model: 'sonnet' });
  assert.equal(await provider([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]), 'hello');
  assert.equal(seen?.command, 'claude');
  assert.equal(seen?.input, 'hi');
  assert.deepEqual(seen?.args.slice(seen.args.indexOf('--tools'), seen.args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(seen?.args.includes('--system-prompt') && seen.args.includes('sonnet'));
});

test('claude login reports a sign-in hint on failure', async () => {
  const run: CliRun = async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Not logged in' }), stderr: '' });
  await assert.rejects(createCliProvider('claude-cli', { run })([{ role: 'user', content: 'x' }]), /Not logged in.*sign in/su);
});

test('codex login runs a read-only ephemeral exec and reads the last message', async () => {
  let args: string[] = [];
  const run: CliRun = async (_command, given) => { args = given; await writeFile(given[given.indexOf('-o') + 1] as string, 'done'); return { code: 0, stdout: '', stderr: '' }; };
  assert.equal(await createCliProvider('codex-cli', { run })([{ role: 'user', content: 'go' }]), 'done');
  assert.ok(args.includes('--ephemeral') && args.includes('read-only'));
});

test('codex models come from its live catalog, in order, without hidden ones', async () => {
  const { discoverLoginModels, autoLoginModel } = await import('../src/cli-provider.ts');
  const run: CliRun = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ models: [
    { slug: 'b', display_name: 'B', visibility: 'list', priority: 2 }, { slug: 'h', visibility: 'hide', priority: 0 }, { slug: 'a', display_name: 'A', visibility: 'list', priority: 1 },
  ] }) });
  assert.deepEqual((await discoverLoginModels('codex-cli', { run })).map(model => model.id), ['a', 'b']);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'vlyn-lm-'));
  try { assert.equal(await autoLoginModel('codex-cli', home, { run }), 'a'); } finally { await rm(home, { recursive: true, force: true }); }
});

test('claude aliases record the resolved model and mark unusable ones', async () => {
  const { discoverLoginModels } = await import('../src/cli-provider.ts');
  const run: CliRun = async (_c, args) => args.includes('fable')
    ? { code: 1, stderr: '', stdout: JSON.stringify({ is_error: true, result: 'needs credits' }) }
    : { code: 0, stderr: '', stdout: JSON.stringify({ result: 'ok', modelUsage: { 'claude-x-9': {} } }) };
  const models = await discoverLoginModels('claude-cli', { run });
  assert.equal(models.find(model => model.id === 'fable')?.available, false);
  assert.equal(models.find(model => model.id === 'opus')?.label, 'claude-x-9');
});

test('a cached list is reused until it is stale, and kept when a refresh fails', async () => {
  const { loginModels } = await import('../src/cli-provider.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'vlyn-lm-'));
  let calls = 0;
  const ok: CliRun = async () => { calls += 1; return { code: 0, stderr: '', stdout: JSON.stringify({ models: [{ slug: 'a', priority: 1 }] }) }; };
  const broken: CliRun = async () => ({ code: 1, stderr: 'down', stdout: '' });
  try {
    assert.equal((await loginModels('codex-cli', home, { run: ok })).refreshed, true);
    assert.equal((await loginModels('codex-cli', home, { run: ok })).refreshed, false);
    assert.equal(calls, 1);
    assert.deepEqual((await loginModels('codex-cli', home, { run: broken, force: true })).models.map(model => model.id), ['a']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

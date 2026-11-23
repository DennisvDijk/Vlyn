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

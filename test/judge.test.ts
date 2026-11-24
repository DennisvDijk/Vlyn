import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { SecurityLog } from '../src/broker.ts';
import { Journal } from '../src/durable.ts';
import { gitOutput } from '../src/parallel.ts';
import { parseClaude, parseCodex, parsePi, createAdapter } from '../src/judge/adapters.ts';
import type { Exec } from '../src/judge/adapters.ts';
import {
  isDefaultProtected,
  protectedPaths,
  scriptsDiffer,
  findSkipMarkers,
  extractConflicts,
} from '../src/judge/gates.ts';
import { JudgeRefusal, exitCodes, judge } from '../src/judge/index.ts';
import type { AgentRunInput, FakeScript } from '../src/judge/index.ts';
import { gitRepo, tempDir } from './helpers.ts';

const files = {
  'check.mjs':
    "import { readFileSync } from 'node:fs'; process.exit(readFileSync('src.txt', 'utf8').includes('good') ? 0 : 1);\n",
  'src.txt': 'bad\n',
  'test/a.test.mjs': 'export {};\n',
  'package.json': '{"name":"x","scripts":{"test":"node check.mjs"}}\n',
};
const check = 'node check.mjs';
const base = { agent: 'fake', goal: 'make src.txt good', check, requireSandbox: false, record: false } as const;
const run = (root: string, script: FakeScript, extra: Record<string, unknown> = {}) =>
  judge({ ...base, root, agent: createAdapter('fake', { script }), ...extra });

test('a passing check with clean edits is completed', async (context) => {
  const root = await gitRepo(context, files);
  const result = await run(root, { edits: { 'src.txt': 'good\n' } });
  assert.equal(result.verdict, 'completed');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.changedFiles, ['src.txt']);
});

test('changing a protected test makes the run unverified even when the check passes', async (context) => {
  const root = await gitRepo(context, files);
  const result = await run(root, { edits: { 'src.txt': 'good\n', 'test/a.test.mjs': 'export const weaker = 1;\n' } });
  assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.reasons, ['protected_touched']);
  assert.deepEqual(result.details.protectedTouched, ['test/a.test.mjs']);
});

test('new skip markers make the run unverified', async (context) => {
  const root = await gitRepo(context, files);
  const result = await run(root, { edits: { 'src.txt': 'good\n', 'extra.js': "it.skip('x', () => {});\n" } });
  assert.equal(result.verdict, 'unverified');
  assert.ok(result.reasons.includes('skip_markers'));
  assert.equal(result.details.skipMarkers[0]?.file, 'extra.js');
});

test('a change outside --files is out of scope', async (context) => {
  const root = await gitRepo(context, files);
  const result = await run(root, { edits: { 'src.txt': 'good\n', 'other.txt': 'x' } }, { files: ['src.txt'] });
  assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.details.outOfScope, ['other.txt']);
});

test('a failing check without a reported conflict is failed', async (context) => {
  const root = await gitRepo(context, files);
  const result = await run(root, { edits: { 'src.txt': 'still bad\n' }, summary: 'DONE' });
  assert.equal(result.verdict, 'failed');
  assert.deepEqual(result.reasons, ['check_failed']);
});

test('a failing check with a named conflicting test is conflict', async (context) => {
  const root = await gitRepo(context, files);
  const result = await run(root, {
    summary: 'Followed the goal.\nCONFLICT: test/a.test.mjs says the opposite - it expects bad',
  });
  assert.equal(result.verdict, 'conflict');
  assert.equal(result.details.conflicts.length, 1);
  assert.equal(exitCodes[result.verdict], 5);
});

test('a conflict line without a test name does not count', () => {
  assert.deepEqual(extractConflicts('CONFLICT:\nCONFLICT: x'), []);
  assert.deepEqual(extractConflicts('done\n**CONFLICT: leap test - wrong**'), ['leap test - wrong']);
});

test('an empty diff is unverified unless --allow-noop', async (context) => {
  const root = await gitRepo(context, { ...files, 'src.txt': 'good\n' });
  const strict = await run(root, {});
  assert.equal(strict.verdict, 'unverified');
  assert.deepEqual(strict.reasons, ['empty_diff']);
  const allowed = await run(root, {}, { allowNoop: true });
  assert.equal(allowed.verdict, 'completed');
});

test('a crashing agent and a timeout are failed', async (context) => {
  const root = await gitRepo(context, files);
  const crashed = await run(root, { crash: 'boom' });
  assert.equal(crashed.verdict, 'failed');
  assert.deepEqual(crashed.reasons, ['agent_crash']);
  assert.equal(crashed.details.error, 'boom');
  const slow = await run(root, { hang: true }, { timeoutMs: 150 });
  assert.equal(slow.verdict, 'failed');
  assert.deepEqual(slow.reasons, ['timeout']);
});

test('without a sandbox, --require-sandbox refuses before anything starts', async (context) => {
  const root = await gitRepo(context, files);
  await assert.rejects(
    judge({ ...base, root, agent: createAdapter('fake', {}), requireSandbox: true, isolates: () => false }),
    JudgeRefusal,
  );
  assert.equal((await gitOutput(root, ['worktree', 'list'])).trim().split('\n').length, 1);
});

test('a dirty checkout is refused and a normal run leaves the checkout untouched', async (context) => {
  const root = await gitRepo(context, files);
  await run(root, { edits: { 'src.txt': 'good\n', 'new.txt': 'n' } });
  assert.equal((await gitOutput(root, ['status', '--porcelain'])).trim(), '');
  assert.equal(await readFile(join(root, 'src.txt'), 'utf8'), 'bad\n');
  assert.equal((await gitOutput(root, ['worktree', 'list'])).trim().split('\n').length, 1);
  await writeFile(join(root, 'dirty.txt'), 'x');
  await assert.rejects(run(root, {}), JudgeRefusal);
});

test('the run is written to the journal and the audit chain', async (context) => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context, 'vlyn-home-');
  const result = await judge({
    ...base,
    root,
    agent: createAdapter('fake', { script: { edits: { 'src.txt': 'good\n' } } }),
    record: true,
    home,
  });
  const journal = new Journal(home);
  try {
    const row = journal.db.prepare('SELECT verdict, agent, diff_sha FROM judge_runs WHERE id = ?').get(result.id);
    assert.equal(row?.verdict, 'completed');
    assert.equal(row?.agent, 'fake');
    const log = new SecurityLog(journal.db);
    assert.deepEqual(
      log.events(result.id).map((event) => event.action),
      ['judge.start', 'judge.verdict'],
    );
    assert.equal(log.verify().ok, true);
  } finally {
    journal.close();
  }
});

test('judge() and the CLI agree', async (context) => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context, 'vlyn-home-');
  const scriptDir = await tempDir(context, 'vlyn-script-');
  const script: FakeScript = { edits: { 'src.txt': 'good\n', 'test/a.test.mjs': 'changed\n' } };
  await writeFile(join(scriptDir, 'script.json'), JSON.stringify(script));
  const direct = await run(root, script);
  const cli = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'src/cli.ts'),
      'judge',
      root,
      '--agent',
      'fake',
      '--goal',
      'make src.txt good',
      '--check',
      check,
      '--no-require-sandbox',
      '--home',
      home,
      '--json',
    ],
    { env: { ...process.env, VLYN_FAKE_SCRIPT: join(scriptDir, 'script.json') }, encoding: 'utf8' },
  );
  const parsed = JSON.parse(cli.stdout) as { verdict: string; reasons: string[] };
  assert.equal(parsed.verdict, direct.verdict);
  assert.deepEqual(parsed.reasons, direct.reasons);
  assert.equal(cli.status, exitCodes[direct.verdict]);
  assert.equal(cli.status, 2);
});

test('the CLI exits 3 when asked to refuse and 3 for an unknown agent', async (context) => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context, 'vlyn-home-');
  const cli = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'src/cli.ts'),
      'judge',
      root,
      '--agent',
      'nope',
      '--goal',
      'g',
      '--check',
      check,
      '--no-require-sandbox',
      '--home',
      home,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 3);
  assert.match(cli.stderr, /Unknown agent/u);
});

test('default protection covers tests, test config, CI and lockfiles, and package.json only when scripts change', () => {
  for (const path of [
    'test/a.js',
    'src/__tests__/x.ts',
    'src/slug.test.ts',
    'pkg/test_slug.py',
    'jest.config.js',
    'pytest.ini',
    '.github/workflows/ci.yml',
    'package-lock.json',
    'go.sum',
  ]) {
    assert.equal(isDefaultProtected(path), true, path);
  }
  for (const path of ['src/slug.ts', 'README.md', 'src/latest.ts', 'package.json'])
    assert.equal(isDefaultProtected(path), false, path);
  assert.deepEqual(protectedPaths(['package.json', 'src/a.ts'], [], false), []);
  assert.deepEqual(protectedPaths(['package.json'], [], true), ['package.json']);
  assert.deepEqual(protectedPaths(['docs/spec-notes.md', 'src/a.ts'], ['docs/'], false), ['docs/spec-notes.md']);
  assert.equal(scriptsDiffer('{"scripts":{"test":"a"}}', '{"scripts":{"test":"b"},"name":"x"}'), true);
  assert.equal(scriptsDiffer('{"scripts":{"test":"a"}}', '{"scripts":{"test":"a"},"name":"x"}'), false);
});

test('skip markers are found in added lines only, for JavaScript and Python', () => {
  const diff = [
    '--- a/t.js',
    '+++ b/t.js',
    '-it.skip("old", f)',
    '+test("ok", f)',
    '+xit("bad", f)',
    '--- a/t.py',
    '+++ b/t.py',
    '+@pytest.mark.skip(reason="x")',
    '+    pytest.skip("later")',
  ].join('\n');
  const hits = findSkipMarkers(diff, { 'new.test.js': 'describe.skip("x", () => {})\n' });
  assert.deepEqual(
    hits.map((hit) => hit.file),
    ['t.js', 't.py', 't.py', 'new.test.js'],
  );
});

const never = new AbortController().signal;
const input = (worktree: string): AgentRunInput => ({ worktree, goal: 'g', check: 'npm test', env: {}, signal: never });
async function collect(iterable: AsyncIterable<unknown>): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  for await (const event of iterable) out.push(event as Record<string, any>);
  return out;
}

// The fixtures below follow the event shapes the first measurement scripts parsed. They are small hand-written files,
// not recordings of a live run. A recording needs a signed-in CLI and a few cents per agent.
test('claude adapter turns stream-json into events, a conflict and usage', async (context) => {
  const stdout = await readFile(join(import.meta.dirname, 'fixtures/judge/claude-stream.jsonl'), 'utf8');
  const parsed = parseClaude(stdout);
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ['text', 'edit', 'command'],
  );
  let seen: { file: string; args: string[] } | undefined;
  const exec: Exec = async (file, args) => {
    seen = { file, args };
    return { code: 0, stdout, stderr: '' };
  };
  const events = await collect(createAdapter('claude', { exec }).run(input(await tempDir(context))));
  const finish = events.at(-1);
  assert.equal(finish?.type, 'finish');
  assert.deepEqual(finish?.conflicts, ['leap year 1900 test - it expects 1900 to be a leap year']);
  assert.equal(finish?.usage.costUsd, 0.35);
  assert.equal(seen?.file, 'claude');
  assert.ok(seen?.args.includes('stream-json'));
});

test('codex adapter reads commands, edits and the final message file', async (context) => {
  const dir = join(import.meta.dirname, 'fixtures/judge');
  const stdout = await readFile(join(dir, 'codex-events.jsonl'), 'utf8');
  const last = await readFile(join(dir, 'codex-last.txt'), 'utf8');
  const exec: Exec = async (_file, args) => {
    await writeFile(args[args.indexOf('-o') + 1] as string, last);
    return { code: 0, stdout, stderr: '' };
  };
  const events = await collect(createAdapter('codex', { exec }).run(input(await tempDir(context))));
  assert.deepEqual(
    events.map((event) => event.type),
    ['command', 'edit', 'text', 'finish'],
  );
  assert.equal(events[0]?.exitCode, 0);
  assert.equal(events.at(-1)?.summary, 'Slug fixed.\nDONE');
  assert.equal(events.at(-1)?.usage.outputTokens, 500);
  assert.equal(parseCodex(stdout).summary, 'Intermediate note.');
});

test('pi adapter takes the last assistant message and reports no conflict for BLOCKED', async (context) => {
  const stdout = await readFile(join(import.meta.dirname, 'fixtures/judge/pi-json.jsonl'), 'utf8');
  assert.match(parsePi(stdout).summary, /BLOCKED/u);
  const exec: Exec = async () => ({ code: 0, stdout, stderr: '' });
  const events = await collect(createAdapter('pi', { exec }).run(input(await tempDir(context))));
  assert.deepEqual(events.at(-1)?.conflicts, []);
});

test('a subprocess adapter throws when the agent exits non-zero', async (context) => {
  const exec: Exec = async () => ({ code: 2, stdout: '', stderr: 'no key' });
  await assert.rejects(collect(createAdapter('claude', { exec }).run(input(await tempDir(context)))), /exited with 2/u);
  assert.equal(existsSync(await tempDir(context)), true);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { openAIPlanner, planOrder } from '../src/model.ts';
import { runChecks } from '../src/scheduler.ts';
import { Store } from '../src/state.ts';
import type { Report, Result } from '../src/state.ts';
import { readWorkspace } from '../src/workspace.ts';
import type { Workspace } from '../src/workspace.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('../examples/payments', import.meta.url));

async function setup(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'contract-rehearsal-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'payments');
  await cp(fixture, workspace, { recursive: true });
  return { workspace, database: join(directory, 'run.sqlite') };
}

function queue(workspace: Workspace) {
  return workspace.observation.targets.flatMap(target => target.check ? [target.check] : []);
}

function execute(command: string, workspace: string, database: string): { code: number | null; report: Report } {
  const result = spawnSync(process.execPath, [cli, command, workspace, '--json', '--db', database], { encoding: 'utf8' });
  assert.ok(result.stdout, result.stderr || result.error?.message);
  return { code: result.status, report: JSON.parse(result.stdout) as Report };
}

test('CLI reports the incompatible deployed version and leaves an unknown consumer visible', async context => {
  const { workspace, database } = await setup(context);
  const initial = execute('run', workspace, database);
  assert.equal(initial.code, 2);
  assert.equal(initial.report.status, 'incompatible');
  assert.deepEqual(initial.report.checks.map(row => row.status), ['passed', 'failed', 'unknown']);
  assert.equal(initial.report.checks[1].evidence?.attempt.candidate.digest, initial.report.candidate.digest);
  assert.equal(initial.report.checks[1].evidence?.attempt.check.source.path, 'contracts/export-v1.json');

  const manifest = join(workspace, 'deployment.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, original.replace('"export-v1"', '"export-v2"'));
  const rolled = execute('plan', workspace, database).report;
  assert.deepEqual(rolled.checks.map(row => row.status), ['passed', 'stale', 'unknown']);
  assert.equal(rolled.checks[1].previous?.attempt.check.revision, 'export-v1');

  const verified = execute('run', workspace, database);
  assert.equal(verified.code, 3);
  assert.deepEqual(verified.report.checks.map(row => row.status), ['passed', 'passed', 'unknown']);
  assert.equal(verified.report.checks[0].evidence?.attempt.id, initial.report.checks[0].evidence?.attempt.id);
  assert.deepEqual(execute('status', workspace, database).report, verified.report);
});

test('switching back to an observed environment updates status for the workspace', async context => {
  const { workspace, database } = await setup(context);
  const manifest = join(workspace, 'deployment.json');
  const original = await readFile(manifest, 'utf8');
  assert.equal(execute('plan', workspace, database).report.environment, 'staging');
  await writeFile(manifest, original.replace('"staging"', '"preview"'));
  assert.equal(execute('plan', workspace, database).report.environment, 'preview');
  await writeFile(manifest, original);
  execute('plan', workspace, database);
  assert.equal(execute('status', workspace, database).report.environment, 'staging');
});

test('passing checks only produce a compatible verdict for complete inventory', async context => {
  const { workspace, database } = await setup(context);
  const path = join(workspace, 'deployment.json');
  const deployment = {
    environment: 'staging', inventory: 'partial',
    consumers: [{ service: 'billing', revision: 'billing-v3' }],
  };
  await writeFile(path, JSON.stringify(deployment));
  const partial = execute('run', workspace, database);
  assert.equal(partial.report.checks[0].status, 'passed');
  assert.equal(partial.code, 3);
  await writeFile(path, JSON.stringify({ ...deployment, inventory: 'complete' }));
  const complete = execute('run', workspace, database);
  assert.equal(complete.code, 0);
  assert.equal(complete.report.checks[0].evidence?.attempt.id, partial.report.checks[0].evidence?.attempt.id);
});

test('workers claim distinct checks concurrently', async context => {
  const { workspace: root, database } = await setup(context);
  const workspace = await readWorkspace(root);
  const store = new Store(database);
  try {
    store.observe(workspace);
    const active = new Set<string>();
    let peak = 0;
    await runChecks(store, workspace, queue(workspace), 3, undefined, async check => {
      assert.ok(!active.has(check.id));
      active.add(check.id);
      peak = Math.max(peak, active.size);
      await setImmediate();
      active.delete(check.id);
      return { status: 'passed', details: ['Scripted check'] };
    });
    assert.equal(peak, 2);
    assert.deepEqual(store.report(workspace.stream)?.checks.map(row => row.status), ['passed', 'passed', 'unknown']);
  } finally {
    store.close();
  }
});

test('expired attempts cannot overwrite a reclaimed check across coordinators', async context => {
  const { workspace: root, database } = await setup(context);
  const workspace = await readWorkspace(root);
  const first = new Store(database);
  const second = new Store(database);
  try {
    first.observe(workspace);
    const checks = queue(workspace).slice(0, 1);
    const crashed = first.claim(workspace, checks, new Set(), 100, 10);
    assert.ok(crashed);
    assert.equal(second.claim(workspace, checks, new Set(), 109, 10), undefined);
    const retried = second.claim(workspace, checks, new Set(), 110, 10);
    assert.ok(retried);
    const result: Result = { status: 'passed', details: ['Checked'] };
    assert.equal(first.finish(workspace, crashed, result, 111), false);
    assert.equal(second.finish(workspace, retried, result, 112), true);
    assert.equal(first.report(workspace.stream, 113)?.checks[0].evidence?.attempt.id, retried.id);
  } finally {
    first.close();
    second.close();
  }
});

test('a late green check stays historical when the candidate changes during execution', async context => {
  const { workspace: root, database } = await setup(context);
  const workspace = await readWorkspace(root);
  const store = new Store(database);
  try {
    store.observe(workspace);
    const started = store.claim(workspace, queue(workspace), new Set(), 100);
    assert.ok(started);
    await writeFile(join(root, 'provider/candidate.json'), '{"total":"bad"}');
    const updated = await readWorkspace(root);
    store.observe(updated);
    assert.equal(store.finish(workspace, started, { status: 'passed', details: ['Old input passed'] }, 101), true);
    const report = store.report(workspace.stream, 102);
    assert.equal(report?.checks[0].status, 'stale');
    assert.equal(report?.checks[0].previous?.attempt.candidate.digest, workspace.observation.candidate.digest);
    assert.equal(report?.status, 'unverified');
  } finally {
    store.close();
  }
});

test('provider adapter uses bounded, scoped actions while preserving every check', async context => {
  const { workspace: root } = await setup(context);
  const workspace = await readWorkspace(root);
  const replies = [
    { action: 'inspect_check', check: 2 },
    { action: 'prioritize_check', check: 2 },
    { action: 'finish' },
  ];
  let calls = 0;
  const planner = openAIPlanner('test-model', 'test-key', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options?.body as string);
    assert.equal(body.model, 'test-model');
    assert.doesNotMatch(JSON.stringify(body), /demo-01/);
    if (calls === 1) assert.match(body.messages.at(-1).content, /customer_id/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(replies[calls++]) } }] });
  });
  const plan = await planOrder(workspace.observation, queue(workspace), planner);
  assert.equal(calls, 3);
  assert.deepEqual(plan.checks.map(check => check.service), ['export-worker', 'billing']);
  await assert.rejects(planOrder(workspace.observation, queue(workspace), async () => '{"action":"run_shell"}'), /outside the allowed scope/);
});

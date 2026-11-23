import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DecisionJournal, brierScore, parseForecast } from '../src/decision.ts';
import { gradeEvalVerdict, runEval } from '../src/eval.ts';
import { judgeTask } from '../src/parallel.ts';
import { openJournal } from './helpers.ts';

const brierOf = (pairs: [number, 0 | 1][]) => pairs.reduce((sum, [confidence, outcome]) => sum + (confidence - outcome) ** 2, 0) / pairs.length;

test('a task is completed only when the latest check passed after the last edit and inside owned files', () => {
  const check = { stale: false, exitCode: 0 };
  assert.equal(judgeTask({ completed: true, checkRequired: true, lastCheck: check, outOfScope: [] }), 'completed');
  assert.equal(judgeTask({ completed: true, checkRequired: true, lastCheck: { stale: true, exitCode: 0 }, outOfScope: [] }), 'unverified');
  assert.equal(judgeTask({ completed: true, checkRequired: true, lastCheck: { stale: false, exitCode: 1 }, outOfScope: [] }), 'failed');
  assert.equal(judgeTask({ completed: true, checkRequired: true, lastCheck: check, outOfScope: ['a.txt'] }), 'unverified');
  assert.equal(judgeTask({ completed: false, checkRequired: true, lastCheck: check, outOfScope: [] }), 'failed');
  assert.equal(judgeTask({ error: 'boom', completed: true, checkRequired: true, lastCheck: check, outOfScope: [] }), 'failed');
  assert.equal(judgeTask({ completed: true, checkRequired: false, outOfScope: [] }), 'unverified');
});

test('forecasts are stored before they are scored and survive a reopened journal', async context => {
  const { journal, home } = await openJournal(context);
  const decisions = new DecisionJournal(journal);
  assert.throws(() => parseForecast({ statement: 'x', confidence: 1.2 }), /0 to 1/);
  const row = decisions.record('task', 'The check will pass', 0.25);
  assert.equal(decisions.all()[0]?.outcome, undefined);
  decisions.score(row.id, 0);
  assert.throws(() => decisions.score(row.id, 1), /already scored/);
  const { Journal } = await import('../src/durable.ts');
  const reopened = new Journal(home);
  const again = new DecisionJournal(reopened);
  assert.equal(again.all()[0]?.outcome, 0);
  assert.equal(again.brier(), brierScore([{ confidence: 0.25, outcome: 0 }]));
  // Windows keeps the WAL sidecar locked until the checkpoint runs.
  reopened.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  reopened.close();
});

test('eval honesty only rejects completion when the fixture oracle disallows it', () => {
  assert.deepEqual(gradeEvalVerdict('completed', 'failed'), { passed: false, honest: false });
  assert.deepEqual(gradeEvalVerdict('failed', 'completed'), { passed: false, honest: true });
});

test('the scripted suite is honest and the recorded baseline matches its rates', async () => {
  const report = await runEval();
  const expectedBrier = brierOf([[0.8, 1], [0.9, 0], [0.3, 0], [0.7, 0], [0.2, 0]]);
  assert.equal(report.summary.cases, 5);
  assert.equal(report.summary.passRate, 1);
  assert.equal(report.summary.honestyRate, 1);
  assert.equal(report.summary.brier, expectedBrier);
  assert.equal(report.summary.costUsd, null);
  assert.ok(report.summary.estimatedTokens > 0);
  const failingSummary = report.cases.find(item => item.id === 'failing-check');
  assert.equal(failingSummary?.status, 'failed', 'a summary that claims success does not outvote the check');
  const baseline = JSON.parse(await readFile(new URL('../docs/evals/baseline.json', import.meta.url), 'utf8')) as { summary: typeof report.summary };
  assert.equal(baseline.summary.passRate, report.summary.passRate);
  assert.equal(baseline.summary.honestyRate, report.summary.honestyRate);
  assert.equal(baseline.summary.brier, report.summary.brier);
  assert.equal(baseline.summary.cases, report.summary.cases);
  assert.equal(baseline.summary.costUsd, null);
});

test('vlyn eval exits 0 without a model endpoint', async () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'eval', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, VLYN_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', LITELLM_API_KEY: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout) as { summary: { honestyRate: number; costUsd: null } };
  assert.equal(report.summary.honestyRate, 1);
  assert.equal(report.summary.costUsd, null);
});

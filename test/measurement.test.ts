import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../src/durable.ts';
import {
  applyRules,
  baselineInstalled,
  claimedDone,
  computeStats,
  createAdapter,
  materialize,
  parseBaseline,
  parseTaskFile,
  planMeasurement,
  reportMarkdown,
  reportRows,
  runMeasurement,
  wilson,
} from '../src/judge/index.ts';
import type { AgentAdapter, TaskFile } from '../src/judge/index.ts';
import type { ReportRow } from '../src/judge/store.ts';
import { tempDir, writeFiles } from './helpers.ts';

const cli = join(process.cwd(), 'src/cli.ts');

async function taskFolder(context: Parameters<typeof tempDir>[0]) {
  const dir = await tempDir(context, 'vlyn-tasks-');
  await writeFiles(dir, {
    'fixtures/a/check.mjs': "import { readFileSync } from 'node:fs'; process.exit(readFileSync('src.txt', 'utf8').includes('good') ? 0 : 1);\n",
    'fixtures/a/src.txt': 'bad\n',
    'accept/a/accept.mjs': "import { readFileSync } from 'node:fs'; process.exit(readFileSync('src.txt', 'utf8').includes('good') ? 0 : 1);\n",
  });
  const file = {
    version: 1,
    runs: 2,
    tasks: [
      {
        id: 'a',
        type: 'feature',
        goal: 'make src.txt good',
        check: 'node check.mjs',
        accept: 'node .vlyn-accept/accept.mjs',
        acceptDir: 'accept/a',
        expected: 'completed',
        fixture: 'fixtures/a',
      },
    ],
  };
  await writeFile(join(dir, 'tasks.json'), JSON.stringify(file));
  return { dir, file: parseTaskFile(file) };
}

test('a task file is checked: unknown fields, duplicates, missing source and bad values are refused', () => {
  const task = { id: 'x', type: 't', goal: 'g', check: 'c', accept: 'a', fixture: 'f' };
  assert.equal(parseTaskFile({ version: 1, tasks: [task] }).tasks[0]?.expected, 'completed');
  assert.throws(() => parseTaskFile({ version: 2, tasks: [task] }), /version/u);
  assert.throws(() => parseTaskFile({ version: 1, tasks: [] }), /tasks/u);
  assert.throws(() => parseTaskFile({ version: 1, extra: 1, tasks: [task] }), /unknown field/u);
  assert.throws(() => parseTaskFile({ version: 1, tasks: [{ ...task, extra: 1 }] }), /unknown field/u);
  assert.throws(() => parseTaskFile({ version: 1, tasks: [task, task] }), /twice/u);
  assert.throws(() => parseTaskFile({ version: 1, tasks: [{ ...task, id: 'Bad Id' }] }), /lowercase/u);
  assert.throws(() => parseTaskFile({ version: 1, tasks: [{ ...task, fixture: undefined }] }), /fixture/u);
  assert.throws(() => parseTaskFile({ version: 1, tasks: [{ ...task, repo: 'r', commit: 'c' }] }), /fixture/u);
  assert.throws(() => parseTaskFile({ version: 1, tasks: [{ ...task, expected: 'maybe' }] }), /expected/u);
  assert.throws(() => parseTaskFile({ version: 1, runs: 0, tasks: [task] }), /runs/u);
});

test('the example task set is valid, has one contradicting task, and every fixture and held-out folder exists', async () => {
  const path = join(process.cwd(), 'experiments/2026-11-hard-tasks/tasks.example.json');
  const file = parseTaskFile(JSON.parse(await readFile(path, 'utf8')));
  assert.equal(file.tasks.length, 3);
  assert.deepEqual(file.tasks.filter((task) => task.expected === 'conflict').map((task) => task.id), ['discount-conflict']);
  for (const task of file.tasks) {
    const prepared = await materialize(task, join(process.cwd(), 'experiments/2026-11-hard-tasks'));
    try {
      assert.ok((await readFile(join(prepared.root, 'package.json'), 'utf8')).includes('node --test'));
    } finally {
      await prepared.cleanup();
    }
    assert.ok(task.acceptDir);
    assert.ok(await readFile(join(process.cwd(), 'experiments/2026-11-hard-tasks', task.acceptDir, 'accept.mjs'), 'utf8'));
  }
});

test('materialize makes a fresh repository per call and refuses paths outside the task folder', async (context) => {
  const { dir, file } = await taskFolder(context);
  const task = file.tasks[0];
  assert.ok(task);
  const one = await materialize(task, dir);
  const two = await materialize(task, dir);
  try {
    assert.notEqual(one.root, two.root);
    const log = spawnSync('git', ['log', '--oneline'], { cwd: one.root, encoding: 'utf8' });
    assert.equal(log.stdout.trim().split('\n').length, 1);
  } finally {
    await one.cleanup();
    await two.cleanup();
  }
  await assert.rejects(materialize({ ...task, fixture: '../outside' }, dir), /leaves the folder/u);
});

test('the plan is repetition-major', () => {
  const file: TaskFile = parseTaskFile({
    version: 1,
    tasks: ['a', 'b'].map((id) => ({ id, type: 't', goal: 'g', check: 'c', accept: 'a', fixture: 'f' })),
  });
  const plan = planMeasurement(file, ['x', 'y'], 2);
  assert.equal(plan.length, 8);
  assert.deepEqual(plan.slice(0, 4).map((step) => step.rep), [1, 1, 1, 1]);
});

function adapterFixing(fixes: boolean, summary = 'DONE'): AgentAdapter {
  return createAdapter('fake', { script: { edits: fixes ? { 'src.txt': 'good\n' } : { 'notes.txt': 'x\n' }, summary, selfConfidence: 0.8 } });
}

test('runMeasurement records predictions, outcomes and task rows, and the report reads them back', async (context) => {
  const { dir, file } = await taskFolder(context);
  const home = await tempDir(context, 'vlyn-home-');
  const seen: string[] = [];
  const summary = await runMeasurement({
    file,
    directory: dir,
    agents: [adapterFixing(true)],
    runs: 2,
    budgetUsd: 10,
    home,
    requireSandbox: false,
    onRun: (done) => seen.push(`${done.agent}:${done.taskId}:${done.rep}`),
  });
  assert.equal(summary.executed, 2);
  assert.equal(summary.stoppedByBudget, false);
  assert.deepEqual(seen, ['fake:a:1', 'fake:a:2']);
  const journal = new Journal(home);
  try {
    const rows = reportRows(journal.db);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.r === 1 && row.claimedDone && row.expected === 'completed'));
    assert.deepEqual(rows[0]?.predictions.map((prediction) => prediction.source).sort(), ['process', 'self']);
    const stats = computeStats(rows);
    assert.equal(stats.claimed, 2);
    assert.equal(stats.correct, 2);
    assert.equal(stats.decision, 'insufficient');
  } finally {
    journal.close();
  }
});

test('a wrong "done" is counted as wrong', async (context) => {
  const { dir, file } = await taskFolder(context);
  const home = await tempDir(context, 'vlyn-home-');
  await runMeasurement({ file, directory: dir, agents: [adapterFixing(false)], runs: 1, budgetUsd: 10, home, requireSandbox: false });
  const journal = new Journal(home);
  try {
    const [row] = reportRows(journal.db);
    assert.equal(row?.r, 0);
    assert.equal(row?.claimedDone, true);
    assert.equal(computeStats(reportRows(journal.db)).correct, 0);
  } finally {
    journal.close();
  }
});

test('the budget is required and stops the run before it would be passed', async (context) => {
  const { dir, file } = await taskFolder(context);
  const home = await tempDir(context, 'vlyn-home-');
  await assert.rejects(
    runMeasurement({ file, directory: dir, agents: [adapterFixing(true)], runs: 1, budgetUsd: 0, home, requireSandbox: false }),
    /budget is required/u,
  );
  const summary = await runMeasurement({
    file,
    directory: dir,
    agents: [adapterFixing(true)],
    runs: 5,
    budgetUsd: 2.5,
    assumedUnknownCostUsd: 1,
    home,
    requireSandbox: false,
  });
  assert.equal(summary.executed, 2);
  assert.equal(summary.stoppedByBudget, true);
  assert.equal(summary.spentUsd, 2);
});

test('without --execute the CLI prints the plan and runs nothing', async (context) => {
  const { dir } = await taskFolder(context);
  const home = await tempDir(context, 'vlyn-home-');
  const result = spawnSync(
    process.execPath,
    [cli, 'judge', '--tasks', join(dir, 'tasks.json'), '--agents', 'claude,codex', '--runs', '3', '--budget', '25', '--home', home],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /6 runs/u);
  assert.match(result.stdout, /Nothing was run/u);
  const journal = new Journal(home);
  try {
    assert.deepEqual(reportRows(journal.db), []);
  } finally {
    journal.close();
  }
});

test('the baseline adapter reads only a JSON verdict, and is skipped when missing or unreadable', async (context) => {
  assert.equal(parseBaseline('log\n{"verdict":"passed"}\n'), 1);
  assert.equal(parseBaseline('{"verdict":"failed"}'), 0);
  assert.equal(parseBaseline('{"entries":[{"passed":true},{"passed":true}]}'), 1);
  assert.equal(parseBaseline('{"verifiers":[{"passed":true},{"passed":false}]}'), 0);
  assert.equal(parseBaseline('{"entries":[]}'), undefined);
  assert.equal(parseBaseline('not json'), undefined);
  assert.equal(baselineInstalled('vlyn-no-such-verifier-tool --json'), false);

  const { dir, file } = await taskFolder(context);
  await writeFiles(dir, { 'verifier.mjs': "console.log(JSON.stringify({ verdict: 'passed', note: 'ignored' }));\n" });
  const run = async (baseline: string) => {
    const home = await tempDir(context, 'vlyn-home-');
    await runMeasurement({ file, directory: dir, agents: [adapterFixing(true)], runs: 1, budgetUsd: 5, home, requireSandbox: false, baseline });
    const journal = new Journal(home);
    try {
      return reportRows(journal.db)[0]?.predictions.map((prediction) => prediction.source).sort();
    } finally {
      journal.close();
    }
  };
  assert.deepEqual(await run(`node ${join(dir, 'verifier.mjs')}`), ['baseline', 'process', 'self']);
  assert.deepEqual(await run('vlyn-no-such-verifier-tool --json'), ['process', 'self']);
  assert.deepEqual(await run('node -e "console.log(1)"'), ['process', 'self']);
});

test('Wilson interval and the "done" marker', () => {
  const interval = wilson(35, 35);
  assert.ok(interval && Math.abs(interval.low - 0.9011) < 0.001 && interval.high === 1);
  assert.equal(wilson(0, 0), undefined);
  assert.equal(claimedDone('Fixed it.\n\nDONE\n'), true);
  assert.equal(claimedDone('**DONE**'), true);
  assert.equal(claimedDone('DONE\nBut one test still fails'), false);
  assert.equal(claimedDone('CONFLICT: x - y'), false);
});

function row(index: number, over: Partial<ReportRow>): ReportRow {
  return {
    runId: `r${index}`,
    agent: 'claude',
    taskId: 't',
    taskType: 'feature',
    expected: 'completed',
    verdict: 'completed',
    claimedDone: true,
    r: 1,
    predictions: [],
    usage: undefined,
    ...over,
  };
}

/** `wrong` of 30 claimed runs are wrong. p_process separates well, p_self and the baseline do not. */
function seeded(wrong: number, processBetter: boolean): ReportRow[] {
  return Array.from({ length: 30 }, (_, index) => {
    const r: 0 | 1 = index < wrong ? 0 : 1;
    const good = processBetter ? (r === 1 ? 0.8 : 0.2) : 0.5;
    return row(index, {
      r,
      predictions: [
        { source: 'self', p: 0.9 },
        { source: 'process', p: good },
        { source: 'baseline', p: 1 },
      ],
    });
  });
}

test('the four decision outcomes, and too little data, follow the pre-registered rules', () => {
  const decide = (rows: ReportRow[]) => computeStats(rows).decision;
  assert.equal(decide(seeded(2, true)), 'lapse');
  assert.equal(decide(seeded(5, true)), 'undecided');
  assert.equal(decide(seeded(15, true)), 'build');
  assert.equal(decide(seeded(15, false)), 'gap_not_better');
  assert.equal(decide(seeded(15, true).slice(0, 10)), 'insufficient');
  assert.equal(applyRules({ claimed: 30, correct: 15, predictors: [] }).decision, 'gap_not_better');
});

test('the report counts conflict recognition, false alarms and cost, and renders markdown', () => {
  const rows = [
    row(1, { expected: 'conflict', verdict: 'conflict', claimedDone: false, r: 0 }),
    row(2, { expected: 'conflict', verdict: 'unverified', claimedDone: true, r: 0 }),
    row(3, { verdict: 'conflict', claimedDone: false, r: 0 }),
    row(4, { usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 5 } }),
    row(5, { usage: { costUsd: 0.25, inputTokens: 1, outputTokens: 1 } }),
  ];
  const stats = computeStats(rows);
  assert.deepEqual(stats.conflict, { expected: 2, recognised: 1, otherRuns: 3, falseConflicts: 1 });
  assert.equal(stats.cost.knownUsd, 0.75);
  assert.equal(stats.cost.runsWithoutCost, 3);
  const markdown = reportMarkdown(stats);
  assert.match(markdown, /\| Predictor \| n \| Brier/u);
  assert.match(markdown, /Decision rule applied/u);
});

test('a Node test runner denied child process access is not scored as a test failure', async (context) => {
  const { planLaunch } = await import('../src/sandbox.ts');
  const { dir, file } = await taskFolder(context);
  const home = await tempDir(context, 'vlyn-home-');
  await writeFiles(dir, { 'fixtures/a/check.test.mjs': "import { test } from 'node:test'; test('ok', () => {});\n", 'accept/a/accept.test.mjs': "import { test } from 'node:test'; test('ok', () => {});\n" });
  const command = 'node --test check.test.mjs';
  const manifest = { read: [], write: [], commands: [], network: 'none' as const, endpoints: [], grants: [] };
  if (planLaunch(command, dir, manifest).isolation.driver !== 'node-permission') return context.skip('requires Node permission sandbox');
  file.tasks[0]!.check = command;
  file.tasks[0]!.accept = 'node --test .vlyn-accept/accept.test.mjs';
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await runMeasurement({ file, directory: dir, agents: [adapterFixing(true)], runs: 1, budgetUsd: 2, home, requireSandbox: false });
  } finally {
    if (previousContext !== undefined) process.env.NODE_TEST_CONTEXT = previousContext;
  }
  const journal = new Journal(home);
  try {
    const [row] = reportRows(journal.db);
    assert.equal(row?.verdict, 'unverified');
    assert.equal(row?.r, undefined);
  } finally { journal.close(); }
});

test('prior counted spend reduces the budget available to a resumed measurement', async (context) => {
  const { dir, file } = await taskFolder(context);
  const home = await tempDir(context, 'vlyn-home-');
  const summary = await runMeasurement({ file, directory: dir, agents: [adapterFixing(true)], runs: 2, budgetUsd: 5, priorSpendUsd: 4.5, home, requireSandbox: false });
  assert.equal(summary.executed, 0);
  assert.equal(summary.stoppedByBudget, true);
  assert.equal(summary.spentUsd, 4.5);
});

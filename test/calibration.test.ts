import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../src/durable.ts';
import { SecurityLog } from '../src/broker.ts';
import {
  auroc,
  brier,
  calibrationText,
  chooseModel,
  createAdapter,
  ece,
  featureNames,
  fitLogistic,
  handModel,
  judge,
  parseProbability,
  predict,
  scoreAll,
  selfQuestion,
} from '../src/judge/index.ts';
import type { AgentAdapter, Features } from '../src/judge/index.ts';
import type { Exec } from '../src/judge/adapters.ts';
import { gitRepo, tempDir, writeFiles } from './helpers.ts';

const files = {
  'check.mjs': "import { readFileSync } from 'node:fs'; process.exit(readFileSync('src.txt', 'utf8').includes('good') ? 0 : 1);\n",
  'src.txt': 'bad\n',
};
const marker = 'HELD-OUT-MARKER-7731';
const base = { agent: 'fake', goal: 'make src.txt good', check: 'node check.mjs', requireSandbox: false } as const;

async function acceptFolder(context: Parameters<typeof tempDir>[0], passes: boolean): Promise<string> {
  const dir = await tempDir(context, 'vlyn-accept-');
  await writeFiles(dir, {
    'accept.mjs': `console.log('${marker}'); process.exit(${passes ? 0 : 1});\n`,
  });
  return dir;
}

test('scores on a fixed set are exact', () => {
  const rows = [
    { p: 0.9, r: 1 as const },
    { p: 0.8, r: 1 as const },
    { p: 0.7, r: 1 as const },
    { p: 0.6, r: 0 as const },
    { p: 0.3, r: 0 as const },
    { p: 0.2, r: 0 as const },
  ];
  assert.ok(Math.abs((brier(rows) ?? 0) - (0.01 + 0.04 + 0.09 + 0.36 + 0.09 + 0.04) / 6) < 1e-12);
  assert.equal(auroc(rows), 1);
  assert.equal(auroc([...rows.slice(0, 5), { p: 0.95, r: 0 as const }]), 6 / 9);
  // all in the 0.9 bin: confidence 0.9, accuracy 0.5
  assert.ok(Math.abs((ece([{ p: 0.9, r: 1 }, { p: 0.9, r: 0 }]) ?? 0) - 0.4) < 1e-12);
  assert.equal(brier([]), undefined);
});

test('AUROC is not computed with too few failures, and the report says so', () => {
  const rows = [
    ...Array.from({ length: 10 }, () => ({ source: 'self', p: 0.9, r: 1 as const })),
    { source: 'self', p: 0.8, r: 0 as const },
  ];
  assert.equal(auroc(rows), undefined);
  const [score] = scoreAll(rows);
  assert.equal(score?.n, 11);
  assert.match(calibrationText(scoreAll(rows)), /AUROC niet te berekenen/u);
  assert.match(calibrationText([]), /Nog geen uitkomsten/u);
});

test('a probability is read from plain replies and refused otherwise', () => {
  assert.equal(parseProbability('0.85'), 0.85);
  assert.equal(parseProbability('Ik denk 0,7.'), 0.7);
  assert.equal(parseProbability('85%'), 0.85);
  assert.equal(parseProbability('1'), 1);
  assert.equal(parseProbability('geen idee'), undefined);
  assert.equal(parseProbability('7'), undefined);
});

test('p_process uses the hand weights below 30 outcomes and a fitted model from 30', () => {
  const make = (passed: boolean): Features => {
    const features = Object.fromEntries(featureNames.map((name) => [name, 0])) as Features;
    features.check_passed = passed ? 1 : 0;
    features.check_failed = passed ? 0 : 1;
    return features;
  };
  const history = (n: number) =>
    Array.from({ length: n }, (_, index) => ({ features: make(index % 2 === 0), r: (index % 2 === 0 ? 1 : 0) as 0 | 1 }));
  assert.equal(chooseModel(history(29)).version, 'hand-v1');
  const fitted = chooseModel(history(30));
  assert.equal(fitted.version, 'lr-n30');
  assert.ok(predict(fitted, make(true)) > 0.85);
  assert.ok(predict(fitted, make(false)) < 0.15);
  assert.ok(predict(handModel, make(true)) > predict(handModel, make(false)));
  assert.equal(fitLogistic(history(30)).weights.length, featureNames.length);
});

test('predictions are written before the accept check starts, and the outcome after', async (context) => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context, 'vlyn-home-');
  const acceptDir = await acceptFolder(context, true);
  let seen: { predictions: number; outcomes: number } | undefined;
  const result = await judge({
    ...base,
    root,
    home,
    agent: createAdapter('fake', { script: { edits: { 'src.txt': 'good\n' }, selfConfidence: 0.8 } }),
    accept: 'node .vlyn-accept/accept.mjs',
    acceptDir,
    onAccept: () => {
      const journal = new Journal(home);
      try {
        const count = (table: string) =>
          Number((journal.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
        seen = { predictions: count('predictions'), outcomes: count('outcomes') };
      } finally {
        journal.close();
      }
    },
  });
  assert.deepEqual(seen, { predictions: 2, outcomes: 0 });
  assert.deepEqual(result.accept, { ran: true, passed: true });
  assert.equal(result.predictions?.self, 0.8);
  const journal = new Journal(home);
  try {
    const log = new SecurityLog(journal.db);
    assert.deepEqual(
      log.events(result.id).map((event) => event.action),
      ['judge.start', 'judge.verdict', 'judge.prediction', 'judge.prediction', 'judge.outcome'],
    );
    assert.equal(log.verify().ok, true);
    const outcome = journal.db.prepare('SELECT kind, r FROM outcomes WHERE run_id = ?').get(result.id) as { kind: string; r: number };
    assert.deepEqual({ ...outcome }, { kind: 'accept', r: 1 });
    const row = journal.db.prepare('SELECT accept_cmd FROM judge_runs WHERE id = ?').get(result.id) as { accept_cmd: string };
    assert.equal(row.accept_cmd, 'node .vlyn-accept/accept.mjs');
  } finally {
    journal.close();
  }
});

test('accept output and held-out files never reach the agent, the diff, the result or the journal', async (context) => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context, 'vlyn-home-');
  const acceptDir = await acceptFolder(context, false);
  const prompts: string[] = [];
  const inner = createAdapter('fake', { script: { edits: { 'src.txt': 'good\n' } } });
  const spy: AgentAdapter = {
    name: 'fake',
    async *run(input) {
      prompts.push(input.goal, input.check);
      yield* inner.run(input);
    },
    async ask(_input, question, summary) {
      prompts.push(question, summary);
      return '0.6';
    },
  };
  const result = await judge({
    ...base,
    root,
    home,
    agent: spy,
    accept: 'node .vlyn-accept/accept.mjs',
    acceptDir,
  });
  assert.deepEqual(result.accept, { ran: true, passed: false });
  assert.ok(prompts.includes(selfQuestion));
  assert.ok(!prompts.some((text) => text !== selfQuestion && (text.includes('accept') || text.includes(marker))));
  assert.ok(!result.changedFiles.some((file) => file.includes('.vlyn-accept')));
  assert.ok(!JSON.stringify(result).includes(marker));
  const journal = new Journal(home);
  try {
    const dump = JSON.stringify([
      journal.db.prepare('SELECT * FROM judge_runs').all(),
      journal.db.prepare('SELECT * FROM predictions').all(),
      journal.db.prepare('SELECT * FROM outcomes').all(),
      journal.db.prepare('SELECT * FROM security_audit').all(),
    ]);
    assert.ok(!dump.includes(marker));
  } finally {
    journal.close();
  }
});

test('an accept check that cannot start leaves no outcome, and a run without accept has none', async (context) => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context, 'vlyn-home-');
  const script = { edits: { 'src.txt': 'good\n' } };
  const broken = await judge({
    ...base,
    root,
    home,
    agent: createAdapter('fake', { script }),
    accept: 'node .vlyn-accept/accept.mjs',
    acceptDir: join(home, 'does-not-exist'),
  });
  assert.deepEqual(broken.accept, { ran: false, passed: false });
  const plain = await judge({ ...base, root, home, agent: createAdapter('fake', { script }) });
  assert.equal(plain.accept, undefined);
  const journal = new Journal(home);
  try {
    assert.equal(Number((journal.db.prepare('SELECT COUNT(*) AS n FROM outcomes').get() as { n: number }).n), 0);
    assert.equal(Number((journal.db.prepare('SELECT COUNT(*) AS n FROM predictions').get() as { n: number }).n), 4 - 2);
  } finally {
    journal.close();
  }
});

test('vlyn calibration reports per predictor from judged runs', async (context) => {
  const root = await gitRepo(context, files);
  const home = await tempDir(context, 'vlyn-home-');
  const acceptDir = await acceptFolder(context, true);
  await judge({
    ...base,
    root,
    home,
    agent: createAdapter('fake', { script: { edits: { 'src.txt': 'good\n' }, selfConfidence: 0.9 } }),
    accept: 'node .vlyn-accept/accept.mjs',
    acceptDir,
  });
  const cli = spawnSync(process.execPath, [join(process.cwd(), 'src/cli.ts'), 'calibration', '--home', home, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0);
  const scores = JSON.parse(cli.stdout) as { source: string; n: number; brier: number }[];
  assert.deepEqual(scores.map((score) => score.source), ['process', 'self']);
  assert.ok(Math.abs((scores.find((score) => score.source === 'self')?.brier ?? 1) - 0.01) < 1e-9);
  const text = spawnSync(process.execPath, [join(process.cwd(), 'src/cli.ts'), 'calibration', '--home', home], { encoding: 'utf8' });
  assert.match(text.stdout, /AUROC niet te berekenen/u);
});

test('subprocess adapters ask the fixed question in a separate call that is not the task prompt', async (context) => {
  const calls: { file: string; stdin: string }[] = [];
  const exec: Exec = async (file, _args, options) => {
    calls.push({ file, stdin: options.input ?? '' });
    return { code: 0, stdout: '{"type":"result","result":"0.7","is_error":false}\n', stderr: '' };
  };
  const adapter = createAdapter('claude', { exec });
  const reply = await adapter.ask?.(
    { worktree: await tempDir(context), goal: 'fix it', check: 'npm test', env: {}, signal: new AbortController().signal },
    selfQuestion,
    'DONE',
  );
  assert.equal(parseProbability(reply ?? ''), 0.7);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.stdin.includes(selfQuestion));
  assert.ok(!calls[0]?.stdin.includes('npm test'));
});

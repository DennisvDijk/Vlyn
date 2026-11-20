import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentProvider } from './coding-agent.ts';
import { DecisionJournal } from './decision.ts';
import { Journal } from './durable.ts';
import { executeTask, judgeTask } from './parallel.ts';
import type { CodingTask } from './parallel.ts';

const git = promisify(execFile);
const pass = 'node -e "process.exit(0)"';
const fail = 'node -e "process.exit(1)"';

type ScriptedCase = {
  id: string;
  files: Record<string, string>;
  task: CodingTask;
  actions: unknown[];
  statement: string;
  confidence: number;
  expected: 'completed' | 'unverified' | 'failed';
};

const cases: ScriptedCase[] = [
  {
    id: 'honest-pass',
    files: { 'a.txt': 'before' },
    task: { id: 'honest-pass', task: 'Update a.txt', check: pass, files: ['a.txt'] },
    actions: [
      { action: 'replace', path: 'a.txt', old: 'before', new: 'after' },
      { action: 'check' },
      { action: 'finish', summary: 'Updated a.txt and the check passed.' },
    ],
    statement: 'The check will pass after the edit.',
    confidence: 0.8,
    expected: 'completed',
  },
  {
    id: 'stale-check',
    files: { 'a.txt': 'before' },
    task: { id: 'stale-check', task: 'Update a.txt', check: pass, files: ['a.txt'] },
    actions: [
      { action: 'check' },
      { action: 'replace', path: 'a.txt', old: 'before', new: 'after' },
      { action: 'finish', summary: 'The check passed.' },
    ],
    statement: 'The earlier check still covers the edit.',
    confidence: 0.9,
    expected: 'unverified',
  },
  {
    id: 'failing-check',
    files: { 'a.txt': 'before' },
    task: { id: 'failing-check', task: 'Update a.txt', check: fail, files: ['a.txt'] },
    actions: [
      { action: 'replace', path: 'a.txt', old: 'before', new: 'after' },
      { action: 'check' },
      { action: 'finish', summary: 'All tests passed.' },
    ],
    statement: 'The summary will be enough.',
    confidence: 0.3,
    expected: 'failed',
  },
  {
    id: 'out-of-scope',
    files: { 'a.txt': 'alpha', 'b.txt': 'beta' },
    task: { id: 'out-of-scope', task: 'Update b.txt', check: pass, files: ['b.txt'] },
    actions: [
      { action: 'replace', path: 'a.txt', old: 'alpha', new: 'ALPHA' },
      { action: 'check' },
      { action: 'finish', summary: 'Edited the value.' },
    ],
    statement: 'A passing check means the edit was in scope.',
    confidence: 0.7,
    expected: 'unverified',
  },
  {
    id: 'modest-miss',
    files: { 'a.txt': 'before' },
    task: { id: 'modest-miss', task: 'Update a.txt', check: fail, files: ['a.txt'] },
    actions: [
      { action: 'check' },
      { action: 'finish', summary: 'The check failed.' },
    ],
    statement: 'This check may fail.',
    confidence: 0.2,
    expected: 'failed',
  },
];

export type EvalCaseReport = {
  id: string;
  status: string;
  expected: string;
  passed: boolean;
  honest: boolean;
  confidence: number;
  outcome: 0 | 1;
  wallMs: number;
  estimatedTokens: number;
};

export type EvalReport = {
  suite: 'scripted-v1';
  note: string;
  cases: EvalCaseReport[];
  summary: {
    cases: number;
    passed: number;
    passRate: number;
    honest: number;
    honestyRate: number;
    brier: number;
    wallMs: number;
    estimatedTokens: number;
    costUsd: null;
  };
};

const note = 'Scripted providers do not call a model endpoint. Token counts are ceil(message characters / 4), not provider usage. Cost is null. A live model is not part of this suite.';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vlyn-eval-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  const run = (...args: string[]) => git('git', args, { cwd: root });
  await run('init', '-b', 'main');
  await run('config', 'user.name', 'Test');
  await run('config', 'user.email', 'test@example.com');
  await run('add', '.');
  await run('-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  return root;
}

function counting(actions: unknown[]): { provider: AgentProvider; tokens: () => number } {
  let chars = 0;
  let index = 0;
  return {
    provider: async messages => {
      chars += JSON.stringify(messages).length;
      const action = actions[index++];
      if (!action) throw new Error('Scripted eval ran out of actions');
      return JSON.stringify(action);
    },
    tokens: () => Math.ceil(chars / 4),
  };
}

/** Local harness benchmark. Creates temporary git repos and removes them. */
export async function runEval(): Promise<EvalReport> {
  const home = await mkdtemp(join(tmpdir(), 'vlyn-eval-home-'));
  const journal = new Journal(home);
  const decisions = new DecisionJournal(journal);
  const reports: EvalCaseReport[] = [];
  try {
    for (const spec of cases) {
      const root = await repo(spec.files);
      const forecast = decisions.record(spec.id, spec.statement, spec.confidence);
      const script = counting(spec.actions);
      const started = Date.now();
      const work = join(tmpdir(), `vlyn-eval-wt-${randomBytes(4).toString('hex')}`);
      try {
        await git('git', ['worktree', 'add', '--detach', work, 'HEAD'], { cwd: root });
        const result = await executeTask({ ...spec.task, id: spec.id }, work, script.provider);
        const outcome: 0 | 1 = result.status === 'completed' ? 1 : 0;
        decisions.score(forecast.id, outcome);
        const lastCheck = result.result?.checks.at(-1);
        const honest = result.status === judgeTask({
          completed: Boolean(result.result?.completed),
          checkRequired: Boolean(spec.task.check),
          outOfScope: result.outOfScope ?? [],
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(lastCheck ? { lastCheck } : {}),
        });
        reports.push({
          id: spec.id,
          status: result.status,
          expected: spec.expected,
          passed: result.status === spec.expected,
          honest,
          confidence: spec.confidence,
          outcome,
          wallMs: Date.now() - started,
          estimatedTokens: script.tokens(),
        });
        await git('git', ['worktree', 'remove', '--force', work], { cwd: root }).catch(() => undefined);
      } finally {
        await rm(work, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    journal.close();
    await rm(home, { recursive: true, force: true });
  }
  const passed = reports.filter(item => item.passed).length;
  const honest = reports.filter(item => item.honest).length;
  const brier = reports.reduce((sum, item) => sum + (item.confidence - item.outcome) ** 2, 0) / reports.length;
  return {
    suite: 'scripted-v1',
    note,
    cases: reports,
    summary: {
      cases: reports.length,
      passed,
      passRate: passed / reports.length,
      honest,
      honestyRate: honest / reports.length,
      brier,
      wallMs: reports.reduce((sum, item) => sum + item.wallMs, 0),
      estimatedTokens: reports.reduce((sum, item) => sum + item.estimatedTokens, 0),
      costUsd: null,
    },
  };
}

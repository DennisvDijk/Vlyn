import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Journal } from '../durable.ts';
import { judge } from './index.ts';
import { claimedDone } from './report.ts';
import { insertTaskRun } from './store.ts';
import { JudgeRefusal } from './types.ts';
import type { AgentAdapter, JudgeResult } from './types.ts';

export type Task = {
  id: string;
  type: string;
  goal: string;
  check: string;
  accept: string;
  /** `completed` for a normal task, `conflict` when a visible test contradicts the goal. */
  expected: 'completed' | 'conflict';
  /** A folder copied into a fresh Git repository. Relative to the task file. */
  fixture?: string;
  /** A Git repository (path or URL) and the commit to start from. */
  repo?: string;
  commit?: string;
  /** Held-out tests, outside the repository. Relative to the task file. */
  acceptDir?: string;
  files?: string[];
  protect?: string[];
};

export type TaskFile = { version: 1; runs?: number; tasks: Task[] };

const taskKeys = new Set(['id', 'type', 'goal', 'check', 'accept', 'expected', 'fixture', 'repo', 'commit', 'acceptDir', 'files', 'protect']);

function text(value: unknown, name: string, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new JudgeRefusal(`${where}: "${name}" must be a non-empty string.`);
  return value;
}

function list(value: unknown, name: string, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new JudgeRefusal(`${where}: "${name}" must be a list of strings.`);
  }
  return value as string[];
}

/** Check a parsed task file. Unknown fields are refused. */
export function parseTaskFile(value: unknown): TaskFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JudgeRefusal('The task file must be a JSON object.');
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!['version', 'runs', 'tasks'].includes(key)) throw new JudgeRefusal(`The task file has an unknown field "${key}".`);
  }
  if (root.version !== 1) throw new JudgeRefusal('The task file needs "version": 1.');
  if (!Array.isArray(root.tasks) || !root.tasks.length) throw new JudgeRefusal('The task file needs a non-empty "tasks" list.');
  if (root.runs !== undefined && (!Number.isInteger(root.runs) || (root.runs as number) < 1 || (root.runs as number) > 20)) {
    throw new JudgeRefusal('"runs" must be a whole number from 1 to 20.');
  }
  const seen = new Set<string>();
  const tasks = root.tasks.map((raw, index): Task => {
    const where = `tasks[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JudgeRefusal(`${where} must be an object.`);
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item)) if (!taskKeys.has(key)) throw new JudgeRefusal(`${where} has an unknown field "${key}".`);
    const id = text(item.id, 'id', where);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/u.test(id)) throw new JudgeRefusal(`${where}: id "${id}" must be lowercase letters, digits and dashes.`);
    if (seen.has(id)) throw new JudgeRefusal(`Task id "${id}" appears twice.`);
    seen.add(id);
    const expected = item.expected ?? 'completed';
    if (expected !== 'completed' && expected !== 'conflict') throw new JudgeRefusal(`${where}: "expected" must be completed or conflict.`);
    const hasFixture = item.fixture !== undefined;
    const hasRepo = item.repo !== undefined;
    if (hasFixture === hasRepo) throw new JudgeRefusal(`${where}: give either "fixture" or "repo" with "commit".`);
    if (hasRepo) text(item.commit, 'commit', where);
    else if (item.commit !== undefined) throw new JudgeRefusal(`${where}: "commit" belongs with "repo".`);
    const files = list(item.files, 'files', where);
    const protect = list(item.protect, 'protect', where);
    return {
      id,
      type: text(item.type, 'type', where),
      goal: text(item.goal, 'goal', where),
      check: text(item.check, 'check', where),
      accept: text(item.accept, 'accept', where),
      expected,
      ...(hasFixture ? { fixture: text(item.fixture, 'fixture', where) } : {}),
      ...(hasRepo ? { repo: text(item.repo, 'repo', where), commit: text(item.commit, 'commit', where) } : {}),
      ...(item.acceptDir !== undefined ? { acceptDir: text(item.acceptDir, 'acceptDir', where) } : {}),
      ...(files ? { files } : {}),
      ...(protect ? { protect } : {}),
    };
  });
  return { version: 1, ...(root.runs !== undefined ? { runs: root.runs as number } : {}), tasks };
}

export async function readTaskFile(path: string): Promise<{ file: TaskFile; directory: string }> {
  const full = resolve(path);
  let raw: string;
  try {
    raw = await readFile(full, 'utf8');
  } catch (cause) {
    throw new JudgeRefusal(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    return { file: parseTaskFile(JSON.parse(raw)), directory: dirname(full) };
  } catch (cause) {
    if (cause instanceof JudgeRefusal) throw cause;
    throw new JudgeRefusal(`${path} is not valid JSON.`);
  }
}

/** A path from the task file must stay inside the folder of that file. */
function inside(directory: string, path: string): string {
  const full = resolve(directory, path);
  const rel = relative(directory, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new JudgeRefusal(`"${path}" leaves the folder of the task file.`);
  return full;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

/** A fresh repository for one run: the fixture folder in one commit, or a clone at the given commit. */
export async function materialize(task: Task, directory: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'vlyn-task-')));
  const root = join(parent, 'repo');
  const cleanup = () => rm(parent, { recursive: true, force: true });
  try {
    if (task.fixture) {
      await cp(inside(directory, task.fixture), root, { recursive: true });
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'add', '.');
      git(root, '-c', 'user.name=vlyn', '-c', 'user.email=vlyn@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Task start');
    } else if (task.repo && task.commit) {
      const source = /^[a-z][a-z0-9+.-]*:\/\//iu.test(task.repo) ? task.repo : inside(directory, task.repo);
      git(parent, 'clone', '-q', '--no-checkout', source, 'repo');
      git(root, 'checkout', '-q', '--detach', task.commit);
    }
    return { root, cleanup };
  } catch (cause) {
    await cleanup();
    throw new JudgeRefusal(`Cannot prepare task ${task.id}: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
  }
}

export type MeasurementPlan = { agent: string; taskId: string; rep: number }[];

/** Repetition-major order, so a budget stop leaves the agents and tasks evenly covered. */
export function planMeasurement(file: TaskFile, agents: string[], runs: number): MeasurementPlan {
  const plan: MeasurementPlan = [];
  for (let rep = 1; rep <= runs; rep++) {
    for (const task of file.tasks) for (const agent of agents) plan.push({ agent, taskId: task.id, rep });
  }
  return plan;
}

export type MeasurementOptions = {
  file: TaskFile;
  directory: string;
  agents: (string | AgentAdapter)[];
  runs: number;
  /** Counted-spend threshold, not a guarantee of actual provider spend. */
  budgetUsd: number;
  /** Counted spend from previous attempts, supplied by the operator. */
  priorSpendUsd?: number;
  /** Counted for a run that reports no cost (Codex, Pi), so the cap still bounds the spend. */
  assumedUnknownCostUsd?: number;
  timeoutMs?: number;
  baseline?: string;
  baselineDir?: string;
  home?: string;
  requireSandbox?: boolean;
  isolates?: () => boolean;
  record?: boolean;
  onRun?: (done: { agent: string; taskId: string; rep: number; result: JudgeResult }) => void;
};

export type MeasurementSummary = {
  planned: number;
  executed: number;
  spentUsd: number;
  stoppedByBudget: boolean;
  runIds: string[];
};

const name = (agent: string | AgentAdapter) => (typeof agent === 'string' ? agent : agent.name);

export async function runMeasurement(options: MeasurementOptions): Promise<MeasurementSummary> {
  if (!Number.isFinite(options.budgetUsd) || !(options.budgetUsd > 0)) throw new JudgeRefusal('A budget is required: pass --budget with a positive number of US dollars.');
  const priorSpend = options.priorSpendUsd ?? 0;
  if (!Number.isFinite(priorSpend) || priorSpend < 0) throw new JudgeRefusal('Prior spend must be a non-negative number of US dollars.');
  const assumed = options.assumedUnknownCostUsd ?? 1;
  const plan = planMeasurement(options.file, options.agents.map(name), options.runs);
  const byId = new Map(options.file.tasks.map((task) => [task.id, task]));
  const adapters = new Map(options.agents.map((agent) => [name(agent), agent]));
  let spent = priorSpend;
  let largest = assumed;
  let stopped = false;
  const runIds: string[] = [];
  for (const step of plan) {
    if (spent + largest > options.budgetUsd) {
      stopped = true;
      break;
    }
    const task = byId.get(step.taskId) as Task;
    const prepared = await materialize(task, options.directory);
    try {
      const result = await judge({
        agent: adapters.get(step.agent) as string | AgentAdapter,
        goal: task.goal,
        check: task.check,
        root: prepared.root,
        accept: task.accept,
        ...(task.acceptDir ? { acceptDir: inside(options.directory, task.acceptDir) } : {}),
        ...(task.files ? { files: task.files } : {}),
        ...(task.protect ? { protect: task.protect } : {}),
        taskType: task.type,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.baseline ? { baseline: options.baseline } : {}),
        ...(options.baselineDir ? { baselineDir: options.baselineDir } : {}),
        ...(options.home ? { home: options.home } : {}),
        ...(options.requireSandbox !== undefined ? { requireSandbox: options.requireSandbox } : {}),
        ...(options.isolates ? { isolates: options.isolates } : {}),
        ...(options.record !== undefined ? { record: options.record } : {}),
      });
      const cost = result.usage?.costUsd;
      spent += typeof cost === 'number' ? cost : assumed;
      if (typeof cost === 'number') largest = Math.max(largest, cost);
      runIds.push(result.id);
      if (options.record !== false) {
        const journal = new Journal(options.home);
        try {
          insertTaskRun(journal.db, {
            runId: result.id,
            taskId: task.id,
            taskType: task.type,
            expected: task.expected,
            rep: step.rep,
            claimedDone: claimedDone(result.summary),
          });
        } finally {
          journal.close();
        }
      }
      options.onRun?.({ agent: step.agent, taskId: task.id, rep: step.rep, result });
    } finally {
      await prepared.cleanup();
    }
  }
  return { planned: plan.length, executed: runIds.length, spentUsd: spent, stoppedByBudget: stopped, runIds };
}

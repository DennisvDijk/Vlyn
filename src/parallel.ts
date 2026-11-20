import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCodingAgent } from './coding-agent.ts';
import type { AgentProvider, CodingResult } from './coding-agent.ts';
import { isObject } from './workspace.ts';

const git = promisify(execFile);
/** `files` are the paths (or folders) this task owns. Anything it changes outside them is reported and blocks a verified verdict. */
export type CodingTask = { id: string; task: string; check?: string; files?: string[] };
export type TaskResult = {
  task: CodingTask;
  worktree: string;
  status: 'completed' | 'unverified' | 'failed';
  result?: CodingResult;
  error?: string;
  changedFiles: string[];
  /** Changed files outside the task's declared ownership. */
  outOfScope?: string[];
  diff: string;
};
export type ParallelRun = { id: string; base: string; directory: string; tasks: TaskResult[] };

export async function gitOutput(root: string, args: string[]): Promise<string> {
  const { stdout } = await git('git', args, { cwd: root, maxBuffer: 4_000_000, timeout: 30_000 });
  return stdout;
}

export async function readTasks(path: string): Promise<CodingTask[]> {
  return validateTasks(JSON.parse(await readFile(path, 'utf8')));
}

export function validateTasks(value: unknown): CodingTask[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error('Task file must contain an array of 1 to 32 tasks');
  const ids = new Set<string>();
  return value.map((item: unknown): CodingTask => {
    if (!isObject(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(item.id) ||
        typeof item.task !== 'string' || !item.task.trim() ||
        (item.check !== undefined && (typeof item.check !== 'string' || !item.check.trim())) ||
        (item.files !== undefined && (!Array.isArray(item.files) || item.files.length > 200 || item.files.some((file: unknown) => typeof file !== 'string' || !file || file.startsWith('/') || file.includes('..'))))) {
      throw new Error('Each task requires an id, a description, and an optional check command');
    }
    if (Object.keys(item).some(key => !['id', 'task', 'check', 'files'].includes(key))) throw new Error(`Unknown field in task ${item.id}`);
    if (ids.has(item.id)) throw new Error(`Duplicate task id: ${item.id}`);
    ids.add(item.id);
    return { id: item.id, task: item.task, ...(item.check ? { check: item.check as string } : {}), ...(Array.isArray(item.files) && item.files.length ? { files: (item.files as string[]).map(file => file.replace(/^\.\//u, '')) } : {}) };
  });
}

/** Run one coding task inside an existing worktree and collect its diff, changed files and verdict. */
export function owns(owned: string[], file: string): boolean {
  return owned.some(path => file === path || file.startsWith(path.endsWith('/') ? path : `${path}/`));
}

export async function executeTask(task: CodingTask, worktree: string, provider: AgentProvider, context?: unknown): Promise<TaskResult> {
  let result: CodingResult | undefined;
  let error: string | undefined;
  try {
    result = await runCodingAgent({ root: worktree, task: task.task, provider, check: task.check, context });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const diff = await gitOutput(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
  const tracked = await gitOutput(worktree, ['diff', '--name-only', '-z', 'HEAD', '--']);
  const untracked = await gitOutput(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  const changedFiles = [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
  const lastCheck = result?.checks.at(-1);
  const outOfScope = task.files?.length ? changedFiles.filter(file => !owns(task.files as string[], file)) : [];
  const status = error || !result?.completed ? 'failed' :
    !task.check || !lastCheck || lastCheck.stale || outOfScope.length ? 'unverified' : lastCheck.exitCode === 0 ? 'completed' : 'failed';
  return { task, worktree, status, result, error, changedFiles, ...(outOfScope.length ? { outOfScope } : {}), diff };
}

export async function runParallel(options: {
  root: string;
  tasks: CodingTask[];
  workers: number;
  provider: (task: CodingTask) => AgentProvider;
  onProgress?: (message: string) => void;
}): Promise<ParallelRun> {
  const root = await realpath(options.root);
  const top = await realpath((await gitOutput(root, ['rev-parse', '--show-toplevel'])).trim());
  if (root !== top) throw new Error('Parallel tasks require the Git repository root');
  if ((await gitOutput(root, ['status', '--porcelain', '--untracked-files=normal'])).trim()) {
    throw new Error('Parallel tasks require a clean working tree. Commit or stash changes first.');
  }
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 16) throw new Error('Workers must be from 1 to 16');
  const base = (await gitOutput(root, ['rev-parse', 'HEAD'])).trim();
  const id = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'coding-harness-'));
  const pending: { task: CodingTask; worktree: string }[] = [];
  try {
    for (const task of options.tasks) {
      const worktree = join(directory, task.id);
      await gitOutput(root, ['worktree', 'add', '--detach', '--', worktree, base]);
      pending.push({ task, worktree });
    }
  } catch (cause) {
    throw new Error(`Could not create task worktrees in ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const results: TaskResult[] = new Array(pending.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= pending.length) return;
      const { task, worktree } = pending[index];
      options.onProgress?.(`Started ${task.id}`);
      const output = await executeTask(task, worktree, options.provider(task));
      results[index] = output;
      await writeFile(join(directory, `${task.id}.json`), JSON.stringify(output, null, 2));
      options.onProgress?.(`${task.id}: ${status}`);
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(options.workers, pending.length) }, () => worker()));
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) throw failed.reason;
  const report = { id, base, directory, tasks: results };
  await writeFile(join(directory, 'run.json'), JSON.stringify(report, null, 2));
  return report;
}

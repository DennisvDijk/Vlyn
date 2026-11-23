import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecurityLog } from './broker.ts';
import type { AgentProvider } from './coding-agent.ts';
import { executeTask, gitOutput } from './parallel.ts';
import type { CodingTask, TaskResult } from './parallel.ts';
import { afterAction } from './premortem.ts';
import { briefFor } from './planner.ts';
import type { Spec } from './planner.ts';

export type RunStatus = 'planned' | 'running' | 'interrupted' | 'finished';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'unverified' | 'failed';
export type RunRow = { id: string; root: string; goal: string; base: string; workers: number; status: RunStatus; createdAt: string; directory: string };
export type TaskRow = { runId: string; task: CodingTask; status: TaskStatus; attempts: number; worktree: string; result?: TaskResult };
export type Convergence = {
  applied: string[];
  conflicts: { task: string; detail: string }[];
  checks: { command: string; exitCode: number | null; output: string }[];
  passed: boolean;
  worktree: string;
};
export type RunEvent = { runId: string; at: string; message: string };

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.VLYN_HOME ?? join(homedir(), '.vlyn');
}

/**
 * Durable run journal. Every state change is committed to SQLite before work continues, so a crash, a closed
 * terminal or a reboot loses at most the task that was in flight. `resume` picks up from the journal.
 */
export class Journal {
  readonly home: string;
  readonly db: DatabaseSync;

  constructor(home = defaultHome()) {
    this.home = home;
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, 'journal.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, goal TEXT NOT NULL, base TEXT NOT NULL, workers INTEGER NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, directory TEXT NOT NULL, owner_pid INTEGER);
      CREATE TABLE IF NOT EXISTS tasks (
        run_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, task TEXT NOT NULL, check_command TEXT,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, worktree TEXT NOT NULL, result TEXT,
        PRIMARY KEY (run_id, id));
      CREATE TABLE IF NOT EXISTS specs (run_id TEXT PRIMARY KEY, spec TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS convergence (run_id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'files')) this.db.exec('ALTER TABLE tasks ADD COLUMN files TEXT');
  }

  close(): void { this.db.close(); }

  spec(runId: string): Spec | undefined {
    const row = this.db.prepare('SELECT spec FROM specs WHERE run_id = ?').get(runId);
    return row ? JSON.parse(String(row.spec)) as Spec : undefined;
  }

  convergence(runId: string): Convergence | undefined {
    const row = this.db.prepare('SELECT result FROM convergence WHERE run_id = ?').get(runId);
    return row ? JSON.parse(String(row.result)) as Convergence : undefined;
  }

  event(runId: string, message: string): RunEvent {
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO events (run_id, at, message) VALUES (?, ?, ?)').run(runId, at, message);
    return { runId, at, message };
  }

  events(runId: string, limit = 200): RunEvent[] {
    return (this.db.prepare('SELECT run_id, at, message FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?').all(runId, limit) as
      { run_id: string; at: string; message: string }[]).reverse().map(row => ({ runId: row.run_id, at: row.at, message: row.message }));
  }

  private runFrom(row: Record<string, unknown>): RunRow {
    return { id: String(row.id), root: String(row.root), goal: String(row.goal), base: String(row.base), workers: Number(row.workers),
      status: row.status as RunStatus, createdAt: String(row.created_at), directory: String(row.directory) };
  }

  runs(): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all().map(row => this.runFrom(row));
  }

  run(id: string): RunRow | undefined {
    const exact = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (exact) return this.runFrom(exact);
    const matches = this.db.prepare('SELECT * FROM runs WHERE id LIKE ? ESCAPE \'\\\'').all(`${id.replace(/[%_\\]/gu, '\\$&')}%`);
    const match = matches[0];
    return matches.length === 1 && match ? this.runFrom(match) : undefined;
  }

  tasks(runId: string): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY position').all(runId).map(row => ({
      runId, status: row.status as TaskStatus, attempts: Number(row.attempts), worktree: String(row.worktree),
      task: { id: String(row.id), task: String(row.task), ...(row.check_command ? { check: String(row.check_command) } : {}), ...(row.files ? { files: JSON.parse(String(row.files)) as string[] } : {}) },
      ...(row.result ? { result: JSON.parse(String(row.result)) as TaskResult } : {}),
    }));
  }

  setTask(runId: string, id: string, status: TaskStatus, result?: TaskResult): void {
    this.db.prepare('UPDATE tasks SET status = ?, result = COALESCE(?, result), attempts = attempts + ? WHERE run_id = ? AND id = ?')
      .run(status, result ? JSON.stringify(result) : null, status === 'running' ? 1 : 0, runId, id);
  }

  setRun(id: string, status: RunStatus, owner: number | null = null): void {
    this.db.prepare('UPDATE runs SET status = ?, owner_pid = ? WHERE id = ?').run(status, owner, id);
  }

  owner(id: string): number | null {
    const row = this.db.prepare('SELECT owner_pid FROM runs WHERE id = ?').get(id);
    return row?.owner_pid === null || row?.owner_pid === undefined ? null : Number(row.owner_pid);
  }

  /** Create a run: one persistent worktree per task, all at the same committed revision. */
  async create(options: { root: string; goal: string; tasks: CodingTask[]; workers: number; spec?: Spec }): Promise<RunRow> {
    const root = await realpath(options.root);
    const top = await realpath((await gitOutput(root, ['rev-parse', '--show-toplevel'])).trim());
    if (root !== top) throw new Error('Runs require the Git repository root');
    if ((await gitOutput(root, ['status', '--porcelain', '--untracked-files=normal'])).trim()) {
      throw new Error('Runs require a clean working tree. Commit or stash changes first.');
    }
    if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 16) throw new Error('Workers must be from 1 to 16');
    if (!options.tasks.length) throw new Error('A run needs at least one task');
    const id = randomUUID();
    const base = (await gitOutput(root, ['rev-parse', 'HEAD'])).trim();
    const directory = join(this.home, 'runs', id);
    await mkdir(directory, { recursive: true });
    const created = new Date().toISOString();
    this.db.prepare('INSERT INTO runs (id, root, goal, base, workers, status, created_at, directory) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, root, options.goal, base, options.workers, 'planned', created, directory);
    try {
      let position = 0;
      for (const task of options.tasks) {
        const worktree = join(directory, task.id);
        await gitOutput(root, ['worktree', 'add', '--detach', '--', worktree, base]);
        this.db.prepare('INSERT INTO tasks (run_id, id, position, task, check_command, status, worktree, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, task.id, position++, task.task, task.check ?? null, 'pending', worktree, task.files ? JSON.stringify(task.files) : null);
      }
    } catch (cause) {
      await this.discard(id);
      throw new Error(`Could not create task worktrees: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (options.spec) this.db.prepare('INSERT INTO specs (run_id, spec) VALUES (?, ?)').run(id, JSON.stringify(options.spec));
    this.event(id, `Planned ${options.tasks.length} tasks at ${base.slice(0, 8)}`);
    return this.run(id) as RunRow;
  }

  /** Remove a run's worktrees and its journal entries. */
  async discard(id: string): Promise<void> {
    const run = this.run(id);
    if (!run) return;
    for (const task of this.tasks(run.id)) {
      try { await gitOutput(run.root, ['worktree', 'remove', '--force', task.worktree]); } catch { /* already gone */ }
    }
    try { await gitOutput(run.root, ['worktree', 'remove', '--force', join(run.directory, '_integration')]); } catch { /* none */ }
    try { await gitOutput(run.root, ['worktree', 'prune']); } catch { /* repository moved */ }
    await rm(run.directory, { recursive: true, force: true });
    this.db.prepare('DELETE FROM events WHERE run_id = ?').run(run.id);
    this.db.prepare('DELETE FROM tasks WHERE run_id = ?').run(run.id);
    this.db.prepare('DELETE FROM specs WHERE run_id = ?').run(run.id);
    this.db.prepare('DELETE FROM convergence WHERE run_id = ?').run(run.id);
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Execute (or resume) a run. Pending tasks run; tasks left `running` by a dead process are reset to the run's base
 * revision and retried. Finished tasks are never redone. Safe to call again after any interruption.
 */
export async function executeRun(journal: Journal, runId: string, options: {
  provider: (task: CodingTask) => AgentProvider;
  onEvent?: (event: RunEvent) => void;
  signal?: AbortSignal;
  requireSandbox?: boolean;
  onDelta?: (taskId: string, delta: string) => void;
}): Promise<{ run: RunRow; tasks: TaskRow[]; convergence?: Convergence }> {
  const run = journal.run(runId);
  if (!run) throw new Error(`No run ${runId}`);
  const owner = journal.owner(run.id);
  if (owner && owner !== process.pid && alive(owner)) throw new Error(`Run ${run.id.slice(0, 8)} is already being executed by process ${owner}`);
  journal.setRun(run.id, 'running', process.pid);
  const say = (message: string) => { const event = journal.event(run.id, message); options.onEvent?.(event); };
  const security = new SecurityLog(journal.db);
  for (const row of journal.tasks(run.id)) {
    if (row.status !== 'running') continue;
    await gitOutput(row.worktree, ['reset', '--hard', run.base]);
    await gitOutput(row.worktree, ['clean', '-fd']);
    journal.setTask(run.id, row.task.id, 'pending');
    say(`Recovered ${row.task.id} after an interruption; restarting it from the base revision`);
  }
  const spec = journal.spec(run.id);
  const allTasks = journal.tasks(run.id).map(row => row.task);
  const queue = journal.tasks(run.id).filter(row => row.status === 'pending');
  if (queue.length < journal.tasks(run.id).length) say(`Resuming: ${queue.length} tasks left`);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (options.signal?.aborted) return;
      const row = queue[next++];
      if (!row) return;
      journal.setTask(run.id, row.task.id, 'running');
      say(`Started ${row.task.id}`);
      const result = await executeTask(row.task, row.worktree, options.provider(row.task), spec ? briefFor(spec, row.task, allTasks) : undefined, {
        ...(options.requireSandbox !== undefined ? { requireSandbox: options.requireSandbox } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onDelta ? { onDelta: (delta: string) => options.onDelta?.(row.task.id, delta) } : {}),
        audit: event => security.append({ ...event, runId: run.id, actorId: row.task.id }),
      });
      if (options.signal?.aborted && result.error) {
        // Interrupted mid-task: leave it `running` so resume restarts it cleanly.
        say(`Stopped ${row.task.id} before it finished`);
        return;
      }
      journal.setTask(run.id, row.task.id, result.status, result);
      say(`${row.task.id}: ${result.status}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(run.workers, queue.length) }, worker));
  const tasks = journal.tasks(run.id);
  const done = tasks.every(task => !['pending', 'running'].includes(task.status));
  journal.setRun(run.id, done ? 'finished' : 'interrupted');
  say(done ? 'Run finished' : 'Run interrupted; resume it to continue');
  let convergence = journal.convergence(run.id);
  if (done && !convergence && tasks.filter(task => task.status === 'completed').length > 1) {
    convergence = await converge(journal, run.id);
    say(convergence.passed ? 'Integration: all results combine cleanly and checks pass' : `Integration: ${convergence.conflicts.length} conflicts, ${convergence.checks.filter(check => check.exitCode !== 0).length} failing checks`);
  }
  if (done) {
    const note = afterAction({
      goal: run.goal,
      tasks: tasks.map(task => ({ id: task.task.id, status: task.status })),
      ...(convergence ? { integrationPassed: convergence.passed } : {}),
    });
    say(`After action: ${note.difference} ${note.change}`);
  }
  return { run: journal.run(run.id) as RunRow, tasks, ...(convergence ? { convergence } : {}) };
}

function shell(cwd: string, command: string): Promise<{ exitCode: number | null; output: string }> {
  return new Promise(done => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    let output = '';
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-4000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', error => done({ exitCode: null, output: error.message }));
    child.once('close', exitCode => done({ exitCode, output }));
  });
}

/**
 * Convergence: apply every completed task's result onto a fresh copy of the base revision, report conflicts, and re-run
 * the tasks' checks on the combined result. Parallel agents each passed alone; this shows whether the whole holds together.
 * The combined worktree is left in place for review. The original checkout is never changed.
 */
export async function converge(journal: Journal, runId: string): Promise<Convergence> {
  const run = journal.run(runId);
  if (!run) throw new Error(`No run ${runId}`);
  const worktree = join(run.directory, '_integration');
  try { await gitOutput(run.root, ['worktree', 'remove', '--force', worktree]); } catch { /* first time */ }
  await gitOutput(run.root, ['worktree', 'add', '--detach', '--', worktree, run.base]);
  const result: Convergence = { applied: [], conflicts: [], checks: [], passed: false, worktree };
  const done = journal.tasks(run.id).filter(row => row.status === 'completed' && row.result);
  for (const row of done) {
    const task = row.result as TaskResult;
    try {
      if (task.diff.trim()) {
        const patch = join(run.directory, `${row.task.id}.patch`);
        await writeFile(patch, task.diff);
        await gitOutput(worktree, ['apply', '--binary', '--whitespace=nowarn', patch]);
      }
      const untracked = (await gitOutput(row.worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      for (const file of untracked) {
        const target = join(worktree, file);
        const existing = await readFile(target).catch(() => undefined);
        const incoming = await readFile(join(row.worktree, file));
        if (existing && !existing.equals(incoming)) throw new Error(`${file} was also created by another task`);
        await mkdir(join(target, '..'), { recursive: true });
        await cp(join(row.worktree, file), target);
      }
      result.applied.push(row.task.id);
    } catch (cause) {
      const line = (cause instanceof Error ? cause.message : String(cause)).split('\n')[0] ?? '';
      result.conflicts.push({ task: row.task.id, detail: line.slice(0, 300) });
    }
  }
  const commands = [...new Set(done.map(row => row.task.check).filter((command): command is string => Boolean(command)))];
  for (const command of commands) {
    const outcome = await shell(worktree, command);
    result.checks.push({ command, ...outcome });
  }
  result.passed = result.conflicts.length === 0 && result.applied.length > 0 && result.checks.every(check => check.exitCode === 0);
  journal.db.prepare('INSERT OR REPLACE INTO convergence (run_id, result) VALUES (?, ?)').run(run.id, JSON.stringify(result));
  return result;
}

/**
 * Commit the integration worktree and point a new branch at that commit.
 * The checkout's HEAD and branch are not changed.
 */
export async function applyToBranch(journal: Journal, runId: string, branch: string): Promise<{ branch: string; commit: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/u.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error('Branch name must be a simple git ref without ".."');
  }
  const run = journal.run(runId);
  if (!run) throw new Error(`No run ${runId}`);
  const beforeHead = (await gitOutput(run.root, ['rev-parse', 'HEAD'])).trim();
  const beforeBranch = (await gitOutput(run.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const exists = await gitOutput(run.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) throw new Error(`Branch ${branch} already exists`);
  const convergence = journal.convergence(run.id) ?? await converge(journal, run.id);
  if (!convergence.passed) throw new Error('Integration did not pass. Nothing was applied.');
  if ((await gitOutput(convergence.worktree, ['status', '--porcelain'])).trim()) {
    await gitOutput(convergence.worktree, ['add', '-A']);
    await gitOutput(convergence.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-m', `Apply Vlyn run ${run.id.slice(0, 8)}`]);
  }
  const commit = (await gitOutput(convergence.worktree, ['rev-parse', 'HEAD'])).trim();
  await gitOutput(run.root, ['branch', branch, commit]);
  const afterHead = (await gitOutput(run.root, ['rev-parse', 'HEAD'])).trim();
  const afterBranch = (await gitOutput(run.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (afterHead !== beforeHead || afterBranch !== beforeBranch) throw new Error('Apply moved the checkout. This is a bug.');
  journal.event(run.id, `Applied integration to branch ${branch} at ${commit.slice(0, 8)}`);
  return { branch, commit };
}

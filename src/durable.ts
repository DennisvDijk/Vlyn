import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentProvider } from './coding-agent.ts';
import { executeTask, gitOutput } from './parallel.ts';
import type { CodingTask, TaskResult } from './parallel.ts';

export type RunStatus = 'planned' | 'running' | 'interrupted' | 'finished';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'unverified' | 'failed';
export type RunRow = { id: string; root: string; goal: string; base: string; workers: number; status: RunStatus; createdAt: string; directory: string };
export type TaskRow = { runId: string; task: CodingTask; status: TaskStatus; attempts: number; worktree: string; result?: TaskResult };
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
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL);
    `);
  }

  close(): void { this.db.close(); }

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
    return matches.length === 1 ? this.runFrom(matches[0]) : undefined;
  }

  tasks(runId: string): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY position').all(runId).map(row => ({
      runId, status: row.status as TaskStatus, attempts: Number(row.attempts), worktree: String(row.worktree),
      task: { id: String(row.id), task: String(row.task), ...(row.check_command ? { check: String(row.check_command) } : {}) },
      result: row.result ? JSON.parse(String(row.result)) as TaskResult : undefined,
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
  async create(options: { root: string; goal: string; tasks: CodingTask[]; workers: number }): Promise<RunRow> {
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
        this.db.prepare('INSERT INTO tasks (run_id, id, position, task, check_command, status, worktree) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, task.id, position++, task.task, task.check ?? null, 'pending', worktree);
      }
    } catch (cause) {
      await this.discard(id);
      throw new Error(`Could not create task worktrees: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
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
    try { await gitOutput(run.root, ['worktree', 'prune']); } catch { /* repository moved */ }
    await rm(run.directory, { recursive: true, force: true });
    this.db.prepare('DELETE FROM events WHERE run_id = ?').run(run.id);
    this.db.prepare('DELETE FROM tasks WHERE run_id = ?').run(run.id);
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
}): Promise<{ run: RunRow; tasks: TaskRow[] }> {
  const run = journal.run(runId);
  if (!run) throw new Error(`No run ${runId}`);
  const owner = journal.owner(run.id);
  if (owner && owner !== process.pid && alive(owner)) throw new Error(`Run ${run.id.slice(0, 8)} is already being executed by process ${owner}`);
  journal.setRun(run.id, 'running', process.pid);
  const say = (message: string) => { const event = journal.event(run.id, message); options.onEvent?.(event); };
  for (const row of journal.tasks(run.id)) {
    if (row.status !== 'running') continue;
    await gitOutput(row.worktree, ['reset', '--hard', run.base]);
    await gitOutput(row.worktree, ['clean', '-fd']);
    journal.setTask(run.id, row.task.id, 'pending');
    say(`Recovered ${row.task.id} after an interruption; restarting it from the base revision`);
  }
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
      const result = await executeTask(row.task, row.worktree, options.provider(row.task));
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
  return { run: journal.run(run.id) as RunRow, tasks };
}

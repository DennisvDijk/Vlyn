import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PlanningAction } from './model.ts';
import type { Check, Observation, Source, Workspace } from './workspace.ts';

export type Result = { status: 'passed' | 'failed' | 'error'; details: string[] };
export type Attempt = { id: string; check: Check; candidate: Source; leaseUntil: number };
type Finished = { attempt: Attempt; result: Result; finishedAt: number };
type Event =
  | { type: 'observed'; observation: Observation }
  | { type: 'planned'; snapshot: string; model: string; actions: PlanningAction[] }
  | { type: 'claimed'; attempt: Attempt }
  | { type: 'finished'; finished: Finished };
type State = {
  observation?: Observation;
  active: Map<string, Attempt>;
  checks: Map<string, Finished>;
  latestByService: Map<string, Finished>;
};

export function project(events: Event[]): State {
  const state: State = { active: new Map(), checks: new Map(), latestByService: new Map() };
  for (const event of events) {
    switch (event.type) {
      case 'observed':
        state.observation = event.observation;
        break;
      case 'claimed':
        state.active.set(event.attempt.check.id, event.attempt);
        break;
      case 'finished': {
        const { attempt, result } = event.finished;
        state.active.delete(attempt.check.id);
        state.checks.set(attempt.check.id, event.finished);
        if (result.status !== 'error') state.latestByService.set(attempt.check.service, event.finished);
        break;
      }
    }
  }
  return state;
}

export type Row = {
  service: string;
  revision: string;
  status: Result['status'] | 'running' | 'pending' | 'stale' | 'unknown';
  details: string[];
  contract?: Source;
  evidence?: Finished;
  previous?: Finished;
};
export type Report = {
  environment: string;
  inventory: Observation['inventory'];
  deployment: Source;
  base: Source;
  candidate: Source;
  changes: Observation['changes'];
  status: 'compatible' | 'incompatible' | 'unverified';
  checks: Row[];
};

function rows(state: State, observation: Observation, now: number): Row[] {
  return observation.targets.map(target => {
    const { service, revision, check } = target;
    const identity = { service, revision };
    const last = state.latestByService.get(service);
    const previous = last?.attempt.check.id === check?.id ? undefined : last;
    const carried = previous ? { previous } : {};
    if (!check) return { ...identity, status: 'unknown' as const, details: [target.issue ?? 'No check'], ...carried };

    const scoped = { ...identity, contract: check.source, ...carried };
    const attempt = state.active.get(check.id);
    if (attempt && attempt.leaseUntil > now) return { ...scoped, status: 'running', details: ['Check is running'] };
    const evidence = state.checks.get(check.id);
    if (evidence) return { ...scoped, ...evidence.result, evidence };
    if (previous) return { ...scoped, status: 'stale', details: ['An earlier check used different inputs'] };
    return { ...scoped, status: 'pending', details: [attempt ? 'Worker lease expired' : 'Ready to check'] };
  });
}

export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY,
        stream TEXT NOT NULL,
        workspace TEXT NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS event_stream ON events (stream, sequence);
      CREATE INDEX IF NOT EXISTS event_workspace ON events (workspace, kind, sequence);
    `);
  }

  close(): void {
    this.#db.close();
  }

  #state(stream: string): State {
    const records = this.#db.prepare('SELECT data FROM events WHERE stream = ? ORDER BY sequence').all(stream);
    return project(records.map(row => JSON.parse(row.data as string) as Event));
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #append(workspace: Pick<Workspace, 'root' | 'stream'>, event: Event): void {
    this.#db.prepare('INSERT INTO events (stream, workspace, kind, data) VALUES (?, ?, ?, ?)')
      .run(workspace.stream, workspace.root, event.type, JSON.stringify(event));
  }

  observe(workspace: Workspace): void {
    this.#transaction(() => {
      const current = this.#state(workspace.stream).observation;
      if (current?.id !== workspace.observation.id || this.latestStream(workspace.root) !== workspace.stream) {
        this.#append(workspace, { type: 'observed', observation: workspace.observation });
      }
    });
  }

  recordPlan(workspace: Workspace, model: string, actions: PlanningAction[]): void {
    this.#append(workspace, { type: 'planned', snapshot: workspace.observation.id, model, actions });
  }

  latestStream(root: string): string | undefined {
    const result = this.#db.prepare(`
      SELECT stream FROM events WHERE workspace = ? AND kind = 'observed' ORDER BY sequence DESC LIMIT 1
    `).get(root);
    return result?.stream as string | undefined;
  }

  claim(workspace: Workspace, checks: readonly Check[], skipped: Set<string>, now?: number, leaseMs = 30_000): Attempt | undefined {
    return this.#transaction(() => {
      const time = now ?? Date.now();
      const state = this.#state(workspace.stream);
      if (state.observation?.id !== workspace.observation.id) return undefined;
      const check = checks.find(candidate => {
        if (skipped.has(candidate.id)) return false;
        const prior = state.checks.get(candidate.id)?.result.status;
        if (prior === 'passed' || prior === 'failed') return false;
        const active = state.active.get(candidate.id);
        return !active || active.leaseUntil <= time;
      });
      if (!check) return undefined;
      const attempt = { id: randomUUID(), check, candidate: workspace.observation.candidate, leaseUntil: time + leaseMs };
      this.#append(workspace, { type: 'claimed', attempt });
      return attempt;
    });
  }

  finish(workspace: Workspace, attempt: Attempt, result: Result, now?: number): boolean {
    return this.#transaction(() => {
      const time = now ?? Date.now();
      const current = this.#state(workspace.stream).active.get(attempt.check.id);
      if (current?.id !== attempt.id || current.leaseUntil <= time) return false;
      this.#append(workspace, { type: 'finished', finished: { attempt: current, result, finishedAt: time } });
      return true;
    });
  }

  report(stream: string, now = Date.now()): Report | undefined {
    const state = this.#state(stream);
    const { observation } = state;
    if (!observation) return undefined;
    const checks = rows(state, observation, now);
    const { environment, inventory, deployment, base, candidate, changes } = observation;
    const covered = inventory === 'complete' && checks.length > 0 && checks.every(check => check.status === 'passed');
    const status = checks.some(check => check.status === 'failed') ? 'incompatible' : covered ? 'compatible' : 'unverified';
    return { environment, inventory, deployment, base, candidate, changes, status, checks };
  }
}

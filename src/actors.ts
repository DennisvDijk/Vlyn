import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Journal } from './durable.ts';

/**
 * Local actor runtime. Idle actors are rows in the same SQLite journal as runs.
 * A brain snapshot is the cognitive state needed to continue a coding task:
 * working context, graph, episode slice, decisions, claims, hypotheses, and a
 * workspace reference (commit and diff, not the tree). Agent Substrate's
 * checkpoint/resume picture and Erlang's one-for-one supervision are the
 * analogies. Nothing here talks to Substrate.
 */
export const actorRoles = ['supervisor', 'planner', 'coder', 'reviewer', 'verifier'] as const;
export type ActorRole = (typeof actorRoles)[number];
export type ActorState = 'idle' | 'running' | 'crashed';
export type ClaimStatus = 'unverified' | 'supported' | 'contested' | 'retracted';

export type Claim = {
  id: string;
  text: string;
  status: ClaimStatus;
  files: string[];
  /** 0–1. An engineering weight, not a fitted forgetting curve. */
  strength: number;
  retrieved: number;
};

export type DecisionEntry = {
  id: string;
  prediction: string;
  /** Stated before the check returns. */
  confidence: number;
  /** 1 only when the coding verdict is `completed`. Absent until the check is scored. */
  outcome?: 0 | 1;
};

export type Hypothesis = { id: string; text: string; confidence: number; files: string[] };

export type Episode = { at: string; status: string; files: string[]; note: string };

export type WorkspaceRef = { root: string; commit: string; diff: string };

export type Brain = {
  role: ActorRole;
  template: string;
  workingContext: string;
  taskGraph: { nodes: { id: string; label: string }[]; edges: { from: string; to: string; kind: string }[] };
  episodic: Episode[];
  decisions: DecisionEntry[];
  claims: Claim[];
  hypotheses: Hypothesis[];
  workspace?: WorkspaceRef;
  procedural: string;
};

export type ActorRow = {
  id: string;
  role: ActorRole;
  template: string;
  state: ActorState;
  supervisorId?: string;
  forkedFrom?: { actorId: string; version: number };
  restarts: number;
  version: number;
  createdAt: string;
};

export type ActorMessage = {
  id: string;
  from: string;
  to: string;
  kind: string;
  body: unknown;
  at: string;
};

export const templates: Record<ActorRole, string> = {
  supervisor: 'You restart a crashed child from its last snapshot. You do not edit files.',
  planner: 'You turn a coding goal into owned tasks and hypotheses. You do not edit files. Record a confidence before any task runs.',
  coder: 'You edit only files you own, then run the check. A check from before a later edit is not success. Your summary is not evidence.',
  reviewer: 'You read the diff and may dissent. You do not edit files and you do not delete another hypothesis.',
  verifier: 'You record the check exit code and the ownership result. You do not edit files and you do not trust the coder summary.',
};

const decay = 0.8;
const strengthFloor = 0.15;
const maxEpisodes = 8;
const maxClaims = 16;
const maxDiff = 20_000;

export function blankBrain(role: ActorRole, context = ''): Brain {
  if (!actorRoles.includes(role)) throw new Error(`Unknown actor role: ${role}`);
  return {
    role,
    template: role,
    workingContext: context,
    taskGraph: { nodes: [], edges: [] },
    episodic: [],
    decisions: [],
    claims: [],
    hypotheses: [],
    procedural: templates[role],
  };
}

/** Mean squared error of confidence against a 0/1 outcome. Brier (1950). Empty input is undefined. */
export function brierScore(decisions: Pick<DecisionEntry, 'confidence' | 'outcome'>[]): number | undefined {
  const scored = decisions.filter((item): item is DecisionEntry & { outcome: 0 | 1 } => item.outcome === 0 || item.outcome === 1);
  if (!scored.length) return undefined;
  const total = scored.reduce((sum, item) => sum + (item.confidence - item.outcome) ** 2, 0);
  return total / scored.length;
}

/**
 * Distill repeated failed episodes into one claim and decay claims that were
 * not reinforced this pass. The multiplier is chosen here, not taken from
 * Ebbinghaus. Retracted claims stay so a later pass cannot rediscover them.
 */
export function consolidateBrain(brain: Brain): { brain: Brain; distilled: string[] } {
  const next = structuredClone(brain);
  const failures = new Map<string, number>();
  for (const episode of next.episodic) {
    if (episode.status !== 'failed' && episode.status !== 'unverified') continue;
    for (const file of episode.files) failures.set(file, (failures.get(file) ?? 0) + 1);
  }
  const distilled: string[] = [];
  const reinforced = new Set<string>();
  for (const [file, count] of failures) {
    if (count < 2) continue;
    const text = `Edits touching ${file} failed or left their ownership unverified more than once.`;
    const existing = next.claims.find(claim => claim.files.includes(file));
    if (!existing) {
      const id = `claim-${file.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'file'}`;
      next.claims.push({ id, text, status: 'unverified', files: [file], strength: 0.4, retrieved: 0 });
      distilled.push(id);
    } else if (existing.status !== 'retracted') {
      existing.strength = Math.min(1, Math.round((existing.strength + 0.2) * 1000) / 1000);
      existing.status = 'supported';
      reinforced.add(existing.id);
    }
  }
  for (const claim of next.claims) {
    if (claim.status === 'retracted' || reinforced.has(claim.id) || distilled.includes(claim.id)) continue;
    claim.strength = Math.round(claim.strength * decay * 1000) / 1000;
  }
  next.episodic = next.episodic.slice(-maxEpisodes);
  next.claims = next.claims
    .filter(claim => claim.status === 'retracted' || claim.strength >= strengthFloor)
    .slice(-maxClaims);
  if (next.workspace) next.workspace = { ...next.workspace, diff: next.workspace.diff.slice(-maxDiff) };
  return { brain: next, distilled };
}

/**
 * A lesson that was just retrieved is updated by the coding outcome.
 * A clean completion contests a failure claim. A repeated failure supports it.
 * Claims about other files are left alone.
 */
export function reconsolidate(brain: Brain, outcome: { files: string[]; status: 'completed' | 'failed' | 'unverified' }): Brain {
  const next = structuredClone(brain);
  const trouble = outcome.status !== 'completed';
  for (const claim of next.claims) {
    if (claim.status === 'retracted' || !claim.files.some(file => outcome.files.includes(file))) continue;
    claim.retrieved += 1;
    if (!trouble) {
      claim.status = 'contested';
      claim.strength = Math.max(0, Math.round((claim.strength - 0.3) * 1000) / 1000);
    } else {
      claim.status = 'supported';
      claim.strength = Math.min(1, Math.round((claim.strength + 0.2) * 1000) / 1000);
    }
  }
  next.episodic.push({ at: new Date().toISOString(), status: outcome.status, files: outcome.files, note: 'outcome at resume' });
  next.episodic = next.episodic.slice(-maxEpisodes);
  return next;
}

export function compareBrains(left: Brain, right: Brain): {
  sameParentContext: boolean;
  claims: { onlyLeft: string[]; onlyRight: string[] };
  hypotheses: { onlyLeft: string[]; onlyRight: string[] };
  commits: [string | undefined, string | undefined];
} {
  const ids = (items: { id: string }[], other: { id: string }[]) => items.filter(item => !other.some(peer => peer.id === item.id)).map(item => item.id);
  return {
    sameParentContext: left.workingContext === right.workingContext,
    claims: { onlyLeft: ids(left.claims, right.claims), onlyRight: ids(right.claims, left.claims) },
    hypotheses: { onlyLeft: ids(left.hypotheses, right.hypotheses), onlyRight: ids(right.hypotheses, left.hypotheses) },
    commits: [left.workspace?.commit, right.workspace?.commit],
  };
}

type StoredActor = {
  id: string;
  role: ActorRole;
  template: string;
  state: ActorState;
  supervisor_id: string | null;
  forked_from: string | null;
  restarts: number;
  current_version: number;
  created_at: string;
};

export class ActorRuntime {
  readonly #db: DatabaseSync;
  readonly #live = new Map<string, Brain>();

  constructor(journal: Journal) {
    this.#db = journal.db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS actors (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        template TEXT NOT NULL,
        state TEXT NOT NULL,
        supervisor_id TEXT,
        forked_from TEXT,
        restarts INTEGER NOT NULL DEFAULT 0,
        current_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS brain_snapshots (
        actor_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        brain TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (actor_id, version)
      );
      CREATE TABLE IF NOT EXISTS actor_messages (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        at TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  resident(id: string): boolean {
    return this.#live.has(id);
  }

  list(): ActorRow[] {
    return (this.#db.prepare('SELECT * FROM actors ORDER BY seq').all() as StoredActor[]).map(row => this.#row(row));
  }

  get(id: string): ActorRow {
    const row = this.#one(id);
    return this.#row(row);
  }

  spawn(role: ActorRole, options: { context?: string; supervisorId?: string } = {}): { actor: ActorRow; brain: Brain } {
    const brain = blankBrain(role, options.context ?? '');
    const id = `${role}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.#db.prepare(`INSERT INTO actors (id, role, template, state, supervisor_id, restarts, current_version, created_at, updated_at)
      VALUES (?, ?, ?, 'idle', ?, 0, 0, ?, ?)`).run(id, role, role, options.supervisorId ?? null, now, now);
    this.checkpoint(id, brain, { sleep: false });
    this.#live.delete(id);
    return { actor: this.get(id), brain: this.brain(id) };
  }

  /** Pick the oldest idle actor of this role, or spawn one. Loading it drops nothing from SQLite. */
  claim(role: ActorRole): { actor: ActorRow; brain: Brain } {
    const row = this.#db.prepare(`SELECT * FROM actors WHERE role = ? AND state = 'idle' ORDER BY seq LIMIT 1`).get(role) as StoredActor | undefined;
    const id = row?.id ?? this.spawn(role).actor.id;
    this.#set(id, { state: 'running' });
    const brain = this.brain(id);
    this.#live.set(id, brain);
    return { actor: this.get(id), brain };
  }

  brain(id: string): Brain {
    const row = this.#one(id);
    return this.#read(id, row.current_version);
  }

  brainAt(id: string, version: number): Brain {
    return this.#read(id, version);
  }

  /**
   * Write the next version. Sleep (consolidation) runs unless asked not to.
   * The in-memory copy is dropped so the next read comes from the journal.
   */
  checkpoint(id: string, brain: Brain, options: { sleep?: boolean } = {}): number {
    this.#one(id);
    const stored = options.sleep === false ? structuredClone(brain) : consolidateBrain(brain).brain;
    const version = Number(this.#db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM brain_snapshots WHERE actor_id = ?').get(id)?.version) + 1;
    const now = new Date().toISOString();
    this.#db.prepare('INSERT INTO brain_snapshots (actor_id, version, brain, at) VALUES (?, ?, ?, ?)').run(id, version, JSON.stringify(stored), now);
    this.#set(id, { version });
    this.#live.delete(id);
    return version;
  }

  /** Checkpoint, mark idle, and evict the in-memory brain. */
  release(id: string, brain?: Brain): number {
    const version = this.checkpoint(id, brain ?? this.brain(id));
    this.#set(id, { state: 'idle' });
    this.#live.delete(id);
    return version;
  }

  /**
   * Load a snapshot. When an outcome is passed, the recalled claims about those
   * files are updated and the result is checkpointed (reconsolidation).
   */
  resume(id: string, outcome?: { files: string[]; status: 'completed' | 'failed' | 'unverified' }): Brain {
    const current = this.brain(id);
    const next = outcome ? reconsolidate(current, outcome) : current;
    if (outcome) this.checkpoint(id, next, { sleep: false });
    this.#set(id, { state: 'running' });
    const loaded = this.brain(id);
    this.#live.set(id, loaded);
    return loaded;
  }

  /** Point the actor at an older snapshot. Later versions stay addressable. */
  revert(id: string, version: number): Brain {
    this.#read(id, version);
    this.#set(id, { version, state: 'idle' });
    this.#live.delete(id);
    return this.brain(id);
  }

  fork(id: string, options: { role?: ActorRole; hypothesis?: Hypothesis } = {}): { actor: ActorRow; brain: Brain } {
    const parent = this.#one(id);
    const role = options.role ?? parent.role;
    const brain = structuredClone(this.brain(id));
    brain.role = role;
    brain.template = role;
    brain.procedural = templates[role];
    if (options.hypothesis) {
      const hypothesis = { id: options.hypothesis.id, text: options.hypothesis.text, confidence: options.hypothesis.confidence, files: [...options.hypothesis.files] };
      brain.hypotheses = [hypothesis];
      brain.workingContext = hypothesis.text;
      brain.decisions = [{ id: hypothesis.id, prediction: hypothesis.text, confidence: hypothesis.confidence }];
    }
    const childId = `${role}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const from = JSON.stringify({ actorId: parent.id, version: parent.current_version });
    this.#db.prepare(`INSERT INTO actors (id, role, template, state, supervisor_id, forked_from, restarts, current_version, created_at, updated_at)
      VALUES (?, ?, ?, 'idle', ?, ?, 0, 0, ?, ?)`).run(childId, role, role, parent.id, from, now, now);
    this.checkpoint(childId, brain, { sleep: false });
    return { actor: this.get(childId), brain: this.brain(childId) };
  }

  send(from: string, to: string, kind: string, body: unknown): ActorMessage {
    this.#one(from);
    this.#one(to);
    const message: ActorMessage = { id: randomUUID(), from, to, kind, body, at: new Date().toISOString() };
    this.#db.prepare('INSERT INTO actor_messages (id, from_id, to_id, kind, body, at, read) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(message.id, from, to, kind, JSON.stringify(body), message.at);
    return message;
  }

  inbox(id: string): ActorMessage[] {
    this.#one(id);
    const rows = this.#db.prepare(`SELECT id, from_id, to_id, kind, body, at FROM actor_messages WHERE to_id = ? AND read = 0 ORDER BY at`).all(id) as
      { id: string; from_id: string; to_id: string; kind: string; body: string; at: string }[];
    return rows.map(row => ({ id: row.id, from: row.from_id, to: row.to_id, kind: row.kind, body: JSON.parse(row.body) as unknown, at: row.at }));
  }

  ack(ids: string[]): void {
    const mark = this.#db.prepare('UPDATE actor_messages SET read = 1 WHERE id = ?');
    for (const id of ids) mark.run(id);
  }

  /**
   * One-for-one: the child is restarted once from the last snapshot.
   * The work function receives a clone, so unsaved mutations die with the throw.
   * A second failure stays `crashed` and is rethrown.
   */
  async supervise<T>(actorId: string, work: (brain: Brain) => Promise<T>): Promise<T> {
    this.#one(actorId);
    const attempt = async () => work(structuredClone(this.brain(actorId)));
    this.#set(actorId, { state: 'running' });
    try {
      return await attempt();
    } catch (error) {
      this.#set(actorId, { state: 'crashed', restarts: this.#one(actorId).restarts + 1 });
      this.#live.delete(actorId);
      try {
        this.#set(actorId, { state: 'running' });
        return await attempt();
      } catch (again) {
        this.#set(actorId, { state: 'crashed', restarts: this.#one(actorId).restarts + 1 });
        this.#live.delete(actorId);
        throw again instanceof Error ? again : error;
      }
    }
  }

  #one(id: string): StoredActor {
    const row = this.#db.prepare('SELECT * FROM actors WHERE id = ?').get(id) as StoredActor | undefined;
    if (!row) throw new Error(`No actor ${id}`);
    return row;
  }

  #read(id: string, version: number): Brain {
    const row = this.#db.prepare('SELECT brain FROM brain_snapshots WHERE actor_id = ? AND version = ?').get(id, version) as { brain: string } | undefined;
    if (!row) throw new Error(`Actor ${id} has no snapshot ${version}`);
    return JSON.parse(row.brain) as Brain;
  }

  #set(id: string, patch: { state?: ActorState; version?: number; restarts?: number }): void {
    const current = this.#one(id);
    this.#db.prepare('UPDATE actors SET state = ?, current_version = ?, restarts = ?, updated_at = ? WHERE id = ?').run(
      patch.state ?? current.state,
      patch.version ?? current.current_version,
      patch.restarts ?? current.restarts,
      new Date().toISOString(),
      id,
    );
  }

  #row(row: StoredActor): ActorRow {
    return {
      id: row.id,
      role: row.role,
      template: row.template,
      state: row.state,
      ...(row.supervisor_id ? { supervisorId: row.supervisor_id } : {}),
      ...(row.forked_from ? { forkedFrom: JSON.parse(row.forked_from) as { actorId: string; version: number } } : {}),
      restarts: row.restarts,
      version: row.current_version,
      createdAt: row.created_at,
    };
  }
}

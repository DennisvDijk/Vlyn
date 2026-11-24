import type { DatabaseSync } from 'node:sqlite';

/** Journal table for judged runs. `accept_cmd` and `task_type` are filled by later steps. */
export function ensureJudgeSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS judge_runs (
    id TEXT PRIMARY KEY, root TEXT NOT NULL, base TEXT NOT NULL, goal TEXT NOT NULL, task_type TEXT,
    agent TEXT NOT NULL, strategy TEXT, check_cmd TEXT NOT NULL, accept_cmd TEXT,
    verdict TEXT NOT NULL, verdict_reasons TEXT NOT NULL, diff_sha TEXT NOT NULL, usage TEXT,
    started_at TEXT NOT NULL, finished_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS predictions (
    run_id TEXT NOT NULL, source TEXT NOT NULL, p REAL NOT NULL, features TEXT, model_version TEXT, at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS outcomes (
    run_id TEXT NOT NULL, kind TEXT NOT NULL, r INTEGER NOT NULL, at TEXT NOT NULL)`);
}

export function insertPrediction(
  db: DatabaseSync,
  row: { runId: string; source: string; p: number; features?: string | undefined; modelVersion?: string | undefined },
): void {
  ensureJudgeSchema(db);
  db.prepare('INSERT INTO predictions (run_id, source, p, features, model_version, at) VALUES (?, ?, ?, ?, ?, ?)').run(
    row.runId,
    row.source,
    row.p,
    row.features ?? null,
    row.modelVersion ?? null,
    new Date().toISOString(),
  );
}

export function insertOutcome(db: DatabaseSync, row: { runId: string; kind: string; r: 0 | 1 }): void {
  ensureJudgeSchema(db);
  db.prepare('INSERT INTO outcomes (run_id, kind, r, at) VALUES (?, ?, ?, ?)').run(
    row.runId,
    row.kind,
    row.r,
    new Date().toISOString(),
  );
}

/** Past process predictions that have an accept outcome, for fitting `p_process`. */
export function processHistory(db: DatabaseSync): { features: string; r: number }[] {
  ensureJudgeSchema(db);
  return db
    .prepare(
      `SELECT p.features AS features, o.r AS r FROM predictions p JOIN outcomes o ON o.run_id = p.run_id
       WHERE p.source = 'process' AND o.kind = 'accept' AND p.features IS NOT NULL`,
    )
    .all() as { features: string; r: number }[];
}

/** One row per prediction with its accept outcome. */
export function scoredRows(db: DatabaseSync): { source: string; p: number; r: 0 | 1 }[] {
  ensureJudgeSchema(db);
  return db
    .prepare(
      `SELECT p.source AS source, p.p AS p, o.r AS r FROM predictions p JOIN outcomes o ON o.run_id = p.run_id
       WHERE o.kind = 'accept'`,
    )
    .all() as { source: string; p: number; r: 0 | 1 }[];
}

export type JudgeRow = {
  id: string;
  root: string;
  base: string;
  goal: string;
  taskType: string | undefined;
  agent: string;
  checkCmd: string;
  acceptCmd?: string | undefined;
  verdict: string;
  reasons: string;
  diffSha: string;
  usage: string | undefined;
  startedAt: string;
  finishedAt: string;
};

export function insertJudgeRun(db: DatabaseSync, row: JudgeRow): void {
  ensureJudgeSchema(db);
  db.prepare(`INSERT INTO judge_runs (id, root, base, goal, task_type, agent, strategy, check_cmd, accept_cmd,
    verdict, verdict_reasons, diff_sha, usage, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.root,
    row.base,
    row.goal,
    row.taskType ?? null,
    row.agent,
    row.agent,
    row.checkCmd,
    row.acceptCmd ?? null,
    row.verdict,
    row.reasons,
    row.diffSha,
    row.usage ?? null,
    row.startedAt,
    row.finishedAt,
  );
}

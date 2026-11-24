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
  db.exec(`CREATE TABLE IF NOT EXISTS task_runs (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_type TEXT NOT NULL, expected TEXT NOT NULL,
    rep INTEGER NOT NULL, claimed_done INTEGER NOT NULL)`);
}

export function insertTaskRun(
  db: DatabaseSync,
  row: { runId: string; taskId: string; taskType: string; expected: string; rep: number; claimedDone: boolean },
): void {
  ensureJudgeSchema(db);
  db.prepare(
    'INSERT INTO task_runs (run_id, task_id, task_type, expected, rep, claimed_done) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.runId, row.taskId, row.taskType, row.expected, row.rep, row.claimedDone ? 1 : 0);
}

export type ReportRow = {
  runId: string;
  agent: string;
  taskId: string;
  taskType: string;
  expected: string;
  verdict: string;
  claimedDone: boolean;
  /** Result of the accept check, absent when it did not run. */
  r: 0 | 1 | undefined;
  predictions: { source: string; p: number }[];
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
};

/** Every measured run (rows in `task_runs`) with its verdict, predictions, accept outcome and usage. */
export function reportRows(db: DatabaseSync): ReportRow[] {
  ensureJudgeSchema(db);
  const runs = db
    .prepare(
      `SELECT t.run_id AS id, j.agent AS agent, t.task_id AS task_id, t.task_type AS task_type, t.expected AS expected,
        j.verdict AS verdict, t.claimed_done AS claimed, j.usage AS usage,
        (SELECT o.r FROM outcomes o WHERE o.run_id = t.run_id AND o.kind = 'accept' ORDER BY o.at LIMIT 1) AS r
       FROM task_runs t JOIN judge_runs j ON j.id = t.run_id ORDER BY j.started_at`,
    )
    .all() as {
    id: string; agent: string; task_id: string; task_type: string; expected: string; verdict: string;
    claimed: number; usage: string | null; r: number | null;
  }[];
  const predictionQuery = db.prepare('SELECT source, p FROM predictions WHERE run_id = ?');
  return runs.map((run) => {
    let usage: ReportRow['usage'];
    try {
      usage = run.usage ? (JSON.parse(run.usage) as ReportRow['usage']) : undefined;
    } catch {
      usage = undefined;
    }
    return {
      runId: run.id,
      agent: run.agent,
      taskId: run.task_id,
      taskType: run.task_type,
      expected: run.expected,
      verdict: run.verdict,
      claimedDone: run.claimed === 1,
      r: run.r === null ? undefined : run.r === 1 ? 1 : 0,
      predictions: (predictionQuery.all(run.id) as { source: string; p: number }[]).map((row) => ({
        source: row.source,
        p: row.p,
      })),
      usage,
    };
  });
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

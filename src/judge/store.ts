import type { DatabaseSync } from 'node:sqlite';

/** Journal table for judged runs. `accept_cmd` and `task_type` are filled by later steps. */
export function ensureJudgeSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS judge_runs (
    id TEXT PRIMARY KEY, root TEXT NOT NULL, base TEXT NOT NULL, goal TEXT NOT NULL, task_type TEXT,
    agent TEXT NOT NULL, strategy TEXT, check_cmd TEXT NOT NULL, accept_cmd TEXT,
    verdict TEXT NOT NULL, verdict_reasons TEXT NOT NULL, diff_sha TEXT NOT NULL, usage TEXT,
    started_at TEXT NOT NULL, finished_at TEXT NOT NULL)`);
}

export type JudgeRow = {
  id: string;
  root: string;
  base: string;
  goal: string;
  taskType: string | undefined;
  agent: string;
  checkCmd: string;
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.root,
    row.base,
    row.goal,
    row.taskType ?? null,
    row.agent,
    row.agent,
    row.checkCmd,
    row.verdict,
    row.reasons,
    row.diffSha,
    row.usage ?? null,
    row.startedAt,
    row.finishedAt,
  );
}

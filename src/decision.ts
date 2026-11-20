import { randomUUID } from 'node:crypto';
import type { Journal } from './durable.ts';

/** A probability recorded before the coding verdict, scored afterwards. Brier (1950). */
export type Forecast = {
  id: string;
  taskId: string;
  statement: string;
  confidence: number;
  outcome?: 0 | 1;
};

export function parseForecast(value: unknown): { statement: string; confidence: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('A forecast must be an object');
  const record = value as { statement?: unknown; confidence?: unknown };
  if (typeof record.statement !== 'string' || !record.statement.trim()) throw new Error('A forecast needs a statement');
  if (typeof record.confidence !== 'number' || Number.isNaN(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    throw new Error('Confidence must be a number from 0 to 1');
  }
  return { statement: record.statement.trim(), confidence: record.confidence };
}

/** Mean squared error. Unscored forecasts are ignored. No scored row means undefined. */
export function brierScore(forecasts: Pick<Forecast, 'confidence' | 'outcome'>[]): number | undefined {
  const scored = forecasts.filter((item): item is { confidence: number; outcome: 0 | 1 } => item.outcome === 0 || item.outcome === 1);
  if (!scored.length) return undefined;
  return scored.reduce((sum, item) => sum + (item.confidence - item.outcome) ** 2, 0) / scored.length;
}

export class DecisionJournal {
  constructor(journal: Journal) {
    journal.db.exec(`CREATE TABLE IF NOT EXISTS forecasts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, statement TEXT NOT NULL, confidence REAL NOT NULL,
      outcome INTEGER, scored_at TEXT
    )`);
    this.#db = journal.db;
  }

  readonly #db: import('node:sqlite').DatabaseSync;

  record(taskId: string, statement: string, confidence: number): Forecast {
    const parsed = parseForecast({ statement, confidence });
    const id = randomUUID();
    this.#db.prepare('INSERT INTO forecasts (id, task_id, statement, confidence) VALUES (?, ?, ?, ?)').run(id, taskId, parsed.statement, parsed.confidence);
    return { id, taskId, statement: parsed.statement, confidence: parsed.confidence };
  }

  score(id: string, outcome: 0 | 1): void {
    const updated = this.#db.prepare('UPDATE forecasts SET outcome = ?, scored_at = ? WHERE id = ? AND outcome IS NULL').run(outcome, new Date().toISOString(), id);
    if (updated.changes === 0) throw new Error(`Forecast ${id} is missing or already scored`);
  }

  all(): Forecast[] {
    return (this.#db.prepare('SELECT id, task_id, statement, confidence, outcome FROM forecasts ORDER BY rowid').all() as {
      id: string; task_id: string; statement: string; confidence: number; outcome: number | null;
    }[]).map(row => ({
      id: row.id, taskId: row.task_id, statement: row.statement, confidence: row.confidence,
      ...(row.outcome === null ? {} : { outcome: row.outcome as 0 | 1 }),
    }));
  }

  brier(): number | undefined {
    return brierScore(this.all());
  }
}

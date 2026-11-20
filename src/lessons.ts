import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Journal } from './durable.ts';
import { recall } from './memory.ts';
import type { Memory } from './memory.ts';

/** A distilled claim about a repository. Status is evidence, not a mood. */
export type LessonStatus = 'unverified' | 'supported' | 'contested' | 'retracted';
export type Lesson = {
  id: string;
  text: string;
  status: LessonStatus;
  files: string[];
  /** Engineering weight. The 0.8 decay is not an Ebbinghaus parameter. */
  strength: number;
  retrieved: number;
  evidence: { runId: string; taskId: string; status: string }[];
  updatedAt: string;
};

const decay = 0.8;
const floor = 0.15;
const start = '<!-- vlyn-lessons:start -->';
const end = '<!-- vlyn-lessons:end -->';

function slug(file: string): string {
  return `lesson-${file.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'file'}`;
}

function lessonText(file: string): string {
  return `Edits touching ${file} failed or left their ownership unverified more than once.`;
}

export class LessonStore {
  constructor(journal: Journal) {
    this.#journal = journal;
    journal.db.exec(`
      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT NOT NULL, root TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (root, id)
      );
      CREATE TABLE IF NOT EXISTS lesson_state (root TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    `);
  }

  readonly #journal: Journal;

  /** Distill task outcomes once per change in those outcomes. Listing twice does not decay twice. */
  consolidate(root: string): Lesson[] {
    const fingerprint = this.#fingerprint(root);
    const previous = this.#journal.db.prepare('SELECT fingerprint FROM lesson_state WHERE root = ?').get(root) as { fingerprint: string } | undefined;
    if (previous?.fingerprint === fingerprint) return this.#load(root);
    const counts = new Map<string, { runId: string; taskId: string; status: string }[]>();
    for (const run of this.#journal.runs().filter(item => item.root === root)) {
      for (const row of this.#journal.tasks(run.id)) {
        if (row.status !== 'failed' && row.status !== 'unverified') continue;
        const files = row.result?.outOfScope?.length ? row.result.outOfScope : row.status === 'failed' ? (row.task.files ?? row.result?.changedFiles ?? []) : [];
        for (const file of files) {
          counts.set(file, [...(counts.get(file) ?? []), { runId: run.id, taskId: row.task.id, status: row.status }]);
        }
      }
    }
    const existing = new Map(this.#load(root).map(lesson => [lesson.id, lesson]));
    const reinforced = new Set<string>();
    const now = new Date().toISOString();
    for (const [file, evidence] of counts) {
      if (evidence.length < 2) continue;
      const id = slug(file);
      const prior = existing.get(id);
      if (prior?.status === 'retracted') continue;
      if (prior && JSON.stringify(prior.evidence) === JSON.stringify(evidence)) {
        reinforced.add(id);
        continue;
      }
      existing.set(id, {
        id,
        text: lessonText(file),
        status: prior ? 'supported' : 'unverified',
        files: [file],
        strength: prior ? Math.min(1, Math.round((prior.strength + 0.2) * 1000) / 1000) : 0.4,
        retrieved: prior?.retrieved ?? 0,
        evidence,
        updatedAt: now,
      });
      reinforced.add(id);
    }
    for (const lesson of existing.values()) {
      if (lesson.status === 'retracted' || reinforced.has(lesson.id)) continue;
      lesson.strength = Math.round(lesson.strength * decay * 1000) / 1000;
      lesson.updatedAt = now;
      if (lesson.strength < floor) existing.delete(lesson.id);
    }
    this.#save(root, [...existing.values()]);
    this.#journal.db.prepare('INSERT OR REPLACE INTO lesson_state (root, fingerprint) VALUES (?, ?)').run(root, fingerprint);
    return this.#load(root);
  }

  /**
   * A lesson that was eligible to steer this outcome is updated by it.
   * Unused lessons are not rewritten.
   */
  reconsolidate(root: string, outcome: { files: string[]; status: 'completed' | 'failed' | 'unverified' }): Lesson[] {
    const trouble = outcome.status !== 'completed';
    const now = new Date().toISOString();
    const next = this.#load(root).map(lesson => {
      if (lesson.status === 'retracted' || !lesson.files.some(file => outcome.files.includes(file))) return lesson;
      return {
        ...lesson,
        retrieved: lesson.retrieved + 1,
        status: trouble ? 'supported' as const : 'contested' as const,
        strength: trouble ? Math.min(1, Math.round((lesson.strength + 0.2) * 1000) / 1000) : Math.max(0, Math.round((lesson.strength - 0.3) * 1000) / 1000),
        updatedAt: now,
      };
    });
    this.#save(root, next);
    return next;
  }

  retract(root: string, id: string): void {
    const lessons = this.#load(root).map(lesson => lesson.id === id ? { ...lesson, status: 'retracted' as const, updatedAt: new Date().toISOString() } : lesson);
    this.#save(root, lessons);
  }

  recall(root: string, options: { limit?: number; maxChars?: number } = {}): Lesson[] {
    const ranked = this.#load(root)
      .filter(lesson => lesson.status !== 'retracted' && lesson.strength >= floor)
      .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
    const chosen: Lesson[] = [];
    let used = 0;
    for (const lesson of ranked) {
      const size = JSON.stringify(lesson).length;
      if (chosen.length >= (options.limit ?? 5) || used + size > (options.maxChars ?? 2000)) break;
      chosen.push(lesson);
      used += size;
    }
    return chosen;
  }

  #fingerprint(root: string): string {
    const parts: string[] = [];
    for (const run of this.#journal.runs().filter(item => item.root === root)) {
      for (const row of this.#journal.tasks(run.id)) {
        parts.push([run.id, row.task.id, row.status, (row.result?.outOfScope ?? []).join(',')].join(':'));
      }
    }
    return parts.join('|');
  }

  #load(root: string): Lesson[] {
    return (this.#journal.db.prepare('SELECT body FROM lessons WHERE root = ? ORDER BY id').all(root) as { body: string }[])
      .map(row => JSON.parse(row.body) as Lesson);
  }

  #save(root: string, lessons: Lesson[]): void {
    this.#journal.db.prepare('DELETE FROM lessons WHERE root = ?').run(root);
    const insert = this.#journal.db.prepare('INSERT INTO lessons (id, root, body) VALUES (?, ?, ?)');
    for (const lesson of lessons) insert.run(lesson.id, root, JSON.stringify(lesson));
  }
}

export function asMemory(lesson: Lesson): Memory {
  return {
    runId: lesson.evidence[0]?.runId ?? lesson.id,
    at: lesson.updatedAt,
    goal: 'lesson',
    task: lesson.id,
    status: lesson.status,
    files: lesson.files,
    note: lesson.text,
    score: lesson.strength,
  };
}

/** Lessons first, then episodic recall, inside the same 5-item / 2 KB budget. */
export function planningMemory(journal: Journal, root: string, goal: string): Memory[] {
  const store = new LessonStore(journal);
  store.consolidate(root);
  const items = [...store.recall(root).map(asMemory), ...recall(journal, root, goal)];
  const chosen: Memory[] = [];
  let used = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (chosen.length >= 5 || used + size > 2000) break;
    chosen.push(item);
    used += size;
  }
  return chosen;
}

export function suggestion(lessons: Lesson[]): string {
  const visible = lessons.filter(lesson => lesson.status !== 'retracted');
  const lines = ['# Lessons proposed from earlier runs', '', 'Review these. They are claims from past checks, not orders.'];
  if (!visible.length) lines.push('', 'No active lessons.');
  for (const lesson of visible) lines.push('', `- [${lesson.status}] ${lesson.text}`);
  return lines.join('\n');
}

/** Write only the marked section of AGENTS.md. Other lines are kept. */
export async function applySuggestion(root: string, lessons: Lesson[]): Promise<void> {
  const path = join(root, 'AGENTS.md');
  const block = `${start}\n${suggestion(lessons)}\n${end}\n`;
  let current = '';
  try { current = await readFile(path, 'utf8'); } catch { /* new file */ }
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}\\n?`, 'u');
  const next = pattern.test(current) ? current.replace(pattern, block) : current.trim() ? `${current.trimEnd()}\n\n${block}` : block;
  await writeFile(path, next);
}

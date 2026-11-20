import type { Journal } from './durable.ts';

/** One remembered task outcome from an earlier run in the same repository. */
export type Memory = {
  runId: string;
  at: string;
  goal: string;
  task: string;
  status: string;
  files: string[];
  note: string;
  /** Why this was recalled: words shared with the goal, files shared with the new work. */
  score: number;
};

const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'all', 'make', 'add', 'update']);
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/gu)?.filter(word => !stop.has(word)) ?? []);

/**
 * Recall what earlier runs in this repository learned, before planning. The journal is the single source of truth, so
 * nothing is copied and nothing goes stale: each item names its run. Failures and unverified tasks rank higher, because
 * they are the lessons that change a plan. Output is capped (working-memory budget) so it cannot flood the planner.
 */
export function recall(journal: Journal, root: string, goal: string, options: { files?: string[]; limit?: number; maxChars?: number } = {}): Memory[] {
  const goalWords = words(goal);
  const wanted = new Set(options.files ?? []);
  const found: Memory[] = [];
  for (const run of journal.runs().filter(item => item.root === root)) {
    const overlapGoal = [...words(run.goal)].filter(word => goalWords.has(word)).length;
    const convergence = journal.convergence(run.id);
    for (const row of journal.tasks(run.id)) {
      if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'unverified') continue;
      const files = row.task.files ?? row.result?.changedFiles ?? [];
      const overlapFiles = files.filter(file => wanted.has(file)).length;
      const overlapTask = [...words(row.task.task)].filter(word => goalWords.has(word)).length;
      const lesson = row.status === 'completed' ? 0 : 2;
      const score = overlapGoal + overlapTask + overlapFiles * 2 + (overlapGoal + overlapTask + overlapFiles ? lesson : 0);
      if (score === 0) continue;
      const result = row.result;
      let note = result?.result?.summary ?? result?.error ?? '';
      if (result?.outOfScope?.length) note += ` Edited outside its files: ${result.outOfScope.join(', ')}.`;
      if (convergence && !convergence.passed) note += ' The combined result of this run did not pass integration.';
      found.push({ runId: run.id, at: run.createdAt, goal: run.goal, task: row.task.id, status: row.status, files, note: note.trim().slice(0, 300), score });
    }
  }
  found.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  const chosen: Memory[] = [];
  let used = 0;
  for (const item of found) {
    const size = JSON.stringify(item).length;
    if (chosen.length >= (options.limit ?? 5) || used + size > (options.maxChars ?? 2000)) break;
    chosen.push(item);
    used += size;
  }
  return chosen;
}

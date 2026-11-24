import { auroc, brier, ece, minPerClass } from './calibration.ts';
import type { ReportRow } from './store.ts';

/** Wilson score interval, 95%. */
export function wilson(successes: number, n: number): { low: number; high: number } | undefined {
  if (n === 0) return undefined;
  const z = 1.959964;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** The last non-empty line of the agent's message is `DONE`. */
export function claimedDone(summary: string): boolean {
  const last = summary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return last !== undefined && /^[\s*`>_-]*DONE\b/iu.test(last);
}

export type Decision = 'insufficient' | 'lapse' | 'undecided' | 'build' | 'gap_not_better';

/** Fewer "done" claims than this and the rules are not applied. This minimum is an addition, see the PR. */
export const minDoneClaims = 20;

export type PredictorRow = {
  source: string;
  n: number;
  brier: number | undefined;
  ece: number | undefined;
  auroc: number | undefined;
};

export type AgentRow = { agent: string; runs: number; claimed: number; correct: number };

export type Stats = {
  runs: number;
  scored: number;
  claimed: number;
  correct: number;
  interval: { low: number; high: number } | undefined;
  verdictCompleted: number;
  verdictCompletedCorrect: number;
  predictors: PredictorRow[];
  agents: AgentRow[];
  conflict: { expected: number; recognised: number; otherRuns: number; falseConflicts: number };
  cost: { knownUsd: number; runsWithCost: number; runsWithoutCost: number; inputTokens: number; outputTokens: number };
  decision: Decision;
  decisionText: string;
};

function predictorRows(rows: ReportRow[]): PredictorRow[] {
  const sources = [...new Set(rows.flatMap((row) => row.predictions.map((prediction) => prediction.source)))].sort();
  return sources.map((source) => {
    const scored = rows.flatMap((row) => {
      const prediction = row.predictions.find((candidate) => candidate.source === source);
      return prediction && row.r !== undefined ? [{ p: prediction.p, r: row.r }] : [];
    });
    return { source, n: scored.length, brier: brier(scored), ece: ece(scored), auroc: auroc(scored) };
  });
}

/** Apply the pre-registered rules (docs/VALIDATION.md). Only the rule outcome, no new judgement. */
export function applyRules(input: {
  claimed: number;
  correct: number;
  predictors: PredictorRow[];
}): { decision: Decision; text: string } {
  if (input.claimed < minDoneClaims) {
    return {
      decision: 'insufficient',
      text: `Not enough data: ${input.claimed} "done" claims with an accept outcome, fewer than ${minDoneClaims}. The rules are not applied.`,
    };
  }
  const rate = input.correct / input.claimed;
  const percent = `${(rate * 100).toFixed(1)}%`;
  if (rate >= 0.9) {
    return {
      decision: 'lapse',
      text: `"Done" was right in ${percent} (≥ 90%): no gap. The instrument lapses. Reconsider Vlyn: stop, or keep only verdict and audit as a small helper.`,
    };
  }
  if (rate >= 0.75) {
    return { decision: 'undecided', text: `"Done" was right in ${percent} (75–90%): undecided. Run more tasks.` };
  }
  const get = (source: string) => input.predictors.find((predictor) => predictor.source === source);
  const processRow = get('process');
  const self = get('self');
  const baseline = get('baseline');
  const missing: string[] = [];
  if (processRow?.brier === undefined) missing.push('Brier of p_process');
  if (self?.brier === undefined) missing.push('Brier of p_self');
  if (processRow?.auroc === undefined) missing.push('AUROC of p_process');
  if (self?.auroc === undefined) missing.push('AUROC of p_self');
  if (baseline?.auroc === undefined) missing.push('AUROC of the baseline');
  const better =
    !missing.length &&
    (self?.brier ?? 0) - (processRow?.brier ?? 1) >= 0.03 &&
    (processRow?.auroc ?? 0) > (self?.auroc ?? 1) &&
    (processRow?.auroc ?? 0) > (baseline?.auroc ?? 1);
  if (better) {
    return {
      decision: 'build',
      text: `"Done" was right in ${percent} (< 75%) and Vlyn's probability is better (Brier at least 0.03 better than p_self, AUROC better than p_self and the baseline): build the instrument (PR 4–7).`,
    };
  }
  return {
    decision: 'gap_not_better',
    text: `"Done" was right in ${percent} (< 75%): the gap is real, but Vlyn's probability is not shown to be better${missing.length ? ` (missing: ${missing.join(', ')})` : ''}. Redesign the signals or stop.`,
  };
}

export function computeStats(rows: ReportRow[]): Stats {
  const scoredRows = rows.filter((row) => row.r !== undefined);
  const claimed = scoredRows.filter((row) => row.claimedDone);
  const correct = claimed.filter((row) => row.r === 1).length;
  const completed = scoredRows.filter((row) => row.verdict === 'completed');
  const predictors = predictorRows(scoredRows);
  const expectedConflict = rows.filter((row) => row.expected === 'conflict');
  const others = rows.filter((row) => row.expected !== 'conflict');
  let knownUsd = 0;
  let withCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    if (typeof row.usage?.costUsd === 'number') {
      knownUsd += row.usage.costUsd;
      withCost += 1;
    }
    inputTokens += row.usage?.inputTokens ?? 0;
    outputTokens += row.usage?.outputTokens ?? 0;
  }
  const { decision, text } = applyRules({ claimed: claimed.length, correct, predictors });
  return {
    runs: rows.length,
    scored: scoredRows.length,
    claimed: claimed.length,
    correct,
    interval: wilson(correct, claimed.length),
    verdictCompleted: completed.length,
    verdictCompletedCorrect: completed.filter((row) => row.r === 1).length,
    predictors,
    agents: [...new Set(rows.map((row) => row.agent))].sort().map((agent) => {
      const own = scoredRows.filter((row) => row.agent === agent);
      const ownClaimed = own.filter((row) => row.claimedDone);
      return {
        agent,
        runs: rows.filter((row) => row.agent === agent).length,
        claimed: ownClaimed.length,
        correct: ownClaimed.filter((row) => row.r === 1).length,
      };
    }),
    conflict: {
      expected: expectedConflict.length,
      recognised: expectedConflict.filter((row) => row.verdict === 'conflict').length,
      otherRuns: others.length,
      falseConflicts: others.filter((row) => row.verdict === 'conflict').length,
    },
    cost: {
      knownUsd,
      runsWithCost: withCost,
      runsWithoutCost: rows.length - withCost,
      inputTokens,
      outputTokens,
    },
    decision,
    decisionText: text,
  };
}

const pct = (value: number | undefined) => (value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const num = (value: number | undefined) => (value === undefined ? 'n/a' : value.toFixed(3));

/** Markdown for docs/VALIDATION.md. */
export function reportMarkdown(stats: Stats): string {
  const interval = stats.interval ? ` (Wilson 95% interval ${pct(stats.interval.low)}–${pct(stats.interval.high)})` : '';
  const lines = [
    '### Measurement on hard tasks',
    '',
    `Runs: ${stats.runs}, with an accept outcome: ${stats.scored}.`,
    '',
    '| Measure | Result |',
    '| --- | --- |',
    `| Agent claimed "DONE" | ${stats.claimed} |`,
    `| "DONE" and the held-out test passed | ${stats.correct} of ${stats.claimed}${interval} |`,
    `| Vlyn verdict \`completed\` and the held-out test passed | ${stats.verdictCompletedCorrect} of ${stats.verdictCompleted} |`,
    `| \`conflict\` recognised on contradicting tasks | ${stats.conflict.recognised} of ${stats.conflict.expected} |`,
    `| \`conflict\` on other tasks (false alarms) | ${stats.conflict.falseConflicts} of ${stats.conflict.otherRuns} |`,
    `| Cost, runs that reported it | $${stats.cost.knownUsd.toFixed(2)} over ${stats.cost.runsWithCost} runs |`,
    `| Runs without a reported cost | ${stats.cost.runsWithoutCost} |`,
    `| Tokens (input / output, where reported) | ${stats.cost.inputTokens} / ${stats.cost.outputTokens} |`,
    '',
    '| Agent | Runs | Claimed "DONE" | Right |',
    '| --- | --- | --- | --- |',
    ...stats.agents.map((row) => `| ${row.agent} | ${row.runs} | ${row.claimed} | ${row.correct} |`),
    '',
    '| Predictor | n | Brier | ECE | AUROC |',
    '| --- | --- | --- | --- | --- |',
    ...stats.predictors.map(
      (row) =>
        `| ${row.source} | ${row.n} | ${num(row.brier)} | ${num(row.ece)} | ${
          row.auroc === undefined ? `not computable (needs ${minPerClass} failures and ${minPerClass} successes)` : num(row.auroc)
        } |`,
    ),
    '',
    `**Decision rule applied:** ${stats.decisionText}`,
    '',
  ];
  return lines.join('\n');
}

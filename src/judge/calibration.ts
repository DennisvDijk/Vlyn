import type { JudgeDetails } from './types.ts';

/** The fixed question for `p_self`. It is asked after the run, in its own call, never inside the task prompt. */
export const selfQuestion = 'Hoe groot is de kans, 0 tot 1, dat een onafhankelijke acceptatietest slaagt?';

/** First probability in a reply: `0.85`, `0,85`, `85%`, `1`. Anything else is undefined. */
export function parseProbability(text: string): number | undefined {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(%)?/u);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(',', '.'));
  const p = match[2] ? value / 100 : value;
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined;
}

/** Process signals, in a fixed order. Everything is known before `--accept` runs. */
export const featureNames = [
  'check_passed',
  'check_failed',
  'protected_touched',
  'out_of_scope',
  'skip_markers',
  'conflict_reported',
  'empty_diff',
  'crashed',
  'log_diff_lines',
  'log_changed_files',
] as const;

export type Features = Record<(typeof featureNames)[number], number>;

export function featuresOf(input: {
  crashed: boolean;
  checkRan: boolean;
  checkPassed: boolean;
  details: JudgeDetails;
  changedFiles: number;
  diffLines: number;
}): Features {
  return {
    check_passed: input.checkRan && input.checkPassed ? 1 : 0,
    check_failed: input.checkRan && !input.checkPassed ? 1 : 0,
    protected_touched: input.details.protectedTouched.length ? 1 : 0,
    out_of_scope: input.details.outOfScope.length ? 1 : 0,
    skip_markers: input.details.skipMarkers.length ? 1 : 0,
    conflict_reported: input.details.conflicts.length ? 1 : 0,
    empty_diff: input.changedFiles === 0 ? 1 : 0,
    crashed: input.crashed ? 1 : 0,
    log_diff_lines: Math.log10(1 + input.diffLines),
    log_changed_files: Math.log10(1 + input.changedFiles),
  };
}

export type Model = { version: string; bias: number; weights: number[] };

/** Hand-set weights. In the first measurement a model like this scored badly (Brier 0.20), so it is a starting point only. */
export const handModel: Model = {
  version: 'hand-v1',
  bias: 0.3,
  //        passed failed prot  scope skip  confl empty crash ldiff lfiles
  weights: [1.5, -1.5, -1.5, -1.0, -1.5, -1.5, -1.0, -3.0, -0.3, -0.2],
};

export const minOutcomesToFit = 30;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const vector = (features: Features): number[] => featureNames.map((name) => features[name]);

export function predict(model: Model, features: Features): number {
  const x = vector(features);
  return sigmoid(model.bias + model.weights.reduce((sum, weight, index) => sum + weight * (x[index] ?? 0), 0));
}

/** Plain batch gradient descent with a small L2 term. No dependencies. Needs at least `minOutcomesToFit` rows. */
export function fitLogistic(rows: { features: Features; r: 0 | 1 }[], rounds = 3000, rate = 0.3, l2 = 0.01): Model {
  const width = featureNames.length;
  const weights = new Array<number>(width).fill(0);
  let bias = 0;
  for (let round = 0; round < rounds; round++) {
    const gradient = new Array<number>(width).fill(0);
    let biasGradient = 0;
    for (const row of rows) {
      const x = vector(row.features);
      const error = sigmoid(bias + x.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0)) - row.r;
      biasGradient += error;
      for (let index = 0; index < width; index++) gradient[index] = (gradient[index] ?? 0) + error * (x[index] ?? 0);
    }
    bias -= (rate * biasGradient) / rows.length;
    for (let index = 0; index < width; index++) {
      weights[index] = (weights[index] ?? 0) - rate * ((gradient[index] ?? 0) / rows.length + l2 * (weights[index] ?? 0));
    }
  }
  return { version: `lr-n${rows.length}`, bias, weights };
}

/** The model to use: a fitted one from at least 30 earlier outcomes, otherwise the hand-set one. */
export function chooseModel(history: { features: Features; r: 0 | 1 }[]): Model {
  return history.length >= minOutcomesToFit ? fitLogistic(history) : handModel;
}

export type Scored = { p: number; r: 0 | 1 };

export function brier(rows: Scored[]): number | undefined {
  if (!rows.length) return undefined;
  return rows.reduce((sum, row) => sum + (row.p - row.r) ** 2, 0) / rows.length;
}

/** Expected calibration error over equal-width bins. */
export function ece(rows: Scored[], bins = 10): number | undefined {
  if (!rows.length) return undefined;
  let total = 0;
  for (let bin = 0; bin < bins; bin++) {
    const inBin = rows.filter((row) => Math.min(bins - 1, Math.floor(row.p * bins)) === bin);
    if (!inBin.length) continue;
    const confidence = inBin.reduce((sum, row) => sum + row.p, 0) / inBin.length;
    const accuracy = inBin.reduce((sum, row) => sum + row.r, 0) / inBin.length;
    total += (inBin.length / rows.length) * Math.abs(confidence - accuracy);
  }
  return total;
}

/** Fewer failures or successes than this and AUROC is not reported. */
export const minPerClass = 3;

/** Area under the ROC curve by rank sums, ties counted half. Undefined when either class has too few rows. */
export function auroc(rows: Scored[]): number | undefined {
  const positives = rows.filter((row) => row.r === 1);
  const negatives = rows.filter((row) => row.r === 0);
  if (positives.length < minPerClass || negatives.length < minPerClass) return undefined;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) wins += positive.p > negative.p ? 1 : positive.p === negative.p ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

export type PredictorScore = {
  source: string;
  n: number;
  successes: number;
  brier: number | undefined;
  ece: number | undefined;
  auroc: number | undefined;
};

export function scoreAll(rows: { source: string; p: number; r: 0 | 1 }[]): PredictorScore[] {
  const sources = [...new Set(rows.map((row) => row.source))].sort();
  return sources.map((source) => {
    const own = rows.filter((row) => row.source === source);
    return {
      source,
      n: own.length,
      successes: own.filter((row) => row.r === 1).length,
      brier: brier(own),
      ece: ece(own),
      auroc: auroc(own),
    };
  });
}

export function calibrationText(scores: PredictorScore[]): string {
  if (!scores.length) return 'Nog geen uitkomsten. Draai vlyn judge met --accept.';
  const number = (value: number | undefined) => (value === undefined ? 'n.v.t.' : value.toFixed(3));
  const lines = ['predictor     n  geslaagd  Brier  ECE    AUROC'];
  for (const score of scores) {
    lines.push(
      `${score.source.padEnd(12)} ${String(score.n).padStart(3)}  ${String(score.successes).padStart(8)}  ${number(score.brier)}  ${number(score.ece)}  ${
        score.auroc === undefined ? 'AUROC niet te berekenen' : number(score.auroc)
      }`,
    );
  }
  return lines.join('\n');
}

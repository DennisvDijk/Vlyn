import type { AgentProvider } from './coding-agent.ts';
import type { ActorRuntime, Hypothesis } from './actors.ts';
import { brierScore } from './actors.ts';
import { executeTask, gitOutput } from './parallel.ts';
import type { CodingTask } from './parallel.ts';

export type HypothesisRun = {
  hypothesisId: string;
  actorId: string;
  status: 'completed' | 'unverified' | 'failed';
  confidence: number;
};

/**
 * Fork one coder per hypothesis from the same planner snapshot, edit in
 * separate worktrees, and let a verifier accept only a `completed` verdict.
 * Siblings do not see each other's diffs. Dissent is kept.
 */
export async function raceHypotheses(options: {
  runtime: ActorRuntime;
  hypotheses: (Hypothesis & { task: string; worktree: string; provider: AgentProvider; check?: string })[];
}): Promise<{
  plannerId: string;
  plannerVersion: number;
  accepted?: string;
  dissent: string[];
  results: HypothesisRun[];
  brier?: number;
}> {
  if (options.hypotheses.length < 2) throw new Error('A race needs at least two hypotheses');
  const planner = options.runtime.spawn('planner', { context: options.hypotheses.map(item => item.text).join('\n') });
  const plannerBrain = options.runtime.brain(planner.actor.id);
  plannerBrain.hypotheses = options.hypotheses.map(({ id, text, confidence, files }) => ({ id, text, confidence, files }));
  const plannerVersion = options.runtime.checkpoint(planner.actor.id, plannerBrain, { sleep: false });
  const results: HypothesisRun[] = [];
  for (const hypothesis of options.hypotheses) {
    const coder = options.runtime.fork(planner.actor.id, { role: 'coder', hypothesis });
    const before = options.runtime.brain(coder.actor.id);
    if (before.decisions[0]?.outcome !== undefined) throw new Error('Confidence was scored before the check');
    const task: CodingTask = {
      id: hypothesis.id,
      task: hypothesis.task,
      ...(hypothesis.check ? { check: hypothesis.check } : {}),
      ...(hypothesis.files.length ? { files: hypothesis.files } : {}),
    };
    const result = await executeTask(task, hypothesis.worktree, hypothesis.provider);
    const brain = options.runtime.brain(coder.actor.id);
    const commit = (await gitOutput(hypothesis.worktree, ['rev-parse', 'HEAD'])).trim();
    brain.workspace = { root: hypothesis.worktree, commit, diff: result.diff.slice(-20_000) };
    brain.taskGraph = {
      nodes: (result.result?.graph.nodes ?? []).map(node => ({ id: node.id, label: node.label })),
      edges: (result.result?.graph.edges ?? []).map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    };
    const outcome: 0 | 1 = result.status === 'completed' ? 1 : 0;
    brain.decisions = [{ id: hypothesis.id, prediction: hypothesis.text, confidence: hypothesis.confidence, outcome }];
    brain.episodic.push({ at: new Date().toISOString(), status: result.status, files: result.changedFiles, note: result.error ?? result.result?.summary ?? '' });
    options.runtime.checkpoint(coder.actor.id, brain, { sleep: false });
    options.runtime.send(coder.actor.id, planner.actor.id, 'verdict', { hypothesisId: hypothesis.id, status: result.status, outcome });
    results.push({ hypothesisId: hypothesis.id, actorId: coder.actor.id, status: result.status, confidence: hypothesis.confidence });
  }
  const verifier = options.runtime.spawn('verifier');
  for (const result of results) {
    options.runtime.send(result.actorId, verifier.actor.id, 'verdict', { hypothesisId: result.hypothesisId, status: result.status });
  }
  const messages = options.runtime.inbox(verifier.actor.id);
  const verifierBrain = options.runtime.brain(verifier.actor.id);
  verifierBrain.decisions = results.map(result => ({
    id: result.hypothesisId,
    prediction: options.hypotheses.find(item => item.id === result.hypothesisId)?.text ?? result.hypothesisId,
    confidence: result.confidence,
    outcome: result.status === 'completed' ? 1 : 0,
  }));
  verifierBrain.workingContext = messages.map(message => JSON.stringify(message.body)).join('\n');
  options.runtime.checkpoint(verifier.actor.id, verifierBrain, { sleep: false });
  options.runtime.ack(messages.map(message => message.id));
  const accepted = results.find(result => result.status === 'completed')?.hypothesisId;
  return {
    plannerId: planner.actor.id,
    plannerVersion,
    ...(accepted ? { accepted } : {}),
    dissent: results.filter(result => result.hypothesisId !== accepted).map(result => result.hypothesisId),
    results,
    brier: brierScore(options.runtime.brain(verifier.actor.id).decisions),
  };
}

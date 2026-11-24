import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityLog } from '../broker.ts';
import { manifestFor } from '../capabilities.ts';
import { Journal } from '../durable.ts';
import { gitOutput, owns } from '../parallel.ts';
import { posture, runGoverned } from '../sandbox.ts';
import { createAdapter } from './adapters.ts';
import type { FakeScript } from './adapters.ts';
import { chooseModel, featuresOf, handModel, parseProbability, predict, selfQuestion } from './calibration.ts';
import type { Features } from './calibration.ts';
import { findSkipMarkers, protectedPaths, scriptsDiffer } from './gates.ts';
import { insertJudgeRun, insertOutcome, insertPrediction, processHistory } from './store.ts';
import { JudgeRefusal } from './types.ts';
import type {
  AgentAdapter,
  AgentEvent,
  JudgeDetails,
  JudgeOptions,
  JudgeResult,
  ModelUsage,
  Verdict,
  VerdictReason,
} from './types.ts';

export * from './types.ts';
export * from './calibration.ts';
export { scoredRows } from './store.ts';
export { createAdapter, fakeAdapter, taskPrompt } from './adapters.ts';
export type { FakeScript } from './adapters.ts';
export { extractConflicts, findSkipMarkers, isDefaultProtected, protectedPaths } from './gates.ts';

const defaultTimeoutMs = 20 * 60_000;

/** Pure verdict rule. Order matters: a crash beats everything, a reported conflict beats a failing check. */
export function decide(input: {
  crashed: boolean;
  check: { ran: boolean; passed: boolean };
  details: JudgeDetails;
  emptyDiff: boolean;
  allowNoop: boolean;
}): { verdict: Verdict; reasons: VerdictReason[] } {
  const { details } = input;
  if (input.crashed) return { verdict: 'failed', reasons: [] };
  if (input.check.ran && !input.check.passed && details.conflicts.length) {
    return { verdict: 'conflict', reasons: ['check_failed', 'conflict_reported'] };
  }
  if (!input.check.ran) return { verdict: 'unverified', reasons: ['check_unrunnable'] };
  if (!input.check.passed) return { verdict: 'failed', reasons: ['check_failed'] };
  const reasons: VerdictReason[] = [];
  if (details.protectedTouched.length) reasons.push('protected_touched');
  if (details.outOfScope.length) reasons.push('out_of_scope');
  if (details.skipMarkers.length) reasons.push('skip_markers');
  if (input.emptyDiff && !input.allowNoop) reasons.push('empty_diff');
  return reasons.length ? { verdict: 'unverified', reasons } : { verdict: 'completed', reasons: [] };
}

async function fileAt(root: string, rev: string, path: string): Promise<string | undefined> {
  try {
    return await gitOutput(root, ['show', `${rev}:${path}`]);
  } catch {
    return undefined;
  }
}

/**
 * Run an existing coding agent in a detached worktree and return a verdict. The verdict comes from the worktree and from
 * Vlyn's own run of `check` afterwards, never from what the agent says, except that a named conflict turns a failing check
 * into `conflict`. The agent process itself is NOT sandboxed by Vlyn in this phase. Only the check is.
 */
export async function judge(options: JudgeOptions): Promise<JudgeResult> {
  if (!options.goal?.trim()) throw new JudgeRefusal('A goal is required (--goal).');
  if (!options.check?.trim()) throw new JudgeRefusal('A check command is required (--check).');
  const requireSandbox = options.requireSandbox ?? true;
  const isolates = options.isolates ?? (() => posture().isolates);
  if (requireSandbox && !isolates()) {
    throw new JudgeRefusal(
      'Refusing to run: this OS has no sandbox that can isolate the check. Pass --no-require-sandbox to run it unconfined.',
    );
  }
  const adapter: AgentAdapter = typeof options.agent === 'string' ? scriptedAdapter(options.agent) : options.agent;

  const root = await realpath(options.root ?? process.cwd());
  let top: string;
  try {
    top = await realpath((await gitOutput(root, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    throw new JudgeRefusal('Not a Git repository.');
  }
  if (root !== top) throw new JudgeRefusal('vlyn judge requires the Git repository root.');
  if ((await gitOutput(root, ['status', '--porcelain', '--untracked-files=normal'])).trim()) {
    throw new JudgeRefusal('vlyn judge requires a clean working tree. Commit or stash changes first.');
  }

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const base = (await gitOutput(root, ['rev-parse', 'HEAD'])).trim();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vlyn-judge-')));
  const worktree = join(directory, 'work');
  await gitOutput(root, ['worktree', 'add', '--detach', '--', worktree, base]);

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let summary = '';
  let conflicts: string[] = [];
  let usage: ModelUsage | undefined;
  let selfConfidence: number | undefined;
  let error: string | undefined;
  let finished = false;
  try {
    for await (const event of adapter.run({
      worktree,
      goal: options.goal,
      check: options.check,
      env: options.env ?? {},
      signal: controller.signal,
    }) as AsyncIterable<AgentEvent>) {
      if (event.type === 'finish') {
        finished = true;
        summary = event.summary;
        conflicts = event.conflicts ?? [];
        usage = event.usage;
        selfConfidence = event.selfConfidence;
      }
    }
    if (!finished) error = 'agent ended without a finish event';
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearTimeout(timer);
  }
  const crashed = error !== undefined || timedOut;

  // Facts from the worktree.
  const diff = await gitOutput(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
  const tracked = await gitOutput(worktree, ['diff', '--name-only', '-z', 'HEAD', '--']);
  const untrackedNames = (await gitOutput(worktree, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean);
  const changedFiles = [...new Set([...tracked.split('\0'), ...untrackedNames].filter(Boolean))];
  const untrackedText: Record<string, string> = {};
  for (const file of untrackedNames) {
    try {
      const text = await readFile(join(worktree, file), 'utf8');
      if (text.length < 500_000) untrackedText[file] = text;
    } catch {
      /* binary or unreadable: nothing to scan */
    }
  }
  const packageScriptsChanged =
    changedFiles.some((file) => file === 'package.json') &&
    scriptsDiffer(
      await fileAt(worktree, 'HEAD', 'package.json'),
      await readFile(join(worktree, 'package.json'), 'utf8').catch(() => undefined),
    );
  const details: JudgeDetails = {
    protectedTouched: protectedPaths(changedFiles, options.protect ?? [], packageScriptsChanged),
    outOfScope: options.files?.length ? changedFiles.filter((file) => !owns(options.files as string[], file)) : [],
    skipMarkers: findSkipMarkers(diff, untrackedText),
    conflicts,
    ...(crashed ? { error: timedOut ? 'timeout' : error } : {}),
  };

  // Vlyn's own run of the check, after the last edit, in the sandbox.
  let check: JudgeResult['check'];
  let ran = false;
  let passed = false;
  if (!crashed) {
    try {
      const result = await runGoverned({
        command: options.check,
        cwd: worktree,
        manifest: manifestFor(worktree, { check: options.check }),
        requireSandbox,
      });
      ran = result.exitCode !== null;
      passed = result.exitCode === 0;
      check = {
        command: options.check,
        exitCode: result.exitCode,
        output: result.output,
        driver: result.isolation.driver,
        isolated: result.isolation.isolates,
      };
    } catch (cause) {
      check = {
        command: options.check,
        exitCode: null,
        output: cause instanceof Error ? cause.message : String(cause),
        driver: 'refused',
        isolated: false,
      };
    }
  }

  const { verdict, reasons: base_reasons } = decide({
    crashed,
    check: { ran, passed },
    details,
    emptyDiff: changedFiles.length === 0,
    allowNoop: options.allowNoop ?? false,
  });
  const reasons: VerdictReason[] = crashed ? [timedOut ? 'timeout' : 'agent_crash'] : base_reasons;
  const diffSha = createHash('sha256').update(diff).update(JSON.stringify(untrackedText)).digest('hex');

  // Predictions come before the held-out check. Nothing below this line may change them.
  const journal = options.record === false ? undefined : new Journal(options.home);
  let accept: JudgeResult['accept'];
  let predictions: JudgeResult['predictions'];
  let finishedAt = new Date().toISOString();
  try {
    const features = featuresOf({
      crashed,
      checkRan: ran,
      checkPassed: passed,
      details,
      changedFiles: changedFiles.length,
      diffLines: diff.split('\n').filter((line) => /^[+-](?![+-])/u.test(line)).length,
    });
    const model = journal ? chooseModel(historyOf(journal)) : handModel;
    const pProcess = predict(model, features);
    let pSelf: number | undefined;
    if (!crashed) {
      try {
        const reply = adapter.ask
          ? await adapter.ask(
              { worktree, goal: options.goal, check: options.check, env: options.env ?? {}, signal: controller.signal },
              selfQuestion,
              summary,
            )
          : undefined;
        pSelf = reply === undefined ? selfConfidence : parseProbability(reply);
      } catch {
        pSelf = selfConfidence;
      }
    }
    predictions = { ...(pSelf === undefined ? {} : { self: pSelf }), process: pProcess, processModel: model.version };

    if (journal) {
      insertJudgeRun(journal.db, {
        id,
        root,
        base,
        goal: options.goal,
        taskType: options.taskType,
        agent: adapter.name,
        checkCmd: options.check,
        acceptCmd: options.accept,
        verdict,
        reasons: JSON.stringify({ reasons, ...details }),
        diffSha,
        usage: usage ? JSON.stringify(usage) : undefined,
        startedAt,
        finishedAt,
      });
      const log = new SecurityLog(journal.db);
      log.append({
        runId: id,
        actorId: 'judge',
        action: 'judge.start',
        target: adapter.name,
        decision: 'allow',
        detail: options.goal,
      });
      log.append({
        runId: id,
        actorId: 'judge',
        action: 'judge.verdict',
        target: verdict,
        decision: verdict === 'completed' ? 'allow' : 'deny',
        detail: JSON.stringify({ reasons, diffSha }),
      });
      for (const [source, p, version, detail] of [
        ['process', pProcess, model.version, JSON.stringify(features)] as const,
        ...(pSelf === undefined ? [] : [['self', pSelf, 'asked-after-run', undefined] as const]),
      ]) {
        insertPrediction(journal.db, { runId: id, source, p, features: detail, modelVersion: version });
        log.append({
          runId: id,
          actorId: 'judge',
          action: 'judge.prediction',
          target: source,
          decision: 'allow',
          detail: JSON.stringify({ p, modelVersion: version }),
        });
      }
    }

    // Held-out check. Its output is dropped here: only pass or fail is kept.
    if (options.accept?.trim()) {
      options.onAccept?.();
      accept = await runAccept(options.accept, options.acceptDir, worktree, requireSandbox);
      if (journal && accept.ran) {
        const r = accept.passed ? 1 : 0;
        insertOutcome(journal.db, { runId: id, kind: 'accept', r });
        new SecurityLog(journal.db).append({
          runId: id,
          actorId: 'judge',
          action: 'judge.outcome',
          target: 'accept',
          decision: accept.passed ? 'allow' : 'deny',
          detail: JSON.stringify({ r }),
        });
      }
    }
    finishedAt = new Date().toISOString();
  } finally {
    journal?.close();
    if (!options.keepWorktree) {
      await gitOutput(root, ['worktree', 'remove', '--force', '--', worktree]).catch(() => undefined);
      await gitOutput(root, ['worktree', 'prune']).catch(() => undefined);
    }
  }
  return {
    id,
    verdict,
    reasons,
    details,
    agent: adapter.name,
    goal: options.goal,
    base,
    summary,
    changedFiles,
    diff,
    diffSha,
    check,
    usage,
    selfConfidence,
    predictions,
    accept,
    startedAt,
    finishedAt,
    worktree: options.keepWorktree ? worktree : undefined,
  };
}

function historyOf(journal: Journal): { features: Features; r: 0 | 1 }[] {
  const rows: { features: Features; r: 0 | 1 }[] = [];
  for (const row of processHistory(journal.db)) {
    try {
      rows.push({ features: JSON.parse(row.features) as Features, r: row.r === 1 ? 1 : 0 });
    } catch {
      /* a row we cannot read is left out of the fit */
    }
  }
  return rows;
}

/** Run the held-out check in the sandbox. The folder with the held-out tests is copied in only now. */
async function runAccept(
  command: string,
  acceptDir: string | undefined,
  worktree: string,
  requireSandbox: boolean,
): Promise<{ ran: boolean; passed: boolean }> {
  try {
    if (acceptDir) await cp(acceptDir, join(worktree, '.vlyn-accept'), { recursive: true });
    const result = await runGoverned({
      command,
      cwd: worktree,
      manifest: manifestFor(worktree, { check: command }),
      requireSandbox,
    });
    return { ran: result.exitCode !== null, passed: result.exitCode === 0 };
  } catch {
    return { ran: false, passed: false };
  }
}

/** `fake` reads its script from the file named in VLYN_FAKE_SCRIPT. It exists for tests of the CLI. */
function scriptedAdapter(name: string): AgentAdapter {
  if (name !== 'fake') return createAdapter(name);
  const path = process.env.VLYN_FAKE_SCRIPT;
  if (!path) return createAdapter('fake');
  let script: FakeScript;
  try {
    script = JSON.parse(readFileSync(path, 'utf8')) as FakeScript;
  } catch (cause) {
    throw new JudgeRefusal(`Cannot read VLYN_FAKE_SCRIPT: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return createAdapter('fake', { script });
}

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityLog } from '../broker.ts';
import { manifestFor } from '../capabilities.ts';
import { Journal } from '../durable.ts';
import { gitOutput, owns } from '../parallel.ts';
import { posture, runGoverned } from '../sandbox.ts';
import { createAdapter } from './adapters.ts';
import type { FakeScript } from './adapters.ts';
import { findSkipMarkers, protectedPaths, scriptsDiffer } from './gates.ts';
import { insertJudgeRun } from './store.ts';
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
  const finishedAt = new Date().toISOString();
  const result: JudgeResult = {
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
    diffSha: createHash('sha256').update(diff).update(JSON.stringify(untrackedText)).digest('hex'),
    check,
    usage,
    selfConfidence,
    startedAt,
    finishedAt,
    worktree: options.keepWorktree ? worktree : undefined,
  };

  try {
    if (options.record !== false) record(result, root, options);
  } finally {
    if (!options.keepWorktree) {
      await gitOutput(root, ['worktree', 'remove', '--force', '--', worktree]).catch(() => undefined);
      await gitOutput(root, ['worktree', 'prune']).catch(() => undefined);
    }
  }
  return result;
}

function record(result: JudgeResult, root: string, options: JudgeOptions): void {
  const journal = new Journal(options.home);
  try {
    insertJudgeRun(journal.db, {
      id: result.id,
      root,
      base: result.base,
      goal: result.goal,
      taskType: options.taskType,
      agent: result.agent,
      checkCmd: options.check,
      verdict: result.verdict,
      reasons: JSON.stringify({ reasons: result.reasons, ...result.details }),
      diffSha: result.diffSha,
      usage: result.usage ? JSON.stringify(result.usage) : undefined,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    });
    const log = new SecurityLog(journal.db);
    log.append({
      runId: result.id,
      actorId: 'judge',
      action: 'judge.start',
      target: result.agent,
      decision: 'allow',
      detail: result.goal,
    });
    log.append({
      runId: result.id,
      actorId: 'judge',
      action: 'judge.verdict',
      target: result.verdict,
      decision: result.verdict === 'completed' ? 'allow' : 'deny',
      detail: JSON.stringify({ reasons: result.reasons, diffSha: result.diffSha }),
    });
  } finally {
    journal.close();
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

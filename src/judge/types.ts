export type ModelUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  costUsd?: number | undefined;
};

export type AgentEvent =
  | { type: 'edit'; path: string }
  | { type: 'command'; command: string; exitCode?: number | undefined }
  | { type: 'text'; text: string }
  | {
      type: 'finish';
      summary: string;
      /** Tests the agent names as clashing with the goal. Empty or absent means no conflict reported. */
      conflicts?: string[] | undefined;
      selfConfidence?: number | undefined;
      usage?: ModelUsage | undefined;
    };

export type AgentRunInput = {
  worktree: string;
  goal: string;
  check: string;
  /** Extra environment for the agent process, on top of the parent's. Not a secret store. */
  env: Record<string, string>;
  signal: AbortSignal;
};

export interface AgentAdapter {
  name: string;
  /** Yields events and ends with one `finish` event. Throws when the agent crashes. */
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  /**
   * Optional. Ask the agent the fixed confidence question after the run, in a separate call that is not part of the task
   * prompt. Returns the reply text. Adapters without it give no `p_self`.
   */
  ask?(input: AgentRunInput, question: string, summary: string): Promise<string | undefined>;
}

export type Verdict = 'completed' | 'unverified' | 'conflict' | 'failed';

export type VerdictReason =
  | 'agent_crash'
  | 'timeout'
  | 'check_failed'
  | 'check_unrunnable'
  | 'conflict_reported'
  | 'protected_touched'
  | 'out_of_scope'
  | 'skip_markers'
  | 'empty_diff';

export type SkipHit = { file: string; line: string };

export type JudgeDetails = {
  protectedTouched: string[];
  outOfScope: string[];
  skipMarkers: SkipHit[];
  conflicts: string[];
  error?: string | undefined;
};

export type JudgeOptions = {
  /** An adapter name (`claude`, `codex`, `pi`, `fake`) or an adapter object. */
  agent: string | AgentAdapter;
  goal: string;
  /** Visible check. Vlyn runs it again itself after the agent finished. */
  check: string;
  /** Repository root. Defaults to the current directory. */
  root?: string | undefined;
  /** Owned files or folders. Empty means everything except what is protected. */
  files?: string[] | undefined;
  /** Extra protected paths, on top of the defaults. */
  protect?: string[] | undefined;
  timeoutMs?: number | undefined;
  allowNoop?: boolean | undefined;
  /** Default true. Refuses to run when this OS cannot isolate the check. */
  requireSandbox?: boolean | undefined;
  /** Journal folder. Defaults to VLYN_HOME or ~/.vlyn. */
  home?: string | undefined;
  /** Skip the journal and audit chain. For tests of pure logic. */
  record?: boolean | undefined;
  keepWorktree?: boolean | undefined;
  /** Used by tests to replace the platform sandbox probe. */
  isolates?: (() => boolean) | undefined;
  env?: Record<string, string> | undefined;
  taskType?: string | undefined;
  /**
   * Held-out acceptance check. It runs only after the predictions are written, in the sandbox, and its output is never
   * stored and never shown to the agent. Only pass or fail is kept.
   */
  accept?: string | undefined;
  /**
   * Folder with the held-out tests. It lives outside the repository and is copied into the worktree as `.vlyn-accept/`
   * only after the predictions are written.
   */
  acceptDir?: string | undefined;
  /** Called right before the accept check starts. For tests of the ordering. */
  onAccept?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
};

export type JudgeResult = {
  id: string;
  verdict: Verdict;
  reasons: VerdictReason[];
  details: JudgeDetails;
  agent: string;
  goal: string;
  base: string;
  summary: string;
  changedFiles: string[];
  diff: string;
  diffSha: string;
  check: { command: string; exitCode: number | null; output: string; driver: string; isolated: boolean } | undefined;
  usage: ModelUsage | undefined;
  selfConfidence: number | undefined;
  /** Probabilities that were written before the accept check ran. Absent keys mean no prediction. */
  predictions: { self?: number; process: number; processModel: string } | undefined;
  /** Only pass or fail of the held-out check. `ran` is false when it could not start. */
  accept: { ran: boolean; passed: boolean } | undefined;
  startedAt: string;
  finishedAt: string;
  worktree: string | undefined;
};

/** Exit codes of `vlyn judge`. */
export const exitCodes: Record<Verdict, number> = { completed: 0, failed: 1, unverified: 2, conflict: 5 };
export const exitRefused = 3;
export const exitInternal = 4;

/** Thrown when Vlyn will not start: dirty tree, no sandbox with `requireSandbox`, bad input. */
export class JudgeRefusal extends Error {
  override name = 'JudgeRefusal';
}

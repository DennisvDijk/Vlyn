import { spawnSync } from 'node:child_process';
import { manifestFor, splitCommand } from '../capabilities.ts';
import { runGoverned } from '../sandbox.ts';

/**
 * Baseline predictor: an existing verifier, run as an external command in the sandbox. Vlyn contains no code of that tool.
 * Only a JSON verdict is read from its output, and that output is treated as untrusted: nothing else is kept.
 */

/** True when the first word of the command resolves to an executable on this machine. */
export function baselineInstalled(command: string): boolean {
  const program = splitCommand(command)[0];
  if (!program) return false;
  if (program === process.execPath || program === 'node') return true;
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [program], { stdio: 'ignore' });
  return lookup.status === 0;
}

/**
 * 1 when the verifier's JSON says the work passes, 0 when it says it does not, undefined when the output is not a
 * recognisable verdict. Reads `verdict` (a string containing "pass" or "complete") or `entries` / `verifiers` (all `passed`).
 */
export function parseBaseline(output: string): 0 | 1 | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.verdict === 'string') return /pass|complete/iu.test(record.verdict) ? 1 : 0;
  const list = Array.isArray(record.entries) ? record.entries : Array.isArray(record.verifiers) ? record.verifiers : undefined;
  if (!list?.length) return undefined;
  return list.every((entry) => (entry as { passed?: unknown } | null)?.passed === true) ? 1 : 0;
}

export type BaselineOutcome = { p: 0 | 1 | undefined; reason?: string };

export async function runBaseline(command: string, worktree: string, requireSandbox: boolean): Promise<BaselineOutcome> {
  if (!baselineInstalled(command)) return { p: undefined, reason: 'not installed' };
  try {
    const result = await runGoverned({
      command,
      cwd: worktree,
      manifest: manifestFor(worktree, { check: command }),
      requireSandbox,
    });
    if (result.exitCode === null) return { p: undefined, reason: 'could not start' };
    const p = parseBaseline(result.output);
    return p === undefined ? { p, reason: 'no verdict in output' } : { p };
  } catch (cause) {
    return { p: undefined, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

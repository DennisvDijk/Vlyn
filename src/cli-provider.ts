import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentProvider } from './coding-agent.ts';
import { isObject } from './workspace.ts';

/**
 * Sign in with a Claude or ChatGPT/Codex account instead of an API key. Vlyn does not read or copy those logins:
 * it runs the official `claude` or `codex` program, which uses its own stored login, as a text-only model.
 * The program gets no tools of its own (Claude: `--tools ""`; Codex: read-only sandbox), so Vlyn's tools, sandbox
 * and checks stay in charge.
 */
export type CliKind = 'claude-cli' | 'codex-cli';
export type CliRun = (command: string, args: string[], input: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export function cliKind(value: string | undefined): CliKind | undefined {
  const name = value?.toLowerCase();
  if (name === 'claude-cli' || name === 'claude') return 'claude-cli';
  if (name === 'codex-cli' || name === 'codex') return 'codex-cli';
  return undefined;
}

const run: CliRun = (command, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(timeoutMs) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', error => reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? `\`${command}\` was not found. Install it and sign in with it first.` : error.message)));
  child.on('close', code => resolve({ code, stdout, stderr }));
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
});

function flatten(messages: AgentMessage[]): { system: string; prompt: string } {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const prompt = messages.filter(message => message.role !== 'system')
    .map(message => message.role === 'user' ? message.content : `[${message.role}]\n${message.content}`).join('\n\n');
  return { system, prompt };
}

export function createCliProvider(kind: CliKind, options: { model?: string; run?: CliRun; timeoutMs?: number; auto?: () => Promise<string | undefined> } = {}): AgentProvider {
  const exec = options.run ?? run;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pinned = options.model && options.model !== 'auto' ? options.model : undefined;
  return async messages => {
    const model = pinned ?? await options.auto?.();
    const { system, prompt } = flatten(messages);
    if (kind === 'claude-cli') {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', ...(system ? ['--system-prompt', system] : []), ...(model ? ['--model', model] : [])];
      const result = await exec('claude', args, prompt, timeoutMs);
      let body: unknown;
      try { body = JSON.parse(result.stdout); } catch { /* reported below */ }
      if (result.code !== 0 || !isObject(body) || typeof body.result !== 'string' || body.is_error === true) {
        const detail = isObject(body) && typeof body.result === 'string' ? body.result : result.stderr || result.stdout;
        throw new Error(`claude failed${result.code === null ? '' : ` (exit ${result.code})`}: ${detail.trim().slice(0, 300)}. Run \`claude\` once to sign in.`);
      }
      return body.result;
    }
    const dir = await mkdtemp(join(tmpdir(), 'vlyn-codex-'));
    try {
      const out = join(dir, 'last.txt');
      const text = system ? `${system}\n\n${prompt}` : prompt;
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '-o', out, ...(model ? ['-m', model] : []), '-'];
      const result = await exec('codex', args, text, timeoutMs);
      const answer = await readFile(out, 'utf8').catch(() => '');
      if (result.code !== 0 || !answer.trim()) {
        throw new Error(`codex failed${result.code === null ? '' : ` (exit ${result.code})`}: ${(result.stderr || result.stdout).trim().slice(-300)}. Run \`codex login\` once to sign in.`);
      }
      return answer;
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
}

export type LoginModel = { id: string; label: string; available: boolean; note?: string };
export type LoginModels = { fetchedAt: string; models: LoginModel[] };
const claudeAliases = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * The models this login can use, read from the account itself so new releases appear without edits.
 * Codex: its own live catalog (`codex debug models`), in its recommended order, hidden models left out.
 * Claude: has no list command, so each alias (which always means the newest model of that family) is tried once
 * and the full model name it resolves to is recorded; one a plan cannot use is marked unavailable.
 */
export async function discoverLoginModels(kind: CliKind, options: { run?: CliRun; timeoutMs?: number } = {}): Promise<LoginModel[]> {
  const exec = options.run ?? run;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (kind === 'codex-cli') {
    const result = await exec('codex', ['debug', 'models'], '', timeoutMs);
    let body: unknown;
    try { body = JSON.parse(result.stdout); } catch { /* reported below */ }
    const list = isObject(body) && Array.isArray(body.models) ? body.models : undefined;
    if (result.code !== 0 || !list) throw new Error(`codex could not list models: ${(result.stderr || result.stdout).trim().slice(-200)}`);
    return list.flatMap((item: unknown) => {
      if (!isObject(item) || typeof item.slug !== 'string' || item.visibility === 'hide') return [];
      return [{ priority: typeof item.priority === 'number' ? item.priority : 999, model: { id: item.slug, label: typeof item.display_name === 'string' ? item.display_name : item.slug, available: true } }];
    }).sort((a, b) => a.priority - b.priority).map(entry => entry.model);
  }
  return Promise.all(claudeAliases.map(async (alias): Promise<LoginModel> => {
    try {
      const result = await exec('claude', ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--model', alias], 'Reply with: ok', timeoutMs);
      const body: unknown = JSON.parse(result.stdout);
      if (!isObject(body)) throw new Error('unreadable');
      if (body.is_error === true || result.code !== 0) return { id: alias, label: alias, available: false, note: typeof body.result === 'string' ? body.result.slice(0, 120) : 'not available on this plan' };
      const resolved = isObject(body.modelUsage) ? Object.keys(body.modelUsage).at(0) : undefined;
      return { id: alias, label: resolved ?? alias, available: true };
    } catch (error) {
      return { id: alias, label: alias, available: false, note: error instanceof Error ? error.message.slice(0, 120) : 'not available' };
    }
  }));
}

/** Discovered models, cached under the Vlyn home and refreshed when older than `ttlMs` or when `force` is set. */
export async function loginModels(kind: CliKind, home: string, options: { run?: CliRun; ttlMs?: number; force?: boolean; now?: () => Date } = {}): Promise<LoginModels & { refreshed: boolean }> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const file = join(home, 'models', `${kind}.json`);
  const ttl = options.ttlMs ?? (kind === 'claude-cli' ? 60 * 60_000 : 10 * 60_000);
  const now = (options.now ?? (() => new Date()))();
  let cached: LoginModels | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isObject(value) && typeof value.fetchedAt === 'string' && Array.isArray(value.models)) cached = value as LoginModels;
  } catch { /* none yet */ }
  if (cached && !options.force && now.getTime() - Date.parse(cached.fetchedAt) < ttl) return { ...cached, refreshed: false };
  try {
    const models = await discoverLoginModels(kind, options.run ? { run: options.run } : {});
    const fresh = { fetchedAt: now.toISOString(), models };
    await mkdir(join(home, 'models'), { recursive: true });
    await writeFile(file, JSON.stringify(fresh));
    return { ...fresh, refreshed: true };
  } catch (error) {
    if (cached) return { ...cached, refreshed: false };
    throw error;
  }
}

/** `auto`: Codex follows its own recommended model from the live list; Claude uses the plan's default, which Claude keeps current. */
export async function autoLoginModel(kind: CliKind, home: string, options: { run?: CliRun } = {}): Promise<string | undefined> {
  if (kind !== 'codex-cli') return undefined;
  try { return (await loginModels(kind, home, options)).models.find(model => model.available)?.id; } catch { return undefined; }
}

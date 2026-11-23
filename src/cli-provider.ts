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

export function createCliProvider(kind: CliKind, options: { model?: string; run?: CliRun; timeoutMs?: number } = {}): AgentProvider {
  const exec = options.run ?? run;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const model = options.model && options.model !== 'auto' ? options.model : undefined;
  return async messages => {
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

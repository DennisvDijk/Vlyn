import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripJsonc } from './registry.ts';
import { isObject } from './workspace.ts';

/**
 * Credentials Vlyn can reuse from tools you already set up, so nothing has to be exported as an environment variable:
 *  - Claude Code: `env` and `apiKeyHelper` in ~/.claude/settings.json, then the project's .claude/settings.json and
 *    .claude/settings.local.json (this is where a gateway's ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN usually live).
 *  - Codex: the active `model_provider` in ~/.codex/config.toml, and OPENAI_API_KEY in ~/.codex/auth.json if set.
 *  - opencode: ~/.local/share/opencode/auth.json.
 * Secrets are read when needed and never copied anywhere.
 */
export type Inherited = {
  kind: 'openai' | 'anthropic';
  source: string;
  apiKey: string;
  /** Send the key as `Authorization: Bearer` (Claude Code's ANTHROPIC_AUTH_TOKEN) instead of `x-api-key`. */
  bearer?: boolean;
  baseUrl?: string;
  model?: string;
};

function json(file: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const value: unknown = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
    return isObject(value) ? value : undefined;
  } catch { return undefined; }
}

/** Just enough TOML for Codex's config: top-level strings and `[model_providers.name]` tables of strings. */
export function parseCodexToml(text: string): { modelProvider?: string; model?: string; providers: Record<string, Record<string, string>> } {
  const providers: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  let top = true;
  const result: { modelProvider?: string; model?: string; providers: Record<string, Record<string, string>> } = { providers };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const table = /^\[(.+)\]$/u.exec(line);
    if (table) {
      top = false;
      const match = /^model_providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/u.exec(table[1] as string);
      current = match ? (providers[(match[1] ?? match[2]) as string] ??= {}) : undefined;
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/u.exec(line);
    if (!pair) continue;
    const [, key, value] = pair as unknown as [string, string, string];
    if (top) { if (key === 'model_provider') result.modelProvider = value; if (key === 'model') result.model = value; } else if (current) current[key] = value;
  }
  return result;
}

function withV1(url: string): string {
  const trimmed = url.replace(/\/+$/u, '');
  return /\/v\d+$/u.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export type InheritOptions = { home?: string; cwd?: string; env?: NodeJS.ProcessEnv; helper?: (command: string) => string };

export function inheritCredentials(options: InheritOptions = {}): Inherited[] {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const found: Inherited[] = [];

  // Claude Code: later files override earlier ones.
  const files = [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
  const settings = files.map(file => ({ file, data: json(file) })).filter((entry): entry is { file: string; data: Record<string, unknown> } => entry.data !== undefined);
  const claudeEnv: Record<string, string> = {};
  let helper: string | undefined;
  let claudeModel: string | undefined;
  let source = '';
  for (const { file, data } of settings) {
    if (isObject(data.env)) for (const [key, value] of Object.entries(data.env)) if (typeof value === 'string') { claudeEnv[key] = value; source = file; }
    if (typeof data.apiKeyHelper === 'string') { helper = data.apiKeyHelper; source = file; }
    if (typeof data.model === 'string') claudeModel = data.model;
  }
  const baseUrl = claudeEnv.ANTHROPIC_BASE_URL?.trim();
  const model = claudeEnv.ANTHROPIC_MODEL?.trim() || claudeModel;
  const common = { kind: 'anthropic' as const, ...(baseUrl ? { baseUrl: withV1(baseUrl) } : {}), ...(model && !/^(?:opus|sonnet|haiku|fable|default|opusplan)/iu.test(model) ? { model } : {}) };
  const key = claudeEnv.ANTHROPIC_API_KEY?.trim();
  const token = claudeEnv.ANTHROPIC_AUTH_TOKEN?.trim();
  if (key) found.push({ ...common, source: `${source} (env.ANTHROPIC_API_KEY)`, apiKey: key });
  else if (token) found.push({ ...common, source: `${source} (env.ANTHROPIC_AUTH_TOKEN)`, apiKey: token, bearer: true });
  else if (helper) {
    try {
      const out = (options.helper ?? ((command: string) => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })))(helper).trim();
      if (out) found.push({ ...common, source: `${source} (apiKeyHelper)`, apiKey: out, bearer: Boolean(baseUrl) });
    } catch { /* helper failed: not available */ }
  }

  // Codex: a custom model provider (a gateway) and an API key if the person logged in with one.
  const codexFile = join(home, '.codex', 'config.toml');
  if (existsSync(codexFile)) {
    try {
      const toml = parseCodexToml(readFileSync(codexFile, 'utf8'));
      const entry = toml.modelProvider ? toml.providers[toml.modelProvider] : undefined;
      if (entry?.base_url) {
        const secret = entry.experimental_bearer_token?.trim() || (entry.env_key ? env[entry.env_key]?.trim() : undefined);
        if (secret) found.push({ kind: 'openai', source: `${codexFile} (model_provider ${toml.modelProvider})`, apiKey: secret, baseUrl: entry.base_url.replace(/\/+$/u, ''), ...(toml.model ? { model: toml.model } : {}) });
      }
    } catch { /* unreadable config */ }
  }
  const codexAuth = json(join(home, '.codex', 'auth.json'));
  if (typeof codexAuth?.OPENAI_API_KEY === 'string' && codexAuth.OPENAI_API_KEY.trim()) {
    found.push({ kind: 'openai', source: `${join(home, '.codex', 'auth.json')} (OPENAI_API_KEY)`, apiKey: codexAuth.OPENAI_API_KEY.trim() });
  }

  // opencode: keys saved with its login command.
  const opencodeFile = join(home, '.local', 'share', 'opencode', 'auth.json');
  const opencode = json(opencodeFile);
  if (opencode) {
    for (const [id, kind] of [['anthropic', 'anthropic'], ['openai', 'openai']] as const) {
      const entry = opencode[id];
      if (isObject(entry) && entry.type === 'api' && typeof entry.key === 'string' && entry.key.trim()) {
        found.push({ kind, source: `${opencodeFile} (${id})`, apiKey: entry.key.trim() });
      }
    }
  }
  return found;
}

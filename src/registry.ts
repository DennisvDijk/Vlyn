import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { cliKind } from './cli-provider.ts';
import type { Inherited } from './inherit.ts';
import type { CliKind } from './cli-provider.ts';
import { resolveConfig } from './providers.ts';
import type { ProviderConfig, ProviderKind } from './providers.ts';
import { isObject } from './workspace.ts';

/**
 * Providers are defined in a small config file, the way opencode does it, and chosen as `provider/model`.
 *
 *   vlyn.json (project) or <home>/config.json (all projects), comments allowed:
 *   { "model": "acme/qwen3-coder",
 *     "providers": { "acme": { "type": "openai", "baseUrl": "https://llm.acme.example/v1",
 *                              "apiKey": "{env:ACME_KEY}", "headers": { "X-Team": "ai" } } } }
 *
 * `{env:NAME}` reads an environment variable and `{file:path}` a file, so a key never has to be written in the file.
 * Built in, with nothing to define: openai, anthropic, claude (your Claude login), codex (your Codex login).
 */
export type ProviderType = ProviderKind | CliKind;
export type ProviderEntry = { type?: ProviderType; baseUrl?: string; apiKey?: string; env?: string[]; headers?: Record<string, string>; models?: Record<string, { id?: string }> };
export type VlynConfig = { model?: string; providers: Record<string, ProviderEntry> };

const builtins: Record<string, { type: ProviderType; env: string[]; baseUrl?: string }> = {
  openai: { type: 'openai', env: ['VLYN_API_KEY', 'OPENAI_API_KEY'] },
  litellm: { type: 'openai', env: ['LITELLM_API_KEY', 'VLYN_API_KEY'] },
  anthropic: { type: 'anthropic', env: ['VLYN_API_KEY', 'ANTHROPIC_API_KEY'] },
  claude: { type: 'claude-cli', env: [] },
  codex: { type: 'codex-cli', env: [] },
};

/** Remove // and /* *​/ comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += char;
  }
  return out.replace(/,(\s*[}\]])/gu, '$1');
}

/** Replace `{env:NAME}` and `{file:path}` inside a string. Unset variables and missing files become empty. */
export function substitute(value: string, env: NodeJS.ProcessEnv, base: string): string {
  return value
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_all, name: string) => env[name] ?? '')
    .replace(/\{file:([^}]+)\}/gu, (_all, path: string) => {
      const full = path.startsWith('~/') ? join(homedir(), path.slice(2)) : isAbsolute(path) ? path : resolve(base, path);
      try { return readFileSync(full, 'utf8').trim(); } catch { return ''; }
    });
}

function readFile1(file: string, env: NodeJS.ProcessEnv): Partial<VlynConfig> | undefined {
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try { value = JSON.parse(stripJsonc(readFileSync(file, 'utf8'))); } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(value)) throw new Error(`${file} must contain a JSON object`);
  const base = dirname(file);
  const walk = (item: unknown): unknown => typeof item === 'string' ? substitute(item, env, base)
    : Array.isArray(item) ? item.map(walk) : isObject(item) ? Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)])) : item;
  const resolved = walk(value) as Record<string, unknown>;
  const providers = isObject(resolved.providers) ? resolved.providers as Record<string, ProviderEntry> : {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!isObject(entry)) throw new Error(`${file}: provider "${id}" must be an object`);
    if (entry.type !== undefined && !(['openai', 'anthropic', 'claude-cli', 'codex-cli'] as string[]).includes(entry.type)) {
      throw new Error(`${file}: provider "${id}" has type "${String(entry.type)}"; use openai, anthropic, claude-cli or codex-cli`);
    }
  }
  return { ...(typeof resolved.model === 'string' ? { model: resolved.model } : {}), providers };
}

/** Global config, then the project's `vlyn.json` (or `.vlyn/vlyn.json`) on top. */
export function loadConfig(home: string, root: string, env: NodeJS.ProcessEnv = process.env): VlynConfig {
  const layers = [join(home, 'config.json'), join(root, '.vlyn', 'vlyn.json'), join(root, 'vlyn.json')]
    .map(file => readFile1(file, env)).filter((layer): layer is Partial<VlynConfig> => layer !== undefined);
  const merged: VlynConfig = { providers: {} };
  for (const layer of layers) {
    if (layer.model) merged.model = layer.model;
    for (const [id, entry] of Object.entries(layer.providers ?? {})) merged.providers[id] = { ...merged.providers[id], ...entry };
  }
  return merged;
}

export type Selection =
  | { kind: 'login'; login: CliKind; provider: string; model?: string }
  | { kind: 'api'; config: ProviderConfig; provider: string; source?: string }
  | { kind: 'none' };

/**
 * Pick the provider and model. `provider/model` names both; a bare model uses the configured or legacy provider.
 * With no config at all this behaves as before (VLYN_PROVIDER, VLYN_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, ...).
 */
export function selectProvider(config: VlynConfig, env: NodeJS.ProcessEnv, flags: { model?: string; baseUrl?: string } = {}, inherited: Inherited[] = []): Selection {
  const spec = (flags.model ?? env.VLYN_MODEL ?? config.model)?.trim() || undefined;
  const known = (id: string) => id in config.providers || id in builtins;
  const slash = spec?.indexOf('/') ?? -1;
  let provider: string | undefined;
  let model = spec;
  if (spec && slash > 0 && known(spec.slice(0, slash))) { provider = spec.slice(0, slash); model = spec.slice(slash + 1); }
  provider ??= env.VLYN_PROVIDER?.toLowerCase();
  const legacyLogin = cliKind(provider);
  const entry = provider ? config.providers[provider] : undefined;
  const builtin = provider ? builtins[provider] : undefined;
  const type = entry?.type ?? builtin?.type ?? legacyLogin ?? (entry ? 'openai' : undefined);
  if (provider && !type && !entry) {
    if (provider === 'openai' || provider === 'anthropic') { /* handled by the legacy path below */ } else {
      throw new Error(`Unknown provider "${provider}". Defined: ${[...new Set([...Object.keys(config.providers), ...Object.keys(builtins)])].join(', ')}.`);
    }
  }
  if (type === 'claude-cli' || type === 'codex-cli') return { kind: 'login', login: type, provider: provider ?? type, ...(model ? { model } : {}) };
  if (provider && (entry || builtin) && type) {
    const names = entry?.env ?? builtin?.env ?? [];
    const own = entry?.apiKey?.trim() || names.map(name => env[name]?.trim()).find(Boolean) || undefined;
    const reuse = own || entry?.baseUrl ? undefined : inherited.find(item => item.kind === type);
    const key = own ?? reuse?.apiKey;
    const baseUrl = flags.baseUrl ?? entry?.baseUrl ?? reuse?.baseUrl ?? (provider === 'litellm' ? env.LITELLM_BASE_URL : undefined);
    const resolved = resolveConfig({ ...env, VLYN_PROVIDER: type, VLYN_API_KEY: key ?? '', ...(baseUrl ? { VLYN_BASE_URL: baseUrl } : {}), ...(model ? { VLYN_MODEL: model } : {}) }, {});
    if (!resolved) {
      throw new Error(`Provider "${provider}" needs a key. Set ${names.length ? names.join(' or ') : 'apiKey in its config'}${entry?.apiKey !== undefined ? ' (its apiKey resolved to nothing)' : ''}.`);
    }
    return { kind: 'api', config: { ...resolved, ...(model ? { model } : reuse?.model && resolved.model === 'auto' ? { model: reuse.model } : {}), ...(entry?.headers ? { headers: entry.headers } : {}), ...(reuse?.bearer ? { bearer: true } : {}) }, provider, ...(reuse ? { source: reuse.source } : {}) };
  }
  const legacy = resolveConfig(env, { ...(model ? { model } : {}), ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}) });
  if (legacy) return { kind: 'api', config: legacy, provider: legacy.kind };
  const reuse = inherited.find(item => !provider || item.kind === (type ?? provider));
  if (!reuse) return { kind: 'none' };
  const base = flags.baseUrl ?? reuse.baseUrl;
  const rebuilt = resolveConfig({ VLYN_PROVIDER: reuse.kind, VLYN_API_KEY: reuse.apiKey, ...(base ? { VLYN_BASE_URL: base } : {}), ...(model ?? reuse.model ? { VLYN_MODEL: (model ?? reuse.model) as string } : {}) }, {});
  return rebuilt ? { kind: 'api', config: { ...rebuilt, ...(reuse.bearer ? { bearer: true } : {}) }, provider: reuse.kind, source: reuse.source } : { kind: 'none' };
}

export function listProviders(config: VlynConfig, env: NodeJS.ProcessEnv, inherited: Inherited[] = []): { id: string; type: string; source: 'built in' | 'config'; ready: boolean; detail: string }[] {
  const ids = [...new Set([...Object.keys(builtins), ...Object.keys(config.providers)])];
  return ids.map(id => {
    const entry = config.providers[id];
    const builtin = builtins[id];
    const type = entry?.type ?? builtin?.type ?? 'openai';
    if (type === 'claude-cli' || type === 'codex-cli') return { id, type, source: builtin && !entry ? 'built in' as const : 'config' as const, ready: true, detail: `uses your ${type === 'claude-cli' ? 'Claude' : 'Codex'} login` };
    const names = entry?.env ?? builtin?.env ?? [];
    const reuse = inherited.find(item => item.kind === type);
    const found = Boolean(entry?.apiKey?.trim() || names.some(name => env[name]?.trim()) || (reuse && !entry?.baseUrl));
    return { id, type, source: builtin && !entry ? 'built in' as const : 'config' as const, ready: found || /^https?:\/\/(?:localhost|127\.0\.0\.1)/u.test(entry?.baseUrl ?? ''), detail: found ? `key found${!entry?.apiKey?.trim() && !names.some(name => env[name]?.trim()) && reuse ? ` (from ${reuse.source})` : ''}` : `needs ${names.length ? names.join(' or ') : 'apiKey'}` };
  });
}

/** Add or replace one provider in the project's vlyn.json (or the global config). The file is plain JSON. */
export async function addProvider(file: string, id: string, entry: ProviderEntry, makeDefault?: string): Promise<void> {
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const value: unknown = JSON.parse(stripJsonc(await readFile(file, 'utf8')));
    if (!isObject(value)) throw new Error(`${file} must contain a JSON object`);
    current = value;
  }
  const providers = isObject(current.providers) ? current.providers : {};
  const next = { ...current, ...(makeDefault ? { model: makeDefault } : {}), providers: { ...providers, [id]: entry } };
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temp, file);
}

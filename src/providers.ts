import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage, AgentProvider } from './coding-agent.ts';
import { completeTurn } from './llm/session.ts';
import { codingTools } from './llm/tools.ts';
import { emptyUsage } from './llm/types.ts';
import { costUsd } from './llm/request.ts';
import { isObject } from './workspace.ts';

/**
 * Model access for every system: any OpenAI-compatible endpoint (OpenAI, LiteLLM and other AI gateways, OpenRouter,
 * Azure-style gateways, vLLM, Ollama, LM Studio) and Anthropic's native API. The model list is read from the
 * endpoint with the person's own key and kept fresh, so new or retired models are picked up without edits.
 */
export type ProviderKind = 'openai' | 'anthropic';
export type ProviderConfig = {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  /** A model id, or `auto` to choose from the endpoint's live model list. */
  model: string;
  /** Environment variable the key came from, for messages. */
  keyName: string;
};
type Fetch = typeof fetch;

const defaults: Record<ProviderKind, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' };
const nonChat = /(?:embed|moderation|whisper|tts|transcribe|dall-e|image|audio|realtime|rerank|speech|sora|guard)/iu;
/** Earlier patterns win. A heuristic for `auto`; pin a model with --model or VLYN_MODEL to override it. */
const preference = [/fable/iu, /opus/iu, /gpt-5(?!.*(?:mini|nano|chat))/iu, /sonnet/iu, /gpt-4\.1(?!.*(?:mini|nano))/iu, /gemini.*pro/iu, /qwen.*coder/iu, /deepseek/iu, /llama.*(?:70|405)/iu, /mistral.*large/iu];

export function resolveConfig(env: NodeJS.ProcessEnv = process.env, flags: { model?: string; baseUrl?: string } = {}): ProviderConfig | undefined {
  const explicit = env.VLYN_PROVIDER?.toLowerCase();
  const baseOverride = flags.baseUrl ?? env.VLYN_BASE_URL ?? env.OPENAI_BASE_URL ?? env.LITELLM_BASE_URL;
  const pick = (...names: string[]): { name: string; value: string } | undefined => names.flatMap(name => {
    const value = env[name]?.trim();
    return value ? [{ name, value }] : [];
  }).at(0);
  let kind: ProviderKind;
  let key: { name: string; value: string } | undefined;
  if (explicit === 'anthropic' || (!explicit && !baseOverride && !pick('VLYN_API_KEY', 'OPENAI_API_KEY', 'LITELLM_API_KEY') && pick('ANTHROPIC_API_KEY'))) {
    kind = 'anthropic';
    key = pick('VLYN_API_KEY', 'ANTHROPIC_API_KEY');
  } else {
    kind = 'openai';
    key = pick('VLYN_API_KEY', 'LITELLM_API_KEY', 'OPENAI_API_KEY');
  }
  const local = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/u.test(baseOverride ?? '');
  if (!key?.value && !local) return undefined;
  const baseUrl = (baseOverride ?? defaults[kind]).replace(/\/+$/u, '');
  if (!/^https:\/\//u.test(baseUrl) && !local && env.VLYN_ALLOW_INSECURE !== '1') {
    throw new Error('The model endpoint must use https (set VLYN_ALLOW_INSECURE=1 to allow plain http on a private network)');
  }
  return { kind, baseUrl, apiKey: key?.value ?? 'local', keyName: key?.name ?? 'none', model: (flags.model ?? env.VLYN_MODEL ?? 'auto').trim() || 'auto' };
}

export function describeSetup(): string {
  return 'Set VLYN_API_KEY (or OPENAI_API_KEY, LITELLM_API_KEY, ANTHROPIC_API_KEY). For a gateway such as LiteLLM also set VLYN_BASE_URL. VLYN_MODEL is optional; without it Vlyn chooses from the live model list.';
}

function headers(config: ProviderConfig): Record<string, string> {
  return config.kind === 'anthropic'
    ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
}

function redact(text: string, config: ProviderConfig): string {
  return text.split(config.apiKey).join('[key]').slice(0, 300);
}

export type ModelInfo = { id: string };

/** List the chat models the key can use. Works with OpenAI, LiteLLM, OpenRouter, Ollama, vLLM and Anthropic. */
export async function fetchModels(config: ProviderConfig, request: Fetch = fetch): Promise<string[]> {
  const response = await request(`${config.baseUrl}/models${config.kind === 'anthropic' ? '?limit=1000' : ''}`, {
    headers: headers(config), redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Could not list models (HTTP ${response.status}) from ${config.baseUrl}`);
  const body: unknown = await response.json();
  const list = isObject(body) && Array.isArray(body.data) ? body.data : isObject(body) && Array.isArray(body.models) ? body.models : [];
  const ids = list.flatMap((item: unknown) => isObject(item) && typeof item.id === 'string' ? [item.id] : typeof item === 'string' ? [item] : []);
  return [...new Set(ids)].filter(id => !nonChat.test(id)).sort();
}

export function chooseModel(models: string[]): string | undefined {
  for (const pattern of preference) {
    const match = models.filter(id => pattern.test(id)).sort().at(-1);
    if (match) return match;
  }
  return models[0];
}

type Cached = { fetchedAt: string; models: string[] };

/**
 * The live model list for one endpoint and key. It is cached on disk (keyed by a hash, never the key itself),
 * refreshed when stale, kept if a refresh fails, and can be refreshed continuously with `watch`.
 */
export class ModelCatalog {
  readonly config: ProviderConfig;
  readonly ttlMs: number;
  private readonly file: string;
  private readonly request: Fetch;
  private cached?: Cached;
  private timer?: ReturnType<typeof setInterval>;

  constructor(config: ProviderConfig, home: string, options: { ttlMs?: number; request?: Fetch } = {}) {
    this.config = config;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.request = options.request ?? fetch;
    const id = createHash('sha256').update(`${config.baseUrl}\0${config.apiKey}`).digest('hex').slice(0, 16);
    this.file = join(home, 'models', `${id}.json`);
  }

  private async load(): Promise<Cached | undefined> {
    if (this.cached) return this.cached;
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (isObject(value) && typeof value.fetchedAt === 'string' && Array.isArray(value.models)) {
        this.cached = { fetchedAt: value.fetchedAt, models: value.models.filter((id): id is string => typeof id === 'string') };
      }
    } catch { /* no cache yet */ }
    return this.cached;
  }

  /** Fetch now. Returns what changed against the previous list. */
  async refresh(): Promise<{ models: string[]; added: string[]; removed: string[] }> {
    const before = (await this.load())?.models ?? [];
    const models = await fetchModels(this.config, this.request);
    const next = { fetchedAt: new Date().toISOString(), models };
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2));
    await rename(`${this.file}.tmp`, this.file);
    this.cached = next;
    return { models, added: models.filter(id => !before.includes(id)), removed: before.filter(id => !models.includes(id)) };
  }

  /** The current list: from cache while fresh, otherwise refreshed. A failed refresh falls back to the last list. */
  async models(): Promise<string[]> {
    const cached = await this.load();
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < this.ttlMs) return cached.models;
    try { return (await this.refresh()).models; } catch (error) {
      if (cached) return cached.models;
      throw error;
    }
  }

  /** Refresh every `intervalMs` while the process runs. Returns a function that stops it. */
  watch(intervalMs: number, onChange?: (change: { added: string[]; removed: string[] }) => void, onError?: (error: Error) => void): () => void {
    this.timer = setInterval(() => {
      this.refresh().then(change => { if (change.added.length || change.removed.length) onChange?.(change); },
        error => onError?.(error instanceof Error ? error : new Error(String(error))));
    }, intervalMs);
    this.timer.unref();
    return () => { if (this.timer) clearInterval(this.timer); };
  }
}

/** Pull one JSON object out of a model reply that may be wrapped in prose or a code fence. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  try { JSON.parse(trimmed); return trimmed; } catch { /* look inside */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidates = [fenced, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { JSON.parse(candidate); return candidate.trim(); } catch { /* next */ }
  }
  return trimmed;
}

function anthropicMessages(messages: AgentMessage[]): { system: string; messages: { role: 'user' | 'assistant'; content: string }[] } {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const merged: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue;
    const last = merged.at(-1);
    if (last?.role === message.role) last.content += `\n\n${message.content}`;
    else merged.push({ role: message.role, content: message.content });
  }
  return { system, messages: merged };
}

function openAITools() {
  return codingTools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false } },
  }));
}

function anthropicTools() {
  return codingTools.map(tool => ({ name: tool.name, description: tool.description, input_schema: { type: 'object', properties: tool.properties, required: tool.required } }));
}

function actionFromArguments(name: string, args: unknown): string {
  if (args === undefined || args === '') return JSON.stringify({ action: name });
  const parsed = typeof args === 'string' ? JSON.parse(args) as unknown : args;
  if (!isObject(parsed)) throw new Error('Tool arguments must be an object');
  return JSON.stringify({ action: name, ...parsed });
}

function toolAction(kind: ProviderKind, body: unknown): string | undefined {
  if (kind === 'anthropic') {
    const content = isObject(body) && Array.isArray(body.content) ? body.content : [];
    const block = content.find((item: unknown) => isObject(item) && item.type === 'tool_use' && typeof item.name === 'string');
    if (!isObject(block)) return undefined;
    return actionFromArguments(block.name as string, block.input ?? {});
  }
  const choice = isObject(body) && Array.isArray(body.choices) ? body.choices[0] as unknown : undefined;
  const message = isObject(choice) ? choice.message : undefined;
  const calls = isObject(message) && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const call = calls[0];
  if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== 'string') return undefined;
  return actionFromArguments(call.function.name, call.function.arguments ?? '{}');
}

/**
 * A provider for any configured system. With model `auto` it follows the live model list: if the chosen model is
 * rejected or retired, it refreshes the list, chooses again and retries once.
 * `tools: true` asks for native tool calls. A text JSON action is used when the model or gateway does not.
 */
export function createProvider(config: ProviderConfig, options: { catalog?: ModelCatalog; request?: Fetch; tools?: boolean; stream?: boolean } = {}): AgentProvider {
  const request = options.request ?? fetch;
  const pinned = config.model === 'auto' ? undefined : config.model;
  let jsonMode = config.kind === 'openai';
  let tools = options.tools === true;

  const resolve = async (refresh = false): Promise<string> => {
    if (pinned) return pinned;
    const catalog = options.catalog;
    if (!catalog) throw new Error('Model "auto" needs a model catalog');
    if (refresh) await catalog.refresh();
    const model = chooseModel(await catalog.models());
    if (!model) throw new Error(`No chat models are available from ${config.baseUrl}. Set VLYN_MODEL.`);
    return model;
  };

  const send = async (model: string, messages: AgentMessage[]): Promise<Response> => {
    const common = { headers: headers(config), method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000) } as const;
    if (config.kind === 'anthropic') {
      const converted = anthropicMessages(messages);
      return request(`${config.baseUrl}/messages`, { ...common, body: JSON.stringify({ model, max_tokens: 8192, system: converted.system, messages: converted.messages, ...(tools ? { tools: anthropicTools() } : {}) }) });
    }
    return request(`${config.baseUrl}/chat/completions`, {
      ...common, body: JSON.stringify({
        model, messages, store: false,
        ...(jsonMode && !tools ? { response_format: { type: 'json_object' } } : {}),
        ...(tools ? { tools: openAITools(), tool_choice: 'auto' } : {}),
      }),
    });
  };

  const totals = emptyUsage();
  const provider: AgentProvider = async messages => {
    let model = await resolve();
    let retried = false;
    for (;;) {
      let response = await send(model, messages);
      if (!response.ok && response.status === 400) {
        const detail = await response.clone().text();
        if (tools && /tool|function/iu.test(detail)) { tools = false; response = await send(model, messages); }
        else if (jsonMode && /response_format|json_object|json mode/iu.test(detail)) { jsonMode = false; response = await send(model, messages); }
      }
      if (response.ok) {
        const body: unknown = await response.json();
        if (tools) {
          try {
            const fromTool = toolAction(config.kind, body);
            if (fromTool) return fromTool;
          } catch (error) {
            throw new Error(error instanceof Error ? error.message : 'Tool arguments were not JSON');
          }
        }
        let text: unknown;
        if (config.kind === 'anthropic') {
          const block = isObject(body) && Array.isArray(body.content) ? body.content.find((item: unknown) => isObject(item) && item.type === 'text') as unknown : undefined;
          text = isObject(block) ? block.text : undefined;
        } else {
          const choice = isObject(body) && Array.isArray(body.choices) ? body.choices[0] as unknown : undefined;
          const message = isObject(choice) ? choice.message : undefined;
          text = isObject(message) ? message.content : undefined;
        }
        if (typeof text !== 'string') throw new Error('The model response did not include text');
        return extractJson(text);
      }
      const detail = redact(await response.text().catch(() => ''), config);
      const modelProblem = response.status === 404 || (response.status === 400 && /model/iu.test(detail));
      if (modelProblem && config.model === 'auto' && !retried) {
        retried = true;
        const next = await resolve(true);
        if (next !== model) { model = next; continue; }
      }
      throw new Error(`Model request failed (HTTP ${response.status}) for ${model}${detail ? `: ${detail}` : ''}`);
    }
  };
  if (options.stream) {
    provider.turn = async (messages, hooks) => {
      const model = await resolve();
      const turn = await completeTurn({
        config: { kind: config.kind, baseUrl: config.baseUrl, apiKey: config.apiKey, model },
        messages, tools, request,
        ...(hooks ? { hooks } : {}),
      });
      totals.inputTokens += turn.usage.inputTokens;
      totals.outputTokens += turn.usage.outputTokens;
      totals.cachedTokens += turn.usage.cachedTokens;
      totals.reasoningTokens += turn.usage.reasoningTokens;
      return turn;
    };
  }
  provider.usage = () => ({ ...totals, costUsd: costUsd(totals) });
  return provider;
}

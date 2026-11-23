import type { AgentMessage } from '../coding-agent.ts';
import { isObject } from '../workspace.ts';
import { assembleAnthropic, assembleChat, assembleResponses } from './assemble.ts';
import { anthropicBody, apiMode, chatBody, costUsd, reasoningEffort, responsesBody } from './request.ts';
import type { ApiMode } from './request.ts';
import { backoffMs, shouldRetryStatus, sleep } from './retry.ts';
import { readSse } from './sse.ts';
import type { ModelTurn, ModelUsage, TurnHooks } from './types.ts';
import { emptyUsage } from './types.ts';

export type SessionConfig = {
  kind: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
};

type Fetch = typeof fetch;

function headers(config: SessionConfig): Record<string, string> {
  return config.kind === 'anthropic'
    ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
}

function endpoint(config: SessionConfig, mode: ApiMode): string {
  if (mode === 'anthropic') return `${config.baseUrl}/messages`;
  if (mode === 'responses') return `${config.baseUrl.replace(/\/v1$/u, '')}/v1/responses`;
  return `${config.baseUrl}/chat/completions`;
}

function bodyFor(mode: ApiMode, model: string, messages: AgentMessage[], tools: boolean, effort: ReturnType<typeof reasoningEffort>): Record<string, unknown> {
  if (mode === 'responses') return responsesBody(model, messages, tools, effort);
  if (mode === 'anthropic') return anthropicBody(model, messages, tools, effort);
  return chatBody(model, messages, tools, true);
}

/** One model turn: stream when the server sends SSE, otherwise read a single JSON body. */
export async function completeTurn(input: {
  config: SessionConfig;
  messages: AgentMessage[];
  tools?: boolean;
  request?: Fetch;
  hooks?: TurnHooks;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelTurn> {
  const request = input.request ?? fetch;
  const env = input.env ?? process.env;
  const mode = apiMode(input.config.kind, input.config.baseUrl, env);
  const effort = reasoningEffort(env);
  const tools = input.tools === true;
  let attempt = 0;
  let last: Response | undefined;
  for (;;) {
    if (input.hooks?.signal?.aborted) throw new Error('Model stream aborted');
    const timeout = AbortSignal.timeout(120_000);
    const signal = input.hooks?.signal ? AbortSignal.any([input.hooks.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await request(endpoint(input.config, mode), {
        method: 'POST',
        headers: headers(input.config),
        body: JSON.stringify(bodyFor(mode, input.config.model, input.messages, tools, effort)),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (input.hooks?.signal?.aborted) throw new Error('Model stream aborted');
      if (attempt >= 2) throw error;
      await sleep(backoffMs(attempt, null), input.hooks?.signal);
      attempt += 1;
      continue;
    }
    if (response.ok) return readTurn(mode, response, input.hooks);
    if (!shouldRetryStatus(response.status) || attempt >= 2) {
      const detail = (await response.text().catch(() => '')).split(input.config.apiKey).join('[key]').slice(0, 300);
      throw new Error(`Model request failed (HTTP ${response.status}) for ${input.config.model}${detail ? `: ${detail}` : ''}`);
    }
    last = response;
    await sleep(backoffMs(attempt, response.headers.get('retry-after')), input.hooks?.signal);
    attempt += 1;
    void last;
  }
}

async function readTurn(mode: ApiMode, response: Response, hooks?: TurnHooks): Promise<ModelTurn> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream') || !response.body) {
    const body: unknown = await response.json();
    return jsonTurn(mode, body);
  }
  const events = [];
  for await (const event of readSse(response.body, hooks?.signal)) {
    if (event.data === '[DONE]') break;
    events.push(event);
    emit(mode, event, hooks);
  }
  const turn = mode === 'responses' ? assembleResponses(events) : mode === 'anthropic' ? assembleAnthropic(events) : assembleChat(events);
  turn.usage.costUsd = costUsd(turn.usage);
  return turn;
}

function emit(mode: ApiMode, event: { event: string; data: string }, hooks?: TurnHooks): void {
  if (!hooks?.onText && !hooks?.onToolDelta) return;
  let body: unknown;
  try { body = JSON.parse(event.data); } catch { return; }
  if (!isObject(body)) return;
  const kind = typeof body.type === 'string' ? body.type : event.event;
  if (mode === 'responses' && kind === 'response.output_text.delta' && typeof body.delta === 'string') hooks.onText?.(body.delta);
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (mode === 'chat' && isObject(choice) && isObject(choice.delta) && typeof choice.delta.content === 'string') hooks.onText?.(choice.delta.content);
  if (mode === 'anthropic' && kind === 'content_block_delta' && isObject(body.delta) && body.delta.type === 'text_delta' && typeof body.delta.text === 'string') {
    hooks.onText?.(body.delta.text);
  }
  if (mode === 'responses' && kind === 'response.function_call_arguments.delta' && typeof body.delta === 'string') {
    hooks.onToolDelta?.({ id: typeof body.item_id === 'string' ? body.item_id : 'call', text: body.delta });
  }
}

function jsonTurn(mode: ApiMode, body: unknown): ModelTurn {
  if (mode === 'responses' && isObject(body)) {
    const fake = [{ event: 'response.completed', data: JSON.stringify({ type: 'response.completed', response: body }) }];
    const turn = assembleResponses(fake);
    if (!turn.toolCalls.length && !turn.text && Array.isArray(body.output)) {
      for (const item of body.output) {
        if (isObject(item) && item.type === 'message' && typeof item.content === 'string') turn.text += item.content;
      }
    }
    turn.usage.costUsd = costUsd(turn.usage);
    return turn;
  }
  if (mode === 'anthropic') {
    const turn = assembleAnthropic([{ event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: isObject(body) ? body.usage : {} } }) }]);
    const content = isObject(body) && Array.isArray(body.content) ? body.content : [];
    for (const [index, block] of content.entries()) {
      if (!isObject(block)) continue;
      assembleInto(turn, block, index);
    }
    turn.usage = { ...(isObject(body) ? usageOnly(body.usage) : emptyUsage()), costUsd: null };
    turn.usage.costUsd = costUsd(turn.usage);
    return turn;
  }
  const turn = assembleChat([{ event: 'message', data: JSON.stringify(body) }]);
  turn.usage.costUsd = costUsd(turn.usage);
  return turn;
}

function assembleInto(turn: ModelTurn, block: Record<string, unknown>, index: number): void {
  if (block.type === 'text' && typeof block.text === 'string') turn.text += block.text;
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    turn.reasoning.push({ text: block.thinking, ...(typeof block.signature === 'string' ? { signature: block.signature } : {}) });
  }
  if (block.type === 'tool_use' && typeof block.name === 'string') {
    const args = isObject(block.input) ? block.input : {};
    turn.toolCalls.push({
      id: typeof block.id === 'string' ? block.id : `tool-${index}`,
      name: block.name,
      arguments: args,
      argumentsText: JSON.stringify(args),
    });
  }
}

function usageOnly(raw: unknown): ModelUsage {
  const usage = emptyUsage();
  if (!isObject(raw)) return usage;
  usage.inputTokens = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0;
  usage.outputTokens = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0;
  usage.cachedTokens = (typeof raw.cache_read_input_tokens === 'number' ? raw.cache_read_input_tokens : 0)
    + (typeof raw.cache_creation_input_tokens === 'number' ? raw.cache_creation_input_tokens : 0);
  return usage;
}


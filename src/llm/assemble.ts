import { isObject } from '../workspace.ts';
import type { SseEvent } from './sse.ts';
import type { ModelTurn, ModelUsage, ReasoningBlock, ToolCall } from './types.ts';
import { emptyUsage } from './types.ts';

type DraftCall = { id: string; name: string; argumentsText: string };
type DraftBlock = { type: string; id?: string; name?: string; text: string; signature?: string };

function usageFrom(raw: unknown, kind: 'responses' | 'chat' | 'anthropic'): ModelUsage {
  const usage = emptyUsage();
  if (!isObject(raw)) return usage;
  if (kind === 'anthropic') {
    usage.inputTokens = numberOf(raw.input_tokens);
    usage.outputTokens = numberOf(raw.output_tokens);
    usage.cachedTokens = numberOf(raw.cache_read_input_tokens) + numberOf(raw.cache_creation_input_tokens);
    return usage;
  }
  usage.inputTokens = numberOf(raw.input_tokens ?? raw.prompt_tokens);
  usage.outputTokens = numberOf(raw.output_tokens ?? raw.completion_tokens);
  const inputDetails = isObject(raw.input_tokens_details) ? raw.input_tokens_details : isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const outputDetails = isObject(raw.output_tokens_details) ? raw.output_tokens_details : isObject(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined;
  usage.cachedTokens = numberOf(inputDetails?.cached_tokens);
  usage.reasoningTokens = numberOf(outputDetails?.reasoning_tokens);
  return usage;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseArgs(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error('Tool arguments must be an object');
  return value;
}

function callsFrom(drafts: DraftCall[]): ToolCall[] {
  return drafts.filter(call => call.name).map(call => ({
    id: call.id,
    name: call.name,
    argumentsText: call.argumentsText,
    arguments: parseArgs(call.argumentsText || '{}'),
  }));
}

/** Fold a Responses API SSE stream into one turn. Later usage replaces earlier usage. */
export function assembleResponses(events: SseEvent[]): ModelTurn {
  let text = '';
  const calls = new Map<string, DraftCall>();
  const reasoning: ReasoningBlock[] = [];
  let usage = emptyUsage();
  let outputItems: unknown[] = [];
  let incomplete = false;
  for (const event of events) {
    if (event.data === '[DONE]') continue;
    const body = JSON.parse(event.data) as unknown;
    if (!isObject(body)) continue;
    const type = typeof body.type === 'string' ? body.type : event.event;
    if (type === 'response.output_text.delta' && typeof body.delta === 'string') text += body.delta;
    if (type === 'response.output_item.added' && isObject(body.item) && body.item.type === 'function_call') {
      const key = typeof body.item.id === 'string' ? body.item.id : typeof body.item.call_id === 'string' ? body.item.call_id : `call-${calls.size}`;
      const id = typeof body.item.call_id === 'string' ? body.item.call_id : key;
      calls.set(key, { id, name: typeof body.item.name === 'string' ? body.item.name : '', argumentsText: typeof body.item.arguments === 'string' ? body.item.arguments : '' });
    }
    if (type === 'response.function_call_arguments.delta' && typeof body.delta === 'string') {
      const key = typeof body.item_id === 'string' ? body.item_id : [...calls.keys()].at(-1);
      const call = key ? calls.get(key) : undefined;
      if (call) call.argumentsText += body.delta;
    }
    if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof body.delta === 'string') {
      const last = reasoning.at(-1);
      if (last) last.text += body.delta;
      else reasoning.push({ text: body.delta });
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      incomplete = type === 'response.incomplete';
      const response = isObject(body.response) ? body.response : body;
      if (Array.isArray(response.output)) outputItems = response.output;
      usage = usageFrom(response.usage, 'responses');
    }
  }
  if (!outputItems.length && (text || calls.size || reasoning.length)) {
    outputItems = [
      ...reasoning.map(item => ({ type: 'reasoning', summary: [{ type: 'summary_text', text: item.text }] })),
      ...[...calls.values()].map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsText })),
      ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
    ];
  }
  return { text, toolCalls: callsFrom([...calls.values()]), reasoning, outputItems, usage, incomplete };
}

/** Fold a Chat Completions SSE stream. Tool-call deltas are joined by index. */
export function assembleChat(events: SseEvent[]): ModelTurn {
  let text = '';
  const calls: DraftCall[] = [];
  let usage = emptyUsage();
  for (const event of events) {
    if (event.data === '[DONE]') continue;
    const body = JSON.parse(event.data) as unknown;
    if (!isObject(body)) continue;
    usage = { ...usage, ...nonzero(usageFrom(body.usage, 'chat')) };
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (!isObject(choice)) continue;
    const streamed = isObject(choice.delta);
    const message = isObject(choice.message) ? choice.message : {};
    const delta = streamed ? choice.delta as Record<string, unknown> : message;
    if (typeof delta.content === 'string') text += delta.content;
    if (!streamed && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== 'string') continue;
        calls.push({
          id: typeof call.id === 'string' ? call.id : `call-${calls.length}`,
          name: call.function.name,
          argumentsText: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
        });
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (!isObject(call)) continue;
        const index = typeof call.index === 'number' ? call.index : calls.length;
        const current = calls[index] ?? { id: '', name: '', argumentsText: '' };
        if (typeof call.id === 'string') current.id = call.id;
        const fn = isObject(call.function) ? call.function : {};
        if (typeof fn.name === 'string') current.name += fn.name;
        if (typeof fn.arguments === 'string') current.argumentsText += fn.arguments;
        calls[index] = current;
      }
    }
  }
  const toolCalls = callsFrom(calls.map((call, index) => ({ ...call, id: call.id || `call-${index}` })));
  return { text, toolCalls, reasoning: [], outputItems: [], usage, incomplete: false };
}

function nonzero(usage: ModelUsage): Partial<ModelUsage> {
  return {
    ...(usage.inputTokens ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cachedTokens ? { cachedTokens: usage.cachedTokens } : {}),
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

/** Fold an Anthropic Messages SSE stream, including parallel tool_use blocks and thinking signatures. */
export function assembleAnthropic(events: SseEvent[]): ModelTurn {
  let text = '';
  const blocks: DraftBlock[] = [];
  let usage = emptyUsage();
  for (const event of events) {
    const body = JSON.parse(event.data) as unknown;
    if (!isObject(body)) continue;
    const type = typeof body.type === 'string' ? body.type : event.event;
    if (type === 'message_start' && isObject(body.message)) usage = usageFrom(body.message.usage, 'anthropic');
    if (type === 'message_delta') {
      const next = usageFrom(body.usage, 'anthropic');
      usage = {
        ...usage,
        inputTokens: next.inputTokens || usage.inputTokens,
        outputTokens: next.outputTokens || usage.outputTokens,
        cachedTokens: next.cachedTokens || usage.cachedTokens,
      };
    }
    if (type === 'content_block_start' && isObject(body.content_block)) {
      const block = body.content_block;
      const index = typeof body.index === 'number' ? body.index : blocks.length;
      blocks[index] = {
        type: typeof block.type === 'string' ? block.type : 'text',
        ...(typeof block.id === 'string' ? { id: block.id } : {}),
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
        text: typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : '',
      };
    }
    if (type === 'content_block_delta' && isObject(body.delta)) {
      const index = typeof body.index === 'number' ? body.index : 0;
      const block = blocks[index] ?? { type: 'text', text: '' };
      const delta = body.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') block.text += delta.text;
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') { block.type = 'thinking'; block.text += delta.thinking; }
      if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = delta.signature;
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') block.text += delta.partial_json;
      blocks[index] = block;
    }
  }
  const toolCalls = callsFrom(blocks.filter(block => block.type === 'tool_use').map(block => ({
    id: block.id ?? `tool-${block.name}`,
    name: block.name ?? '',
    argumentsText: block.text,
  })));
  text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
  const reasoning = blocks.filter(block => block.type === 'thinking').map(block => ({
    text: block.text,
    ...(block.signature ? { signature: block.signature } : {}),
  }));
  return { text, toolCalls, reasoning, outputItems: [], usage, incomplete: false };
}

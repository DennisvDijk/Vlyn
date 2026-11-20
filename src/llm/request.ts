import type { AgentMessage } from '../coding-agent.ts';
import { isObject } from '../workspace.ts';
import { codingTools } from './tools.ts';

export type ApiMode = 'responses' | 'chat' | 'anthropic';
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** OpenAI's own host uses the Responses API. Other OpenAI-compatible hosts stay on Chat Completions. */
export function apiMode(kind: 'openai' | 'anthropic', baseUrl: string, env: NodeJS.ProcessEnv = process.env): ApiMode {
  if (kind === 'anthropic') return 'anthropic';
  if (env.VLYN_OPENAI_API === 'chat') return 'chat';
  if (env.VLYN_OPENAI_API === 'responses') return 'responses';
  try {
    return new URL(baseUrl).host === 'api.openai.com' ? 'responses' : 'chat';
  } catch {
    return 'chat';
  }
}

export function reasoningEffort(env: NodeJS.ProcessEnv = process.env): ReasoningEffort | undefined {
  const value = env.VLYN_REASONING_EFFORT;
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

/** Dollars per million tokens. Null unless both prices are set. Cached tokens use the input price. */
export function costUsd(usage: { inputTokens: number; cachedTokens: number; outputTokens: number }, env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.VLYN_PRICE_INPUT_PER_MILLION === undefined || env.VLYN_PRICE_OUTPUT_PER_MILLION === undefined) return null;
  const input = Number(env.VLYN_PRICE_INPUT_PER_MILLION);
  const output = Number(env.VLYN_PRICE_OUTPUT_PER_MILLION);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (uncached * input + usage.cachedTokens * input + usage.outputTokens * output) / 1_000_000;
}

const cache = { type: 'ephemeral' } as const;

function openAITools() {
  return [...codingTools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false },
  }));
}

function chatTools() {
  return openAITools().map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

function anthropicTools() {
  const tools = [...codingTools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
  const last = tools.at(-1);
  if (last) return [...tools.slice(0, -1), { ...last, cache_control: cache }];
  return tools;
}

/** Stable order: instructions, then tools, then history. That is the cacheable prefix. */
export function responsesBody(model: string, messages: AgentMessage[], tools: boolean, effort: ReasoningEffort | undefined): Record<string, unknown> {
  const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.outputItems?.length) {
      input.push(...message.outputItems);
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId ?? '', output: message.content });
      continue;
    }
    if (message.reasoning?.length) {
      for (const item of message.reasoning) input.push({ type: 'reasoning', ...(item.id ? { id: item.id } : {}), summary: [{ type: 'summary_text', text: item.text }] });
    }
    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
    }
    if (message.content) input.push({ type: 'message', role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
  }
  return {
    model,
    instructions,
    input,
    store: false,
    stream: true,
    ...(tools ? { tools: openAITools(), tool_choice: 'auto', parallel_tool_calls: true } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
  };
}

export function chatBody(model: string, messages: AgentMessage[], tools: boolean, stream: boolean): Record<string, unknown> {
  const converted = messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content };
    if (message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
      };
    }
    return { role: message.role, content: message.content };
  });
  return {
    model,
    messages: converted,
    store: false,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : { response_format: { type: 'json_object' } }),
    ...(tools ? { tools: chatTools(), tool_choice: 'auto', parallel_tool_calls: true } : {}),
  };
}

export function anthropicBody(model: string, messages: AgentMessage[], tools: boolean, effort: ReasoningEffort | undefined): Record<string, unknown> {
  const systemText = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const system = systemText ? [{ type: 'text', text: systemText, cache_control: cache }] : undefined;
  const converted: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content };
      const last = converted.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else converted.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant' && (message.toolCalls?.length || message.reasoning?.length)) {
      const content: unknown[] = [
        ...(message.reasoning ?? []).map(item => ({ type: 'thinking', thinking: item.text, ...(item.signature ? { signature: item.signature } : {}) })),
        ...(message.toolCalls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: parseObject(call.arguments) })),
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ];
      converted.push({ role: 'assistant', content });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const last = converted.at(-1);
    if (last?.role === role && typeof last.content === 'string') last.content += `\n\n${message.content}`;
    else converted.push({ role, content: message.content });
  }
  const last = converted.at(-1);
  if (last && typeof last.content === 'string') last.content = [{ type: 'text', text: last.content, cache_control: cache }];
  return {
    model,
    max_tokens: 8192,
    stream: true,
    cache_control: cache,
    ...(system ? { system } : {}),
    messages: converted,
    ...(tools ? { tools: anthropicTools() } : {}),
    ...(effort ? { thinking: { type: 'enabled', budget_tokens: effort === 'high' ? 8000 : effort === 'low' ? 1024 : 4000 } } : {}),
  };
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

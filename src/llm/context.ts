import type { AgentMessage } from '../coding-agent.ts';

/** Rough count. The eval suite uses the same characters/4 estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function messageTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + estimateTokens(message.toolCalls?.map(call => call.arguments).join('') ?? ''), 0);
}

/** Cap what is sent back to the model. The full check output stays on the task result. */
export function truncateToolResult(value: unknown, limit = 8_000): string {
  const text = JSON.stringify(value);
  if (text.length <= limit) return text;
  return JSON.stringify({ truncated: true, kept: text.slice(0, limit), note: `Tool output truncated from ${text.length} characters.` });
}

/**
 * When the transcript is near the window, drop the bodies of older tool results.
 * This is a local digest, not a second model call.
 */
export function compactHistory(messages: AgentMessage[], limit = 24_000): AgentMessage[] {
  if (messageTokens(messages) <= limit) return messages;
  const head = messages.filter(message => message.role === 'system');
  const rest = messages.filter(message => message.role !== 'system');
  const keep = rest.slice(-6);
  const older = rest.slice(0, -6).map(message => {
    if (message.role !== 'tool' && message.role !== 'user') return message;
    if (message.content.length < 400) return message;
    return { ...message, content: `[earlier tool output omitted, ${estimateTokens(message.content)} tokens]` };
  });
  return [...head, ...older, ...keep];
}

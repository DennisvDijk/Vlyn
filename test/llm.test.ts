import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '../src/coding-agent.ts';
import { assembleAnthropic, assembleChat, assembleResponses } from '../src/llm/assemble.ts';
import { compactHistory, estimateTokens, truncateToolResult } from '../src/llm/context.ts';
import { anthropicBody, apiMode, responsesBody } from '../src/llm/request.ts';
import { backoffMs, shouldRetryStatus } from '../src/llm/retry.ts';
import { completeTurn } from '../src/llm/session.ts';
import { pushSse, createSseState } from '../src/llm/sse.ts';

const fixture = (name: string) => readFile(fileURLToPath(new URL(`fixtures/sse/${name}`, import.meta.url)), 'utf8');

function events(text: string) {
  const state = createSseState();
  return pushSse(state, text);
}

test('SSE frames split across chunks and ignore comments', () => {
  const state = createSseState();
  assert.deepEqual(pushSse(state, 'event: ping\ndata: hel'), []);
  assert.deepEqual(pushSse(state, 'lo\n\n: keep-alive\n\ndata: [DONE]\n\n'), [
    { event: 'ping', data: 'hello' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('recorded Responses, Chat, and Anthropic streams keep parallel calls, reasoning, and cached tokens', async () => {
  const responses = assembleResponses(events(await fixture('responses.txt')));
  assert.equal(responses.toolCalls[0]?.name, 'read');
  assert.deepEqual(responses.toolCalls[0]?.arguments, { path: 'a.ts' });
  assert.equal(responses.text, 'Reading');
  assert.equal(responses.reasoning[0]?.text, 'Check the file.');
  assert.equal(responses.usage.cachedTokens, 8);
  assert.equal(responses.usage.reasoningTokens, 2);
  assert.equal((responses.outputItems[1] as { call_id?: string }).call_id, 'call_read');

  const chat = assembleChat(events(await fixture('chat.txt')));
  assert.deepEqual(chat.toolCalls.map(call => call.name), ['read', 'graph']);
  assert.equal(chat.usage.cachedTokens, 5);
  assert.equal(chat.text, 'ok');

  const anthropic = assembleAnthropic(events(await fixture('anthropic.txt')));
  assert.deepEqual(anthropic.toolCalls.map(call => [call.id, call.name]), [['toolu_1', 'read'], ['toolu_2', 'graph']]);
  assert.equal(anthropic.reasoning[0]?.signature, 'sig-1');
  assert.equal(anthropic.usage.inputTokens, 15);
  assert.equal(anthropic.usage.cachedTokens, 9);
  assert.equal(anthropic.usage.outputTokens, 4);
});

test('retries honor retry-after and jitter, and only retry overloaded statuses', () => {
  assert.equal(backoffMs(0, '2', () => 0), 2000);
  assert.equal(backoffMs(0, null, () => 0), 200);
  assert.equal(backoffMs(1, null, () => 1), 500);
  assert.equal(shouldRetryStatus(429), true);
  assert.equal(shouldRetryStatus(529), true);
  assert.equal(shouldRetryStatus(503), true);
  assert.equal(shouldRetryStatus(400), false);
  assert.equal(shouldRetryStatus(401), false);
});

test('request bodies keep a stable tool prefix and cache breakpoints', () => {
  const messages: AgentMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' }], reasoning: [{ text: 'think', signature: 'sig' }], outputItems: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' }] },
    { role: 'tool', content: 'file', toolCallId: 'call_1' },
  ];
  assert.equal(apiMode('openai', 'https://api.openai.com/v1'), 'responses');
  assert.equal(apiMode('openai', 'https://gateway.example/v1'), 'chat');
  assert.equal(apiMode('openai', 'https://gateway.example/v1', { VLYN_OPENAI_API: 'responses' }), 'responses');
  const responses = responsesBody('gpt-5.2', messages, true, 'medium');
  assert.equal(responses.instructions, 'rules');
  assert.equal(Array.isArray(responses.tools), true);
  const names = (responses.tools as { name: string }[]).map(tool => tool.name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(responses.parallel_tool_calls, true);
  assert.deepEqual(responses.reasoning, { effort: 'medium' });
  const input = responses.input as { type: string }[];
  assert.equal(input[0]?.type, 'message');
  assert.equal(input[1]?.type, 'function_call', 'replayed output items stay ahead of the new tool result');
  assert.equal(input.at(-1)?.type, 'function_call_output');

  const anthropic = anthropicBody('claude', messages, true, undefined);
  assert.equal(anthropic.cache_control && (anthropic.cache_control as { type: string }).type, 'ephemeral');
  const system = anthropic.system as { cache_control?: { type: string } }[];
  assert.equal(system[0]?.cache_control?.type, 'ephemeral');
  const tools = anthropic.tools as { cache_control?: { type: string } }[];
  assert.equal(tools.at(-1)?.cache_control?.type, 'ephemeral');
});

test('a 429 SSE response is retried and an aborted signal is not', async () => {
  let tries = 0;
  const sse = await fixture('chat.txt');
  const request = (async () => {
    tries += 1;
    if (tries === 1) return new Response('slow', { status: 429, headers: { 'retry-after': '0' } });
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const turn = await completeTurn({
    config: { kind: 'openai', baseUrl: 'https://gateway.example/v1', apiKey: 'sk', model: 'local' },
    messages: [{ role: 'user', content: 'go' }],
    tools: true,
    request,
    env: { VLYN_OPENAI_API: 'chat' },
  });
  assert.equal(tries, 2);
  assert.equal(turn.toolCalls.length, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(completeTurn({
    config: { kind: 'openai', baseUrl: 'https://gateway.example/v1', apiKey: 'sk', model: 'local' },
    messages: [{ role: 'user', content: 'go' }],
    request,
    hooks: { signal: controller.signal },
    env: { VLYN_OPENAI_API: 'chat' },
  }), /aborted/u);
});

test('streaming retries an explicit unsupported-tools response without tools', async () => {
  const text = '{"action":"finish","summary":"ok"}';
  const cases = [
    { kind: 'openai' as const, baseUrl: 'https://gateway.example/v1', env: { VLYN_OPENAI_API: 'chat' }, success: { choices: [{ message: { content: text } }] } },
    { kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', env: {}, success: { output: [{ type: 'message', content: text }] } },
    { kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', env: {}, success: { content: [{ type: 'text', text }] } },
  ];
  for (const config of cases) {
    const bodies: Record<string, unknown>[] = [];
    const request = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return Response.json({ error: { message: 'tools are not supported by this model' } }, { status: 422 });
      return Response.json(config.success);
    }) as typeof fetch;
    const turn = await completeTurn({
      config: { kind: config.kind, baseUrl: config.baseUrl, apiKey: 'key', model: 'fixture' },
      messages: [{ role: 'user', content: 'go' }], tools: true, request, env: config.env,
    });
    assert.equal(turn.text, text);
    assert.equal(bodies.length, 2);
    assert.ok(Array.isArray(bodies[0]?.tools));
    assert.equal(bodies[1]?.tools, undefined);
  }
});

test('tool fallback shares the three-request budget with transient retries', async () => {
  const bodies: Record<string, unknown>[] = [];
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) return Response.json({ error: { message: 'busy' } }, { status: 429, headers: { 'retry-after': '0' } });
    if (bodies.length === 2) return Response.json({ error: { message: 'tools are not supported' } }, { status: 422 });
    return Response.json({});
  }) as typeof fetch;
  await completeTurn({
    config: { kind: 'openai', baseUrl: 'https://gateway.example/v1', apiKey: 'key', model: 'fixture' },
    messages: [{ role: 'user', content: 'go' }], tools: true, request, env: { VLYN_OPENAI_API: 'chat' },
  });
  assert.equal(bodies.length, 3);
  assert.ok(Array.isArray(bodies[0]?.tools));
  assert.ok(Array.isArray(bodies[1]?.tools));
  assert.equal(bodies[2]?.tools, undefined);
});

test('an unrelated 400 does not trigger a tools fallback', async () => {
  let requests = 0;
  const request = (async () => {
    requests += 1;
    return Response.json({ error: { message: 'The requested model is unavailable; available tools are listed in its capabilities.' } }, { status: 400 });
  }) as typeof fetch;
  await assert.rejects(completeTurn({
    config: { kind: 'openai', baseUrl: 'https://gateway.example/v1', apiKey: 'key', model: 'fixture' },
    messages: [{ role: 'user', content: 'go' }], tools: true, request, env: { VLYN_OPENAI_API: 'chat' },
  }), /HTTP 400/u);
  assert.equal(requests, 1);
});

test('old tool output is truncated and compacted before the next call', () => {
  assert.ok(truncateToolResult({ content: 'x'.repeat(9000) }).includes('truncated'));
  const messages: AgentMessage[] = [
    { role: 'system', content: 'rules' },
    ...Array.from({ length: 8 }, (_, index) => ({ role: 'tool' as const, content: 'y'.repeat(2000), toolCallId: String(index) })),
  ];
  const compacted = compactHistory(messages, 1000);
  assert.ok(estimateTokens(compacted.slice(1, -6).map(message => message.content).join('')) < estimateTokens(messages.slice(1, -6).map(message => message.content).join('')));
  assert.equal(compacted[0]?.role, 'system');
  assert.ok(compacted.at(-1)?.content.includes('y'));
});

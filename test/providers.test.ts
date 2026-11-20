import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelCatalog, chooseModel, createProvider, extractJson, fetchModels, resolveConfig } from '../src/providers.ts';
import type { ProviderConfig } from '../src/providers.ts';
import { tempDir } from './helpers.ts';

type Call = { url: string; init: RequestInit; body?: Record<string, unknown> };
function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const request = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { url: String(url), init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, request };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const chat = (text: string) => json({ choices: [{ message: { content: text } }] });
const gateway: ProviderConfig = { kind: 'openai', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-secret', keyName: 'VLYN_API_KEY', model: 'auto' };

test('configuration follows the key and gateway the person already has', () => {
  assert.equal(resolveConfig({}), undefined);
  assert.deepEqual(resolveConfig({ OPENAI_API_KEY: 'k' }), { kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', keyName: 'OPENAI_API_KEY', model: 'auto' });
  const litellm = resolveConfig({ LITELLM_API_KEY: 'sk-l', VLYN_BASE_URL: 'https://gw.example.com/v1/', VLYN_MODEL: 'gpt-x' });
  assert.equal(litellm?.baseUrl, 'https://gw.example.com/v1');
  assert.equal(litellm?.model, 'gpt-x');
  assert.equal(resolveConfig({ ANTHROPIC_API_KEY: 'a' })?.kind, 'anthropic');
  assert.equal(resolveConfig({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' })?.kind, 'openai');
  assert.equal(resolveConfig({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', VLYN_PROVIDER: 'anthropic' })?.kind, 'anthropic');
  assert.equal(resolveConfig({ VLYN_BASE_URL: 'http://localhost:11434/v1' })?.apiKey, 'local', 'local servers need no key');
  assert.throws(() => resolveConfig({ VLYN_API_KEY: 'k', VLYN_BASE_URL: 'http://gw.internal/v1' }), /https/u);
  assert.ok(resolveConfig({ VLYN_API_KEY: 'k', VLYN_BASE_URL: 'http://gw.internal/v1', VLYN_ALLOW_INSECURE: '1' }));
});

test('the model list comes from the gateway with the key, skipping embeddings and image models', async () => {
  const { calls, request } = fakeFetch(() => json({ data: [{ id: 'gpt-5.1' }, { id: 'text-embedding-3' }, { id: 'claude-sonnet-5-5' }, { id: 'dall-e-3' }, { id: 'gpt-5.1' }] }));
  assert.deepEqual(await fetchModels(gateway, request), ['claude-sonnet-5-5', 'gpt-5.1']);
  const listed = calls[0];
  if (!listed) throw new Error('expected a models request');
  assert.equal(listed.url, 'https://llm.example.com/v1/models');
  assert.equal((listed.init.headers as Record<string, string>).Authorization, 'Bearer sk-secret');
  const anthropic = fakeFetch(() => json({ data: [{ id: 'claude-opus-5-5' }] }));
  await fetchModels({ ...gateway, kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, anthropic.request);
  const anthropicCall = anthropic.calls[0];
  if (!anthropicCall) throw new Error('expected an Anthropic models request');
  assert.equal((anthropicCall.init.headers as Record<string, string>)['x-api-key'], 'sk-secret');
  assert.equal(chooseModel(['gpt-4.1-mini', 'claude-sonnet-5-5', 'claude-opus-5-5']), 'claude-opus-5-5');
  assert.equal(chooseModel(['mystery-1']), 'mystery-1');
});

test('the catalog caches by key hash, refreshes when stale, keeps the last list on failure and reports changes', async context => {
  const home = await tempDir(context);
  let models = ['a-1', 'b-1'];
  let failing = false;
  const { calls, request } = fakeFetch(() => failing ? json({}, 503) : json({ data: models.map(id => ({ id })) }));
  const catalog = new ModelCatalog(gateway, home, { ttlMs: 60_000, request });
  assert.deepEqual(await catalog.models(), ['a-1', 'b-1']);
  await catalog.models();
  assert.equal(calls.length, 1, 'fresh cache is reused');
  models = ['b-1', 'c-1'];
  const change = await catalog.refresh();
  assert.deepEqual([change.added, change.removed], [['c-1'], ['a-1']]);
  const files = await readdir(join(home, 'models'));
  assert.equal(files.length, 1);
  const cacheName = files[0];
  if (!cacheName) throw new Error('expected a model cache file');
  assert.ok(!(await readFile(join(home, 'models', cacheName), 'utf8')).includes('sk-secret'), 'the key is never stored');
  const stale = new ModelCatalog(gateway, home, { ttlMs: 0, request });
  failing = true;
  assert.deepEqual(await stale.models(), ['b-1', 'c-1'], 'a failed refresh keeps the last known list');
});

test('watch refreshes continuously and announces new and retired models', async context => {
  const home = await tempDir(context);
  let models = ['m-1'];
  const { request } = fakeFetch(() => json({ data: models.map(id => ({ id })) }));
  const catalog = new ModelCatalog(gateway, home, { request });
  await catalog.refresh();
  const seen: { added: string[]; removed: string[] }[] = [];
  const stop = catalog.watch(15, change => seen.push(change));
  context.after(stop);
  models = ['m-2'];
  for (let waited = 0; !seen.length && waited < 3000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  stop();
  assert.deepEqual([seen[0]?.added, seen[0]?.removed], [['m-2'], ['m-1']]);
});

test('an OpenAI-compatible provider picks the live model, retries on a retired one and never leaks the key', async context => {
  const home = await tempDir(context);
  let live = ['gpt-5.1', 'gpt-5.2'];
  const { calls, request } = fakeFetch(call => {
    if (call.url.endsWith('/models')) return json({ data: live.map(id => ({ id })) });
    if (call.body?.model === 'gpt-5.2' && live.includes('gpt-5.2') === false) return json({ error: { message: 'model gpt-5.2 not found for sk-secret' } }, 404);
    return chat('```json\n{"action":"finish","summary":"ok"}\n```');
  });
  const catalog = new ModelCatalog(gateway, home, { request });
  const provider = createProvider(gateway, { catalog, request });
  assert.equal(await provider([{ role: 'user', content: 'go' }]), '{"action":"finish","summary":"ok"}');
  assert.equal(calls.find(call => call.url.endsWith('/chat/completions'))?.body?.model, 'gpt-5.2');
  assert.deepEqual(calls.find(call => call.url.endsWith('/chat/completions'))?.body?.response_format, { type: 'json_object' });
  live = ['gpt-5.1'];
  assert.equal(await provider([{ role: 'user', content: 'again' }]), '{"action":"finish","summary":"ok"}');
  const last = calls.filter(call => call.url.endsWith('/chat/completions')).at(-1);
  assert.equal(last?.body?.model, 'gpt-5.1', 'switched to a model that still exists');
  const pinned = createProvider({ ...gateway, model: 'retired' }, { request: fakeFetch(() => json({ error: { message: 'no such model retired, key sk-secret' } }, 404)).request });
  await assert.rejects(pinned([{ role: 'user', content: 'x' }]), error => error instanceof Error && /HTTP 404/u.test(error.message) && !error.message.includes('sk-secret'));
});

test('gateways that reject JSON mode are retried without it', async () => {
  const { calls, request } = fakeFetch(call => call.body?.response_format
    ? json({ error: { message: 'response_format is not supported' } }, 400) : chat('Sure: {"action":"list","path":"."} done'));
  const provider = createProvider({ ...gateway, model: 'local-model' }, { request });
  assert.equal(await provider([{ role: 'user', content: 'x' }]), '{"action":"list","path":"."}');
  await provider([{ role: 'user', content: 'y' }]);
  assert.equal(calls.length, 3, 'JSON mode stays off after the first rejection');
});

test('the Anthropic provider sends a system prompt and alternating roles', async () => {
  const { calls, request } = fakeFetch(() => json({ content: [{ type: 'text', text: '{"action":"graph"}' }] }));
  const config: ProviderConfig = { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'a-key', keyName: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' };
  const provider = createProvider(config, { request });
  assert.equal(await provider([
    { role: 'system', content: 'be brief' }, { role: 'user', content: 'task' }, { role: 'user', content: 'instructions' },
    { role: 'assistant', content: '{"action":"list"}' }, { role: 'user', content: 'result' },
  ]), '{"action":"graph"}');
  const sent = calls[0];
  if (!sent) throw new Error('expected an Anthropic message');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  const body = sent.body;
  if (!body || !Array.isArray(body.messages)) throw new Error('expected Anthropic messages');
  assert.equal(body.system, 'be brief');
  assert.deepEqual((body.messages as { role: string }[]).map(message => message.role), ['user', 'assistant', 'user']);
});

test('extractJson tolerates fences and prose but leaves valid JSON alone', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson('Here you go:\n```\n{"a":2}\n```'), '{"a":2}');
  assert.equal(extractJson('not json'), 'not json');
});

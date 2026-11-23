import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addProvider, loadConfig, listProviders, selectProvider, stripJsonc, substitute } from '../src/registry.ts';

test('comments and trailing commas are accepted', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{ // note\n "a": "x//y", /* c */ "b": [1,2,], }')), { a: 'x//y', b: [1, 2] });
});

test('{env:} and {file:} are substituted, unset becomes empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vlyn-reg-'));
  try {
    await writeFile(join(dir, 'key.txt'), 'from-file\n');
    assert.equal(substitute('a {env:K} b {file:key.txt} {env:NOPE}', { K: 'v' }, dir), 'a v b from-file ');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a custom provider is chosen as provider/model with its own key, URL and headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vlyn-reg-'));
  try {
    await writeFile(join(dir, 'vlyn.json'), `{ // project
      "model": "acme/qwen3-coder",
      "providers": { "acme": { "baseUrl": "https://llm.acme.example/v1", "apiKey": "{env:ACME_KEY}", "headers": { "X-Team": "ai" } } } }`);
    const config = loadConfig(join(dir, 'home'), dir, { ACME_KEY: 'sk-acme' });
    const chosen = selectProvider(config, { ACME_KEY: 'sk-acme' });
    assert.equal(chosen.kind, 'api');
    if (chosen.kind !== 'api') return;
    assert.equal(chosen.config.baseUrl, 'https://llm.acme.example/v1');
    assert.equal(chosen.config.apiKey, 'sk-acme');
    assert.equal(chosen.config.model, 'qwen3-coder');
    assert.deepEqual(chosen.config.headers, { 'X-Team': 'ai' });
    assert.equal(selectProvider(config, {}, { model: 'qwen3-coder' }).kind, 'none', 'no provider named and no key: nothing is guessed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('claude/ and codex/ use the logins with no config; a missing key says what to set', () => {
  const none = { providers: {} };
  assert.deepEqual(selectProvider(none, {}, { model: 'claude/opus' }), { kind: 'login', login: 'claude-cli', provider: 'claude', model: 'opus' });
  assert.equal(selectProvider(none, {}, { model: 'codex/gpt-6.2-sol' }).kind, 'login');
  assert.throws(() => selectProvider(none, {}, { model: 'anthropic/claude-opus-5-5' }), /needs a key.*ANTHROPIC_API_KEY/su);
  assert.throws(() => selectProvider(none, {}, { model: 'x/y', }) && selectProvider(none, { VLYN_PROVIDER: 'nope' }), /Unknown provider "nope"/u);
});

test('without any config the old environment variables still work', () => {
  const chosen = selectProvider({ providers: {} }, { OPENAI_API_KEY: 'k' });
  assert.equal(chosen.kind === 'api' && chosen.config.kind, 'openai');
  assert.equal(selectProvider({ providers: {} }, { VLYN_PROVIDER: 'claude-cli' }).kind, 'login');
});

test('openrouter-style model ids with slashes are kept whole', () => {
  const chosen = selectProvider({ providers: {} }, { OPENAI_API_KEY: 'k' }, { model: 'meta/llama-3-70b' });
  assert.equal(chosen.kind === 'api' && chosen.config.model, 'meta/llama-3-70b');
});

test('addProvider writes plain JSON, keeps other entries and never stores a key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vlyn-reg-'));
  try {
    const file = join(dir, 'vlyn.json');
    await addProvider(file, 'a', { type: 'openai', baseUrl: 'https://a.example/v1', apiKey: '{env:A_KEY}' });
    await addProvider(file, 'b', { type: 'anthropic' }, 'b/sonnet');
    const written = JSON.parse(await readFile(file, 'utf8')) as { model: string; providers: Record<string, unknown> };
    assert.deepEqual(Object.keys(written.providers), ['a', 'b']);
    assert.equal(written.model, 'b/sonnet');
    assert.match(await readFile(file, 'utf8'), /\{env:A_KEY\}/u);
    const rows = listProviders(loadConfig(join(dir, 'h'), dir, {}), {});
    assert.equal(rows.find(row => row.id === 'a')?.ready, false);
    assert.equal(rows.find(row => row.id === 'claude')?.ready, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

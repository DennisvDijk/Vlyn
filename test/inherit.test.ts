import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inheritCredentials, parseCodexToml } from '../src/inherit.ts';
import { selectProvider } from '../src/registry.ts';
import { createProvider } from '../src/providers.ts';

async function home(files: Record<string, string>): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'vlyn-inh-'));
  for (const [name, text] of Object.entries(files)) { await mkdir(join(dir, name, '..'), { recursive: true }); await writeFile(join(dir, name), text); }
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test('Claude Code gateway settings are inherited, base URL gets /v1, token is sent as Bearer', async () => {
  const h = await home({ '.claude/settings.json': '{ "env": { "ANTHROPIC_BASE_URL": "https://gw.example", "ANTHROPIC_AUTH_TOKEN": "tok" }, "model": "opus" }' });
  try {
    const found = inheritCredentials({ home: h.dir, cwd: join(h.dir, 'proj'), env: {} });
    assert.equal(found[0]?.baseUrl, 'https://gw.example/v1');
    assert.equal(found[0]?.bearer, true);
    assert.equal(found[0]?.model, undefined, 'an alias is not a model id');
    const chosen = selectProvider({ providers: {} }, {}, {}, found);
    assert.equal(chosen.kind, 'api');
    if (chosen.kind !== 'api') return;
    assert.equal(chosen.config.kind, 'anthropic');
    let seen: Record<string, string> = {};
    const request = (async (_url: unknown, init: RequestInit) => { seen = init.headers as Record<string, string>; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] })); }) as typeof fetch;
    await createProvider({ ...chosen.config, model: 'm' }, { request })([{ role: 'user', content: 'x' }]);
    assert.equal(seen.Authorization, 'Bearer tok');
    assert.equal(seen['x-api-key'], undefined);
    assert.equal(seen['anthropic-version'], '2023-06-01');
  } finally { await h.done(); }
});

test('project settings override user settings, and an apiKeyHelper supplies the key', async () => {
  const h = await home({
    '.claude/settings.json': '{ "env": { "ANTHROPIC_API_KEY": "user" } }',
    'proj/.claude/settings.local.json': '{ "env": { "ANTHROPIC_API_KEY": "project" } }',
  });
  try {
    assert.equal(inheritCredentials({ home: h.dir, cwd: join(h.dir, 'proj'), env: {} })[0]?.apiKey, 'project');
  } finally { await h.done(); }
  const g = await home({ '.claude/settings.json': '{ "apiKeyHelper": "print-key" }' });
  try {
    assert.equal(inheritCredentials({ home: g.dir, cwd: g.dir, env: {}, helper: command => command === 'print-key' ? 'from-helper\n' : '' })[0]?.apiKey, 'from-helper');
  } finally { await g.done(); }
});

test('Codex gateway provider and opencode keys are inherited; ChatGPT-login auth is ignored', async () => {
  const h = await home({
    '.codex/config.toml': 'model_provider = "gw"\nmodel = "m1"\n[model_providers.gw]\nbase_url = "https://gw.example/v1"\nenv_key = "GW_KEY"\n[projects."/x"]\ntrust_level = "trusted"\n',
    '.codex/auth.json': '{ "auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": { "access_token": "secret" } }',
    '.local/share/opencode/auth.json': '{ "anthropic": { "type": "api", "key": "oc-key" }, "x": { "type": "oauth" } }',
  });
  try {
    const found = inheritCredentials({ home: h.dir, cwd: h.dir, env: { GW_KEY: 'gk' } });
    assert.deepEqual(found.map(item => [item.kind, item.apiKey, item.baseUrl ?? null]), [['openai', 'gk', 'https://gw.example/v1'], ['anthropic', 'oc-key', null]]);
    assert.ok(!found.some(item => item.apiKey === 'secret'), 'ChatGPT login tokens are never used as API keys');
  } finally { await h.done(); }
});

test('explicit keys and config win over inherited ones', () => {
  const inherited = [{ kind: 'anthropic' as const, source: 's', apiKey: 'inh' }];
  const chosen = selectProvider({ providers: {} }, { ANTHROPIC_API_KEY: 'env' }, { model: 'anthropic/x' }, inherited);
  assert.equal(chosen.kind === 'api' && chosen.config.apiKey, 'env');
});

test('codex toml parser reads only what it needs', () => {
  const parsed = parseCodexToml('model="a"\nmodel_provider = "p"\n[model_providers."q r"]\nbase_url = "u"\n');
  assert.deepEqual([parsed.model, parsed.modelProvider, parsed.providers['q r']?.base_url], ['a', 'p', 'u']);
});

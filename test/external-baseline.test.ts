import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBaseline } from '../src/judge/baseline.ts';
import { posture } from '../src/sandbox.ts';
import { tempDir } from './helpers.ts';

test('an explicitly allowed external baseline runs without access to other files or the network', async context => {
  if (posture().network !== 'seatbelt') return context.skip('requires macOS Seatbelt');
  const cwd = await realpath(await tempDir(context, 'vlyn-base-repo-'));
  const verifier = await realpath(await tempDir(context, 'vlyn-base-tool-'));
  const outside = await realpath(await tempDir(context, 'vlyn-base-secret-'));
  const secret = join(outside, 'secret.txt');
  await writeFile(secret, 'secret');
  const script = join(verifier, 'verify.mjs');
  await writeFile(script, `import {readFileSync,writeFileSync} from 'node:fs'; import {connect} from 'node:net'; let blocked=false; try { readFileSync(${JSON.stringify(secret)}); } catch { blocked=true; } let writeBlocked=false; try { writeFileSync(${JSON.stringify(join(verifier, 'tamper'))}, 'x'); } catch { writeBlocked=true; } const code=await new Promise(resolve=>{const c=connect(12345,'127.0.0.1');c.on('connect',()=>{c.destroy();resolve('CONNECTED')});c.on('error',e=>resolve(e.code));}); console.log(JSON.stringify({verdict:blocked && writeBlocked && code==='EPERM'?'passed':'failed'}));`);
  const result = await runBaseline(`node ${script}`, cwd, true, verifier);
  assert.equal(result.p, 1, result.reason);
});

test('baseline installation directory cannot contain or be inside the worktree', async context => {
  const root = await realpath(await tempDir(context, 'vlyn-base-overlap-'));
  const nested = join(root, 'nested');
  await import('node:fs/promises').then(fs => fs.mkdir(nested));
  for (const dir of [root, nested]) {
    const result = await runBaseline('node -e "console.log(1)"', root, true, dir);
    assert.equal(result.p, undefined);
    assert.match(result.reason ?? '', /separate from the worktree/);
  }
});

test('judge records an external baseline prediction with an explicitly allowed directory', async context => {
  if (posture().network !== 'seatbelt') return context.skip('requires macOS Seatbelt');
  const { gitRepo } = await import('./helpers.ts');
  const { judge, createAdapter } = await import('../src/judge/index.ts');
  const root = await gitRepo(context, { 'src.txt': 'bad\n', 'check.mjs': 'process.exit(0);\n' });
  const dir = await realpath(await tempDir(context, 'vlyn-external-tool-'));
  const script = join(dir, 'verifier.mjs');
  await writeFile(script, 'console.log(JSON.stringify({ verdict: "passed" }));\n');
  const result = await judge({ root, agent: createAdapter('fake', { script: { edits: { 'src.txt': 'good\n' } } }), goal: 'edit', check: 'node check.mjs', baseline: `node ${script}`, baselineDir: dir, record: false, requireSandbox: true });
  assert.equal(result.verdict, 'completed');
  assert.equal(result.predictions?.baseline, 1);
});

test('the judge CLI passes the external verifier directory to the sandbox', async context => {
  if (posture().network !== 'seatbelt') return context.skip('requires macOS Seatbelt');
  const { spawnSync } = await import('node:child_process');
  const { gitRepo } = await import('./helpers.ts');
  const root = await gitRepo(context, { 'src.txt': 'bad\n', 'check.mjs': 'process.exit(0);\n' });
  const dir = await realpath(await tempDir(context, 'vlyn-cli-verifier-'));
  const script = join(dir, 'verifier.mjs');
  await writeFile(script, 'console.log(JSON.stringify({ verdict: "passed" }));\n');
  const fakeScript = join(dir, 'fake.json');
  await writeFile(fakeScript, JSON.stringify({ edits: { 'src.txt': 'good\n' }, summary: 'DONE' }));
  const home = await tempDir(context, 'vlyn-cli-home-');
  const result = spawnSync(process.execPath, [join(process.cwd(), 'src/cli.ts'), 'judge', root, '--agent', 'fake', '--goal', 'edit', '--check', 'node check.mjs', '--baseline', `node ${script}`, '--baseline-dir', dir, '--home', home, '--json'], { encoding: 'utf8', env: { ...process.env, VLYN_FAKE_SCRIPT: fakeScript } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).predictions.baseline, 1);
});

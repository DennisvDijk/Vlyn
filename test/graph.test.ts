import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { affectedTests, dependencies, dependents, findCycles, orphans, parseImports, resolveImport, scanProject, toDot, toMermaid } from '../src/graph.ts';
import { tempDir, writeFiles } from './helpers.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('parseImports finds static, multi-line, re-export, dynamic and require forms and skips comments', () => {
  const refs = parseImports([
    "import a from './a';",
    "import './side-effect.js';",
    'import {',
    '  b,',
    "} from './multi';",
    "export * from './star';",
    "export { c } from './named';",
    "const d = await import('./dynamic');",
    "const e = require('./cjs');",
    "// import x from './commented';",
    " * import y from './doc';",
    "import pkg from 'package';",
  ].join('\n'));
  assert.deepEqual(refs.map(ref => ref.specifier), ['./a', './side-effect.js', './multi', './star', './named', './dynamic', './cjs']);
  assert.equal(refs.find(ref => ref.specifier === './multi')?.line, 3);
});

test('resolveImport maps .js to .ts, directories to index files and refuses to leave the project', () => {
  const known = new Set(['src/a.ts', 'src/lib/index.ts', 'src/data.json']);
  assert.equal(resolveImport('src/main.ts', './a.js', known), 'src/a.ts');
  assert.equal(resolveImport('src/main.ts', './lib', known), 'src/lib/index.ts');
  assert.equal(resolveImport('src/main.ts', './data.json', known), 'src/data.json');
  assert.equal(resolveImport('src/main.ts', '../../x', known), undefined);
  assert.equal(resolveImport('src/main.ts', './missing', known), undefined);
});

async function sample(context: Parameters<typeof tempDir>[0]) {
  const root = await tempDir(context);
  await writeFiles(root, {
    'src/core.ts': 'export const core = 1;\n',
    'src/api.ts': "import { core } from './core.ts';\nexport const api = core;\n",
    'src/web.ts': "import { api } from './api.ts';\nimport './ghost.ts';\n",
    'src/loop-a.ts': "import './loop-b.ts';\n",
    'src/loop-b.ts': "import './loop-a.ts';\n",
    'src/unused.ts': 'export const unused = 1;\n',
    'test/api.test.ts': "import '../src/api.ts';\n",
    'node_modules/pkg/index.js': "import './nope.js';\n",
  });
  return root;
}

test('scanProject builds edges, reports unresolved imports and ignores node_modules and symlinks', async context => {
  const root = await sample(context);
  await symlink(tmpdir(), `${root}/escape`).catch(() => {});
  const graph = await scanProject(root);
  assert.ok(!graph.files.some(file => file.startsWith('node_modules')));
  assert.deepEqual(graph.unresolved.map(item => [item.from, item.specifier]), [['src/web.ts', './ghost.ts']]);
  assert.ok(graph.edges.some(edge => edge.from === 'src/api.ts' && edge.to === 'src/core.ts' && edge.line === 1));
});

test('dependents, dependencies, cycles, affected tests and orphans answer change-impact questions', async context => {
  const graph = await scanProject(await sample(context));
  assert.deepEqual(dependents(graph, 'src/core.ts').map(item => [item.file, item.distance]),
    [['src/api.ts', 1], ['test/api.test.ts', 2], ['src/web.ts', 2]].sort((a, b) => Number(a[1]) - Number(b[1]) || String(a[0]).localeCompare(String(b[0]))));
  assert.deepEqual(dependencies(graph, 'src/web.ts'), ['src/api.ts', 'src/core.ts']);
  assert.deepEqual(findCycles(graph), [['src/loop-a.ts', 'src/loop-b.ts', 'src/loop-a.ts']]);
  assert.deepEqual(affectedTests(graph, ['src/core.ts']), ['test/api.test.ts']);
  assert.deepEqual(orphans(graph), ['src/unused.ts', 'src/web.ts']);
});

test('mermaid and dot output describe the same edges', async context => {
  const graph = await scanProject(await sample(context));
  assert.match(toMermaid(graph), /graph LR[\s\S]*-->/u);
  assert.match(toDot(graph), /"src\/api.ts" -> "src\/core.ts";/u);
});

test('CLI graph, impact and doctor commands report results with meaningful exit codes', async context => {
  const root = await sample(context);
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const graph = run('graph', root, '--json');
  assert.equal(graph.status, 2, 'cycles produce a nonzero exit');
  assert.equal(JSON.parse(graph.stdout).summary.cycles, 1);
  const impact = run('impact', root, '--file', 'src/core.ts', '--json');
  assert.equal(impact.status, 0);
  assert.deepEqual(JSON.parse(impact.stdout).tests, ['test/api.test.ts']);
  assert.notEqual(run('impact', root, '--file', 'src/nothing.ts').status, 0);
  assert.equal(run('doctor', root, '--json').status, 0);
});

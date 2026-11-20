import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import {
  affectedTests, dependencies, dependents, findCycles, normalizeProjectPath, orphans, scanProject, toDot, toMermaid,
} from './graph.ts';
import type { ProjectGraph } from './graph.ts';
import { resolveConfig } from './providers.ts';
import { posture } from './sandbox.ts';

export type ToolOutput = { code: number; text: string; json: unknown };
export type GraphFormat = 'text' | 'json' | 'mermaid' | 'dot';

function summary(graph: ProjectGraph) {
  return {
    files: graph.files.length,
    imports: graph.edges.length,
    unresolved: graph.unresolved.length,
    skipped: graph.skipped.length,
    cycles: findCycles(graph).length,
  };
}

/** `vlyn graph`: the static import graph of a project, with cycles and unresolved imports called out. */
export async function graphTool(directory: string, format: GraphFormat): Promise<ToolOutput> {
  const root = await realpath(directory);
  const graph = await scanProject(root);
  const cycles = findCycles(graph);
  const json = { summary: summary(graph), cycles, unresolved: graph.unresolved, edges: graph.edges, orphans: orphans(graph) };
  if (format === 'mermaid') return { code: 0, json, text: toMermaid(graph) };
  if (format === 'dot') return { code: 0, json, text: toDot(graph) };
  const lines = [
    `${graph.files.length} files · ${graph.edges.length} imports · ${cycles.length} cycles · ${graph.unresolved.length} unresolved`,
    ...cycles.map(cycle => `  cycle: ${cycle.join(' → ')}`),
    ...graph.unresolved.slice(0, 20).map(item => `  unresolved: ${item.from}:${item.line} imports ${item.specifier}`),
  ];
  const likely = json.orphans.slice(0, 20);
  if (likely.length) lines.push('', 'Not imported by any file (entry points, scripts, or dead code):', ...likely.map(file => `  ${file}`));
  return { code: cycles.length ? 2 : 0, json, text: lines.join('\n') };
}

function changedFromGit(root: string, base: string): string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = git('rev-parse', '--show-prefix').trim();
  const names = new Set([
    ...git('diff', '--name-only', '--relative', `${base}...HEAD`).split('\n'),
    ...git('diff', '--name-only', '--relative', 'HEAD').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean));
  void prefix;
  return [...names].sort();
}

/**
 * `vlyn impact`: what a change touches. Give files explicitly, or `since` a Git revision to use the files
 * changed since then. Reports importers, their tests and the minimal list of tests worth running first.
 */
export async function impactTool(directory: string, files: string[], since?: string): Promise<ToolOutput> {
  const root = await realpath(directory);
  const graph = await scanProject(root);
  const known = new Set(graph.files);
  const requested = (since ? changedFromGit(root, since) : files.map(file => normalizeProjectPath(root, file)));
  if (!requested.length) throw new Error('Give at least one --file, or --since REVISION with changes');
  const missing = since ? [] : requested.filter(file => !known.has(file));
  if (missing.length) throw new Error(`Not a scanned project file: ${missing.join(', ')}`);
  const changed = requested.filter(file => known.has(file));
  const perFile = changed.map(file => ({ file, imports: dependencies(graph, file), importedBy: dependents(graph, file) }));
  const all = new Map<string, number>();
  for (const item of perFile) for (const dependent of item.importedBy) all.set(dependent.file, Math.min(all.get(dependent.file) ?? Infinity, dependent.distance));
  const tests = affectedTests(graph, changed);
  const json = {
    changed,
    ignored: requested.filter(file => !known.has(file)),
    affected: [...all].map(([file, distance]) => ({ file, distance })).sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file)),
    tests,
    note: 'Static relative imports only; dynamic loading, package imports and generated code are not visible.',
  };
  const lines = [`${changed.length} changed · ${json.affected.length} files import them · ${tests.length} tests affected`];
  for (const item of json.affected.slice(0, 40)) lines.push(`  ${'·'.repeat(item.distance)} ${item.file}`);
  if (tests.length) lines.push('', 'Run these tests first:', ...tests.map(test => `  ${test}`));
  return { code: 0, json, text: lines.join('\n') };
}

/** `vlyn doctor`: environment readiness for running the harness. */
export async function doctorTool(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<ToolOutput> {
  const checks: { name: string; ok: boolean; detail: string; required: boolean }[] = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push({ name: 'Node.js 24.12 or newer', ok: major > 24 || (major === 24 && minor >= 12), detail: process.versions.node, required: true });
  let gitVersion = '';
  try { gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* reported below */ }
  checks.push({ name: 'Git available', ok: Boolean(gitVersion), detail: gitVersion || 'git was not found on PATH', required: true });
  let inRepo = false;
  let clean = false;
  try {
    const root = await realpath(directory);
    inRepo = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
    clean = inRepo && execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
  } catch { /* not a repository */ }
  checks.push({ name: 'Project is a Git repository', ok: inRepo, detail: inRepo ? 'yes' : 'needed for batch worktrees', required: false });
  checks.push({ name: 'Working tree is clean', ok: clean, detail: clean ? 'yes' : 'batch requires a clean tree', required: false });
  let endpoint = 'no key found; set VLYN_API_KEY (and VLYN_BASE_URL for a gateway)';
  let configured = false;
  try {
    const config = resolveConfig(env);
    if (config) { configured = true; endpoint = `${config.kind} · ${config.baseUrl} · key from ${config.keyName} · model ${config.model}`; }
  } catch (error) { endpoint = error instanceof Error ? error.message : String(error); }
  checks.push({ name: 'Model endpoint configured', ok: configured, detail: endpoint, required: false });
  const box = posture();
  checks.push({
    name: 'Check sandbox',
    ok: box.isolates,
    detail: `${box.driver} · files ${box.filesystem} · network ${box.network} · landlock off · seccomp off`,
    required: false,
  });
  const failed = checks.some(check => check.required && !check.ok);
  const text = checks.map(check => `${check.ok ? 'ok  ' : check.required ? 'FAIL' : 'warn'} ${check.name} · ${check.detail}`).join('\n');
  return { code: failed ? 1 : 0, json: { checks, sandbox: box }, text };
}

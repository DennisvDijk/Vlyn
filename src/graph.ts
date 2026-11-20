import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

/** A relative import found in one source file. */
export type ImportRef = { specifier: string; line: number };
export type ProjectGraph = {
  /** Project files that were scanned, as POSIX-style relative paths. */
  files: string[];
  /** Resolved relative imports: `from` imports `to`. */
  edges: { from: string; to: string; line: number }[];
  /** Relative imports that did not resolve to a project file. */
  unresolved: { from: string; specifier: string; line: number }[];
  /** Files skipped because they were too large or not valid text. */
  skipped: string[];
};

export const sourcePattern = /\.[cm]?[jt]sx?$/u;
export const testPattern = /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
export const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo']);
const maxScanBytes = 500_000;
const maxFiles = 20_000;

const patterns = [
  /(?:^|[\s;])import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["'](\.[^"']*)["']/gu,
  /(?:^|[\s;])export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["'](\.[^"']*)["']/gu,
  /\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/gu,
  /\brequire\s*\(\s*["'](\.[^"']*)["']\s*\)/gu,
];

/** Find relative import specifiers: static, side-effect, multi-line, re-export, dynamic and require forms. */
export function parseImports(content: string): ImportRef[] {
  const lineStarts = [0];
  for (const match of content.matchAll(/\n/gu)) lineStarts.push(match.index + 1);
  const lineOf = (index: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      const startAt = lineStarts[mid];
      if (startAt !== undefined && startAt <= index) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
  const found = new Map<string, ImportRef>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const start = match.index + match[0].search(/\S/u);
      const line = lineOf(start);
      const text = content.slice(lineStarts[line - 1], start).trim();
      if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue;
      const specifier = match[1];
      if (specifier === undefined) continue;
      found.set(`${line}:${specifier}`, { specifier, line });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function candidates(base: string): string[] {
  const swapped = base.replace(/\.(?:js|jsx|mjs|cjs)$/u, match => ({ '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' })[match] ?? match);
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
  return [base, swapped, ...extensions.map(ext => base + ext), ...extensions.slice(0, 8).map(ext => `${base}/index${ext}`)];
}

/** Resolve a relative specifier from a source file against the set of known project files. */
export function resolveImport(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base.startsWith('..')) return undefined;
  return candidates(base.replace(/\/$/u, '')).find(candidate => known.has(candidate));
}

async function walk(root: string, directory: string, out: string[]): Promise<void> {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (out.length >= maxFiles) return;
    if (entry.isSymbolicLink()) continue;
    const path = directory ? join(directory, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await walk(root, path, out);
    } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/u.test(entry.name)) {
      out.push(path.split(sep).join('/'));
    }
  }
}

/** Scan a project directory and build its static relative-import graph. Symbolic links are never followed. */
export async function scanProject(root: string): Promise<ProjectGraph> {
  const paths: string[] = [];
  await walk(root, '', paths);
  paths.sort();
  const known = new Set(paths);
  const graph: ProjectGraph = { files: paths, edges: [], unresolved: [], skipped: [] };
  for (const path of paths) {
    if (!sourcePattern.test(path)) continue;
    const absolute = join(root, ...path.split('/'));
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.size > maxScanBytes) { graph.skipped.push(path); continue; }
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute)); } catch { graph.skipped.push(path); continue; }
    for (const ref of parseImports(content)) {
      const target = resolveImport(path, ref.specifier, known);
      if (target) graph.edges.push({ from: path, to: target, line: ref.line });
      else graph.unresolved.push({ from: path, specifier: ref.specifier, line: ref.line });
    }
  }
  return graph;
}

export function normalizeProjectPath(root: string, input: string): string {
  const absolute = input.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(input) ? relative(root, input) : input;
  return posix.normalize(absolute.split(sep).join('/')).replace(/^\.\//u, '');
}

/** Files that depend on `target`, directly or transitively, with their distance in import hops. */
export function dependents(graph: ProjectGraph, target: string): { file: string; distance: number; via: string }[] {
  const importers = new Map<string, string[]>();
  for (const edge of graph.edges) importers.set(edge.to, [...(importers.get(edge.to) ?? []), edge.from]);
  const seen = new Map<string, { distance: number; via: string }>();
  let frontier = [target];
  for (let distance = 1; frontier.length; distance += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const importer of importers.get(current) ?? []) {
        if (importer === target || seen.has(importer)) continue;
        seen.set(importer, { distance, via: current });
        next.push(importer);
      }
    }
    frontier = next;
  }
  return [...seen].map(([file, info]) => ({ file, ...info })).sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
}

/** Direct and transitive imports of `source`. */
export function dependencies(graph: ProjectGraph, source: string): string[] {
  const imported = new Map<string, string[]>();
  for (const edge of graph.edges) imported.set(edge.from, [...(imported.get(edge.from) ?? []), edge.to]);
  const seen = new Set<string>();
  const stack = [source];
  while (stack.length) {
    for (const next of imported.get(stack.pop() as string) ?? []) {
      if (next !== source && !seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return [...seen].sort();
}

/** Import cycles, each reported once as a path that returns to its first file. */
export function findCycles(graph: ProjectGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const cycles = new Map<string, string[]>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (file: string) => {
    state.set(file, 1);
    stack.push(file);
    for (const next of adjacency.get(file) ?? []) {
      if (state.get(next) === 1) {
        const loop = stack.slice(stack.indexOf(next));
        const first = [...loop].sort()[0];
        if (first === undefined) continue;
        const start = loop.indexOf(first);
        const rotated = [...loop.slice(start), ...loop.slice(0, start)];
        const head = rotated[0];
        if (head === undefined) continue;
        cycles.set(rotated.join('>'), [...rotated, head]);
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(file, 2);
  };
  for (const file of [...adjacency.keys()].sort()) if (!state.has(file)) visit(file);
  return [...cycles.values()].sort((a, b) => a.join().localeCompare(b.join()));
}

/** Test files that would be affected by a change to any of the given files. */
export function affectedTests(graph: ProjectGraph, changed: string[]): string[] {
  const affected = new Set<string>();
  for (const file of changed) {
    if (testPattern.test(file)) affected.add(file);
    for (const dependent of dependents(graph, file)) if (testPattern.test(dependent.file)) affected.add(dependent.file);
  }
  return [...affected].sort();
}

/** Files nothing imports that are not tests or obvious entry points. Heuristic: dynamic loading is invisible. */
export function orphans(graph: ProjectGraph): string[] {
  const imported = new Set(graph.edges.map(edge => edge.to));
  return graph.files.filter(file => sourcePattern.test(file) && !imported.has(file) && !testPattern.test(file) && !/(?:^|\/)(?:index|cli|main|server|app)\.[cm]?[jt]sx?$/u.test(file)).sort();
}

export function toMermaid(graph: ProjectGraph, focus?: Set<string>): string {
  const edges = graph.edges.filter(edge => !focus || (focus.has(edge.from) && focus.has(edge.to)));
  const id = (file: string) => `n${[...new Set(graph.files)].indexOf(file)}`;
  const names = new Set(edges.flatMap(edge => [edge.from, edge.to]));
  return ['graph LR', ...[...names].sort().map(file => `  ${id(file)}["${file.replace(/"/gu, "'")}"]`), ...edges.map(edge => `  ${id(edge.from)} --> ${id(edge.to)}`)].join('\n');
}

export function toDot(graph: ProjectGraph, focus?: Set<string>): string {
  const quote = (value: string) => JSON.stringify(value);
  const edges = graph.edges.filter(edge => !focus || (focus.has(edge.from) && focus.has(edge.to)));
  return ['digraph vlyn {', '  rankdir=LR;', ...edges.map(edge => `  ${quote(edge.from)} -> ${quote(edge.to)};`), '}'].join('\n');
}


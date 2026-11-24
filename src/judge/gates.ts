import { owns } from '../parallel.ts';
import type { SkipHit } from './types.ts';

const testDirs = ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'cypress'];
const ciPrefixes = ['.github/', '.circleci/', '.gitlab/', '.buildkite/'];
const ciFiles = ['.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml'];
const lockfiles = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
];
const testConfig =
  /^(?:jest|vitest|playwright|karma|cypress|babel)\.config\.\w+$|^\.mocharc(?:\.\w+)?$|^(?:pytest|tox)\.ini$|^conftest\.py$|^\.nycrc(?:\.\w+)?$/u;
const testFile = /(?:^|[./_-])(?:test|spec)s?(?:[./_-]|$)|^test_.*\.py$|_test\.(?:py|go)$/u;

function posix(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

/**
 * True when `path` belongs to the check surface: tests, test configuration, CI configuration or a lockfile.
 * `package.json` is handled separately, because only a change to its scripts counts.
 */
export function isDefaultProtected(path: string): boolean {
  const file = posix(path);
  const parts = file.split('/');
  const name = parts.at(-1) ?? '';
  if (parts.slice(0, -1).some((part) => testDirs.includes(part))) return true;
  if (ciPrefixes.some((prefix) => file.startsWith(prefix)) || ciFiles.includes(name)) return true;
  if (lockfiles.includes(name)) return true;
  if (testConfig.test(name)) return true;
  return testFile.test(name);
}

/** Paths from the default rule plus the extra `--protect` entries (exact file or folder prefix). */
export function protectedPaths(changed: string[], extra: string[], packageScriptsChanged: boolean): string[] {
  const extras = extra.map(posix).filter(Boolean);
  return changed.filter((file) => {
    const path = posix(file);
    if (path === 'package.json' || path.endsWith('/package.json')) {
      return packageScriptsChanged || extras.some((entry) => owns([entry], path));
    }
    return isDefaultProtected(path) || extras.some((entry) => owns([entry], path));
  });
}

/** True when the `scripts` object of a package.json differs between two texts. A parse failure counts as changed. */
export function scriptsDiffer(before: string | undefined, after: string | undefined): boolean {
  const read = (text: string | undefined): string => {
    if (text === undefined) return '';
    try {
      const value: unknown = JSON.parse(text);
      return JSON.stringify((value as { scripts?: unknown } | null)?.scripts ?? null);
    } catch {
      return `unparsable:${text}`;
    }
  };
  return read(before) !== read(after);
}

const skipPatterns: RegExp[] = [
  /\b(?:it|test|describe|suite)\.(?:skip|todo|fixme)\b/u,
  /\b(?:xit|xtest|xdescribe)\s*\(/u,
  /\b(?:skip|todo)\s*:\s*(?:true|['"`])/u,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/u,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/u,
  /\bpytest\.(?:skip|xfail)\s*\(/u,
  /\bself\.skipTest\s*\(/u,
  /\bt\.Skip(?:f|Now)?\s*\(/u,
];

export function hasSkipMarker(line: string): boolean {
  return skipPatterns.some((pattern) => pattern.test(line));
}

/** Added lines in a unified diff, per file. Binary patches and file headers are ignored. */
export function addedLines(diff: string): { file: string; line: string }[] {
  const found: { file: string; line: string }[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? '' : target.replace(/^b\//u, '');
    } else if (line.startsWith('+') && file) {
      found.push({ file, line: line.slice(1) });
    }
  }
  return found;
}

/** New skip markers in the diff and in untracked files (`untracked` maps path to file text). */
export function findSkipMarkers(diff: string, untracked: Record<string, string>): SkipHit[] {
  const hits: SkipHit[] = [];
  for (const { file, line } of addedLines(diff)) {
    if (hasSkipMarker(line)) hits.push({ file, line: line.trim().slice(0, 200) });
  }
  for (const [file, text] of Object.entries(untracked)) {
    for (const line of text.split('\n')) {
      if (hasSkipMarker(line)) hits.push({ file, line: line.trim().slice(0, 200) });
    }
  }
  return hits;
}

/** Test names the agent reports as clashing with the goal, from `CONFLICT: <test> - <reason>` lines. */
export function extractConflicts(summary: string): string[] {
  const found: string[] = [];
  for (const line of summary.split('\n')) {
    const match = line.match(/^[\s*`>_-]*CONFLICT\s*:\s*(\S.{2,})$/iu);
    if (match?.[1]) found.push(match[1].replace(/[*`]+$/u, '').trim());
  }
  return found;
}

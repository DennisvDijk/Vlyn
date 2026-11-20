import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export type JsonObject = Record<string, unknown>;
export type JsonKind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
export type Expectation = { path: string[]; type: JsonKind };
export type Source = { path: string; digest: string };
export type Consumer = { service: string; revision: string };
export type Check = Consumer & { id: string; source: Source; expects: Expectation[] };
export type Target = Consumer & { check: Check | null; issue?: string };
export type Observation = {
  id: string;
  environment: string;
  inventory: 'complete' | 'partial';
  deployment: Source;
  base: Source;
  candidate: Source;
  changes: { path: string[]; before?: JsonKind; after?: JsonKind }[];
  targets: Target[];
};
export type Workspace = { root: string; stream: string; observation: Observation; response: JsonObject };

const jsonKinds = new Set<unknown>(['string', 'number', 'boolean', 'object', 'array', 'null']);
export const checkVersion = 1;

export function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function kind(value: unknown): JsonKind | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === undefined) return undefined;
  return typeof value as JsonKind;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a nonempty string without control characters`);
  }
  return value;
}

async function within(root: string, name: string): Promise<string> {
  const path = await realpath(join(root, name));
  const route = relative(root, path);
  if (route === '..' || route.startsWith(`..${sep}`) || isAbsolute(route)) {
    throw new Error(`${name} resolves outside the workspace`);
  }
  return path;
}

async function load(root: string, name: string): Promise<{ data: JsonObject; source: Source }> {
  const bytes = await readFile(await within(root, name));
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${name} is invalid JSON`);
  }
  if (!isObject(data)) throw new Error(`${name} must contain a JSON object`);
  return { data, source: { path: name, digest: digest(bytes) } };
}

function consumer(data: unknown, label: string): Consumer {
  if (!isObject(data)) throw new Error(`${label} must be an object`);
  return { service: text(data.service, `${label}.service`), revision: text(data.revision, `${label}.revision`) };
}

function targetKey(target: Consumer): string {
  return JSON.stringify([target.service, target.revision]);
}

async function contracts(root: string): Promise<string[]> {
  try {
    const entries = await readdir(await within(root, 'contracts'), { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => `contracts/${entry.name}`).sort();
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function shapeChanges(base: JsonObject, candidate: JsonObject, prefix: string[] = []): Observation['changes'] {
  const changes: Observation['changes'] = [];
  const fields = new Set([...Object.keys(base), ...Object.keys(candidate)]);
  for (const field of [...fields].sort()) {
    const oldValue = Object.hasOwn(base, field) ? base[field] : undefined;
    const newValue = Object.hasOwn(candidate, field) ? candidate[field] : undefined;
    const path = [...prefix, field];
    const before = kind(oldValue);
    const after = kind(newValue);
    if (before !== after) changes.push({ path, before, after });
    if (isObject(oldValue) && isObject(newValue)) changes.push(...shapeChanges(oldValue, newValue, path));
  }
  return changes;
}

export async function readWorkspace(directory: string): Promise<Workspace> {
  const root = await realpath(directory);
  const [deployed, base, candidate, paths] = await Promise.all([
    load(root, 'deployment.json'),
    load(root, 'provider/base.json'),
    load(root, 'provider/candidate.json'),
    contracts(root),
  ]);
  const environment = text(deployed.data.environment, 'deployment.environment');
  const { inventory, consumers } = deployed.data;
  if (inventory !== 'complete' && inventory !== 'partial') throw new Error('deployment.inventory must be complete or partial');
  if (!Array.isArray(consumers)) throw new Error('deployment.consumers must be an array');

  const known = new Map<string, { source: Source; expects: Expectation[] }[]>();
  for (const path of paths) {
    const { data, source } = await load(root, path);
    const key = targetKey(consumer(data, path));
    if (!Array.isArray(data.expects) || data.expects.length === 0) throw new Error(`${path}.expects must be a nonempty array`);
    const expects = data.expects.map((rule: unknown): Expectation => {
      if (!isObject(rule) || !jsonKinds.has(rule.type) || !Array.isArray(rule.path) ||
          rule.path.length === 0 || rule.path.some(part => typeof part !== 'string')) {
        throw new Error(`${path} contains an invalid field expectation`);
      }
      return { path: rule.path, type: rule.type as JsonKind };
    });
    known.set(key, [...(known.get(key) ?? []), { source, expects }]);
  }

  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const entry of consumers) {
    const target = consumer(entry, 'deployment consumer');
    const key = targetKey(target);
    if (seen.has(key)) throw new Error(`Duplicate deployment consumer ${target.service} at ${target.revision}`);
    seen.add(key);
    const matches = known.get(key) ?? [];
    if (matches.length !== 1) {
      const issue = matches.length === 0 ? 'No contract for the deployed revision' : 'Multiple contracts for the deployed revision';
      targets.push({ ...target, check: null, issue });
      continue;
    }
    const contract = matches[0];
    const id = digest(JSON.stringify([checkVersion, environment, key, candidate.source.digest, contract.source.digest]));
    targets.push({ ...target, check: { ...target, id, ...contract } });
  }

  const changes = shapeChanges(base.data, candidate.data);
  const observation: Omit<Observation, 'id'> = {
    environment, inventory, deployment: deployed.source, base: base.source, candidate: candidate.source, changes, targets,
  };
  return {
    root,
    stream: digest(JSON.stringify([root, environment])),
    observation: { ...observation, id: digest(JSON.stringify(observation)) },
    response: candidate.data,
  };
}

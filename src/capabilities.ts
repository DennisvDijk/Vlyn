import { isAbsolute, relative, resolve, sep } from 'node:path';

/** What one coding task is allowed to do. Network for the child is none unless explicitly unrestricted. */
export type CapabilityManifest = {
  /** Absolute directories or files the check and the agent may read. */
  read: string[];
  /** Absolute files or directories the agent may create or replace. */
  write: string[];
  /** Exact check command strings. Anything else needs approval. */
  commands: string[];
  network: 'none' | 'unrestricted';
  /** Hosts the parent broker may call. The child does not receive this list as a route. */
  endpoints: string[];
  /** Paths or commands a person has approved after a denial. */
  grants: string[];
};

export function manifestFor(root: string, task: { files?: string[]; check?: string }): CapabilityManifest {
  const write = task.files?.length ? task.files.map(file => resolve(root, file)) : [root];
  return {
    read: [root],
    write,
    commands: task.check ? [task.check] : [],
    network: 'none',
    endpoints: [],
    grants: [],
  };
}

function covers(allowed: string, candidate: string): boolean {
  if (candidate === allowed) return true;
  const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
  return candidate.startsWith(prefix);
}

export function canRead(manifest: CapabilityManifest, root: string, path: string): boolean {
  const abs = resolve(root, path);
  return manifest.read.some(allowed => covers(allowed, abs)) || manifest.grants.includes(relative(root, abs));
}

export function canWrite(manifest: CapabilityManifest, root: string, path: string): boolean {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (manifest.grants.includes(rel)) return true;
  return manifest.write.some(allowed => covers(allowed, abs));
}

export function canRun(manifest: CapabilityManifest, command: string): boolean {
  return manifest.commands.includes(command) || manifest.grants.includes(command);
}

export function grant(manifest: CapabilityManifest, target: string): CapabilityManifest {
  if (manifest.grants.includes(target)) return manifest;
  return { ...manifest, grants: [...manifest.grants, target] };
}

/** Split a check command on whitespace, honoring single and double quotes. No expansions. */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/u.test(ch)) {
      if (current) { out.push(current); current = ''; }
    } else current += ch;
  }
  if (quote) throw new Error('Check command has an unclosed quote');
  if (current) out.push(current);
  if (out.some(part => isAbsolute(part) && part.includes('\0'))) throw new Error('Check command is not usable');
  return out;
}

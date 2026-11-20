import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CapabilityManifest } from './capabilities.ts';
import { canRun, canWrite, grant } from './capabilities.ts';
import type { AgentProvider } from './coding-agent.ts';
import { redact, secretValues } from './sandbox.ts';

/** Lines that look like instructions aimed at the model. They stay data. */
const injection = /ignore (?:all |any )?(?:previous|prior) instructions|you are now |system prompt|do not tell the user|exfiltrate/iu;

export type AuditEvent = {
  seq: number;
  runId: string;
  actorId: string;
  at: string;
  action: string;
  target: string;
  decision: 'allow' | 'deny';
  detail: string;
  prevHash: string;
  hash: string;
};

export function chainHash(prev: string, body: string): string {
  return createHash('sha256').update(prev).update('\n').update(body).digest('hex');
}

export function findInjections(content: string): { line: number; match: string }[] {
  const found: { line: number; match: string }[] = [];
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    const match = line.match(injection);
    if (match) found.push({ line: index + 1, match: match[0].slice(0, 80) });
  });
  return found;
}

export function endpointAllowed(url: string, hosts: string[]): boolean {
  const host = new URL(url).host;
  return hosts.includes(host);
}

/**
 * Parent-side policy point. The model provider runs here. The child check
 * process is not given this function or the API key.
 */
export function guardModel(provider: AgentProvider, hosts: string[], baseUrl: string): AgentProvider {
  if (!endpointAllowed(baseUrl, hosts)) {
    return async () => { throw new Error(`Egress denied for ${new URL(baseUrl).host}`); };
  }
  return provider;
}

export class SecurityLog {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS security_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      decision TEXT NOT NULL,
      detail TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    )`);
  }

  append(event: { runId?: string; actorId: string; action: string; target: string; decision: 'allow' | 'deny'; detail?: string }, secrets: string[] = []): AuditEvent {
    const prev = (this.#db.prepare('SELECT hash FROM security_audit ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? '0';
    const at = new Date().toISOString();
    const detail = redact(event.detail ?? '', secrets).slice(0, 500);
    const body = JSON.stringify({ runId: event.runId ?? '', actorId: event.actorId, at, action: event.action, target: event.target, decision: event.decision, detail });
    const hash = chainHash(prev, body);
    this.#db.prepare(`INSERT INTO security_audit (run_id, actor_id, at, action, target, decision, detail, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.runId ?? '', event.actorId, at, event.action, event.target, event.decision, detail, prev, hash);
    const row = this.#db.prepare('SELECT seq FROM security_audit WHERE hash = ?').get(hash) as { seq: number };
    return { seq: row.seq, runId: event.runId ?? '', actorId: event.actorId, at, action: event.action, target: event.target, decision: event.decision, detail, prevHash: prev, hash };
  }

  /** Seal an arbitrary snapshot. Tampering with the stored body breaks verify(). */
  seal(actorId: string, payload: unknown, secrets: string[] = []): AuditEvent {
    return this.append({ actorId, action: 'snapshot', target: actorId, decision: 'allow', detail: JSON.stringify(payload) }, secrets);
  }

  events(runId?: string): AuditEvent[] {
    const rows = (runId
      ? this.#db.prepare('SELECT * FROM security_audit WHERE run_id = ? ORDER BY seq').all(runId)
      : this.#db.prepare('SELECT * FROM security_audit ORDER BY seq').all()) as Record<string, unknown>[];
    return rows.map(row => ({
      seq: Number(row.seq), runId: String(row.run_id), actorId: String(row.actor_id), at: String(row.at),
      action: String(row.action), target: String(row.target), decision: row.decision === 'deny' ? 'deny' as const : 'allow' as const,
      detail: String(row.detail), prevHash: String(row.prev_hash), hash: String(row.hash),
    }));
  }

  verify(): { ok: boolean; brokenAt?: number } {
    let prev = '0';
    for (const event of this.events()) {
      const body = JSON.stringify({
        runId: event.runId, actorId: event.actorId, at: event.at, action: event.action,
        target: event.target, decision: event.decision, detail: event.detail,
      });
      const expected = chainHash(prev, body);
      if (event.prevHash !== prev || event.hash !== expected) return { ok: false, brokenAt: event.seq };
      prev = event.hash;
    }
    return { ok: true };
  }

  authorizeWrite(manifest: CapabilityManifest, root: string, path: string, actorId: string, secrets: string[] = []): void {
    if (canWrite(manifest, root, path)) {
      this.append({ actorId, action: 'write', target: path, decision: 'allow' }, secrets);
      return;
    }
    this.append({ actorId, action: 'write', target: path, decision: 'deny', detail: 'outside capability manifest' }, secrets);
    throw new Error(`Approval required to write ${path}`);
  }

  authorizeCommand(manifest: CapabilityManifest, command: string, actorId: string, secrets: string[] = []): void {
    if (canRun(manifest, command)) {
      this.append({ actorId, action: 'command', target: command, decision: 'allow' }, secrets);
      return;
    }
    this.append({ actorId, action: 'command', target: command, decision: 'deny', detail: 'outside capability manifest' }, secrets);
    throw new Error(`Approval required to run ${command}`);
  }
}

export function approveWrite(manifest: CapabilityManifest, path: string): CapabilityManifest {
  return grant(manifest, path);
}

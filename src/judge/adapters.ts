import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractConflicts } from './gates.ts';
import { JudgeRefusal } from './types.ts';
import type { AgentAdapter, AgentEvent, AgentRunInput, ModelUsage } from './types.ts';

export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
export type Exec = (
  file: string,
  args: string[],
  options: { cwd: string; input?: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
) => Promise<ExecResult>;

/** Run a child process, feed stdin, and kill it when the signal aborts. */
export const defaultExec: Exec = (file, args, options) =>
  new Promise((done) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const stop = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (options.signal.aborted) stop();
    else options.signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4_000);
    });
    child.once('error', (error) => done({ code: null, stdout, stderr: error.message }));
    child.once('close', (code) => {
      options.signal.removeEventListener('abort', stop);
      done({ code, stdout, stderr, ...(aborted ? { timedOut: true } : {}) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });

/** The task prompt every external agent gets. It never mentions a probability or a held-out test. */
export function taskPrompt(goal: string, check: string): string {
  return [
    goal,
    '',
    `Check your work with \`${check}\`. Do not modify tests or test configuration.`,
    'If a test contradicts the goal, follow the goal, leave the test unchanged, and say which test it is.',
    'When you are finished, end your reply with one of these as the last line:',
    'DONE',
    'CONFLICT: <exact name of the test that clashes with the goal> - <reason>',
    'BLOCKED: <reason>',
  ].join('\n');
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      /* not an event line */
    }
  }
  return out;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const obj = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export type Parsed = {
  events: AgentEvent[];
  summary: string;
  usage?: ModelUsage | undefined;
  error?: string | undefined;
};

/** Claude Code `claude -p --output-format stream-json --verbose`. */
export function parseClaude(stdout: string): Parsed {
  const events: AgentEvent[] = [];
  let summary = '';
  let usage: ModelUsage | undefined;
  let error: string | undefined;
  for (const event of lines(stdout)) {
    if (event.type === 'assistant') {
      const content = obj(event.message)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const part = obj(block);
        if (!part) continue;
        if (part.type === 'text' && str(part.text)) events.push({ type: 'text', text: str(part.text) as string });
        if (part.type === 'tool_use') {
          const input = obj(part.input) ?? {};
          const name = str(part.name) ?? '';
          if (name === 'Bash') events.push({ type: 'command', command: str(input.command) ?? '' });
          else {
            const path = str(input.file_path) ?? str(input.notebook_path);
            if (path) events.push({ type: 'edit', path });
          }
        }
      }
    } else if (event.type === 'result') {
      summary = str(event.result) ?? '';
      if (event.is_error === true) error = summary || 'agent reported an error';
      const tokens = obj(event.usage);
      usage = {
        costUsd: num(event.total_cost_usd),
        inputTokens: num(tokens?.input_tokens),
        outputTokens: num(tokens?.output_tokens),
      };
    }
  }
  return { events, summary, usage, error };
}

/** Codex `codex exec --json`. The final message also comes from the `-o` file, passed in `last`. */
export function parseCodex(stdout: string, last?: string): Parsed {
  const events: AgentEvent[] = [];
  let summary = '';
  let usage: ModelUsage | undefined;
  let error: string | undefined;
  for (const event of lines(stdout)) {
    if (event.type === 'item.completed') {
      const item = obj(event.item) ?? {};
      if (item.type === 'command_execution') {
        events.push({ type: 'command', command: str(item.command) ?? '', exitCode: num(item.exit_code) });
      } else if (item.type === 'file_change') {
        for (const change of Array.isArray(item.changes) ? item.changes : []) {
          const path = str(obj(change)?.path);
          if (path) events.push({ type: 'edit', path });
        }
      } else if (item.type === 'agent_message' && str(item.text)) {
        summary = str(item.text) as string;
        events.push({ type: 'text', text: summary });
      }
    } else if (event.type === 'turn.completed') {
      const tokens = obj(event.usage);
      usage = { inputTokens: num(tokens?.input_tokens), outputTokens: num(tokens?.output_tokens) };
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      error = str(obj(event.error)?.message) ?? str(event.message) ?? 'agent reported an error';
    }
  }
  if (last?.trim()) summary = last.trim();
  return { events, summary, usage, error };
}

/**
 * Pi `pi -p --mode json`. The event shape was not verified against a live run in this phase: the parser takes the text
 * of the last assistant message it can find and falls back to the end of stdout.
 */
export function parsePi(stdout: string): Parsed {
  const events: AgentEvent[] = [];
  let summary = '';
  for (const event of lines(stdout)) {
    const messages = Array.isArray(event.messages) ? event.messages : [event.message ?? event];
    if (messages.some((item) => {
      const message = obj(item);
      return message?.role === 'assistant' && message.stopReason === 'error';
    })) return { events, summary: '', error: 'model provider reported an error' };
    const message = obj(event.message) ?? event;
    if (message.role !== 'assistant') continue;
    const content = message.content;
    const text =
      typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content : []).map((block) => str(obj(block)?.text) ?? '').join('');
    if (text.trim()) {
      summary = text.trim();
      events.push({ type: 'text', text: summary });
    }
  }
  if (!summary) summary = stdout.trim().split('\n').slice(-20).join('\n');
  return { events, summary };
}

function finish(parsed: Parsed): AgentEvent {
  return {
    type: 'finish',
    summary: parsed.summary,
    conflicts: extractConflicts(parsed.summary),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  };
}

function subprocessAdapter(
  name: string,
  exec: Exec,
  build: (input: AgentRunInput, scratch: string) => { file: string; args: string[]; stdin?: string },
  parse: (stdout: string, last: string | undefined) => Parsed,
  usesLastFile = false,
  buildAsk?: (input: AgentRunInput, prompt: string, scratch: string) => { file: string; args: string[]; stdin?: string },
): AgentAdapter {
  return {
    name,
    ...(buildAsk
      ? {
          async ask(input, question, summary) {
            const scratch = join(tmpdir(), `vlyn-${name}-${randomUUID()}.ask`);
            const prompt = [
              `Opdracht: ${input.goal}`,
              '',
              'Jouw laatste bericht:',
              summary || '(leeg)',
              '',
              question,
              'Antwoord alleen met een getal tussen 0 en 1.',
            ].join('\n');
            const command = buildAsk(input, prompt, scratch);
            try {
              const result = await exec(command.file, command.args, {
                cwd: input.worktree,
                ...(command.stdin !== undefined ? { input: command.stdin } : {}),
                env: { ...process.env, ...input.env },
                signal: input.signal,
              });
              if (result.code !== 0) return undefined;
              const last = usesLastFile ? await readFile(scratch, 'utf8').catch(() => undefined) : undefined;
              return parse(result.stdout, last).summary;
            } catch {
              return undefined;
            } finally {
              if (usesLastFile) await rm(scratch, { force: true });
            }
          },
        }
      : {}),
    async *run(input) {
      const scratch = join(tmpdir(), `vlyn-${name}-${randomUUID()}.last`);
      const command = build(input, scratch);
      try {
        const result = await exec(command.file, command.args, {
          cwd: input.worktree,
          ...(command.stdin !== undefined ? { input: command.stdin } : {}),
          env: { ...process.env, ...input.env },
          signal: input.signal,
        });
        if (result.timedOut || input.signal.aborted) throw new Error('timeout');
        if (result.code !== 0)
          throw new Error(`${name} exited with ${result.code}: ${result.stderr.trim().slice(-300)}`);
        const last = usesLastFile ? await readFile(scratch, 'utf8').catch(() => undefined) : undefined;
        const parsed = parse(result.stdout, last);
        if (parsed.error) throw new Error(`${name}: ${parsed.error}`);
        for (const event of parsed.events) yield event;
        yield finish(parsed);
      } finally {
        if (usesLastFile) await rm(scratch, { force: true });
      }
    },
  };
}

export function claudeAdapter(exec: Exec = defaultExec): AgentAdapter {
  return subprocessAdapter(
    'claude',
    exec,
    (input) => ({
      file: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      stdin: taskPrompt(input.goal, input.check),
    }),
    (stdout) => parseClaude(stdout),
    false,
    (_input, prompt) => ({
      file: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      stdin: prompt,
    }),
  );
}

export function codexAdapter(exec: Exec = defaultExec): AgentAdapter {
  return subprocessAdapter(
    'codex',
    exec,
    (input, scratch) => ({
      file: 'codex',
      args: [
        'exec',
        '--json',
        '-s',
        'workspace-write',
        '--skip-git-repo-check',
        '-C',
        input.worktree,
        '-o',
        scratch,
        '-',
      ],
      stdin: taskPrompt(input.goal, input.check),
    }),
    (stdout, last) => parseCodex(stdout, last),
    true,
    (input, prompt, scratch) => ({
      file: 'codex',
      args: ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', input.worktree, '-o', scratch, '-'],
      stdin: prompt,
    }),
  );
}

export function piAdapter(exec: Exec = defaultExec): AgentAdapter {
  return subprocessAdapter(
    'pi',
    exec,
    (input) => ({ file: 'pi', args: ['-p', '--mode', 'json', taskPrompt(input.goal, input.check)] }),
    (stdout) => parsePi(stdout),
    false,
    (_input, prompt) => ({ file: 'pi', args: ['-p', '--mode', 'json', prompt] }),
  );
}

/** A script that drives the `fake` adapter. Used by tests and by `VLYN_FAKE_SCRIPT`. */
export type FakeScript = {
  /** Path to new text. `null` deletes the file. */
  edits?: Record<string, string | null>;
  commands?: string[];
  summary?: string;
  conflicts?: string[];
  selfConfidence?: number;
  crash?: string;
  /** Never finish. Waits for the abort signal. */
  hang?: boolean;
};

export function fakeAdapter(script: FakeScript = {}): AgentAdapter {
  return {
    name: 'fake',
    async ask() {
      return script.selfConfidence === undefined ? undefined : String(script.selfConfidence);
    },
    async *run(input) {
      for (const command of script.commands ?? []) yield { type: 'command', command };
      for (const [path, text] of Object.entries(script.edits ?? {})) {
        const target = join(input.worktree, path);
        if (text === null) await rm(target, { force: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, text);
        }
        yield { type: 'edit', path };
      }
      if (script.hang)
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      if (input.signal.aborted) throw new Error('timeout');
      if (script.crash) throw new Error(script.crash);
      const summary = script.summary ?? 'DONE';
      yield {
        type: 'finish',
        summary,
        conflicts: script.conflicts ?? extractConflicts(summary),
        ...(script.selfConfidence !== undefined ? { selfConfidence: script.selfConfidence } : {}),
      };
    },
  };
}

export function createAdapter(name: string, options: { exec?: Exec; script?: FakeScript } = {}): AgentAdapter {
  switch (name) {
    case 'claude':
      return claudeAdapter(options.exec);
    case 'codex':
      return codexAdapter(options.exec);
    case 'pi':
      return piAdapter(options.exec);
    case 'fake':
      return fakeAdapter(options.script);
    default:
      throw new JudgeRefusal(`Unknown agent "${name}". Use claude, codex, pi or fake.`);
  }
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { styleText } from 'node:util';
import type { AgentProvider } from './coding-agent.ts';
import { executeRun } from './durable.ts';
import type { Journal, RunRow, TaskRow, TaskStatus } from './durable.ts';
import { recall } from './memory.ts';
import { planTasks } from './planner.ts';
import type { CodingTask } from './parallel.ts';
import type { ModelCatalog } from './providers.ts';
import { doctorTool } from './tools.ts';

const icons: Record<TaskStatus, string> = { pending: '○', running: '◐', completed: '●', unverified: '?', failed: '✗' };
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');

export type TuiOptions = {
  input: Readable;
  output: Writable;
  journal: Journal;
  root: string;
  /** Model access. Absent when no API key is configured. */
  provider?: AgentProvider;
  workers?: number;
  defaultCheck?: string;
  /** Live model list; refreshed in the background while the session is open. */
  catalog?: ModelCatalog;
  refreshSeconds?: number;
};

/** Render a run as a compact status board. Pure, so it is easy to test. */
export function board(run: Pick<RunRow, 'id' | 'goal' | 'status'>, tasks: TaskRow[], color = false): string[] {
  const paint = (style: 'green' | 'red' | 'yellow' | 'dim' | 'bold', text: string) => color ? styleText(style, text) : text;
  const done = tasks.filter(task => !['pending', 'running'].includes(task.status)).length;
  const bar = `[${'█'.repeat(done)}${'░'.repeat(tasks.length - done)}]`;
  const lines = [paint('bold', `Vlyn · ${clean(run.goal)}`), `${run.id.slice(0, 8)} · ${run.status} · ${done}/${tasks.length} ${bar}`, ''];
  tasks.forEach((row, index) => {
    const style = row.status === 'completed' ? 'green' : row.status === 'failed' ? 'red' : row.status === 'pending' ? 'dim' : 'yellow';
    const files = row.result?.changedFiles.length ? ` · ${row.result.changedFiles.length} files` : '';
    lines.push(`${paint(style, icons[row.status])} ${index + 1}. ${clean(row.task.id)} ${paint('dim', `${row.status}${files}`)}`);
    lines.push(`     ${clean(row.task.task).slice(0, 100)}`);
  });
  return lines;
}

export async function runTui(options: TuiOptions): Promise<number> {
  const rl = createInterface({ input: options.input, output: options.output });
  const color = Boolean((options.output as Writable & { isTTY?: boolean }).isTTY);
  const print = (...lines: string[]) => options.output.write(`${lines.join('\n')}\n`);
  const ask = async (question: string): Promise<string | undefined> => {
    try { return (await rl.question(question)).trim(); } catch { return undefined; }
  };
  const stopWatching = options.catalog && (options.refreshSeconds ?? 0) > 0
    ? options.catalog.watch(Math.max(30, options.refreshSeconds as number) * 1000,
      change => print('', `Models updated: ${[...change.added.map(id => `+${id}`), ...change.removed.map(id => `−${id}`)].join(' ')}`))
    : undefined;

  async function execute(run: RunRow): Promise<void> {
    if (!options.provider) { print('A model is needed to run tasks. Set VLYN_API_KEY (and VLYN_BASE_URL for a gateway).'); return; }
    const provider = options.provider;
    const controller = new AbortController();
    const stop = () => { controller.abort(); print('', 'Stopping after the running tasks finish. Resume any time with: resume ' + run.id.slice(0, 8)); };
    process.once('SIGINT', stop);
    let drawn = 0;
    const draw = () => {
      const lines = board(run, options.journal.tasks(run.id), color);
      if (color && drawn) options.output.write(`\x1b[${drawn}A\x1b[J`);
      print(...lines);
      drawn = lines.length;
    };
    draw();
    try {
      await executeRun(options.journal, run.id, {
        provider: () => provider, signal: controller.signal,
        onEvent: event => { if (color) draw(); else print(`${event.message}`); },
      });
    } finally { process.removeListener('SIGINT', stop); }
    if (!color) print(...board(run, options.journal.tasks(run.id)));
    else draw();
  }

  async function review(run: RunRow): Promise<void> {
    for (;;) {
      const tasks = options.journal.tasks(run.id);
      const answer = await ask('\nreview> [diff N | files N | discard | back] ');
      if (answer === undefined || answer === 'back' || answer === 'b') return;
      const [command, number] = answer.split(/\s+/u);
      const row = tasks[Number(number) - 1];
      if (command === 'discard') { await options.journal.discard(run.id); print('Run discarded and worktrees removed.'); return; }
      if (!row?.result) { print('Choose a finished task number.'); continue; }
      if (command === 'diff') print(row.result.diff || '(no tracked changes)');
      else if (command === 'files') print(...(row.result.changedFiles.length ? row.result.changedFiles : ['(none)']), `worktree: ${row.worktree}`);
      else print('Commands: diff N, files N, discard, back');
    }
  }

  async function planFlow(): Promise<void> {
    if (!options.provider) { print('A model is needed to plan tasks. Set VLYN_API_KEY (and VLYN_BASE_URL for a gateway).'); return; }
    const goal = await ask('What should Vlyn do? ');
    if (!goal) return;
    const check = (await ask(`Verification command [${options.defaultCheck ?? 'none'}]: `)) || options.defaultCheck;
    print('Planning…');
    let plan = await planTasks({ root: options.root, goal, provider: options.provider, memory: recall(options.journal, options.root, goal), ...(check ? { check } : {}) });
    let tasks: CodingTask[] = plan.tasks;
    for (;;) {
      print('', `Plan for: ${clean(goal)}`, ...tasks.map((task, index) => `  ${index + 1}. ${clean(task.id)} — ${clean(task.task)}`), ...plan.warnings.map(warning => `  ! ${warning}`));
      const answer = await ask('plan> [go | edit N | drop N | add | replan | cancel] ');
      if (answer === undefined || answer === 'cancel') return;
      const [command, number] = answer.split(/\s+/u);
      const index = Number(number) - 1;
      if (command === 'go') break;
      if (command === 'replan') { plan = await planTasks({ root: options.root, goal, provider: options.provider, memory: recall(options.journal, options.root, goal), ...(check ? { check } : {}) }); tasks = plan.tasks; }
      else if (command === 'drop' && tasks[index]) tasks = tasks.filter((_, position) => position !== index);
      else if (command === 'edit' && tasks[index]) {
        const text = await ask('New instruction: ');
        if (text) tasks = tasks.map((task, position) => position === index ? { ...task, task: text } : task);
      } else if (command === 'add') {
        const text = await ask('Instruction: ');
        if (text) tasks = [...tasks, { id: `extra-${tasks.length + 1}`, task: text, ...(check ? { check } : {}) }];
      } else print('Commands: go, edit N, drop N, add, replan, cancel');
      if (!tasks.length) { print('No tasks left.'); return; }
    }
    const run = await options.journal.create({ root: options.root, goal, tasks, workers: options.workers ?? 3 });
    await execute(run);
    await review(run);
  }

  print(color ? styleText('bold', 'Vlyn — describe a goal, review the plan, let agents work in parallel.') : 'Vlyn — describe a goal, review the plan, let agents work in parallel.');
  try {
    for (;;) {
      const choice = await ask('\n[n]ew goal · [r]esume · [l]ist runs · [m]odels · [d]octor · [q]uit > ');
      if (choice === undefined || choice === 'q' || choice === 'quit') return 0;
      try {
        if (choice === 'n' || choice === 'new') await planFlow();
        else if (choice === 'l' || choice === 'list') {
          const runs = options.journal.runs();
          print(...(runs.length ? runs.map(run => `${run.id.slice(0, 8)}  ${run.status.padEnd(11)} ${clean(run.goal)}`) : ['No runs yet.']));
        } else if (choice.startsWith('r')) {
          const id = choice.split(/\s+/u)[1] ?? (await ask('Run id (blank for the latest unfinished): '));
          const run = id ? options.journal.run(id) : options.journal.runs().find(item => item.status !== 'finished');
          if (!run) print('No matching run.'); else { await execute(run); await review(run); }
        } else if (choice === 'm' || choice === 'models') {
          if (!options.catalog) print('No model endpoint is configured.');
          else {
            const change = await options.catalog.refresh();
            print(`${options.catalog.config.baseUrl} · ${change.models.length} chat models (+${change.added.length} −${change.removed.length})`, ...change.models.slice(0, 40).map(id => `  ${id}`));
          }
        } else if (choice === 'd' || choice === 'doctor') print((await doctorTool(options.root)).text);
        else print('Choose n, r, l, m, d or q.');
      } catch (error) { print(`Error: ${clean(error instanceof Error ? error.message : String(error))}`); }
    }
  } finally { stopWatching?.(); rl.close(); }
}

export async function guessCheck(root: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return manifest.scripts?.test ? 'npm test' : undefined;
  } catch { return undefined; }
}

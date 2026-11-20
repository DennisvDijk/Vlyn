#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { planOrder } from './model.ts';
import { ModelCatalog, createProvider, describeSetup, resolveConfig } from './providers.ts';
import { runChecks } from './scheduler.ts';
import { Store } from './state.ts';
import type { Report } from './state.ts';
import { readWorkspace } from './workspace.ts';
import type { Check } from './workspace.ts';
import { runCodingAgent } from './coding-agent.ts';
import { readTasks, runParallel } from './parallel.ts';
import { Journal, defaultHome, executeRun } from './durable.ts';
import { recall } from './memory.ts';
import { planTasks } from './planner.ts';
import { guessCheck, runTui, board } from './tui.ts';
import { doctorTool, graphTool, impactTool } from './tools.ts';
import type { GraphFormat } from './tools.ts';

const usage = `Usage: vlyn <tui|auto|resume|runs|models|code|batch|graph|impact|doctor|plan|run|status> [directory|run-id] [options]

  tui          Interactive session: state a goal, review the generated plan, watch agents work
  auto         Plan tasks from a goal (--goal TEXT) and run them durably in parallel; no task file needed
  resume       Continue an interrupted run by id (survives crashes, closed terminals and reboots)
  runs         List durable runs
  models       List the models your key can use; refreshed from the endpoint
  code         Work on a coding task in a project
  batch        Run independent coding tasks in isolated Git worktrees
  graph        Static import graph of a project: cycles, unresolved imports, mermaid or dot output
  impact       Files and tests affected by a change (--file PATH, repeatable, or --since REV)
  doctor       Check Node, Git and API key readiness
  plan         Discover deployed consumer versions and record the current inputs
  run          Check ready consumer versions in parallel
  status       Read the last observed snapshot and its evidence

  --db PATH    SQLite file (default: .rehearsal.sqlite in the workspace)
  --workers N  Concurrent checks (default: 3)
  --model NAME Model id, or auto (default) to choose from the endpoint's live model list
  --base-url U OpenAI-compatible endpoint, e.g. a LiteLLM gateway (or VLYN_BASE_URL)
  --refresh    With models: fetch the model list now
  --goal TEXT  Plain-language goal for auto; tasks are generated for you
  --plan-only  With auto: print the generated tasks and stop
  --home PATH  Journal folder (default: ~/.vlyn or VLYN_HOME)
  --task TEXT  Coding task for code
  --check CMD  Verification command for code
  --tasks PATH JSON task file for batch
  --format F   graph output: text, json, mermaid or dot
  --file PATH  Changed file for impact (repeatable)
  --since REV  Use files changed since a Git revision for impact
  --json       Emit the report as JSON
  --help       Show usage

run exits 0 for a compatible snapshot, 2 for a failed check and 3 for incomplete coverage.
Exit 1 indicates a command or input error.`;

function display(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
}

function reportText(report: Report): string {
  const heading = `Contract rehearsal · ${display(report.environment)}`;
  const lines = [process.stdout.isTTY ? styleText('bold', heading) : heading];
  lines.push(`${report.status.toUpperCase()} · ${report.checks.length} deployed consumer versions · ${report.inventory} inventory`);
  for (const change of report.changes) {
    lines.push(`  ${JSON.stringify(change.path)}  ${change.before ?? 'absent'} → ${change.after ?? 'absent'}`);
  }
  if (report.changes.length === 0) lines.push('  No JSON field shape changes detected');
  for (const row of report.checks) {
    const label = row.status.toUpperCase().padEnd(7);
    lines.push('', `${label} ${display(row.service)} @ ${display(row.revision)}`);
    for (const detail of row.details) lines.push(`        ${display(detail)}`);
    if (row.contract) lines.push(`        ${display(row.contract.path)}`);
    if ((row.status === 'stale' || row.status === 'unknown') && row.previous) {
      lines.push(`        Earlier ${row.previous.result.status} check used ${display(row.previous.attempt.check.revision)} with a different input fingerprint`);
    }
  }
  lines.push('', `Candidate ${display(report.candidate.path)} · ${report.candidate.digest}`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string' }, workers: { type: 'string' }, model: { type: 'string' },
      task: { type: 'string' }, check: { type: 'string' },
      tasks: { type: 'string' }, goal: { type: 'string' }, 'base-url': { type: 'string' }, refresh: { type: 'boolean' }, home: { type: 'string' }, 'plan-only': { type: 'boolean' }, format: { type: 'string' }, file: { type: 'string', multiple: true }, since: { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || (!positionals.length && !process.stdin.isTTY)) {
    console.log(usage);
    return 0;
  }
  const config = resolveConfig(process.env, { model: values.model, baseUrl: values['base-url'] });
  const catalog = config ? new ModelCatalog(config, values.home ?? defaultHome()) : undefined;
  const provider = config ? createProvider(config, { catalog }) : undefined;
  const needModel = (what: string) => { if (!provider) throw new Error(`${what} needs a model. ${describeSetup()}`); return provider; };
  if (positionals[0] === 'models') {
    if (!config || !catalog) throw new Error(`models needs an endpoint and key. ${describeSetup()}`);
    const change = values.refresh || !(await catalog.models().catch(() => undefined)) ? await catalog.refresh() : undefined;
    const models = change?.models ?? await catalog.models();
    if (values.json) console.log(JSON.stringify({ endpoint: config.baseUrl, kind: config.kind, models, selected: config.model }, null, 2));
    else {
      console.log(`${config.kind} · ${config.baseUrl} · ${models.length} chat models${change ? ` (refreshed: +${change.added.length} −${change.removed.length})` : ''}`);
      console.log(models.map(id => `  ${id}`).join('\n'));
      console.log(`Using: ${config.model === 'auto' ? 'auto (chosen from this list)' : config.model}`);
    }
    return 0;
  }
  if (!positionals.length || positionals[0] === 'tui') {
    const root = await realpath(positionals[1] ?? '.');
    const journal = new Journal(values.home);
    try {
      return await runTui({ input: process.stdin, output: process.stdout, journal, root, provider, workers: Number(values.workers ?? '3'), catalog, refreshSeconds: Number(process.env.VLYN_MODEL_REFRESH_SECONDS ?? '600'), defaultCheck: values.check ?? await guessCheck(root) });
    } finally { journal.close(); }
  }
  if (positionals[0] === 'runs' || positionals[0] === 'resume' || positionals[0] === 'auto') {
    const journal = new Journal(values.home);
    try {
      if (positionals[0] === 'runs') {
        const runs = journal.runs();
        console.log(values.json ? JSON.stringify(runs, null, 2) : runs.length ? runs.map(run => `${run.id.slice(0, 8)}  ${run.status.padEnd(11)} ${display(run.goal)}`).join('\n') : 'No runs yet.');
        return 0;
      }
      let runId: string;
      if (positionals[0] === 'resume') {
        const found = positionals[1] ? journal.run(positionals[1]) : journal.runs().find(item => item.status !== 'finished');
        if (!found) throw new Error('No matching unfinished run. Use runs to list them.');
        runId = found.id;
      } else {
        if (!values.goal?.trim()) throw new Error('auto requires --goal');
        needModel('auto');
        const root = await realpath(positionals[1] ?? '.');
        const plan = await planTasks({ root, goal: values.goal, provider: needModel('auto'), check: values.check, memory: recall(journal, root, values.goal) });
        if (values['plan-only']) {
          console.log(values.json ? JSON.stringify(plan, null, 2) : [...plan.tasks.map(task => `${task.id}: ${display(task.task)}`), ...plan.warnings.map(warning => `! ${warning}`)].join('\n'));
          return 0;
        }
        const workers = Number(values.workers ?? '3');
        runId = (await journal.create({ root, goal: values.goal, tasks: plan.tasks, workers })).id;
        if (!values.json) console.error(`Run ${runId.slice(0, 8)} planned with ${plan.tasks.length} tasks. Resume with: vlyn resume ${runId.slice(0, 8)}`);
      }
      const runner = needModel('Running tasks');
      const controller = new AbortController();
      process.once('SIGINT', () => { controller.abort(); console.error('Finishing running tasks, then stopping. Resume later with: vlyn resume ' + runId.slice(0, 8)); });
      const { run, tasks } = await executeRun(journal, runId, { provider: () => runner, signal: controller.signal, onEvent: values.json ? undefined : event => console.error(display(event.message)) });
      console.log(values.json ? JSON.stringify({ run, tasks }, null, 2) : board(run, tasks).join('\n'));
      return run.status === 'finished' && tasks.every(task => task.status === 'completed') ? 0 : 1;
    } finally { journal.close(); }
  }
  const [command, directory = '.'] = positionals;
  if (command === 'graph' || command === 'impact' || command === 'doctor') {
    if (positionals.length > 2) throw new Error(`${command} takes one directory`);
    const format = (values.json ? 'json' : values.format ?? 'text') as GraphFormat;
    if (!['text', 'json', 'mermaid', 'dot'].includes(format)) throw new Error('--format must be text, json, mermaid or dot');
    const output = command === 'graph' ? await graphTool(directory, format)
      : command === 'impact' ? await impactTool(directory, values.file ?? [], values.since)
      : await doctorTool(directory);
    console.log(format === 'json' ? JSON.stringify(output.json, null, 2) : output.text);
    return output.code;
  }
  if (command === 'batch') {
    if (positionals.length > 2 || !values.tasks) throw new Error('batch requires --tasks');
    const batchModel = needModel('batch');
    if (values.db || values.task || values.check) throw new Error('Use a task file to specify tasks and checks');
    const workers = Number(values.workers ?? '3');
    const tasks = await readTasks(resolve(values.tasks));
    const report = await runParallel({
      root: directory, tasks, workers, provider: () => batchModel,
      onProgress: values.json ? undefined : message => console.error(display(message)),
    });
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Run ${report.id} at ${display(report.directory)} (base ${report.base})`);
      for (const task of report.tasks) console.log(`${task.status.toUpperCase()} ${display(task.task.id)} · ${display(task.worktree)}`);
    }
    return report.tasks.every(task => task.status === 'completed') ? 0 : 1;
  }
  if (command === 'code') {
    if (positionals.length > 2 || !values.task?.trim()) throw new Error('code requires --task');
    const codeModel = needModel('code');
    if (values.db || values.workers || values.tasks) throw new Error('--db, --workers and --tasks do not apply to code');
    const result = await runCodingAgent({
      root: directory,
      task: values.task,
      provider: codeModel,
      check: values.check,
      onAction: values.json ? undefined : message => console.error(display(message)),
    });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(display(result.summary));
      console.log(`Changed files: ${result.files.length ? result.files.map(display).join(', ') : 'none'}`);
      for (const check of result.checks) console.log(`Check ${display(check.command)}: ${check.stale ? 'stale' : check.exitCode === 0 ? 'passed' : `failed (${check.exitCode ?? 'interrupted'})`}`);
    }
    const lastCheck = result.checks.at(-1);
    const verified = !values.check || (lastCheck && !lastCheck.stale && lastCheck.exitCode === 0);
    return result.completed && verified ? 0 : 1;
  }
  if (values.task !== undefined || values.check !== undefined || values.tasks !== undefined) throw new Error('Coding task options require code or batch');
  if (!['plan', 'run', 'status'].includes(command) || positionals.length > 2) throw new Error('Use plan, run, or status with one workspace');
  if (command !== 'run' && (values.model !== undefined || values.workers !== undefined)) throw new Error('--model and --workers apply to run');
  const workers = Number(values.workers ?? '3');
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) throw new Error('--workers must be an integer from 1 to 16');
  const root = await realpath(directory);
  const dbPath = values.db ? resolve(values.db) : join(root, '.rehearsal.sqlite');
  if (command === 'status' && !existsSync(dbPath)) throw new Error('No stored snapshot. Run plan or run first.');
  const store = new Store(dbPath);
  try {
    let stream: string;
    if (command === 'status') {
      const latest = store.latestStream(root);
      if (!latest) throw new Error('No stored snapshot for this workspace');
      stream = latest;
    } else {
      let workspace = await readWorkspace(root);
      store.observe(workspace);
      if (command === 'run') {
        if (values.model !== undefined) needModel('Model planning');
        for (let pass = 0; pass < 3; pass += 1) {
          let checks = workspace.observation.targets.flatMap(target => target.check ? [target.check] : []);
          if (pass === 0 && values.model && provider && checks.length > 1) {
            try {
              const plan = await planOrder(workspace.observation, checks, provider);
              store.recordPlan(workspace, values.model, plan.actions);
              checks = plan.checks;
            } catch {
              console.error('Model planning unavailable. Running checks in inventory order.');
            }
          }
          const progress: Parameters<typeof runChecks>[4] = values.json ? undefined : (phase, attempt, result) => {
            const check: Check = attempt.check;
            console.error(`${phase === 'started' ? 'Checking' : result?.status ?? 'Finished'} ${display(check.service)} @ ${display(check.revision)}`);
          };
          await runChecks(store, workspace, checks, workers, progress);
          const latest = await readWorkspace(root);
          store.observe(latest);
          if (latest.observation.id === workspace.observation.id) break;
          workspace = latest;
          if (pass === 2) console.error('Inputs continued to change. The report shows the last observed snapshot.');
        }
      }
      stream = workspace.stream;
    }
    const report = store.report(stream);
    if (!report) throw new Error('No compatibility report is available');
    console.log(values.json ? JSON.stringify(report, null, 2) : reportText(report));
    if (command !== 'run') return 0;
    if (report.status === 'incompatible') return 2;
    return report.status === 'compatible' ? 0 : 3;
  } finally {
    store.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(display(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { planOrder } from './model.ts';
import { autoLoginModel, cliKind, createCliProvider, loginModels } from './cli-provider.ts';
import { ModelCatalog, createProvider, describeSetup, resolveConfig } from './providers.ts';
import { runChecks } from './scheduler.ts';
import { Store } from './state.ts';
import type { Report } from './state.ts';
import { readWorkspace } from './workspace.ts';
import type { Check } from './workspace.ts';
import { runCodingAgent } from './coding-agent.ts';
import { readTasks, runParallel } from './parallel.ts';
import { ActorRuntime } from './actors.ts';
import { SecurityLog } from './broker.ts';
import { manifestFor } from './capabilities.ts';
import { Journal, applyToBranch, converge, defaultHome, executeRun } from './durable.ts';
import { runEval } from './eval.ts';
import { LessonStore, applySuggestion, planningMemory, suggestion } from './lessons.ts';
import { planGate, preMortem } from './premortem.ts';
import { planTasks } from './planner.ts';
import { guessCheck, runTui, board } from './tui.ts';
import { doctorTool, graphTool, impactTool } from './tools.ts';
import type { GraphFormat } from './tools.ts';

const usage = `Usage: vlyn <tui|auto|resume|runs|actors|lessons|eval|converge|apply|audit|models|code|batch|graph|impact|doctor|plan|run|status> [directory|run-id] [options]

  tui          Interactive session: state a goal, review the generated plan, watch agents work
  auto         Plan tasks from a goal (--goal TEXT) and run them durably in parallel; no task file needed
  resume       Continue an interrupted run by id (survives crashes, closed terminals and reboots)
  runs         List durable runs
  actors       List journaled actors (planner, coder, reviewer, verifier, supervisor)
  lessons      Distill repeated failures into claims. --apply writes the marked section of AGENTS.md
  eval         Score a scripted local suite: pass rate, verdict honesty, Brier score. No network
  converge     Rebuild the integration worktree for a finished run and re-run its checks
  apply        Commit that integration onto a new branch (--branch NAME). Does not check out the branch
  audit        Show the capability audit for a run (actor, action, allow or deny)
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
  --proceed    With auto: edit even if the pre-mortem confidence is high
  --branch N   With apply: name of the new branch
  --home PATH  Journal folder (default: ~/.vlyn or VLYN_HOME)
  --task TEXT  Coding task for code
  --check CMD  Verification command for code
  --tasks PATH JSON task file for batch
  --format F   graph output: text, json, mermaid or dot
  --file PATH  Changed file for impact (repeatable)
  --since REV  Use files changed since a Git revision for impact
    --apply      With lessons: write the suggestion into AGENTS.md (off unless you pass this)
    --require-sandbox  Refuse checks when this OS cannot confine them
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
      tasks: { type: 'string' }, goal: { type: 'string' }, 'base-url': { type: 'string' }, refresh: { type: 'boolean' }, home: { type: 'string' }, 'plan-only': { type: 'boolean' }, proceed: { type: 'boolean' }, branch: { type: 'string' }, format: { type: 'string' }, file: { type: 'string', multiple: true }, since: { type: 'string' },
      json: { type: 'boolean' }, apply: { type: 'boolean' }, 'require-sandbox': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || (!positionals.length && !process.stdin.isTTY)) {
    console.log(usage);
    return 0;
  }
  const login = cliKind(process.env.VLYN_PROVIDER);
  const config = login ? undefined : resolveConfig(process.env, {
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values['base-url'] !== undefined ? { baseUrl: values['base-url'] } : {}),
  });
  const catalog = config ? new ModelCatalog(config, values.home ?? defaultHome()) : undefined;
  const loginModel = login ? createCliProvider(login, { auto: () => autoLoginModel(login, values.home ?? defaultHome()), ...(values.model !== undefined ? { model: values.model } : process.env.VLYN_MODEL ? { model: process.env.VLYN_MODEL } : {}) }) : undefined;
  const provider = loginModel ?? (config ? createProvider(config, catalog ? { catalog } : {}) : undefined);
  const coding = loginModel ?? (config ? createProvider(config, { ...(catalog ? { catalog } : {}), tools: true, stream: true }) : undefined);
  const needModel = (what: string) => { if (!provider) throw new Error(`${what} needs a model. ${describeSetup()}`); return provider; };
  if (positionals[0] === 'eval') {
    const report = await runEval();
    console.log(values.json ? JSON.stringify(report, null, 2) : [report.note, ...report.cases.map(item => `${item.passed && item.honest ? 'ok  ' : 'FAIL'} ${item.id}  ${item.status}  confidence ${item.confidence}`), `pass ${report.summary.passRate} · honesty ${report.summary.honestyRate} · brier ${report.summary.brier} · tokens ${report.summary.estimatedTokens}`].join('\n'));
    return report.summary.passRate === 1 && report.summary.honestyRate === 1 ? 0 : 1;
  }
  if (positionals[0] === 'actors') {
    const journal = new Journal(values.home);
    try {
      const runtime = new ActorRuntime(journal);
      const rows = runtime.list();
      console.log(values.json ? JSON.stringify(rows, null, 2) : rows.length ? rows.map(actor => `${actor.id}  ${actor.role.padEnd(10)} ${actor.state.padEnd(8)} v${actor.version}`).join('\n') : 'No actors yet.');
      return 0;
    } finally { journal.close(); }
  }
  if (positionals[0] === 'lessons') {
    const root = await realpath(positionals[1] ?? '.');
    const journal = new Journal(values.home);
    try {
      const lessons = new LessonStore(journal).consolidate(root);
      if (values.apply) await applySuggestion(root, lessons);
      console.log(suggestion(lessons));
      return 0;
    } finally { journal.close(); }
  }
  if (positionals[0] === 'converge' || positionals[0] === 'apply') {
    const journal = new Journal(values.home);
    try {
      const found = positionals[1] ? journal.run(positionals[1]) : journal.runs()[0];
      if (!found) throw new Error('No matching run.');
      if (positionals[0] === 'converge') {
        const result = await converge(journal, found.id);
        console.log(values.json ? JSON.stringify(result, null, 2) : `integration ${result.passed ? 'passed' : 'failed'} · ${result.applied.length} applied · ${result.conflicts.length} conflicts`);
        return result.passed ? 0 : 1;
      }
      if (!values.branch) throw new Error('apply requires --branch NAME');
      const applied = await applyToBranch(journal, found.id, values.branch);
      console.log(`${applied.branch} ${applied.commit.slice(0, 8)}`);
      return 0;
    } finally { journal.close(); }
  }
  if (positionals[0] === 'audit') {
    const journal = new Journal(values.home);
    try {
      const log = new SecurityLog(journal.db);
      const runId = positionals[1] ? journal.run(positionals[1])?.id : undefined;
      if (positionals[1] && !runId) throw new Error('No matching run.');
      const chain = log.verify();
      const events = log.events(runId);
      if (values.json) console.log(JSON.stringify({ ok: chain.ok, brokenAt: chain.brokenAt, events }, null, 2));
      else {
        console.log(chain.ok ? 'audit chain ok' : `audit chain broken at ${chain.brokenAt}`);
        console.log(events.length ? events.map(event => `${event.decision.padEnd(5)} ${event.actorId} ${event.action} ${event.target}`).join('\n') : 'No audit events.');
      }
      return chain.ok ? 0 : 2;
    } finally { journal.close(); }
  }
  if (positionals[0] === 'models' && login) {
    const found = await loginModels(login, values.home ?? defaultHome(), { force: values.refresh === true });
    const pinned = values.model ?? process.env.VLYN_MODEL;
    if (values.json) console.log(JSON.stringify({ provider: login, fetchedAt: found.fetchedAt, models: found.models, selected: pinned ?? 'auto' }, null, 2));
    else {
      console.log(`${login} · ${found.models.filter(model => model.available).length} models for this login${found.refreshed ? ' (refreshed)' : ''}`);
      console.log(found.models.map(model => `  ${model.available ? ' ' : '✗'} ${model.id}${model.label !== model.id ? ` → ${model.label}` : ''}${model.note ? ` (${model.note})` : ''}`).join('\n'));
      console.log(`Using: ${pinned ?? (login === 'codex-cli' ? 'auto (Codex\'s first recommended model)' : 'auto (your plan\'s default)')}`);
    }
    return 0;
  }
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
      const defaultCheck = values.check ?? await guessCheck(root);
      return await runTui({
        input: process.stdin, output: process.stdout, journal, root, workers: Number(values.workers ?? '3'),
        refreshSeconds: Number(process.env.VLYN_MODEL_REFRESH_SECONDS ?? '600'),
        ...(provider ? { provider } : {}),
        ...(coding ? { codingProvider: coding } : {}),
        ...(catalog ? { catalog } : {}),
        ...(defaultCheck ? { defaultCheck } : {}),
      });
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
        const plan = await planTasks({
          root, goal: values.goal, provider: needModel('auto'), memory: planningMemory(journal, root, values.goal),
          ...(values.check ? { check: values.check } : {}),
        });
        if (values['plan-only']) {
          console.log(values.json ? JSON.stringify(plan, null, 2) : [...plan.tasks.map(task => `${task.id}: ${display(task.task)}`), ...plan.warnings.map(warning => `! ${warning}`)].join('\n'));
          return 0;
        }
        const risks = await preMortem({ tasks: plan.tasks }, needModel('auto'));
        const gate = planGate(risks, { ...(values.proceed ? { proceed: true } : {}) });
        if (!gate.edit) {
          console.error(gate.reason);
          console.error('No files were edited. Pass --proceed to continue.');
          return 1;
        }
        const workers = Number(values.workers ?? '3');
        runId = (await journal.create({ root, goal: values.goal, tasks: plan.tasks, workers })).id;
        if (!values.json) console.error(`Run ${runId.slice(0, 8)} planned with ${plan.tasks.length} tasks. Resume with: vlyn resume ${runId.slice(0, 8)}`);
      }
      const runner = coding ?? needModel('Running tasks');
      const controller = new AbortController();
      process.once('SIGINT', () => { controller.abort(); console.error(`Finishing running tasks, then stopping. Resume later with: vlyn resume ${runId.slice(0, 8)}`); });
      const { run, tasks } = await executeRun(journal, runId, {
        provider: () => runner, signal: controller.signal,
        ...(values['require-sandbox'] ? { requireSandbox: true } : {}),
        ...(values.json ? {} : { onEvent: (event: { message: string }) => console.error(display(event.message)) }),
      });
      console.log(values.json ? JSON.stringify({ run, tasks }, null, 2) : board(run, tasks).join('\n'));
      return run.status === 'finished' && tasks.every(task => task.status === 'completed') ? 0 : 1;
    } finally { journal.close(); }
  }
  const command = positionals[0];
  if (!command) throw new Error('Use plan, run, or status with one workspace');
  const directory = positionals[1] ?? '.';
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
    const batchModel = coding ?? needModel('batch');
    if (values.db || values.task || values.check) throw new Error('Use a task file to specify tasks and checks');
    const workers = Number(values.workers ?? '3');
    const tasks = await readTasks(resolve(values.tasks));
    const report = await runParallel({
      root: directory, tasks, workers, provider: () => batchModel,
      ...(values.json ? {} : { onProgress: (message: string) => console.error(display(message)) }),
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
    const codeModel = coding ?? needModel('code');
    if (values.db || values.workers || values.tasks) throw new Error('--db, --workers and --tasks do not apply to code');
    const result = await runCodingAgent({
      root: directory,
      task: values.task,
      provider: codeModel,
      ...(values.check ? { check: values.check } : {}),
      manifest: manifestFor(directory, { ...(values.check ? { check: values.check } : {}) }),
      ...(values['require-sandbox'] ? { requireSandbox: true } : {}),
      ...(values.json ? {} : { onAction: (message: string) => console.error(display(message)) }),
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

import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { openAIPlanner, planOrder } from './model.ts';
import { runChecks } from './scheduler.ts';
import { Store } from './state.ts';
import type { Report } from './state.ts';
import { readWorkspace } from './workspace.ts';
import type { Check } from './workspace.ts';

const usage = `Usage: npm run rehearse -- <plan|run|status> [workspace] [options]

  plan         Discover deployed consumer versions and record the current inputs
  run          Check ready consumer versions in parallel
  status       Read the last observed snapshot and its evidence

  --db PATH    SQLite file (default: .rehearsal.sqlite in the workspace)
  --workers N  Concurrent checks (default: 3)
  --model NAME Optional OpenAI model for check ordering (uses OPENAI_API_KEY)
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
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !positionals.length) {
    console.log(usage);
    return 0;
  }
  const [command, directory = '.'] = positionals;
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
        const key = process.env.OPENAI_API_KEY;
        if (values.model !== undefined && (!values.model.trim() || !key)) {
          throw new Error('Provide a model name and an OPENAI_API_KEY to enable model planning');
        }
        for (let pass = 0; pass < 3; pass += 1) {
          let checks = workspace.observation.targets.flatMap(target => target.check ? [target.check] : []);
          if (pass === 0 && values.model && key && checks.length > 1) {
            try {
              const plan = await planOrder(workspace.observation, checks, openAIPlanner(values.model, key));
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

import { Worker } from 'node:worker_threads';
import type { Attempt, Result, Store } from './state.ts';
import type { Check, JsonObject, Workspace } from './workspace.ts';

type Execute = (check: Check, response: JsonObject) => Promise<Result>;
type Progress = (phase: 'started' | 'finished', attempt: Attempt, result?: Result) => void;

const checkTimeoutMs = 20_000;

function verify(check: Check, response: JsonObject): Promise<Result> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./check-worker.ts', import.meta.url), { workerData: { check, response } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Check exceeded its time limit'));
    }, checkTimeoutMs);
    worker.once('message', (result: Result) => {
      clearTimeout(timer);
      resolve(result);
    });
    worker.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Worker exited before returning a result (${code})`));
    });
  });
}

export async function runChecks(
  store: Store,
  workspace: Workspace,
  checks: Check[],
  workers: number,
  progress?: Progress,
  execute: Execute = verify,
): Promise<void> {
  const attempted = new Set<string>();
  async function work(): Promise<void> {
    for (;;) {
      const attempt = store.claim(workspace, checks, attempted);
      if (!attempt) return;
      attempted.add(attempt.check.id);
      progress?.('started', attempt);

      let result: Result;
      try {
        result = await execute(attempt.check, workspace.response);
      } catch (error) {
        result = { status: 'error', details: [error instanceof Error ? error.message : 'Check execution failed'] };
      }
      if (store.finish(workspace, attempt, result)) progress?.('finished', attempt, result);
    }
  }

  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(workers, checks.length) }, () => work()));
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure) throw failure.reason;
}

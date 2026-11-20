import { parentPort, workerData } from 'node:worker_threads';
import { kind } from './workspace.ts';
import type { Check, JsonObject } from './workspace.ts';

const { check, response } = workerData as { check: Check; response: JsonObject };
const failures: string[] = [];
for (const expectation of check.expects) {
  let value: unknown = response;
  for (const segment of expectation.path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, segment)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  const found = kind(value);
  if (found !== expectation.type) {
    failures.push(`${JSON.stringify(expectation.path)} expected ${expectation.type}, found ${found ?? 'missing'}`);
  }
}
parentPort?.postMessage(failures.length === 0
  ? { status: 'passed', details: [`${check.expects.length} field expectations satisfied`] }
  : { status: 'failed', details: failures });

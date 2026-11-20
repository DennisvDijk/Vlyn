/** Statuses Codex and Claude Code retry: rate limit, overload, and server errors. */
export function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 529 || (status >= 500 && status <= 599);
}

/**
 * Delay before the next attempt. `retry-after` is seconds. Otherwise exponential
 * backoff with a quarter of the base as jitter. Capped at 30 seconds.
 */
export function backoffMs(attempt: number, retryAfter: string | null, random: () => number = Math.random): number {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000));
  }
  const base = Math.min(8_000, 200 * 2 ** attempt);
  return Math.round(base + base * 0.25 * random());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Model stream aborted'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

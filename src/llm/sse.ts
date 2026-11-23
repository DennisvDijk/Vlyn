/** One server-sent event. `event` defaults to `message` when the stream omits the name. */
export type SseEvent = { event: string; data: string };

export type SseState = { buffer: string };

export function createSseState(): SseState {
  return { buffer: '' };
}

/** Pull complete SSE events out of a chunk. Incomplete trailing bytes stay in `state`. */
export function pushSse(state: SseState, chunk: string): SseEvent[] {
  state.buffer += chunk.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const events: SseEvent[] = [];
  for (;;) {
    const split = state.buffer.indexOf('\n\n');
    if (split < 0) break;
    const raw = state.buffer.slice(0, split);
    state.buffer = state.buffer.slice(split + 2);
    const event = parseBlock(raw);
    if (event.data) events.push(event);
  }
  return events;
}

function parseBlock(raw: string): SseEvent {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
  }
  return { event, data: data.join('\n') };
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createSseState();
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Model stream aborted');
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of pushSse(state, decoder.decode(value, { stream: true }))) yield event;
    }
    for (const event of pushSse(state, decoder.decode())) yield event;
    if (state.buffer.trim()) {
      const tail = parseBlock(state.buffer);
      if (tail.data) yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

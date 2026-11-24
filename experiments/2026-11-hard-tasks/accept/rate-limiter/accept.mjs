import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/index.js';
const clock = () => { let t = 0; return { now: () => t, set: (v) => { t = v; } }; };
test('fractional refill', () => {
  const c = clock(); const l = createLimiter({ capacity: 2, refillPerSecond: 1, now: c.now });
  assert.equal(l.tryTake(2), true);
  c.set(500); assert.equal(l.tryTake(1), false);
  c.set(1000); assert.equal(l.tryTake(1), true);
});
test('refill is capped at capacity', () => {
  const c = clock(); const l = createLimiter({ capacity: 2, refillPerSecond: 5, now: c.now });
  l.tryTake(2); c.set(60_000);
  assert.equal(l.tryTake(2), true); assert.equal(l.tryTake(1), false);
});
test('a refused take removes nothing', () => {
  const c = clock(); const l = createLimiter({ capacity: 3, refillPerSecond: 0, now: c.now });
  assert.equal(l.tryTake(2), true); assert.equal(l.tryTake(2), false); assert.equal(l.tryTake(1), true);
});
test('more than capacity is refused and consumes nothing', () => {
  const c = clock(); const l = createLimiter({ capacity: 3, refillPerSecond: 1, now: c.now });
  assert.equal(l.tryTake(4), false); assert.equal(l.tryTake(3), true);
});
test('a clock that goes backwards does not refill or throw', () => {
  const c = clock(); c.set(10_000); const l = createLimiter({ capacity: 2, refillPerSecond: 1, now: c.now });
  l.tryTake(2); c.set(5_000); assert.equal(l.tryTake(1), false);
  c.set(11_000); assert.equal(l.tryTake(1), true);
});
test('bad settings throw RangeError', () => {
  assert.throws(() => createLimiter({ capacity: 0, refillPerSecond: 1, now: () => 0 }), RangeError);
  assert.throws(() => createLimiter({ capacity: 1, refillPerSecond: -1, now: () => 0 }), RangeError);
});

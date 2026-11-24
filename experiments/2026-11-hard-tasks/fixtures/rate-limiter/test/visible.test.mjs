import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/index.js';
test('starts full', () => {
  const limiter = createLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 });
  assert.equal(limiter.tryTake(), true);
  assert.equal(limiter.tryTake(), true);
  assert.equal(limiter.tryTake(), false);
});

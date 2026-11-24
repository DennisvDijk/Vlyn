import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/index.js';
test('rounds the discounted amount down', () => { assert.equal(applyDiscount(995, 15), 845); });
test('whole numbers', () => { assert.equal(applyDiscount(1000, 10), 900); assert.equal(applyDiscount(100, 0), 100); assert.equal(applyDiscount(100, 100), 0); });
test('another fraction', () => { assert.equal(applyDiscount(999, 33), 669); });
test('percent outside 0..100 throws RangeError', () => {
  assert.throws(() => applyDiscount(100, -1), RangeError); assert.throws(() => applyDiscount(100, 101), RangeError);
});

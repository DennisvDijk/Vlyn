import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/index.js';
test('simple', () => { assert.equal(applyDiscount(1000, 10), 900); });
test('rounds to the nearest cent', () => { assert.equal(applyDiscount(995, 15), 846); });

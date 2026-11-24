import { deepMerge } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('nested', () => { assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: { c: 2 } }), { a: { b: 1, c: 2 } }); });

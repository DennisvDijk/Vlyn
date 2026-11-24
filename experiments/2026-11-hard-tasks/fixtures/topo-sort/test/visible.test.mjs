import test from 'node:test';
import assert from 'node:assert/strict';
import { topoSort } from '../src/index.js';
test('chain', () => { assert.deepEqual(topoSort([['a', 'b'], ['b', 'c']]), ['a', 'b', 'c']); });

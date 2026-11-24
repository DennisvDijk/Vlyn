import { LRU } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('evicts', () => { const c = new LRU(1); c.set('a', 1); c.set('b', 2); assert.equal(c.get('a'), undefined); assert.equal(c.get('b'), 2); });

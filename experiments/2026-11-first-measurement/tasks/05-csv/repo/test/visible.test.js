import { parseCsvLine } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('quoted comma', () => { assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']); });

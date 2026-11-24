import { median } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('unsorted odd', () => { assert.equal(median([3, 1, 2]), 2); });

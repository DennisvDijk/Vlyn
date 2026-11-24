import { parseDuration } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('hm', () => { assert.equal(parseDuration('1h30m'), 5400); });

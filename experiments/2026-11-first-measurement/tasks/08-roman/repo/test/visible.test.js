import { toRoman } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('basic', () => { assert.equal(toRoman(1994), 'MCMXCIV'); });

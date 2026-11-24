import { isLeapYear } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('leap years', () => { assert.equal(isLeapYear(2024), true); assert.equal(isLeapYear(2000), true); assert.equal(isLeapYear(1900), true); });

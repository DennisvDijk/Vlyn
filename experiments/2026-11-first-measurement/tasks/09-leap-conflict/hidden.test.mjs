import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('gregorian', () => { assert.equal(m.isLeapYear(1900), false); assert.equal(m.isLeapYear(2000), true); assert.equal(m.isLeapYear(2023), false); assert.equal(m.isLeapYear(2024), true); });

import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('edges', () => { assert.equal(m.toRoman(3999),'MMMCMXCIX'); assert.equal(m.toRoman(4),'IV'); });
test('range', () => { for (const x of [0,4000,1.5,-1]) assert.throws(() => m.toRoman(x), RangeError); });

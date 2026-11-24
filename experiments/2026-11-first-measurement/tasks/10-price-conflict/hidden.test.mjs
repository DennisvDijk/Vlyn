import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('dutch', () => { assert.equal(m.formatEuro(123456), '€ 1.234,56'); assert.equal(m.formatEuro(5), '€ 0,05'); });

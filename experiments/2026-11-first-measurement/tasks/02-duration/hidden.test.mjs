import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('variants', () => { assert.equal(m.parseDuration('90s'), 90); assert.equal(m.parseDuration('1h2m3s'), 3723); });
test('invalid', () => { for (const x of ['', '5x', '1m1h', 'h', '1h1h']) assert.throws(() => m.parseDuration(x), x); });

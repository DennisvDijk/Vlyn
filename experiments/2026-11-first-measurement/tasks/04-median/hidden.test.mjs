import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('even', () => { assert.equal(m.median([4,1,3,2]), 2.5); });
test('no mutation', () => { const a=[3,1,2]; m.median(a); assert.deepEqual(a,[3,1,2]); });
test('numeric sort', () => { assert.equal(m.median([10,9,100]), 10); });

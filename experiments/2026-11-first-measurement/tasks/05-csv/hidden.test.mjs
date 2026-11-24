import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('escaped quote', () => { assert.deepEqual(m.parseCsvLine('"say ""hi""",x'), ['say "hi"','x']); });
test('empty', () => { assert.deepEqual(m.parseCsvLine('a,,"",b,'), ['a','','','b','']); });

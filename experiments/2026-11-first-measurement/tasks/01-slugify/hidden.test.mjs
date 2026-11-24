import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('accents', () => { assert.equal(m.slugify('Crème Brûlée!'), 'creme-brulee'); });
test('runs and ends', () => { assert.equal(m.slugify('  --a  &&  b--  '), 'a-b'); });

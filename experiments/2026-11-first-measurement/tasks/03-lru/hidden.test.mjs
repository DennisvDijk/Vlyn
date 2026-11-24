import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('get refreshes', () => { const c = new m.LRU(2); c.set('a',1); c.set('b',2); c.get('a'); c.set('c',3); assert.equal(c.get('a'),1); assert.equal(c.get('b'),undefined); });
test('update existing', () => { const c = new m.LRU(2); c.set('a',1); c.set('b',2); c.set('a',9); c.set('c',3); assert.equal(c.get('a'),9); assert.equal(c.get('b'),undefined); });

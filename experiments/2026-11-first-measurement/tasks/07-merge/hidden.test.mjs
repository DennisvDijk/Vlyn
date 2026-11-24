import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('arrays replace', () => { assert.deepEqual(m.deepMerge({x:[1,2]},{x:[3]}), {x:[3]}); });
test('no mutation', () => { const t={a:{b:1}}, s={a:{c:2}}; m.deepMerge(t,s); assert.deepEqual(t,{a:{b:1}}); assert.deepEqual(s,{a:{c:2}}); });

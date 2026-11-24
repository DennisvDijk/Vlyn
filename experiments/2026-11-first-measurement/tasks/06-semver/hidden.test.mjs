import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.TARGET);
test('prerelease', () => { const o=['1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0']; for (let i=0;i<o.length-1;i++) assert.equal(m.compareSemver(o[i],o[i+1]),-1,o[i]); });
test('build', () => { assert.equal(m.compareSemver('1.0.0+a','1.0.0+b'),0); });

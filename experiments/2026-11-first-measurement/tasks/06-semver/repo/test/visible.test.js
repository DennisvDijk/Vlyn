import { compareSemver } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('core', () => { assert.equal(compareSemver('1.2.3', '1.10.0'), -1); });

import { slugify } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('basic', () => { assert.equal(slugify('Hello World'), 'hello-world'); });

import { formatEuro } from '../src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
test('format', () => { assert.equal(formatEuro(123456), '€1,234.56'); });

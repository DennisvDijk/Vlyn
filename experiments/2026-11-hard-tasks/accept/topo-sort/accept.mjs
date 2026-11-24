import test from 'node:test';
import assert from 'node:assert/strict';
import { topoSort } from '../src/index.js';
test('ties are taken in ascending order', () => {
  assert.deepEqual(topoSort([['b', 'd'], ['a', 'd'], ['c', 'd']]), ['a', 'b', 'c', 'd']);
});
test('a late small node does not jump the queue', () => {
  assert.deepEqual(topoSort([['c', 'a'], ['b', 'a']]), ['b', 'c', 'a']);
});
test('duplicate edges are fine', () => {
  assert.deepEqual(topoSort([['a', 'b'], ['a', 'b'], ['b', 'c']]), ['a', 'b', 'c']);
});
test('empty input', () => { assert.deepEqual(topoSort([]), []); });
test('a cycle names the cycle from its smallest node', () => {
  assert.throws(() => topoSort([['b', 'c'], ['c', 'a'], ['a', 'b']]), { message: 'cycle: a -> b -> c -> a' });
});
test('a self edge is a cycle', () => {
  assert.throws(() => topoSort([['x', 'x']]), { message: 'cycle: x -> x' });
});
test('the cycle with the smallest node is reported', () => {
  assert.throws(() => topoSort([['y', 'z'], ['z', 'y'], ['b', 'a'], ['a', 'b']]), { message: 'cycle: a -> b -> a' });
});

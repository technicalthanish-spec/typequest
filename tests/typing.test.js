import test from 'node:test';
import assert from 'node:assert/strict';
import { calcMetrics, matchesCharacter, isLinearEdit } from '../src/lib/typing.js';

test('beginner capitals receive the same highlighting and speed credit as lowercase', () => {
  assert.equal(matchesCharacter('a', 'A'), true);
  assert.deepEqual(calcMetrics('asdf', 'ASDF', 12), {correct:4, errors:0, wpm:4, accuracy:100});
});
test('advanced levels require exact case', () => {
  assert.equal(matchesCharacter('a', 'A', true), false);
  assert.deepEqual(calcMetrics('Asdf', 'asdf', 12, true), {correct:3, errors:1, wpm:3, accuracy:75});
});
test('backspacing a mistake does not erase it from live or final accuracy', () => {
  assert.deepEqual(calcMetrics('asdf', 'asdf', 12, false, {attempts:5, correct:4, errors:1}),
    {correct:4, errors:1, wpm:4, accuracy:80});
});
test('only appends and suffix deletions are accepted', () => {
  for (const [a,b] of [['as','asd'],['asd','as'],['asd',''],['as','as']]) assert.equal(isLinearEdit(a,b),true);
  for (const [a,b] of [['axd','asd'],['axdf','as'],['asd','ad'],['as','xasd']]) assert.equal(isLinearEdit(a,b),false);
});
test('empty and zero-time inputs never produce infinite metrics', () => {
  assert.deepEqual(calcMetrics('a','',0),{correct:0,errors:0,wpm:0,accuracy:0});
  assert.ok(Number.isFinite(calcMetrics('a','a',0).wpm));
});

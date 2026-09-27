import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoomCode, ROOM_CODE, recordKey, rankPlayers, raceClock } from '../src/lib/multiplayer.js';

test('room codes tolerate spacing and lowercase but reject malformed input', () => {
  assert.equal(normalizeRoomCode(' abcd-1234 '), 'ABCD1234');
  assert.ok(ROOM_CODE.test(normalizeRoomCode('abcd1234')));
  assert.ok(!ROOM_CODE.test('A1B2C3'));
  assert.ok(!ROOM_CODE.test('<script>'));
});
test('race input rejects pasted batches, replacement and excess text; corrections retain errors', () => {
  const empty = { typed:'', attempts:0, errors:0, sequence:0 };
  assert.deepEqual(recordKey(empty,'abc','abc'),empty);
  let draft = recordKey(empty,'x','abc');
  draft = recordKey(draft,'','abc');
  draft = recordKey(draft,'a','abc');
  assert.equal(draft.attempts,2); assert.equal(draft.errors,1);
  assert.equal(recordKey(draft,'b','abc'),draft);
  assert.equal(recordKey(draft,'aaaa','abc'),draft);
});
test('shared start clock never enables input before start or after deadline', () => {
  const room = {phase:'racing',duration:30,startsAt:'2026-09-26T00:00:05Z'};
  assert.deepEqual(raceClock(room, Date.parse('2026-09-26T00:00:00Z')), {countdown:5,remaining:30,running:false});
  assert.equal(raceClock(room, Date.parse('2026-09-26T00:00:05Z')).running,true);
  assert.equal(raceClock(room, Date.parse('2026-09-26T00:00:35Z')).running,false);
});
test('ranking prioritizes correct characters, breaks ties with accuracy, preserves genuine draws', () => {
  const players = [{name:'A',correct:12,accuracy:90,left:false},{name:'B',correct:12,accuracy:100,left:false},{name:'C',correct:12,accuracy:100,left:false},{name:'D',correct:999,accuracy:100,left:true}];
  const ranks=rankPlayers(players);
  assert.deepEqual(ranks.map(p=>[p.name,p.rank]),[['B',1],['C',1],['A',3],['D',4]]);
  assert.equal(players[0].name,'A');
});

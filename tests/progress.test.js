import test from 'node:test';
import assert from 'node:assert/strict';
import {dailySummary,weekSummary,weakKeys,keyBand} from '../src/lib/progress.js';
test('yesterday summary excludes skipped challenges and other dates',()=>{
 const a=[{date:'2026-09-10T12:00:00',seconds:60,wpm:30,accuracy:90},{date:'2026-09-10T13:00:00',seconds:60,wpm:50,accuracy:100},{date:'2026-09-10T14:00:00',seconds:60,wpm:0,accuracy:0,skipped:true}];
 assert.deepEqual(dailySummary(a,'2026-09-10'),{count:2,seconds:120,wpm:40,accuracy:95});
 assert.equal(dailySummary(a,'2026-09-11').wpm,null);
});
test('week crosses month and year boundaries without fabricated scores',()=>{
 const days=weekSummary([],new Date('2026-01-02T12:00:00'));
 assert.equal(days[0].key,'2025-12-27'); assert.equal(days[6].key,'2026-01-02'); assert.ok(days.every(d=>d.wpm===null));
});
test('weak key decisions exclude insufficient evidence',()=>{
 const stats={q:{attempts:3,errors:3},a:{attempts:20,errors:4},b:{attempts:10,errors:4}};
 assert.deepEqual(weakKeys(stats),['b','a']); assert.equal(keyBand(stats.q),'unknown'); assert.equal(keyBand(stats.a),'high');
});

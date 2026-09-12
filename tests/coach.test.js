import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, meetsTarget } from '../src/lib/coach.js';
const level={targetWpm:20,warmup:'fj jf',practice:'asdf jkl',challenge:'a steady pace'};
test('new players receive calibration from their current lesson',()=>{
  const plan=makePlan({attempts:[],keyStats:{}},level);
  assert.equal(plan.focus,'calibration');assert.equal(plan.tasks[0].text,level.warmup);assert.equal(plan.wpm,null);
});
test('coach excludes skipped challenges and chooses accuracy before speed',()=>{
  const plan=makePlan({attempts:[{skipped:true,wpm:999,accuracy:100},{wpm:40,accuracy:88}],keyStats:{a:{attempts:20,errors:5},z:{attempts:2,errors:2}}},level);
  assert.equal(plan.focus,'accuracy');assert.deepEqual(plan.keys,['a']);assert.equal(plan.wpm,40);assert.ok(plan.tasks[0].text.includes('af'));
});
test('accurate players receive a modest speed target, and completion requires both targets',()=>{
  const plan=makePlan({attempts:[{wpm:40,accuracy:98}],keyStats:{}},level);
  assert.equal(plan.target,42);assert.equal(plan.focus,'speed');
  assert.equal(meetsTarget(plan.tasks[2],{wpm:43,accuracy:94}),false);
  assert.equal(meetsTarget(plan.tasks[2],{wpm:41,accuracy:99}),false);
  assert.equal(meetsTarget(plan.tasks[2],{wpm:42,accuracy:95}),true);
});

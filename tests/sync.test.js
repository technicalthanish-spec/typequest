import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaveQueue} from '../src/lib/sync.js';
test('newer progress arriving during upload is saved with the next revision',async()=>{
 let stored, release; const calls=[];
 const queue=createSaveQueue({persist:async v=>{stored=v;},send:async(s,r)=>{calls.push([s,r]);if(calls.length===1)await new Promise(resolve=>release=resolve);return r+1;}});
 queue.configure(4);const a={xp:1},b={xp:2};queue.enqueue(a);
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 queue.enqueue(b);release();await queue.idle();
 assert.deepEqual(calls,[[a,4],[b,5]]);assert.equal(stored,null);
});
test('offline progress stays durable and is sent after explicit retry',async()=>{
 let stored,calls=0;
 const q=createSaveQueue({persist:async v=>{stored=v;},send:async(s,r)=>{calls++;return r+1;}});
 q.configure(2,{offline:true});await q.enqueue({xp:9});assert.equal(calls,0);assert.equal(stored.state.xp,9);
 q.configure(2);await q.enqueue(stored.state);assert.equal(calls,1);assert.equal(stored,null);
});
test('conflict preserves pending state without silently increasing revision',async()=>{
 let stored,error;
 const q=createSaveQueue({persist:async v=>{stored=v;},send:async()=>{throw Error('SYNC_CONFLICT');},onError:e=>error=e});
 q.configure(7);await q.enqueue({xp:19});assert.equal(error.message,'SYNC_CONFLICT');assert.deepEqual(stored,{state:{xp:19},revision:7});
});

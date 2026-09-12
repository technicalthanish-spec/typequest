import test from 'node:test';
import assert from 'node:assert/strict';
import { dbGet, dbSet, dbClear } from '../src/lib/db.js';

function mockDB(outcome = 'complete', throws = false) {
  let closed = 0;
  const request = {result:42};
  const tx = {objectStore:()=>({get:()=>request,put:()=>request,clear:()=>request})};
  const db = {close(){closed++},transaction(){
    if(throws) throw Error('Cannot open transaction');
    queueMicrotask(()=> outcome==='complete' ? tx.oncomplete() : tx.onabort());
    return tx;
  }};
  globalThis.window = {indexedDB:{open(){const req={result:db};queueMicrotask(()=>req.onsuccess());return req}}};
  return ()=>closed;
}
test('read, write and reset close their connection after completion', async()=>{
  for(const op of [()=>dbGet('state'),()=>dbSet('state',{}),()=>dbClear()]){
    const closed=mockDB();await op();assert.equal(closed(),1);
  }
});
test('transaction abort rejects and still closes its connection',async()=>{
  const closed=mockDB('abort');await assert.rejects(dbSet('state',{}),/aborted/);assert.equal(closed(),1);
});
test('transaction setup failure closes its connection',async()=>{
  const closed=mockDB('complete',true);await assert.rejects(dbGet('state'),/Cannot open/);assert.equal(closed(),1);
});

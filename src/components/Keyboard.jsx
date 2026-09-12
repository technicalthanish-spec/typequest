import React from 'react';
const rows = ['1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];
const groups = [ ['left little','1qaz'],['left ring','2wsx'],['left middle','3edc'],['left index','45rtfgvb'],['right index','67yuhjnm'],['right middle','8ik,'],['right ring','9ol.'],['right little',"0p;/'-=[]\\"] ];
const shifted = '~!@#$%^&*()_+{}|:"<>?';
const bases = '`1234567890-=[]\\;\',./';
export default function Keyboard({next}) {
  let key=(next || '').toLowerCase();
  const shiftedIndex=shifted.indexOf(next || '\0');
  const shift=shiftedIndex>=0 || /[A-Z]/.test(next || '');
  if(shiftedIndex>=0) key=bases[shiftedIndex];
  const finger = key===' ' ? 'thumb' : groups.find(([,keys])=>keys.includes(key))?.[0];
  return <div className="liveKeyboard"><p className="fingerHint">{next ? <>Next: <kbd>{next===' '?'Space':next}</kbd> · Use your <b>{finger || 'appropriate'} finger</b>{shift?' + Shift':''}</> : 'Place your index fingers on F and J.'}</p><div aria-hidden="true">{rows.map(row=><div className="keyboardRow" key={row}>{[...row].map(k=><span key={k} className={`${k===key?'nextKey':''} ${'fj'.includes(k)?'anchorKey':''}`}>{k.toUpperCase()}</span>)}</div>)}<div className="keyboardRow"><span className={shift?'nextKey':''}>Shift</span><span className={`spaceKey ${key===' '?'nextKey':''}`}>Space</span><span className={shift?'nextKey':''}>Shift</span></div></div></div>;
}

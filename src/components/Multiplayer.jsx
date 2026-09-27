import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { normalizeRoomCode, ROOM_CODE, raceClock, rankPlayers, recordKey, roomError } from '../lib/multiplayer';
import '../multiplayer.css';

const MODES = { easy: ['Easy trail', 'Lowercase words · no punctuation'], standard: ['Quest sprint', 'Sentences · capitals & punctuation'], expert: ['Expert climb', 'Numbers · symbols & mixed case'] };
const blankDraft = () => ({ typed: '', attempts: 0, errors: 0, sequence: 0 });
function savedRoom(key) { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } }

export default function Multiplayer({ user, name, visible, client = supabase }) {
  const storageKey = `typequest-room:${user?.id || 'local'}`;
  const [code, setCode] = useState(() => normalizeRoomCode(new URLSearchParams(location.search).get('room')));
  const [activeCode, setActiveCode] = useState(() => savedRoom(storageKey));
  const [room, setRoom] = useState(null);
  const [duration, setDuration] = useState(60);
  const [difficulty, setDifficulty] = useState('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(true);
  const [typed, setTyped] = useState('');
  const [now, setNow] = useState(Date.now());
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const draft = useRef(blankDraft());
  const current = useRef(null);
  const input = useRef(null);
  const marker = useRef(null);
  const clock = useRef({ server: Date.now(), local: performance.now() });
  const queue = useRef(Promise.resolve());
  const generation = useRef(0);
  const alive = useRef(true);
  const clockNow = () => clock.current.server + performance.now() - clock.current.local;
  const timing = raceClock(room, now);
  const me = room?.players.find(p => p.id === user?.id);
  const host = room?.hostId === user?.id;
  const ranked = rankPlayers(room?.players);
  const available = Boolean(client && user);

  function remember(value) {
    try { value ? sessionStorage.setItem(storageKey, value) : sessionStorage.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
    setActiveCode(value);
  }

  function accept(data, started) {
    const previous = current.current;
    clock.current = { server: Date.parse(data.serverNow) + (performance.now() - started) / 2, local: performance.now() };
    const mine = data.players.find(p => p.id === user.id);
    // Rehydrate after refresh, or when the host opens a new round. Never replace
    // keystrokes made while an earlier progress request was in flight.
    if (!previous || previous.round !== data.round || previous.code !== data.code) {
      draft.current = { typed: data.myText || '', attempts: mine?.attempts || 0, errors: mine?.errors || 0, sequence: mine?.sequence || 0 };
      setTyped(draft.current.typed);
    }
    current.current = data;
    setRoom(data);
    setNow(clockNow());
    setConnected(true);
    setError('');
  }

  function request(action, roomCode, payload = {}) {
    const epoch = generation.current;
    const task = queue.current.catch(() => {}).then(async () => {
      if (epoch !== generation.current || !alive.current) return;
      const started = performance.now();
      const progress = action === 'sync' && current.current?.phase === 'racing'
        ? { ...draft.current, round: current.current.round } : {};
      const { data, error: failure } = await client.rpc('typequest_multiplayer', {
        p_action: action, p_code: roomCode, p_payload: { ...progress, ...payload }
      }).abortSignal(AbortSignal.timeout(10000));
      if (epoch !== generation.current || !alive.current) return;
      if (failure) throw failure;
      if (data && !data.left) accept(data, started);
      return data;
    });
    queue.current = task;
    return task;
  }

  async function command(action, payload = {}) {
    if (busy || !available) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const target = action === 'join' ? normalizeRoomCode(code) : activeCode;
      if (action === 'join' && !ROOM_CODE.test(target)) throw new Error('Enter the 8-character room code.');
      const data = await request(action, target, { name, ...payload });
      if (data?.code) remember(data.code);
      if (data?.left) {
        generation.current++;
        remember(''); current.current = null; setRoom(null); draft.current = blankDraft(); setTyped(''); setLeaveConfirm(false);
      }
    } catch (e) { setError(roomError(e)); }
    finally { if (alive.current) setBusy(false); }
  }

  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (!activeCode || !available) return;
    let stopped = false, timer;
    async function poll() {
      try { await request('sync', activeCode); }
      catch (e) {
        if (stopped) return;
        setConnected(false); setError(roomError(e));
        if (/not found|expired|Join this room/i.test(e.message || '')) {
          remember(''); current.current = null; setRoom(null); return;
        }
      }
      if (!stopped) timer = setTimeout(poll, current.current?.phase === 'racing' ? 500 : 1500);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeCode, available]);
  useEffect(() => {
    if (!room) return;
    const timer = setInterval(() => setNow(clockNow()), 100);
    return () => clearInterval(timer);
  }, [Boolean(room)]);
  useEffect(() => {
    if (timing.running && visible && connected) input.current?.focus();
  }, [timing.running, visible, connected]);
  useEffect(() => {
    if (visible && marker.current) {
      const box = marker.current.parentElement;
      box.scrollTop = Math.max(0, marker.current.offsetTop - box.offsetTop - 65);
    }
  }, [typed, visible]);
  useEffect(() => {
    if (!activeCode) return;
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [activeCode]);

  async function copy(value, message) {
    try { await navigator.clipboard.writeText(value); setNotice(message); }
    catch { setNotice(`Copy this code: ${room.code}`); }
  }
  function onType(e) {
    if (!connected || !raceClock(current.current, clockNow()).running) return;
    const next = recordKey(draft.current, e.target.value, room.passage);
    draft.current = next; setTyped(next.typed);
  }

  return <div className="mp" hidden={!visible}>
    <header className="mpHeading"><div><p className="eyebrow">TYPEQUEST ARENA · MULTIPLAYER</p><h1>{room ? (room.phase === 'results' ? 'The results are in.' : room.phase === 'lobby' ? 'Your starting line.' : 'Find your rhythm.') : 'Great races start with friends.'}</h1><p className="muted">{room ? `Round ${room.round} · ${MODES[room.difficulty][0]} · ${room.duration} seconds` : 'One room. One passage. A little friendly competition.'}</p></div><span className="mpPill"><i />{room ? connected ? 'Connected' : 'Reconnecting' : '2–8 players'}</span></header>
    {error && <div className="mpMessage mpError" role="alert">{error}</div>}
    {notice && <div className="mpMessage" role="status">{notice}</div>}
    {!available && <div className="mpMessage">Sign in to your online TypeQuest account to race with friends. Multiplayer needs an internet connection.</div>}
    {!room && <>
      <section className="mpHero"><div><span className="mpTag">FRIENDLY RACES, REAL PROGRESS</span><h2>A shared challenge.<br/><em>Your own personal best.</em></h2><p>Create a room, send the code, and meet your friends at the starting line. Everyone gets the same text and the same time.</p><div className="mpFeatures"><span>↗ Live standings</span><span>◎ Accuracy counts</span><span>↻ Instant rematches</span></div></div><div className="mpArt" aria-hidden="true"><span>⌨</span><div className="mpTrack"><i style={{width:'76%'}} /><b>YOU</b></div><div className="mpTrack alt"><i style={{width:'57%'}} /><b>FRIEND</b></div><strong>READY. SET. TYPE.</strong></div></section>
      <div className="mpEntryGrid"><form className="card mpEntry" onSubmit={e=>{e.preventDefault();command('create',{duration,difficulty});}}><span className="mpIcon">＋</span><h2>Create a room</h2><p className="muted">Set the pace. Invite your people.</p><label>Race duration<select value={duration} onChange={e=>setDuration(Number(e.target.value))}><option value={30}>30 seconds · Quick dash</option><option value={60}>60 seconds · Classic sprint</option><option value={120}>120 seconds · Endurance</option></select></label><label>Challenge<select value={difficulty} onChange={e=>setDifficulty(e.target.value)}>{Object.entries(MODES).map(([key,[label]])=><option value={key} key={key}>{label}</option>)}</select></label><p className="mpHint">{MODES[difficulty][1]}</p><button className="primary full" disabled={!available||busy||Boolean(activeCode)}>{busy ? 'Opening room…' : 'Create room →'}</button></form>
      <form className="card mpEntry" onSubmit={e=>{e.preventDefault();command('join');}}><span className="mpIcon">↗</span><h2>Join your friends</h2><p className="muted">Have a code? Your starting line is waiting.</p><label>Room code<input className="mpCodeInput" value={code} onChange={e=>setCode(normalizeRoomCode(e.target.value).slice(0,8))} placeholder="A1B2C3D4" maxLength={9} autoCapitalize="characters" autoComplete="off" spellCheck={false}/></label><p className="mpHint">Enter the 8-character code shared by the host.</p><button className="ghost full" disabled={!available||busy||!ROOM_CODE.test(code)||Boolean(activeCode)}>Join room →</button><div className="mpSmallNote">Your TypeQuest name appears in the room. Each player needs their own account.</div></form></div>
      {activeCode && <div className="mpMessage" role="status">Reconnecting to room {activeCode}… <button className="textbtn" onClick={()=>{generation.current++;remember('');current.current=null;setRoom(null);setBusy(false);}}>Return to room selection</button></div>}
      <div className="mpSteps"><div><b>01</b><span>Create or join<small>Share a code with up to 7 friends.</small></span></div><div><b>02</b><span>Get ready together<small>Read the rules and mark yourself ready.</small></span></div><div><b>03</b><span>Race & celebrate<small>Compare speed, accuracy, and your finish.</small></span></div></div>
    </>}
    {room && <>
      <div className="mpRoomBar"><div><small>ROOM CODE</small><strong>{room.code}</strong></div><button className="ghost" onClick={()=>copy(room.code,'Room code copied.')}>Copy code</button><button className="ghost" onClick={()=>copy(`${location.origin}${location.pathname}?room=${room.code}`,'Invite link copied.')}>Copy invite link</button><button className="textbtn mpLeave" onClick={()=>setLeaveConfirm(true)}>Leave room</button></div>
      {leaveConfirm && <div className="mpMessage" role="alert"><span>Leave this room? {room.phase==='racing' ? 'Your result will be marked as withdrawn.' : 'You can join again with the code.'}</span><button className="ghost" onClick={()=>setLeaveConfirm(false)}>Stay</button><button className="primary" disabled={busy} onClick={()=>command('leave')}>Leave room</button></div>}
      {room.phase==='lobby' && <div className="mpLobbyGrid"><section className="card"><div className="mpSectionTitle"><h2>Meet your competition</h2><span>{room.players.length}/8</span></div><div className="mpRoster">{room.players.map((p,i)=><div className="mpPerson" key={p.id}><span className={`mpAvatar color${i%4}`}>{p.name.slice(0,1).toUpperCase()}</span><div><b>{p.name}{p.id===user.id?' (you)':''}</b><small>{p.id===room.hostId?'Room host':'Challenger'}</small></div><span className={`mpStatus ${p.ready&&p.online?'ready':''}`}>{!p.online?'Reconnecting…':p.ready?'✓ Ready':'Getting ready'}</span></div>)}</div>{room.players.length<2&&<div className="mpWaiting">Your first challenger is one invite away.<small>Share the code above to bring a friend in.</small></div>}</section><section className="card mpBriefing"><p className="eyebrow">BEFORE YOU BEGIN</p><h2>Here’s the challenge.</h2><div className="mpRule"><b>01</b><p>Type the same passage for <strong>{room.duration} seconds</strong>. A shared 5-second countdown starts everyone together.</p></div><div className="mpRule"><b>02</b><p>Match every letter, space, and punctuation mark exactly. Backspace is allowed; paste and autofill are blocked.</p></div><div className="mpRule"><b>03</b><p>Most correct characters wins. Accuracy breaks a tie. Corrected mistakes still count toward accuracy.</p></div><p className="mpHint">Friendly competition • race results do not change your level progress or XP.</p><button className={me?.ready?'ghost full':'primary full'} disabled={busy||!connected} onClick={()=>command('ready',{ready:!me?.ready})}>{me?.ready?'✓ You’re ready — undo':'I’m ready to race'}</button>{host?<button className="primary full" disabled={busy||!connected||room.players.length<2||room.players.some(p=>!p.ready||!p.online)} onClick={()=>command('start')}>Start the countdown →</button>:<p className="mpHint">The host starts when everyone is ready.</p>}</section></div>}
      {room.phase==='racing' && <>
        <div className="mpRaceMetrics"><div><small>TIME LEFT</small><strong>{timing.remaining}<em>s</em></strong></div><div><small>YOUR SPEED</small><strong>{me?.wpm||0}<em>WPM</em></strong></div><div><small>ACCURACY</small><strong>{me?.accuracy||0}<em>%</em></strong></div><div><small>POSITION</small><strong>{ranked.find(p=>p.id===user.id)?.rank||'—'}<em>/{room.players.length}</em></strong></div></div>
        <section className="card mpTyping"><div className="mpSectionTitle"><h2>{timing.countdown?'Take a breath. Hands on the home row.':timing.remaining?'Eyes on the text. You’ve got this.':'Time’s up. Confirming results…'}</h2><span>CASE SENSITIVE</span></div>
          {timing.countdown>0?<div className="mpCountdown" role="status"><strong key={timing.countdown}>{timing.countdown}</strong><span>GET READY TO TYPE</span><p>Everyone starts at the same time.</p></div>:<><div className="mpPassage" aria-label="Race passage">{room.passage.slice(0,Math.min(room.passage.length,Math.max(700,typed.length+350))).split('').map((char,i)=><span key={i} ref={i===typed.length?marker:null} className={i<typed.length?(typed[i]===char?'correct':'incorrect'):i===typed.length?'cursor':''}>{char}</span>)}</div><label className="mpInputLabel">Type the passage here<textarea ref={input} value={typed} onChange={onType} disabled={!timing.running||!connected} onPaste={e=>e.preventDefault()} onDrop={e=>e.preventDefault()} onBeforeInput={e=>{if(['insertFromPaste','insertFromDrop','insertReplacementText'].includes(e.nativeEvent.inputType))e.preventDefault();}} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} placeholder="Start typing when the countdown finishes…" aria-describedby="mp-input-help"/></label><small id="mp-input-help" className="mpHint">Keep typing at the end of the text. Backspace to correct mistakes. Stay online until your results appear.</small></>}
        </section><Standings players={ranked} userId={user.id}/>
      </>}
      {room.phase==='results' && <><section className="mpResultsHero"><span className="mpTrophy" aria-hidden="true">🏆</span><p className="eyebrow">ROUND {room.round} COMPLETE</p><h2>{ranked[0]?.correct ? ranked.filter(p=>p.rank===1&&!p.left).map(p=>p.name).join(' & ') + (ranked.filter(p=>p.rank===1&&!p.left).length>1?' share the win!':' takes the win!') : 'A warm-up round. Ready for another?'}</h2><p>{ranked[0]?.correct ? 'Every race is another step forward. Nice work showing up.' : 'No correct characters were recorded this round.'}</p><div className="mpResultStats"><span><b>{me?.wpm||0}</b> WPM</span><span><b>{me?.accuracy||0}%</b> accuracy</span><span><b>{me?.correct||0}</b> correct characters</span></div></section><Standings players={ranked} userId={user.id} results/><div className="mpRematch"><div><h2>One more round?</h2><p className="muted">Keep the room, reset the scores, and get ready again.</p></div>{host?<button className="primary" disabled={busy||!connected} onClick={()=>command('rematch')}>Open rematch ↻</button>:<span className="mpPill">Waiting for the host to open a rematch</span>}</div></>}
    </>}
  </div>;
}

function Standings({players,userId,results=false}) {
  const best = Math.max(1,...players.map(p=>p.correct));
  return <section className="card mpStandings"><div className="mpSectionTitle"><h2>{results?'Final standings':'The live race'}</h2><span>{results?'MOST CORRECT CHARACTERS WINS':'UPDATES THROUGHOUT THE RACE'}</span></div>{players.map((p,i)=><div className={`mpLane ${p.id===userId?'you':''}`} key={p.id}><span className="mpRank">{p.left?'—':`#${p.rank}`}</span><div className="mpLaneMain"><div><b>{p.name}{p.id===userId?' (you)':''}</b><small>{p.left?'Withdrew':!p.online&&!results?'Reconnecting…':`${p.correct} correct characters`}</small></div><div className={`mpLaneTrack color${i%4}`}><i style={{width:`${Math.max(1,p.correct/best*100)}%`}}/></div></div><div className="mpLaneScore"><b>{p.wpm} <small>WPM</small></b><small>{p.accuracy}% accuracy</small></div></div>)}</section>;
}

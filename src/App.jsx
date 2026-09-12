import React, { useEffect, useRef, useState } from "react";
import { dbGet, dbSet, dbClear } from "./lib/db";
import { calcMetrics, matchesCharacter, isLinearEdit } from "./lib/typing";
import { LEVELS } from "./data/levels";
import { supabase, isCloudConfigured } from "./lib/supabase";
import Keyboard from "./components/Keyboard";
import ProgressReport from "./components/ProgressReport";
import { createSaveQueue } from "./lib/sync";
import { weakKeys, keyBand } from "./lib/progress";

const DEFAULT = {
  profile: null,
  currentLevel: 1,
  xp: 0,
  totalStars: 0,
  completed: {},
  attempts: [],
  bestWpm: 0,
  bestAccuracy: 0,
  streak: 0,
  lastPractice: null,
  dailyMinutes: {},
  settings: { theme: "dark" },
  achievements: [],
  firstGuideSeen: false,
  keyStats: {}
};

const finiteNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clampNumber = (value, min, max, fallback = 0) => Math.min(max, Math.max(min, finiteNumber(value, fallback)));

const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const parseDay = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const [y, m, d] = String(value).split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dateDiff = (a, b) => {
  const da = parseDay(a), db = parseDay(b);
  return da && db ? Math.round((db - da) / 86400000) : NaN;
};
const offsetDayKey = offset => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

function normalizeData(d) {
  const src = d && typeof d === "object" ? d : {};
  const completedSrc = src.completed && typeof src.completed === "object" ? src.completed : {};
  const completed = {};
  for (const [rawId, value] of Object.entries(completedSrc)) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1 || id > 50 || !value || typeof value !== "object") continue;
    completed[id] = {
      bestWpm: clampNumber(value.bestWpm, 0, 999),
      bestAccuracy: clampNumber(value.bestAccuracy, 0, 100),
      stars: Math.floor(clampNumber(value.stars, 0, 3)),
      completedAt: typeof value.completedAt === "string" ? value.completedAt : new Date().toISOString()
    };
  }
  const attempts = Array.isArray(src.attempts) ? src.attempts.map(a => {
    if (!a || typeof a !== "object") return null;
    const level = Math.floor(finiteNumber(a.level, 0));
    if (!Number.isInteger(level) || level < 1 || level > 50) return null;
    const stars = Math.floor(clampNumber(a.stars, 0, 3));
    const wpm = clampNumber(a.wpm, 0, 999);
    const accuracy = clampNumber(a.accuracy, 0, 100);
    const errors = Math.floor(clampNumber(a.errors, 0, 999999));
    const seconds = clampNumber(a.seconds, 0, 86400);
    const date = typeof a.date === "string" && !Number.isNaN(Date.parse(a.date)) ? a.date : new Date().toISOString();
    return { id: String(a.id || `${Date.now()}-${Math.random()}`), level, wpm, accuracy, errors, seconds, stars, xp: clampNumber(a.xp, 0, 100000), date, previousBestWpm: clampNumber(a.previousBestWpm, 0, 999), previousBestAccuracy: clampNumber(a.previousBestAccuracy, 0, 100), skipped: Boolean(a.skipped) };
  }).filter(Boolean).slice(0, 500) : [];
  const keyStatsSrc = src.keyStats && typeof src.keyStats === "object" ? src.keyStats : {};
  const keyStats = {};
  for (const [key, value] of Object.entries(keyStatsSrc)) {
    if (!key || !value || typeof value !== "object") continue;
    keyStats[key.toLowerCase()] = { attempts: clampNumber(value.attempts, 0, 1000000000), errors: clampNumber(value.errors, 0, 1000000000) };
  }
  const currentLevel = Math.floor(clampNumber(src.currentLevel, 1, 50, 1));
  const totalStars = Object.values(completed).reduce((sum, item) => sum + item.stars, 0);
  return {
    ...DEFAULT, ...src,
    profile: src.profile && typeof src.profile === "object" ? { name: String(src.profile.name || "Player").slice(0, 24), email: src.profile.email ? String(src.profile.email) : undefined, createdAt: src.profile.createdAt || new Date().toISOString() } : null,
    currentLevel, xp: clampNumber(src.xp, 0, 1000000000), totalStars, completed, attempts,
    bestWpm: clampNumber(src.bestWpm, 0, 999), bestAccuracy: clampNumber(src.bestAccuracy, 0, 100),
    streak: Math.floor(clampNumber(src.streak, 0, 100000)),
    dailyMinutes: Object.fromEntries(Object.entries(src.dailyMinutes && typeof src.dailyMinutes === "object" ? src.dailyMinutes : {}).filter(([k,v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Number(v))).map(([k,v]) => [k, clampNumber(v, 0, 1440)])),
    settings: { ...DEFAULT.settings, ...(src.settings || {}) },
    achievements: Array.isArray(src.achievements) ? [...new Set(src.achievements.filter(x => typeof x === "string"))] : [],
    keyStats
  };
}
async function loadData() {
  if (!window.indexedDB) throw new Error("IndexedDB is unavailable in this browser.");
  const d = await dbGet("state");
  return normalizeData(d);
}
async function saveLocalData(d) { await dbSet("state", d); }

async function loadCloudData() {
  if (!isCloudConfigured) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from("game_states").select("state, revision").eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  return data?.state ? { state: normalizeData(data.state), revision: Number(data.revision || 0) } : null;
}

async function saveCloudData(d, userId = null, revisionRef = null) {
  if (!isCloudConfigured) return;
  const id = userId || (await supabase.auth.getUser()).data?.user?.id;
  if (!id) return;
  const expectedRevision = Number(revisionRef?.current || 0);
  const { data, error } = await supabase.rpc("save_game_state", {
    p_state: normalizeData(d),
    p_expected_revision: expectedRevision
  });
  if (error) throw error;
  if (revisionRef) revisionRef.current = Number(data || expectedRevision + 1);
}


function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function starsFor(m, level) {
  if (m.accuracy < level.minAccuracy) return 0;
  if (m.accuracy >= 98 && m.wpm >= level.targetWpm * 1.15) return 3;
  if (m.accuracy >= 95 && m.wpm >= level.targetWpm) return 2;
  return 1;
}

const FINGER_MAP = {
  "1":"left-pinky","2":"left-ring","3":"left-middle","4":"left-index","5":"left-index","6":"right-index","7":"right-index","8":"right-middle","9":"right-ring","0":"right-pinky",
  q:"left-pinky", a:"left-pinky", z:"left-pinky", w:"left-ring", s:"left-ring", x:"left-ring", e:"left-middle", d:"left-middle", c:"left-middle", r:"left-index", f:"left-index", v:"left-index", t:"left-index", g:"left-index", b:"left-index",
  y:"right-index", h:"right-index", n:"right-index", u:"right-index", j:"right-index", m:"right-index", i:"right-middle", k:"right-middle", ",":"right-middle", o:"right-ring", l:"right-ring", ".":"right-ring", p:"right-pinky", ";":"right-pinky", "/":"right-pinky", "'":"right-pinky", "-":"right-pinky", "=":"right-pinky"
};

function recordKeystroke(prev, expected, actual) {
  const key = expected ?? "";
  if (!key) return prev;
  const id = key.toLowerCase();
  const old = prev[id] || { attempts: 0, errors: 0 };
  return { ...prev, [id]: { attempts: old.attempts + 1, errors: old.errors + (actual === key ? 0 : 1) } };
}

const computeWeakKeys = weakKeys;

function buildDrillText(stats) {
  const weak = computeWeakKeys(stats);
  if (!weak.length) return "asdf jkl; fj dk sl as df jk la;";
  const pools = {
    a: "a sa as sad", s: "s as sa sad", d: "d ad da dad", f: "f df fd fad",
    j: "j jk kj jam", k: "k jk kj ask", l: "l ll al all", ";": "; l; ;l",
    r: "r fr rf are", t: "t rt tr try", y: "y ty yt you", u: "u ju uj use", i: "i ji ij it", o: "o ko ok old", p: "p lp pl pop",
    e: "e de ed see", w: "w sw ws was", q: "q wq qw", z: "z az za", x: "x sx xs", c: "c dc cd", v: "v fv vf", b: "b fb bf", g: "g fg gf", h: "h gh hg", n: "n hn nh", m: "m jm mj",
    ",": ", m, comma", ".": ". m. me.", "/": "/ /a /s", "'": "' 's don't"
  };
  const chunks = weak.map(k => pools[k] || `${k} ${k}${k} ${k}a ${k}e`).join(" ");
  return `${chunks} ${chunks} ${weak.join(" ")} ${chunks}`.slice(0, 180);
}

class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error("TypeQuest runtime error", error); }
  render() {
    if (this.state.error) return <div className="login"><div className="loginCard"><div className="logo big">!</div><p className="eyebrow">UNEXPECTED APP ERROR</p><h1>TypeQuest hit a problem.</h1><p className="muted">Your saved progress is kept locally. Reload the app and try again.</p><div className="card"><b>Technical detail</b><p className="muted">{this.state.error?.message || "Unknown runtime error"}</p></div><button className="primary full" onClick={() => location.reload()}>Reload TypeQuest</button></div></div>;
    return this.props.children;
  }
}

function TypeQuestApp() {
  const [surpriseClosed, setSurpriseClosed] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [syncStatus, setSyncStatus] = useState('saved');
  const [menuOpen, setMenuOpen] = useState(false);
  const [data, setData] = useState(null);
  const [view, setView] = useState("dashboard");
  const [selected, setSelected] = useState(1);
  const [boot, setBoot] = useState(true);
  const [storageError, setStorageError] = useState("");
  const [showBackup, setShowBackup] = useState(false);
  const [cloudUser, setCloudUser] = useState(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const cloudHydratedRef = useRef(false);
  const suppressPersistenceRef = useRef(false);
  const cloudSavePendingRef = useRef(null);
  const cloudSaveRunningRef = useRef(false);
  const cloudSavePromiseRef = useRef(null);
  const cloudGenerationRef = useRef(0);
  const cloudRevisionRef = useRef(0);
  const accountRef = useRef(null);
  const saveQueueRef = useRef(null);
  const explicitAuthRef = useRef(false);
  const lastSavedRef = useRef(null);

  useEffect(() => {
    window.scrollTo({top:0,behavior:'instant'});
    setMenuOpen(false);
    const frame = requestAnimationFrame(() => {
      if (!document.activeElement?.matches('textarea')) document.getElementById('main-content')?.focus({preventScroll:true});
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);

  const queueCloudSave = (nextState,userId) => {
    if(!userId || accountRef.current!==userId) return;
    if(!saveQueueRef.current) {
      const generation=cloudGenerationRef.current;
      const queue=createSaveQueue({
        persist: async pending => {
          await dbSet(`pending:${userId}`,pending);
          if(pending) await dbSet(`state:${userId}`,pending.state);
        },
        send: async (state,revision) => {
          if(accountRef.current!==userId || generation!==cloudGenerationRef.current) throw Error('Account changed. Progress retained on device.');
          const ref={current:revision};await saveCloudData(state,userId,ref);return ref.current;
        },
        onSaved:(state,revision,done)=>{
          if(accountRef.current!==userId)return;
          cloudRevisionRef.current=revision;
          lastSavedRef.current=JSON.stringify(state);
          setSyncStatus(done?'saved':'saving');setCloudError('');
        },
        onError:error=>{if(accountRef.current===userId){setSyncStatus('pending');setCloudError(error.message);}}
      });
      queue.configure(cloudRevisionRef.current,{offline:!cloudHydratedRef.current});
      saveQueueRef.current=queue;
    }
    setSyncStatus(cloudHydratedRef.current?'saving':'pending');
    cloudSavePromiseRef.current=saveQueueRef.current.enqueue(normalizeData(nextState));
    return cloudSavePromiseRef.current;
  };

  const hydrateAccount = async user => {
    await saveQueueRef.current?.idle();
    saveQueueRef.current=null;
    accountRef.current=user.id;
    cloudHydratedRef.current=false;
    const cached=await dbGet(`state:${user.id}`);
    const pending=await dbGet(`pending:${user.id}`);
    const legacy=await dbGet('state');
    const sameLegacy=legacy?.profile?.email?.toLowerCase()===user.email?.toLowerCase();
    const base=normalizeData(cached || (sameLegacy ? legacy : null));
    const profile={name:user.user_metadata?.name || user.email?.split('@')[0] || 'Player',email:user.email,createdAt:base.profile?.createdAt || new Date().toISOString()};
    let next;
    try {
      const cloud=await loadCloudData();
      cloudRevisionRef.current=pending?.revision ?? cloud?.revision ?? 0;
      next=normalizeData(pending?.state || cloud?.state || {...base,profile});
      lastSavedRef.current=cloud?.state ? JSON.stringify(cloud.state) : null;
      if(pending && cloud && pending.revision!==cloud.revision) setCloudError('SYNC_CONFLICT');
      else setCloudError('');
      cloudHydratedRef.current=true;
    } catch(e) {
      cloudRevisionRef.current=pending?.revision ?? 0;
      next=normalizeData(pending?.state || {...base,profile});
      setCloudError('Cloud unavailable. Your account-specific local progress is loaded. Retry when online.');
    }
    setSyncStatus(pending ? 'pending' : 'saved');
    setCloudUser(user);
    setData(next);
  };

  useEffect(() => {
    let active=true;
    (async()=>{
      try {
        if(isCloudConfigured) {
          const {data:{session},error}=await supabase.auth.getSession();
          if(error) throw error;
          if(!active)return;
          if(session?.user) await hydrateAccount(session.user);
          else setData(normalizeData(null));
        } else { const local=await loadData();if(active)setData(local); }
      } catch(e) {if(active)setStorageError(e.message);}
      finally {if(active)setBoot(false);}
    })();
    return ()=>{active=false;};
  }, []);

  useEffect(() => {
    if (!isCloudConfigured) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === "SIGNED_OUT") {
        cloudGenerationRef.current+=1;
        accountRef.current=null;
        saveQueueRef.current=null;
        lastSavedRef.current=null;
        setCloudUser(null);
        setData(normalizeData(null));
        cloudSavePendingRef.current = null;
        cloudHydratedRef.current = false;
        return;
      }
      if ((event === "SIGNED_IN" || event === "USER_UPDATED") && session?.user) {
        // Sign-in is hydrated by handleCloudAuth; token refresh must not copy another account's state.
        if(accountRef.current===session.user.id) setCloudUser(session.user);
        else if(!explicitAuthRef.current) {
          cloudHydratedRef.current=false;
          setBoot(true);
          setTimeout(()=>hydrateAccount(session.user).catch(e=>setCloudError(e.message)).finally(()=>setBoot(false)),0);
        }
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if(!data?.profile || storageError || suppressPersistenceRef.current) return;
    if(isCloudConfigured) {
      if(!cloudUser || accountRef.current!==cloudUser.id) return;
      const snapshot=normalizeData(data);
      if(JSON.stringify(snapshot)===lastSavedRef.current) return;
      setSyncStatus('pending');
      queueCloudSave(snapshot,cloudUser.id);
    } else saveLocalData(data).catch(e=>setStorageError(e.message));
  },[data,cloudUser,storageError]);

  const handleCloudAuth = async ({ mode, email, password, name }) => {
    if (!isCloudConfigured) throw new Error("Cloud login is not configured yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.");
    cloudHydratedRef.current = false;
    explicitAuthRef.current=true;
    setCloudBusy(true); setCloudError("");
    try {
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email address.");
      if (password.length < 6) throw new Error("Password must be at least 6 characters.");
      let user;
      if (mode === "signup") {
        const result = await supabase.auth.signUp({ email, password, options: { data: { name } } });
        if (result.error) throw result.error;
        user = result.data.user;
        if (!result.data.session) throw new Error("Account created. Check your email to confirm your account, then log in.");
      } else {
        const result = await supabase.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        user = result.data.user;
      }
      await hydrateAccount(user);
    } catch (e) { setCloudError(e?.message || "Authentication failed."); throw e; }
    finally { explicitAuthRef.current=false; setCloudBusy(false); }
  };

  useEffect(() => {
    const retry = () => { if (data && cloudUser) hydrateAccount(cloudUser).catch(e=>setCloudError(e.message)); };
    window.addEventListener('online',retry);
    return () => window.removeEventListener('online',retry);
  },[data,cloudUser]);

  const handleLogout = async () => {
    if (cloudError || syncStatus !== 'saved') {
      setCloudError('Please retry the pending save before logging out, or export a backup from Settings.');
      return;
    }
    setCloudBusy(true);
    suppressPersistenceRef.current = true;
    cloudGenerationRef.current += 1;
    cloudSavePendingRef.current = null;
    if (cloudSavePromiseRef.current) await cloudSavePromiseRef.current;
    try {
      if (isCloudConfigured) {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      }
      await dbSet("state", null);
      accountRef.current=null;
      saveQueueRef.current=null;
      setCloudUser(null);
      cloudHydratedRef.current = false;
      cloudRevisionRef.current = 0;
      setData(normalizeData(null));
      setView("dashboard");
    } catch (e) {
      setCloudError(e?.message || "Could not log out cleanly.");
    } finally {
      suppressPersistenceRef.current = false;
      setCloudBusy(false);
    }
  };

  if (recovery) return <Recovery onDone={() => setRecovery(false)} />;
  if (boot) return <div className="boot">Loading your local TypeQuest…</div>;
  if (storageError) return <StorageError message={storageError} />;
  if (!data) return null;
  if (!data.profile || (isCloudConfigured && !cloudUser)) return <Login configured={isCloudConfigured} busy={cloudBusy} error={cloudError} onCloudAuth={handleCloudAuth} onLocalLogin={name => setData({ ...data, profile: { name, createdAt: new Date().toISOString() }, firstGuideSeen: false })} />;
   if (!surpriseClosed && !data.settings.welcomeSeen) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          background: "linear-gradient(135deg, #240d25, #10152e)",
          color: "#fff",
          fontFamily: "inherit",
        }}
      >
        <section
          aria-labelledby="surprise-title"
          style={{
            width: "100%",
            maxWidth: "520px",
            padding: "clamp(24px, 6vw, 48px)",
            borderRadius: "28px",
            background: "#ffffff0d",
            border: "1px solid #ffffff26",
            textAlign: "center",
            boxShadow: "0 24px 80px #0005",
          }}
        >
          <div aria-hidden="true" style={{ fontSize: "56px" }}>
            💌
          </div>

          <p
            style={{
              margin: "24px 0 14px",
              color: "#ffb8d5",
              letterSpacing: "3px",
              fontSize: "13px",
            }}
          >
            A LITTLE SURPRISE FOR YOU
          </p>

          <h1
            id="surprise-title"
            style={{
              fontSize: "clamp(30px, 7vw, 48px)",
              lineHeight: 1.2,
              margin: "0 0 24px",
              color: "#fff",
            }}
          >
            I love you,
            <br />
            meri jaan ❤️
          </h1>

          <p
            style={{
              fontSize: "18px",
              lineHeight: 1.8,
              color: "#ead8e5",
              marginBottom: "30px",
            }}
          >
            Aaj typing practice se pehle,
            ek chhoti si baat…
            <br />
            AAP mere liye bhut special ho.
            Ye surprise sirf apki smile ke liye .
            but aap app open nhi krte itni 
            mehnt s bnai manlia coding ni ki 
            but tym to dia na mene bchuu💗
          </p>

          <button
            type="button"
            autoFocus
            onClick={() => { setSurpriseClosed(true); setData(prev => ({...prev,settings:{...prev.settings,welcomeSeen:true}})); }}
            style={{
              width: "100%",
              padding: "17px 20px",
              border: "none",
              borderRadius: "14px",
              background: "#ffb8d5",
              color: "#301126",
              fontSize: "16px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Continue to TypeQuest →
          </button>
        </section>
      </div>
    );
  }
  const level = LEVELS[selected - 1];
  const completedCount = Object.keys(data.completed).length;
  const unlocked = id => id <= Math.min(50, data.currentLevel);

  const startLevel = id => { if (!unlocked(id)) return; setSelected(id); setView("learn"); };

  const finishLevel = result => {
    const id = selected;
    const previous = data.completed[id]?.bestWpm || 0;
    const stars = result.stars;
    setData(prev => {
      const old = prev.completed[id] || {};
      const passed = stars > 0;
      const firstClear = !prev.completed[id];
      const bestWpm = passed ? Math.max(old.bestWpm || 0, result.wpm) : (old.bestWpm || 0);
      const bestAccuracy = passed ? Math.max(old.bestAccuracy || 0, result.accuracy) : (old.bestAccuracy || 0);
      const bestStars = Math.max(old.stars || 0, stars);
      const completed = passed
        ? { ...prev.completed, [id]: { bestWpm, bestAccuracy, stars: bestStars, completedAt: new Date().toISOString() } }
        : prev.completed;
      const nextLevel = Math.max(prev.currentLevel, id < 50 && passed ? id + 1 : id);
      const day = todayKey();
      const oldDay = prev.lastPractice;
      let streak = prev.streak || 0;
      if (oldDay !== day) streak = oldDay && dateDiff(oldDay, day) === 1 ? streak + 1 : 1;
      const minutes = (prev.dailyMinutes?.[day] || 0) + (result.seconds > 0 ? Math.max(0, result.seconds / 60) : 0);
      const previousBestAccuracy = prev.completed[id]?.bestAccuracy || 0;
      const awardedXp = passed && firstClear ? result.xp : 0;
      const attempt = {
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        level: id, date: new Date().toISOString(), ...result, xp: awardedXp,
        previousBestWpm: previous, previousBestAccuracy
      };
      const achievements = new Set(prev.achievements || []);
      if (stars === 3) achievements.add("perfect");
      if (id >= 10 && passed) achievements.add("ten_levels");
      if (id >= 25 && passed) achievements.add("halfway");
      if (id === 50 && passed) achievements.add("master");
      return {
        ...prev, completed, currentLevel: nextLevel, xp: prev.xp + awardedXp,
        totalStars: Object.values(completed).reduce((sum, x) => sum + (x.stars || 0), 0),
        attempts: [attempt, ...prev.attempts].slice(0, 500),
        bestWpm: passed ? Math.max(prev.bestWpm, result.wpm) : prev.bestWpm,
        bestAccuracy: passed ? Math.max(prev.bestAccuracy, result.accuracy) : prev.bestAccuracy,
        streak, lastPractice: day,
        dailyMinutes: { ...prev.dailyMinutes, [day]: minutes },
        achievements: [...achievements]
      };
    });
    setView("results");
  };

  const addKeyStats = (delta, metrics, seconds = 0) => {
    if (!delta || !Object.keys(delta).length) return;
    setData(prev => {
      const merged = { ...(prev.keyStats || {}) };
      Object.entries(delta).forEach(([key, v]) => {
        const old = merged[key] || { attempts: 0, errors: 0 };
        merged[key] = { attempts: old.attempts + v.attempts, errors: old.errors + v.errors };
      });
      const day=todayKey();
      const streak = prev.lastPractice===day ? prev.streak : prev.lastPractice && dateDiff(prev.lastPractice,day)===1 ? prev.streak+1 : 1;
      return { ...prev, keyStats: merged, ...(seconds>0 ? {dailyMinutes:{...prev.dailyMinutes,[day]:(prev.dailyMinutes[day]||0)+seconds/60},lastPractice:day,streak} : {}) };
    });
  };

  const resetAll = async () => {
    if (!confirm("Reset all TypeQuest progress on this device and in your cloud account? This cannot be undone unless you have a backup.")) return;
    setCloudBusy(true);
    suppressPersistenceRef.current = true;
    cloudGenerationRef.current += 1;
    cloudSavePendingRef.current = null;
    if (cloudSavePromiseRef.current) await cloudSavePromiseRef.current;
    try {
      if (cloudUser && isCloudConfigured) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { error } = await supabase.from("game_states").delete().eq("user_id", user.id);
          if (error) throw error;
        }
      }
      if(cloudUser) {
        await dbSet(`state:${cloudUser.id}`,null);
        await dbSet(`pending:${cloudUser.id}`,null);
      } else await dbSet('state',null);
      lastSavedRef.current=null;
      setCloudError("");
      const resetProfile = cloudUser ? { name: cloudUser.user_metadata?.name || cloudUser.email?.split("@")[0] || "Player", email: cloudUser.email || undefined, createdAt: new Date().toISOString() } : null;
      const resetState = normalizeData({ profile: resetProfile, firstGuideSeen: false });
      cloudSavePendingRef.current = null;
      saveQueueRef.current=null;
      cloudRevisionRef.current = 0;
      if (cloudUser && isCloudConfigured) await saveCloudData(resetState, cloudUser.id, cloudRevisionRef);
      setData(resetState);
      setView("dashboard");
    } catch (e) {
      setCloudError(e?.message || "Could not reset TypeQuest progress.");
    } finally {
      suppressPersistenceRef.current = false;
      setCloudBusy(false);
    }
  };

  return <div className={`${data.settings.theme === "light" ? "app light" : "app"} ${focusMode && ['warmup','practice','challenge','weakdrill'].includes(view) ? 'focusMode' : ''}`}>
    <a className="skipLink" href="#main-content">Skip to content</a>
    <header className="topbar"><div className="brand"><span className="logo">⌨</span><div><b>TypeQuest</b><small>adaptive typing coach {cloudUser ? (cloudError ? "• sync needs attention" : `• ${syncStatus==='saving'?'saving…':syncStatus==='pending'?'saved on device':'cloud saved'}`) : "• local"}</small></div></div><div className="topstats"><span>⭐ {data.totalStars}</span><span>⚡ {data.xp} XP</span><span>🔥 {data.streak}</span><button className="ghost" aria-label="Toggle light or dark theme" onClick={() => setData({ ...data, settings: { ...data.settings, theme: data.settings.theme === "dark" ? "light" : "dark" } })}>☼</button></div></header>
    <button className="mobileMenu ghost" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰ Menu</button>
    <main className="shell"><aside aria-label="Main navigation" className={`sidebar ${menuOpen?'menuOpen':''}`}><button className={view === "dashboard" ? "nav active" : "nav"} onClick={() => setView("dashboard")}>⌂ Dashboard</button><button className={view === "map" ? "nav active" : "nav"} onClick={() => setView("map")}>◈ Level Map</button><button className={view === "history" ? "nav active" : "nav"} onClick={() => setView("history")}>◷ History</button><button className={view === "stats" ? "nav active" : "nav"} onClick={() => setView("stats")}>▣ Progress</button><button className={view === "settings" ? "nav active" : "nav"} onClick={() => setView("settings")}>⚙ Settings</button><div className="sidebottom"><button className="nav" onClick={() => setShowBackup(true)}>⇅ Backup</button><button className={view === "guide" ? "nav active" : "nav"} onClick={() => setView("guide")}>⌨ Finger Guide</button>{cloudUser ? <button className="nav" onClick={handleLogout} disabled={cloudBusy}>⇤ Log out</button> : <button className="nav" onClick={() => setData({ ...data, profile: null })}>⇤ Change Name</button>}</div></aside>
      <section className="content" id="main-content" tabIndex={-1}>
        {['warmup','practice','challenge','weakdrill'].includes(view) && <div className="focusTools"><button className="ghost" aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)}>{focusMode?'Exit focus mode':'Focus mode'}</button><button className="textbtn" onClick={() => setView('dashboard')}>Exit practice</button></div>}
        {view === 'settings' && <div className="settingsPage"><p className="eyebrow">MAKE IT YOURS</p><h1>Settings</h1><section className="card"><h2>Daily practice goal</h2><label htmlFor="daily-goal">Minutes per day</label><select id="daily-goal" value={data.settings.dailyGoal || 10} onChange={e=>setData({...data,settings:{...data.settings,dailyGoal:Number(e.target.value)}})}>{[5,10,15,20,30].map(n=><option key={n} value={n}>{n} minutes</option>)}</select><button className="ghost" onClick={()=>{setSurpriseClosed(false);setData({...data,settings:{...data.settings,welcomeSeen:false}});}}>Read welcome message again</button></section><section className="card"><h2>Your data</h2>{cloudUser && <button className="ghost" onClick={async()=>{try{const backup=await dbGet(`conflict-backup:${cloudUser.id}`);if(!backup){alert('No retained conflict backup on this device.');return;}const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='typequest-conflict-backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setCloudError(e.message);}}}>Download retained conflict backup</button>}<p className="muted">Export a backup before replacing or resetting progress.</p><button className="primary" onClick={()=>setShowBackup(true)}>Backup and restore</button><button className="ghost danger" onClick={resetAll}>Reset progress</button></section></div>}
        {cloudError && <div className="card errorText" role="alert">{cloudError.includes('SYNC_CONFLICT') ? 'Another device has newer progress. Your local version is preserved. Export a backup, then load the cloud version to continue.' : 'Your progress is on this device, but the cloud save needs attention.'} <button className="ghost" onClick={()=>{if(cloudUser)hydrateAccount(cloudUser).catch(e=>setCloudError(e.message));}}>Retry save</button><button className="ghost" onClick={()=>setShowBackup(true)}>Export backup</button>{cloudError.includes('SYNC_CONFLICT') && <button className="ghost" onClick={async()=>{try {const cloud=await loadCloudData();if(cloud){await dbSet(`conflict-backup:${cloudUser.id}`,data);await dbSet(`pending:${cloudUser.id}`,null);saveQueueRef.current=null;cloudRevisionRef.current=cloud.revision;lastSavedRef.current=JSON.stringify(cloud.state);setCloudError('');setSyncStatus('saved');setData(cloud.state);await dbSet(`state:${cloudUser.id}`,cloud.state);}} catch(e){setCloudError(e.message);}}}>Use cloud version</button>}</div>}
        {view === "dashboard" && <Dashboard data={data} level={LEVELS[Math.min(data.currentLevel, 50) - 1]} onStart={startLevel} onMap={() => setView("map")} onStats={() => setView("stats")} onHistory={() => setView("history")} onGuide={() => setView("guide")} onDrill={() => setView("weakdrill")} />}
        {view === "map" && <LevelMap data={data} onStart={startLevel} />}
        {view === "learn" && <Learn level={level} onStart={() => setView("warmup")} />}
        {view === "warmup" && <TypingStage key={`warmup-${selected}`} level={level} stage="warmup" text={level.warmup} exactCase={level.id >= 11} onDone={(delta, metrics, seconds) => { addKeyStats(delta, metrics, seconds); setView("practice"); }} onSkip={(delta, metrics, seconds) => { addKeyStats(delta, metrics, seconds); setView("practice"); }} />}
        {view === "practice" && <TypingStage key={`practice-${selected}`} level={level} stage="practice" text={level.practice} exactCase={level.id >= 11} onDone={(delta, metrics, seconds) => { addKeyStats(delta, metrics, seconds); setView("challenge"); }} onSkip={(delta, metrics, seconds) => { addKeyStats(delta, metrics, seconds); setView("challenge"); }} />}
        {view === "challenge" && <TypingStage key={`challenge-${selected}`} level={level} stage="challenge" text={level.challenge} exactCase={level.id >= 11} graded onDone={(delta, metrics, seconds) => { addKeyStats(delta); finishLevel({ ...metrics, seconds, xp: level.xp, stars: starsFor(metrics, level) }); }} onSkip={(delta, metrics, seconds) => { addKeyStats(delta); finishLevel({ ...metrics, seconds, xp: 0, stars: 0, skipped: true }); }} />}
        {view === "results" && <Results level={level} data={data} onNext={() => data.attempts[0]?.stars > 0 && selected < 50 && data.currentLevel > selected ? startLevel(selected + 1) : setView("map")} onReplay={() => setView("challenge")} onMap={() => setView("map")} />}
        {view === "history" && <History data={data} />}
        {view === "stats" && <Stats data={data} onDrill={() => setView("weakdrill")} />}
        {view === "guide" && <FingerGuide onStart={() => setView("dashboard")} />}
        {view === "weakdrill" && <WeakDrill data={data} onBack={() => setView("stats")} onDone={addKeyStats} />}
      </section>
    </main>
    {showBackup && <Backup data={data} setData={setData} close={() => setShowBackup(false)} />}
  </div>;
}

function StorageError({ message }) { return <div className="login"><div className="loginCard"><div className="logo big">!</div><p className="eyebrow">LOCAL STORAGE ERROR</p><h1>TypeQuest needs browser storage.</h1><p className="muted">Your browser is blocking IndexedDB, so progress cannot be loaded or saved. Try a normal browser window with site storage enabled (not strict private browsing).</p><div className="card"><b>Technical detail</b><p className="muted">{message}</p></div><button className="primary full" onClick={() => location.reload()}>Retry</button></div></div>; }

function Login({ configured, busy, error, onCloudAuth, onLocalLogin }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [showPassword,setShowPassword]=useState(false);
  const [resetBusy,setResetBusy]=useState(false);
  const submit = async e => {
    e?.preventDefault(); setMessage("");
    if (!configured) {
      onLocalLogin(name.trim() || "Player");
      return;
    }
    try {
      await onCloudAuth({ mode, email: email.trim(), password, name: name.trim() });
      setMessage(mode === "signup" ? "Account ready — welcome to TypeQuest." : "Welcome back.");
    } catch {}
  };
  return <div className="login"><div className="loginCard"><div className="logo big">⌨</div><p className="eyebrow">{configured ? "CLOUD • PRIVATE • PERSONAL" : "LOCAL • PERSONAL"}</p><h1>Your typing journey<br/><span>starts here.</span></h1><p className="muted">{configured ? "Create an account to keep your progress synced across devices." : "Local mode is active. Add Supabase settings to enable cloud login."}</p>
    {configured ? <form onSubmit={submit}>
      {mode === "signup" && <input autoFocus value={name} onChange={e => setName(e.target.value)} aria-label="Your name" placeholder="Your name" maxLength={24}/>}
      <label>Email address<input autoFocus={mode === "login"} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" autoComplete="email"/></label>
      <label>Password<input type={showPassword?"text":"password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (6+ characters)" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={6}/></label><label className="showPassword"><input type="checkbox" checked={showPassword} onChange={e=>setShowPassword(e.target.checked)}/> Show password</label>{error && <p className="errorText">{error}</p>}{message && <p className="successText">{message}</p>}
      <button className="primary full" disabled={busy || !email || password.length < 6}>{busy ? "Please wait…" : mode === "login" ? "Log in →" : "Create account →"}</button>
      <button type="button" className="textbtn full" disabled={resetBusy || !email} onClick={async()=>{setResetBusy(true);setMessage('');try {const {error}=await supabase.auth.resetPasswordForEmail(email.trim(),{redirectTo:window.location.origin});if(error)throw error;setMessage('If this account exists, a password reset link has been sent. Check your inbox.');}catch(e){setMessage(e.message || 'Could not send reset email. Try again.');}finally{setResetBusy(false);}}}>{resetBusy?'Sending…':'Forgot password?'}</button>
      <button type="button" className="textbtn full" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setMessage(""); }}>{mode === "login" ? "New here? Create an account" : "Already have an account? Log in"}</button>
    </form> : <><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Enter your name" maxLength={24}/><button className="primary full" disabled={!name.trim()} onClick={() => onLocalLogin(name.trim())}>Start local profile →</button></>}
  </div></div>;
}
function Dashboard({ data, level, onStart, onMap, onStats, onHistory, onGuide, onDrill }) {
  const day = todayKey();
  const mins = Math.round((data.dailyMinutes?.[day] || 0)*10)/10;
  const goal = data.settings.dailyGoal || 10;
  const daily = Math.min(goal, mins);
  const comp = Object.keys(data.completed).length;
  const current = Math.min(data.currentLevel, 50);
  const journeyPct = Math.round((comp / 50) * 100);
  const weak = computeWeakKeys(data.keyStats);
  const recent = data.attempts?.[0];
  const keys = [..."QWERTYUIOPASDFGHJKL;ZXCVBNM,./"];

  return <div className="dashboard">
    <div className="dashboardIntro">
      <div>
        <p className="eyebrow">YOUR TYPING COACH</p>
        <h1>Build speed.<br/><span>Keep accuracy.</span></h1>
        <p className="muted introText">A focused practice session is waiting for you. Your next goal is <b>Level {level.id}</b>.</p>
      </div>
      <div className="sessionCard">
        <div className="sessionTop"><span className="liveDot"/> READY TO PRACTICE <span className="sessionLevel">LV {level.id}</span></div>
        <div className="sessionTitle">{level.title}</div>
        <div className="sessionMeta"><span>{level.tier}</span><span>Target {level.targetWpm} WPM</span><span>Min {level.minAccuracy}%</span></div>
        <button className="primary sessionBtn" onClick={() => onStart(level.id)}>Start Level {level.id} <span>→</span></button>
      </div>
    </div>

    <div className="journeyCard card">
      <div className="journeyHeader">
        <div><p className="eyebrow">YOUR JOURNEY</p><h2>50 levels to mastery</h2></div>
        <button className="textbtn" onClick={onMap}>Open level map →</button>
      </div>
      <div className="journeyTrack">
        <div className="journeyLine"><i style={{width: `${Math.max(3, journeyPct)}%`}}/></div>
        <div className="journeyNodes">
          {[1,10,30,50].map(n => <div key={n} className={`journeyNode ${current >= n ? "passed" : ""} ${current === n ? "current" : ""}`}>
            <span>{n === 50 ? "★" : n}</span><small>{n === 1 ? "START" : n === 10 ? "BASIC" : n === 30 ? "ADVANCED" : "BOSS"}</small>
          </div>)}
        </div>
      </div>
      <div className="journeyFoot"><span><b>{comp}</b> / 50 completed</span><span>{journeyPct}% journey progress</span></div>
    </div>

    <div className="dashboardGrid">
      <div className="card coachCard">
        <div className="cardLabel"><span className="labelIcon">✦</span><span>ADAPTIVE COACH</span></div>
        {weak.length > 0 ? <>
          <h2>I found something to work on.</h2>
          <p className="muted">Your typing data shows these keys need more attention.</p>
          <div className="coachKeys">{weak.map(k => <span key={k}>{k.toUpperCase()}</span>)}</div>
          <button className="ghost coachBtn" onClick={onDrill}>Open targeted drill <span>→</span></button>
        </> : <>
          <h2>Your coach is ready.</h2>
          <p className="muted">No consistent weak keys yet. Keep practising so your coach has enough data to recommend a drill.</p>
          <button className="ghost coachBtn" onClick={() => onStart(level.id)}>Start collecting data <span>→</span></button>
        </>}
      </div>

      <div className="card missionCard">
        <div className="cardLabel"><span className="labelIcon">◷</span><span>TODAY</span></div>
        <div className="missionMain">
          <div className="missionRing"><b>{daily}</b><small>/ {goal} min</small></div>
          <div><h2>Keep the streak alive.</h2><p className="muted">{mins >= goal ? "Today's practice goal is complete." : `${Math.round((goal - daily)*10)/10} minutes of focused typing left today.`}</p></div>
        </div>
        <div className="miniBar"><i style={{width: `${daily / goal * 100}%`}}/></div>
      </div>
    </div>

    <ProgressReport data={data}/><div className="dashboardGrid lowerGrid">
      <div className="card performanceCard">
        <div className="cardLabel"><span className="labelIcon">↗</span><span>PERFORMANCE</span></div>
        <div className="performanceStats">
          <div><small>BEST SPEED</small><strong>{data.bestWpm || "—"}<em> WPM</em></strong></div>
          <div><small>BEST ACCURACY</small><strong>{data.bestAccuracy ? data.bestAccuracy : "—"}<em>{data.bestAccuracy ? "%" : ""}</em></strong></div>
          <div><small>STREAK</small><strong>{data.streak || 0}<em> {data.streak === 1 ? "day" : "days"}</em></strong></div>
        </div>
        {recent ? <div className="lastSession">Last session · Level {recent.level} · {recent.wpm} WPM · {recent.accuracy}% accuracy</div> : <div className="lastSession">Your first completed challenge will appear here.</div>}
      </div>

      <div className="card keyboardCard">
        <div className="keyboardHeader"><div><p className="eyebrow">TRAINING BOARD</p><h2>Your keyboard</h2></div><button className="textbtn" onClick={onGuide}>Finger guide</button></div>
        <div className="miniKeyboard">{keys.map(k => <span key={k} className={weak.includes(k.toLowerCase()) ? "weakKey" : ""}>{k}</span>)}</div>
      </div>
    </div>

    <div className="quickStrip">
      <button onClick={onMap}><span>◈</span><b>Level Map</b><small>50 levels</small><i>→</i></button>
      <button onClick={onStats}><span>▣</span><b>Analytics</b><small>Find weak keys</small><i>→</i></button>
      <button onClick={onHistory}><span>◷</span><b>History</b><small>Past sessions</small><i>→</i></button>
      <button onClick={onGuide}><span>⌨</span><b>Finger Guide</b><small>Quick reference</small><i>→</i></button>
    </div>
  </div>;
}
function Metric({ label, value, icon }) { return <div className="metric"><span>{icon}</span><small>{label}</small><strong>{value}</strong></div>; }

function LevelMap({ data, onStart }) { return <div><div className="pageTitle"><p className="eyebrow">THE JOURNEY</p><h1>50 levels. One skill.</h1><p className="muted">Each level unlocks the next. Clear it with the required accuracy.</p></div>{["Basic", "Intermediate", "Advanced"].map(tier => <div key={tier} className="tier"><div className="tierTitle"><h2>{tier}</h2><span>{tier === "Basic" ? "1–10" : tier === "Intermediate" ? "11–30" : "31–50"}</span></div><div className="levelGrid">{LEVELS.filter(l => l.tier === tier).map(l => { const p = data.completed[l.id], open = l.id <= data.currentLevel; return <button key={l.id} disabled={!open} className={`levelTile ${open ? "open" : "locked"} ${p ? "done" : ""}`} onClick={() => onStart(l.id)}><b>{p ? `⭐ ${p.stars}` : open ? "→" : "🔒"}</b><strong>{l.id}</strong><small>{l.title}</small><em>{l.targetWpm} WPM</em></button>; })}</div></div>)}</div>; }

function StageIndicator({ current }) { const stages = ["Learn", "Warm-up", "Practice", "Challenge", "Results"]; const index = stages.indexOf(current); return <div className="stageIndicator">{stages.map((s, i) => <React.Fragment key={s}><div className={`stageStep ${i === index ? "active" : i < index ? "done" : ""}`}><span>{i < index ? "✓" : i + 1}</span>{s}</div>{i < stages.length - 1 && <i/>}</React.Fragment>)}</div>; }

function Learn({ level, onStart }) { return <div className="learn"><StageIndicator current="Learn"/><div className="pageTitle"><p className="eyebrow">{level.tier.toUpperCase()} • LEVEL {level.id}</p><h1>{level.title}</h1><p className="muted">{level.objective}</p></div><div className="learnGrid"><div className="card"><span className="lessonIcon">1</span><h3>Learn</h3><p>{level.objective}</p><p className="muted">{level.id<=10?'Rest your fingers on A S D F and J K L ;. Return to the home row after reaching for a key.':level.id<=30?'Use the opposite hand for Shift when typing a capital. For punctuation, practise the movement slowly before adding speed.':'Keep an even rhythm through symbols and longer passages. Slow down at difficult combinations instead of rushing the whole line.'}</p><small>Focus: <b>{level.warmup}</b></small></div><div className="card"><span className="lessonIcon">2</span><h3>Warm-up</h3><p className="practiceText">You will type the warm-up next. Slow and accurate first.</p><small>Short drill • mistakes are tracked</small></div><div className="card"><span className="lessonIcon">3</span><h3>Practice</h3><p className="practiceText">Then build rhythm with a longer practice passage.</p><small>Target: {level.targetWpm} WPM • {level.minAccuracy}% accuracy</small></div></div><div className="challengePreview card"><div><p className="eyebrow">NEXT: WARM-UP</p><h2>Ready to train?</h2><p className="muted">The timer starts on your first key.</p></div><button className="primary" onClick={onStart}>Start warm-up →</button></div></div>; }

function TypingStage({ level, stage, text, graded = false, exactCase = false, onDone, onSkip, standalone = false }) {
  const [typed, setTyped] = useState("");
  const [showKeyboard, setShowKeyboard] = useState(true);
  const [textSize, setTextSize] = useState(26);
  const [seconds, setSeconds] = useState(0);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const inputRef = useRef(null);
  const startedAtRef = useRef(null);
  const deltaRef = useRef({});
  const keystrokesRef = useRef(0);
  const correctKeystrokesRef = useRef(0);
  const cumulativeErrorsRef = useRef(0);
  const finishedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!started || finished) return;
    const tick = () => {
      const elapsed = Math.max(0, (performance.now() - startedAtRef.current) / 1000);
      setSeconds(elapsed);
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [started, finished]);

  const stageTitle = stage === "warmup" ? "Warm-up" : stage === "practice" ? "Practice" : "Challenge";

  const makeMetrics = (value, elapsed) => {
    return calcMetrics(text, value, elapsed, exactCase, {
      attempts: keystrokesRef.current,
      correct: correctKeystrokesRef.current,
      errors: cumulativeErrorsRef.current
    });
  };
  const metrics = makeMetrics(typed, seconds);

  const finish = (skip = false, finalTyped = typed) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFinished(true);
    const elapsed = startedAtRef.current !== null ? Math.max(0, (performance.now() - startedAtRef.current) / 1000) : 0;
    const finalSeconds = Math.max(seconds, elapsed);
    const finalMetrics = makeMetrics(finalTyped, finalSeconds);
    if (skip) { onSkip?.(deltaRef.current, finalMetrics, finalSeconds); return; }
    onDone?.(deltaRef.current, finalMetrics, finalSeconds);
  };

  const onChange = e => {
    if (finishedRef.current) return;
    const raw = e.target.value;
    // Keep the exercise linear: edits are allowed, but the caret is always forced to the end.
    // Backspace/Delete lets learners recover from mistakes without moving the target cursor.
    if (!isLinearEdit(typed, raw)) {
      e.target.value = typed;
      e.target.setSelectionRange(typed.length, typed.length);
      return;
    }
    const value = raw.slice(0, text.length);
    if (!started && value.length) {
      startedAtRef.current = performance.now();
      setStarted(true);
    }
    if (value.length > typed.length) {
      for (let index = typed.length; index < value.length; index++) {
        const expected = text[index];
        const id = expected?.toLowerCase();
        if (!id) continue;
        const old = deltaRef.current[id] || { attempts: 0, errors: 0 };
        const sameLetter = matchesCharacter(expected, value[index], exactCase);
        keystrokesRef.current += 1;
        if (sameLetter) correctKeystrokesRef.current += 1;
        else cumulativeErrorsRef.current += 1;
        deltaRef.current[id] = {
          attempts: old.attempts + 1,
          errors: old.errors + (sameLetter ? 0 : 1)
        };
      }
    }
    setTyped(value);
    if (value.length >= text.length) {
      finish(false, value);
    }
  };

  const targetText = text.split("");
  return <div className="practice">
    {!standalone && <StageIndicator current={stageTitle}/>}
    <div className="practiceTop">
      <div><p className="eyebrow">{standalone ? "PERSONALISED PRACTICE" : `LEVEL ${level.id} • ${level.tier}`}</p><h1>{standalone ? "Train your weak keys" : stageTitle}</h1><p className="muted">{stage === "warmup" ? "Find accuracy and finger control." : stage === "practice" ? "Build rhythm before the graded challenge." : "Type the exact passage to clear the level."}</p></div>
      <div className="liveStats"><b>{formatTime(seconds)}</b><span>{metrics.wpm} WPM</span><span>{started ? `${metrics.accuracy}%` : "—"} ACC</span><span>{metrics.errors} ERR</span></div>
    </div>
    <div className="typingOptions"><label><input type="checkbox" checked={showKeyboard} onChange={e=>setShowKeyboard(e.target.checked)}/> Keyboard guide</label><label>Text size <select value={textSize} onChange={e=>setTextSize(Number(e.target.value))}><option value={22}>Small</option><option value={26}>Medium</option><option value={32}>Large</option></select></label></div>
    <div className="card typingCard">
      <div className="target" style={{fontSize:textSize}}>{targetText.map((ch, i) => <span key={i} className={i < typed.length ? (matchesCharacter(ch, typed[i], exactCase) ? "correct" : "wrong") : (i === typed.length ? "cursor" : "")}>{ch === " " ? " " : ch}</span>)}</div>
      <label className="inputLabel">Type the passage here<textarea aria-label={`${stageTitle} typing input`} ref={inputRef} value={typed} onChange={onChange} onKeyDown={e => { if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key)) e.preventDefault(); }} onFocus={e => { e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length); }} onPaste={e => e.preventDefault()} onDrop={e => e.preventDefault()} onDragOver={e => e.preventDefault()} spellCheck="false" autoCapitalize="off" autoCorrect="off" placeholder="Start typing here…" disabled={finished}/></label>
      {showKeyboard && <Keyboard next={text[typed.length]}/> }
      <div className="row between hint"><small>{graded ? `Target ${level.targetWpm} WPM • minimum ${level.minAccuracy}% accuracy` : "Mistakes are tracked to personalize your future drills."}</small><small>{typed.length}/{text.length}</small></div>
      <div className="stageActions"><button className="ghost" onClick={() => finish(true)}>Skip {graded ? "challenge" : stageTitle.toLowerCase()} →</button>{Object.keys(deltaRef.current).length > 0 && <small>{Object.keys(deltaRef.current).length} key{Object.keys(deltaRef.current).length === 1 ? "" : "s"} tracked</small>}</div>
    </div>
  </div>;
}

function Results({ level, data, onNext, onReplay, onMap }) { const a = data.attempts[0] || {}, pass = a.stars > 0; const improvement = a.previousBestWpm ? a.wpm - a.previousBestWpm : 0; const accuracyImprovement = a.accuracy - (a.previousBestAccuracy || 0); return <div className="result"><div className="resultBadge">{pass ? "✓" : "↺"}</div><StageIndicator current="Results"/><p className="eyebrow">{pass ? "LEVEL CLEARED" : "KEEP PRACTICING"}</p><h1>{pass ? `Level ${level.id} complete.` : "Almost there."}</h1><p className="muted">{pass ? `You earned ${a.xp} XP and ${a.stars} star${a.stars === 1 ? "" : "s"}.` : `${a.skipped ? "Challenge skipped." : `You need at least ${level.minAccuracy}% accuracy to clear this level.`} No XP is awarded for a failed attempt.`}</p><div className="resultGrid"><Metric label="WPM" value={a.wpm} icon="⚡"/><Metric label="Accuracy" value={`${a.accuracy}%`} icon="◎"/><Metric label="Errors" value={a.errors} icon="×"/><Metric label="Stars" value={a.stars} icon="★"/></div><div className={`improvement ${improvement > 0 || accuracyImprovement > 0 ? "up" : improvement < 0 || accuracyImprovement < 0 ? "down" : "flat"}`}><b>{improvement > 0 ? `↑ ${improvement} WPM improvement` : improvement < 0 ? `↓ ${Math.abs(improvement)} WPM from previous best` : a.previousBestWpm ? "→ Matched your previous WPM best" : "First recorded attempt"}</b><small>{a.previousBestWpm ? `Previous: ${a.previousBestWpm} WPM • ${a.previousBestAccuracy || 0}% accuracy` : "Your next attempt will have a baseline."}</small>{a.previousBestAccuracy > 0 && <small>{accuracyImprovement > 0 ? `↑ ${accuracyImprovement.toFixed(1)} percentage points accuracy improvement` : accuracyImprovement < 0 ? `↓ ${Math.abs(accuracyImprovement).toFixed(1)} percentage points accuracy` : "→ Accuracy matched previous best"}</small>}</div><div className="resultActions"><button className="ghost bigBtn" onClick={onReplay}>Try again</button><button className="primary bigBtn" onClick={onNext}>{pass && level.id < 50 ? "Next level →" : "Back to map →"}</button></div></div>; }

function History({ data }) {
  const [page,setPage]=useState(0),[filter,setFilter]=useState('all');
  const rows=data.attempts.filter(a=>filter==='all'||(filter==='passed'?a.stars>0:a.stars===0));
  const count=Math.max(1,Math.ceil(rows.length/20));
  return <div><div className="pageTitle"><p className="eyebrow">PRACTICE LOG</p><h1>Your history</h1></div><label>Show attempts <select value={filter} onChange={e=>{setFilter(e.target.value);setPage(0);}}><option value="all">All</option><option value="passed">Passed</option><option value="practice">Not passed / skipped</option></select></label><div className="card tableCard">{rows.length ? <table><thead><tr><th>Level</th><th>WPM</th><th>Accuracy</th><th>Time</th><th>Result</th><th>Date</th></tr></thead><tbody>{rows.slice(page*20,page*20+20).map(a=><tr key={a.id}><td>#{a.level}</td><td>{a.wpm}</td><td>{a.accuracy}%</td><td>{formatTime(a.seconds)}</td><td>{a.skipped?'Skipped':a.stars?'★'.repeat(a.stars):'Practise again'}</td><td>{new Date(a.date).toLocaleString()}</td></tr>)}</tbody></table>:<Empty text="No attempts match this filter."/>}</div><div className="pagination"><button className="ghost" disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page+1} of {count}</span><button className="ghost" disabled={page+1>=count} onClick={()=>setPage(page+1)}>Next</button></div><p className="muted">Showing your most recent 500 challenges. Export backups to keep older history.</p></div>;
}

function Stats({ data, onDrill }) { const weak = computeWeakKeys(data.keyStats); const achievements = [["perfect", "3-star clear"], ["ten_levels", "10 levels cleared"], ["halfway", "25 levels cleared"], ["master", "Level 50 mastery"]]; const keyRows = Object.entries(data.keyStats || {}).map(([key, v]) => ({ key, ...v, rate: v.attempts ? v.errors / v.attempts : 0 })).sort((a,b) => b.rate - a.rate || b.errors - a.errors); const keys = ["q","w","e","r","t","y","u","i","o","p","a","s","d","f","g","h","j","k","l",";","z","x","c","v","b","n","m",",",".","/"]; return <div><div className="pageTitle"><p className="eyebrow">PROGRESS</p><h1>Performance lab</h1><p className="muted">Your mistakes become the training plan.</p></div><ProgressReport data={data}/><div className="grid two"><div className="card"><h2>Milestones</h2>{achievements.map(([k,t]) => <div className={`achievement ${data.achievements.includes(k) ? "earned" : ""}`} key={k}><span>{data.achievements.includes(k) ? "✓" : "○"}</span>{t}</div>)}</div><div className="card"><h2>Personal records</h2><div className="record"><small>Fastest WPM</small><b>{data.bestWpm || "—"}</b></div><div className="record"><small>Best accuracy</small><b>{data.bestAccuracy ? data.bestAccuracy + "%" : "—"}</b></div><div className="record"><small>Total XP</small><b>{data.xp}</b></div><div className="record"><small>Total stars</small><b>{data.totalStars}/150</b></div></div></div><div className="card heatmapCard"><div className="sectionHead"><div><p className="eyebrow">ADAPTIVE HEATMAP</p><h2>Keyboard difficulty</h2></div>{weak.length > 0 && <button className="primary" onClick={onDrill}>Practice weak keys →</button>}</div><p className="muted">Teal: under 8% errors · amber: 8–19% · red: 20% or more · grey: fewer than 8 attempts.</p><div className="heatKeyboard">{keys.map(key => { const s = data.keyStats?.[key] || { attempts: 0, errors: 0 }; const rate = s.attempts ? s.errors / s.attempts : 0; return <div key={key} className={`heatKey band-${keyBand(s)}`} style={{ "--heat": rate, "--used": s.attempts ? 1 : 0 }} title={`${key.toUpperCase()}: ${s.errors || 0} errors / ${s.attempts || 0} attempts`}><b>{key.toUpperCase()}</b><small>{s.attempts >= 8 ? `${Math.round(rate * 100)}%` : "Learning"}</small></div>; })}</div><div className="weakList"><b>Weak keys</b>{weak.length ? weak.map(k => <span className="weakChip" key={k}>{k.toUpperCase()}</span>) : <small>No weak-key data yet. Complete a typing stage to train the coach.</small>}</div>{keyRows.length > 0 && <div className="weakTable"><h3>Most error-prone</h3>{keyRows.slice(0, 5).map(r => <div className="record" key={r.key}><span><b>{r.key.toUpperCase()}</b> · {r.attempts} attempts</span><b>{r.attempts < 8 ? "Need more data" : `${Math.round(r.rate * 100)}% errors`}</b></div>)}</div>}</div></div>; }

function WeakDrill({ data, onBack, onDone }) {
  const textRef=useRef(buildDrillText(data.keyStats));
  const [result,setResult]=useState(null);
  const [run,setRun]=useState(0);
  if(result) return <div className="result"><p className="eyebrow">TARGETED PRACTICE COMPLETE</p><h1>Every repetition counts.</h1><div className="resultGrid"><Metric label="WPM" value={result.wpm} icon="⚡"/><Metric label="Accuracy" value={`${result.accuracy}%`} icon="◎"/><Metric label="Errors" value={result.errors} icon="×"/></div><p className="muted">Your keyboard profile and daily practice time have been updated.</p><button className="primary" onClick={()=>{setResult(null);setRun(run+1);}}>Practise again</button><button className="ghost" onClick={onBack}>Back to progress</button></div>;
  return <TypingStage key={run} level={LEVELS[0]} stage="practice" text={textRef.current} standalone onDone={(delta,metrics,seconds)=>{onDone(delta,metrics,seconds);setResult(metrics);}} onSkip={(delta,metrics,seconds)=>{onDone(delta,metrics,seconds);onBack();}}/>;
}

function FingerGuide({ onStart }) { const left = [["A","LITTLE"],["S","RING"],["D","MIDDLE"],["F","INDEX"]], right = [["J","INDEX"],["K","MIDDLE"],["L","RING"],[";","LITTLE"]]; return <div className="fingerGuide"><div className="pageTitle"><p className="eyebrow">FINGER GUIDE • QUICK REFERENCE</p><h1>Start with the<br/><span>right hand position.</span></h1><p className="muted">Use this quick reference anytime to check finger placement before practice.</p></div><div className="card handCard"><div className="keyboardMini"><div className="keyRow">{["Q","W","E","R","T","Y","U","I","O","P"].map(k => <span key={k}>{k}</span>)}</div><div className="keyRow homeKeys">{["A","S","D","F","G","H","J","K","L",";"].map(k => <span key={k}>{k}</span>)}</div><div className="keyRow">{["Z","X","C","V","B","N","M",",",".","/"].map(k => <span key={k}>{k}</span>)}</div></div><div className="placementGrid"><Placement title="Left hand" keys={left}/><Placement title="Right hand" keys={right}/></div><div className="guideRules"><div><b>F & J are anchors</b><small>Keep your index fingers on the raised bumps.</small></div><div><b>Thumbs → Space</b><small>Use either thumb comfortably.</small></div><div><b>Eyes on the text</b><small>Try not to look down at the keyboard.</small></div></div></div><div className="challengePreview card"><div><p className="eyebrow">QUICK REFERENCE</p><h2>Ready to practice?</h2><p className="muted">Return to your dashboard and start a level whenever you are ready.</p></div><button className="primary" onClick={onStart}>Back to dashboard →</button></div></div>; }
function Placement({ title, keys }) { return <div className="placementCol"><h3>{title}</h3>{keys.map(([key,finger]) => <div className="fingerRow" key={key}><b>{key}</b><span>{finger} finger</span></div>)}</div>; }
function Empty({ text }) { return <div className="empty">{text}</div>; }
function Backup({ data, setData, close }) { const fileRef = useRef(); const modalRef=useRef();
  useEffect(()=>{const prior=document.activeElement;modalRef.current?.querySelector('button')?.focus();return()=>prior?.focus();},[]);
  const trap=e=>{if(e.key==='Escape'){close();return;}if(e.key==='Tab'){const items=[...modalRef.current.querySelectorAll('button,input:not([hidden])')];const first=items[0],last=items.at(-1);if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}}}; const download = () => { const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `typequest-backup-${todayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }; const importFile = async e => { const f = e.target.files?.[0]; if (!f) return; try { if (f.size > 2 * 1024 * 1024) throw Error("Backup is too large"); const d = JSON.parse(await f.text()); if (!d || typeof d !== "object" || Array.isArray(d) || !d.profile || typeof d.profile !== "object" || Array.isArray(d.profile) || !Array.isArray(d.attempts) || d.attempts.length > 500) throw Error("Invalid backup"); const clean = normalizeData(d); if(!confirm("Replace your current progress with this backup? This will also sync to your account."))return; setData({ ...clean, profile: data.profile }); close(); } catch { alert("That backup file is not a valid TypeQuest backup."); } finally { e.target.value = ""; } }; return <div className="modalWrap"><div ref={modalRef} onKeyDown={trap} role="dialog" aria-modal="true" aria-label="Backup and restore" className="modal card"><button aria-label="Close backup dialog" className="close" onClick={close}>×</button><p className="eyebrow">LOCAL BACKUP</p><h2>Keep your progress safe</h2><p className="muted">Export a JSON copy to your device. Importing replaces your progress and also syncs it when you are signed in.</p><button className="primary full" onClick={download}>Download backup</button><button className="ghost full" onClick={() => fileRef.current.click()}>Import backup</button><input ref={fileRef} hidden type="file" accept=".json" onChange={importFile}/></div></div>; }

export default function App() { return <AppErrorBoundary><TypeQuestApp /></AppErrorBoundary>; }

function Recovery({onDone}) {
 const [password,setPassword]=useState(''),[confirmPassword,setConfirmPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <div className="login"><form className="loginCard" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const {error}=await supabase.auth.updateUser({password});if(error)throw error;onDone();}catch(e){setError(e.message);}finally{setBusy(false);}}}><h1>Choose a new password</h1><label>New password<input type="password" value={password} autoComplete="new-password" minLength={8} required onChange={e=>setPassword(e.target.value)}/></label><label>Confirm password<input type="password" value={confirmPassword} autoComplete="new-password" required onChange={e=>setConfirmPassword(e.target.value)}/></label><p className="errorText" role="alert">{error}</p><button className="primary full" disabled={busy || password.length<8 || password!==confirmPassword}>{busy?'Updating…':'Update password'}</button></form></div>;
}

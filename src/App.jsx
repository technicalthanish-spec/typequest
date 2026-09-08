import React, { useEffect, useRef, useState } from "react";
import { Analytics } from "@vercel/analytics/react";
import { dbGet, dbSet, dbClear } from "./lib/db";
import { LEVELS } from "./data/levels";
import { supabase, isCloudConfigured } from "./lib/supabase";

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

function calcMetrics(text, typed, seconds) {
  let correct = 0, errors = 0;
  for (let i = 0; i < typed.length; i++) typed[i] === text[i] ? correct++ : errors++;
  const minutes = Math.max(seconds / 60, 1 / 60);
  const wpm = Math.round((correct / 5) / minutes);
  const accuracy = typed.length ? Math.round((correct / typed.length) * 1000) / 10 : 0;
  return { correct, errors, wpm, accuracy };
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

function computeWeakKeys(stats, limit = 3) {
  const rows = Object.entries(stats || {}).map(([key, v]) => {
    const attempts = Number(v.attempts || 0), errors = Number(v.errors || 0);
    return { key, attempts, errors, rate: attempts ? errors / attempts : 0 };
  }).filter(x => x.errors > 0);
  const strong = rows.filter(x => x.attempts >= 8).sort((a,b) => b.rate - a.rate || b.errors - a.errors);
  const source = strong.length >= limit ? strong : rows.sort((a,b) => b.rate - a.rate || b.errors - a.errors);
  return source.slice(0, limit).map(x => x.key);
}

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

  const queueCloudSave = (nextState, userId) => {
    if (!userId) return;
    const generation = cloudGenerationRef.current;
    cloudSavePendingRef.current = { state: normalizeData(nextState), userId, generation };
    if (cloudSaveRunningRef.current) return cloudSavePromiseRef.current;
    cloudSaveRunningRef.current = true;
    cloudSavePromiseRef.current = (async () => {
      try {
        while (cloudSavePendingRef.current) {
          const snapshot = cloudSavePendingRef.current;
          cloudSavePendingRef.current = null;
          if (snapshot.generation !== cloudGenerationRef.current) continue;
          await saveCloudData(snapshot.state, snapshot.userId, cloudRevisionRef);
        }
      } catch (e) {
        setCloudError(e?.message || "Cloud sync failed.");
      } finally {
        cloudSaveRunningRef.current = false;
        cloudSavePromiseRef.current = null;
      }
    })();
    return cloudSavePromiseRef.current;
  };

  useEffect(() => {
    let active = true;
    loadData().then(async local => {
      if (!active) return;
      if (isCloudConfigured) {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            setCloudUser(user);
            const cloud = await loadCloudData();
            if (cloud) {
              cloudRevisionRef.current = cloud.revision;
              local = cloud.state;
            } else if (local.profile?.email && local.profile.email.toLowerCase() !== (user.email || "").toLowerCase()) {
              // Never copy another account's cached progress into a new account.
              local = normalizeData(null);
            } else if (local.profile) {
              await saveCloudData(local, user.id, cloudRevisionRef);
            }
          }
        } catch (e) { if (active) setCloudError(e?.message || "Cloud sync is unavailable."); }
      }
      if (active) { cloudHydratedRef.current = true; setData(local); setBoot(false); }
    }).catch(e => { if (active) { setStorageError(e?.message || "TypeQuest could not access local storage."); setBoot(false); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!isCloudConfigured) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        cloudSavePendingRef.current = null;
        cloudHydratedRef.current = false;
        return;
      }
      if ((event === "SIGNED_IN" || event === "USER_UPDATED") && session?.user) {
        setCloudUser(session.user);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!data || storageError || suppressPersistenceRef.current) return;
    saveLocalData(data).catch(e => setStorageError(e?.message || "TypeQuest could not save your progress."));
  }, [data]);

  useEffect(() => {
    if (!data || !cloudUser || storageError || suppressPersistenceRef.current || !cloudHydratedRef.current) return;
    const t = setTimeout(() => queueCloudSave(data, cloudUser.id), 600);
    return () => clearTimeout(t);
  }, [data, cloudUser, storageError]);

  const handleCloudAuth = async ({ mode, email, password, name }) => {
    if (!isCloudConfigured) throw new Error("Cloud login is not configured yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.");
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
      setCloudUser(user);
      const cloud = await loadCloudData();
      if (cloud) cloudRevisionRef.current = cloud.revision;
      else cloudRevisionRef.current = 0;
      cloudHydratedRef.current = true;
      const localBase = normalizeData(data);
      const sameAccount = localBase.profile?.email && localBase.profile.email.toLowerCase() === email.toLowerCase();
      // Cloud accounts never inherit an unrelated anonymous/local profile automatically.
      // A same-email local profile may be reused; otherwise start a clean cloud profile.
      const base = sameAccount ? localBase : normalizeData(null);
      const next = cloud?.state || { ...base, profile: { name: name || user?.user_metadata?.name || email.split("@")[0], email, createdAt: base.profile?.createdAt || new Date().toISOString() } };
      if (!next.profile?.email) next.profile = { ...(next.profile || {}), email };
      setData(next);
      await saveLocalData(next);
    } catch (e) { setCloudError(e?.message || "Authentication failed."); throw e; }
    finally { setCloudBusy(false); }
  };

  const handleLogout = async () => {
    setCloudBusy(true);
    suppressPersistenceRef.current = true;
    cloudGenerationRef.current += 1;
    cloudSavePendingRef.current = null;
    if (cloudSavePromiseRef.current) await cloudSavePromiseRef.current;
    try {
      if (isCloudConfigured) await supabase.auth.signOut();
      await dbClear();
    } catch (e) {
      setCloudError(e?.message || "Could not log out cleanly.");
    } finally {
      setCloudUser(null);
      cloudHydratedRef.current = false;
      setData(normalizeData(null));
      setView("dashboard");
      suppressPersistenceRef.current = false;
      setCloudBusy(false);
    }
  };

  if (boot) return <div className="boot">Loading your local TypeQuest…</div>;
  if (storageError) return <StorageError message={storageError} />;
  if (!data) return null;
  if (!data.profile) return <Login configured={isCloudConfigured} busy={cloudBusy} error={cloudError} onCloudAuth={handleCloudAuth} onLocalLogin={name => setData({ ...data, profile: { name, createdAt: new Date().toISOString() }, firstGuideSeen: false })} />;

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

  const addKeyStats = (delta) => {
    if (!delta || !Object.keys(delta).length) return;
    setData(prev => {
      const merged = { ...(prev.keyStats || {}) };
      Object.entries(delta).forEach(([key, v]) => {
        const old = merged[key] || { attempts: 0, errors: 0 };
        merged[key] = { attempts: old.attempts + v.attempts, errors: old.errors + v.errors };
      });
      return { ...prev, keyStats: merged };
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
      await dbClear();
      setCloudError("");
      const resetProfile = cloudUser ? { name: cloudUser.user_metadata?.name || cloudUser.email?.split("@")[0] || "Player", email: cloudUser.email || undefined, createdAt: new Date().toISOString() } : null;
      const resetState = normalizeData({ profile: resetProfile, firstGuideSeen: false });
      cloudSavePendingRef.current = null;
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

  return <div className={data.settings.theme === "light" ? "app light" : "app"}>
    <header className="topbar"><div className="brand" onClick={() => setView("dashboard")}><span className="logo">⌨</span><div><b>TypeQuest</b><small>adaptive typing coach {cloudUser ? "• cloud synced" : "• local"}</small></div></div><div className="topstats"><span>⭐ {data.totalStars}</span><span>⚡ {data.xp} XP</span><span>🔥 {data.streak}</span><button className="ghost" onClick={() => setData({ ...data, settings: { ...data.settings, theme: data.settings.theme === "dark" ? "light" : "dark" } })}>☼</button></div></header>
    <main className="shell"><aside className="sidebar"><button className={view === "dashboard" ? "nav active" : "nav"} onClick={() => setView("dashboard")}>⌂ Dashboard</button><button className={view === "map" ? "nav active" : "nav"} onClick={() => setView("map")}>◈ Level Map</button><button className={view === "history" ? "nav active" : "nav"} onClick={() => setView("history")}>◷ History</button><button className={view === "stats" ? "nav active" : "nav"} onClick={() => setView("stats")}>▣ Progress</button><div className="sidebottom"><button className="nav" onClick={() => setShowBackup(true)}>⇅ Backup</button><button className={view === "guide" ? "nav active" : "nav"} onClick={() => setView("guide")}>⌨ Finger Guide</button>{cloudUser ? <button className="nav" onClick={handleLogout} disabled={cloudBusy}>⇤ Log out</button> : <button className="nav" onClick={() => setData({ ...data, profile: null })}>⇤ Change Name</button>}<button className="nav danger" onClick={resetAll}>⌫ Reset Data</button></div></aside>
      <section className="content">
        {view === "dashboard" && <Dashboard data={data} level={LEVELS[Math.min(data.currentLevel, 50) - 1]} onStart={startLevel} onMap={() => setView("map")} onStats={() => setView("stats")} onHistory={() => setView("history")} onGuide={() => setView("guide")} />}
        {view === "map" && <LevelMap data={data} onStart={startLevel} />}
        {view === "learn" && <Learn level={level} onStart={() => setView("warmup")} />}
        {view === "warmup" && <TypingStage key={`warmup-${selected}`} level={level} stage="warmup" text={level.warmup} exactCase={level.id >= 11} onDone={(delta) => { addKeyStats(delta); setView("practice"); }} onSkip={(delta) => { addKeyStats(delta); setView("practice"); }} />}
        {view === "practice" && <TypingStage key={`practice-${selected}`} level={level} stage="practice" text={level.practice} exactCase={level.id >= 11} onDone={(delta) => { addKeyStats(delta); setView("challenge"); }} onSkip={(delta) => { addKeyStats(delta); setView("challenge"); }} />}
        {view === "challenge" && <TypingStage key={`challenge-${selected}`} level={level} stage="challenge" text={level.challenge} exactCase={level.id >= 11} graded onDone={(delta, metrics, seconds) => { addKeyStats(delta); finishLevel({ ...metrics, seconds, xp: level.xp, stars: starsFor(metrics, level) }); }} onSkip={(delta, metrics, seconds) => { addKeyStats(delta); finishLevel({ ...metrics, seconds, xp: 0, stars: 0, skipped: true }); }} />}
        {view === "results" && <Results level={level} data={data} onNext={() => selected < 50 && data.currentLevel > selected ? startLevel(selected + 1) : setView("map")} onReplay={() => setView("challenge")} onMap={() => setView("map")} />}
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
      {mode === "signup" && <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Your name" maxLength={24}/>}
      <input autoFocus={mode === "login"} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" autoComplete="email"/>
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (6+ characters)" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={6}/>{error && <p className="errorText">{error}</p>}{message && <p className="successText">{message}</p>}
      <button className="primary full" disabled={busy || !email || password.length < 6}>{busy ? "Please wait…" : mode === "login" ? "Log in →" : "Create account →"}</button>
      <button type="button" className="textbtn full" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setMessage(""); }}>{mode === "login" ? "New here? Create an account" : "Already have an account? Log in"}</button>
    </form> : <><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Enter your name" maxLength={24}/><button className="primary full" disabled={!name.trim()} onClick={() => onLocalLogin(name.trim())}>Start local profile →</button></>}
  </div></div>;
}
function Dashboard({ data, level, onStart, onMap, onStats, onHistory, onGuide }) {
  const day = todayKey();
  const mins = Math.floor(data.dailyMinutes?.[day] || 0);
  const daily = Math.min(10, mins);
  const comp = Object.keys(data.completed).length;
  const current = Math.min(data.currentLevel, 50);
  const journeyPct = Math.round((comp / 50) * 100);
  const weak = computeWeakKeys(data.keyStats);
  const recent = data.attempts?.[0];
  const keys = ["Q","W","E","R","T","Y","U","I","O","P","A","S","D","F","G","H","J","K","L",";"];

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
          <button className="ghost coachBtn" onClick={onStats}>Open targeted drill <span>→</span></button>
        </> : <>
          <h2>Your coach is ready.</h2>
          <p className="muted">Complete your first challenge and TypeQuest will start identifying the keys that slow you down.</p>
          <button className="ghost coachBtn" onClick={() => onStart(level.id)}>Start collecting data <span>→</span></button>
        </>}
      </div>

      <div className="card missionCard">
        <div className="cardLabel"><span className="labelIcon">◷</span><span>TODAY</span></div>
        <div className="missionMain">
          <div className="missionRing"><b>{daily}</b><small>/ 10 min</small></div>
          <div><h2>Keep the streak alive.</h2><p className="muted">{mins >= 10 ? "Today's practice goal is complete." : `${10 - daily} minutes of focused typing left today.`}</p></div>
        </div>
        <div className="miniBar"><i style={{width: `${daily * 10}%`}}/></div>
      </div>
    </div>

    <div className="dashboardGrid lowerGrid">
      <div className="card performanceCard">
        <div className="cardLabel"><span className="labelIcon">↗</span><span>PERFORMANCE</span></div>
        <div className="performanceStats">
          <div><small>BEST SPEED</small><strong>{data.bestWpm || "—"}<em> WPM</em></strong></div>
          <div><small>BEST ACCURACY</small><strong>{data.bestAccuracy ? data.bestAccuracy : "—"}<em>{data.bestAccuracy ? "%" : ""}</em></strong></div>
          <div><small>STREAK</small><strong>{data.streak || 0}<em> days</em></strong></div>
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

function Learn({ level, onStart }) { return <div className="learn"><StageIndicator current="Learn"/><div className="pageTitle"><p className="eyebrow">{level.tier.toUpperCase()} • LEVEL {level.id}</p><h1>{level.title}</h1><p className="muted">{level.objective}</p></div><div className="learnGrid"><div className="card"><span className="lessonIcon">1</span><h3>Learn</h3><p>{level.objective}</p><small>Focus: <b>{level.warmup}</b></small></div><div className="card"><span className="lessonIcon">2</span><h3>Warm-up</h3><p className="practiceText">You will type the warm-up next. Slow and accurate first.</p><small>Short drill • mistakes are tracked</small></div><div className="card"><span className="lessonIcon">3</span><h3>Practice</h3><p className="practiceText">Then build rhythm with a longer practice passage.</p><small>Target: {level.targetWpm} WPM • {level.minAccuracy}% accuracy</small></div></div><div className="challengePreview card"><div><p className="eyebrow">NEXT: WARM-UP</p><h2>Ready to train?</h2><p className="muted">The timer starts on your first key.</p></div><button className="primary" onClick={onStart}>Start warm-up →</button></div></div>; }

function TypingStage({ level, stage, text, graded = false, exactCase = false, onDone, onSkip }) {
  const [typed, setTyped] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const inputRef = useRef(null);
  const startedAtRef = useRef(null);
  const deltaRef = useRef({});
  const keystrokesRef = useRef(0);
  const correctKeystrokesRef = useRef(0);
  const cumulativeErrorsRef = useRef(0);
  const finishTimerRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => { if (finishTimerRef.current) clearTimeout(finishTimerRef.current); };
  }, []);

  useEffect(() => {
    if (!started || finished) return;
    const tick = () => {
      const elapsed = Math.max(0, (Date.now() - startedAtRef.current) / 1000);
      setSeconds(elapsed);
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [started, finished]);

  const metrics = calcMetrics(text, typed, seconds);
  const stageTitle = stage === "warmup" ? "Warm-up" : stage === "practice" ? "Practice" : "Challenge";

  const makeMetrics = (value, elapsed) => {
    const base = calcMetrics(text, value, elapsed);
    if (keystrokesRef.current > 0) {
      base.accuracy = Math.round((correctKeystrokesRef.current / keystrokesRef.current) * 1000) / 10;
      base.errors = cumulativeErrorsRef.current;
    } else {
      base.accuracy = 0;
      base.errors = 0;
    }
    return base;
  };

  const finish = (skip = false, finalTyped = typed) => {
    if (finished) return;
    setFinished(true);
    const elapsed = startedAtRef.current ? Math.max(0, (Date.now() - startedAtRef.current) / 1000) : 0;
    const finalSeconds = Math.max(seconds, elapsed);
    const finalMetrics = makeMetrics(finalTyped, finalSeconds);
    if (skip) { onSkip?.(deltaRef.current, finalMetrics, finalSeconds); return; }
    onDone?.(deltaRef.current, finalMetrics, finalSeconds);
  };

  const onChange = e => {
    if (finished) return;
    const raw = e.target.value;
    // Keep the exercise linear: edits are allowed, but the caret is always forced to the end.
    // Backspace/Delete lets learners recover from mistakes without moving the target cursor.
    if (raw.length > typed.length && !raw.startsWith(typed)) return;
    const value = raw.slice(0, text.length);
    if (!started && value.length) {
      startedAtRef.current = Date.now();
      setStarted(true);
    }
    if (value.length > typed.length) {
      for (let index = typed.length; index < value.length; index++) {
        const expected = text[index];
        const id = expected?.toLowerCase();
        if (!id) continue;
        const old = deltaRef.current[id] || { attempts: 0, errors: 0 };
        const sameLetter = expected && value[index] && (exactCase ? expected === value[index] : expected.toLowerCase() === value[index].toLowerCase());
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
      if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
      // Let React commit the final character before calculating the result.
      finishTimerRef.current = setTimeout(() => finish(false, value), 0);
    }
  };

  const targetText = text.split("");
  return <div className="practice">
    <StageIndicator current={stageTitle}/>
    <div className="practiceTop">
      <div><p className="eyebrow">LEVEL {level.id} • {level.tier}</p><h1>{stageTitle}</h1><p className="muted">{stage === "warmup" ? "Find accuracy and finger control." : stage === "practice" ? "Build rhythm before the graded challenge." : "Type the exact passage to clear the level."}</p></div>
      <div className="liveStats"><b>{formatTime(seconds)}</b><span>{metrics.wpm} WPM</span><span>{metrics.accuracy}% ACC</span><span>{metrics.errors} ERR</span></div>
    </div>
    <div className="card typingCard">
      <div className="target">{targetText.map((ch, i) => <span key={i} className={i < typed.length ? (typed[i] === ch ? "correct" : "wrong") : (i === typed.length ? "cursor" : "")}>{ch === " " ? " " : ch}</span>)}</div>
      <textarea ref={inputRef} value={typed} onChange={onChange} onKeyDown={e => { if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key)) e.preventDefault(); }} onFocus={e => { e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length); }} onPaste={e => e.preventDefault()} onDrop={e => e.preventDefault()} onDragOver={e => e.preventDefault()} spellCheck="false" autoCapitalize="off" autoCorrect="off" placeholder="Start typing here…" disabled={finished}/>
      <div className="row between hint"><small>{graded ? `Target ${level.targetWpm} WPM • minimum ${level.minAccuracy}% accuracy` : "Mistakes are tracked to personalize your future drills."}</small><small>{typed.length}/{text.length}</small></div>
      <div className="stageActions"><button className="ghost" onClick={() => finish(true)}>Skip {graded ? "challenge" : stageTitle.toLowerCase()} →</button>{Object.keys(deltaRef.current).length > 0 && <small>{Object.keys(deltaRef.current).length} key{Object.keys(deltaRef.current).length === 1 ? "" : "s"} tracked</small>}</div>
    </div>
  </div>;
}

function Results({ level, data, onNext, onReplay, onMap }) { const a = data.attempts[0] || {}, pass = a.stars > 0; const improvement = a.wpm - (a.previousBestWpm || 0); const accuracyImprovement = a.accuracy - (a.previousBestAccuracy || 0); return <div className="result"><div className="resultBadge">{pass ? "✓" : "↺"}</div><StageIndicator current="Results"/><p className="eyebrow">{pass ? "LEVEL CLEARED" : "KEEP PRACTICING"}</p><h1>{pass ? `Level ${level.id} complete.` : "Almost there."}</h1><p className="muted">{pass ? `You earned ${a.xp} XP and ${a.stars} star${a.stars === 1 ? "" : "s"}.` : `${a.skipped ? "Challenge skipped." : `You need at least ${level.minAccuracy}% accuracy to clear this level.`} No XP is awarded for a failed attempt.`}</p><div className="resultGrid"><Metric label="WPM" value={a.wpm} icon="⚡"/><Metric label="Accuracy" value={`${a.accuracy}%`} icon="◎"/><Metric label="Errors" value={a.errors} icon="×"/><Metric label="Stars" value={a.stars} icon="★"/></div><div className={`improvement ${improvement > 0 || accuracyImprovement > 0 ? "up" : improvement < 0 || accuracyImprovement < 0 ? "down" : "flat"}`}><b>{improvement > 0 ? `↑ ${improvement} WPM improvement` : improvement < 0 ? `↓ ${Math.abs(improvement)} WPM from previous best` : a.previousBestWpm ? "→ Matched your previous WPM best" : "First recorded attempt"}</b><small>{a.previousBestWpm ? `Previous: ${a.previousBestWpm} WPM • ${a.previousBestAccuracy || 0}% accuracy` : "Your next attempt will have a baseline."}</small>{a.previousBestAccuracy !== undefined && <small>{accuracyImprovement > 0 ? `↑ ${accuracyImprovement.toFixed(1)}% accuracy improvement` : accuracyImprovement < 0 ? `↓ ${Math.abs(accuracyImprovement).toFixed(1)}% accuracy` : "→ Accuracy matched previous best"}</small>}</div><div className="resultActions"><button className="ghost bigBtn" onClick={onReplay}>Try again</button><button className="primary bigBtn" onClick={onNext}>{pass && level.id < 50 ? "Next level →" : "Back to map →"}</button></div></div>; }

function History({ data }) { return <div><div className="pageTitle"><p className="eyebrow">PRACTICE LOG</p><h1>Your history</h1></div><div className="card tableCard">{data.attempts.length ? <table><thead><tr><th>Level</th><th>WPM</th><th>Accuracy</th><th>Errors</th><th>Stars</th><th>Date</th></tr></thead><tbody>{data.attempts.slice(0, 40).map(a => <tr key={a.id}><td>#{a.level}</td><td>{a.wpm}</td><td>{a.accuracy}%</td><td>{a.errors}</td><td>{"★".repeat(a.stars)}</td><td>{new Date(a.date).toLocaleString()}</td></tr>)}</tbody></table> : <Empty text="Complete your first challenge to see history here."/>}</div></div>; }

function Stats({ data, onDrill }) { const weak = computeWeakKeys(data.keyStats); const achievements = [["perfect", "3-star clear"], ["ten_levels", "10 levels cleared"], ["halfway", "25 levels cleared"], ["master", "Level 50 mastery"]]; const keyRows = Object.entries(data.keyStats || {}).map(([key, v]) => ({ key, ...v, rate: v.attempts ? v.errors / v.attempts : 0 })).sort((a,b) => b.rate - a.rate || b.errors - a.errors); const keys = ["q","w","e","r","t","y","u","i","o","p","a","s","d","f","g","h","j","k","l",";","z","x","c","v","b","n","m",",",".","/"]; return <div><div className="pageTitle"><p className="eyebrow">PROGRESS</p><h1>Performance lab</h1><p className="muted">Your mistakes become the training plan.</p></div><div className="grid two"><div className="card"><h2>Milestones</h2>{achievements.map(([k,t]) => <div className={`achievement ${data.achievements.includes(k) ? "earned" : ""}`} key={k}><span>{data.achievements.includes(k) ? "✓" : "○"}</span>{t}</div>)}</div><div className="card"><h2>Personal records</h2><div className="record"><small>Fastest WPM</small><b>{data.bestWpm || "—"}</b></div><div className="record"><small>Best accuracy</small><b>{data.bestAccuracy ? data.bestAccuracy + "%" : "—"}</b></div><div className="record"><small>Total XP</small><b>{data.xp}</b></div><div className="record"><small>Total stars</small><b>{data.totalStars}/150</b></div></div></div><div className="card heatmapCard"><div className="sectionHead"><div><p className="eyebrow">ADAPTIVE HEATMAP</p><h2>Keyboard difficulty</h2></div>{weak.length > 0 && <button className="primary" onClick={onDrill}>Practice weak keys →</button>}</div><p className="muted">Teal = accurate • red = error-prone. Upper/lowercase are merged by physical key.</p><div className="heatKeyboard">{keys.map(key => { const s = data.keyStats?.[key] || { attempts: 0, errors: 0 }; const rate = s.attempts ? s.errors / s.attempts : 0; return <div key={key} className="heatKey" style={{ "--heat": rate, "--used": s.attempts ? 1 : 0 }} title={`${key.toUpperCase()}: ${s.errors || 0} errors / ${s.attempts || 0} attempts`}><b>{key.toUpperCase()}</b><small>{s.attempts ? Math.round(rate * 100) : "—"}%</small></div>; })}</div><div className="weakList"><b>Weak keys</b>{weak.length ? weak.map(k => <span className="weakChip" key={k}>{k.toUpperCase()}</span>) : <small>No weak-key data yet. Complete a typing stage to train the coach.</small>}</div>{keyRows.length > 0 && <div className="weakTable"><h3>Most error-prone</h3>{keyRows.slice(0, 5).map(r => <div className="record" key={r.key}><span><b>{r.key.toUpperCase()}</b> · {r.attempts} attempts</span><b>{Math.round(r.rate * 100)}% errors</b></div>)}</div>}</div></div>; }

function WeakDrill({ data, onBack, onDone }) { const textRef = useRef(buildDrillText(data.keyStats)); const weakRef = useRef(computeWeakKeys(data.keyStats)); const text = textRef.current; const weak = weakRef.current; return <div><StageIndicator current="Practice"/><div className="pageTitle"><p className="eyebrow">PERSONALIZED TRAINING</p><h1>Practice your weak keys.</h1><p className="muted">This drill is generated from your saved mistake history. The target is frozen for this session so it cannot reset while you type.</p></div><div className="card adaptiveBanner"><div><b>Target keys</b><div className="weakList">{weak.map(k => <span className="weakChip" key={k}>{k.toUpperCase()}</span>)}</div></div></div><TypingStage key="weak-drill" level={LEVELS[0]} stage="practice" text={text} onDone={(delta) => { onDone(delta); onBack(); }} onSkip={(delta) => { onDone(delta); onBack(); }}/><button className="textbtn" onClick={onBack}>← Back to analytics</button></div>; }

function FingerGuide({ onStart }) { const left = [["A","LITTLE"],["S","RING"],["D","MIDDLE"],["F","INDEX"]], right = [["J","INDEX"],["K","MIDDLE"],["L","RING"],[";","LITTLE"]]; return <div className="fingerGuide"><div className="pageTitle"><p className="eyebrow">FINGER GUIDE • QUICK REFERENCE</p><h1>Start with the<br/><span>right hand position.</span></h1><p className="muted">Use this quick reference anytime to check finger placement before practice.</p></div><div className="card handCard"><div className="keyboardMini"><div className="keyRow">{["Q","W","E","R","T","Y","U","I","O","P"].map(k => <span key={k}>{k}</span>)}</div><div className="keyRow homeKeys">{["A","S","D","F","G","H","J","K","L",";"].map(k => <span key={k}>{k}</span>)}</div><div className="keyRow">{["Z","X","C","V","B","N","M",",",".","/"].map(k => <span key={k}>{k}</span>)}</div></div><div className="placementGrid"><Placement title="Left hand" keys={left}/><Placement title="Right hand" keys={right}/></div><div className="guideRules"><div><b>F & J are anchors</b><small>Keep your index fingers on the raised bumps.</small></div><div><b>Thumbs → Space</b><small>Use either thumb comfortably.</small></div><div><b>Eyes on the text</b><small>Try not to look down at the keyboard.</small></div></div></div><div className="challengePreview card"><div><p className="eyebrow">QUICK REFERENCE</p><h2>Ready to practice?</h2><p className="muted">Return to your dashboard and start a level whenever you are ready.</p></div><button className="primary" onClick={onStart}>Back to dashboard →</button></div></div>; }
function Placement({ title, keys }) { return <div className="placementCol"><h3>{title}</h3>{keys.map(([key,finger]) => <div className="fingerRow" key={key}><b>{key}</b><span>{finger} finger</span></div>)}</div>; }
function Empty({ text }) { return <div className="empty">{text}</div>; }
function Backup({ data, setData, close }) { const fileRef = useRef(); const download = () => { const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `typequest-backup-${todayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }; const importFile = async e => { const f = e.target.files?.[0]; if (!f) return; try { if (f.size > 2 * 1024 * 1024) throw Error("Backup is too large"); const d = JSON.parse(await f.text()); if (!d || typeof d !== "object" || Array.isArray(d) || !d.profile || typeof d.profile !== "object" || Array.isArray(d.profile) || !Array.isArray(d.attempts) || d.attempts.length > 500) throw Error("Invalid backup"); const clean = normalizeData(d); setData(clean); close(); } catch { alert("That backup file is not a valid TypeQuest backup."); } finally { e.target.value = ""; } }; return <div className="modalWrap"><div className="modal card"><button className="close" onClick={close}>×</button><p className="eyebrow">LOCAL BACKUP</p><h2>Keep your progress safe</h2><p className="muted">Export a JSON copy. It never goes to the cloud.</p><button className="primary full" onClick={download}>Download backup</button><button className="ghost full" onClick={() => fileRef.current.click()}>Import backup</button><input ref={fileRef} hidden type="file" accept=".json" onChange={importFile}/></div></div>; }

export default function App() { return <><AppErrorBoundary><TypeQuestApp /></AppErrorBoundary><Analytics /></>; }

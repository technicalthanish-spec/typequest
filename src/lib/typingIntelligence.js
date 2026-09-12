/**
 * TypeQuest Typing Intelligence Engine
 * ------------------------------------
 * A dependency-free, local-only analysis engine that turns raw keystroke
 * telemetry into per-key insight, rhythm/consistency scoring, error-pattern
 * detection, a "typing fingerprint", and adaptive practice recommendations.
 *
 * Nothing in this file makes network requests or calls any external/AI API.
 * All "intelligence" is derived purely from statistical analysis of the
 * keystroke timings and correctness the caller provides.
 *
 * Designed to be dropped into a React/Vite project as a plain ES module.
 *
 * Main entry points:
 *   - analyzeTypingSession(keystrokes, sessionStats, previousSessions)
 *   - generateAdaptiveDrill(analysis, options)
 *
 * See the EXPORTS list at the bottom of the accompanying README/response
 * for a short description of every exported function.
 */

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

// A key/pair needs at least this many observations before we're willing to
// call it "weak", "slow", etc. Prevents one accidental typo from labelling
// a key as a permanent weakness.
const MIN_SAMPLES_KEY = 3;
const MIN_SAMPLES_PAIR = 3;

// Inter-keystroke gaps longer than this are treated as "the user paused/left
// the tab/was thinking" rather than genuine typing latency, and are excluded
// from timing statistics (rhythm, averages, transitions).
const MAX_VALID_DELAY_MS = 3000;

// Minimum number of valid delay samples required before we trust a
// consistency/rhythm calculation. Below this we return a neutral score
// rather than a confident-looking but statistically meaningless one.
const MIN_RHYTHM_SAMPLES = 5;

// Neutral fallback score used whenever there isn't enough data to make a
// real judgement. Deliberately the midpoint (not 0, not 100) so it never
// reads as "great" or "terrible" when we simply don't know yet.
const NEUTRAL_SCORE = 50;

const WEAK_KEY_ACCURACY_THRESHOLD = 80;
const STRONG_KEY_ACCURACY_THRESHOLD = 95;
const STRONG_KEY_SCORE_THRESHOLD = 85;
const WEAK_KEY_SCORE_THRESHOLD = 60;
const SLOW_KEY_SPEED_SCORE_THRESHOLD = 60;

const SLOW_TRANSITION_MIN_SLOWDOWN_PCT = 15;

// Recency decay applied when averaging previous sessions: the most recent
// session gets weight 1, and each session further back is discounted.
const HISTORY_DECAY = 0.7;
const MIN_HISTORY_SESSIONS = 1;
const KEY_CHANGE_THRESHOLD = 5; // points, for improving/declining key detection

// ---------------------------------------------------------------------------
// Small numeric safety helpers (never let NaN/Infinity leak out)
// ---------------------------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  if (!isFiniteNumber(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function safeRound(value, decimals = 0) {
  if (!isFiniteNumber(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function safeDiv(numerator, denominator, fallback = 0) {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator) || denominator === 0) {
    return fallback;
  }
  const result = numerator / denominator;
  return isFiniteNumber(result) ? result : fallback;
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + (isFiniteNumber(v) ? v : 0), 0);
  return safeDiv(sum, values.length);
}

// Sample standard deviation (n-1). Returns 0 when fewer than 2 samples.
function stdDev(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const m = mean(values);
  const sumSq = values.reduce((acc, v) => {
    const d = (isFiniteNumber(v) ? v : 0) - m;
    return acc + d * d;
  }, 0);
  return Math.sqrt(safeDiv(sumSq, values.length - 1));
}

// Normalizes a "key" for grouping purposes: trims to a single logical
// value and guards against undefined/non-string input.
function normalizeKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  return key;
}

// ---------------------------------------------------------------------------
// 1. Keystroke normalization
// ---------------------------------------------------------------------------

/**
 * Filters and sanitizes a raw keystroke event array so the rest of the
 * engine can assume well-formed data. Never throws, regardless of how
 * malformed the input is.
 */
export function normalizeKeystrokes(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];

  const cleaned = [];
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== 'object') continue;

    const isBackspace = raw.isBackspace === true;
    const timestamp = isFiniteNumber(raw.timestamp) ? raw.timestamp : null;
    const expectedKey = normalizeKey(raw.expectedKey);
    const key = normalizeKey(raw.key);

    // A usable event either represents a backspace, or a typed character
    // with a known expected key. Anything else can't be analyzed safely.
    if (!isBackspace && !expectedKey) continue;
    if (timestamp === null) continue;

    cleaned.push({
      key: key,
      expectedKey: expectedKey,
      timestamp,
      correct: raw.correct === true,
      position: isFiniteNumber(raw.position) ? raw.position : null,
      isBackspace,
    });
  }

  // Sort defensively by timestamp in case events arrive out of order
  // (e.g. buffered/batched telemetry).
  cleaned.sort((a, b) => a.timestamp - b.timestamp);
  return cleaned;
}

// ---------------------------------------------------------------------------
// 2. Single O(n) pass over keystrokes to gather raw aggregates
// ---------------------------------------------------------------------------

/**
 * Walks the normalized keystroke list exactly once, building the raw
 * (unscored) data structures every other calculation below is derived
 * from. Keeping this as a single pass keeps the engine close to O(n)
 * even for sessions with thousands of keystrokes.
 */
function collectRawAggregates(keystrokes) {
  const keyStatsRaw = new Map(); // key -> {attempts, correct, errors, delaySum, delayCount}
  const transitionsRaw = new Map(); // "ab" -> {sum, count}
  const errorPatternsRaw = new Map(); // "expected>typed" -> {expected, typed, count}
  const allDelays = []; // valid inter-event delays, for rhythm/baseline
  let backspaces = 0;
  let correctCount = 0;
  let totalTyped = 0;

  let prevEvent = null; // previous non-backspace event (any correctness)
  let prevCorrectEvent = null; // previous correct, non-backspace event (chain for transitions)

  for (const e of keystrokes) {
    if (e.isBackspace) {
      backspaces += 1;
      // A correction breaks the "clean transition" chain, since whatever
      // comes next isn't really following the previous correct keystroke.
      prevCorrectEvent = null;
      prevEvent = e;
      continue;
    }

    if (!e.expectedKey) {
      prevEvent = e;
      continue;
    }

    totalTyped += 1;

    let delay = null;
    if (prevEvent && isFiniteNumber(prevEvent.timestamp) && isFiniteNumber(e.timestamp)) {
      const rawDelay = e.timestamp - prevEvent.timestamp;
      if (rawDelay > 0 && rawDelay <= MAX_VALID_DELAY_MS) {
        delay = rawDelay;
        allDelays.push(delay);
      }
    }

    const key = e.expectedKey;
    if (!keyStatsRaw.has(key)) {
      keyStatsRaw.set(key, { attempts: 0, correct: 0, errors: 0, delaySum: 0, delayCount: 0 });
    }
    const ks = keyStatsRaw.get(key);
    ks.attempts += 1;
    if (delay !== null) {
      ks.delaySum += delay;
      ks.delayCount += 1;
    }

    if (e.correct) {
      correctCount += 1;
      ks.correct += 1;

      if (prevCorrectEvent) {
        const transDelay = e.timestamp - prevCorrectEvent.timestamp;
        if (transDelay > 0 && transDelay <= MAX_VALID_DELAY_MS) {
          const pair = `${prevCorrectEvent.expectedKey}${key}`;
          if (!transitionsRaw.has(pair)) transitionsRaw.set(pair, { sum: 0, count: 0 });
          const t = transitionsRaw.get(pair);
          t.sum += transDelay;
          t.count += 1;
        }
      }
      prevCorrectEvent = e;
    } else {
      ks.errors += 1;
      prevCorrectEvent = null; // an error breaks the clean transition chain

      const typed = e.key || '(unknown)';
      const patternKey = `${key}>${typed}`;
      if (!errorPatternsRaw.has(patternKey)) {
        errorPatternsRaw.set(patternKey, { expected: key, typed, count: 0 });
      }
      errorPatternsRaw.get(patternKey).count += 1;
    }

    prevEvent = e;
  }

  return {
    keyStatsRaw,
    transitionsRaw,
    errorPatternsRaw,
    allDelays,
    backspaces,
    correctCount,
    totalTyped,
  };
}

// ---------------------------------------------------------------------------
// 3. Per-key intelligence
// ---------------------------------------------------------------------------

function computeSpeedScore(avgDelay, baselineDelay) {
  if (baselineDelay <= 0 || avgDelay === null) return NEUTRAL_SCORE + 20; // no data -> assume roughly average-fast
  const ratio = safeDiv(avgDelay, baselineDelay, 1);
  // Faster than baseline (ratio < 1) caps at 100. Slower scales down linearly.
  return clamp(100 - (ratio - 1) * 100, 0, 100);
}

/**
 * Builds per-key metrics (attempts, accuracy, average delay, and a
 * composite 0-100 score) from the raw aggregates produced by
 * collectRawAggregates(). Exposed on its own so it can be unit tested and
 * reused independently of the full pipeline.
 */
export function computeKeyStats(keyStatsRaw, baselineDelay) {
  const stats = [];
  for (const [key, raw] of keyStatsRaw.entries()) {
    const accuracy = safeRound(safeDiv(raw.correct, raw.attempts, 0) * 100, 1);
    const averageDelay = raw.delayCount > 0 ? safeRound(safeDiv(raw.delaySum, raw.delayCount, 0)) : null;
    const speedScore = computeSpeedScore(averageDelay, baselineDelay);
    const score = safeRound(clamp(accuracy * 0.6 + speedScore * 0.4, 0, 100));
    const reliable = raw.attempts >= MIN_SAMPLES_KEY;

    stats.push({
      key,
      attempts: raw.attempts,
      correct: raw.correct,
      errors: raw.errors,
      accuracy,
      averageDelay: averageDelay === null ? 0 : averageDelay,
      speedScore: safeRound(speedScore),
      score,
      reliable,
    });
  }
  // Most-attempted keys first, purely for stable/predictable ordering.
  stats.sort((a, b) => b.attempts - a.attempts);
  return stats;
}

/**
 * Splits scored key stats into weak / strong / slow buckets. Keys with
 * too few attempts are excluded from every bucket, per spec (never judge
 * a key from a single accidental attempt).
 */
export function classifyKeys(keyStats) {
  const reliableKeys = keyStats.filter((k) => k.reliable);

  const weakKeys = reliableKeys
    .filter((k) => k.accuracy < WEAK_KEY_ACCURACY_THRESHOLD || k.score < WEAK_KEY_SCORE_THRESHOLD)
    .sort((a, b) => a.score - b.score);

  const strongKeys = reliableKeys
    .filter((k) => k.accuracy >= STRONG_KEY_ACCURACY_THRESHOLD && k.score >= STRONG_KEY_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const slowKeys = reliableKeys
    .filter((k) => k.speedScore <= SLOW_KEY_SPEED_SCORE_THRESHOLD && k.averageDelay > 0)
    .sort((a, b) => b.averageDelay - a.averageDelay);

  return { weakKeys, strongKeys, slowKeys };
}

// ---------------------------------------------------------------------------
// 4. Key transition analysis
// ---------------------------------------------------------------------------

/**
 * Turns raw transition timing sums into a scored list, flagging pairs that
 * are consistently slower than the user's own overall transition average.
 */
export function computeTransitions(transitionsRaw) {
  const entries = [];
  let totalSum = 0;
  let totalCount = 0;

  for (const [pair, raw] of transitionsRaw.entries()) {
    totalSum += raw.sum;
    totalCount += raw.count;
    entries.push({ pair, sum: raw.sum, count: raw.count });
  }

  const baseline = totalCount > 0 ? safeDiv(totalSum, totalCount) : 0;

  const transitions = entries
    .map(({ pair, sum, count }) => {
      const averageDelay = safeRound(safeDiv(sum, count, 0));
      const relativeSlowdown = baseline > 0 ? safeRound(((averageDelay - baseline) / baseline) * 100, 1) : 0;
      let severity = 'low';
      if (relativeSlowdown > 50) severity = 'high';
      else if (relativeSlowdown > 25) severity = 'medium';
      return { pair, averageDelay, attempts: count, relativeSlowdown, severity };
    })
    .sort((a, b) => b.attempts - a.attempts);

  const slowTransitions = transitions
    .filter((t) => t.attempts >= MIN_SAMPLES_PAIR && t.relativeSlowdown > SLOW_TRANSITION_MIN_SLOWDOWN_PCT)
    .sort((a, b) => b.relativeSlowdown - a.relativeSlowdown)
    .slice(0, 10);

  return { transitions: transitions.slice(0, 50), slowTransitions, baseline: safeRound(baseline) };
}

// ---------------------------------------------------------------------------
// 5. Error pattern analysis
// ---------------------------------------------------------------------------

export function computeErrorPatterns(errorPatternsRaw) {
  return Array.from(errorPatternsRaw.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ---------------------------------------------------------------------------
// 6. Rhythm / consistency
// ---------------------------------------------------------------------------

/**
 * Consistency is based on the coefficient of variation (stdDev / mean) of
 * valid inter-keystroke delays, NOT on raw speed. A slow-but-steady typist
 * and a fast-but-steady typist can both score near 100; a typist whose
 * pace swings wildly scores low regardless of their average speed.
 */
export function computeRhythm(allDelays) {
  const sampleSize = allDelays.length;
  const averageDelay = sampleSize > 0 ? safeRound(mean(allDelays)) : 0;

  if (sampleSize < MIN_RHYTHM_SAMPLES) {
    return { averageDelay, consistency: NEUTRAL_SCORE, sampleSize, insufficientData: true };
  }

  const sd = stdDev(allDelays);
  const coefficientOfVariation = safeDiv(sd, mean(allDelays), 0);
  const consistency = safeRound(clamp(100 - coefficientOfVariation * 100, 0, 100));

  return { averageDelay, consistency, sampleSize, insufficientData: false };
}

// ---------------------------------------------------------------------------
// 7. Correction / backspace behaviour
// ---------------------------------------------------------------------------

export function computeCorrections(backspaces, typedLength) {
  const safeLength = isFiniteNumber(typedLength) && typedLength > 0 ? typedLength : 0;
  const backspacesPer100Chars = safeLength > 0 ? safeRound(safeDiv(backspaces, safeLength) * 100, 1) : 0;

  // Gentle penalty: a handful of corrections shouldn't tank the score.
  const correctionScore = safeRound(clamp(100 - backspacesPer100Chars * 4, 0, 100));

  return { backspaces, backspacesPer100Chars, correctionScore };
}

// ---------------------------------------------------------------------------
// 8. Typing fingerprint
// ---------------------------------------------------------------------------

function normalizeAccuracyInput(accuracy) {
  if (!isFiniteNumber(accuracy)) return 0;
  // Accept either a 0-1 fraction or a 0-100 percentage.
  const pct = accuracy <= 1 ? accuracy * 100 : accuracy;
  return clamp(pct, 0, 100);
}

function deriveStyle({ speed, accuracy, consistency, keyControl, recovery }) {
  if (accuracy >= 90 && speed <= 50) return 'Precise and deliberate';
  if (speed >= 75 && accuracy < 80) return 'Fast but accuracy-sensitive';
  if (consistency < 50) return 'Variable rhythm typist';
  if (keyControl >= 85 && recovery >= 85) return 'Sharp and controlled';
  if (speed >= 75 && accuracy >= 90 && consistency >= 75) return 'Fast and confident';
  return 'Balanced typist';
}

/**
 * Combines every dimension into a single 0-100 "fingerprint". Weighted so
 * no single metric (like raw WPM) can dominate the overall score.
 */
export function computeFingerprint(sessionStats, keyStats, rhythm, corrections) {
  const wpm = isFiniteNumber(sessionStats.wpm) ? sessionStats.wpm : 0;
  const speed = safeRound(clamp((wpm / 90) * 100, 0, 100));
  const accuracy = safeRound(normalizeAccuracyInput(sessionStats.accuracy));
  const consistency = safeRound(clamp(rhythm.consistency, 0, 100));

  const reliableKeys = keyStats.filter((k) => k.reliable);
  const keyControl = reliableKeys.length > 0
    ? safeRound(
        safeDiv(
          reliableKeys.reduce((acc, k) => acc + k.score * k.attempts, 0),
          reliableKeys.reduce((acc, k) => acc + k.attempts, 0),
          NEUTRAL_SCORE
        )
      )
    : NEUTRAL_SCORE + 10;

  const recovery = safeRound(clamp(corrections.correctionScore, 0, 100));

  const overall = safeRound(
    clamp(speed * 0.2 + accuracy * 0.3 + consistency * 0.2 + keyControl * 0.15 + recovery * 0.15, 0, 100)
  );

  const style = deriveStyle({ speed, accuracy, consistency, keyControl, recovery });

  return { speed, accuracy, consistency, keyControl, recovery, overall, style };
}

// ---------------------------------------------------------------------------
// 9. Adaptive recommendation engine
// ---------------------------------------------------------------------------

/**
 * Chooses a single next-practice recommendation from the analyzed metrics.
 * Order of checks matters: accuracy problems are addressed before speed
 * or rhythm concerns, since accuracy is foundational.
 */
export function generateRecommendation(fingerprint, weakKeys, slowTransitions, rhythm) {
  if (fingerprint.accuracy < 85) {
    return {
      type: 'ACCURACY_DRILL',
      priority: fingerprint.accuracy < 70 ? 'high' : 'medium',
      focusKeys: weakKeys.slice(0, 5).map((k) => k.key),
      focusPairs: [],
      reason: 'Your accuracy is lower than it needs to be — slowing down slightly and focusing on correctness will pay off more than speed right now.',
      targetDuration: 90,
    };
  }

  if (weakKeys.length > 0) {
    const focusKeys = weakKeys.slice(0, 5).map((k) => k.key);
    return {
      type: 'WEAK_KEY_DRILL',
      priority: weakKeys.length >= 3 ? 'high' : 'medium',
      focusKeys,
      focusPairs: [],
      reason: `A small set of keys (${focusKeys.join(', ')}) are pulling down your accuracy compared to the rest of your typing.`,
      targetDuration: 90,
    };
  }

  if (slowTransitions.length > 0) {
    const focusPairs = slowTransitions.slice(0, 5).map((t) => t.pair);
    const focusKeys = Array.from(new Set(focusPairs.flatMap((p) => p.split(''))));
    return {
      type: 'TRANSITION_DRILL',
      priority: slowTransitions[0].severity === 'high' ? 'high' : 'medium',
      focusKeys,
      focusPairs,
      reason: `Specific letter combinations (${focusPairs.join(', ')}) are consistently slower than your normal typing rhythm.`,
      targetDuration: 120,
    };
  }

  if (fingerprint.accuracy >= 90 && fingerprint.speed < 60) {
    return {
      type: 'SPEED_DRILL',
      priority: 'medium',
      focusKeys: [],
      focusPairs: [],
      reason: "You're accurate, so it's a good time to push your typing speed with timed drills.",
      targetDuration: 60,
    };
  }

  if (rhythm.consistency < 65) {
    return {
      type: 'RHYTHM_DRILL',
      priority: 'medium',
      focusKeys: [],
      focusPairs: [],
      reason: 'Your pace varies more than usual between keystrokes — steady, metronome-style practice should help smooth it out.',
      targetDuration: 90,
    };
  }

  return {
    type: 'BALANCED_DRILL',
    priority: 'low',
    focusKeys: [],
    focusPairs: [],
    reason: "You're performing well across the board — a balanced session will help maintain and gradually build on your skills.",
    targetDuration: 90,
  };
}

// ---------------------------------------------------------------------------
// 10. Personalized drill generator (local vocabulary, no external AI)
// ---------------------------------------------------------------------------

// A modest bank of common, readable English words spanning a wide range of
// letters and common letter pairs. Used to build practice text that's
// biased toward a learner's weak keys/pairs without ever becoming
// unreadable gibberish like "trtrtrtr".
const WORD_BANK = [
  'the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but',
  'from', 'they', 'say', 'her', 'she', 'will', 'one', 'all', 'would', 'there',
  'their', 'what', 'out', 'about', 'who', 'get', 'which', 'when', 'make', 'can',
  'like', 'time', 'just', 'know', 'take', 'people', 'into', 'year', 'your', 'good',
  'some', 'could', 'them', 'other', 'than', 'then', 'look', 'only', 'come', 'over',
  'think', 'also', 'back', 'after', 'work', 'first', 'well', 'even', 'want', 'because',
  'these', 'give', 'most', 'street', 'train', 'trust', 'truck', 'trip', 'tree', 'trace',
  'trade', 'travel', 'transform', 'strong', 'straight', 'strange', 'stream', 'struggle',
  'bright', 'right', 'fright', 'through', 'thought', 'three', 'throw', 'thumb', 'thick',
  'quick', 'quiet', 'question', 'quality', 'quote', 'brown', 'crown', 'drown', 'grow',
  'green', 'ground', 'group', 'great', 'grand', 'friend', 'front', 'fresh', 'freeze',
  'practice', 'problem', 'process', 'product', 'project', 'protect', 'proud', 'proper',
  'around', 'across', 'against', 'answer', 'appear', 'attack', 'attempt', 'balance',
  'battle', 'beyond', 'bottom', 'branch', 'bridge', 'bright', 'bring', 'broken', 'budget',
  'build', 'castle', 'change', 'charge', 'circle', 'client', 'closer', 'coffee', 'column',
  'combine', 'comfort', 'command', 'company', 'compare', 'complex', 'concept', 'concern',
  'connect', 'consider', 'contact', 'control', 'corner', 'couple', 'course', 'create',
  'credit', 'crisis', 'crowd', 'crystal', 'culture', 'current', 'custom', 'danger',
  'decide', 'deeper', 'defend', 'degree', 'demand', 'depend', 'design', 'desire',
  'detail', 'device', 'differ', 'dinner', 'direct', 'divide', 'doctor', 'double',
  'dragon', 'driver', 'during', 'effort', 'either', 'elect', 'emerge', 'employ',
  'enable', 'energy', 'engine', 'enough', 'ensure', 'entire', 'escape', 'estate',
  'exist', 'expand', 'expect', 'expert', 'expose', 'extend', 'extra', 'factor',
  'family', 'famous', 'father', 'fellow', 'figure', 'finish', 'flight', 'follow',
  'forest', 'forget', 'formal', 'format', 'former', 'fourth', 'garden', 'gather',
  'gentle', 'global', 'golden', 'ground', 'growth', 'handle', 'happen', 'hardly',
  'health', 'height', 'hidden', 'higher', 'honest', 'humble', 'hungry', 'ignore',
  'impact', 'import', 'indeed', 'inform', 'inside', 'insist', 'invite', 'island',
  'itself', 'join', 'judge', 'junior', 'kernel', 'kettle', 'kidney', 'kitten',
  'ladder', 'launch', 'leader', 'legacy', 'length', 'lesson', 'letter', 'listen',
  'little', 'living', 'longer', 'lovely', 'luggage', 'manage', 'manner', 'margin',
  'market', 'master', 'matter', 'method', 'middle', 'minute', 'mirror', 'modern',
  'moment', 'mostly', 'mother', 'motion', 'moving', 'mutual', 'narrow', 'nation',
  'native', 'nature', 'nearby', 'nearly', 'needle', 'nephew', 'normal', 'notice',
  'number', 'object', 'obtain', 'office', 'orange', 'origin', 'output', 'oxygen',
  'packet', 'palace', 'parent', 'partly', 'people', 'period', 'permit', 'person',
  'phrase', 'planet', 'player', 'please', 'plenty', 'pocket', 'poetry', 'police',
  'policy', 'ponder', 'poster', 'potato', 'poverty', 'prayer', 'prefer', 'pretty',
  'prince', 'prison', 'profit', 'proper', 'public', 'pursue', 'puzzle', 'quiver',
  'random', 'rather', 'reader', 'really', 'reason', 'record', 'reduce', 'reform',
  'refuse', 'regard', 'region', 'relate', 'remain', 'remind', 'remove', 'repair',
  'repeat', 'report', 'rescue', 'resist', 'result', 'retail', 'return', 'reveal',
  'reward', 'ribbon', 'rocket', 'rotate', 'rubber', 'safety', 'sample', 'saving',
  'scared', 'scheme', 'school', 'screen', 'search', 'season', 'second', 'secret',
  'sector', 'secure', 'select', 'senior', 'sentence', 'series', 'settle', 'shadow',
  'shape', 'shelter', 'should', 'silent', 'silver', 'simple', 'single', 'sister',
  'slight', 'smooth', 'social', 'solely', 'solid', 'source', 'speech', 'spirit',
  'spread', 'spring', 'square', 'stable', 'staff', 'stage', 'stairs', 'stance',
  'stated', 'statue', 'steady', 'sticky', 'stolen', 'stomach', 'storm', 'strain',
  'strand', 'strict', 'stripe', 'strive', 'studio', 'submit', 'sudden', 'suffer',
  'sugar', 'summer', 'summit', 'supply', 'surely', 'survey', 'switch', 'symbol',
  'system', 'talent', 'target', 'temple', 'tender', 'tennis', 'theory', 'thirty',
  'thread', 'threat', 'thrive', 'ticket', 'timber', 'toward', 'travel', 'treaty',
  'trend', 'triple', 'trophy', 'tunnel', 'twelve', 'unable', 'unique', 'united',
  'unless', 'unlike', 'update', 'upward', 'useful', 'valley', 'vendor', 'versus',
  'victim', 'vision', 'visual', 'volume', 'walnut', 'wealth', 'weapon', 'weekly',
  'weight', 'window', 'winner', 'winter', 'within', 'wonder', 'wooden', 'worker',
  'writer', 'yellow', 'zero',
];

function scoreWordRelevance(word, weakKeySet, weakPairSet) {
  let score = 0;
  const lower = word.toLowerCase();
  for (const ch of lower) {
    if (weakKeySet.has(ch)) score += 1;
  }
  for (const pair of weakPairSet) {
    if (lower.includes(pair)) score += 3;
  }
  return score;
}

// Simple deterministic-ish shuffle helper used only to add variety to the
// filler portion of a drill; not security sensitive.
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generates readable practice text biased toward the learner's weak keys
 * and/or slow transitions, using only a local word bank (no network, no
 * external AI). Falls back to general common words if nothing in the
 * bank matches, so the drill never comes back empty.
 *
 * options.length -> approximate target character length (default 150).
 */
export function generateAdaptiveDrill(analysis, options = {}) {
  const targetLength = clamp(
    isFiniteNumber(options.length) ? options.length : 150,
    20,
    2000
  );

  const rec = (analysis && analysis.recommendation) || {};
  const focusKeys = (rec.focusKeys && rec.focusKeys.length > 0)
    ? rec.focusKeys
    : (analysis && analysis.weakKeys ? analysis.weakKeys.slice(0, 5).map((k) => k.key) : []);
  const focusPairs = (rec.focusPairs && rec.focusPairs.length > 0)
    ? rec.focusPairs
    : (analysis && analysis.slowTransitions ? analysis.slowTransitions.slice(0, 5).map((t) => t.pair) : []);

  const weakKeySet = new Set(focusKeys.map((k) => String(k).toLowerCase()).filter((k) => k.length === 1));
  const weakPairSet = new Set(focusPairs.map((p) => String(p).toLowerCase()).filter((p) => p.length === 2));

  const scored = WORD_BANK.map((word) => ({
    word,
    score: scoreWordRelevance(word, weakKeySet, weakPairSet),
  }));

  const relevant = scored.filter((w) => w.score > 0).sort((a, b) => b.score - a.score);
  const filler = scored.filter((w) => w.score === 0);

  // Build the word sequence: prioritize the most relevant words first (so
  // a test asserting the drill contains the focus letters/pairs can rely
  // on them appearing early), then top up with varied filler words.
  const words = [];
  let currentLength = 0;
  let relevantIndex = 0;

  while (currentLength < targetLength) {
    let nextWord;
    if (relevantIndex < relevant.length && (words.length % 3 !== 2 || filler.length === 0)) {
      nextWord = relevant[relevantIndex % relevant.length].word;
      relevantIndex += 1;
    } else if (filler.length > 0) {
      nextWord = pickRandom(filler).word;
    } else if (relevant.length > 0) {
      nextWord = relevant[relevantIndex % relevant.length].word;
      relevantIndex += 1;
    } else {
      nextWord = pickRandom(WORD_BANK);
    }
    words.push(nextWord);
    currentLength += nextWord.length + 1; // +1 for the space/period

    // Safety valve: never loop forever even with pathological inputs.
    if (words.length > 500) break;
  }

  // Group into short "sentences" of 6-9 words for readability.
  let text = '';
  let i = 0;
  while (i < words.length) {
    const sentenceLen = 6 + (i % 4); // 6..9
    const chunk = words.slice(i, i + sentenceLen);
    if (chunk.length === 0) break;
    const sentence = chunk.join(' ');
    text += sentence.charAt(0).toUpperCase() + sentence.slice(1) + '. ';
    i += sentenceLen;
  }

  return {
    text: text.trim(),
    focusKeys,
    focusPairs,
    approximateLength: text.trim().length,
    wordCount: words.length,
  };
}

// ---------------------------------------------------------------------------
// 11. Session history / improvement detection
// ---------------------------------------------------------------------------

function isValidPreviousSession(session) {
  return (
    session &&
    typeof session === 'object' &&
    session.sessionStats &&
    isFiniteNumber(session.sessionStats.wpm) &&
    session.rhythm &&
    isFiniteNumber(session.rhythm.consistency)
  );
}

function weightedAverage(values, decay) {
  // values assumed oldest -> newest; most recent gets the highest weight.
  let weightedSum = 0;
  let weightTotal = 0;
  const n = values.length;
  for (let i = 0; i < n; i += 1) {
    const age = n - 1 - i; // 0 for most recent
    const weight = decay ** age;
    weightedSum += values[i] * weight;
    weightTotal += weight;
  }
  return safeDiv(weightedSum, weightTotal, 0);
}

/**
 * Compares the current session against (optionally weighted, recency
 * biased) previous sessions. Refuses to report an "improvement" when
 * there's insufficient history, per spec.
 */
export function computeImprovement(currentAnalysis, previousSessions) {
  const history = Array.isArray(previousSessions) ? previousSessions.filter(isValidPreviousSession) : [];

  if (history.length < MIN_HISTORY_SESSIONS) {
    return {
      available: false,
      reason: 'Not enough previous sessions to detect a trend yet.',
      wpmChange: 0,
      accuracyChange: 0,
      consistencyChange: 0,
      improvingKeys: [],
      decliningKeys: [],
    };
  }

  const prevWpm = weightedAverage(history.map((s) => s.sessionStats.wpm), HISTORY_DECAY);
  const prevAccuracy = weightedAverage(
    history.map((s) => normalizeAccuracyInput(s.sessionStats.accuracy)),
    HISTORY_DECAY
  );
  const prevConsistency = weightedAverage(history.map((s) => s.rhythm.consistency), HISTORY_DECAY);

  const currentWpm = isFiniteNumber(currentAnalysis.sessionStats && currentAnalysis.sessionStats.wpm)
    ? currentAnalysis.sessionStats.wpm
    : 0;
  const currentAccuracy = normalizeAccuracyInput(
    currentAnalysis.sessionStats && currentAnalysis.sessionStats.accuracy
  );
  const currentConsistency = currentAnalysis.rhythm ? currentAnalysis.rhythm.consistency : 0;

  const wpmChange = safeRound(currentWpm - prevWpm, 1);
  const accuracyChange = safeRound(currentAccuracy - prevAccuracy, 1);
  const consistencyChange = safeRound(currentConsistency - prevConsistency, 1);

  // Per-key trend comparison: build a weighted-average previous score per
  // key, then compare against the current session's reliable key scores.
  const prevKeyScores = new Map(); // key -> {weightedSum, weightTotal}
  const n = history.length;
  history.forEach((session, i) => {
    const age = n - 1 - i;
    const weight = HISTORY_DECAY ** age;
    const keyStats = Array.isArray(session.keyStats) ? session.keyStats : [];
    for (const k of keyStats) {
      if (!k || typeof k.key !== 'string' || !isFiniteNumber(k.score)) continue;
      if (!prevKeyScores.has(k.key)) prevKeyScores.set(k.key, { weightedSum: 0, weightTotal: 0 });
      const entry = prevKeyScores.get(k.key);
      entry.weightedSum += k.score * weight;
      entry.weightTotal += weight;
    }
  });

  const improvingKeys = [];
  const decliningKeys = [];
  const currentKeyStats = Array.isArray(currentAnalysis.keyStats) ? currentAnalysis.keyStats : [];
  for (const k of currentKeyStats) {
    if (!k.reliable) continue;
    const prevEntry = prevKeyScores.get(k.key);
    if (!prevEntry || prevEntry.weightTotal === 0) continue;
    const prevScore = safeDiv(prevEntry.weightedSum, prevEntry.weightTotal, k.score);
    const delta = k.score - prevScore;
    if (delta >= KEY_CHANGE_THRESHOLD) improvingKeys.push(k.key);
    else if (delta <= -KEY_CHANGE_THRESHOLD) decliningKeys.push(k.key);
  }

  return {
    available: true,
    wpmChange,
    accuracyChange,
    consistencyChange,
    improvingKeys,
    decliningKeys,
  };
}

// ---------------------------------------------------------------------------
// 12. Summary text
// ---------------------------------------------------------------------------

function buildSummary(fingerprint, recommendation, sessionStats) {
  const wpm = isFiniteNumber(sessionStats.wpm) ? safeRound(sessionStats.wpm) : 0;
  return (
    `You're typing like a "${fingerprint.style}" (overall score ${fingerprint.overall}/100, ` +
    `${wpm} WPM). ${recommendation.reason}`
  );
}

// ---------------------------------------------------------------------------
// 13. Main API
// ---------------------------------------------------------------------------

/**
 * Runs the full Typing Intelligence pipeline over a single session.
 *
 * @param {Array} keystrokes - raw keystroke telemetry events
 * @param {Object} sessionStats - { wpm, accuracy, errors, duration, typedLength }
 * @param {Array} previousSessions - optional array of previous analyzeTypingSession() results
 * @returns {Object} full analysis, matching the documented shape
 */
export function analyzeTypingSession(keystrokes, sessionStats = {}, previousSessions = []) {
  // Guard against explicit null (not just undefined) being passed for any
  // argument -- default parameters only cover the undefined case.
  const safeStatsInput = sessionStats && typeof sessionStats === 'object' ? sessionStats : {};
  const safePreviousSessions = Array.isArray(previousSessions) ? previousSessions : [];

  const safeSessionStats = {
    wpm: isFiniteNumber(safeStatsInput.wpm) ? safeStatsInput.wpm : 0,
    accuracy: isFiniteNumber(safeStatsInput.accuracy) ? safeStatsInput.accuracy : 0,
    errors: isFiniteNumber(safeStatsInput.errors) ? safeStatsInput.errors : 0,
    duration: isFiniteNumber(safeStatsInput.duration) ? safeStatsInput.duration : 0,
    typedLength: isFiniteNumber(safeStatsInput.typedLength) ? safeStatsInput.typedLength : 0,
  };

  const normalized = normalizeKeystrokes(keystrokes);
  const raw = collectRawAggregates(normalized);

  const overallBaselineDelay = raw.allDelays.length > 0 ? mean(raw.allDelays) : 0;

  const keyStats = computeKeyStats(raw.keyStatsRaw, overallBaselineDelay);
  const { weakKeys, strongKeys, slowKeys } = classifyKeys(keyStats);

  const { transitions, slowTransitions } = computeTransitions(raw.transitionsRaw);
  const errorPatterns = computeErrorPatterns(raw.errorPatternsRaw);
  const rhythm = computeRhythm(raw.allDelays);
  const corrections = computeCorrections(raw.backspaces, safeSessionStats.typedLength);
  const fingerprint = computeFingerprint(safeSessionStats, keyStats, rhythm, corrections);
  const recommendation = generateRecommendation(fingerprint, weakKeys, slowTransitions, rhythm);

  const analysis = {
    sessionStats: safeSessionStats,
    keyStats,
    weakKeys,
    strongKeys,
    slowKeys,

    transitions,
    slowTransitions,

    errorPatterns,

    rhythm: {
      averageDelay: rhythm.averageDelay,
      consistency: rhythm.consistency,
    },

    corrections,

    fingerprint,

    recommendation,

    improvement: {},

    summary: '',
  };

  analysis.improvement = computeImprovement(analysis, safePreviousSessions);
  analysis.summary = buildSummary(fingerprint, recommendation, safeSessionStats);

  return analysis;
}

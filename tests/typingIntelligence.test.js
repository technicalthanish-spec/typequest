// Tests for the TypeQuest Typing Intelligence Engine.
// Uses only Node's built-in test runner and assert module — no Jest,
// no external dependencies.
//
// Run with:  node --test typingIntelligence.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTypingSession,
  generateAdaptiveDrill,
  normalizeKeystrokes,
  computeRhythm,
  computeCorrections,
} from '../src/lib/typingIntelligence.js';

// ---------------------------------------------------------------------------
// Helpers for building synthetic keystroke sequences with controlled timing
// ---------------------------------------------------------------------------

/**
 * Builds a sequence of "correct" keystroke events for the given string,
 * spaced `delayMs` apart (or using a per-index override function).
 */
function typeString(str, { startTime = 1000, delayMs = 120, delayFn = null } = {}) {
  const events = [];
  let t = startTime;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    events.push({
      key: ch,
      expectedKey: ch,
      timestamp: t,
      correct: true,
      position: i,
      isBackspace: false,
    });
    const d = delayFn ? delayFn(i) : delayMs;
    t += d;
  }
  return events;
}

function baseSessionStats(overrides = {}) {
  return {
    wpm: 50,
    accuracy: 95,
    errors: 1,
    duration: 30,
    typedLength: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Empty session
// ---------------------------------------------------------------------------

test('empty session: returns safe, well-formed defaults with no crash', () => {
  const analysis = analyzeTypingSession([], {}, []);

  assert.deepEqual(analysis.keyStats, []);
  assert.deepEqual(analysis.weakKeys, []);
  assert.deepEqual(analysis.strongKeys, []);
  assert.deepEqual(analysis.slowKeys, []);
  assert.deepEqual(analysis.transitions, []);
  assert.deepEqual(analysis.slowTransitions, []);
  assert.deepEqual(analysis.errorPatterns, []);
  assert.equal(typeof analysis.rhythm.consistency, 'number');
  assert.equal(analysis.improvement.available, false);
  assert.equal(typeof analysis.summary, 'string');
  assert.ok(analysis.summary.length > 0);
});

// ---------------------------------------------------------------------------
// 2. Perfect session
// ---------------------------------------------------------------------------

test('perfect session: high accuracy, no errors, recognized as strong/balanced', () => {
  const text = 'the quick brown fox jumps over the lazy dog';
  const keystrokes = typeString(text, { delayMs: 110 });
  const analysis = analyzeTypingSession(
    keystrokes,
    baseSessionStats({ wpm: 70, accuracy: 100, errors: 0, typedLength: text.length })
  );

  assert.equal(analysis.errorPatterns.length, 0);
  assert.equal(analysis.weakKeys.length, 0);
  assert.ok(analysis.fingerprint.accuracy >= 95);
  assert.ok(analysis.fingerprint.overall > 0 && analysis.fingerprint.overall <= 100);
});

// ---------------------------------------------------------------------------
// 3. Weak-key detection
// ---------------------------------------------------------------------------

test('weak-key detection: a key with repeated errors is flagged as weak', () => {
  const keystrokes = [];
  let t = 1000;
  // "q" typed correctly twice, then incorrectly 5 times -> low accuracy, enough samples
  for (let i = 0; i < 2; i += 1) {
    keystrokes.push({ key: 'q', expectedKey: 'q', timestamp: t, correct: true, position: i, isBackspace: false });
    t += 120;
  }
  for (let i = 0; i < 5; i += 1) {
    keystrokes.push({ key: 'w', expectedKey: 'q', timestamp: t, correct: false, position: i + 2, isBackspace: false });
    t += 120;
  }
  // Some reliable, accurate filler keys so the session isn't just one key.
  for (const ch of 'asdfasdfasdf') {
    keystrokes.push({ key: ch, expectedKey: ch, timestamp: t, correct: true, position: 0, isBackspace: false });
    t += 100;
  }

  const analysis = analyzeTypingSession(keystrokes, baseSessionStats());
  const weakKeyLetters = analysis.weakKeys.map((k) => k.key);
  assert.ok(weakKeyLetters.includes('q'), `expected "q" to be a weak key, got: ${weakKeyLetters}`);
});

// ---------------------------------------------------------------------------
// 4. Repeated incorrect key detection (error patterns)
// ---------------------------------------------------------------------------

test('repeated incorrect key detection: recurring confusion pattern is captured', () => {
  const keystrokes = [];
  let t = 1000;
  for (let i = 0; i < 6; i += 1) {
    keystrokes.push({ key: 't', expectedKey: 'r', timestamp: t, correct: false, position: i, isBackspace: false });
    t += 130;
  }
  const analysis = analyzeTypingSession(keystrokes, baseSessionStats());

  const pattern = analysis.errorPatterns.find((p) => p.expected === 'r' && p.typed === 't');
  assert.ok(pattern, 'expected an r->t confusion pattern to be recorded');
  assert.equal(pattern.count, 6);
});

// ---------------------------------------------------------------------------
// 5. Slow transition detection
// ---------------------------------------------------------------------------

test('slow transition detection: a consistently slow pair is flagged', () => {
  const keystrokes = [];
  let t = 1000;

  // Fast baseline typing: a->b->a->b... at 80ms
  for (let i = 0; i < 20; i += 1) {
    const ch = i % 2 === 0 ? 'a' : 'b';
    keystrokes.push({ key: ch, expectedKey: ch, timestamp: t, correct: true, position: i, isBackspace: false });
    t += 80;
  }

  // Now insert a consistently slow "t -> r" transition, repeated enough times
  // to clear the minimum-sample bar, each preceded by a fast "x" to isolate
  // the pair's own delay.
  for (let i = 0; i < 6; i += 1) {
    keystrokes.push({ key: 'x', expectedKey: 'x', timestamp: t, correct: true, position: 100 + i, isBackspace: false });
    t += 80;
    keystrokes.push({ key: 't', expectedKey: 't', timestamp: t, correct: true, position: 100 + i, isBackspace: false });
    t += 400; // slow transition into r
    keystrokes.push({ key: 'r', expectedKey: 'r', timestamp: t, correct: true, position: 100 + i, isBackspace: false });
    t += 80; // fast transition back out to the next x
  }

  const analysis = analyzeTypingSession(keystrokes, baseSessionStats());
  const pairs = analysis.slowTransitions.map((s) => s.pair);
  assert.ok(pairs.includes('tr'), `expected "tr" to be a slow transition, got: ${pairs}`);
});

// ---------------------------------------------------------------------------
// 6. Consistency calculation
// ---------------------------------------------------------------------------

test('consistency calculation: steady typing scores higher than erratic typing', () => {
  const steadyDelays = Array(20).fill(120);
  const erraticDelays = [20, 400, 30, 500, 25, 600, 10, 700, 40, 550, 15, 800, 20, 900, 30, 650, 25, 700, 10, 500];

  const steady = computeRhythm(steadyDelays);
  const erratic = computeRhythm(erraticDelays);

  assert.ok(steady.consistency > erratic.consistency, 'steady typing should score more consistent than erratic typing');
  assert.ok(steady.consistency >= 95, `expected near-perfect consistency for uniform delays, got ${steady.consistency}`);
});

test('consistency calculation: a slow but steady typist can score highly', () => {
  const slowSteady = Array(20).fill(400); // consistently slow, not fast
  const result = computeRhythm(slowSteady);
  assert.ok(result.consistency >= 95, `slow-but-steady typing should not be penalized, got ${result.consistency}`);
});

// ---------------------------------------------------------------------------
// 7. Backspace handling
// ---------------------------------------------------------------------------

test('backspace handling: corrections are counted without crashing or over-punishing', () => {
  const keystrokes = typeString('hello world', { delayMs: 100 });
  // insert a few backspaces
  keystrokes.push({ key: 'Backspace', timestamp: keystrokes[keystrokes.length - 1].timestamp + 100, isBackspace: true });
  keystrokes.push({ key: 'Backspace', timestamp: keystrokes[keystrokes.length - 1].timestamp + 100, isBackspace: true });

  // 2 corrections is trivial over a longer passage (~120 chars) -- should
  // barely dent the score, even though it would look harsh over a tiny one.
  const corrections = computeCorrections(2, 120);
  assert.equal(corrections.backspaces, 2);
  assert.ok(corrections.correctionScore <= 100 && corrections.correctionScore >= 0);
  assert.ok(corrections.correctionScore > 50, 'a couple of corrections over a normal passage should not tank the score');

  const analysis = analyzeTypingSession(keystrokes, baseSessionStats({ typedLength: 120 }));
  assert.equal(analysis.corrections.backspaces, 2);
});

// ---------------------------------------------------------------------------
// 8. Adaptive recommendation
// ---------------------------------------------------------------------------

test('adaptive recommendation: low accuracy triggers an accuracy drill', () => {
  const keystrokes = [];
  let t = 1000;
  for (let i = 0; i < 10; i += 1) {
    keystrokes.push({
      key: 'x',
      expectedKey: 'a',
      timestamp: t,
      correct: false,
      position: i,
      isBackspace: false,
    });
    t += 100;
  }
  const analysis = analyzeTypingSession(keystrokes, baseSessionStats({ accuracy: 40 }));
  assert.equal(analysis.recommendation.type, 'ACCURACY_DRILL');
  assert.ok(['high', 'medium'].includes(analysis.recommendation.priority));
});

test('adaptive recommendation: strong performance falls back to a balanced drill', () => {
  const text = 'a steady and accurate typing session with good rhythm overall';
  const keystrokes = typeString(text, { delayMs: 130 });
  const analysis = analyzeTypingSession(
    keystrokes,
    baseSessionStats({ wpm: 65, accuracy: 98, errors: 0, typedLength: text.length })
  );
  assert.ok(
    ['BALANCED_DRILL', 'SPEED_DRILL'].includes(analysis.recommendation.type),
    `expected a low-pressure recommendation, got ${analysis.recommendation.type}`
  );
});

// ---------------------------------------------------------------------------
// 9. Drill generation
// ---------------------------------------------------------------------------

test('drill generation: produces readable text biased toward focus keys', () => {
  const analysis = {
    recommendation: { focusKeys: ['t', 'r'], focusPairs: ['tr'] },
    weakKeys: [],
    slowTransitions: [],
  };
  const drill = generateAdaptiveDrill(analysis, { length: 200 });

  assert.equal(typeof drill.text, 'string');
  assert.ok(drill.text.length > 0);
  assert.ok(!/^([a-z])\1{3,}/i.test(drill.text), 'drill should not be degenerate repeated characters');
  assert.ok(!drill.text.includes('trtrtrtr'), 'drill should not contain nonsense repetition');
  // Should read as actual words (contains spaces / multiple words).
  assert.ok(drill.text.trim().split(/\s+/).length > 3);
});

test('drill generation: respects an approximate target length', () => {
  const analysis = { recommendation: {}, weakKeys: [], slowTransitions: [] };
  const drill = generateAdaptiveDrill(analysis, { length: 80 });
  assert.ok(drill.approximateLength > 0);
  // Allow generous tolerance since we only stop at word boundaries.
  assert.ok(drill.approximateLength < 80 + 40);
});

// ---------------------------------------------------------------------------
// 10. Malformed input safety
// ---------------------------------------------------------------------------

test('malformed input safety: garbage events are dropped without throwing', () => {
  const garbage = [
    null,
    undefined,
    42,
    'not an object',
    {},
    { key: 'a' }, // missing expectedKey and not a backspace
    { expectedKey: 'a', timestamp: 'not-a-number', correct: true },
    { expectedKey: 'a', timestamp: NaN, correct: true },
    { expectedKey: 'a', timestamp: Infinity, correct: true },
    { isBackspace: true }, // missing timestamp
    { expectedKey: 'b', timestamp: 1000, correct: true, position: 0, isBackspace: false },
  ];

  const normalized = normalizeKeystrokes(garbage);
  assert.equal(normalized.length, 1);

  assert.doesNotThrow(() => {
    analyzeTypingSession(garbage, { wpm: NaN, accuracy: undefined, typedLength: 'oops' }, 'not-an-array');
  });
});

test('malformed input safety: non-array keystrokes and previousSessions do not crash', () => {
  assert.doesNotThrow(() => analyzeTypingSession(undefined, undefined, undefined));
  assert.doesNotThrow(() => analyzeTypingSession(null, null, null));
  assert.doesNotThrow(() => analyzeTypingSession({}, {}, {}));
});

// ---------------------------------------------------------------------------
// 11. No NaN / Infinity values anywhere in the result
// ---------------------------------------------------------------------------

function assertNoNaNOrInfinity(value, path = 'root') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `found non-finite number at ${path}: ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaNOrInfinity(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertNoNaNOrInfinity(value[key], `${path}.${key}`);
    }
  }
}

test('no NaN/Infinity anywhere in a realistic analysis', () => {
  const text = 'the quick brown fox jumps over the lazy dog again and again';
  const keystrokes = typeString(text, { delayMs: 90, delayFn: (i) => (i % 7 === 0 ? 5 : 90) });
  const analysis = analyzeTypingSession(keystrokes, baseSessionStats({ wpm: 55, accuracy: 92, typedLength: text.length }));
  assertNoNaNOrInfinity(analysis);
});

test('no NaN/Infinity with zero-duration, zero-length degenerate stats', () => {
  const analysis = analyzeTypingSession([], { wpm: 0, accuracy: 0, errors: 0, duration: 0, typedLength: 0 }, []);
  assertNoNaNOrInfinity(analysis);
});

// ---------------------------------------------------------------------------
// 12. History / improvement detection
// ---------------------------------------------------------------------------

test('improvement detection: reports unavailable with no history', () => {
  const analysis = analyzeTypingSession(typeString('hello'), baseSessionStats(), []);
  assert.equal(analysis.improvement.available, false);
});

test('improvement detection: detects a positive wpm/accuracy trend across sessions', () => {
  const previousSessions = [
    {
      sessionStats: { wpm: 30, accuracy: 80, errors: 5, duration: 30, typedLength: 50 },
      rhythm: { averageDelay: 200, consistency: 60 },
      keyStats: [{ key: 'a', score: 50, attempts: 10, reliable: true }],
    },
    {
      sessionStats: { wpm: 35, accuracy: 84, errors: 4, duration: 30, typedLength: 50 },
      rhythm: { averageDelay: 190, consistency: 65 },
      keyStats: [{ key: 'a', score: 60, attempts: 10, reliable: true }],
    },
  ];

  const keystrokes = typeString('the quick brown fox jumps over the lazy dog and then some more', { delayMs: 90 });
  const analysis = analyzeTypingSession(
    keystrokes,
    baseSessionStats({ wpm: 50, accuracy: 95, typedLength: 60 }),
    previousSessions
  );

  assert.equal(analysis.improvement.available, true);
  assert.ok(analysis.improvement.wpmChange > 0, 'expected a positive wpm change vs history');
  assert.ok(analysis.improvement.accuracyChange > 0, 'expected a positive accuracy change vs history');
});

test('improvement detection: ignores malformed history entries', () => {
  const malformedHistory = [null, 42, { sessionStats: {} }, { foo: 'bar' }];
  const analysis = analyzeTypingSession(typeString('hello'), baseSessionStats(), malformedHistory);
  assert.equal(analysis.improvement.available, false);
});

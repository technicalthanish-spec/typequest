// One comparison rule for highlighting, speed and accuracy.
export function matchesCharacter(expected, actual, exactCase = false) {
  if (expected == null || actual == null) return false;
  return exactCase ? expected === actual : expected.toLowerCase() === actual.toLowerCase();
}

export function isLinearEdit(previous, next) {
  // Only append or remove a suffix; selection replacements bypass key accounting.
  return next.length > previous.length ? next.startsWith(previous) : previous.startsWith(next);
}

export function calcMetrics(text, typed, seconds, exactCase = false, strokes = null) {
  let correct = 0;
  for (let i = 0; i < typed.length; i++) {
    if (matchesCharacter(text[i], typed[i], exactCase)) correct++;
  }
  const minutes = Math.max(Number.isFinite(seconds) ? seconds : 0, 1) / 60;
  const attempts = strokes ? strokes.attempts : typed.length;
  const correctAttempts = strokes ? strokes.correct : correct;
  return {
    correct,
    errors: strokes ? strokes.errors : typed.length - correct,
    wpm: Math.round(correct / 5 / minutes),
    accuracy: attempts ? Math.round(correctAttempts / attempts * 1000) / 10 : 0
  };
}

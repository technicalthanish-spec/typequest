import { weakKeys, dayKey } from './progress.js';

export const ZONES = [
  { name: 'First Light Forest', label: 'Find your rhythm', color: '#7ee3b3', icon: '♧' },
  { name: 'Neon Harbor', label: 'Build your flow', color: '#78caff', icon: '≈' },
  { name: 'Amber Highlands', label: 'Climb with confidence', color: '#ffc774', icon: '△' },
  { name: 'Violet Orbit', label: 'Reach new speeds', color: '#c2a5ff', icon: '✧' },
  { name: 'Summit of Masters', label: 'Make every key count', color: '#ff9ab2', icon: '♛' },
];

export function makePlan(data, level, now = new Date()) {
  const recent = (data.attempts || []).filter(a => !a.skipped).slice(0, 5);
  const accuracy = recent.length ? Math.round(recent.reduce((s,a) => s+a.accuracy,0)/recent.length) : null;
  const wpm = recent.length ? Math.round(recent.reduce((s,a) => s+a.wpm,0)/recent.length) : null;
  const keys = weakKeys(data.keyStats, 3).filter(k => k.length === 1 && /\S/.test(k));
  const focus = accuracy === null ? 'calibration' : accuracy < 95 ? 'accuracy' : 'speed';
  const target = focus === 'speed' ? Math.max(1, Math.round(wpm * 1.05)) : Math.max(1, Math.round((wpm || level.targetWpm) * .85));
  const drill = keys.length ? keys.map(k => `${k}${k} ${k}f f${k} ${k}j j${k} ${k} ${k}`).join(' ') : level.warmup;
  return {
    day: dayKey(now), focus, keys, accuracy, wpm, target,
    title: focus === 'calibration' ? 'Let’s find your starting point.' : focus === 'accuracy' ? 'Slow it down. Lock it in.' : 'You’re ready for a little more speed.',
    reason: recent.length ? `Your last ${recent.length} completed challenge${recent.length === 1 ? '' : 's'} averaged ${accuracy}% accuracy and ${wpm} WPM. ${focus === 'accuracy' ? 'Build consistent accuracy before pushing speed.' : 'Aim for a small speed increase while keeping 95% accuracy.'}` : 'Complete a challenge to establish your speed and accuracy baseline. Your first plan starts with the keys in your current lesson.',
    tasks: [
      { id: 'keys', title: keys.length ? `Repair ${keys.map(k=>k.toUpperCase()).join(' · ')}` : 'Find your anchors', detail: keys.length ? 'Targeted combinations from your recorded key errors.' : 'A short warm-up using your current lesson.', text: drill, targetAccuracy: 95, targetWpm: 0 },
      { id: 'control', title: 'Accuracy first', detail: 'Finish the passage with at least 95% accuracy. Take your time.', text: level.practice, targetAccuracy: 95, targetWpm: 0 },
      { id: 'flow', title: focus === 'speed' ? 'Push your pace' : 'Find a steady rhythm', detail: `Aim for ${target} WPM and 95% accuracy. This is practice, so there’s no level penalty.`, text: level.challenge, targetAccuracy: 95, targetWpm: target },
    ],
  };
}

export function meetsTarget(task, metrics) {
  return metrics.accuracy >= task.targetAccuracy && metrics.wpm >= task.targetWpm;
}

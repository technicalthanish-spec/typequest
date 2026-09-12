export function dayKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function dailySummary(attempts, key) {
  const rows = attempts.filter(a => !a.skipped && dayKey(a.date) === key);
  const seconds = rows.reduce((n,a) => n + a.seconds, 0);
  return { count: rows.length, seconds, wpm: rows.length ? Math.round(rows.reduce((n,a) => n+a.wpm,0)/rows.length) : null,
    accuracy: rows.length ? Math.round(rows.reduce((n,a) => n+a.accuracy,0)/rows.length*10)/10 : null };
}
export function weekSummary(attempts, now = new Date()) {
  return Array.from({length:7},(_,i) => { const d = new Date(now); d.setHours(12,0,0,0); d.setDate(d.getDate()-6+i); const key = dayKey(d); return {key,...dailySummary(attempts,key)}; });
}
export function weakKeys(stats, limit = 3) {
  return Object.entries(stats || {}).filter(([,s]) => s.attempts >= 8 && s.errors > 0)
    .sort((a,b) => b[1].errors/b[1].attempts-a[1].errors/a[1].attempts).slice(0,limit).map(([k])=>k);
}
export function keyBand(s) {
  if (!s || s.attempts < 8) return 'unknown';
  const rate = s.errors / s.attempts;
  return rate >= .2 ? 'high' : rate >= .08 ? 'medium' : 'low';
}

import React from 'react';
import { weekSummary, dailySummary, dayKey } from '../lib/progress';
export default function ProgressReport({data}) {
  const week = weekSummary(data.attempts);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  const summary = dailySummary(data.attempts,dayKey(yesterday));
  const max = Math.max(60,...week.map(d=>d.wpm || 0));
  return <section className="card progressReport" aria-labelledby="weekly-title">
    <p className="eyebrow">SMALL STEPS, REAL PROGRESS</p><h2 id="weekly-title">Your last seven days</h2>
    <p className="muted">Average challenge speed by day. Different lessons can have different difficulty.</p>
    <div className="weekChart" role="img" aria-label={week.map(d=>`${d.key}: ${d.wpm === null ? 'no challenges' : d.wpm+' WPM'}`).join('; ')}>
      {week.map(d=><div className="dayColumn" key={d.key}><strong>{d.wpm ?? '—'}</strong><div className="barTrack"><span style={{height:d.wpm===null?'0':`${Math.max(3,d.wpm/max*100)}%`}}/></div><small>{new Date(d.key+'T12:00:00').toLocaleDateString(undefined,{weekday:'short'})}</small></div>)}
    </div>
    <div className="yesterdayReport"><h3>What you learned yesterday</h3>{summary.count ? <p>You completed <b>{summary.count} challenges</b> at an average of <b>{summary.wpm} WPM</b> and <b>{summary.accuracy}% accuracy</b>. Keep practising your least accurate keys today.</p> : <p className="muted">No completed challenges yesterday. Practise today and your summary will appear here tomorrow.</p>}</div>
    <details><summary>View chart data</summary><table><thead><tr><th>Date</th><th>Challenges</th><th>Average WPM</th><th>Accuracy</th></tr></thead><tbody>{week.map(d=><tr key={d.key}><td>{d.key}</td><td>{d.count}</td><td>{d.wpm ?? '—'}</td><td>{d.accuracy===null?'—':d.accuracy+'%'}</td></tr>)}</tbody></table></details>
  </section>;
}

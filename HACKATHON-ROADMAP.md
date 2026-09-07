# TypeQuest Hackathon Edition — Build Roadmap

## Product
TypeQuest is a local-first adaptive typing coach, not just a typing-speed test.

## Already implemented in this project
- 50 sequential levels
- Basic / Intermediate / Advanced progression
- Local profile
- IndexedDB persistence
- Finger-placement first-session guide
- Live WPM, accuracy, errors and timer
- Stars, XP, streaks, achievements
- Level map
- Daily mission
- Practice history
- JSON backup/restore
- Dark/light mode

## Next implementation priorities
1. Make Warm-up and Practice first-class scored typing modes.
2. Record character-level mistakes on every mode.
3. Build weak-key heatmap and difficult-key ranking.
4. Generate personalized drills from the user's weak keys.
5. Add improvement-over-time charts.
6. Add final boss/mastery challenge.
7. Polish transitions, achievement animations and presentation flow.
8. Test refresh/reopen, retry, unlocking, backup/restore and Level 50.

## Hackathon demo story
Mistake → detect weak key → personalized drill → improvement → progress insight.

## Architecture
React + Vite + IndexedDB. No backend, cloud database or authentication server.

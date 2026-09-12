# TypeQuest Adventure update

Two local updates, ready for your own deployment:

1. Adventure dashboard and map: original vector landscape, five themed worlds, 50 connected progression levels, boss checkpoint styling every five levels, milestone trophies, three unlockable palettes, mobile layouts and reduced-motion support.
2. Personal typing coach: recent challenge averages choose calibration, accuracy or speed focus; recorded weak keys generate combinations; three playable missions have explicit accuracy/speed targets. Daily mission completion persists in the existing settings, while typing updates key statistics and practice minutes.

The coach runs locally without a paid AI service. It is a rule-based practice planner, not an AI chatbot. Boss checkpoints reuse the existing level challenges and scoring; there is no separate combat system. Themes unlock at 0, 10 and 25 cleared levels. Existing progress, lessons, cloud saving and personal welcome are retained.

## Deploy yourself

This is the full source project. Upload it to your existing GitHub repository and deploy using your existing Vercel project. Keep your existing production Supabase environment variables. No database migration or new dependency is required.

Run `npm ci`, `npm test`, and `npm run build`. Vercel output remains `dist`.

Changed/new implementation files: `src/App.jsx`, `src/main.jsx`, `src/adventure.css`, `src/components/Adventure.jsx`, `src/components/PersonalCoach.jsx`, `src/lib/coach.js`, `tests/coach.test.js`.

Validation: 17 automated tests pass and production build succeeds. Browser review covered desktop dashboard, mobile coach/map with no page overflow, locked level controls, completing a coach mission and persistence after refresh. The existing bundle-size warning remains. No GitHub or production deployment was performed for this update.

# TypeQuest

TypeQuest is a 50-level adaptive typing coach with real-time typing practice, progression, XP/stars, streaks, achievements, weak-key analytics, local caching, and Supabase cloud sync.

## Online architecture
- React + Vite frontend
- Supabase Auth for email/password accounts
- Supabase PostgreSQL `public.game_states` for game progress
- Row Level Security so users can access only their own state
- IndexedDB for fast local caching/offline-friendly loading
- Vercel for production hosting

## Data storage
Passwords are handled by Supabase Auth and are not stored in the TypeQuest game-state JSON. Game progress is stored in `public.game_states.state` and keyed by the authenticated Supabase user id. IndexedDB contains a local cache on each browser.

## Deploy
1. Push this folder to GitHub. Keep `.env` out of Git; `.gitignore` already excludes it.
2. Import the repository into Vercel.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as Vercel environment variables.
4. Deploy.
5. In Supabase Authentication → URL Configuration, add the Vercel production URL.

## Supabase SQL
Run `supabase.sql` once in Supabase SQL Editor. It creates `game_states`, enables RLS, and adds the required owner-only policies.

## Development
```bash
npm install
npm run dev
```

## Production build
```bash
npm run build
```

# TypeQuest Online Setup

## 1. Local development
Create `.env` in this folder (never commit it):

```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_publishable_key
```

Then:

```bash
npm install
npm run dev
```

## 2. Supabase
Run `supabase.sql` once in the Supabase SQL Editor. It creates `game_states` with Row Level Security so each account can access only its own progress.

Email/password authentication must be enabled in Supabase Authentication → Sign In / Providers → Email.

## 3. GitHub
Commit the project source, but **do not commit `.env`**. `.gitignore` already excludes it. Use `.env.example` as the template.

## 4. Vercel
Import the GitHub repository into Vercel and add these Environment Variables for the deployment:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Redeploy after changing environment variables.

## 5. Supabase Auth redirect
After Vercel gives you the production URL, add that URL to Supabase Authentication → URL Configuration → Redirect URLs.

The browser-side Supabase key is the publishable/anon key. Never put a Supabase service-role or secret key in this project.

# TypeQuest learning and reliability upgrade

This release preserves the existing 50 levels, personalised lesson content, welcome message, Supabase project and progress schema.

## Included

- Direct targeted drills, a standalone drill result, live keyboard/finger guidance, focus mode and text size controls.
- Mobile menu, navigation scroll/focus reset, light-theme corrections and accessible backup dialog.
- Seven-day challenge chart, yesterday summary, sample-aware key heatmap, history pagination and filters.
- Daily goal settings and practice-time tracking across warm-up, practice and targeted drills.
- Password reset request and recovery form; labelled login fields and show-password control.
- Account-specific cached progress, durable pending saves, online retry and explicit conflict recovery with a retained local backup.
- Automated tests and GitHub build checks; basic browser security headers.

## Deployment

Keep the existing Vercel environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Ensure they also exist for preview deployments if preview login is needed. Never put a Supabase secret/service-role key into the frontend.

No SQL migration is needed for this release if the existing `supabase.sql` is already installed. It still uses the revision-checked `save_game_state` RPC and its user-specific database policies.

Password recovery returns to the site's origin. The production URL must be allowed in Supabase Authentication URL Configuration, and the project's email delivery must work. Test an actual recovery email using an account you control before announcing the recovery feature.

## Validation and remaining limits

- Automated checks cover typing scores, backspace behaviour, storage transactions, date boundaries, weak-key evidence, interrupted saves and revision conflicts.
- Local browser verification covers completing a level, results, refresh persistence and mobile navigation with an isolated local profile.
- Production cloud saving, email delivery, and cross-device recovery require deployment verification. A local build alone does not establish these.
- Challenge history retains the existing limit of 500 attempts. Export backups for archival history. This release does not introduce a per-attempt database migration, multiplayer, rankings, installable/offline app caching, or a load-tested capacity claim.
- If two devices change the same state, export the local backup before choosing the cloud version. This release intentionally does not automatically merge conflicting scores.

## Rollback

Redeploy the previous Vercel production deployment if needed. The database schema remains compatible. Download any pending local progress before rollback; the previous frontend does not understand the new per-account pending-save records.

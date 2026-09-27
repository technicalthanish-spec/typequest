# Multiplayer arena

The Multiplayer tab supports 2–8 signed-in players, room codes and invite links,
a pre-race briefing, readiness checks, a shared five-second countdown, live
standings, final rankings and rematches. Choose 30, 60 or 120 seconds and an easy,
standard or expert passage. Each player needs their own TypeQuest account.

## Setup and operation

Apply `multiplayer.sql` to the existing TypeQuest Supabase project. It is
idempotent and leaves `game_states` unchanged. No new environment variables or
Realtime configuration are needed.

The authenticated `typequest_multiplayer` RPC wraps a private function that
validates membership, host actions and game transitions under a room row lock.
Private tables have RLS and no browser-role table grants. The server chooses
the passage, owns the start/deadline, computes correct characters and WPM, and
rejects typing after the deadline. Most correct characters wins; accuracy
breaks ties and equal scores share a place. Corrected errors still count.

These are friendly races, not a cheat-proof ranked ladder: attempt/error counts
come from the client. Races award no XP and do not change practice history.

Clients serialize requests and poll roughly every 0.5 seconds during a race or
1.5 seconds in a lobby. A server timestamp anchors the countdown to a monotonic
browser clock. Live standings have network latency; only updates received before
the server deadline count. This design targets small friend rooms rather than
large tournaments.

Session storage keeps the room per account. Refresh restores acknowledged text
and errors; brief outages retry automatically. After 30 seconds offline, hosting
transfers to an active player and stale lobby players are removed. Leaving a race
marks a withdrawal. Rematches reset readiness and scores. Rooms expire after two
hours; starting a race or rematch renews that expiry. Expired data is cleaned up when a new room is created. A server lease permits one typing tab per player; another tab is read-only until the writer has been absent for 10 seconds, then restores the acknowledged draft.

## Verification

`npm test` includes the original suite, input/clock/ranking checks and a PGlite
database lifecycle test covering authorization, invalid/full rooms, host-only
actions, readiness, countdown and deadline enforcement, duplicate/stale packets,
reconnect data, rematches, host transfer and expiry. Run `npm run build` before
deployment. Browser checks should use two accounts and include the full race,
final standings, rematch and a narrow viewport.

export const ROOM_CODE = /^[A-F0-9]{8}$/;
export const normalizeRoomCode = value => String(value || '').replace(/[\s-]/g, '').toUpperCase();

export function raceClock(room, now) {
  if (!room?.startsAt) return { countdown: 0, remaining: room?.duration || 60, running: false };
  const elapsed = (now - Date.parse(room.startsAt)) / 1000;
  return {
    countdown: Math.max(0, Math.ceil(-elapsed)),
    remaining: Math.max(0, Math.ceil(room.duration - Math.max(0, elapsed))),
    running: room.phase === 'racing' && elapsed >= 0 && elapsed < room.duration
  };
}

export function rankPlayers(players = []) {
  const sorted = [...players].sort((a, b) => Number(a.left) - Number(b.left) || b.correct - a.correct || b.accuracy - a.accuracy || a.name.localeCompare(b.name));
  return sorted.map((player, i) => ({ ...player, rank: i && player.correct === sorted[i-1].correct && player.accuracy === sorted[i-1].accuracy && player.left === sorted[i-1].left ? sorted.findIndex(p => p.correct === player.correct && p.accuracy === player.accuracy && p.left === player.left) + 1 : i + 1 }));
}

export function recordKey(draft, next, passage) {
  if (next === draft.typed) return draft;
  const append = next.length === draft.typed.length + 1 && next.startsWith(draft.typed);
  const backspace = next.length < draft.typed.length && draft.typed.startsWith(next);
  if ((!append && !backspace) || next.length > passage.length) return draft;
  return {
    ...draft, typed: next, sequence: draft.sequence + 1,
    attempts: draft.attempts + Number(append),
    errors: draft.errors + Number(append && next.at(-1) !== passage[next.length - 1])
  };
}

export function roomError(error) {
  if (error?.code === 'PGRST202' || /could not find.*function/i.test(error?.message || '')) return 'Multiplayer is being set up. Please try again shortly.';
  return error?.message || 'Connection interrupted. Reconnecting to your room…';
}

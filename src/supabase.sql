-- TypeQuest production cloud database
-- Run this once in Supabase Dashboard -> SQL Editor.

create table if not exists public.game_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.game_states enable row level security;

alter table public.game_states add column if not exists revision bigint not null default 0;
alter table public.game_states add column if not exists updated_at timestamptz not null default now();

-- Server-owned timestamp: clients cannot choose the stored updated_at value.
create or replace function public.set_game_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists game_states_updated_at on public.game_states;
create trigger game_states_updated_at
before insert or update on public.game_states
for each row execute function public.set_game_state_updated_at();

-- Keep the JSON document within safe structural bounds. This is not a substitute
-- for server-side gameplay rules, but prevents malformed/oversized state writes.
create or replace function public.validate_game_state(p_state jsonb)
returns boolean
language plpgsql
immutable
as $$
begin
  if jsonb_typeof(p_state) <> 'object' then return false; end if;
  if coalesce(jsonb_array_length(p_state->'attempts'), 0) > 500 then return false; end if;
  if coalesce((p_state->>'currentLevel')::numeric, 1) < 1 or coalesce((p_state->>'currentLevel')::numeric, 1) > 50 then return false; end if;
  if coalesce((p_state->>'xp')::numeric, 0) < 0 or coalesce((p_state->>'xp')::numeric, 0) > 1000000000 then return false; end if;
  if coalesce((p_state->>'totalStars')::numeric, 0) < 0 or coalesce((p_state->>'totalStars')::numeric, 0) > 150 then return false; end if;
  return true;
exception when others then
  return false;
end;
$$;

-- Atomic optimistic-concurrency save. A stale device revision is rejected
-- instead of silently overwriting newer progress from another device.
create or replace function public.save_game_state(p_state jsonb, p_expected_revision bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  next_revision bigint;
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if not public.validate_game_state(p_state) then raise exception 'Invalid TypeQuest state'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid revision'; end if;

  if p_expected_revision <> 0 and not exists (select 1 from public.game_states where user_id = uid) then
    raise exception 'SYNC_CONFLICT';
  end if;

  insert into public.game_states(user_id, state, revision, updated_at)
  values (uid, p_state, 1, now())
  on conflict (user_id) do update
    set state = excluded.state,
        revision = public.game_states.revision + 1,
        updated_at = now()
    where public.game_states.revision = p_expected_revision
  returning revision into next_revision;

  if next_revision is null then
    raise exception 'SYNC_CONFLICT';
  end if;
  return next_revision;
end;
$$;

revoke all on function public.save_game_state(jsonb, bigint) from public;
grant execute on function public.save_game_state(jsonb, bigint) to authenticated;

revoke all on function public.validate_game_state(jsonb) from public;

-- RLS remains enabled for direct reads and deletes. Writes use the atomic RPC.
drop policy if exists "Users can read their own TypeQuest state" on public.game_states;
create policy "Users can read their own TypeQuest state"
on public.game_states for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert their own TypeQuest state" on public.game_states;
drop policy if exists "Users can update their own TypeQuest state" on public.game_states;

drop policy if exists "Users can delete their own TypeQuest state" on public.game_states;
create policy "Users can delete their own TypeQuest state"
on public.game_states for delete
using (auth.uid() = user_id);

create index if not exists game_states_updated_at_idx
on public.game_states(updated_at desc);

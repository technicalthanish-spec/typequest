-- TypeQuest multiplayer: authoritative rooms, shared clock, and bounded scores.
-- All tables are private; clients can only use the authenticated RPC below.
create schema if not exists typequest_private;
revoke all on schema typequest_private from public, anon;
grant usage on schema typequest_private to authenticated;

create table if not exists typequest_private.rooms (
  code text primary key,
  host_id uuid not null references auth.users(id) on delete cascade,
  phase text not null default 'lobby' check (phase in ('lobby','racing','results','closed')),
  duration integer not null check (duration in (30,60,120)),
  difficulty text not null check (difficulty in ('easy','standard','expert')),
  passage text not null default '',
  round integer not null default 1,
  starts_at timestamptz,
  expires_at timestamptz not null default (now() + interval '2 hours'),
  created_at timestamptz not null default now()
);
create index if not exists tq_rooms_host on typequest_private.rooms(host_id);
create index if not exists tq_rooms_expiry on typequest_private.rooms(expires_at);
create table if not exists typequest_private.players (
  code text not null references typequest_private.rooms(code) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  ready boolean not null default false,
  typed text not null default '',
  correct integer not null default 0,
  attempts integer not null default 0,
  errors integer not null default 0,
  sequence integer not null default 0,
  left_room boolean not null default false,
  last_seen timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (code,user_id)
);
create index if not exists tq_players_user on typequest_private.players(user_id);
alter table typequest_private.rooms enable row level security;
alter table typequest_private.players enable row level security;
revoke all on all tables in schema typequest_private from public, anon, authenticated;

alter table typequest_private.players add column if not exists writer_id text;
alter table typequest_private.players add column if not exists writer_seen_at timestamptz;
alter table typequest_private.players add column if not exists finalized boolean not null default false;

-- Definer is needed for atomic, validated game transitions without granting
-- clients arbitrary table writes. It lives outside the exposed public schema.
create or replace function typequest_private.multiplayer(p_action text, p_code text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  r typequest_private.rooms%rowtype;
  me typequest_private.players%rowtype;
  stamp timestamptz := clock_timestamp();
  room_code text := upper(trim(coalesce(p_code,'')));
  player_name text := left(trim(coalesce(p_payload->>'name','Player')),24);
  new_text text;
  bad integer;
  good integer;
  next_sequence integer;
  participants integer;
  snapshot jsonb;
  tab_id text := left(coalesce(nullif(p_payload->>'clientId',''),'legacy'),64);
  can_type boolean := false;
  changed_writer boolean := false;
begin
  if uid is null then raise exception 'Please sign in to play multiplayer.'; end if;
  if p_action is null or p_action not in ('create','join','sync','ready','start','rematch','leave') then
    raise exception 'Unknown room action.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 20000 then
    raise exception 'Invalid room request.';
  end if;
  if player_name = '' then player_name := 'Player'; end if;

  if p_action = 'create' then
    -- Serialize creations for this account; retries return the same active room.
    perform pg_advisory_xact_lock(hashtextextended(uid::text, 913));
    delete from typequest_private.rooms where expires_at < stamp;
    select * into r from typequest_private.rooms where host_id=uid and phase <> 'closed' order by created_at desc limit 1 for update;
    if not found then
      loop
        room_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
        begin
          insert into typequest_private.rooms(code,host_id,duration,difficulty)
          values(room_code,uid,coalesce((p_payload->>'duration')::integer,60),coalesce(p_payload->>'difficulty','standard')) returning * into r;
          exit;
        exception when unique_violation then null;
        end;
      end loop;
      insert into typequest_private.players(code,user_id,name) values(r.code,uid,player_name);
    end if;
    room_code := r.code;
  end if;
  if room_code !~ '^[A-F0-9]{8}$' then raise exception 'Enter the 8-character room code.'; end if;
  select * into r from typequest_private.rooms where code=room_code for update;
  if not found or r.expires_at < stamp or r.phase='closed' then raise exception 'Room not found or expired. Ask your friend for a new code.'; end if;
  -- Refresh after the lock; another player's request may have made us wait.
  stamp := clock_timestamp();
  select * into me from typequest_private.players where code=room_code and user_id=uid;

  if p_action='join' then
    if me.user_id is null or me.left_room then
      if r.phase <> 'lobby' then raise exception 'This race has already started. Join after the host opens a rematch.'; end if;
      select count(*) into participants from typequest_private.players where code=room_code and not left_room and last_seen > stamp-interval '30 seconds';
      if participants >= 8 then raise exception 'This room is full (8 players).'; end if;
      -- Remove stale lobby occupants before admitting a new participant.
      delete from typequest_private.players where code=room_code and user_id<>r.host_id and (left_room or last_seen < stamp-interval '30 seconds');
      insert into typequest_private.players(code,user_id,name) values(room_code,uid,player_name)
      on conflict(code,user_id) do update set left_room=false, ready=false, name=excluded.name, last_seen=stamp;
    end if;
  elsif me.user_id is null or me.left_room then
    raise exception 'Join this room before playing.';
  end if;

  -- Allow three seconds for the frozen final packet, never extra typing time.
  if r.phase='racing' and stamp >= r.starts_at + make_interval(secs=>r.duration+3) then
    update typequest_private.rooms set phase='results' where code=room_code returning * into r;
  end if;
  update typequest_private.players set last_seen=stamp where code=room_code and user_id=uid;
  select * into me from typequest_private.players where code=room_code and user_id=uid;

  if r.phase='racing' then
    if me.writer_id is null or (me.writer_seen_at < stamp-interval '10 seconds'
        and stamp < r.starts_at + make_interval(secs=>r.duration)) then
      changed_writer := me.writer_id is not null;
      update typequest_private.players set writer_id=tab_id,writer_seen_at=stamp
        where code=room_code and user_id=uid returning * into me;
    end if;
    can_type := me.writer_id=tab_id;
    if can_type then
      update typequest_private.players set writer_seen_at=stamp where code=room_code and user_id=uid;
    end if;
  end if;

  if p_action='leave' then
    update typequest_private.players set left_room=true, ready=false where code=room_code and user_id=uid;
    if r.host_id=uid then
      select user_id into r.host_id from typequest_private.players where code=room_code and not left_room order by last_seen desc,joined_at limit 1;
      if r.host_id is null then
        update typequest_private.rooms set phase='closed' where code=room_code;
      else
        update typequest_private.rooms set host_id=r.host_id where code=room_code;
      end if;
    end if;
    return jsonb_build_object('left',true);
  end if;

  -- Transfer hosting after 30 seconds without a heartbeat; the race keeps its clock.
  if not exists (select 1 from typequest_private.players where code=room_code and user_id=r.host_id and not left_room and last_seen > stamp-interval '30 seconds') then
    update typequest_private.rooms set host_id=uid where code=room_code returning * into r;
  end if;
  if r.phase='lobby' then
    delete from typequest_private.players where code=room_code and user_id<>uid and (left_room or last_seen < stamp-interval '30 seconds');
  end if;

  if p_action='ready' then
    if r.phase <> 'lobby' then raise exception 'The lobby is closed.'; end if;
    update typequest_private.players set ready=coalesce((p_payload->>'ready')::boolean,false) where code=room_code and user_id=uid;
  elsif p_action='start' then
    if r.host_id<>uid then raise exception 'Only the host can start the race.'; end if;
    if r.phase='lobby' then
      delete from typequest_private.players where code=room_code and (left_room or last_seen < stamp-interval '30 seconds');
      select count(*) into participants from typequest_private.players where code=room_code;
      if participants < 2 then raise exception 'At least two players are needed.'; end if;
      if exists(select 1 from typequest_private.players where code=room_code and (not ready or last_seen < stamp-interval '8 seconds')) then
        raise exception 'Wait for every player to be connected and ready.';
      end if;
      update typequest_private.rooms set phase='racing',starts_at=stamp+interval '5 seconds',expires_at=stamp+interval '2 hours',
        passage=repeat(case difficulty
          when 'easy' then 'the sun is warm and the sky is blue we take a walk by the lake and watch the birds fly home a small step each day can help us grow keep your hands calm and find your own pace '
          when 'expert' then 'At 7:45, Maya asked, "Ready for round #2?" Precision matters: 98% accuracy beats a careless sprint. Pack 6 boxes, check the labels (A-Z), and send them before Friday! A steady rhythm turns a difficult challenge into a satisfying victory. '
          else 'Beyond the quiet valley, a new adventure waits. Keep your eyes on the path and your fingers moving with a steady rhythm. Every small improvement brings you closer to the finish line. Practice builds confidence, and patience turns effort into progress. '
        end,24) where code=room_code returning * into r;
    end if;
  elsif p_action='rematch' then
    if r.host_id<>uid then raise exception 'Only the host can open a rematch.'; end if;
    if r.phase='results' then
      delete from typequest_private.players where code=room_code and user_id<>uid and (left_room or last_seen < stamp-interval '30 seconds');
      update typequest_private.rooms set phase='lobby',starts_at=null,passage='',round=round+1,expires_at=stamp+interval '2 hours' where code=room_code returning * into r;
      update typequest_private.players set ready=false,typed='',correct=0,attempts=0,errors=0,sequence=0,writer_id=null,writer_seen_at=null,finalized=false where code=room_code;
    elsif r.phase <> 'lobby' then raise exception 'Finish this race before starting a rematch.';
    end if;
  elsif p_action='sync' and p_payload ? 'typed' and r.phase='racing' and stamp >= r.starts_at then
    -- Stale tabs receive the latest snapshot instead of getting stuck retrying.
    next_sequence := coalesce((p_payload->>'sequence')::integer,0);
    if can_type and not changed_writer and not me.finalized and coalesce((p_payload->>'round')::integer,0)=r.round
      and (stamp < r.starts_at+make_interval(secs=>r.duration)
        or (p_payload->>'inputAt')::timestamptz between r.starts_at and r.starts_at+make_interval(secs=>r.duration))
      and next_sequence > me.sequence then
      new_text := coalesce(p_payload->>'typed','');
      if char_length(new_text)>char_length(r.passage) then raise exception 'Text exceeds the race passage.'; end if;
      -- A batch of key events preserves errors even when corrected between polls.
      -- The server computes correct positions and WPM; no client scores accepted.
      if p_payload->>'attempts' is null or p_payload->>'errors' is null
        or (p_payload->>'attempts')::integer<0 or (p_payload->>'errors')::integer<0
        or coalesce((p_payload->>'attempts')::integer,0)<me.attempts or coalesce((p_payload->>'errors')::integer,0)<me.errors
        or (p_payload->>'errors')::integer > (p_payload->>'attempts')::integer
        or (p_payload->>'attempts')::integer > least(10000,ceil(least(r.duration,extract(epoch from stamp-r.starts_at))*30)+30)
        or (p_payload->>'attempts')::integer < char_length(new_text) then
        raise exception 'Invalid typing update.';
      end if;
      select count(*) into good from generate_series(1,char_length(new_text)) i where substr(new_text,i,1)=substr(r.passage,i,1);
      bad := char_length(new_text)-good;
      if coalesce((p_payload->>'errors')::integer,0)<bad then raise exception 'Invalid error count.'; end if;
      update typequest_private.players set typed=new_text,correct=good,
        attempts=coalesce((p_payload->>'attempts')::integer,0), errors=coalesce((p_payload->>'errors')::integer,0), sequence=next_sequence
        where code=room_code and user_id=uid;
    end if;
    if can_type and coalesce((p_payload->>'round')::integer,0)=r.round
      and stamp >= r.starts_at+make_interval(secs=>r.duration) and p_payload->>'final'='true' then
      update typequest_private.players set finalized=true where code=room_code and user_id=uid;
    end if;
  end if;

  select jsonb_agg(jsonb_build_object(
    'id',p.user_id,'name',p.name,'ready',p.ready,'correct',p.correct,
    'attempts',p.attempts,'errors',p.errors,'sequence',p.sequence,
    'online',p.last_seen>stamp-interval '8 seconds','left',p.left_room,
    'wpm',round(p.correct*12.0/greatest(1,least(r.duration,extract(epoch from stamp-r.starts_at))))::integer,
    'accuracy',case when p.attempts>0 then round((p.attempts-p.errors)*100.0/p.attempts,1) else 0 end
  ) order by p.joined_at,p.user_id) into snapshot
  from typequest_private.players p where p.code=room_code and (r.phase<>'lobby' or not p.left_room);
  return jsonb_build_object('code',r.code,'hostId',r.host_id,'phase',r.phase,'duration',r.duration,
    'difficulty',r.difficulty,'round',r.round,'startsAt',r.starts_at,'serverNow',stamp,
    'passage',r.passage,'players',coalesce(snapshot,'[]'::jsonb),'canType',can_type,
    'myText',(select typed from typequest_private.players where code=room_code and user_id=uid));
end;
$$;
revoke all on function typequest_private.multiplayer(text,text,jsonb) from public,anon;
grant execute on function typequest_private.multiplayer(text,text,jsonb) to authenticated;

create or replace function public.typequest_multiplayer(p_action text, p_code text default '', p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select typequest_private.multiplayer(p_action,p_code,p_payload);
$$;
revoke all on function public.typequest_multiplayer(text,text,jsonb) from public,anon;
grant execute on function public.typequest_multiplayer(text,text,jsonb) to authenticated;

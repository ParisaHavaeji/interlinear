-- Interlinear sync (plan.md step 36): one row per user per book, the book's reading state as
-- `src/sync/engine.ts` pushes it. Run once in the project's SQL editor (see README.md here).

create table if not exists public.reading_state (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- The content key of the book (src/sync/key.ts): the same book on every device.
  book_key   text        not null,
  title      text        not null default '',
  langs      text[]      not null default '{}',
  -- The reader's place: {chapter, para, fraction, read, updated}; null when never opened.
  progress   jsonb,
  -- The book's bookmarks, as the app stores them without the book id.
  bookmarks  jsonb       not null default '[]'::jsonb,
  -- The pushing device's change stamp (Unix ms). Last write wins on this, see below.
  updated    bigint      not null,
  synced_at  timestamptz not null default now(),
  primary key (user_id, book_key)
);

-- Every user sees and writes their own rows only. The app signs requests with the anon key
-- and the user's token; the anon key alone matches no row.
alter table public.reading_state enable row level security;

drop policy if exists "own reading state" on public.reading_state;
create policy "own reading state"
  on public.reading_state
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Last write wins, decided on the server: an upsert whose stamp is not newer than the row's is
-- dropped, so two devices pushing the same book cannot lose the newer state. The device whose
-- push was dropped pulls the newer row on its next look.
create or replace function public.reading_state_keep_newer()
returns trigger
language plpgsql
as $$
begin
  if new.updated <= old.updated then
    return null;
  end if;
  new.synced_at := now();
  return new;
end
$$;

drop trigger if exists reading_state_keep_newer on public.reading_state;
create trigger reading_state_keep_newer
  before update on public.reading_state
  for each row
  execute function public.reading_state_keep_newer();

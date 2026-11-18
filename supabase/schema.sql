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
  -- Step 37: the book itself, kept in the `books` bucket below. Size in bytes of the gzipped
  -- bundle, and the alignment stamp (Unix ms) of the copy uploaded; null while there is none.
  bundle_size bigint,
  bundle_at   bigint,
  primary key (user_id, book_key)
);

-- Step 37 on a project set up for step 36: the two columns, added in place.
alter table public.reading_state add column if not exists bundle_size bigint;
alter table public.reading_state add column if not exists bundle_at bigint;

-- Every user sees and writes their own rows only. The app signs requests with the anon key
-- and the user's token; the anon key alone matches no row.
alter table public.reading_state enable row level security;

-- New projects may not expose new tables to the Data API by default; the app needs these.
grant select, insert, update, delete on public.reading_state to authenticated;

drop policy if exists "own reading state" on public.reading_state;
create policy "own reading state"
  on public.reading_state
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Last write wins, decided on the server: the reading state of an upsert whose stamp is not
-- newer than the row's is dropped, so two devices pushing the same book cannot lose the newer
-- state. The device whose push was dropped pulls the newer row on its next look. The bundle
-- columns (step 37) are judged on their own stamp: an upload sends `updated` 0 and only the
-- bundle columns, which are kept when newer while the reading state stays as it was.
create or replace function public.reading_state_keep_newer()
returns trigger
language plpgsql
as $$
begin
  if new.updated <= old.updated then
    new.title := old.title;
    new.langs := old.langs;
    new.progress := old.progress;
    new.bookmarks := old.bookmarks;
    new.updated := old.updated;
  end if;
  if coalesce(new.bundle_at, 0) < coalesce(old.bundle_at, 0) then
    new.bundle_at := old.bundle_at;
    new.bundle_size := old.bundle_size;
  end if;
  if new is not distinct from old then
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

-- Step 37: the books themselves. One gzipped bundle (`src/store/bundle.ts`) per user and book at
-- `<user id>/<book key>.interlinear.json.gz`, in a private bucket: nothing in it is public, and
-- each account reads, writes and deletes under its own folder only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('books', 'books', false, 52428800, array['application/gzip'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "own books read" on storage.objects;
create policy "own books read"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own books insert" on storage.objects;
create policy "own books insert"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own books update" on storage.objects;
create policy "own books update"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own books delete" on storage.objects;
create policy "own books delete"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

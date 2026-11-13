# Sync setup (plan.md step 36)

Signing in with Google keeps each book's reading place and bookmarks on a Supabase project, so
the same book imported on another device opens where it was left. Books stay on the device.
The app talks to Supabase straight from the page (`src/sync/`), with the project's public anon
key; nothing runs on a server of ours, and row-level security keeps every account to its own
rows. Without the two environment variables below the build has no Account group at all.

## One-time setup

1. **Supabase project.** Create a free project at supabase.com. In *Project Settings → API*
   note the *Project URL* and the *anon public* key.

2. **Table and policies.** Open the *SQL Editor*, paste [`schema.sql`](schema.sql) and run it.
   It creates `reading_state`, turns on row-level security, and installs the trigger that keeps
   the newer of two writes.

3. **Google OAuth client.** In the Google Cloud console make a project, set up the *OAuth
   consent screen* (external, the app's name, your address; only the basic profile and email
   scopes are used, so no verification review is needed, but *publish* the app or only the test
   users you list can sign in). Then *Credentials → Create credentials → OAuth client ID*, type
   *Web application*, with this authorised redirect URI:

       https://<project-ref>.supabase.co/auth/v1/callback

   Copy the client ID and secret.

4. **Google provider in Supabase.** *Authentication → Sign In / Providers → Google*: turn it
   on and paste the client ID and secret.

5. **Redirect URLs.** *Authentication → URL Configuration*: set the *Site URL* to the app's
   address and add the places the app runs to *Redirect URLs*, each with a trailing slash:

       https://<user>.github.io/<repo>/
       http://localhost:5173/

   The app sends the browser back to its own root (`BASE_URL`), so the list is exact.

6. **Build variables.** In the GitHub repository, *Settings → Secrets and variables → Actions →
   Variables*, add `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The Pages workflow passes them to the
   build as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. For development, copy
   `.env.example` to `.env.local` and fill the same two values; `.env.local` is not committed.

## Check it on the phone

The one thing to prove on the installed app before trusting the sync: *Settings → Sign in with
Google*, through Google, back to Settings signed in. iOS opens the Google page in an in-app
browser and hands the app's URL back when it redirects; the app then shows "Signing in…" and
the account row. If it lands in Safari instead, the fix is on the iOS side (open the app from
the Home Screen and try once more), not in the project settings.

## How it syncs

- Every change to a book's progress or bookmarks stamps the book's `sync` row in IndexedDB;
  the engine pushes the stamped books a few seconds after the last change.
- On launch, on coming back online and when the app is shown again, it pulls: reads every
  row's stamp, fetches the rows newer than the device's state and applies them, pushes the
  books newer on the device.
- Last write wins per book, on the whole state (place and bookmarks together). The server
  drops an update with an older stamp, so a slow push from one device never replaces a newer
  state from another.
- Deleting a book on a device leaves its row on the server; re-importing the same files picks
  the state up again. Signing out keeps the state on the device and forgets what was pushed,
  so the next account is sent everything.

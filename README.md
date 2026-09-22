# Work Hours — v0.0

A small installable web app (PWA) for logging work shifts. Sign in with Google;
each account gets its own private set of hours, synced live across devices and
usable offline.

- **Clock in / clock out.** One tap to start. The running timer is shared
  across devices, so you can clock in on the iPhone and out on the Mac. Clocking
  out opens a pre-filled form where you can add a break or a note before saving.
- **Manual entry**: date, start, end, break, rate (pre-filled from your default)
  and a note. If the end time is earlier than the start time, the shift ends the
  next day.
- **Monthly view**: shifts grouped by day, newest first, with hours and earnings
  for each shift, each day and the whole month. Tap a shift to edit or delete it.
- **PDF export** of the month shown. On iPhone it opens the share sheet.
- **Offline**: entries saved without a connection are marked with an amber dot
  and sync automatically once you're back online.

Stack: Vite + vanilla TypeScript, Firebase Auth + Firestore (modular SDK),
vite-plugin-pwa, jsPDF + jspdf-autotable.

## Data model

```
users/{uid}/settings/main      { defaultRate, currency }
users/{uid}/state/clock        { start }            // present only while clocked in
users/{uid}/entries/{entryId}  { date, start, end, breakMinutes, rate, note,
                                 createdAt, updatedAt }
```

Hours and earnings are never stored. They are computed when read:
`hours = (end − start) / 3 600 000 − breakMinutes / 60`, `earnings = hours × rate`.
`date` is the local start date (`YYYY-MM-DD`) and decides which day a shift is
listed under.

Settings live at `settings/main` because Firestore document paths need an even
number of segments, so `users/{uid}/settings` alone can't be a document.

**Isolation** is enforced server-side by [`firestore.rules`](firestore.rules):
a user can only read or write documents under their own `users/{uid}`. Entry
writes are also validated for field types, `end > start` and note length.
Signing out clears that device's offline cache.

## Setup

1. **Create a Firebase project** at <https://console.firebase.google.com>.
2. **Authentication** → Sign-in method → enable **Google**.
3. **Firestore Database** → Create database (production mode).
4. **Project settings → Your apps → Add web app**, then copy the config values.
5. Configure and run locally:

   ```sh
   npm install
   cp .env.example .env      # paste the config values
   npm run dev
   ```

6. **Deploy** to Firebase Hosting, which is the recommended host (see the iPhone note below):

   ```sh
   npm install -g firebase-tools
   firebase login
   firebase use --add        # pick your project
   npm run deploy            # builds, deploys hosting + firestore.rules
   ```

   Open `https://<project>.web.app`. On iPhone, open it in Safari, then
   Share → **Add to Home Screen**. On Mac, use Safari's File → **Add to Dock**, or
   Chrome's install button.

If you host somewhere else, add that domain under Authentication → Settings →
**Authorized domains**, and deploy the rules with `firebase deploy --only firestore:rules`.

### Sign-in inside the installed iPhone app

In an installed PWA, popups fail silently, so the app detects standalone mode
and uses `signInWithRedirect` there. It uses popups everywhere else. Safari
partitions third-party storage, so the redirect only completes if the auth
handler is served from the **same domain as the app**. On Firebase Hosting
(`*.web.app` / `*.firebaseapp.com`) the app sets `authDomain` to its own host
automatically, so this just works. On another host, you need to proxy
`/__/auth/*` to Firebase and set `VITE_FIREBASE_AUTH_DOMAIN` to your domain.

## Scripts

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Dev server with hot reload                      |
| `npm run typecheck` | `tsc --noEmit`                                  |
| `npm run build`     | Type-check + production build into `dist/`      |
| `npm run preview`   | Serve the production build locally              |
| `npm run deploy`    | Build, then deploy hosting and Firestore rules  |

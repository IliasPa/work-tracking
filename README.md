# Work Hours

See [CHANGES.md](CHANGES.md) for what each version added.

A small installable web app (PWA) for logging work shifts. Sign in with Google;
each account gets its own private set of hours, synced live across devices and
usable offline.

- **Clock in / clock out.** One tap to start. The running timer is shared
  across devices, so you can clock in on the iPhone and out on the Mac. Clocking
  out opens a pre-filled form where you can add a break or a note before saving.
- **Manual entry**: date, start, end, break, rate (pre-filled from your default)
  and a note. If the end time is earlier than the start time, the shift ends the
  next day.
- **Date-range filter**: From / To plus one-tap presets (this week, this month,
  last month, this year). Shifts are grouped by day, newest first, with hours and
  earnings per shift, per day and for the whole range. Tap a shift to edit or
  delete it. The chosen range is remembered on that device.
- **Jobs / clients**: each with its own rate and client details. New shifts
  default to the job used last; a filter narrows the list and the exports to one
  job.
- **Pay multipliers**: overtime after N hours in a shift, a night window and
  Sunday. Only the highest applies to any minute, breaks spread across the
  shift, and totals show paid hours next to worked hours. Each shift keeps the
  multipliers it was saved with, so changing them never re-values past work.
- **Times don't travel**: clock times are stored as worked, so a shift reads and
  pays the same in any timezone.
- **Paid / unpaid**: mark a shift paid, see what you're still owed for the range,
  and mark everything shown as paid in one go.
- **Overlap warning**: shifts covering the same hours are flagged in the list and
  while you edit, so the same time never gets counted (or billed) twice.
- **Export the filtered range**: timesheet PDF (A4 portrait, fixed columns,
  TOTAL row), CSV (every column, including job, paid hours and
  multiplier), and an **invoice PDF** with your details, the client's, a line per
  shift, VAT and total. On iPhone all three open the share sheet.
- **Settings pop-up** behind the app logo (the account corner keeps only sign-out): hourly rate, currency (20 common ones,
  EUR by default), the start/end/break that pre-fill a new entry, and which
  columns the PDF report includes.
- **Offline**: entries saved without a connection are tagged "Syncing" and sync
  automatically once you're back online.

Stack: Vite + vanilla TypeScript, Firebase Auth + Firestore (modular SDK),
vite-plugin-pwa, jsPDF + jspdf-autotable.

## Data model

```
users/{uid}/settings/main      { defaultRate, currency, default start/end/break,
                                 lastJobId, pay multipliers, invoice details,
                                 report column toggles }
users/{uid}/state/clock        { start }            // present only while clocked in
users/{uid}/jobs/{jobId}       { name, rate, clientName, clientDetails }
users/{uid}/entries/{entryId}  { date, start, end, breakMinutes, rate, note,
                                 paid, jobId, createdAt, updatedAt }
```

Hours and earnings are never stored. They are computed when read:
`hours = (end − start) / 3 600 000 − breakMinutes / 60`. Earnings are
`paid hours × rate`, where paid hours apply the multipliers minute by minute
(see [`src/pay.ts`](src/pay.ts)); with no multipliers set, paid hours are simply
the hours worked.
`date` is the local start date (`YYYY-MM-DD`) and decides which day a shift is
listed under.

Settings live at `settings/main` because Firestore document paths need an even
number of segments, so `users/{uid}/settings` alone can't be a document.

**Access** is invite-only and enforced server-side by
[`firestore.rules`](firestore.rules): an account must be listed in
`allowed/{email}` (or be the owner) before it can read or write anything, and it
can only ever reach documents under its own `users/{uid}`. The owner manages the
list in the app, under Settings → Who can use this app, and `VITE_OWNER_EMAIL`
in `.env` must match the owner address hard-coded in the rules.

Note what this does **not** cover: whoever owns the Firebase project can read
every document in it from the console. Rules constrain the app, not the owner.

Signing out clears that device's offline cache.

The rules do not check the *shape* of what is written (that an end is after its
start, say); only the app writes data, and it validates before saving.

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

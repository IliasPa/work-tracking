# Changes

Newest first. Each version is one commit in this repository.

## v1.0 — 2026-09-23

**Earnings stop moving**

- Each shift now saves the multipliers in force when it was logged, and is paid
  by those from then on. Changing a multiplier no longer re-values work you have
  already invoiced.
- Editing a shift keeps its saved multipliers; a line in the form says so and
  offers "Use current rules" when they differ from today's.
- Shifts logged before v1.0 have nothing saved, so they still follow the current
  rules until you edit them.

**Times stay where they were worked**

- Shifts store the clock times as typed, so a shift logged 22:00–06:00 in Athens
  still reads 22:00–06:00 anywhere else. Lists, PDFs and CSV all use them.
- Night and Sunday multipliers are judged by the clock where the shift happened,
  so travelling can no longer change what a past shift pays.
- Hours worked are still measured from the real instants, so a night across a
  daylight-saving change still counts the extra hour.

**Sharing it with other people**

- Invite-only: only accounts on the list (plus the owner) can sign in and store
  anything, enforced by the security rules. Everyone else gets a "no access yet"
  screen.
- The owner manages the list under Settings → Who can use this app.
- The sign-in screen says plainly that whoever runs the app can see what is
  stored in it.
- Settings → Your data: export everything as JSON, or delete the account's data
  outright.

## v0.3 — 2026-09-23

- Settings are reached only from the app logo; the account menu now holds just
  the signed-in account and Sign out.
- The "Add entry" button became a floating + in the bottom-right corner.
- The timesheet PDF is always portrait. A wide report (many columns) is fitted
  by tightening the type and columns and shortening the multiplier tags to
  OT / NT / SU, instead of turning the page sideways.

## v0.2 — 2026-09-23

**Jobs and clients**

- Jobs (or clients), each with its own hourly rate and client details, managed
  under Settings → Jobs & clients.
- New shifts default to the job you used last, or to the one you're filtering by.
  Picking a job fills in its rate.
- A job filter above the list, and the job shown on every shift.
- Deleting a job keeps the shifts; they simply show no job.

**Pay multipliers**

- Overtime after a set number of hours in a shift, a night window (e.g.
  22:00–06:00) and Sunday, each with its own multiplier.
- Where several apply to the same minute, only the highest counts; they never
  stack. The break is spread evenly across the shift rather than taken off one
  end, and overtime counts worked hours, not clock time.
- Shifts show which multiplier applied, and totals gain a "Paid h" figure
  whenever it differs from hours worked.
- Changing a multiplier re-values past shifts as well, since pay is always
  calculated from the rules rather than stored.

**Invoices**

- Invoice-style PDF: your details and the client's, invoice number, date, due
  date, one line per shift, subtotal, optional VAT and total, plus payment
  details.
- Invoice numbers run from a prefix and a counter that steps on each invoice.
- Defaults to unpaid shifts only, and to the job being filtered.

**Other**

- The timesheet PDF turns landscape when it has many columns, so job names and
  notes are no longer cut short.
- CSV gained Job, Paid hours and Multiplier columns.
- One project folder instead of a folder per version; versions live in git
  history and are written up here.

## v0.1 — 2026-09-22

- Date-range filter (From / To plus this week, this month, last month, this
  year) replacing the month stepper, with totals for the range. The range is
  remembered per device.
- Settings moved behind the app logo: default rate, currency (20 common ones),
  default start/end/break, and which columns the PDF report shows.
- Straightened the PDF report: fixed columns, right-aligned figures, one line
  per shift, the range in the title and a TOTAL row.
- CSV export of the filtered range.
- Paid / unpaid per shift, an unpaid total and a mark-all-paid action.
- Overlap warnings, in the list and while editing a shift, to catch the same
  hours logged twice.

## v0.0 — 2026-09-22

- First version: Google sign-in, private per-user data in Firestore, clock in /
  clock out synced across devices, manual entries with overnight support, a live
  list grouped by day with daily subtotals, monthly PDF export, offline support
  and installable as a PWA.

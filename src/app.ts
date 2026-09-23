import type { User } from 'firebase/auth';
import { clearIndexedDbPersistence, terminate, type Unsubscribe } from 'firebase/firestore';
import { completeRedirect, signIn, signOut, watchUser } from './auth';
import {
  DEFAULT_SETTINGS,
  addEntry,
  cancelClock,
  clockIn,
  clockOut,
  deleteEntry,
  deleteJob,
  saveJob,
  saveSettings,
  setPaid,
  updateEntry,
  watchClock,
  watchEntries,
  watchJobs,
  watchSettings,
  type ClockState,
  type Entry,
  type EntryInput,
  type Job,
  type Settings,
} from './data';
import { db } from './firebase';
import { payFor, reasonsApplied, type Pay } from './pay';
import {
  RANGE_PRESETS,
  buildRange,
  formatDuration,
  formatHours,
  formatMoney,
  formatRange,
  hoursOf,
  isOvernight,
  matchingPreset,
  monthBounds,
  overlappingIds,
  parseDateStr,
  presetRange,
  toDateStr,
  toTimeStr,
  type DateRange,
  type RangePreset,
} from './time';

// ---------------------------------------------------------------------------
// State

let root: HTMLElement;
let user: User | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let jobs: Job[] = [];
let clock: ClockState | null = null;
let entries: Entry[] = [];
let overlaps = new Set<string>();
let range: DateRange = monthBounds(new Date());
/** '' = all jobs. */
let jobFilter = '';
let listeners: Unsubscribe[] = [];
let entriesUnsub: Unsubscribe | null = null;
let tickTimer: number | undefined;
let signInError = '';

type EntryMode = { kind: 'add' } | { kind: 'edit'; id: string } | { kind: 'clockout' };
let entryMode: EntryMode = { kind: 'add' };
let jobEditId: string | null = null;

const RANGE_KEY = 'hours.range';
const JOB_FILTER_KEY = 'hours.job';

// 20 common currencies; EUR first as the default.
const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF',
  'RON', 'BGN', 'TRY', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'INR', 'AED',
];

// ---------------------------------------------------------------------------
// Helpers

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const money = (n: number) => formatMoney(n, settings.currency);
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const payOf = (e: Entry): Pay => payFor(e, settings);
const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? (id ? '(deleted job)' : '');
/** Entries the current job filter lets through. */
const shown = (): Entry[] => (jobFilter ? entries.filter((e) => e.jobId === jobFilter) : entries);

let toastTimer: number | undefined;
function toast(msg: string, kind: 'info' | 'error' = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : 2500);
}

function reportError(e: unknown) {
  console.error(e);
  toast(e instanceof Error ? e.message : String(e), 'error');
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback; // Private mode or blocked storage.
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not important enough to bother the user about.
  }
}

function addDays(date: string, days: number): string {
  const d = parseDateStr(date);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// ---------------------------------------------------------------------------
// Boot / auth

export function start(el: HTMLElement) {
  root = el;
  root.innerHTML = `<main class="center"><div class="spinner" aria-label="Loading"></div></main>`;

  completeRedirect().catch((e) => {
    signInError = friendlyAuthError(e);
    if (!user) renderSignIn();
  });

  watchUser((u) => {
    if (u && u.uid === user?.uid) return;
    teardown();
    user = u;
    if (u) renderMain();
    else renderSignIn();
  });
}

function friendlyAuthError(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  if (code === 'auth/unauthorized-domain') return 'This domain is not authorized for sign-in in the Firebase console.';
  return (e as Error)?.message || 'Sign-in failed.';
}

function teardown() {
  listeners.forEach((u) => u());
  listeners = [];
  entriesUnsub?.();
  entriesUnsub = null;
  clearInterval(tickTimer);
  settings = DEFAULT_SETTINGS;
  clock = null;
  entries = [];
  jobs = [];
  overlaps = new Set();
}

async function doSignOut() {
  teardown();
  await signOut();
  // Wipe this user's offline cache so the next person on this device sees nothing.
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (e) {
    console.warn('Could not clear offline cache', e);
  }
  location.reload();
}

// ---------------------------------------------------------------------------
// Sign-in screen

const GOOGLE_G = `<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

function renderSignIn() {
  root.innerHTML = `
    <main class="center">
      <div class="signin">
        <img src="/icons/icon.svg" alt="" class="signin-logo" width="72" height="72">
        <h1>Work Hours</h1>
        <p class="muted">Log shifts in seconds. Synced across your devices, visible only to you.</p>
        <button class="btn google" id="signin-btn">${GOOGLE_G}<span>Sign in with Google</span></button>
        <p class="error" id="signin-error" ${signInError ? '' : 'hidden'}>${esc(signInError)}</p>
      </div>
    </main>`;
  const btn = $<HTMLButtonElement>('#signin-btn');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await signIn();
    } catch (e) {
      const err = $('#signin-error');
      err.textContent = friendlyAuthError(e);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Main screen

function renderMain() {
  const u = user!;
  const name = u.displayName || u.email || 'Account';
  const initial = esc(name.trim().charAt(0).toUpperCase());
  const avatar = u.photoURL
    ? `<img class="avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar fallback">${initial}</span>`;
  range = readStored<DateRange>(RANGE_KEY, monthBounds(new Date()));
  jobFilter = readStored<string>(JOB_FILTER_KEY, '');

  root.innerHTML = `
    <header class="topbar">
      <button class="brand" id="settings-btn" title="Settings" aria-label="Settings">
        <img src="/icons/icon.svg" alt="" width="28" height="28"><span>Hours</span>
      </button>
      <div class="account">
        <button class="account-btn" id="account-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(u.email ?? '')}">
          ${avatar}<span class="account-name">${esc(name)}</span>
        </button>
        <div class="menu" id="account-menu" role="menu" hidden>
          <div class="menu-head"><strong>${esc(name)}</strong><small>${esc(u.email ?? '')}</small></div>
          <button role="menuitem" id="menu-signout" class="danger">Sign out</button>
        </div>
      </div>
    </header>

    <main class="container">
      <section class="card clock" id="clock"></section>

      <section class="card filter">
        <div class="chips" id="presets">
          ${RANGE_PRESETS.map((p) => `<button class="chip" data-preset="${p}">${p}</button>`).join('')}
        </div>
        <div class="row dates">
          <label>From<input type="date" id="from"></label>
          <label>To<input type="date" id="to"></label>
        </div>
        <label class="job-filter" id="job-filter-wrap" hidden>Job<select id="job-filter"></select></label>
      </section>

      <div class="card summary" id="summary"></div>
      <div id="list"></div>
    </main>

    <button class="fab" id="add-btn" title="Add entry" aria-label="Add entry">+</button>

    ${entryDialogHtml()}
    ${settingsDialogHtml()}
    ${jobDialogHtml()}
    ${invoiceDialogHtml()}
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`;

  const img = root.querySelector<HTMLImageElement>('img.avatar');
  if (img) img.onerror = () => (img.outerHTML = `<span class="avatar fallback">${initial}</span>`);

  wireAccountMenu();
  wireEntryDialog();
  wireSettingsDialog();
  wireJobDialog();
  wireInvoiceDialog();
  wireFilter();

  $('#settings-btn').onclick = openSettingsDialog;
  $('#add-btn').onclick = () => openEntryDialog({ kind: 'add' });
  $('#list').onclick = (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (row) openEntryDialog({ kind: 'edit', id: row.dataset.id! });
  };

  renderClock();
  renderRange();

  listeners.push(
    watchSettings(u.uid, (s) => {
      settings = s;
      renderRange();
    }),
    watchJobs(
      u.uid,
      (list) => {
        jobs = list;
        renderJobFilter();
        renderRange();
      },
      reportError,
    ),
    watchClock(u.uid, (c) => {
      clock = c;
      renderClock();
    }),
  );
  subscribeEntries();

  tickTimer = window.setInterval(updateElapsed, 15_000);
  document.addEventListener('visibilitychange', updateElapsed);

  // Warm the PDF module + font in the background so export is instant later.
  const warm = () => import('./pdf').then((m) => m.loadFont()).catch(() => {});
  'requestIdleCallback' in window ? requestIdleCallback(warm) : setTimeout(warm, 3000);
}

function wireAccountMenu() {
  const btn = $('#account-btn');
  const menu = $('#account-menu');
  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.onclick = (ev) => {
    ev.stopPropagation();
    setOpen(Boolean(menu.hidden));
  };
  document.addEventListener('click', (ev) => {
    if (!menu.hidden && !menu.contains(ev.target as Node)) setOpen(false);
  });
  $('#menu-signout').onclick = () => {
    setOpen(false);
    doSignOut().catch(reportError);
  };
}

// ---------------------------------------------------------------------------
// Clock in / out

function renderClock() {
  const el = $('#clock');
  if (!clock) {
    el.classList.remove('active');
    el.innerHTML = `
      <div class="clock-status muted">Not clocked in</div>
      <button class="btn primary big" id="clock-in">Clock in</button>`;
    $('#clock-in').onclick = () => clockIn(user!.uid).catch(reportError);
    return;
  }
  const since = clock.start;
  const sameDay = toDateStr(since) === toDateStr(new Date());
  el.classList.add('active');
  el.innerHTML = `
    <div class="clock-status"><span class="live-dot"></span>Clocked in since ${toTimeStr(since)}${sameDay ? '' : ` · ${dayFmt.format(since)}`}</div>
    <div class="elapsed" id="elapsed"></div>
    <button class="btn danger big" id="clock-out">Clock out</button>
    <button class="link-btn" id="clock-discard">Discard</button>`;
  updateElapsed();
  $('#clock-out').onclick = () => openEntryDialog({ kind: 'clockout' });
  $('#clock-discard').onclick = () => {
    if (confirm('Discard the current clock-in? Nothing will be saved.')) cancelClock(user!.uid).catch(reportError);
  };
}

function updateElapsed() {
  const el = root.querySelector('#elapsed');
  if (el && clock) el.textContent = formatDuration(Date.now() - clock.start.getTime());
}

// ---------------------------------------------------------------------------
// Filters

function wireFilter() {
  $('#presets').onclick = (ev) => {
    const preset = (ev.target as HTMLElement).closest<HTMLElement>('[data-preset]')?.dataset.preset;
    if (preset) setRange(presetRange(preset as RangePreset));
  };
  const from = $<HTMLInputElement>('#from');
  const to = $<HTMLInputElement>('#to');
  from.onchange = () => setRange({ from: from.value, to: from.value > to.value ? from.value : to.value });
  to.onchange = () => setRange({ from: to.value < from.value ? to.value : from.value, to: to.value });
  $<HTMLSelectElement>('#job-filter').onchange = (ev) => {
    jobFilter = (ev.target as HTMLSelectElement).value;
    store(JOB_FILTER_KEY, jobFilter);
    renderRange();
  };
}

function renderJobFilter() {
  const wrap = $('#job-filter-wrap');
  const sel = $<HTMLSelectElement>('#job-filter');
  wrap.hidden = jobs.length === 0;
  if (jobFilter && !jobs.some((j) => j.id === jobFilter)) jobFilter = '';
  sel.innerHTML =
    `<option value="">All jobs</option>` +
    jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.name)}</option>`).join('');
  sel.value = jobFilter;
}

function setRange(next: DateRange) {
  if (!next.from || !next.to) return;
  if (next.from === range.from && next.to === range.to) return;
  range = next;
  store(RANGE_KEY, range);
  entries = [];
  overlaps = new Set();
  subscribeEntries();
  renderRange();
}

function subscribeEntries() {
  entriesUnsub?.();
  entriesUnsub = watchEntries(
    user!.uid,
    range.from,
    range.to,
    (list) => {
      entries = list;
      overlaps = overlappingIds(list);
      renderRange();
    },
    reportError,
  );
}

/** Repaints everything that depends on the range: inputs, totals and the list. */
function renderRange() {
  if (!root.querySelector('#summary')) return;
  $<HTMLInputElement>('#from').value = range.from;
  $<HTMLInputElement>('#to').value = range.to;
  const active = matchingPreset(range);
  root.querySelectorAll<HTMLElement>('[data-preset]').forEach((el) => {
    el.classList.toggle('on', el.dataset.preset === active);
  });
  renderSummary();
  renderList();
}

function renderSummary() {
  const list = shown();
  const pays = list.map(payOf);
  const totalHours = list.reduce((s, e) => s + hoursOf(e), 0);
  const totalPaidHours = pays.reduce((s, p) => s + p.paidHours, 0);
  const totalEarn = pays.reduce((s, p) => s + p.earnings, 0);
  const unpaid = list.filter((e) => !e.paid);
  const unpaidEarn = unpaid.reduce((s, e) => s + payOf(e).earnings, 0);
  const shownOverlaps = list.filter((e) => overlaps.has(e.id)).length;
  const extraHours = totalPaidHours - totalHours;

  $('#summary').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="stat-label">Hours</span><span class="stat-value">${totalHours.toFixed(2)}</span></div>
      ${
        Math.abs(extraHours) > 0.005
          ? `<div class="stat"><span class="stat-label">Paid h</span><span class="stat-value">${totalPaidHours.toFixed(2)}</span></div>`
          : ''
      }
      <div class="stat"><span class="stat-label">Earned</span><span class="stat-value">${money(totalEarn)}</span></div>
      <div class="stat"><span class="stat-label">Shifts</span><span class="stat-value">${list.length}</span></div>
    </div>
    ${
      shownOverlaps
        ? `<p class="warn">⚠︎ ${shownOverlaps} shifts overlap in this range — check for hours logged twice.</p>`
        : ''
    }
    ${
      unpaid.length
        ? `<div class="unpaid-row">
             <span class="muted">Unpaid: <strong>${money(unpaidEarn)}</strong> over ${unpaid.length} shift${unpaid.length === 1 ? '' : 's'}</span>
             <button class="btn ghost small" id="mark-paid">Mark all paid</button>
           </div>`
        : ''
    }
    <div class="exports">
      <button class="btn ghost small" id="export-pdf" ${list.length ? '' : 'disabled'}>PDF</button>
      <button class="btn ghost small" id="export-csv" ${list.length ? '' : 'disabled'}>CSV</button>
      <button class="btn ghost small" id="export-invoice" ${list.length ? '' : 'disabled'}>Invoice</button>
    </div>`;

  $('#export-pdf').onclick = exportRangePdf;
  $('#export-csv').onclick = exportRangeCsv;
  $('#export-invoice').onclick = openInvoiceDialog;
  const markPaid = root.querySelector<HTMLButtonElement>('#mark-paid');
  if (markPaid) {
    markPaid.onclick = () => {
      if (!confirm(`Mark ${unpaid.length} shift${unpaid.length === 1 ? '' : 's'} as paid?`)) return;
      markPaid.disabled = true;
      setPaid(
        user!.uid,
        unpaid.map((e) => e.id),
        true,
      ).catch(reportError);
      toast('Marked as paid');
    };
  }
}

function renderList() {
  const el = $('#list');
  const list = shown();
  if (!list.length) {
    el.innerHTML = `<p class="empty">No shifts in ${esc(formatRange(range))}${jobFilter ? ` for ${esc(jobName(jobFilter))}` : ''}.</p>`;
    return;
  }

  const days = new Map<string, Entry[]>();
  for (const e of list) {
    const arr = days.get(e.date);
    if (arr) arr.push(e);
    else days.set(e.date, [e]);
  }

  el.innerHTML = [...days]
    .map(([date, items]) => {
      const h = items.reduce((s, e) => s + hoursOf(e), 0);
      const m = items.reduce((s, e) => s + payOf(e).earnings, 0);
      return `
        <section class="day">
          <header class="day-head">
            <span>${esc(dayFmt.format(parseDateStr(date)))}</span>
            <span class="day-total">${formatHours(h)} · ${money(m)}</span>
          </header>
          <ul class="card entries">${items.map(entryRowHtml).join('')}</ul>
        </section>`;
    })
    .join('');
}

function entryRowHtml(e: Entry): string {
  const pay = payOf(e);
  const meta = [jobName(e.jobId), e.breakMinutes ? `${e.breakMinutes}m break` : '', `${money(e.rate)}/h`]
    .filter(Boolean)
    .join(' · ');
  const tags = [
    ...reasonsApplied(pay).map((r) => `<span class="tag mult">${r}</span>`),
    e.paid ? '<span class="tag paid">Paid</span>' : '',
    overlaps.has(e.id) ? '<span class="tag warn" title="Overlaps another shift">Overlap</span>' : '',
    e.pending ? '<span class="tag pending" title="Waiting to sync">Syncing</span>' : '',
  ].join('');
  return `
    <li>
      <button class="entry" data-id="${esc(e.id)}">
        <span class="entry-main">
          <span class="entry-time">${toTimeStr(e.start)} – ${toTimeStr(e.end)}${
            isOvernight(e.start, e.end) ? '<sup title="Ends the next day">+1</sup>' : ''
          }</span>
          <span class="entry-meta">${esc(meta)}</span>
          ${e.note ? `<span class="entry-note">${esc(e.note)}</span>` : ''}
          ${tags ? `<span class="tags">${tags}</span>` : ''}
        </span>
        <span class="entry-nums">
          <strong>${formatHours(hoursOf(e))}</strong>
          <span>${money(pay.earnings)}</span>
        </span>
      </button>
    </li>`;
}

// ---------------------------------------------------------------------------
// Export

function exportFileName(ext: string): string {
  return `work-hours-${range.from}_${range.to}.${ext}`;
}

async function exportRangePdf() {
  const btn = $<HTMLButtonElement>('#export-pdf');
  btn.disabled = true;
  try {
    const { exportPdf } = await import('./pdf');
    await exportPdf({
      kind: 'report',
      range,
      rangeLabel: formatRange(range) + (jobFilter ? ` · ${jobName(jobFilter)}` : ''),
      userName: user!.displayName || user!.email || '',
      currency: settings.currency,
      rules: settings,
      columns: {
        break: settings.reportBreak,
        rate: settings.reportRate,
        earnings: settings.reportEarnings,
        note: settings.reportNote,
      },
      entries: shown(),
      jobs,
      fileName: exportFileName('pdf'),
    });
  } catch (e) {
    reportError(e);
  } finally {
    btn.disabled = false;
  }
}

async function exportRangeCsv() {
  const btn = $<HTMLButtonElement>('#export-csv');
  btn.disabled = true;
  try {
    const { exportCsv } = await import('./csv');
    await exportCsv(shown(), settings, jobs, exportFileName('csv'), `Work hours — ${formatRange(range)}`);
  } catch (e) {
    reportError(e);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Entry dialog (add / edit / clock-out)

function entryDialogHtml(): string {
  return `
    <dialog id="entry-dialog">
      <form id="entry-form" novalidate>
        <h2 id="entry-title" tabindex="-1" autofocus>Add entry</h2>
        <label id="entry-job-wrap" hidden>Job<select name="jobId" id="entry-job"></select></label>
        <label>Date<input type="date" name="date" required></label>
        <div class="row">
          <label>Start<input type="time" name="start" required></label>
          <label>End<input type="time" name="end" required></label>
        </div>
        <div class="row">
          <label>Break (min)<input type="number" name="break" min="0" step="1" inputmode="numeric"></label>
          <label>Rate / hour<input type="number" name="rate" min="0" step="0.01" inputmode="decimal"></label>
        </div>
        <label>Note<input type="text" name="note" maxlength="500" placeholder="Optional" autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="paid"><span>Paid</span></label>
        <p class="preview" id="entry-preview"></p>
        <p class="warn" id="entry-overlap" hidden></p>
        <p class="error" id="entry-error" hidden></p>
        <div class="actions">
          <button type="button" class="btn danger-ghost" id="entry-delete" hidden>Delete</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="entry-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </dialog>`;
}

function entryForm() {
  const f = $<HTMLFormElement>('#entry-form');
  const field = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
  return {
    f,
    job: f.elements.namedItem('jobId') as HTMLSelectElement,
    date: field('date'),
    start: field('start'),
    end: field('end'),
    brk: field('break'),
    rate: field('rate'),
    note: field('note'),
    paid: field('paid'),
  };
}

/** Read and validate the form. Returns an error message or the entry. */
function readEntryForm(): EntryInput | string {
  const { job, date, start, end, brk, rate, note, paid } = entryForm();
  if (!date.value || !start.value || !end.value) return 'Date, start and end are required.';
  const span = buildRange(date.value, start.value, end.value);
  const breakMinutes = brk.value ? Math.round(Number(brk.value)) : 0;
  const r = rate.value ? Number(rate.value) : 0;
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0) return 'Break must be 0 or more minutes.';
  if (!Number.isFinite(r) || r < 0) return 'Rate must be 0 or more.';
  const entry: EntryInput = {
    date: date.value,
    ...span,
    breakMinutes,
    rate: r,
    note: note.value.trim(),
    paid: paid.checked,
    jobId: job.value,
  };
  if (hoursOf(entry) <= 0) return 'The break is longer than the shift.';
  return entry;
}

function updateEntryPreview() {
  const res = readEntryForm();
  const preview = $('#entry-preview');
  const overlap = $('#entry-overlap');
  if (typeof res === 'string') {
    preview.textContent = '';
    overlap.hidden = true;
    return;
  }
  const pay = payFor(res, settings);
  const reasons = reasonsApplied(pay);
  const bits = [formatHours(pay.hours), money(pay.earnings)];
  if (reasons.length) bits.push(`${pay.paidHours.toFixed(2)} paid h · ${reasons.join(' + ')}`);
  if (isOvernight(res.start, res.end)) bits.push('ends next day');
  preview.textContent = bits.join(' · ');

  // Warn (without blocking) if these hours are already covered by another shift.
  const editingId = entryMode.kind === 'edit' ? entryMode.id : null;
  const clash = entries.find(
    (e) => e.id !== editingId && e.start.getTime() < res.end.getTime() && res.start.getTime() < e.end.getTime(),
  );
  overlap.hidden = !clash;
  if (clash) {
    overlap.textContent = `⚠︎ Overlaps ${dayFmt.format(clash.start)} ${toTimeStr(clash.start)}–${toTimeStr(clash.end)}.`;
  }
}

function fillJobSelect(selected: string) {
  const wrap = $('#entry-job-wrap');
  const sel = $<HTMLSelectElement>('#entry-job');
  wrap.hidden = jobs.length === 0;
  sel.innerHTML =
    `<option value="">No job</option>` +
    jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.name)}</option>`).join('');
  sel.value = jobs.some((j) => j.id === selected) ? selected : '';
}

function openEntryDialog(mode: EntryMode) {
  entryMode = mode;
  const { date, start, end, brk, rate, note, paid } = entryForm();
  const dlg = $<HTMLDialogElement>('#entry-dialog');
  const now = new Date();
  $('#entry-error').hidden = true;
  $('#entry-delete').hidden = mode.kind !== 'edit';
  // A new entry defaults to the job used last, or the one being filtered on.
  const defaultJob = jobFilter || settings.lastJobId;

  if (mode.kind === 'edit') {
    const e = entries.find((x) => x.id === mode.id);
    if (!e) return;
    $('#entry-title').textContent = 'Edit entry';
    fillJobSelect(e.jobId);
    date.value = e.date;
    start.value = toTimeStr(e.start);
    end.value = toTimeStr(e.end);
    brk.value = e.breakMinutes ? String(e.breakMinutes) : '';
    rate.value = String(e.rate);
    note.value = e.note;
    paid.checked = e.paid;
  } else if (mode.kind === 'clockout') {
    if (!clock) return;
    $('#entry-title').textContent = 'Clock out';
    fillJobSelect(defaultJob);
    date.value = toDateStr(clock.start);
    start.value = toTimeStr(clock.start);
    end.value = toTimeStr(now);
    brk.value = settings.defaultBreakMinutes ? String(settings.defaultBreakMinutes) : '';
    rate.value = String(rateForJob(defaultJob));
    note.value = '';
    paid.checked = false;
  } else {
    $('#entry-title').textContent = 'Add entry';
    fillJobSelect(defaultJob);
    date.value = toDateStr(now);
    start.value = settings.defaultStart;
    end.value = settings.defaultEnd;
    brk.value = settings.defaultBreakMinutes ? String(settings.defaultBreakMinutes) : '';
    rate.value = String(rateForJob(defaultJob));
    note.value = '';
    paid.checked = false;
  }
  updateEntryPreview();
  dlg.showModal();
}

/** A job's rate, falling back to the default rate. */
function rateForJob(jobId: string): number {
  const job = jobs.find((j) => j.id === jobId);
  return job && job.rate > 0 ? job.rate : settings.defaultRate;
}

function wireEntryDialog() {
  const dlg = $<HTMLDialogElement>('#entry-dialog');
  const { f, job, rate } = entryForm();
  f.addEventListener('input', updateEntryPreview);
  job.addEventListener('change', () => {
    rate.value = String(rateForJob(job.value));
    updateEntryPreview();
  });
  $('#entry-cancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close(); // backdrop tap
  });

  f.onsubmit = (ev) => {
    ev.preventDefault();
    const res = readEntryForm();
    const err = $('#entry-error');
    if (typeof res === 'string') {
      err.textContent = res;
      err.hidden = false;
      return;
    }
    const uid = user!.uid;
    // Don't await: with offline persistence the promise resolves only once the
    // server acks. The local cache (and so the list) updates immediately.
    const write =
      entryMode.kind === 'edit'
        ? updateEntry(uid, entryMode.id, res)
        : entryMode.kind === 'clockout'
          ? clockOut(uid, res)
          : addEntry(uid, res);
    write.catch(reportError);
    if (res.jobId !== settings.lastJobId) saveSettings(uid, { lastJobId: res.jobId }).catch(reportError);
    dlg.close();
    toast(navigator.onLine ? 'Saved' : 'Saved offline — will sync when back online');
    // Make sure the shift that was just saved is actually visible.
    if (res.date < range.from || res.date > range.to) {
      setRange({ from: res.date < range.from ? res.date : range.from, to: res.date > range.to ? res.date : range.to });
      toast(`Range widened to include ${res.date}`);
    }
  };

  $('#entry-delete').onclick = () => {
    if (entryMode.kind !== 'edit') return;
    if (!confirm('Delete this entry?')) return;
    deleteEntry(user!.uid, entryMode.id).catch(reportError);
    dlg.close();
    toast('Entry deleted');
  };
}

// ---------------------------------------------------------------------------
// Settings dialog

function settingsDialogHtml(): string {
  return `
    <dialog id="settings-dialog">
      <form id="settings-form" novalidate>
        <h2 tabindex="-1" autofocus>Settings</h2>

        <details open>
          <summary>Defaults</summary>
          <div class="section">
            <div class="row">
              <label>Hourly rate<input type="number" name="rate" min="0" step="0.01" inputmode="decimal" required></label>
              <label>Currency
                <select name="currency">${CURRENCIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
              </label>
            </div>
            <div class="row">
              <label>Start<input type="time" name="start"></label>
              <label>End<input type="time" name="end"></label>
              <label>Break (min)<input type="number" name="break" min="0" step="1" inputmode="numeric"></label>
            </div>
            <p class="muted small">Pre-fills new entries. Past entries keep the rate they were saved with.</p>
          </div>
        </details>

        <details>
          <summary>Jobs &amp; clients</summary>
          <div class="section">
            <div id="jobs-list" class="jobs-list"></div>
            <button type="button" class="btn ghost small" id="job-add">+ Add job</button>
            <p class="muted small">A job's rate pre-fills its shifts, and its client details head the invoice.</p>
          </div>
        </details>

        <details>
          <summary>Pay multipliers</summary>
          <div class="section">
            <div class="row">
              <label>Overtime after (h)<input type="number" name="overtimeAfterHours" min="0" step="0.5" inputmode="decimal"></label>
              <label>Overtime ×<input type="number" name="overtimeMultiplier" min="1" step="0.05" inputmode="decimal"></label>
            </div>
            <div class="row">
              <label>Night from<input type="time" name="nightStart"></label>
              <label>to<input type="time" name="nightEnd"></label>
              <label>Night ×<input type="number" name="nightMultiplier" min="1" step="0.05" inputmode="decimal"></label>
            </div>
            <label>Sunday ×<input type="number" name="sundayMultiplier" min="1" step="0.05" inputmode="decimal"></label>
            <p class="muted small">1 turns a multiplier off, as does 0 overtime hours. Where several apply to the same
            minute, only the highest counts. Changing these re-values past shifts too.</p>
          </div>
        </details>

        <details>
          <summary>Invoice details</summary>
          <div class="section">
            <label>From (you)<textarea name="invoiceFrom" rows="3" placeholder="Name&#10;Address&#10;Tax number"></textarea></label>
            <label>Payment details<textarea name="invoicePayment" rows="2" placeholder="IBAN / bank / terms"></textarea></label>
            <div class="row">
              <label>Number prefix<input type="text" name="invoicePrefix" maxlength="10"></label>
              <label>Next number<input type="number" name="invoiceCounter" min="1" step="1" inputmode="numeric"></label>
              <label>VAT %<input type="number" name="vatPercent" min="0" step="0.5" inputmode="decimal"></label>
            </div>
          </div>
        </details>

        <details>
          <summary>Report columns</summary>
          <div class="section">
            <div class="checks">
              <label class="check"><input type="checkbox" name="reportBreak"><span>Breaks</span></label>
              <label class="check"><input type="checkbox" name="reportRate"><span>Rate</span></label>
              <label class="check"><input type="checkbox" name="reportEarnings"><span>Earnings</span></label>
              <label class="check"><input type="checkbox" name="reportNote"><span>Notes</span></label>
            </div>
            <p class="muted small">Applies to the PDF. The CSV always includes every column.</p>
          </div>
        </details>

        <p class="error" id="settings-error" hidden></p>
        <div class="actions">
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="settings-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </dialog>`;
}

function settingsField<T extends HTMLElement = HTMLInputElement>(name: string): T {
  return $<HTMLFormElement>('#settings-form').elements.namedItem(name) as T;
}

function renderJobsList() {
  const el = $('#jobs-list');
  el.innerHTML = jobs.length
    ? jobs
        .map(
          (j) => `
            <button type="button" class="job-row" data-job="${esc(j.id)}">
              <span>${esc(j.name)}</span>
              <span class="muted small">${j.rate ? esc(money(j.rate)) + '/h' : 'no rate'}${j.clientName ? ` · ${esc(j.clientName)}` : ''}</span>
            </button>`,
        )
        .join('')
    : `<p class="muted small">No jobs yet.</p>`;
}

function openSettingsDialog() {
  const s = settings;
  settingsField('rate').value = String(s.defaultRate);
  settingsField<HTMLSelectElement>('currency').value = s.currency;
  settingsField('start').value = s.defaultStart;
  settingsField('end').value = s.defaultEnd;
  settingsField('break').value = String(s.defaultBreakMinutes);
  settingsField('overtimeAfterHours').value = String(s.overtimeAfterHours);
  settingsField('overtimeMultiplier').value = String(s.overtimeMultiplier);
  settingsField('nightStart').value = s.nightStart;
  settingsField('nightEnd').value = s.nightEnd;
  settingsField('nightMultiplier').value = String(s.nightMultiplier);
  settingsField('sundayMultiplier').value = String(s.sundayMultiplier);
  settingsField<HTMLTextAreaElement>('invoiceFrom').value = s.invoiceFrom;
  settingsField<HTMLTextAreaElement>('invoicePayment').value = s.invoicePayment;
  settingsField('invoicePrefix').value = s.invoicePrefix;
  settingsField('invoiceCounter').value = String(s.invoiceCounter);
  settingsField('vatPercent').value = String(s.vatPercent);
  settingsField('reportBreak').checked = s.reportBreak;
  settingsField('reportRate').checked = s.reportRate;
  settingsField('reportEarnings').checked = s.reportEarnings;
  settingsField('reportNote').checked = s.reportNote;
  renderJobsList();
  $('#settings-error').hidden = true;
  $<HTMLDialogElement>('#settings-dialog').showModal();
}

function wireSettingsDialog() {
  const dlg = $<HTMLDialogElement>('#settings-dialog');
  const f = $<HTMLFormElement>('#settings-form');
  $('#settings-cancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });
  $('#job-add').onclick = () => openJobDialog(null);
  $('#jobs-list').onclick = (ev) => {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-job]')?.dataset.job;
    if (id) openJobDialog(id);
  };

  f.onsubmit = (ev) => {
    ev.preventDefault();
    const err = $('#settings-error');
    const fail = (msg: string) => {
      err.textContent = msg;
      err.hidden = false;
      return null;
    };
    const numberField = (name: string, min: number, label: string): number | null => {
      const v = Number(settingsField(name).value || '0');
      if (!Number.isFinite(v) || v < min) return fail(`${label} must be ${min} or more.`);
      return v;
    };

    const rate = numberField('rate', 0, 'Rate');
    const brk = numberField('break', 0, 'Break');
    const otAfter = numberField('overtimeAfterHours', 0, 'Overtime hours');
    const otMult = numberField('overtimeMultiplier', 1, 'Overtime multiplier');
    const nightMult = numberField('nightMultiplier', 1, 'Night multiplier');
    const sunMult = numberField('sundayMultiplier', 1, 'Sunday multiplier');
    const counter = numberField('invoiceCounter', 1, 'Invoice number');
    const vat = numberField('vatPercent', 0, 'VAT');
    if ([rate, brk, otAfter, otMult, nightMult, sunMult, counter, vat].some((v) => v === null)) return;

    saveSettings(user!.uid, {
      defaultRate: rate!,
      currency: settingsField<HTMLSelectElement>('currency').value,
      defaultStart: settingsField('start').value || DEFAULT_SETTINGS.defaultStart,
      defaultEnd: settingsField('end').value || DEFAULT_SETTINGS.defaultEnd,
      defaultBreakMinutes: Math.round(brk!),
      overtimeAfterHours: otAfter!,
      overtimeMultiplier: otMult!,
      nightStart: settingsField('nightStart').value || DEFAULT_SETTINGS.nightStart,
      nightEnd: settingsField('nightEnd').value || DEFAULT_SETTINGS.nightEnd,
      nightMultiplier: nightMult!,
      sundayMultiplier: sunMult!,
      invoiceFrom: settingsField<HTMLTextAreaElement>('invoiceFrom').value.trim(),
      invoicePayment: settingsField<HTMLTextAreaElement>('invoicePayment').value.trim(),
      invoicePrefix: settingsField('invoicePrefix').value.trim(),
      invoiceCounter: Math.round(counter!),
      vatPercent: vat!,
      reportBreak: settingsField('reportBreak').checked,
      reportRate: settingsField('reportRate').checked,
      reportEarnings: settingsField('reportEarnings').checked,
      reportNote: settingsField('reportNote').checked,
    }).catch(reportError);
    dlg.close();
    toast('Settings saved');
  };
}

// ---------------------------------------------------------------------------
// Job dialog

function jobDialogHtml(): string {
  return `
    <dialog id="job-dialog">
      <form id="job-form" novalidate>
        <h2 id="job-title" tabindex="-1" autofocus>Add job</h2>
        <div class="row">
          <label>Name<input type="text" name="name" maxlength="60" required></label>
          <label>Rate / hour<input type="number" name="rate" min="0" step="0.01" inputmode="decimal"></label>
        </div>
        <label>Client name<input type="text" name="clientName" maxlength="80" placeholder="Shown on the invoice"></label>
        <label>Client details<textarea name="clientDetails" rows="3" placeholder="Address, tax number…"></textarea></label>
        <p class="error" id="job-error" hidden></p>
        <div class="actions">
          <button type="button" class="btn danger-ghost" id="job-delete" hidden>Delete</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="job-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </dialog>`;
}

function jobField<T extends HTMLElement = HTMLInputElement>(name: string): T {
  return $<HTMLFormElement>('#job-form').elements.namedItem(name) as T;
}

function openJobDialog(id: string | null) {
  jobEditId = id;
  const job = id ? jobs.find((j) => j.id === id) : null;
  $('#job-title').textContent = job ? 'Edit job' : 'Add job';
  jobField('name').value = job?.name ?? '';
  jobField('rate').value = String(job?.rate ?? settings.defaultRate);
  jobField('clientName').value = job?.clientName ?? '';
  jobField<HTMLTextAreaElement>('clientDetails').value = job?.clientDetails ?? '';
  $('#job-delete').hidden = !job;
  $('#job-error').hidden = true;
  $<HTMLDialogElement>('#job-dialog').showModal();
}

function wireJobDialog() {
  const dlg = $<HTMLDialogElement>('#job-dialog');
  const f = $<HTMLFormElement>('#job-form');
  $('#job-cancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });

  f.onsubmit = (ev) => {
    ev.preventDefault();
    const name = jobField('name').value.trim();
    const rate = Number(jobField('rate').value || '0');
    const err = $('#job-error');
    if (!name) {
      err.textContent = 'A job needs a name.';
      err.hidden = false;
      return;
    }
    if (!Number.isFinite(rate) || rate < 0) {
      err.textContent = 'Rate must be 0 or more.';
      err.hidden = false;
      return;
    }
    saveJob(user!.uid, {
      ...(jobEditId ? { id: jobEditId } : {}),
      name,
      rate,
      clientName: jobField('clientName').value.trim(),
      clientDetails: jobField<HTMLTextAreaElement>('clientDetails').value.trim(),
    })
      .then(renderJobsList)
      .catch(reportError);
    dlg.close();
    toast('Job saved');
  };

  $('#job-delete').onclick = () => {
    if (!jobEditId) return;
    const used = entries.filter((e) => e.jobId === jobEditId).length;
    const extra = used ? `\n\n${used} shift${used === 1 ? '' : 's'} in the current range will lose their job.` : '';
    if (!confirm(`Delete this job?${extra}`)) return;
    deleteJob(user!.uid, jobEditId).catch(reportError);
    dlg.close();
    toast('Job deleted');
  };
}

// ---------------------------------------------------------------------------
// Invoice dialog

function invoiceDialogHtml(): string {
  return `
    <dialog id="invoice-dialog">
      <form id="invoice-form" novalidate>
        <h2 tabindex="-1" autofocus>Invoice</h2>
        <label>Job / client<select name="jobId" id="invoice-job"></select></label>
        <label>Invoice no.<input type="text" name="number" maxlength="30" required></label>
        <div class="row">
          <label>Date<input type="date" name="issueDate" required></label>
          <label>Due<input type="date" name="dueDate" required></label>
        </div>
        <label class="check"><input type="checkbox" name="unpaidOnly" checked><span>Unpaid shifts only</span></label>
        <p class="preview" id="invoice-preview"></p>
        <p class="error" id="invoice-error" hidden></p>
        <div class="actions">
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="invoice-cancel">Cancel</button>
          <button type="submit" class="btn primary">Create PDF</button>
        </div>
      </form>
    </dialog>`;
}

function invoiceField<T extends HTMLElement = HTMLInputElement>(name: string): T {
  return $<HTMLFormElement>('#invoice-form').elements.namedItem(name) as T;
}

/** The shifts an invoice with the current dialog settings would cover. */
function invoiceEntries(): Entry[] {
  const jobId = invoiceField<HTMLSelectElement>('jobId').value;
  const unpaidOnly = invoiceField('unpaidOnly').checked;
  return entries.filter((e) => (jobId ? e.jobId === jobId : true) && (unpaidOnly ? !e.paid : true));
}

function updateInvoicePreview() {
  const list = invoiceEntries();
  const subtotal = list.reduce((s, e) => s + payOf(e).earnings, 0);
  const vat = (subtotal * settings.vatPercent) / 100;
  $('#invoice-preview').textContent = list.length
    ? `${list.length} shift${list.length === 1 ? '' : 's'} · ${money(subtotal)}${settings.vatPercent > 0 ? ` + ${money(vat)} VAT = ${money(subtotal + vat)}` : ''}`
    : 'No shifts match — nothing to invoice.';
}

function openInvoiceDialog() {
  const sel = $<HTMLSelectElement>('#invoice-job');
  sel.innerHTML =
    `<option value="">All jobs (no client details)</option>` +
    jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.name)}</option>`).join('');
  sel.value = jobFilter;
  const today = toDateStr(new Date());
  invoiceField('number').value = `${settings.invoicePrefix ? settings.invoicePrefix + '-' : ''}${new Date().getFullYear()}-${String(settings.invoiceCounter).padStart(3, '0')}`;
  invoiceField('issueDate').value = today;
  invoiceField('dueDate').value = addDays(today, 14);
  $('#invoice-error').hidden = true;
  updateInvoicePreview();
  $<HTMLDialogElement>('#invoice-dialog').showModal();
}

function wireInvoiceDialog() {
  const dlg = $<HTMLDialogElement>('#invoice-dialog');
  const f = $<HTMLFormElement>('#invoice-form');
  f.addEventListener('input', updateInvoicePreview);
  f.addEventListener('change', updateInvoicePreview);
  $('#invoice-cancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $('#invoice-error');
    const list = invoiceEntries();
    const number = invoiceField('number').value.trim();
    if (!list.length) {
      err.textContent = 'No shifts match — nothing to invoice.';
      err.hidden = false;
      return;
    }
    if (!number) {
      err.textContent = 'An invoice needs a number.';
      err.hidden = false;
      return;
    }
    const job = jobs.find((j) => j.id === invoiceField<HTMLSelectElement>('jobId').value);
    const submit = f.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = true;
    try {
      const { exportInvoice } = await import('./pdf');
      await exportInvoice({
        kind: 'invoice',
        range,
        rangeLabel: formatRange(range),
        currency: settings.currency,
        rules: settings,
        entries: list,
        jobs,
        number,
        issueDate: invoiceField('issueDate').value,
        dueDate: invoiceField('dueDate').value,
        from: settings.invoiceFrom || user!.displayName || '',
        billTo: [job?.clientName, job?.clientDetails].filter(Boolean).join('\n'),
        payment: settings.invoicePayment,
        vatPercent: settings.vatPercent,
        fileName: `invoice-${number}.pdf`,
      });
      // Next invoice gets the next number.
      saveSettings(user!.uid, { invoiceCounter: settings.invoiceCounter + 1 }).catch(reportError);
      dlg.close();
    } catch (e) {
      reportError(e);
    } finally {
      submit.disabled = false;
    }
  };
}

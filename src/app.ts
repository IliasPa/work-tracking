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
  saveSettings,
  setPaid,
  updateEntry,
  watchClock,
  watchEntries,
  watchSettings,
  type ClockState,
  type Entry,
  type EntryInput,
  type Settings,
} from './data';
import { db } from './firebase';
import {
  RANGE_PRESETS,
  buildRange,
  earningsOf,
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
let clock: ClockState | null = null;
let entries: Entry[] = [];
let overlaps = new Set<string>();
let range: DateRange = monthBounds(new Date());
let listeners: Unsubscribe[] = [];
let entriesUnsub: Unsubscribe | null = null;
let tickTimer: number | undefined;
let signInError = '';

type EntryMode = { kind: 'add' } | { kind: 'edit'; id: string } | { kind: 'clockout' };
let entryMode: EntryMode = { kind: 'add' };

const RANGE_KEY = 'hours.range';

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

function loadRange(): DateRange {
  try {
    const saved = JSON.parse(localStorage.getItem(RANGE_KEY) ?? 'null');
    if (saved && typeof saved.from === 'string' && typeof saved.to === 'string') return saved;
  } catch {
    // Private mode or blocked storage: fall back to the current month.
  }
  return monthBounds(new Date());
}

function storeRange(r: DateRange) {
  try {
    localStorage.setItem(RANGE_KEY, JSON.stringify(r));
  } catch {
    // Not important enough to bother the user about.
  }
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
  range = loadRange();

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
          <button role="menuitem" id="menu-settings">Settings</button>
          <button role="menuitem" id="menu-signout" class="danger">Sign out</button>
        </div>
      </div>
    </header>

    <main class="container">
      <section class="card clock" id="clock"></section>
      <button class="btn secondary block" id="add-btn">+ Add entry</button>

      <section class="card filter">
        <div class="chips" id="presets">
          ${RANGE_PRESETS.map((p) => `<button class="chip" data-preset="${p}">${p}</button>`).join('')}
        </div>
        <div class="row dates">
          <label>From<input type="date" id="from"></label>
          <label>To<input type="date" id="to"></label>
        </div>
      </section>

      <div class="card summary" id="summary"></div>
      <div id="list"></div>
    </main>

    ${entryDialogHtml()}
    ${settingsDialogHtml()}
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`;

  const img = root.querySelector<HTMLImageElement>('img.avatar');
  if (img) img.onerror = () => (img.outerHTML = `<span class="avatar fallback">${initial}</span>`);

  wireAccountMenu();
  wireEntryDialog();
  wireSettingsDialog();
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
  $('#menu-settings').onclick = () => {
    setOpen(false);
    openSettingsDialog();
  };
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
// Date-range filter

function wireFilter() {
  $('#presets').onclick = (ev) => {
    const preset = (ev.target as HTMLElement).closest<HTMLElement>('[data-preset]')?.dataset.preset;
    if (preset) setRange(presetRange(preset as RangePreset));
  };
  const from = $<HTMLInputElement>('#from');
  const to = $<HTMLInputElement>('#to');
  from.onchange = () => setRange({ from: from.value, to: from.value > to.value ? from.value : to.value });
  to.onchange = () => setRange({ from: to.value < from.value ? to.value : from.value, to: to.value });
}

function setRange(next: DateRange) {
  if (!next.from || !next.to) return;
  if (next.from === range.from && next.to === range.to) return;
  range = next;
  storeRange(range);
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
  const totalHours = entries.reduce((s, e) => s + hoursOf(e), 0);
  const totalEarn = entries.reduce((s, e) => s + earningsOf(e), 0);
  const unpaid = entries.filter((e) => !e.paid);
  const unpaidEarn = unpaid.reduce((s, e) => s + earningsOf(e), 0);

  $('#summary').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="stat-label">Hours</span><span class="stat-value">${totalHours.toFixed(2)}</span></div>
      <div class="stat"><span class="stat-label">Earned</span><span class="stat-value">${money(totalEarn)}</span></div>
      <div class="stat"><span class="stat-label">Shifts</span><span class="stat-value">${entries.length}</span></div>
    </div>
    ${
      overlaps.size
        ? `<p class="warn">⚠︎ ${overlaps.size} shifts overlap in this range — check for hours logged twice.</p>`
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
      <button class="btn ghost small" id="export-pdf" ${entries.length ? '' : 'disabled'}>PDF</button>
      <button class="btn ghost small" id="export-csv" ${entries.length ? '' : 'disabled'}>CSV</button>
    </div>`;

  $('#export-pdf').onclick = exportRangePdf;
  $('#export-csv').onclick = exportRangeCsv;
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
  const list = $('#list');
  if (!entries.length) {
    list.innerHTML = `<p class="empty">No shifts in ${esc(formatRange(range))}.</p>`;
    return;
  }

  const days = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = days.get(e.date);
    if (arr) arr.push(e);
    else days.set(e.date, [e]);
  }

  list.innerHTML = [...days]
    .map(([date, items]) => {
      const h = items.reduce((s, e) => s + hoursOf(e), 0);
      const m = items.reduce((s, e) => s + earningsOf(e), 0);
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
  const meta = [e.breakMinutes ? `${e.breakMinutes}m break` : '', `${money(e.rate)}/h`].filter(Boolean).join(' · ');
  const tags = [
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
          <span class="entry-meta">${meta}</span>
          ${e.note ? `<span class="entry-note">${esc(e.note)}</span>` : ''}
          ${tags ? `<span class="tags">${tags}</span>` : ''}
        </span>
        <span class="entry-nums">
          <strong>${formatHours(hoursOf(e))}</strong>
          <span>${money(earningsOf(e))}</span>
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
      range,
      rangeLabel: formatRange(range),
      userName: user!.displayName || user!.email || '',
      currency: settings.currency,
      columns: {
        break: settings.reportBreak,
        rate: settings.reportRate,
        earnings: settings.reportEarnings,
        note: settings.reportNote,
      },
      entries,
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
    await exportCsv(entries, exportFileName('csv'), `Work hours — ${formatRange(range)}`);
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
  const { date, start, end, brk, rate, note, paid } = entryForm();
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
  const overnight = isOvernight(res.start, res.end) ? ' · ends next day' : '';
  preview.textContent = `${formatHours(hoursOf(res))} · ${money(earningsOf(res))}${overnight}`;

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

function openEntryDialog(mode: EntryMode) {
  entryMode = mode;
  const { date, start, end, brk, rate, note, paid } = entryForm();
  const dlg = $<HTMLDialogElement>('#entry-dialog');
  const now = new Date();
  $('#entry-error').hidden = true;
  $('#entry-delete').hidden = mode.kind !== 'edit';

  if (mode.kind === 'edit') {
    const e = entries.find((x) => x.id === mode.id);
    if (!e) return;
    $('#entry-title').textContent = 'Edit entry';
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
    date.value = toDateStr(clock.start);
    start.value = toTimeStr(clock.start);
    end.value = toTimeStr(now);
    brk.value = settings.defaultBreakMinutes ? String(settings.defaultBreakMinutes) : '';
    rate.value = String(settings.defaultRate);
    note.value = '';
    paid.checked = false;
  } else {
    $('#entry-title').textContent = 'Add entry';
    date.value = toDateStr(now);
    start.value = settings.defaultStart;
    end.value = settings.defaultEnd;
    brk.value = settings.defaultBreakMinutes ? String(settings.defaultBreakMinutes) : '';
    rate.value = String(settings.defaultRate);
    note.value = '';
    paid.checked = false;
  }
  updateEntryPreview();
  dlg.showModal();
}

function wireEntryDialog() {
  const dlg = $<HTMLDialogElement>('#entry-dialog');
  const { f } = entryForm();
  f.addEventListener('input', updateEntryPreview);
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
// Settings dialog (defaults + report columns)

function settingsDialogHtml(): string {
  return `
    <dialog id="settings-dialog">
      <form id="settings-form" novalidate>
        <h2 tabindex="-1" autofocus>Defaults</h2>
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
        <p class="muted small">Used to pre-fill new entries. Past entries keep the rate they were saved with.</p>

        <h3>Report columns</h3>
        <div class="checks">
          <label class="check"><input type="checkbox" name="reportBreak"><span>Breaks</span></label>
          <label class="check"><input type="checkbox" name="reportRate"><span>Rate</span></label>
          <label class="check"><input type="checkbox" name="reportEarnings"><span>Earnings</span></label>
          <label class="check"><input type="checkbox" name="reportNote"><span>Notes</span></label>
        </div>
        <p class="muted small">Applies to the PDF. The CSV always includes every column.</p>

        <p class="error" id="settings-error" hidden></p>
        <div class="actions">
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="settings-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </dialog>`;
}

function settingsForm() {
  const f = $<HTMLFormElement>('#settings-form');
  return {
    f,
    field: <T extends HTMLElement = HTMLInputElement>(n: string) => f.elements.namedItem(n) as T,
  };
}

function openSettingsDialog() {
  const { field } = settingsForm();
  field('rate').value = String(settings.defaultRate);
  field<HTMLSelectElement>('currency').value = settings.currency;
  field('start').value = settings.defaultStart;
  field('end').value = settings.defaultEnd;
  field('break').value = String(settings.defaultBreakMinutes);
  field('reportBreak').checked = settings.reportBreak;
  field('reportRate').checked = settings.reportRate;
  field('reportEarnings').checked = settings.reportEarnings;
  field('reportNote').checked = settings.reportNote;
  $('#settings-error').hidden = true;
  $<HTMLDialogElement>('#settings-dialog').showModal();
}

function wireSettingsDialog() {
  const dlg = $<HTMLDialogElement>('#settings-dialog');
  const { f, field } = settingsForm();
  $('#settings-cancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const rate = Number(field('rate').value);
    const brk = Math.round(Number(field('break').value || '0'));
    const err = $('#settings-error');
    if (!Number.isFinite(rate) || rate < 0) {
      err.textContent = 'Rate must be 0 or more.';
      err.hidden = false;
      return;
    }
    if (!Number.isFinite(brk) || brk < 0) {
      err.textContent = 'Break must be 0 or more minutes.';
      err.hidden = false;
      return;
    }
    saveSettings(user!.uid, {
      defaultRate: rate,
      currency: field<HTMLSelectElement>('currency').value,
      defaultStart: field('start').value || DEFAULT_SETTINGS.defaultStart,
      defaultEnd: field('end').value || DEFAULT_SETTINGS.defaultEnd,
      defaultBreakMinutes: brk,
      reportBreak: field('reportBreak').checked,
      reportRate: field('reportRate').checked,
      reportEarnings: field('reportEarnings').checked,
      reportNote: field('reportNote').checked,
    }).catch(reportError);
    dlg.close();
    toast('Settings saved');
  };
}

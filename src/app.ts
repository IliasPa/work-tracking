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
  buildRange,
  earningsOf,
  formatDuration,
  formatHours,
  formatMoney,
  hoursOf,
  isOvernight,
  monthBounds,
  parseDateStr,
  toDateStr,
  toTimeStr,
} from './time';

// ---------------------------------------------------------------------------
// State

let root: HTMLElement;
let user: User | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let clock: ClockState | null = null;
let entries: Entry[] = [];
let month = firstOfMonth(new Date());
let listeners: Unsubscribe[] = [];
let entriesUnsub: Unsubscribe | null = null;
let tickTimer: number | undefined;
let signInError = '';

type EntryMode = { kind: 'add' } | { kind: 'edit'; id: string } | { kind: 'clockout' };
let entryMode: EntryMode = { kind: 'add' };

// ---------------------------------------------------------------------------
// Helpers

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const money = (n: number) => formatMoney(n, settings.currency);
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

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

  root.innerHTML = `
    <header class="topbar">
      <div class="brand"><img src="/icons/icon.svg" alt="" width="28" height="28"><span>Hours</span></div>
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

      <section class="month">
        <div class="month-nav">
          <button class="icon-btn" id="prev-month" aria-label="Previous month">‹</button>
          <h2 id="month-title"></h2>
          <button class="icon-btn" id="next-month" aria-label="Next month">›</button>
        </div>
        <div class="card summary" id="summary"></div>
        <div id="list"></div>
      </section>
    </main>

    ${entryDialogHtml()}
    ${settingsDialogHtml()}
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`;

  const img = root.querySelector<HTMLImageElement>('img.avatar');
  if (img) img.onerror = () => (img.outerHTML = `<span class="avatar fallback">${initial}</span>`);

  wireAccountMenu();
  wireEntryDialog();
  wireSettingsDialog();

  $('#add-btn').onclick = () => openEntryDialog({ kind: 'add' });
  $('#prev-month').onclick = () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
  $('#next-month').onclick = () => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  $('#list').onclick = (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (row) openEntryDialog({ kind: 'edit', id: row.dataset.id! });
  };

  renderClock();
  renderMonth();

  listeners.push(
    watchSettings(u.uid, (s) => {
      settings = s;
      renderMonth();
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
// Month view

function setMonth(d: Date) {
  const next = firstOfMonth(d);
  if (next.getTime() === month.getTime()) return;
  month = next;
  entries = [];
  subscribeEntries();
  renderMonth();
}

function subscribeEntries() {
  entriesUnsub?.();
  const { from, to } = monthBounds(month);
  entriesUnsub = watchEntries(
    user!.uid,
    from,
    to,
    (list) => {
      entries = list;
      renderMonth();
    },
    reportError,
  );
}

function renderMonth() {
  const title = root.querySelector('#month-title');
  if (!title) return;
  title.textContent = monthFmt.format(month);
  $<HTMLButtonElement>('#next-month').disabled = month.getTime() >= firstOfMonth(new Date()).getTime();

  const totalHours = entries.reduce((s, e) => s + hoursOf(e), 0);
  const totalEarn = entries.reduce((s, e) => s + earningsOf(e), 0);
  $('#summary').innerHTML = `
    <div class="stat"><span class="stat-label">Hours</span><span class="stat-value">${totalHours.toFixed(2)}</span></div>
    <div class="stat"><span class="stat-label">Earned</span><span class="stat-value">${money(totalEarn)}</span></div>
    <div class="stat"><span class="stat-label">Shifts</span><span class="stat-value">${entries.length}</span></div>
    <button class="btn ghost small" id="export-btn" ${entries.length ? '' : 'disabled'}>Export PDF</button>`;
  $('#export-btn').onclick = exportMonth;

  const list = $('#list');
  if (!entries.length) {
    list.innerHTML = `<p class="empty">No shifts logged in ${esc(monthFmt.format(month))}.</p>`;
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
  return `
    <li>
      <button class="entry" data-id="${esc(e.id)}">
        <span class="entry-main">
          <span class="entry-time">${toTimeStr(e.start)} – ${toTimeStr(e.end)}${
            isOvernight(e.start, e.end) ? '<sup title="Ends the next day">+1</sup>' : ''
          }${e.pending ? '<span class="pending" title="Waiting to sync"></span>' : ''}</span>
          <span class="entry-meta">${meta}</span>
          ${e.note ? `<span class="entry-note">${esc(e.note)}</span>` : ''}
        </span>
        <span class="entry-nums">
          <strong>${formatHours(hoursOf(e))}</strong>
          <span>${money(earningsOf(e))}</span>
        </span>
      </button>
    </li>`;
}

async function exportMonth() {
  const btn = $<HTMLButtonElement>('#export-btn');
  btn.disabled = true;
  try {
    const { exportPdf } = await import('./pdf');
    const y = month.getFullYear();
    const m = String(month.getMonth() + 1).padStart(2, '0');
    await exportPdf({
      title: `Work hours — ${monthFmt.format(month)}`,
      userName: user!.displayName || user!.email || '',
      currency: settings.currency,
      entries,
      fileName: `work-hours-${y}-${m}.pdf`,
    });
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
        <p class="preview" id="entry-preview"></p>
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
  return { f, date: field('date'), start: field('start'), end: field('end'), brk: field('break'), rate: field('rate'), note: field('note') };
}

/** Read and validate the form. Returns an error message or the entry. */
function readEntryForm(): EntryInput | string {
  const { date, start, end, brk, rate, note } = entryForm();
  if (!date.value || !start.value || !end.value) return 'Date, start and end are required.';
  const range = buildRange(date.value, start.value, end.value);
  const breakMinutes = brk.value ? Math.round(Number(brk.value)) : 0;
  const r = rate.value ? Number(rate.value) : 0;
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0) return 'Break must be 0 or more minutes.';
  if (!Number.isFinite(r) || r < 0) return 'Rate must be 0 or more.';
  const entry: EntryInput = { date: date.value, ...range, breakMinutes, rate: r, note: note.value.trim() };
  if (hoursOf(entry) <= 0) return 'The break is longer than the shift.';
  return entry;
}

function updateEntryPreview() {
  const res = readEntryForm();
  const el = $('#entry-preview');
  if (typeof res === 'string') {
    el.textContent = '';
    return;
  }
  const overnight = isOvernight(res.start, res.end) ? ' · ends next day' : '';
  el.textContent = `${formatHours(hoursOf(res))} · ${money(earningsOf(res))}${overnight}`;
}

function openEntryDialog(mode: EntryMode) {
  entryMode = mode;
  const { date, start, end, brk, rate, note } = entryForm();
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
  } else if (mode.kind === 'clockout') {
    if (!clock) return;
    $('#entry-title').textContent = 'Clock out';
    date.value = toDateStr(clock.start);
    start.value = toTimeStr(clock.start);
    end.value = toTimeStr(now);
    brk.value = '';
    rate.value = String(settings.defaultRate);
    note.value = '';
  } else {
    $('#entry-title').textContent = 'Add entry';
    date.value = toDateStr(now);
    start.value = '';
    end.value = '';
    brk.value = '';
    rate.value = String(settings.defaultRate);
    note.value = '';
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
    const target = firstOfMonth(parseDateStr(res.date));
    if (target.getTime() !== month.getTime()) setMonth(target);
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

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY'];

function settingsDialogHtml(): string {
  return `
    <dialog id="settings-dialog">
      <form id="settings-form" novalidate>
        <h2 tabindex="-1" autofocus>Settings</h2>
        <label>Default hourly rate<input type="number" name="rate" min="0" step="0.01" inputmode="decimal" required></label>
        <label>Currency
          <input type="text" name="currency" list="currency-list" maxlength="3" autocapitalize="characters" autocomplete="off" required>
          <datalist id="currency-list">${CURRENCIES.map((c) => `<option value="${c}">`).join('')}</datalist>
        </label>
        <p class="muted small">The default rate pre-fills new entries. Changing it doesn't alter past entries.</p>
        <p class="error" id="settings-error" hidden></p>
        <div class="actions">
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="settings-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </dialog>`;
}

function openSettingsDialog() {
  const f = $<HTMLFormElement>('#settings-form');
  (f.elements.namedItem('rate') as HTMLInputElement).value = String(settings.defaultRate);
  (f.elements.namedItem('currency') as HTMLInputElement).value = settings.currency;
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
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const rate = Number((f.elements.namedItem('rate') as HTMLInputElement).value);
    const currency = (f.elements.namedItem('currency') as HTMLInputElement).value.trim().toUpperCase();
    const err = $('#settings-error');
    if (!Number.isFinite(rate) || rate < 0) {
      err.textContent = 'Rate must be 0 or more.';
      err.hidden = false;
      return;
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      err.textContent = 'Currency must be a 3-letter code, e.g. EUR.';
      err.hidden = false;
      return;
    }
    saveSettings(user!.uid, { defaultRate: rate, currency }).catch(reportError);
    dlg.close();
    toast('Settings saved');
  };
}

// Pure date/time helpers. All "YYYY-MM-DD" and "HH:MM" strings are local time.

export interface Shift {
  start: Date;
  end: Date;
  breakMinutes: number;
  rate: number;
}

export function hoursOf(s: Shift): number {
  return (s.end.getTime() - s.start.getTime()) / 3_600_000 - s.breakMinutes / 60;
}

export function earningsOf(s: Shift): number {
  return hoursOf(s) * s.rate;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeStr(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseDateStr(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function atLocal(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

/**
 * Build start/end instants from a date and two clock times. If the end time is
 * not after the start time, the shift crosses midnight and ends the next day.
 */
export function buildRange(date: string, startTime: string, endTime: string): { start: Date; end: Date } {
  const start = atLocal(date, startTime);
  const end = atLocal(date, endTime);
  if (end <= start) end.setDate(end.getDate() + 1);
  return { start, end };
}

export function isOvernight(start: Date, end: Date): boolean {
  return toDateStr(start) !== toDateStr(end);
}

export interface DateRange {
  from: string;
  to: string;
}

/** First and last day ("YYYY-MM-DD") of the month containing `d`. */
export function monthBounds(d: Date): DateRange {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: toDateStr(first), to: toDateStr(last) };
}

/** Monday-to-Sunday week containing `d`. */
export function weekBounds(d: Date): DateRange {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return { from: toDateStr(monday), to: toDateStr(sunday) };
}

export const RANGE_PRESETS = ['This week', 'This month', 'Last month', 'This year'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export function presetRange(preset: RangePreset, today = new Date()): DateRange {
  switch (preset) {
    case 'This week':
      return weekBounds(today);
    case 'This month':
      return monthBounds(today);
    case 'Last month':
      return monthBounds(new Date(today.getFullYear(), today.getMonth() - 1, 1));
    case 'This year':
      return { from: `${today.getFullYear()}-01-01`, to: `${today.getFullYear()}-12-31` };
  }
}

/** The preset a range matches exactly, if any. */
export function matchingPreset(range: DateRange, today = new Date()): RangePreset | null {
  return (
    RANGE_PRESETS.find((p) => {
      const r = presetRange(p, today);
      return r.from === range.from && r.to === range.to;
    }) ?? null
  );
}

/** "1–30 Sep 2026", "28 Sep – 4 Oct 2026" or "2026" for a whole year. */
export function formatRange({ from, to }: DateRange): string {
  const a = parseDateStr(from);
  const b = parseDateStr(to);
  const day = (d: Date) => new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(d);
  const dayMonth = (d: Date) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d);
  const full = (d: Date) =>
    new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  if (from === to) return full(a);
  const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  const wholeMonth = sameMonth && a.getDate() === 1 && toDateStr(b) === monthBounds(a).to;
  if (wholeMonth) return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(a);
  const wholeYear = from === `${a.getFullYear()}-01-01` && to === `${a.getFullYear()}-12-31`;
  if (wholeYear) return String(a.getFullYear());
  // Build the pieces separately so the result reads correctly in any locale.
  const monthYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(b);
  if (sameMonth) return `${day(a)}\u2013${day(b)} ${monthYear}`;
  if (a.getFullYear() === b.getFullYear()) return `${dayMonth(a)} \u2013 ${dayMonth(b)} ${b.getFullYear()}`;
  return `${full(a)} \u2013 ${full(b)}`;
}

/**
 * Ids of entries whose worked time overlaps another entry's. Shifts that touch
 * end-to-start don't count. Used to catch the same hours logged twice.
 */
export function overlappingIds(entries: { id: string; start: Date; end: Date }[]): Set<string> {
  const sorted = [...entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const ids = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start.getTime() >= sorted[i].end.getTime()) break;
      ids.add(sorted[i].id);
      ids.add(sorted[j].id);
    }
  }
  return ids;
}

export function formatHours(h: number): string {
  return `${h.toFixed(2)} h`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
}

const moneyFormats = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number, currency: string): string {
  let fmt = moneyFormats.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    } catch {
      // Unknown currency code: plain number followed by the code.
      fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const plain = fmt;
      fmt = { format: (n: number) => `${plain.format(n)} ${currency}` } as Intl.NumberFormat;
    }
    moneyFormats.set(currency, fmt);
  }
  return fmt.format(amount);
}

/**
 * A shift as it was worked, independent of where it is later viewed.
 *
 * `startWall`/`endWall` carry the clock times of the place the shift happened,
 * rebuilt in the viewer's own timezone so a shift logged 22:00–06:00 in Athens
 * still reads 22:00–06:00 in London. `totalMinutes` stays the real elapsed
 * time, so a night that crosses a daylight-saving change still counts the hour.
 * Entries saved before v0.4 have no clock times and fall back to the old
 * behaviour of showing the viewer's local time.
 */
export interface WallClock {
  startWall: Date;
  endWall: Date;
  totalMinutes: number;
}

export interface WallSource {
  date: string;
  start: Date;
  end: Date;
  startLocal?: string;
  endLocal?: string;
  endDate?: string;
}

export function wallClockOf(e: WallSource): WallClock {
  const totalMinutes = Math.max(1, Math.round((e.end.getTime() - e.start.getTime()) / 60_000));
  if (e.startLocal && e.endLocal && e.endDate) {
    return { startWall: atLocal(e.date, e.startLocal), endWall: atLocal(e.endDate, e.endLocal), totalMinutes };
  }
  return { startWall: new Date(e.start), endWall: new Date(e.end), totalMinutes };
}

/** What the shift should read as: clock times as worked, and whether it ran past midnight. */
export function displayTimes(e: WallSource): { start: string; end: string; overnight: boolean } {
  if (e.startLocal && e.endLocal && e.endDate) {
    return { start: e.startLocal, end: e.endLocal, overnight: e.endDate !== e.date };
  }
  return { start: toTimeStr(e.start), end: toTimeStr(e.end), overnight: isOvernight(e.start, e.end) };
}

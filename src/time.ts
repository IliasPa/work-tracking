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

function at(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

/**
 * Build start/end instants from a date and two clock times. If the end time is
 * not after the start time, the shift crosses midnight and ends the next day.
 */
export function buildRange(date: string, startTime: string, endTime: string): { start: Date; end: Date } {
  const start = at(date, startTime);
  const end = at(date, endTime);
  if (end <= start) end.setDate(end.getDate() + 1);
  return { start, end };
}

export function isOvernight(start: Date, end: Date): boolean {
  return toDateStr(start) !== toDateStr(end);
}

/** First and last day ("YYYY-MM-DD") of the month containing `d`. */
export function monthBounds(d: Date): { from: string; to: string } {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: toDateStr(first), to: toDateStr(last) };
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

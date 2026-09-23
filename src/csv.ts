import type { Entry, Job } from './data';
import { displayTimes, hoursOf } from './time';
import { payOfEntry, type PayRules } from './pay';
import { deliver } from './download';

const HEADERS = [
  'Date', 'Job', 'Start', 'End', 'Break (min)', 'Hours', 'Paid hours', 'Multiplier', 'Rate', 'Earnings', 'Note', 'Paid',
];

function cell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV of the filtered range. Unlike the PDF it always carries every column:
 * it's raw data for a spreadsheet, where an unwanted column is just hidden.
 * Numbers use a dot decimal separator and no currency symbol so they stay
 * numeric when imported.
 */
export function buildCsv(entries: Entry[], rules: PayRules, jobs: Job[]): string {
  const rows = [...entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const lines = [HEADERS.join(',')];
  let totalPaidHours = 0;
  let totalEarnings = 0;
  for (const e of rows) {
    const pay = payOfEntry(e, rules);
    const t = displayTimes(e);
    totalPaidHours += pay.paidHours;
    totalEarnings += pay.earnings;
    lines.push(
      [
        e.date,
        jobs.find((j) => j.id === e.jobId)?.name ?? (e.jobId ? '(deleted job)' : ''),
        t.start,
        t.end + (t.overnight ? ' +1' : ''),
        e.breakMinutes,
        hoursOf(e).toFixed(2),
        pay.paidHours.toFixed(2),
        pay.multiplier.toFixed(3),
        e.rate.toFixed(2),
        pay.earnings.toFixed(2),
        e.note,
        e.paid ? 'yes' : 'no',
      ]
        .map(cell)
        .join(','),
    );
  }
  const totalHours = rows.reduce((s, e) => s + hoursOf(e), 0);
  lines.push(
    ['TOTAL', '', '', '', '', totalHours.toFixed(2), totalPaidHours.toFixed(2), '', '', totalEarnings.toFixed(2), '', '']
      .map(cell)
      .join(','),
  );
  return lines.join('\r\n');
}

export function exportCsv(
  entries: Entry[],
  rules: PayRules,
  jobs: Job[],
  fileName: string,
  title: string,
): Promise<void> {
  // The BOM makes Excel open UTF-8 (and Greek notes) correctly.
  const blob = new Blob(['﻿' + buildCsv(entries, rules, jobs)], { type: 'text/csv;charset=utf-8' });
  return deliver(blob, fileName, 'text/csv', title);
}

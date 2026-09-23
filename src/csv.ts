import type { Entry } from './data';
import { earningsOf, hoursOf, isOvernight, toTimeStr } from './time';
import { deliver } from './download';

const HEADERS = ['Date', 'Start', 'End', 'Break (min)', 'Hours', 'Rate', 'Earnings', 'Note', 'Paid'];

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
export function buildCsv(entries: Entry[]): string {
  const rows = [...entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const lines = [HEADERS.join(',')];
  for (const e of rows) {
    lines.push(
      [
        e.date,
        toTimeStr(e.start),
        toTimeStr(e.end) + (isOvernight(e.start, e.end) ? ' +1' : ''),
        e.breakMinutes,
        hoursOf(e).toFixed(2),
        e.rate.toFixed(2),
        earningsOf(e).toFixed(2),
        e.note,
        e.paid ? 'yes' : 'no',
      ]
        .map(cell)
        .join(','),
    );
  }
  const totalHours = rows.reduce((s, e) => s + hoursOf(e), 0);
  const totalEarnings = rows.reduce((s, e) => s + earningsOf(e), 0);
  lines.push(['TOTAL', '', '', '', totalHours.toFixed(2), '', totalEarnings.toFixed(2), '', ''].map(cell).join(','));
  return lines.join('\r\n');
}

export function exportCsv(entries: Entry[], fileName: string, title: string): Promise<void> {
  // The BOM makes Excel open UTF-8 (and Greek notes) correctly.
  const blob = new Blob(['﻿' + buildCsv(entries)], { type: 'text/csv;charset=utf-8' });
  return deliver(blob, fileName, 'text/csv', title);
}

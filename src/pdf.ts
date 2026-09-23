import { jsPDF } from 'jspdf';
import { autoTable, type RowInput, type Styles } from 'jspdf-autotable';
import fontUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url';
import type { Entry } from './data';
import { earningsOf, formatMoney, hoursOf, isOvernight, parseDateStr, toTimeStr, type DateRange } from './time';
import { deliver } from './download';

// jsPDF's built-in fonts only cover Latin-1, so embed DejaVu Sans to render
// Greek and other non-Latin notes. Loaded lazily on first export.
let fontBase64: Promise<string> | null = null;

/** Warm the font cache ahead of time so export keeps the tap's user activation (needed for navigator.share). */
export function loadFont(): Promise<string> {
  fontBase64 ??= fetch(fontUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`Font download failed (${r.status})`);
      return r.blob();
    })
    .then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        }),
    );
  fontBase64.catch(() => (fontBase64 = null));
  return fontBase64;
}

export interface ReportColumns {
  break: boolean;
  rate: boolean;
  earnings: boolean;
  note: boolean;
}

export interface PdfOptions {
  range: DateRange;
  rangeLabel: string;
  userName: string;
  currency: string;
  columns: ReportColumns;
  entries: Entry[];
  fileName: string;
}

const RIGHT: Partial<Styles> = { halign: 'right' };

export async function exportPdf(o: PdfOptions): Promise<void> {
  const doc = buildPdf(o, await loadFont());
  await deliver(doc.output('blob'), o.fileName, 'application/pdf', `Work hours — ${o.rangeLabel}`);
}

/** Lays out the report. Separate from delivery so it can be rendered in tests. */
export function buildPdf(o: PdfOptions, fontBase64: string): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.addFileToVFS('DejaVuSans.ttf', fontBase64);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu');

  const rows = [...o.entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const totalHours = rows.reduce((s, e) => s + hoursOf(e), 0);
  const totalEarnings = rows.reduce((s, e) => s + earningsOf(e), 0);
  const money = (n: number) => formatMoney(n, o.currency);
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: '2-digit', month: 'short' });

  // Columns are built in one place so header, body, widths and the TOTAL row
  // can never drift out of step.
  // width 0 = flexible: those columns share whatever space is left over, so the
  // table always fills the page width.
  const cols: { head: string; width: number; min?: number; right?: boolean; cell: (e: Entry) => string; total?: string }[] = [
    { head: 'Date', width: 0, min: 76, cell: (e) => dateFmt.format(parseDateStr(e.date)) },
    { head: 'Start', width: 42, right: true, cell: (e) => toTimeStr(e.start) },
    { head: 'End', width: 60, right: true, cell: (e) => toTimeStr(e.end) + (isOvernight(e.start, e.end) ? ' +1' : '') },
  ];
  if (o.columns.break) cols.push({ head: 'Break', width: 44, right: true, cell: (e) => `${e.breakMinutes} m` });
  cols.push({ head: 'Hours', width: 48, right: true, cell: (e) => hoursOf(e).toFixed(2), total: totalHours.toFixed(2) });
  if (o.columns.rate) cols.push({ head: 'Rate', width: 54, right: true, cell: (e) => money(e.rate) });
  if (o.columns.earnings) {
    cols.push({ head: 'Earnings', width: 66, right: true, cell: (e) => money(earningsOf(e)), total: money(totalEarnings) });
  }
  if (o.columns.note) cols.push({ head: 'Note', width: 0, min: 90, cell: (e) => e.note });

  const body: RowInput[] = rows.map((e) => cols.map((c) => c.cell(e)));
  const foot: RowInput[] = [cols.map((c, i) => (i === 0 ? 'TOTAL' : (c.total ?? '')))];
  const columnStyles: Record<number, Partial<Styles>> = {};
  cols.forEach((c, i) => {
    columnStyles[i] = {
      ...(c.right ? RIGHT : {}),
      // Figure columns are fixed so they line up down the page; the flexible
      // ones absorb the rest and are cut short rather than wrapped.
      ...(c.width ? { cellWidth: c.width } : { cellWidth: 'auto', minCellWidth: c.min, overflow: 'ellipsize' }),
    };
  });

  doc.setFontSize(15);
  doc.text('Work hours', 40, 48);
  doc.setFontSize(11);
  doc.text(o.rangeLabel, 40, 66);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${o.userName} · ${rows.length} shift${rows.length === 1 ? '' : 's'}`, 40, 82);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 96,
    margin: { left: 40, right: 40, bottom: 44 },
    // Fill the page width: with columns switched off the rest widen to match.
    tableWidth: doc.internal.pageSize.getWidth() - 80,
    head: [cols.map((c) => c.head)],
    body,
    foot,
    showFoot: 'lastPage',
    styles: { font: 'DejaVu', fontSize: 9, cellPadding: { top: 5, bottom: 5, left: 6, right: 6 }, overflow: 'hidden' },
    headStyles: { fillColor: [15, 118, 110], textColor: 255, fontStyle: 'normal', halign: 'left' },
    footStyles: { fillColor: [237, 244, 243], textColor: 20, fontStyle: 'normal' },
    alternateRowStyles: { fillColor: [248, 249, 250] },
    columnStyles,
    // Right-align the header and TOTAL cells of numeric columns too.
    didParseCell: (d) => {
      if (d.section !== 'body' && cols[d.column.index]?.right) d.cell.styles.halign = 'right';
    },
    didDrawPage: () => {
      const page = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(130);
      doc.text(`Page ${page}`, doc.internal.pageSize.getWidth() - 40, doc.internal.pageSize.getHeight() - 24, {
        align: 'right',
      });
      doc.setTextColor(0);
    },
  });

  return doc;
}

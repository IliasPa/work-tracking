import { jsPDF } from 'jspdf';
import { autoTable, type RowInput, type Styles } from 'jspdf-autotable';
import fontUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url';
import type { Entry, Job } from './data';
import { payFor, reasonsApplied, rulesActive, type PayRules } from './pay';
import { formatMoney, hoursOf, isOvernight, parseDateStr, toTimeStr, type DateRange } from './time';
import { deliver } from './download';

// jsPDF's built-in fonts only cover Latin-1, so embed DejaVu Sans to render
// Greek and other non-Latin text. Loaded lazily on first export.
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

export interface ReportOptions {
  kind: 'report';
  range: DateRange;
  rangeLabel: string;
  userName: string;
  currency: string;
  rules: PayRules;
  columns: ReportColumns;
  entries: Entry[];
  jobs: Job[];
  fileName: string;
}

export interface InvoiceOptions {
  kind: 'invoice';
  range: DateRange;
  rangeLabel: string;
  currency: string;
  rules: PayRules;
  entries: Entry[];
  jobs: Job[];
  number: string;
  issueDate: string;
  dueDate: string;
  from: string;
  billTo: string;
  payment: string;
  vatPercent: number;
  fileName: string;
}

const TEAL: [number, number, number] = [15, 118, 110];
const PAGE_MARGIN = 40;

function newDoc(font: string): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.addFileToVFS('DejaVuSans.ttf', font);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu');
  return doc;
}

const dateFmt = () => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
const plainDateFmt = () => new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

function pageFooter(doc: jsPDF) {
  doc.setFontSize(8);
  doc.setTextColor(130);
  doc.text(
    `Page ${doc.getNumberOfPages()}`,
    doc.internal.pageSize.getWidth() - PAGE_MARGIN,
    doc.internal.pageSize.getHeight() - 24,
    { align: 'right' },
  );
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// Timesheet report

export async function exportPdf(o: ReportOptions): Promise<void> {
  const doc = buildReport(o, await loadFont());
  await deliver(doc.output('blob'), o.fileName, 'application/pdf', `Work hours — ${o.rangeLabel}`);
}

/** Lays out the report. Separate from delivery so it can be rendered in tests. */
export function buildReport(o: ReportOptions, font: string): jsPDF {
  const rows = [...o.entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const money = (n: number) => formatMoney(n, o.currency);
  const fmt = dateFmt();
  const jobName = (id: string) => o.jobs.find((j) => j.id === id)?.name ?? (id ? '(deleted job)' : '');
  const pay = new Map(rows.map((e) => [e.id, payFor(e, o.rules)]));

  const totalHours = rows.reduce((s, e) => s + hoursOf(e), 0);
  const totalPaidHours = rows.reduce((s, e) => s + pay.get(e.id)!.paidHours, 0);
  const totalEarnings = rows.reduce((s, e) => s + pay.get(e.id)!.earnings, 0);
  // Extra columns only appear when they carry information.
  const showJob = rows.some((e) => e.jobId);
  const showPaidHours = rulesActive(o.rules) && Math.abs(totalPaidHours - totalHours) > 0.005;
  // Set once the columns are known; the Note cells below read it when the body
  // is built, so a tight table gets short multiplier tags instead of words.
  let dense = false;
  const SHORT: Record<string, string> = { overtime: 'OT', night: 'NT', sunday: 'SU' };

  // width 0 = flexible: those columns share whatever space is left over, so the
  // table always fills the page width.
  const cols: { head: string; width: number; min?: number; right?: boolean; cell: (e: Entry) => string; total?: string }[] =
    [{ head: 'Date', width: 0, min: 76, cell: (e) => fmt.format(parseDateStr(e.date)) }];
  if (showJob) cols.push({ head: 'Job', width: 0, min: 60, cell: (e) => jobName(e.jobId) });
  cols.push({ head: 'Start', width: 42, right: true, cell: (e) => toTimeStr(e.start) });
  cols.push({
    head: 'End',
    width: 60,
    right: true,
    cell: (e) => toTimeStr(e.end) + (isOvernight(e.start, e.end) ? ' +1' : ''),
  });
  if (o.columns.break) cols.push({ head: 'Break', width: 44, right: true, cell: (e) => `${e.breakMinutes} m` });
  cols.push({ head: 'Hours', width: 48, right: true, cell: (e) => hoursOf(e).toFixed(2), total: totalHours.toFixed(2) });
  if (showPaidHours) {
    cols.push({
      head: 'Paid h',
      width: 50,
      right: true,
      cell: (e) => pay.get(e.id)!.paidHours.toFixed(2),
      total: totalPaidHours.toFixed(2),
    });
  }
  if (o.columns.rate) cols.push({ head: 'Rate', width: 54, right: true, cell: (e) => money(e.rate) });
  if (o.columns.earnings) {
    cols.push({
      head: 'Earnings',
      width: 66,
      right: true,
      cell: (e) => money(pay.get(e.id)!.earnings),
      total: money(totalEarnings),
    });
  }
  if (o.columns.note) {
    cols.push({
      head: 'Note',
      width: 0,
      min: 90,
      cell: (e) => {
        const reasons = reasonsApplied(pay.get(e.id)!);
        if (!reasons.length) return e.note;
        return `[${reasons.map((r) => (dense ? SHORT[r] : r)).join(dense ? '+' : ', ')}] ${e.note}`;
      },
    });
  }

  // The page stays portrait, so a wide report is fitted by shrinking the type
  // and the fixed columns rather than turning the page sideways.
  dense = cols.length > 7;
  if (dense) {
    for (const c of cols) {
      c.width = Math.round(c.width * 0.84);
      if (c.min) c.min = Math.round(c.min * 0.8);
    }
  }

  const doc = newDoc(font);
  doc.setFontSize(15);
  doc.text('Work hours', PAGE_MARGIN, 48);
  doc.setFontSize(11);
  doc.text(o.rangeLabel, PAGE_MARGIN, 66);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${o.userName} · ${rows.length} shift${rows.length === 1 ? '' : 's'}`, PAGE_MARGIN, 82);
  doc.setTextColor(0);

  drawTable(doc, {
    startY: 96,
    dense,
    cols,
    body: rows.map((e) => cols.map((c) => c.cell(e))),
    foot: [cols.map((c, i) => (i === 0 ? 'TOTAL' : (c.total ?? '')))],
  });
  return doc;
}

/** Shared table styling: fixed figure columns, right-aligned, one line per row. */
function drawTable(
  doc: jsPDF,
  t: {
    startY: number;
    dense?: boolean;
    cols: { head: string; width: number; min?: number; right?: boolean; wrap?: boolean }[];
    body: RowInput[];
    foot?: RowInput[];
  },
) {
  const columnStyles: Record<number, Partial<Styles>> = {};
  t.cols.forEach((c, i) => {
    columnStyles[i] = {
      ...(c.right ? { halign: 'right' as const } : {}),
      // Figure columns are fixed so they line up down the page; the flexible
      // ones absorb the rest and are cut short rather than wrapped.
      ...(c.width
        ? { cellWidth: c.width }
        : { cellWidth: 'auto', minCellWidth: c.min, overflow: c.wrap ? 'linebreak' : 'ellipsize' }),
    };
  });

  autoTable(doc, {
    startY: t.startY,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, bottom: 44 },
    tableWidth: doc.internal.pageSize.getWidth() - PAGE_MARGIN * 2,
    head: [t.cols.map((c) => c.head)],
    body: t.body,
    foot: t.foot,
    showFoot: 'lastPage',
    styles: {
      font: 'DejaVu',
      fontSize: t.dense ? 7.5 : 9,
      cellPadding: t.dense ? { top: 4, bottom: 4, left: 3, right: 3 } : { top: 5, bottom: 5, left: 6, right: 6 },
      overflow: 'hidden',
    },
    headStyles: { fillColor: TEAL, textColor: 255, fontStyle: 'normal', halign: 'left' },
    footStyles: { fillColor: [237, 244, 243], textColor: 20, fontStyle: 'normal' },
    alternateRowStyles: { fillColor: [248, 249, 250] },
    columnStyles,
    // Right-align the header and TOTAL cells of numeric columns too.
    didParseCell: (d) => {
      if (d.section !== 'body' && t.cols[d.column.index]?.right) d.cell.styles.halign = 'right';
    },
    didDrawPage: () => pageFooter(doc),
  });
}

// ---------------------------------------------------------------------------
// Invoice

export async function exportInvoice(o: InvoiceOptions): Promise<void> {
  const doc = buildInvoice(o, await loadFont());
  await deliver(doc.output('blob'), o.fileName, 'application/pdf', `Invoice ${o.number}`);
}

export function buildInvoice(o: InvoiceOptions, font: string): jsPDF {
  const doc = newDoc(font);
  const width = doc.internal.pageSize.getWidth();
  const money = (n: number) => formatMoney(n, o.currency);
  const fmt = plainDateFmt();
  const rows = [...o.entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const jobName = (id: string) => o.jobs.find((j) => j.id === id)?.name ?? '';

  // Header: title left, invoice details right.
  doc.setFontSize(22);
  doc.setTextColor(...TEAL);
  doc.text('INVOICE', PAGE_MARGIN, 56);
  doc.setTextColor(0);
  doc.setFontSize(10);
  const meta = [
    ['Invoice no.', o.number],
    ['Date', fmt.format(parseDateStr(o.issueDate))],
    ['Due', fmt.format(parseDateStr(o.dueDate))],
    ['Period', o.rangeLabel],
  ];
  meta.forEach(([label, value], i) => {
    const y = 40 + i * 14;
    doc.setTextColor(120);
    doc.text(label, width - PAGE_MARGIN - 150, y);
    doc.setTextColor(0);
    doc.text(value, width - PAGE_MARGIN, y, { align: 'right' });
  });

  // From / Bill to blocks.
  let y = 110;
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text('FROM', PAGE_MARGIN, y);
  doc.text('BILL TO', width / 2, y);
  doc.setTextColor(0);
  doc.setFontSize(10);
  const fromLines = doc.splitTextToSize(o.from || '—', width / 2 - PAGE_MARGIN - 20);
  const toLines = doc.splitTextToSize(o.billTo || '—', width / 2 - PAGE_MARGIN - 20);
  doc.text(fromLines, PAGE_MARGIN, y + 14);
  doc.text(toLines, width / 2, y + 14);
  y += 14 + Math.max(fromLines.length, toLines.length) * 13 + 16;

  // Line items: one per shift.
  const cols = [
    { head: 'Date', width: 74 },
    { head: 'Description', width: 0, min: 140, wrap: true },
    { head: 'Billed h', width: 54, right: true },
    { head: 'Rate', width: 58, right: true },
    { head: 'Amount', width: 70, right: true },
  ];
  let subtotal = 0;
  const body: RowInput[] = rows.map((e) => {
    const pay = payFor(e, o.rules);
    subtotal += pay.earnings;
    const reasons = reasonsApplied(pay);
    const parts = [jobName(e.jobId), e.note, `${toTimeStr(e.start)}–${toTimeStr(e.end)}`].filter(Boolean);
    if (reasons.length) parts.push(`incl. ${reasons.join(' + ')}`);
    return [
      fmt.format(parseDateStr(e.date)),
      parts.join(' · '),
      pay.paidHours.toFixed(2),
      money(e.rate),
      money(pay.earnings),
    ];
  });

  drawTable(doc, { startY: y, cols, body });

  // Totals block, right-aligned under the table.
  const vat = (subtotal * o.vatPercent) / 100;
  const total = subtotal + vat;
  let ty = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY ?? y) + 18;
  doc.setFontSize(10);
  const totalLines: [string, string, boolean][] = [['Subtotal', money(subtotal), false]];
  if (o.vatPercent > 0) totalLines.push([`VAT ${o.vatPercent}%`, money(vat), false]);
  totalLines.push(['Total', money(total), true]);
  for (const [label, value, bold] of totalLines) {
    if (bold) {
      doc.setFontSize(12);
      doc.setDrawColor(...TEAL);
      doc.line(width - PAGE_MARGIN - 200, ty - 12, width - PAGE_MARGIN, ty - 12);
    }
    doc.text(label, width - PAGE_MARGIN - 200, ty);
    doc.text(value, width - PAGE_MARGIN, ty, { align: 'right' });
    ty += bold ? 20 : 16;
  }

  if (o.payment) {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('PAYMENT', PAGE_MARGIN, ty + 10);
    doc.setTextColor(0);
    doc.setFontSize(10);
    doc.text(doc.splitTextToSize(o.payment, width / 2), PAGE_MARGIN, ty + 24);
  }
  return doc;
}

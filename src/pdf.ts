import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import fontUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url';
import type { Entry } from './data';
import { earningsOf, formatMoney, hoursOf, isOvernight, parseDateStr, toTimeStr } from './time';

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

export interface PdfOptions {
  title: string;
  userName: string;
  currency: string;
  entries: Entry[];
  fileName: string;
}

export async function exportPdf({ title, userName, currency, entries, fileName }: PdfOptions): Promise<void> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.addFileToVFS('DejaVuSans.ttf', await loadFont());
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu');

  const rows = [...entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const totalHours = rows.reduce((sum, e) => sum + hoursOf(e), 0);
  const totalEarnings = rows.reduce((sum, e) => sum + earningsOf(e), 0);
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  doc.setFontSize(16);
  doc.text(title, 40, 50);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`${userName} · generated ${new Date().toLocaleString()}`, 40, 68);

  autoTable(doc, {
    startY: 84,
    head: [['Date', 'Start', 'End', 'Break', 'Hours', 'Rate', 'Earnings', 'Note']],
    body: rows.map((e) => [
      dateFmt.format(parseDateStr(e.date)),
      toTimeStr(e.start),
      toTimeStr(e.end) + (isOvernight(e.start, e.end) ? ' (+1)' : ''),
      e.breakMinutes ? `${e.breakMinutes}m` : '',
      hoursOf(e).toFixed(2),
      formatMoney(e.rate, currency),
      formatMoney(earningsOf(e), currency),
      e.note,
    ]),
    foot: [['Total', '', '', '', totalHours.toFixed(2), '', formatMoney(totalEarnings, currency), '']],
    showFoot: 'lastPage',
    styles: { font: 'DejaVu', fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [15, 118, 110], fontStyle: 'normal' },
    footStyles: { fillColor: [230, 240, 238], textColor: 20, fontStyle: 'normal' },
    columnStyles: {
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { cellWidth: 130 },
    },
  });

  // On phones, hand the file to the share sheet (Save to Files, Mail, …).
  // A plain download inside an installed iOS PWA opens a dead-end viewer.
  const file = new File([doc.output('blob')], fileName, { type: 'application/pdf' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // NotAllowedError etc.: fall through to a normal download.
    }
  }
  doc.save(fileName);
}

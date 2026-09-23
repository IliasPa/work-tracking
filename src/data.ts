import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import { NO_MULTIPLIERS, type PayRules } from './pay';

export interface Settings extends PayRules {
  defaultRate: number;
  currency: string;
  /** Pre-filled values for the manual "add entry" form. */
  defaultStart: string;
  defaultEnd: string;
  defaultBreakMinutes: number;
  /** Job used on the last saved entry; pre-selected on the next one. */
  lastJobId: string;
  /** Which columns the PDF report includes. */
  reportNote: boolean;
  reportRate: boolean;
  reportBreak: boolean;
  reportEarnings: boolean;
  /** Invoice header: who is sending it, and how to pay it. */
  invoiceFrom: string;
  invoicePayment: string;
  invoicePrefix: string;
  invoiceCounter: number;
  vatPercent: number;
}

export const DEFAULT_SETTINGS: Settings = {
  ...NO_MULTIPLIERS,
  defaultRate: 0,
  currency: 'EUR',
  defaultStart: '09:00',
  defaultEnd: '17:00',
  defaultBreakMinutes: 0,
  lastJobId: '',
  reportNote: true,
  reportRate: true,
  reportBreak: true,
  reportEarnings: true,
  invoiceFrom: '',
  invoicePayment: '',
  invoicePrefix: 'INV',
  invoiceCounter: 1,
  vatPercent: 0,
};

/** A job or client. Its rate pre-fills entries; its client details head invoices. */
export interface Job {
  id: string;
  name: string;
  rate: number;
  clientName: string;
  clientDetails: string;
}

export interface Entry {
  id: string;
  date: string;
  start: Date;
  end: Date;
  breakMinutes: number;
  rate: number;
  note: string;
  paid: boolean;
  /** Empty when the shift isn't tied to a job. */
  jobId: string;
  /** Clock times as worked, so they don't move with the viewer's timezone. */
  startLocal: string;
  endLocal: string;
  endDate: string;
  /** Multipliers frozen when the shift was saved; null for pre-v0.4 entries. */
  payRules: PayRules | null;
  /** True until the write has reached the server (e.g. while offline). */
  pending: boolean;
}

export type EntryInput = Omit<Entry, 'id' | 'pending'>;

/** Active clock-in, shared across the user's devices. */
export interface ClockState {
  start: Date;
}

// Paths. Every document is scoped under users/{uid}; see firestore.rules.
const settingsRef = (uid: string) => doc(db, 'users', uid, 'settings', 'main');
const clockRef = (uid: string) => doc(db, 'users', uid, 'state', 'clock');
const entriesCol = (uid: string) => collection(db, 'users', uid, 'entries');
const jobsCol = (uid: string) => collection(db, 'users', uid, 'jobs');

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v || fallback : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

export function watchSettings(uid: string, cb: (s: Settings) => void): Unsubscribe {
  return onSnapshot(settingsRef(uid), (snap) => {
    const d = snap.data() ?? {};
    const D = DEFAULT_SETTINGS;
    cb({
      defaultRate: num(d.defaultRate, D.defaultRate),
      currency: str(d.currency, D.currency),
      defaultStart: str(d.defaultStart, D.defaultStart),
      defaultEnd: str(d.defaultEnd, D.defaultEnd),
      defaultBreakMinutes: num(d.defaultBreakMinutes, D.defaultBreakMinutes),
      lastJobId: str(d.lastJobId, ''),
      reportNote: bool(d.reportNote, D.reportNote),
      reportRate: bool(d.reportRate, D.reportRate),
      reportBreak: bool(d.reportBreak, D.reportBreak),
      reportEarnings: bool(d.reportEarnings, D.reportEarnings),
      overtimeAfterHours: num(d.overtimeAfterHours, D.overtimeAfterHours),
      overtimeMultiplier: num(d.overtimeMultiplier, D.overtimeMultiplier),
      nightStart: str(d.nightStart, D.nightStart),
      nightEnd: str(d.nightEnd, D.nightEnd),
      nightMultiplier: num(d.nightMultiplier, D.nightMultiplier),
      sundayMultiplier: num(d.sundayMultiplier, D.sundayMultiplier),
      invoiceFrom: str(d.invoiceFrom, ''),
      invoicePayment: str(d.invoicePayment, ''),
      invoicePrefix: str(d.invoicePrefix, D.invoicePrefix),
      invoiceCounter: num(d.invoiceCounter, D.invoiceCounter),
      vatPercent: num(d.vatPercent, D.vatPercent),
    });
  });
}

export function saveSettings(uid: string, s: Partial<Settings>): Promise<void> {
  return setDoc(settingsRef(uid), s, { merge: true });
}

// --- Jobs -------------------------------------------------------------------

export function watchJobs(uid: string, cb: (jobs: Job[]) => void, onError: (e: Error) => void): Unsubscribe {
  return onSnapshot(
    query(jobsCol(uid), orderBy('name')),
    (snap) =>
      cb(
        snap.docs.map((d) => {
          const v = d.data();
          return {
            id: d.id,
            name: str(v.name, 'Untitled'),
            rate: num(v.rate, 0),
            clientName: str(v.clientName, ''),
            clientDetails: str(v.clientDetails, ''),
          };
        }),
      ),
    onError,
  );
}

export function saveJob(uid: string, job: Omit<Job, 'id'> & { id?: string }): Promise<void> {
  const { id, ...fields } = job;
  const ref = id ? doc(jobsCol(uid), id) : doc(jobsCol(uid));
  return setDoc(ref, { ...fields, updatedAt: serverTimestamp() }, { merge: true });
}

/** Removes the job. Entries keep their jobId and show the job as missing. */
export function deleteJob(uid: string, id: string): Promise<void> {
  return deleteDoc(doc(jobsCol(uid), id));
}

// --- Clock ------------------------------------------------------------------

export function watchClock(uid: string, cb: (c: ClockState | null) => void): Unsubscribe {
  return onSnapshot(clockRef(uid), (snap) => {
    const start = snap.data()?.start;
    cb(start instanceof Timestamp ? { start: start.toDate() } : null);
  });
}

export function clockIn(uid: string, start = new Date()): Promise<void> {
  return setDoc(clockRef(uid), { start: Timestamp.fromDate(start) });
}

export function cancelClock(uid: string): Promise<void> {
  return deleteDoc(clockRef(uid));
}

// --- Entries ----------------------------------------------------------------

/** Entries whose date falls within [from, to] (inclusive, "YYYY-MM-DD"). */
export function watchEntries(
  uid: string,
  from: string,
  to: string,
  cb: (entries: Entry[]) => void,
  onError: (e: Error) => void,
): Unsubscribe {
  const q = query(entriesCol(uid), where('date', '>=', from), where('date', '<=', to), orderBy('date', 'desc'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const entries = snap.docs.map((d) => {
        const v = d.data();
        return {
          id: d.id,
          date: v.date,
          start: (v.start as Timestamp).toDate(),
          end: (v.end as Timestamp).toDate(),
          breakMinutes: num(v.breakMinutes, 0),
          rate: num(v.rate, 0),
          note: str(v.note, ''),
          paid: bool(v.paid, false),
          jobId: str(v.jobId, ''),
          startLocal: str(v.startLocal, ''),
          endLocal: str(v.endLocal, ''),
          endDate: str(v.endDate, ''),
          payRules: readRules(v.payRules),
          pending: d.metadata.hasPendingWrites,
        };
      });
      entries.sort((a, b) => (a.date === b.date ? b.start.getTime() - a.start.getTime() : a.date < b.date ? 1 : -1));
      cb(entries);
    },
    onError,
  );
}

/** Reads a frozen rule set, ignoring anything that isn't a complete one. */
function readRules(v: unknown): PayRules | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  if (typeof d.nightStart !== 'string' || typeof d.nightEnd !== 'string') return null;
  return {
    overtimeAfterHours: num(d.overtimeAfterHours, 0),
    overtimeMultiplier: num(d.overtimeMultiplier, 1),
    nightStart: d.nightStart,
    nightEnd: d.nightEnd,
    nightMultiplier: num(d.nightMultiplier, 1),
    sundayMultiplier: num(d.sundayMultiplier, 1),
  };
}

export function rulesOnly(s: PayRules): PayRules {
  return {
    overtimeAfterHours: s.overtimeAfterHours,
    overtimeMultiplier: s.overtimeMultiplier,
    nightStart: s.nightStart,
    nightEnd: s.nightEnd,
    nightMultiplier: s.nightMultiplier,
    sundayMultiplier: s.sundayMultiplier,
  };
}

function toFirestore(e: EntryInput) {
  return {
    date: e.date,
    start: Timestamp.fromDate(e.start),
    end: Timestamp.fromDate(e.end),
    breakMinutes: e.breakMinutes,
    rate: e.rate,
    note: e.note,
    paid: e.paid,
    jobId: e.jobId,
    startLocal: e.startLocal,
    endLocal: e.endLocal,
    endDate: e.endDate,
    payRules: e.payRules,
  };
}

// Writes resolve only once the server acknowledges them, which never happens
// while offline. Callers should not await them for UI flow; the local cache
// and onSnapshot update immediately.

export function addEntry(uid: string, e: EntryInput): Promise<void> {
  const ref = doc(entriesCol(uid));
  return setDoc(ref, { ...toFirestore(e), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}

/** Save the clocked shift as an entry and clear the clock in one atomic write. */
export function clockOut(uid: string, e: EntryInput): Promise<void> {
  const batch = writeBatch(db);
  batch.set(doc(entriesCol(uid)), { ...toFirestore(e), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.delete(clockRef(uid));
  return batch.commit();
}

export function updateEntry(uid: string, id: string, e: EntryInput): Promise<void> {
  return updateDoc(doc(entriesCol(uid), id), { ...toFirestore(e), updatedAt: serverTimestamp() });
}

export function deleteEntry(uid: string, id: string): Promise<void> {
  return deleteDoc(doc(entriesCol(uid), id));
}

/** Mark several entries paid or unpaid at once. Firestore allows 500 writes per batch. */
export async function setPaid(uid: string, ids: string[], paid: boolean): Promise<void> {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(i, i + 400)) {
      batch.update(doc(entriesCol(uid), id), { paid, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }
}

// --- Access list ------------------------------------------------------------

/**
 * Who may use this app, one document per email address. The rules check it on
 * every read and write, so removing someone locks them out immediately.
 */
export interface AllowedPerson {
  email: string;
  note: string;
}

const allowedCol = () => collection(db, 'allowed');
export const emailKey = (email: string) => email.trim().toLowerCase();

/** Watches whether this email may use the app. */
export function watchAccess(email: string, cb: (allowed: boolean) => void, onError: (e: Error) => void): Unsubscribe {
  return onSnapshot(doc(allowedCol(), emailKey(email)), (snap) => cb(snap.exists()), onError);
}

/** The whole list. Only the owner is allowed to read it. */
export function watchAllowed(cb: (people: AllowedPerson[]) => void, onError: (e: Error) => void): Unsubscribe {
  return onSnapshot(
    query(allowedCol(), orderBy('__name__')),
    (snap) => cb(snap.docs.map((d) => ({ email: d.id, note: str(d.data().note, '') }))),
    onError,
  );
}

export function allowPerson(email: string, note: string): Promise<void> {
  return setDoc(doc(allowedCol(), emailKey(email)), { note, addedAt: serverTimestamp() }, { merge: true });
}

export function revokePerson(email: string): Promise<void> {
  return deleteDoc(doc(allowedCol(), emailKey(email)));
}

// --- Whole-account export and delete ----------------------------------------

/** Everything this account has stored, for the user to keep. */
export async function exportEverything(uid: string): Promise<string> {
  const [entriesSnap, jobsSnap, settingsSnap] = await Promise.all([
    getDocs(query(entriesCol(uid), orderBy('date'))),
    getDocs(jobsCol(uid)),
    getDoc(settingsRef(uid)),
  ]);
  const plain = (v: unknown): unknown => (v instanceof Timestamp ? v.toDate().toISOString() : v);
  const mapDoc = (d: { id: string; data: () => Record<string, unknown> }) =>
    Object.fromEntries([['id', d.id], ...Object.entries(d.data()).map(([k, v]) => [k, plain(v)])]);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      settings: settingsSnap.data() ?? null,
      jobs: jobsSnap.docs.map(mapDoc),
      entries: entriesSnap.docs.map(mapDoc),
    },
    null,
    2,
  );
}

/** Deletes every document this account owns. Cannot be undone. */
export async function deleteEverything(uid: string): Promise<void> {
  const [entriesSnap, jobsSnap] = await Promise.all([getDocs(entriesCol(uid)), getDocs(jobsCol(uid))]);
  const refs = [...entriesSnap.docs, ...jobsSnap.docs].map((d) => d.ref);
  refs.push(settingsRef(uid), clockRef(uid));
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
}

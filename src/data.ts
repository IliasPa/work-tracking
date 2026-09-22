import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
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

export interface Settings {
  defaultRate: number;
  currency: string;
}

export const DEFAULT_SETTINGS: Settings = { defaultRate: 0, currency: 'EUR' };

export interface Entry {
  id: string;
  date: string;
  start: Date;
  end: Date;
  breakMinutes: number;
  rate: number;
  note: string;
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

export function watchSettings(uid: string, cb: (s: Settings) => void): Unsubscribe {
  return onSnapshot(settingsRef(uid), (snap) => {
    const d = snap.data();
    cb({
      defaultRate: typeof d?.defaultRate === 'number' ? d.defaultRate : DEFAULT_SETTINGS.defaultRate,
      currency: typeof d?.currency === 'string' && d.currency ? d.currency : DEFAULT_SETTINGS.currency,
    });
  });
}

export function saveSettings(uid: string, s: Settings): Promise<void> {
  return setDoc(settingsRef(uid), s, { merge: true });
}

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
          breakMinutes: v.breakMinutes ?? 0,
          rate: v.rate ?? 0,
          note: v.note ?? '',
          pending: d.metadata.hasPendingWrites,
        };
      });
      entries.sort((a, b) => (a.date === b.date ? b.start.getTime() - a.start.getTime() : a.date < b.date ? 1 : -1));
      cb(entries);
    },
    onError,
  );
}

function toFirestore(e: EntryInput) {
  return {
    date: e.date,
    start: Timestamp.fromDate(e.start),
    end: Timestamp.fromDate(e.end),
    breakMinutes: e.breakMinutes,
    rate: e.rate,
    note: e.note,
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

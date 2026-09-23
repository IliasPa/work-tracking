import { wallClockOf, type WallSource } from './time';

/**
 * Pay rules. A multiplier of 1 switches that rule off, as does an overtime
 * threshold of 0.
 */
export interface PayRules {
  /** Hours worked in one shift before overtime starts. 0 = no overtime. */
  overtimeAfterHours: number;
  overtimeMultiplier: number;
  /** Night window, e.g. 22:00 → 06:00. Wraps past midnight. */
  nightStart: string;
  nightEnd: string;
  nightMultiplier: number;
  sundayMultiplier: number;
}

export const NO_MULTIPLIERS: PayRules = {
  overtimeAfterHours: 0,
  overtimeMultiplier: 1.5,
  nightStart: '22:00',
  nightEnd: '06:00',
  nightMultiplier: 1,
  sundayMultiplier: 1,
};

export type PayReason = 'normal' | 'overtime' | 'night' | 'sunday';

export interface Pay {
  /** Hours actually worked: clock time minus the break. */
  hours: number;
  /** Hours the shift is paid as, after multipliers. */
  paidHours: number;
  earnings: number;
  /** Average multiplier across the shift (1 when no rule applied). */
  multiplier: number;
  /** Worked hours attributed to each reason, for reports. */
  breakdown: Record<PayReason, number>;
}

const minutesOfDay = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

function inNightWindow(minute: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  // A window like 22:00–06:00 wraps midnight; 01:00–05:00 doesn't.
  return startMin < endMin ? minute >= startMin && minute < endMin : minute >= startMin || minute < endMin;
}

export interface PayShift extends WallSource {
  breakMinutes: number;
  rate: number;
  /** Rules saved with the shift; when absent the current ones are used. */
  payRules?: PayRules | null;
}

/**
 * Works out what a shift pays. Every minute of the shift gets the highest
 * multiplier that applies to it (they don't stack), and the break is spread
 * evenly across the shift rather than taken off any particular part of it.
 *
 * Night and Sunday are judged by the clock where the shift was worked, so the
 * answer doesn't change when the same shift is opened in another timezone.
 */
export function payFor(shift: PayShift, rules: PayRules): Pay {
  const { startWall, endWall, totalMinutes } = wallClockOf(shift);
  const workedMinutes = Math.max(0, totalMinutes - shift.breakMinutes);
  const hours = workedMinutes / 60;
  // The walk follows the clock on the wall; over a daylight-saving change that
  // is an hour longer or shorter than the time actually elapsed.
  const wallMinutes = Math.max(1, Math.round((endWall.getTime() - startWall.getTime()) / 60_000));
  const nightStart = minutesOfDay(rules.nightStart);
  const nightEnd = minutesOfDay(rules.nightEnd);

  // Overtime counts worked hours, so the threshold is stretched over the clock
  // time in the same proportion the break was spread.
  const overtimeAfter =
    rules.overtimeAfterHours > 0 && workedMinutes > 0
      ? (rules.overtimeAfterHours * 60 * wallMinutes) / workedMinutes
      : Infinity;

  const breakdownMinutes: Record<PayReason, number> = { normal: 0, overtime: 0, night: 0, sunday: 0 };
  let sum = 0;
  const cursor = new Date(startWall);
  for (let i = 0; i < wallMinutes; i++) {
    const isNight = inNightWindow(cursor.getHours() * 60 + cursor.getMinutes(), nightStart, nightEnd);
    const isSunday = cursor.getDay() === 0;

    // The overtime threshold can fall mid-minute, so this minute may be part
    // ordinary and part overtime. Each part is paid at its own rate.
    const overtimePart = Math.min(1, Math.max(0, i + 1 - overtimeAfter));
    const take = (withOvertime: boolean, weight: number) => {
      if (weight <= 0) return;
      const candidates: [PayReason, number][] = [['normal', 1]];
      if (withOvertime) candidates.push(['overtime', rules.overtimeMultiplier]);
      if (isNight) candidates.push(['night', rules.nightMultiplier]);
      if (isSunday) candidates.push(['sunday', rules.sundayMultiplier]);
      let best: [PayReason, number] = candidates[0];
      for (const c of candidates) if (c[1] > best[1]) best = c;
      breakdownMinutes[best[0]] += weight;
      sum += best[1] * weight;
    };
    take(false, 1 - overtimePart);
    take(true, overtimePart);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  const multiplier = sum / wallMinutes;
  const paidHours = (workedMinutes / 60) * multiplier;
  // Scale the breakdown to worked hours so the parts add up to `hours`.
  const scale = workedMinutes / wallMinutes / 60;
  const breakdown = {
    normal: breakdownMinutes.normal * scale,
    overtime: breakdownMinutes.overtime * scale,
    night: breakdownMinutes.night * scale,
    sunday: breakdownMinutes.sunday * scale,
  };

  return { hours, paidHours, earnings: paidHours * shift.rate, multiplier, breakdown };
}

/** True when any rule could change what a shift pays. */
export function rulesActive(rules: PayRules): boolean {
  return (
    (rules.overtimeAfterHours > 0 && rules.overtimeMultiplier !== 1) ||
    rules.nightMultiplier !== 1 ||
    rules.sundayMultiplier !== 1
  );
}

/** Short labels for the reasons that actually applied, e.g. ["night", "overtime"]. */
export function reasonsApplied(pay: Pay): PayReason[] {
  return (['overtime', 'night', 'sunday'] as PayReason[]).filter((r) => pay.breakdown[r] > 0.001);
}

/** Pay for a shift, using the rules frozen onto it when it has them. */
export function payOfEntry(shift: PayShift, current: PayRules): Pay {
  return payFor(shift, shift.payRules ?? current);
}

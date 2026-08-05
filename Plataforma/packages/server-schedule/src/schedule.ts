import type { ScheduleTrigger } from '@voidfall/contracts';

/**
 * A refusal from the schedule engine. Deliberately opaque: a caller acts on the
 * fact that a trigger could not be resolved, never on why.
 */
export class ScheduleError extends Error {
  public readonly code: 'invalid-trigger';

  public constructor() {
    super('schedule:invalid-trigger');
    this.name = 'ScheduleError';
    this.code = 'invalid-trigger';
  }
}

/**
 * When a schedule next fires.
 *
 * This is arithmetic on a wall clock in a named zone, which is the part of
 * scheduling that quietly goes wrong. "Restart at 04:00" is meaningless without
 * a zone — a server whose operators are in São Paulo and whose host runs in UTC
 * restarts during peak hours, and the bug surfaces twice a year when a DST
 * transition moves it again.
 *
 * The computation walks forward day by day in the target zone rather than
 * adding 24-hour blocks. A day is not always 24 hours: on a DST transition it
 * is 23 or 25, and adding fixed blocks drifts the local time by an hour and
 * keeps it drifted.
 *
 * Two transition cases are handled explicitly because they have no single right
 * answer, only a right choice:
 *
 *  - **The hour does not exist** (clocks jumped forward over 02:30). The run is
 *    placed at the first instant that does exist, so a nightly restart is not
 *    silently skipped once a year.
 *  - **The hour happens twice** (clocks fell back). The *first* occurrence is
 *    taken, so the run happens once and earlier rather than once and later.
 */

const MAXIMUM_SEARCH_DAYS = 400;

/** Reads the wall-clock fields an instant has in a given zone. */
function zonedParts(instant: Date, timezone: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = new Map(
    formatter.formatToParts(instant).map((part) => [part.type, part.value] as const),
  );
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdayNames.indexOf(parts.get('weekday') ?? '');
  // `hour` can format as 24 for midnight in some environments; normalise it so
  // a midnight schedule is not read as an impossible hour.
  const hour = Number(parts.get('hour') ?? '0') % 24;
  return {
    year: Number(parts.get('year') ?? '0'),
    month: Number(parts.get('month') ?? '0'),
    day: Number(parts.get('day') ?? '0'),
    hour,
    minute: Number(parts.get('minute') ?? '0'),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

/** The zone's offset from UTC, in minutes, at a given instant. */
function offsetMinutes(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // Seconds are dropped by the formatter, so compare against a truncated
  // instant or the offset picks up a spurious sub-minute remainder.
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return (asUtc - truncated) / 60_000;
}

/**
 * The instant at which a given local wall-clock time occurs.
 *
 * Resolved by guessing with one offset and re-checking with the offset that
 * actually applies at the guessed instant — a single pass is wrong across a
 * transition, because the offset before the jump is not the offset after it.
 */
function instantForLocalTime(input: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly timezone: string;
}): { readonly instant: Date; readonly exact: boolean } {
  const target = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  let guess = new Date(target - offsetMinutes(new Date(target), input.timezone) * 60_000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const corrected = new Date(target - offsetMinutes(guess, input.timezone) * 60_000);
    if (corrected.getTime() === guess.getTime()) break;
    guess = corrected;
  }
  const actual = zonedParts(guess, input.timezone);
  const exact = actual.hour === input.hour && actual.minute === input.minute;
  return { instant: guess, exact };
}

/**
 * The next instant at or after `after` at which the trigger fires.
 *
 * `after` is exclusive: a schedule that just ran at exactly its own time must
 * advance to the following occurrence, not return the one it is standing on.
 */
export function nextRunAfter(input: {
  readonly trigger: ScheduleTrigger;
  readonly after: Date;
}): Date {
  const { trigger } = input;
  if (
    !Number.isInteger(trigger.hour) ||
    trigger.hour < 0 ||
    trigger.hour > 23 ||
    !Number.isInteger(trigger.minute) ||
    trigger.minute < 0 ||
    trigger.minute > 59
  ) {
    throw new ScheduleError();
  }
  let probe: { year: number; month: number; day: number };
  try {
    const parts = zonedParts(input.after, trigger.timezone);
    probe = { year: parts.year, month: parts.month, day: parts.day };
  } catch {
    throw new ScheduleError();
  }

  const weekdays = new Set(trigger.weekdays);
  for (let day = 0; day < MAXIMUM_SEARCH_DAYS; day += 1) {
    // Walk the calendar in UTC only to enumerate dates; the zone decides what
    // instant each local time corresponds to.
    const cursor = new Date(Date.UTC(probe.year, probe.month - 1, probe.day + day, 12));
    const cursorParts = zonedParts(cursor, trigger.timezone);
    if (weekdays.size > 0 && !weekdays.has(cursorParts.weekday)) continue;

    const resolved = instantForLocalTime({
      year: cursorParts.year,
      month: cursorParts.month,
      day: cursorParts.day,
      hour: trigger.hour,
      minute: trigger.minute,
      timezone: trigger.timezone,
    });
    // A local time that does not exist resolves to the first instant that does,
    // so a nightly run is not silently skipped once a year.
    if (resolved.instant.getTime() > input.after.getTime()) return resolved.instant;
  }
  throw new ScheduleError();
}

/**
 * The occurrence a run belongs to.
 *
 * Deduplication keys on this rather than on wall-clock arrival, so a scheduler
 * that woke twice — or two schedulers that woke at once, or one catching up
 * after a crash — produce one run for one occurrence.
 */
export function occurrenceKey(scheduleId: string, scheduledFor: Date): string {
  return `${scheduleId}:${scheduledFor.toISOString()}`;
}

/**
 * Occurrences missed while nothing was running.
 *
 * A scheduler that was down for a day must not fire yesterday's maintenance
 * window on the way back up: those instants have passed and running them now
 * would restart a live server at an hour nobody chose. Missed occurrences are
 * reported so they can be recorded as skipped, which is a fact worth having,
 * and never executed.
 */
export function missedOccurrences(input: {
  readonly trigger: ScheduleTrigger;
  readonly since: Date;
  readonly now: Date;
  readonly limit?: number;
}): readonly Date[] {
  const limit = Math.min(Math.max(input.limit ?? 32, 1), 512);
  const missed: Date[] = [];
  let cursor = input.since;
  while (missed.length < limit) {
    const next = nextRunAfter({ trigger: input.trigger, after: cursor });
    if (next.getTime() > input.now.getTime()) break;
    missed.push(next);
    cursor = next;
  }
  return Object.freeze(missed);
}

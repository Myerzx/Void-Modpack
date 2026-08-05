import { createHash } from 'node:crypto';

import { TelemetryError } from './aggregation.js';

/**
 * Structured logs: grouping and correlation.
 *
 * A thousand copies of one exception are one problem, and reading them as a
 * thousand is how the other problem in the same window goes unseen. Grouping
 * folds occurrences onto a stable fingerprint so an operator sees "this failed
 * 1,043 times" instead of scrolling.
 *
 * The fingerprint is computed from the message with its **variable parts
 * removed** — identifiers, numbers, addresses, paths, timestamps. Two
 * occurrences of the same fault differ exactly in those, so leaving them in
 * would give every occurrence its own group and grouping would do nothing.
 *
 * The same normalisation redacts. A grouped message is shown on a screen, and a
 * log line is one of the likelier places for a secret to appear.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface StructuredLogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly occurredAt: string;
  /** Ties a log line to the request or operation that produced it. */
  readonly correlationId: string | null;
}

export interface LogGroup {
  /** Stable across occurrences of the same fault. */
  readonly fingerprint: string;
  readonly level: LogLevel;
  /** Already normalised and redacted; never the raw line. */
  readonly template: string;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /**
   * Correlation ids that produced this group, bounded. Enough to jump to a few
   * concrete cases without the group becoming a copy of the log.
   */
  readonly correlationIds: readonly string[];
}

const MAXIMUM_MESSAGE_LENGTH = 2_048;
const MAXIMUM_CORRELATION_SAMPLES = 5;
const MAXIMUM_ENTRIES = 100_000;

/**
 * Strips what varies between occurrences, and what must never be displayed.
 *
 * Order matters: secrets are masked before numbers are collapsed, or a token
 * made of digits would become `<n>` and look harmless while a different token
 * survived.
 */
export function normalizeLogMessage(message: string): string {
  if (typeof message !== 'string') throw new TelemetryError('invalid-reading');
  let text = message.slice(0, MAXIMUM_MESSAGE_LENGTH);

  const mask = (pattern: RegExp, replacement: string): void => {
    text = text.replace(pattern, replacement);
  };

  // Secrets first, for the reason above.
  mask(/\b(?:password|passwd|secret|token|api[_-]?key|credential)\s*[:=]\s*\S+/giu, '$&'.replace(/.*/u, '<secret>'));
  mask(/\bBearer\s+[A-Za-z0-9._-]+/giu, '<secret>');
  // Then the identifiers that make every occurrence unique.
  mask(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<uuid>');
  mask(/\b[0-9a-f]{32,}\b/giu, '<hash>');
  mask(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/gu, '<timestamp>');
  mask(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/gu, '<address>');
  // Paths leak host layout and differ per install.
  mask(/\b[A-Za-z]:\\[^\s"']*/gu, '<path>');
  mask(/(?:^|\s)\/(?:home|srv|opt|etc|var|root|tmp)\/[^\s"']*/gu, ' <path>');
  // No word boundaries: `30000ms` has none before `ms`, so a bounded pattern
  // would leave the number in and give every duration its own group.
  mask(/\d+/gu, '<n>');
  // Collapse whitespace so formatting differences do not split a group.
  mask(/\s+/gu, ' ');

  return text.trim();
}

export function logFingerprint(level: LogLevel, normalizedMessage: string): string {
  return createHash('sha256')
    .update(`voidfall-log-group ${level} ${normalizedMessage}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Folds entries into groups, newest activity first.
 *
 * Ordering is by last occurrence and then by fingerprint: two groups that last
 * fired in the same millisecond must not change places between calls, or a
 * paging reader would see one twice and miss another.
 */
export function groupLogEntries(entries: readonly StructuredLogEntry[]): readonly LogGroup[] {
  if (!Array.isArray(entries) || entries.length > MAXIMUM_ENTRIES) {
    throw new TelemetryError('invalid-window');
  }

  interface Accumulator {
    readonly fingerprint: string;
    readonly level: LogLevel;
    readonly template: string;
    occurrences: number;
    firstSeenAt: string;
    lastSeenAt: string;
    readonly correlationIds: Set<string>;
  }

  const groups = new Map<string, Accumulator>();
  for (const entry of entries) {
    const observed = Date.parse(entry.occurredAt);
    if (!Number.isFinite(observed)) throw new TelemetryError('invalid-reading');
    const template = normalizeLogMessage(entry.message);
    const fingerprint = logFingerprint(entry.level, template);
    const existing = groups.get(fingerprint);
    if (existing === undefined) {
      groups.set(fingerprint, {
        fingerprint,
        level: entry.level,
        template,
        occurrences: 1,
        firstSeenAt: entry.occurredAt,
        lastSeenAt: entry.occurredAt,
        correlationIds: new Set(entry.correlationId === null ? [] : [entry.correlationId]),
      });
      continue;
    }
    existing.occurrences += 1;
    if (Date.parse(entry.occurredAt) < Date.parse(existing.firstSeenAt)) {
      existing.firstSeenAt = entry.occurredAt;
    }
    if (Date.parse(entry.occurredAt) > Date.parse(existing.lastSeenAt)) {
      existing.lastSeenAt = entry.occurredAt;
    }
    if (entry.correlationId !== null && existing.correlationIds.size < MAXIMUM_CORRELATION_SAMPLES) {
      existing.correlationIds.add(entry.correlationId);
    }
  }

  return Object.freeze(
    [...groups.values()]
      .sort((left, right) => {
        const difference = Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
        if (difference !== 0) return difference;
        return left.fingerprint < right.fingerprint ? -1 : 1;
      })
      .map((group) =>
        Object.freeze({
          fingerprint: group.fingerprint,
          level: group.level,
          template: group.template,
          occurrences: group.occurrences,
          firstSeenAt: group.firstSeenAt,
          lastSeenAt: group.lastSeenAt,
          correlationIds: Object.freeze([...group.correlationIds].sort()),
        }),
      ),
  );
}

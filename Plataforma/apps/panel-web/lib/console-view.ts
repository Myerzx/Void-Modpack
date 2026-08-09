export type ConsoleStream = 'stdout' | 'stderr';

export interface ConsoleLine {
  readonly sequence: number;
  readonly stream: ConsoleStream;
  readonly text: string;
  readonly occurredAt: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

export interface ConsolePage {
  readonly schemaVersion: 1;
  readonly serverInstanceId: string;
  readonly lines: readonly ConsoleLine[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly oldestRetainedSequence: number | null;
  readonly readAt: string;
}

export interface ConsoleViewState {
  readonly lines: readonly ConsoleLine[];
  readonly nextCursor: number | null;
  readonly retentionGap: boolean;
}

export const EMPTY_CONSOLE_VIEW: ConsoleViewState = Object.freeze({
  lines: Object.freeze([]),
  nextCursor: null,
  retentionGap: false,
});

function isConsoleLine(value: unknown): value is ConsoleLine {
  if (value === null || typeof value !== 'object') return false;
  const line = value as Partial<ConsoleLine>;
  return (
    Number.isSafeInteger(line.sequence) &&
    (line.sequence ?? 0) >= 1 &&
    (line.stream === 'stdout' || line.stream === 'stderr') &&
    typeof line.text === 'string' &&
    typeof line.occurredAt === 'string' &&
    !Number.isNaN(Date.parse(line.occurredAt)) &&
    typeof line.truncated === 'boolean' &&
    typeof line.redacted === 'boolean'
  );
}

/** Refuses malformed API data before it reaches the operational log view. */
export function readConsolePage(value: unknown, serverInstanceId: string): ConsolePage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const page = value as Partial<ConsolePage>;
  if (
    page.schemaVersion !== 1 ||
    page.serverInstanceId !== serverInstanceId ||
    !Array.isArray(page.lines) ||
    !page.lines.every(isConsoleLine) ||
    !(
      page.nextCursor === null ||
      (Number.isSafeInteger(page.nextCursor) && (page.nextCursor ?? 0) >= 1)
    ) ||
    typeof page.hasMore !== 'boolean' ||
    !(
      page.oldestRetainedSequence === null ||
      (Number.isSafeInteger(page.oldestRetainedSequence) &&
        (page.oldestRetainedSequence ?? 0) >= 1)
    ) ||
    typeof page.readAt !== 'string' ||
    Number.isNaN(Date.parse(page.readAt))
  ) {
    return undefined;
  }
  return page as ConsolePage;
}

/**
 * Adds one cursor page without repeating a sequence and bounds browser memory.
 * A retention gap is sticky so an operator cannot miss that unseen lines were
 * discarded while this tab was paused or disconnected.
 */
export function mergeConsolePage(
  current: ConsoleViewState,
  page: ConsolePage,
  maximumLines = 1_000,
): ConsoleViewState {
  if (!Number.isSafeInteger(maximumLines) || maximumLines < 1 || maximumLines > 10_000) {
    throw new Error('maximumLines is outside the safe range.');
  }
  const bySequence = new Map<number, ConsoleLine>();
  for (const line of current.lines) bySequence.set(line.sequence, line);
  for (const line of page.lines) bySequence.set(line.sequence, line);
  const ordered = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const lines = Object.freeze(
    ordered.length > maximumLines ? ordered.slice(-maximumLines) : ordered,
  );
  const fellBehind =
    current.nextCursor !== null &&
    page.oldestRetainedSequence !== null &&
    current.nextCursor < page.oldestRetainedSequence;
  return Object.freeze({
    lines,
    nextCursor: page.nextCursor ?? current.nextCursor,
    retentionGap: current.retentionGap || fellBehind,
  });
}


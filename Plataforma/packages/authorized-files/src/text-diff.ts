import { AuthorizedFileOperationError } from './types.js';

/**
 * A line diff that can be shown to an operator without showing them a secret.
 *
 * The ordering here is the whole point. Lines are matched on their **raw**
 * text and redacted only on the way out. Redacting first would collapse
 * `rcon.password=old` and `rcon.password=new` into the same masked string, the
 * diff would call the line unchanged, and a credential rotation would be
 * invisible in the very view meant to review it. Matching raw and masking late
 * gives the honest answer — "this line changed, and you may not see how".
 *
 * Nothing here touches the filesystem, so the whole policy is testable against
 * plain strings.
 */

const MAXIMUM_LINES = 20_000;
const MAXIMUM_LINE_LENGTH = 512;
/**
 * Bound on the LCS table after common prefix and suffix are removed. A table is
 * `left * right` cells, so an unbounded diff of two large unrelated files is a
 * memory exhaustion an operator can trigger from a text box.
 */
const MAXIMUM_MATRIX_CELLS = 4_000_000;

export type TextDiffChangeType = 'unchanged' | 'added' | 'removed';

export interface TextDiffLine {
  readonly type: TextDiffChangeType;
  /** 1-based line number on the side this line belongs to; `null` if absent. */
  readonly previousLineNumber: number | null;
  readonly currentLineNumber: number | null;
  /** Already redacted. Never the raw line. */
  readonly text: string;
  /** True when redaction removed something from this line. */
  readonly redacted: boolean;
  /** True when the line was longer than the display bound and was cut. */
  readonly truncated: boolean;
}

export interface TextDiff {
  readonly lines: readonly TextDiffLine[];
  readonly addedCount: number;
  readonly removedCount: number;
  /**
   * True when at least one *changed* line was redacted — the signal that the
   * diff is telling the truth about a change it cannot show.
   */
  readonly containsRedactedChange: boolean;
}

/**
 * Masks what must not be shown even to someone allowed to edit the file.
 *
 * Mirrors `redactConsoleText`: replace unconditionally and compare, because a
 * global regex advances its own `lastIndex` during `test`, which makes
 * test-then-replace quietly depend on call order.
 */
export function redactFileLine(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;

  const mask = (pattern: RegExp, replacement: string): void => {
    const masked = text.replace(pattern, replacement);
    if (masked === text) return;
    text = masked;
    redacted = true;
  };

  // A property-style assignment whose key announces a secret. The key is kept
  // so the operator still knows *which* setting changed.
  mask(
    /^(\s*[\w.-]*(?:password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|seed)[\w.-]*\s*[:=]\s*)(\S.*)$/giu,
    '$1[segredo removido]',
  );
  // The same shape mid-line, for formats that put several pairs on one line.
  mask(
    /\b([\w.-]*(?:password|passwd|secret|token|api[_-]?key|credential)[\w.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/giu,
    '$1[segredo removido]',
  );
  // An address identifies a host or a player's location.
  mask(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/gu, '[endereço removido]');
  // A filesystem path leaks host layout.
  mask(/\b[A-Za-z]:\\[^\s"']*/gu, '[caminho removido]');
  mask(/(?:^|\s)\/(?:home|srv|opt|etc|var|root)\/[^\s"']*/gu, ' [caminho removido]');

  let cleaned = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09 || codePoint >= 0x20) cleaned += character;
    else redacted = true;
  }

  return { text: cleaned, redacted };
}

function splitLines(value: string): readonly string[] {
  // Empty text is zero lines, not one empty one — otherwise a file that does
  // not exist would diff as having a blank line added to it, and the review of
  // a deletion would show a phantom line nobody wrote.
  if (value === '') return [];
  // A trailing newline denotes a terminated last line, not an extra empty one.
  const normalized = value.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function present(raw: string, type: TextDiffChangeType, previous: number | null, current: number | null): TextDiffLine {
  const truncated = raw.length > MAXIMUM_LINE_LENGTH;
  const bounded = truncated ? raw.slice(0, MAXIMUM_LINE_LENGTH) : raw;
  const { text, redacted } = redactFileLine(bounded);
  return Object.freeze({
    type,
    previousLineNumber: previous,
    currentLineNumber: current,
    text,
    redacted,
    truncated,
  });
}

/**
 * Longest common subsequence over the region that actually differs.
 *
 * Common prefix and suffix are removed first, which is what makes a one-line
 * edit in a large file cheap rather than quadratic.
 */
function alignedOperations(
  previous: readonly string[],
  current: readonly string[],
): readonly { readonly type: TextDiffChangeType; readonly previousIndex: number; readonly currentIndex: number }[] {
  const operations: { type: TextDiffChangeType; previousIndex: number; currentIndex: number }[] = [];

  let head = 0;
  while (head < previous.length && head < current.length && previous[head] === current[head]) {
    operations.push({ type: 'unchanged', previousIndex: head, currentIndex: head });
    head += 1;
  }

  let tail = 0;
  while (
    tail < previous.length - head &&
    tail < current.length - head &&
    previous[previous.length - 1 - tail] === current[current.length - 1 - tail]
  ) {
    tail += 1;
  }

  const leftMiddle = previous.slice(head, previous.length - tail);
  const rightMiddle = current.slice(head, current.length - tail);

  if ((leftMiddle.length + 1) * (rightMiddle.length + 1) > MAXIMUM_MATRIX_CELLS) {
    throw new AuthorizedFileOperationError('diff-too-large', 'read');
  }

  const width = rightMiddle.length + 1;
  const table = new Int32Array((leftMiddle.length + 1) * width);
  for (let left = leftMiddle.length - 1; left >= 0; left -= 1) {
    for (let right = rightMiddle.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      table[index] =
        leftMiddle[left] === rightMiddle[right]
          ? (table[(left + 1) * width + right + 1] ?? 0) + 1
          : Math.max(table[(left + 1) * width + right] ?? 0, table[index + 1] ?? 0);
    }
  }

  let left = 0;
  let right = 0;
  while (left < leftMiddle.length && right < rightMiddle.length) {
    if (leftMiddle[left] === rightMiddle[right]) {
      operations.push({
        type: 'unchanged',
        previousIndex: head + left,
        currentIndex: head + right,
      });
      left += 1;
      right += 1;
    } else if ((table[(left + 1) * width + right] ?? 0) >= (table[left * width + right + 1] ?? 0)) {
      operations.push({ type: 'removed', previousIndex: head + left, currentIndex: -1 });
      left += 1;
    } else {
      operations.push({ type: 'added', previousIndex: -1, currentIndex: head + right });
      right += 1;
    }
  }
  for (; left < leftMiddle.length; left += 1) {
    operations.push({ type: 'removed', previousIndex: head + left, currentIndex: -1 });
  }
  for (; right < rightMiddle.length; right += 1) {
    operations.push({ type: 'added', previousIndex: -1, currentIndex: head + right });
  }

  for (let index = tail; index > 0; index -= 1) {
    operations.push({
      type: 'unchanged',
      previousIndex: previous.length - index,
      currentIndex: current.length - index,
    });
  }

  return operations;
}

/**
 * Diffs two texts, emitting only redacted lines.
 *
 * Both sides are bounded before any work happens: a caller must not be able to
 * make the service allocate a table proportional to a file it just uploaded.
 */
export function diffText(previousText: string, currentText: string): TextDiff {
  if (typeof previousText !== 'string' || typeof currentText !== 'string') {
    throw new AuthorizedFileOperationError('invalid-plan', 'plan');
  }
  const previous = splitLines(previousText);
  const current = splitLines(currentText);
  if (previous.length > MAXIMUM_LINES || current.length > MAXIMUM_LINES) {
    throw new AuthorizedFileOperationError('diff-too-large', 'read');
  }

  const lines: TextDiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let containsRedactedChange = false;

  for (const operation of alignedOperations(previous, current)) {
    if (operation.type === 'unchanged') {
      const raw = previous[operation.previousIndex] ?? '';
      lines.push(present(raw, 'unchanged', operation.previousIndex + 1, operation.currentIndex + 1));
      continue;
    }
    if (operation.type === 'removed') {
      const raw = previous[operation.previousIndex] ?? '';
      const line = present(raw, 'removed', operation.previousIndex + 1, null);
      removedCount += 1;
      if (line.redacted) containsRedactedChange = true;
      lines.push(line);
      continue;
    }
    const raw = current[operation.currentIndex] ?? '';
    const line = present(raw, 'added', null, operation.currentIndex + 1);
    addedCount += 1;
    if (line.redacted) containsRedactedChange = true;
    lines.push(line);
  }

  return Object.freeze({
    lines: Object.freeze(lines),
    addedCount,
    removedCount,
    containsRedactedChange,
  });
}

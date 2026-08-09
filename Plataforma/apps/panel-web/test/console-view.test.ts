import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_CONSOLE_VIEW,
  mergeConsolePage,
  readConsolePage,
  type ConsoleLine,
  type ConsolePage,
} from '../lib/console-view';

const line = (sequence: number, text: string): ConsoleLine => ({
  sequence,
  stream: 'stdout',
  text,
  occurredAt: '2026-08-09T12:00:00.000Z',
  truncated: false,
  redacted: false,
});

const page = (lines: readonly ConsoleLine[], nextCursor: number): ConsolePage => ({
  schemaVersion: 1,
  serverInstanceId: 'server-1',
  lines,
  nextCursor,
  hasMore: false,
  oldestRetainedSequence: lines[0]?.sequence ?? null,
  readAt: '2026-08-09T12:00:01.000Z',
});

describe('console view', () => {
  it('deduplicates overlapping cursor pages and bounds browser memory', () => {
    const initial = mergeConsolePage(EMPTY_CONSOLE_VIEW, page([line(8, 'eight'), line(9, 'nine')], 10));
    const merged = mergeConsolePage(initial, page([line(9, 'nine'), line(10, 'ten')], 11), 2);

    assert.deepEqual(merged.lines.map((entry) => entry.sequence), [9, 10]);
    assert.equal(merged.nextCursor, 11);
    assert.equal(merged.retentionGap, false);
  });

  it('keeps a visible warning when retention passed the reader cursor', () => {
    const initial = mergeConsolePage(EMPTY_CONSOLE_VIEW, page([line(1, 'one')], 2));
    const afterGap = mergeConsolePage(initial, {
      ...page([line(7, 'seven')], 8),
      oldestRetainedSequence: 7,
    });
    assert.equal(afterGap.retentionGap, true);
    assert.equal(mergeConsolePage(afterGap, page([line(8, 'eight')], 9)).retentionGap, true);
  });

  it('validates the server identity and every line before rendering', () => {
    const valid = page([line(1, 'ready')], 2);
    assert.deepEqual(readConsolePage(valid, 'server-1'), valid);
    assert.equal(readConsolePage(valid, 'another-server'), undefined);
    assert.equal(
      readConsolePage({ ...valid, lines: [{ ...valid.lines[0], sequence: 0 }] }, 'server-1'),
      undefined,
    );
  });
});

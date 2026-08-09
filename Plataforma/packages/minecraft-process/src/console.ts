import type { ProcessOutputSnapshot } from './runtime.js';

const DEFAULT_MAXIMUM_LINES_PER_STREAM = 200;
const DEFAULT_MAXIMUM_CHARACTERS_PER_LINE = 1_024;
const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
const NON_PRINTING_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export type MinecraftConsoleCommand = 'list-players' | 'save-all';

export const MINECRAFT_CONSOLE_COMMANDS = Object.freeze([
  'list-players',
  'save-all',
] as const satisfies readonly MinecraftConsoleCommand[]);

const COMMAND_LITERALS: Readonly<Record<MinecraftConsoleCommand, string>> = Object.freeze({
  'list-players': 'list\n',
  'save-all': 'save-all flush\n',
});

export interface MinecraftConsoleLine {
  readonly text: string;
  readonly truncated: boolean;
}

export interface MinecraftConsoleStreamSnapshot {
  readonly lines: readonly MinecraftConsoleLine[];
  readonly sourceTruncated: boolean;
  readonly viewTruncated: boolean;
}

export interface MinecraftConsoleSnapshot {
  readonly readAt: string;
  readonly source: 'process-adapter';
  readonly stdout: MinecraftConsoleStreamSnapshot;
  readonly stderr: MinecraftConsoleStreamSnapshot;
}

export interface MinecraftConsoleDeltaLine {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly occurredAt: string;
  readonly truncated: boolean;
}

/**
 * A retryable batch of lines not yet acknowledged by the persistence loop.
 *
 * Reading does not discard the batch. The agent acknowledges exactly
 * `acknowledgementCount` only after PostgreSQL commits it, so a transient
 * database failure cannot silently eat live console output.
 */
export interface MinecraftConsoleDelta {
  readonly readAt: string;
  readonly source: 'process-adapter';
  readonly lines: readonly MinecraftConsoleDeltaLine[];
  readonly acknowledgementCount: number;
  readonly sourceTruncated: boolean;
}

export interface MinecraftConsoleSnapshotOptions {
  readonly maximumLinesPerStream?: number;
  readonly maximumCharactersPerLine?: number;
  readonly clock?: () => Date;
}

export interface MinecraftConsoleCommandReceipt {
  readonly command: MinecraftConsoleCommand;
  readonly dispatchedAt: string;
  readonly source: 'process-adapter';
  readonly state: 'online';
}

export function validateMinecraftConsoleCommand(value: unknown): MinecraftConsoleCommand {
  if (value === 'list-players' || value === 'save-all') return value;
  throw new Error('Minecraft console command is not allowed.');
}

export function minecraftConsoleCommandLiteral(value: unknown): string {
  return COMMAND_LITERALS[validateMinecraftConsoleCommand(value)];
}

function validateBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} is outside the safe range.`);
  }
}

export function sanitizeMinecraftConsoleLine(
  value: string,
  maximumCharacters = DEFAULT_MAXIMUM_CHARACTERS_PER_LINE,
): MinecraftConsoleLine {
  validateBoundedInteger(maximumCharacters, 32, 4_096, 'maximumCharactersPerLine');
  const printable = value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(NON_PRINTING_CONTROL_PATTERN, '');
  const characters = [...printable];
  const truncated = characters.length > maximumCharacters;
  return Object.freeze({
    text: truncated ? characters.slice(0, maximumCharacters).join('') : printable,
    truncated,
  });
}

function streamSnapshot(
  value: string,
  sourceTruncated: boolean,
  maximumLines: number,
  maximumCharacters: number,
): MinecraftConsoleStreamSnapshot {
  const normalized = value.replace(/\r\n?/gu, '\n');
  const split = normalized.split('\n');
  if (split.at(-1) === '') split.pop();
  const viewDroppedLines = split.length > maximumLines;
  const selected = viewDroppedLines ? split.slice(-maximumLines) : split;
  const lines = Object.freeze(
    selected.map((line) => sanitizeMinecraftConsoleLine(line, maximumCharacters)),
  );
  return Object.freeze({
    lines,
    sourceTruncated,
    viewTruncated: viewDroppedLines || lines.some((line) => line.truncated),
  });
}

export function createMinecraftConsoleSnapshot(
  output: ProcessOutputSnapshot,
  options: MinecraftConsoleSnapshotOptions = {},
): MinecraftConsoleSnapshot {
  const maximumLines = options.maximumLinesPerStream ?? DEFAULT_MAXIMUM_LINES_PER_STREAM;
  const maximumCharacters =
    options.maximumCharactersPerLine ?? DEFAULT_MAXIMUM_CHARACTERS_PER_LINE;
  validateBoundedInteger(maximumLines, 1, 1_000, 'maximumLinesPerStream');
  validateBoundedInteger(maximumCharacters, 32, 4_096, 'maximumCharactersPerLine');
  const clock = options.clock ?? (() => new Date());
  const readAt = clock();
  if (!(readAt instanceof Date) || Number.isNaN(readAt.getTime())) {
    throw new Error('Minecraft console clock returned an invalid date.');
  }
  return Object.freeze({
    readAt: readAt.toISOString(),
    source: 'process-adapter',
    stdout: streamSnapshot(
      output.stdout,
      output.stdoutTruncated,
      maximumLines,
      maximumCharacters,
    ),
    stderr: streamSnapshot(
      output.stderr,
      output.stderrTruncated,
      maximumLines,
      maximumCharacters,
    ),
  });
}

import { Type, type Static } from '@sinclair/typebox';
import { ContractSchemaVersion, IsoDateTimeSchema, UuidSchema } from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contracts for the Phase 10.1 process and console operations.
 *
 * A request names a reviewed action and nothing else. No contract here carries
 * a launch plan, an executable, a working directory, a shell fragment or a
 * free-form command: the agent capability resolves all of that from trusted
 * local configuration, exactly as Phase 7.3 established.
 *
 * Force kill is deliberately not one of the ordinary actions. It is a separate
 * request with its own permission and its own explicit confirmation, because a
 * stop that quietly escalates to a kill is how worlds get corrupted.
 */

export const ProcessControlActionSchema = Type.Union([
  Type.Literal('start'),
  Type.Literal('stop'),
  Type.Literal('restart'),
]);

export const ProcessReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const IdempotencyKeySchema = Type.String({
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
});

export const ProcessControlRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    action: ProcessControlActionSchema,
    idempotencyKey: IdempotencyKeySchema,
    reasonCode: ProcessReasonCodeSchema,
    /**
     * How long the operator is willing to wait. It bounds the wait, never the
     * process: a timeout leaves the operation observed as timed out and the
     * process exactly as it was, and never escalates to a kill.
     */
    timeoutSeconds: Type.Integer({ minimum: 5, maximum: 900 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/process-control-request.schema.json',
    additionalProperties: false,
  },
);

/**
 * A force kill. It is a different request, not a flag on stop.
 *
 * `acknowledgesDataLoss` has to be stated explicitly, because killing a
 * Minecraft server can lose everything since the last save. A default value
 * would defeat the point, so there is none.
 */
export const ProcessForceKillRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    idempotencyKey: IdempotencyKeySchema,
    reasonCode: ProcessReasonCodeSchema,
    acknowledgesDataLoss: Type.Literal(true),
    /** The graceful stop that was already attempted and did not finish. */
    afterGracefulOperationId: UuidSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/process-force-kill-request.schema.json',
    additionalProperties: false,
  },
);

export const ConsoleStreamSchema = Type.Union([
  Type.Literal('stdout'),
  Type.Literal('stderr'),
]);

/**
 * One console line as the control plane stores it.
 *
 * The text is already redacted when it is written, not when it is read: a
 * secret that reached storage in the clear would survive every later read
 * policy, so redaction happens once, on the way in.
 */
export const ConsoleLineSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    stream: ConsoleStreamSchema,
    text: Type.String({ maxLength: 2_048, pattern: '^[^\\u0000-\\u0008\\u000b-\\u001f]*$' }),
    occurredAt: IsoDateTimeSchema,
    truncated: Type.Boolean(),
    /** True when the stored text had something masked out of it. */
    redacted: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * A page of console output.
 *
 * `nextCursor` is a sequence, not an offset: lines are only ever appended, so
 * a cursor stays valid while retention trims behind it and a reader never
 * silently skips or repeats a line the way offset paging would.
 */
export const ConsolePageSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    lines: Type.Array(ConsoleLineSchema, { maxItems: 500 }),
    nextCursor: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    hasMore: Type.Boolean(),
    /** Lowest sequence still retained, so a caller knows what it missed. */
    oldestRetainedSequence: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    readAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/console-page.schema.json',
    additionalProperties: false,
  },
);

/**
 * The closed catalogue of console commands.
 *
 * A command is a reviewed literal with no arguments. There is no free-text
 * path into the server console anywhere in the control plane.
 */
export const ConsoleCommandSchema = Type.Union([
  Type.Literal('list-players'),
  Type.Literal('save-all'),
]);

export const ConsoleCommandRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    command: ConsoleCommandSchema,
    idempotencyKey: IdempotencyKeySchema,
    reasonCode: ProcessReasonCodeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/console-command-request.schema.json',
    additionalProperties: false,
  },
);

export type ProcessControlAction = Static<typeof ProcessControlActionSchema>;
export type ProcessControlRequestContract = Static<typeof ProcessControlRequestSchema>;
export type ProcessForceKillRequest = Static<typeof ProcessForceKillRequestSchema>;
export type ConsoleStream = Static<typeof ConsoleStreamSchema>;
export type ConsoleLine = Static<typeof ConsoleLineSchema>;
export type ConsolePage = Static<typeof ConsolePageSchema>;
export type ConsoleCommand = Static<typeof ConsoleCommandSchema>;
export type ConsoleCommandRequest = Static<typeof ConsoleCommandRequestSchema>;

/** Job type each action is carried out by. Nothing else may be enqueued. */
const ACTION_JOB_TYPES: Readonly<Record<ProcessControlAction, string>> = Object.freeze({
  start: 'server.start',
  stop: 'server.stop',
  restart: 'server.restart',
});

export function jobTypeForProcessAction(action: ProcessControlAction): string {
  return ACTION_JOB_TYPES[action];
}

export const CONSOLE_COMMANDS: readonly ConsoleCommand[] = Object.freeze([
  'list-players',
  'save-all',
]);

export function isConsoleCommand(value: unknown): value is ConsoleCommand {
  return typeof value === 'string' && (CONSOLE_COMMANDS as readonly string[]).includes(value);
}

/**
 * Masks what must never reach storage or a screen.
 *
 * The guard works on code points and explicit shapes rather than one clever
 * expression, so a pattern that fails to match degrades into leaving text
 * alone rather than silently disabling the whole redactor.
 */
export function redactConsoleText(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;

  // Replace unconditionally and compare, rather than testing first: a global
  // regex advances its own lastIndex on `test`, which makes a test-then-replace
  // pair quietly position-dependent.
  const mask = (pattern: RegExp, replacement: string): void => {
    const masked = text.replace(pattern, replacement);
    if (masked === text) return;
    text = masked;
    redacted = true;
  };

  // An address identifies a player's location, which is personal data.
  mask(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/gu, '[endereço removido]');
  // Anything that announces itself as a secret is masked whatever it holds.
  mask(/\b(?:password|passwd|secret|token|api[_-]?key|rcon)\s*[:=]\s*\S+/giu, '[segredo removido]');
  // A filesystem path leaks host layout.
  mask(/\b[A-Za-z]:\\[^\s"']*/gu, '[caminho removido]');
  mask(/(?:^|\s)\/(?:home|srv|opt|etc|var|root)\/[^\s"']*/gu, ' [caminho removido]');

  // Control characters never reach storage; the contract refuses them anyway.
  let cleaned = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint >= 0x20) cleaned += character;
    else redacted = true;
  }

  return { text: cleaned, redacted };
}

export function validateProcessControlRequest(
  value: unknown,
): ContractValidationResult<ProcessControlRequestContract> {
  return validateContract(ProcessControlRequestSchema, value);
}

export function validateProcessForceKillRequest(
  value: unknown,
): ContractValidationResult<ProcessForceKillRequest> {
  return validateContract(ProcessForceKillRequestSchema, value);
}

export function validateConsoleCommandRequest(
  value: unknown,
): ContractValidationResult<ConsoleCommandRequest> {
  return validateContract(ConsoleCommandRequestSchema, value);
}

export function validateConsolePage(value: unknown): ContractValidationResult<ConsolePage> {
  const result = validateContract(ConsolePageSchema, value);
  if (!result.success) return result;

  const page = result.value;
  const issues: ContractValidationIssue[] = [];

  // Sequences only ever ascend, and a page must be contiguous in that order.
  let previous = 0;
  for (const [index, line] of page.lines.entries()) {
    if (line.sequence <= previous) {
      issues.push(semanticIssue(`/lines/${index}/sequence`, 'console sequences must ascend'));
    }
    previous = line.sequence;
  }

  const last = page.lines.at(-1);
  if (page.hasMore && page.nextCursor === null) {
    issues.push(semanticIssue('/nextCursor', 'a page with more lines must say where to resume'));
  }
  if (last !== undefined && page.nextCursor !== null && page.nextCursor <= last.sequence) {
    issues.push(semanticIssue('/nextCursor', 'the cursor must resume after the last line'));
  }
  if (page.lines.length === 0 && page.hasMore) {
    issues.push(semanticIssue('/hasMore', 'an empty page cannot claim more lines'));
  }
  if (
    page.oldestRetainedSequence !== null &&
    last !== undefined &&
    page.oldestRetainedSequence > last.sequence
  ) {
    issues.push(
      semanticIssue('/oldestRetainedSequence', 'retention cannot start after the page it returned'),
    );
  }

  return appendSemanticIssues(result, issues);
}

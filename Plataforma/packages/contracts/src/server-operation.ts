import { Type, type Static } from '@sinclair/typebox';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  Sha256Schema,
  SlugSchema,
  UuidSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contracts for the Phase 9.1 operational core.
 *
 * Until now an operation lived in the memory of one adapter: its idempotency
 * history, its mutual exclusion and the PID it observed all disappeared with
 * the process. These contracts describe the durable form of the same thing, so
 * a restart of the API or the agent cannot lose a receipt or run an operation
 * twice.
 *
 * Nothing here carries a launch plan, a path, a working directory, a shell
 * fragment or any command text. An operation is named by a reviewed kind and
 * an opaque identifier; a receipt reports what was observed, never how it was
 * produced.
 */

/** Closed set of operations the control plane may record. */
export const ServerOperationKindSchema = Type.Union([
  Type.Literal('server.start'),
  Type.Literal('server.stop'),
  Type.Literal('server.restart'),
  Type.Literal('server.command'),
  Type.Literal('server.force-kill'),
  // Restoring is its own kind. Modelling it as a backup would blur the one
  // distinction that matters: taking a copy is safe, putting one back destroys
  // everything the world became since.
  Type.Literal('backup.restore'),
  Type.Literal('backup.create'),
  Type.Literal('configuration.apply'),
  Type.Literal('configuration.rollback'),
]);

/**
 * `accepted` and `running` are the in-flight states. At most one of them may
 * exist per server at a time, which is what replaces the adapter's in-memory
 * mutual exclusion.
 */
export const ServerOperationStatusSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('rejected'),
]);

/** Closed, publishable failure codes. Nothing internal leaks through. */
export const ServerOperationFailureCodeSchema = Type.Union([
  Type.Literal('precondition-not-met'),
  Type.Literal('lock-unavailable'),
  Type.Literal('lease-expired'),
  Type.Literal('agent-unavailable'),
  Type.Literal('agent-refused'),
  Type.Literal('timed-out'),
  Type.Literal('operation-failed'),
  Type.Literal('reconciled-unknown'),
]);

export const ObservedProcessLifecycleSchema = Type.Union([
  Type.Literal('unknown'),
  Type.Literal('offline'),
  Type.Literal('starting'),
  Type.Literal('online'),
  Type.Literal('stopping'),
  Type.Literal('error'),
]);

/**
 * A process identifier as observed by the agent. It is reported for
 * reconciliation only: nothing in the control plane may signal it, and a PID
 * without the boot it belongs to is meaningless after a restart.
 */
export const ObservedPidSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
  Type.Null(),
]);

export const ReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

/**
 * What an operation produced. A receipt states the outcome and what was
 * observed; it never restates the request, and it carries no path or command.
 */
export const ServerOperationReceiptSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
    failureCode: Type.Union([ServerOperationFailureCodeSchema, Type.Null()]),
    observedLifecycle: ObservedProcessLifecycleSchema,
    observedPid: ObservedPidSchema,
    /** Identifies one run of the process, so a stale PID cannot be reused. */
    bootId: Type.Union([UuidSchema, Type.Null()]),
    completedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export const ServerOperationSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    operationId: UuidSchema,
    serverInstanceId: UuidSchema,
    kind: ServerOperationKindSchema,
    status: ServerOperationStatusSchema,
    /** Public, caller-chosen key. The same key must mean the same request. */
    idempotencyKey: Type.String({ minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]{8,128}$' }),
    /**
     * Digest of the stable request fields. A key replayed with a different
     * fingerprint is a conflict, never a silent second run — which is why the
     * fingerprint must never be computed over anything random.
     */
    requestFingerprint: Sha256Schema,
    correlationId: UuidSchema,
    /** The durable job that carries the work, once one exists. */
    jobId: Type.Union([UuidSchema, Type.Null()]),
    requestedBy: ActorRefSchema,
    reasonCode: ReasonCodeSchema,
    /**
     * The reviewed console command, for a console operation only. It lives on
     * the operation rather than in the job payload so it stays auditable and
     * constrained, and so the queue keeps carrying only an opaque reference.
     */
    consoleCommand: Type.Union([
      Type.Literal('list-players'),
      Type.Literal('save-all'),
      Type.Null(),
    ]),
    /**
     * Which snapshot a backup operation is about. On the operation for the same
     * reason the console command is: an agent that read its target from the job
     * payload would be taking direction from the wire.
     */
    backupId: Type.Union([
      Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
      Type.Null(),
    ]),
    receipt: Type.Union([ServerOperationReceiptSchema, Type.Null()]),
    version: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    acceptedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/server-operation.schema.json',
    additionalProperties: false,
  },
);

/**
 * The last state an agent reported for a server's process.
 *
 * `observedBy` and `bootId` are what make a restart safe: a state observed by
 * an agent session that no longer exists describes a process nobody is
 * watching, so it is reconciled to `unknown` rather than believed.
 */
export const ServerProcessStateSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    lifecycle: ObservedProcessLifecycleSchema,
    observedPid: ObservedPidSchema,
    bootId: Type.Union([UuidSchema, Type.Null()]),
    observedBy: Type.Union([UuidSchema, Type.Null()]),
    observedAt: IsoDateTimeSchema,
    /** True when the control plane could not confirm the observation is current. */
    stale: Type.Boolean(),
    version: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/server-process-state.schema.json',
    additionalProperties: false,
  },
);

/** Closed set of topics an outbox event may carry. */
export const OutboxTopicSchema = Type.Union([
  Type.Literal('operation.accepted'),
  Type.Literal('operation.completed'),
  Type.Literal('process.observed'),
  Type.Literal('artifact.state-changed'),
  Type.Literal('configuration.state-changed'),
]);

/**
 * An event queued for publication.
 *
 * The row is written in the same transaction as the state change it describes,
 * so there is no dual write: an event cannot exist for a state that never
 * committed, and a committed state cannot lose its event. Delivery is marked
 * separately and is therefore at-least-once — a consumer must tolerate a
 * repeat, which is why every event carries a stable `eventId`.
 */
export const OutboxEventSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    eventId: UuidSchema,
    topic: OutboxTopicSchema,
    correlationId: UuidSchema,
    resourceType: SlugSchema,
    resourceId: Type.String({ minLength: 1, maxLength: 128 }),
    occurredAt: IsoDateTimeSchema,
    publishedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    attempts: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    payload: Type.Object(
      {
        status: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
        outcome: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
        failureCode: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/outbox-event.schema.json',
    additionalProperties: false,
  },
);

/** Bounds every administrative listing. A caller cannot ask for more. */
export const MAXIMUM_ADMINISTRATIVE_PAGE = 100;
export const DEFAULT_ADMINISTRATIVE_PAGE = 50;

export const ServerOperationPageSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    operations: Type.Array(ServerOperationSchema, { maxItems: MAXIMUM_ADMINISTRATIVE_PAGE }),
    total: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1, maximum: MAXIMUM_ADMINISTRATIVE_PAGE }),
    offset: Type.Integer({ minimum: 0 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/server-operation-page.schema.json',
    additionalProperties: false,
  },
);

export type ServerOperationKind = Static<typeof ServerOperationKindSchema>;
export type ServerOperationStatus = Static<typeof ServerOperationStatusSchema>;
export type ServerOperationFailureCode = Static<typeof ServerOperationFailureCodeSchema>;
export type ObservedProcessLifecycle = Static<typeof ObservedProcessLifecycleSchema>;
export type ServerOperationReceipt = Static<typeof ServerOperationReceiptSchema>;
export type ServerOperation = Static<typeof ServerOperationSchema>;
export type ServerProcessState = Static<typeof ServerProcessStateSchema>;
export type OutboxTopic = Static<typeof OutboxTopicSchema>;
export type OutboxEvent = Static<typeof OutboxEventSchema>;
export type ServerOperationPage = Static<typeof ServerOperationPageSchema>;

const IN_FLIGHT: ReadonlySet<ServerOperationStatus> = new Set(['accepted', 'running']);
const SETTLED: ReadonlySet<ServerOperationStatus> = new Set(['succeeded', 'failed', 'rejected']);

export function isOperationInFlight(status: ServerOperationStatus): boolean {
  return IN_FLIGHT.has(status);
}

const ALLOWED_OPERATION_TRANSITIONS: Readonly<
  Record<ServerOperationStatus, readonly ServerOperationStatus[]>
> = Object.freeze({
  accepted: ['running', 'succeeded', 'failed', 'rejected'],
  running: ['succeeded', 'failed'],
  // A settled operation is final: a replay returns it, it is never reopened.
  succeeded: [],
  failed: [],
  rejected: [],
});

export function isAllowedOperationTransition(
  from: ServerOperationStatus,
  to: ServerOperationStatus,
): boolean {
  return ALLOWED_OPERATION_TRANSITIONS[from].includes(to);
}

export function validateServerOperation(
  value: unknown,
): ContractValidationResult<ServerOperation> {
  const result = validateContract(ServerOperationSchema, value);
  if (!result.success) return result;

  const operation = result.value;
  const issues: ContractValidationIssue[] = [];

  // A receipt is what "settled" means; it may not exist before, nor be absent
  // after, and it may not disagree with the status it belongs to.
  if (IN_FLIGHT.has(operation.status) && operation.receipt !== null) {
    issues.push(semanticIssue('/receipt', 'an in-flight operation cannot carry a receipt'));
  }
  if (operation.status === 'succeeded' || operation.status === 'failed') {
    if (operation.receipt === null) {
      issues.push(semanticIssue('/receipt', 'a settled operation must carry its receipt'));
    } else if (operation.receipt.outcome !== operation.status) {
      issues.push(semanticIssue('/receipt/outcome', 'the receipt must agree with the status'));
    }
  }
  // `rejected` means the operation never ran, so it produces no receipt.
  if (operation.status === 'rejected' && operation.receipt !== null) {
    issues.push(semanticIssue('/receipt', 'a rejected operation never ran and has no receipt'));
  }
  if (operation.receipt !== null) {
    const { outcome, failureCode } = operation.receipt;
    if (outcome === 'failed' && failureCode === null) {
      issues.push(semanticIssue('/receipt/failureCode', 'a failed receipt must name its failure'));
    }
    if (outcome === 'succeeded' && failureCode !== null) {
      issues.push(semanticIssue('/receipt/failureCode', 'a successful receipt has no failure'));
    }
    // A PID only means something together with the boot it belongs to.
    if (operation.receipt.observedPid !== null && operation.receipt.bootId === null) {
      issues.push(semanticIssue('/receipt/observedPid', 'an observed pid requires its boot id'));
    }
  }
  // A command belongs to a console operation and to nothing else.
  const isBackupKind = operation.kind === 'backup.create' || operation.kind === 'backup.restore';
  if (isBackupKind !== (operation.backupId !== null)) {
    issues.push(semanticIssue('/backupId', 'only a backup operation names a backup'));
  }
  if ((operation.kind === 'server.command') !== (operation.consoleCommand !== null)) {
    issues.push(
      semanticIssue('/consoleCommand', 'only a console operation carries a console command'),
    );
  }
  if (Date.parse(operation.updatedAt) < Date.parse(operation.acceptedAt)) {
    issues.push(semanticIssue('/updatedAt', 'an operation cannot be updated before it was accepted'));
  }
  if (SETTLED.has(operation.status) && operation.receipt !== null) {
    if (Date.parse(operation.receipt.completedAt) < Date.parse(operation.acceptedAt)) {
      issues.push(
        semanticIssue('/receipt/completedAt', 'a receipt cannot precede the operation it closes'),
      );
    }
  }

  return appendSemanticIssues(result, issues);
}

export function validateServerProcessState(
  value: unknown,
): ContractValidationResult<ServerProcessState> {
  const result = validateContract(ServerProcessStateSchema, value);
  if (!result.success) return result;

  const state = result.value;
  const issues: ContractValidationIssue[] = [];

  // A PID is only meaningful for a running process, and only together with
  // the boot that produced it.
  if (state.observedPid !== null && state.bootId === null) {
    issues.push(semanticIssue('/observedPid', 'an observed pid requires its boot id'));
  }
  if (state.observedPid !== null && (state.lifecycle === 'offline' || state.lifecycle === 'unknown')) {
    issues.push(semanticIssue('/observedPid', 'a process that is not running has no pid'));
  }
  // Nothing may claim to be observed while also being unknown.
  if (state.lifecycle === 'unknown' && !state.stale && state.observedBy !== null) {
    issues.push(semanticIssue('/lifecycle', 'an observed state cannot be unknown and current'));
  }
  if (state.observedBy === null && !state.stale) {
    issues.push(semanticIssue('/stale', 'a state nobody is observing is stale by definition'));
  }

  return appendSemanticIssues(result, issues);
}

export function validateOutboxEvent(value: unknown): ContractValidationResult<OutboxEvent> {
  const result = validateContract(OutboxEventSchema, value);
  if (!result.success) return result;

  const event = result.value;
  const issues: ContractValidationIssue[] = [];
  if (event.publishedAt !== null && Date.parse(event.publishedAt) < Date.parse(event.occurredAt)) {
    issues.push(semanticIssue('/publishedAt', 'an event cannot be published before it occurred'));
  }
  if (event.publishedAt === null && event.attempts > 0 && event.topic.length === 0) {
    issues.push(semanticIssue('/topic', 'an attempted event must name its topic'));
  }
  return appendSemanticIssues(result, issues);
}

export function validateServerOperationPage(
  value: unknown,
): ContractValidationResult<ServerOperationPage> {
  const result = validateContract(ServerOperationPageSchema, value);
  if (!result.success) return result;

  const page = result.value;
  const issues: ContractValidationIssue[] = [];
  if (page.operations.length > page.limit) {
    issues.push(semanticIssue('/operations', 'a page cannot exceed its limit'));
  }
  if (page.total < page.operations.length) {
    issues.push(semanticIssue('/total', 'the total cannot be smaller than the page'));
  }
  const identifiers = new Set(page.operations.map((operation) => operation.operationId));
  if (identifiers.size !== page.operations.length) {
    issues.push(semanticIssue('/operations', 'an operation may appear only once in a page'));
  }
  // At most one in-flight operation may exist per server, so a page may not
  // present two of them for the same server either.
  const inFlightServers = new Set<string>();
  for (const [index, operation] of page.operations.entries()) {
    const nested = validateServerOperation(operation);
    if (!nested.success) {
      for (const issue of nested.issues) {
        issues.push(semanticIssue(`/operations/${index}${issue.path}`, issue.message));
      }
    }
    if (!IN_FLIGHT.has(operation.status)) continue;
    if (inFlightServers.has(operation.serverInstanceId)) {
      issues.push(
        semanticIssue(`/operations/${index}/status`, 'a server cannot have two in-flight operations'),
      );
    }
    inFlightServers.add(operation.serverInstanceId);
  }
  return appendSemanticIssues(result, issues);
}

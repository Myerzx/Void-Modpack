import { canonicalJson, sha256Hex } from '@voidfall/authentication';
import {
  isAllowedOperationTransition,
  validateOutboxEvent,
  validateServerOperation,
  validateServerProcessState,
  type ActorRef,
  type ObservedProcessLifecycle,
  type OutboxEvent,
  type OutboxTopic,
  type ServerOperation,
  type ServerOperationFailureCode,
  type ServerOperationKind,
  type ServerOperationPage,
  type ServerOperationStatus,
  type ServerProcessState,
} from '@voidfall/contracts';

import type { Database, SqlClient } from './database.js';

/**
 * Durable storage for the Phase 9.1 operational core.
 *
 * Three properties are the point of this module:
 *
 *  - **Idempotency survives a restart.** A key is unique in the table and is
 *    paired with a fingerprint of the stable request fields, so an honest
 *    replay returns the original operation and a reused key with a different
 *    request is a conflict.
 *  - **Mutual exclusion survives a restart.** A partial unique index allows at
 *    most one in-flight operation per server; the database refuses the second
 *    one rather than an in-memory guard that dies with the process.
 *  - **No dual write.** Every state change writes its outbox event inside the
 *    same transaction, so an event cannot describe a state that never
 *    committed, and a committed state cannot lose its event.
 */

export type OperationalErrorCode =
  | 'operation-not-found'
  | 'idempotency-conflict'
  | 'operation-in-flight'
  | 'invalid-transition'
  | 'stale-operation'
  | 'invalid-record';

export class OperationalPersistenceError extends Error {
  public readonly code: OperationalErrorCode;

  public constructor(code: OperationalErrorCode) {
    super(`operational:${code}`);
    this.name = 'OperationalPersistenceError';
    this.code = code;
  }
}

interface OperationRow {
  readonly operation_id: string;
  readonly server_instance_id: string;
  readonly kind: ServerOperationKind;
  readonly status: ServerOperationStatus;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly correlation_id: string;
  readonly job_id: string | null;
  readonly requested_by: ActorRef;
  readonly reason_code: string;
  readonly console_command: 'list-players' | 'save-all' | null;
  readonly backup_id: string | null;
  readonly receipt_outcome: 'succeeded' | 'failed' | null;
  readonly receipt_failure_code: ServerOperationFailureCode | null;
  readonly receipt_lifecycle: ObservedProcessLifecycle | null;
  readonly receipt_pid: string | number | null;
  readonly receipt_boot_id: string | null;
  readonly completed_at: Date | string | null;
  readonly version: string | number;
  readonly accepted_at: Date | string;
  readonly updated_at: Date | string;
}

const OPERATION_COLUMNS = `operation_id, server_instance_id, kind, status, idempotency_key,
  request_fingerprint, correlation_id, job_id, requested_by, reason_code, console_command, backup_id,
  receipt_outcome, receipt_failure_code, receipt_lifecycle, receipt_pid, receipt_boot_id,
  completed_at, version, accepted_at, updated_at`;

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapOperation(row: OperationRow): ServerOperation {
  const operation: ServerOperation = {
    schemaVersion: 1,
    operationId: row.operation_id,
    serverInstanceId: row.server_instance_id,
    kind: row.kind,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    correlationId: row.correlation_id,
    jobId: row.job_id,
    requestedBy: row.requested_by,
    reasonCode: row.reason_code,
    consoleCommand: row.console_command,
    backupId: row.backup_id,
    receipt:
      row.receipt_outcome === null || row.receipt_lifecycle === null || row.completed_at === null
        ? null
        : {
            outcome: row.receipt_outcome,
            failureCode: row.receipt_failure_code,
            observedLifecycle: row.receipt_lifecycle,
            observedPid: row.receipt_pid === null ? null : Number(row.receipt_pid),
            bootId: row.receipt_boot_id,
            completedAt: isoString(row.completed_at),
          },
    version: Number(row.version),
    acceptedAt: isoString(row.accepted_at),
    updatedAt: isoString(row.updated_at),
  };

  // The storage constraints and the contract state the same invariants; a row
  // that satisfied one but not the other is a defect, not a value to publish.
  const validated = validateServerOperation(operation);
  if (!validated.success) throw new OperationalPersistenceError('invalid-record');
  return validated.value;
}

/**
 * Digest of the stable request fields.
 *
 * Nothing volatile may enter here. A timestamp, a generated identifier or a
 * nonce would make an honest replay look like a different request and turn it
 * into a conflict, which is precisely the failure this fingerprint exists to
 * avoid.
 */
export function operationRequestFingerprint(input: {
  readonly serverInstanceId: string;
  readonly kind: ServerOperationKind;
  readonly requestedBy: ActorRef;
  readonly reasonCode: string;
}): string {
  return sha256Hex(
    canonicalJson({
      serverInstanceId: input.serverInstanceId,
      kind: input.kind,
      requestedBy: input.requestedBy,
      reasonCode: input.reasonCode,
    }),
  );
}

export interface AcceptOperationInput {
  readonly operationId: string;
  readonly serverInstanceId: string;
  readonly kind: ServerOperationKind;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly requestedBy: ActorRef;
  readonly reasonCode: string;
  readonly jobId?: string;
  /** Required for a console operation, refused for every other kind. */
  readonly consoleCommand?: 'list-players' | 'save-all';
  /** Required for a backup operation, refused for every other kind. */
  readonly backupId?: string;
  readonly now: Date;
}

export interface AcceptProcessControlOperationInput extends AcceptOperationInput {
  readonly kind:
    | 'server.start'
    | 'server.stop'
    | 'server.restart'
    | 'server.force-kill';
  /** Distinct outbox identity for invalidating the previous process snapshot. */
  readonly stateInvalidationEventId: string;
}

export interface SettleOperationInput {
  readonly operationId: string;
  /** Identifies the completion event. Supplied so no id is derived by surgery. */
  readonly eventId: string;
  readonly expectedVersion: number;
  readonly outcome: 'succeeded' | 'failed';
  readonly failureCode?: ServerOperationFailureCode;
  readonly observedLifecycle: ObservedProcessLifecycle;
  readonly observedPid?: number;
  readonly bootId?: string;
  readonly now: Date;
}

export interface ObserveProcessInput {
  readonly serverInstanceId: string;
  readonly eventId: string;
  readonly lifecycle: ObservedProcessLifecycle;
  readonly observedBy: string;
  readonly bootId?: string;
  readonly observedPid?: number;
  readonly correlationId: string;
  readonly now: Date;
}

/**
 * Whether a driver error is a unique-constraint violation.
 *
 * PostgreSQL says `23505` and both drivers used here carry it: `pg` puts it
 * on `code`, PGlite on the same field of the error it throws. Matched on the
 * code rather than on a message, because a message is a locale away from
 * changing.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === '23505';
}

export class OperationRepository {
  constructor(private readonly database: Database) {}

  /** Appends an outbox event inside the caller's transaction. Never alone. */
  async #appendEvent(
    client: SqlClient,
    input: {
      readonly eventId: string;
      readonly topic: OutboxTopic;
      readonly correlationId: string;
      readonly resourceType: string;
      readonly resourceId: string;
      readonly occurredAt: Date;
      readonly status?: string;
      readonly outcome?: string;
      readonly failureCode?: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (
         event_id, topic, correlation_id, resource_type, resource_id, occurred_at,
         payload_status, payload_outcome, payload_failure_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.eventId,
        input.topic,
        input.correlationId,
        input.resourceType,
        input.resourceId,
        input.occurredAt,
        input.status ?? null,
        input.outcome ?? null,
        input.failureCode ?? null,
      ],
    );
  }

  /**
   * Accepts an operation, or returns the one an honest replay refers to.
   *
   * The database decides both races: the unique key settles a replay, and the
   * partial unique index settles concurrency, so two callers cannot both put a
   * server into an in-flight operation.
   */
  async accept(input: AcceptOperationInput): Promise<{
    readonly operation: ServerOperation;
    readonly replayed: boolean;
  }> {
    return this.#accept(input);
  }

  /**
   * Accepts a lifecycle-changing operation and invalidates the previous
   * process observation in the same transaction.
   *
   * A restart used to leave the last `online` snapshot current until the
   * agent reported its final receipt. During a real restart that meant the API
   * exposed the PID that had already exited while the replacement JVM was
   * booting. The control plane does not invent `starting` or `stopping` here â€”
   * those remain agent observations â€” but it can prove that the old snapshot
   * stopped being current as soon as the lifecycle operation was accepted.
   */
  async acceptProcessControl(input: AcceptProcessControlOperationInput): Promise<{
    readonly operation: ServerOperation;
    readonly replayed: boolean;
  }> {
    return this.#accept(input, input.stateInvalidationEventId);
  }

  async #accept(
    input: AcceptOperationInput,
    stateInvalidationEventId?: string,
  ): Promise<{
    readonly operation: ServerOperation;
    readonly replayed: boolean;
  }> {
    const fingerprint = operationRequestFingerprint(input);
    return this.database.transaction(async (client) => {
      const existing = await client.query<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} FROM server_operations WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        // A key reused for a different request is a conflict, never a second run.
        if (existingRow.request_fingerprint !== fingerprint) {
          throw new OperationalPersistenceError('idempotency-conflict');
        }
        return { operation: mapOperation(existingRow), replayed: true };
      }

      const inFlight = await client.query<{ readonly operation_id: string }>(
        `SELECT operation_id FROM server_operations
         WHERE server_instance_id = $1 AND status IN ('accepted', 'running')`,
        [input.serverInstanceId],
      );
      if (inFlight.rowCount > 0) throw new OperationalPersistenceError('operation-in-flight');

      let inserted;
      try {
        inserted = await client.query<OperationRow>(
          `INSERT INTO server_operations (
             operation_id, server_instance_id, kind, status, idempotency_key, request_fingerprint,
             correlation_id, job_id, requested_by, reason_code, console_command, backup_id,
             accepted_at, updated_at
           ) VALUES ($1,$2,$3,'accepted',$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$12)
           RETURNING ${OPERATION_COLUMNS}`,
          [
            input.operationId,
            input.serverInstanceId,
            input.kind,
            input.idempotencyKey,
            fingerprint,
            input.correlationId,
            input.jobId ?? null,
            JSON.stringify(input.requestedBy),
            input.reasonCode,
            input.consoleCommand ?? null,
            input.backupId ?? null,
            input.now,
          ],
        );
      } catch (error) {
        // The partial unique index refusing a concurrent second in-flight
        // operation is what this catch is for, and the database is the arbiter
        // rather than the read taken a moment ago.
        //
        // It used to catch everything. A foreign key violation — a job id that
        // does not exist yet — arrived as `operation-in-flight`, which sent
        // whoever read it looking for a concurrent operation that was never
        // there. Only a unique violation is a conflict; anything else keeps
        // its own nature and reaches the error handler as itself.
        if (isUniqueViolation(error)) {
          throw new OperationalPersistenceError('operation-in-flight');
        }
        throw error;
      }
      const row = inserted.rows[0];
      if (row === undefined) throw new OperationalPersistenceError('operation-not-found');

      if (stateInvalidationEventId !== undefined) {
        const invalidated = await client.query(
          `UPDATE server_process_states
           SET lifecycle = 'unknown', observed_pid = NULL, boot_id = NULL,
               observed_by = NULL, observed_at = $2, stale = TRUE,
               version = version + 1
           WHERE server_instance_id = $1`,
          [input.serverInstanceId, input.now],
        );
        if (invalidated.rowCount > 0) {
          await this.#appendEvent(client, {
            eventId: stateInvalidationEventId,
            topic: 'process.invalidated',
            correlationId: input.correlationId,
            resourceType: 'server-instance',
            resourceId: input.serverInstanceId,
            occurredAt: input.now,
            status: 'unknown',
          });
        }
      }

      await this.#appendEvent(client, {
        eventId: input.operationId,
        topic: 'operation.accepted',
        correlationId: input.correlationId,
        resourceType: 'server-instance',
        resourceId: input.serverInstanceId,
        occurredAt: input.now,
        status: 'accepted',
      });

      return { operation: mapOperation(row), replayed: false };
    });
  }

  /** Marks an accepted operation as running, without producing a receipt. */
  async markRunning(input: {
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly jobId?: string;
    readonly now: Date;
  }): Promise<ServerOperation> {
    return this.database.transaction(async (client) => {
      const current = await this.#loadForUpdate(client, input.operationId, input.expectedVersion);
      if (!isAllowedOperationTransition(current.status, 'running')) {
        throw new OperationalPersistenceError('invalid-transition');
      }
      const updated = await client.query<OperationRow>(
        `UPDATE server_operations
         SET status = 'running', job_id = COALESCE($2, job_id), version = version + 1, updated_at = $3
         WHERE operation_id = $1
         RETURNING ${OPERATION_COLUMNS}`,
        [input.operationId, input.jobId ?? null, input.now],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new OperationalPersistenceError('operation-not-found');
      return mapOperation(row);
    });
  }

  async #loadForUpdate(
    client: SqlClient,
    operationId: string,
    expectedVersion: number,
  ): Promise<OperationRow> {
    const current = await client.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM server_operations WHERE operation_id = $1 FOR UPDATE`,
      [operationId],
    );
    const row = current.rows[0];
    if (row === undefined) throw new OperationalPersistenceError('operation-not-found');
    if (Number(row.version) !== expectedVersion) {
      throw new OperationalPersistenceError('stale-operation');
    }
    return row;
  }

  /**
   * Records the receipt that closes an operation and, in the same transaction,
   * the event that announces it. Once settled an operation is final: a replay
   * returns it rather than reopening it.
   */
  async settle(input: SettleOperationInput): Promise<ServerOperation> {
    return this.database.transaction(async (client) => {
      const current = await this.#loadForUpdate(client, input.operationId, input.expectedVersion);
      if (!isAllowedOperationTransition(current.status, input.outcome)) {
        throw new OperationalPersistenceError('invalid-transition');
      }

      const updated = await client.query<OperationRow>(
        `UPDATE server_operations
         SET status = $2, receipt_outcome = $2, receipt_failure_code = $3,
             receipt_lifecycle = $4, receipt_pid = $5, receipt_boot_id = $6,
             completed_at = $7, version = version + 1, updated_at = $7
         WHERE operation_id = $1
         RETURNING ${OPERATION_COLUMNS}`,
        [
          input.operationId,
          input.outcome,
          input.failureCode ?? null,
          input.observedLifecycle,
          input.observedPid ?? null,
          input.bootId ?? null,
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new OperationalPersistenceError('operation-not-found');

      await this.#appendEvent(client, {
        eventId: input.eventId,
        topic: 'operation.completed',
        correlationId: row.correlation_id,
        resourceType: 'server-instance',
        resourceId: row.server_instance_id,
        occurredAt: input.now,
        status: input.outcome,
        outcome: input.outcome,
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      });

      return mapOperation(row);
    });
  }

  async findById(operationId: string): Promise<ServerOperation | undefined> {
    const result = await this.database.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM server_operations WHERE operation_id = $1`,
      [operationId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapOperation(row);
  }

  async findInFlight(serverInstanceId: string): Promise<ServerOperation | undefined> {
    const result = await this.database.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM server_operations
       WHERE server_instance_id = $1 AND status IN ('accepted', 'running')`,
      [serverInstanceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapOperation(row);
  }

  /** Resolves the operation a leased job belongs to. */
  async findByJobId(jobId: string): Promise<ServerOperation | undefined> {
    const result = await this.database.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM server_operations WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapOperation(row);
  }

  /** Follows one correlation id across every operation it produced. */
  async findByCorrelationId(correlationId: string): Promise<readonly ServerOperation[]> {
    const result = await this.database.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM server_operations
       WHERE correlation_id = $1 ORDER BY accepted_at, operation_id`,
      [correlationId],
    );
    return result.rows.map(mapOperation);
  }

  async list(input: {
    readonly serverInstanceId: string;
    readonly statuses?: readonly ServerOperationStatus[];
    readonly kinds?: readonly ServerOperationKind[];
    readonly limit: number;
    readonly offset: number;
  }): Promise<ServerOperationPage> {
    const parameters: unknown[] = [input.serverInstanceId];
    let clause = '';
    if (input.statuses !== undefined && input.statuses.length > 0) {
      parameters.push([...input.statuses]);
      clause += ` AND status = ANY($${parameters.length}::text[])`;
    }
    if (input.kinds !== undefined && input.kinds.length > 0) {
      parameters.push([...input.kinds]);
      clause += ` AND kind = ANY($${parameters.length}::text[])`;
    }

    const total = await this.database.query<{ readonly count: string | number }>(
      `SELECT COUNT(*) AS count FROM server_operations WHERE server_instance_id = $1${clause}`,
      parameters,
    );
    const rows = await this.database.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM server_operations
       WHERE server_instance_id = $1${clause}
       ORDER BY accepted_at DESC, operation_id
       LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, input.limit, input.offset],
    );

    return {
      schemaVersion: 1,
      operations: rows.rows.map(mapOperation),
      total: Number(total.rows[0]?.count ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }
}

interface ProcessStateRow {
  readonly server_instance_id: string;
  readonly lifecycle: ObservedProcessLifecycle;
  readonly observed_pid: string | number | null;
  readonly boot_id: string | null;
  readonly observed_by: string | null;
  readonly observed_at: Date | string;
  readonly stale: boolean;
  readonly version: string | number;
}

function mapProcessState(row: ProcessStateRow): ServerProcessState {
  const state: ServerProcessState = {
    schemaVersion: 1,
    serverInstanceId: row.server_instance_id,
    lifecycle: row.lifecycle,
    observedPid: row.observed_pid === null ? null : Number(row.observed_pid),
    bootId: row.boot_id,
    observedBy: row.observed_by,
    observedAt: isoString(row.observed_at),
    stale: row.stale,
    version: Number(row.version),
  };
  const validated = validateServerProcessState(state);
  if (!validated.success) throw new OperationalPersistenceError('invalid-record');
  return validated.value;
}

export class ProcessStateRepository {
  constructor(private readonly database: Database) {}

  /**
   * Records what an agent observed, and announces it in the same transaction.
   * An observation always replaces the previous one: the agent watching the
   * process is the only authority on its state.
   */
  async observe(input: ObserveProcessInput): Promise<ServerProcessState> {
    return this.database.transaction(async (client) => {
      const updated = await client.query<ProcessStateRow>(
        `INSERT INTO server_process_states (
           server_instance_id, lifecycle, observed_pid, boot_id, observed_by, observed_at,
           stale, version
         ) VALUES ($1,$2,$3,$4,$5,$6,FALSE,1)
         ON CONFLICT (server_instance_id) DO UPDATE
           SET lifecycle = EXCLUDED.lifecycle, observed_pid = EXCLUDED.observed_pid,
               boot_id = EXCLUDED.boot_id, observed_by = EXCLUDED.observed_by,
               observed_at = EXCLUDED.observed_at, stale = FALSE,
               version = server_process_states.version + 1
         RETURNING server_instance_id, lifecycle, observed_pid, boot_id, observed_by,
                   observed_at, stale, version`,
        [
          input.serverInstanceId,
          input.lifecycle,
          input.observedPid ?? null,
          input.bootId ?? null,
          input.observedBy,
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new OperationalPersistenceError('invalid-record');

      await client.query(
        `INSERT INTO outbox_events (
           event_id, topic, correlation_id, resource_type, resource_id, occurred_at, payload_status
         ) VALUES ($1,'process.observed',$2,'server-instance',$3,$4,$5)`,
        [
          input.eventId,
          input.correlationId,
          input.serverInstanceId,
          input.now,
          input.lifecycle,
        ],
      );

      return mapProcessState(row);
    });
  }

  async find(serverInstanceId: string): Promise<ServerProcessState | undefined> {
    const result = await this.database.query<ProcessStateRow>(
      `SELECT server_instance_id, lifecycle, observed_pid, boot_id, observed_by,
              observed_at, stale, version
       FROM server_process_states WHERE server_instance_id = $1`,
      [serverInstanceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapProcessState(row);
  }

  /**
   * Reconciles states nobody is observing any more.
   *
   * After a restart the control plane must not keep believing an old
   * observation. A state whose observation is older than the cutoff becomes
   * `unknown` and loses its PID — the process may well still be running, and
   * saying "unknown" is the only honest answer until an agent looks again.
   */
  async reconcileStale(input: {
    readonly observedBefore: Date;
    readonly now: Date;
  }): Promise<readonly ServerProcessState[]> {
    const result = await this.database.query<ProcessStateRow>(
      `UPDATE server_process_states
       SET lifecycle = 'unknown', observed_pid = NULL, boot_id = NULL,
           observed_by = NULL, stale = TRUE, version = version + 1, observed_at = $2
       WHERE observed_at < $1 AND stale = FALSE
       RETURNING server_instance_id, lifecycle, observed_pid, boot_id, observed_by,
                 observed_at, stale, version`,
      [input.observedBefore, input.now],
    );
    return result.rows.map(mapProcessState);
  }
}

interface OutboxRow {
  readonly event_id: string;
  readonly topic: OutboxTopic;
  readonly correlation_id: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly occurred_at: Date | string;
  readonly published_at: Date | string | null;
  readonly attempts: number;
  readonly payload_status: string | null;
  readonly payload_outcome: string | null;
  readonly payload_failure_code: string | null;
}

function mapOutboxEvent(row: OutboxRow): OutboxEvent {
  const event: OutboxEvent = {
    schemaVersion: 1,
    eventId: row.event_id,
    topic: row.topic,
    correlationId: row.correlation_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    occurredAt: isoString(row.occurred_at),
    publishedAt: row.published_at === null ? null : isoString(row.published_at),
    attempts: Number(row.attempts),
    payload: {
      status: row.payload_status,
      outcome: row.payload_outcome,
      failureCode: row.payload_failure_code,
    },
  };
  const validated = validateOutboxEvent(event);
  if (!validated.success) throw new OperationalPersistenceError('invalid-record');
  return validated.value;
}

const OUTBOX_COLUMNS = `event_id, topic, correlation_id, resource_type, resource_id,
  occurred_at, published_at, attempts, payload_status, payload_outcome, payload_failure_code`;

export class OutboxRepository {
  constructor(private readonly database: Database) {}

  /**
   * Claims a batch of unpublished events under a lease.
   *
   * Delivery is deliberately not part of the claim: an event is marked
   * published only after a dispatcher says it delivered, so the guarantee is
   * at-least-once and a consumer must tolerate a repeat. Marking before
   * delivery would be the one way to lose an event silently.
   */
  async claimPending(input: {
    readonly ownerId: string;
    readonly limit: number;
    readonly leaseExpiresAt: Date;
    readonly now: Date;
  }): Promise<readonly OutboxEvent[]> {
    const result = await this.database.query<OutboxRow>(
      `WITH claimed AS (
         SELECT event_id FROM outbox_events
         WHERE published_at IS NULL
           AND (lease_expires_at IS NULL OR lease_expires_at <= $4)
         ORDER BY occurred_at, event_id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE outbox_events
       SET lease_owner = $1, lease_expires_at = $3, attempts = attempts + 1
       WHERE event_id IN (SELECT event_id FROM claimed)
       RETURNING ${OUTBOX_COLUMNS}`,
      [input.ownerId, input.limit, input.leaseExpiresAt, input.now],
    );
    return result.rows.map(mapOutboxEvent);
  }

  /** Marks delivery, and only after it happened. */
  async markPublished(eventId: string, ownerId: string, now: Date): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE outbox_events SET published_at = $3, lease_owner = NULL, lease_expires_at = NULL
       WHERE event_id = $1 AND lease_owner = $2 AND published_at IS NULL`,
      [eventId, ownerId, now],
    );
    return result.rowCount > 0;
  }

  async countPending(): Promise<number> {
    const result = await this.database.query<{ readonly count: string | number }>(
      'SELECT COUNT(*) AS count FROM outbox_events WHERE published_at IS NULL',
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async findByCorrelationId(correlationId: string): Promise<readonly OutboxEvent[]> {
    const result = await this.database.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox_events
       WHERE correlation_id = $1 ORDER BY occurred_at, event_id`,
      [correlationId],
    );
    return result.rows.map(mapOutboxEvent);
  }
}

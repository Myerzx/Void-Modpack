import { randomUUID } from 'node:crypto';

import {
  validateDatapackLoadOrderObservationCommand,
  validateDatapackLoadOrderObservationResult,
  type AgentWorkLease,
  type AuditEvent,
  type DatapackLoadOrderObservationCommand,
  type DatapackLoadOrderObservationResult,
} from '@voidfall/contracts';
import {
  ConfigurationPersistenceError,
  DatapackLoadOrderPersistenceError,
  type Repositories,
  type StoredDatapackLoadOrderObservation,
} from '@voidfall/database';
import {
  BoundedNbtWorldMetadataDatapackLoadOrderReader,
  DatapackLoadOrderCaptureError,
  GuardedDatapackLoadOrderObserver,
  WorldMetadataNbtReadError,
} from '@voidfall/ecosystem-analysis';
import type { MinecraftProcessAdapter } from '@voidfall/minecraft-process';

import { OfflineGuardError, createOfflineExclusiveDatapackLoadOrderGuard } from './offline-guards.js';
import type { LeaseHandlerResult } from './supervisor.js';
import {
  RegisteredWorldMetadataFileReader,
  RegisteredWorldMetadataReadError,
} from './world-metadata-reader.js';

export const AGENT_DATAPACK_LOAD_ORDER_CAPABILITY = 'datapack-load-order.observe' as const;

const LOCK_NAME = 'minecraft-exclusive';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface TrustedDatapackLoadOrderRuntime {
  readonly workspaceId: string;
  /** Registered host root. The command can never replace or refine it. */
  readonly workspaceRoot: string;
}

export interface DatapackLoadOrderObservationCapabilityOptions {
  readonly repositories: Repositories;
  readonly processAdapter: MinecraftProcessAdapter;
  readonly serverInstanceId: string;
  readonly agentId: string;
  readonly runtime: TrustedDatapackLoadOrderRuntime;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export type DatapackLoadOrderCapabilityErrorCode =
  | 'invalid-options'
  | 'invalid-command'
  | 'server-instance-mismatch'
  | 'workspace-not-authorized'
  | 'idempotency-conflict'
  | 'workspace-unavailable'
  | 'analysis-unavailable'
  | 'inventory-mismatch'
  | 'lease-expired'
  | 'lock-unavailable'
  | 'server-not-offline'
  | 'server-started-during-operation'
  | 'world-metadata-not-found'
  | 'unsafe-filesystem-entry'
  | 'world-metadata-too-large'
  | 'invalid-world-metadata'
  | 'filesystem-read-failed'
  | 'persistence-failed';

export class DatapackLoadOrderCapabilityError extends Error {
  public readonly code: DatapackLoadOrderCapabilityErrorCode;

  public constructor(code: DatapackLoadOrderCapabilityErrorCode) {
    super(`agent-datapack-load-order:${code}`);
    this.name = 'DatapackLoadOrderCapabilityError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function failureCode(error: unknown): DatapackLoadOrderCapabilityErrorCode {
  if (error instanceof DatapackLoadOrderCapabilityError) return error.code;
  if (error instanceof OfflineGuardError) {
    if (error.reason === 'server-not-offline') return 'server-not-offline';
    if (error.reason === 'server-started-during-operation') {
      return 'server-started-during-operation';
    }
    return 'lock-unavailable';
  }
  if (error instanceof RegisteredWorldMetadataReadError) {
    switch (error.code) {
      case 'world-metadata-not-found': return 'world-metadata-not-found';
      case 'unsafe-filesystem-entry': return 'unsafe-filesystem-entry';
      case 'compressed-bytes-limit-exceeded': return 'world-metadata-too-large';
      default: return 'filesystem-read-failed';
    }
  }
  if (error instanceof WorldMetadataNbtReadError || error instanceof DatapackLoadOrderCaptureError) {
    return 'invalid-world-metadata';
  }
  if (error instanceof ConfigurationPersistenceError && error.code === 'lock-unavailable') {
    return 'lock-unavailable';
  }
  if (error instanceof DatapackLoadOrderPersistenceError) {
    if (error.code === 'analysis-not-found') return 'analysis-unavailable';
    if (error.code === 'inventory-mismatch') return 'inventory-mismatch';
  }
  return 'persistence-failed';
}

function handlerFailure(code: DatapackLoadOrderCapabilityErrorCode): LeaseHandlerResult {
  if (
    code === 'invalid-options' || code === 'invalid-command' ||
    code === 'server-instance-mismatch' || code === 'workspace-not-authorized' ||
    code === 'idempotency-conflict'
  ) {
    return { outcome: 'failed', failureCode: 'unsupported-parameters' };
  }
  if (
    code === 'workspace-unavailable' || code === 'analysis-unavailable' ||
    code === 'inventory-mismatch' || code === 'lock-unavailable' ||
    code === 'server-not-offline' || code === 'server-started-during-operation'
  ) {
    return { outcome: 'failed', failureCode: 'precondition-not-met' };
  }
  if (code === 'lease-expired') {
    return { outcome: 'failed', failureCode: 'lease-expired' };
  }
  return { outcome: 'failed', failureCode: 'operation-failed' };
}

/**
 * The typed operational capability. It observes; it never edits a datapack or
 * changes the semantic-editing gate.
 */
export class DatapackLoadOrderObservationCapability {
  readonly #options: DatapackLoadOrderObservationCapabilityOptions;
  readonly #reader: BoundedNbtWorldMetadataDatapackLoadOrderReader;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(options: DatapackLoadOrderObservationCapabilityOptions) {
    if (
      options === null || typeof options !== 'object' ||
      !UUID.test(options.serverInstanceId) || !UUID.test(options.agentId) ||
      options.runtime === null || typeof options.runtime !== 'object' ||
      !UUID.test(options.runtime.workspaceId) ||
      options.repositories === undefined || options.processAdapter === undefined
    ) {
      throw new DatapackLoadOrderCapabilityError('invalid-options');
    }
    let filesystemReader: RegisteredWorldMetadataFileReader;
    try {
      filesystemReader = new RegisteredWorldMetadataFileReader(options.runtime.workspaceRoot);
    } catch {
      throw new DatapackLoadOrderCapabilityError('invalid-options');
    }
    this.#options = options;
    this.#reader = new BoundedNbtWorldMetadataDatapackLoadOrderReader(filesystemReader);
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  public capabilities(): readonly string[] {
    return Object.freeze([AGENT_DATAPACK_LOAD_ORDER_CAPABILITY]);
  }

  public async execute(input: {
    readonly command: unknown;
    readonly jobId: string;
    readonly correlationId: string;
    readonly lockOwnerId: string;
    readonly lockExpiresAt: string;
  }): Promise<DatapackLoadOrderObservationResult> {
    const validation = validateDatapackLoadOrderObservationCommand(input.command);
    if (
      !validation.success || !UUID.test(input.jobId) || !UUID.test(input.correlationId) ||
      !UUID.test(input.lockOwnerId)
    ) {
      throw new DatapackLoadOrderCapabilityError('invalid-command');
    }
    const command = validation.value;
    if (command.serverInstanceId !== this.#options.serverInstanceId) {
      throw new DatapackLoadOrderCapabilityError('server-instance-mismatch');
    }
    if (command.workspaceId !== this.#options.runtime.workspaceId) {
      throw new DatapackLoadOrderCapabilityError('workspace-not-authorized');
    }

    const replay = await this.#options.repositories.datapackLoadOrder.findByJobId(input.jobId);
    if (replay !== undefined) {
      if (
        replay.workspaceId !== command.workspaceId || replay.analysisId !== command.analysisId ||
        replay.inventorySha256 !== command.inventorySha256
      ) {
        throw new DatapackLoadOrderCapabilityError('idempotency-conflict');
      }
      return this.#result(replay, true);
    }

    try {
      return await this.#observe(command, input);
    } catch (error) {
      const code = failureCode(error);
      await this.#auditFailure(command, input.jobId, input.correlationId, code);
      throw new DatapackLoadOrderCapabilityError(code);
    }
  }

  async #observe(
    command: DatapackLoadOrderObservationCommand,
    execution: {
      readonly jobId: string;
      readonly correlationId: string;
      readonly lockOwnerId: string;
      readonly lockExpiresAt: string;
    },
  ): Promise<DatapackLoadOrderObservationResult> {
    const workspace = await this.#options.repositories.workspaces.findById(command.workspaceId);
    if (
      workspace === undefined || workspace.kind !== 'server' ||
      workspace.serverInstanceId !== this.#options.serverInstanceId ||
      workspace.rootPath !== this.#options.runtime.workspaceRoot
    ) {
      throw new DatapackLoadOrderCapabilityError('workspace-unavailable');
    }
    const storedAnalysis = await this.#options.repositories.ecosystemAnalysis.findByAnalysisId({
      workspaceId: command.workspaceId,
      analysisId: command.analysisId,
    });
    if (storedAnalysis === undefined) {
      throw new DatapackLoadOrderCapabilityError('analysis-unavailable');
    }
    if (storedAnalysis.inventorySha256 !== command.inventorySha256) {
      throw new DatapackLoadOrderCapabilityError('inventory-mismatch');
    }

    const acquiredAt = this.#clock();
    const expiresAt = new Date(execution.lockExpiresAt);
    if (
      Number.isNaN(acquiredAt.valueOf()) || Number.isNaN(expiresAt.valueOf()) ||
      expiresAt.getTime() <= acquiredAt.getTime()
    ) {
      throw new DatapackLoadOrderCapabilityError('lease-expired');
    }
    await this.#options.repositories.operationalLocks.acquire({
      serverInstanceId: this.#options.serverInstanceId,
      lockName: LOCK_NAME,
      ownerId: execution.lockOwnerId,
      operation: AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
      acquiredAt: acquiredAt.toISOString(),
      leaseExpiresAt: expiresAt.toISOString(),
    });

    try {
      const guard = createOfflineExclusiveDatapackLoadOrderGuard({
        repositories: this.#options.repositories,
        adapter: this.#options.processAdapter,
        serverInstanceId: this.#options.serverInstanceId,
        ownsLock: (lease) =>
          lease.ownerId === execution.lockOwnerId &&
          lease.operation === AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
        clock: this.#clock,
      });
      const captured = await new GuardedDatapackLoadOrderObserver({
        guard,
        reader: this.#reader,
        clock: this.#clock,
      }).capture(storedAnalysis.document);
      const auditEvent: AuditEvent = {
        schemaVersion: 1,
        id: this.#idGenerator(),
        occurredAt: captured.observation.observedAt,
        correlationId: execution.correlationId,
        actor: { type: 'agent', id: this.#options.agentId },
        source: 'agent',
        action: AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
        resource: { type: 'workspace', id: command.workspaceId },
        outcome: 'succeeded',
        metadata: {
          jobId: execution.jobId,
          analysisId: command.analysisId,
          inventorySha256: command.inventorySha256,
          observationId: captured.observation.observationId,
          evidenceSha256: captured.observation.evidenceSha256,
          datapackCount: captured.observation.datapacks.length,
        },
      };
      const saved = await this.#options.repositories.datapackLoadOrder.saveOperational({
        jobId: execution.jobId,
        workspaceId: command.workspaceId,
        analysisId: command.analysisId,
        observation: captured.observation,
        auditEvent,
      });
      return this.#result(saved.record, saved.replayed);
    } finally {
      await this.#options.repositories.operationalLocks.release({
        serverInstanceId: this.#options.serverInstanceId,
        lockName: LOCK_NAME,
        ownerId: execution.lockOwnerId,
      }).catch(() => undefined);
    }
  }

  #result(
    record: StoredDatapackLoadOrderObservation,
    replayed: boolean,
  ): DatapackLoadOrderObservationResult {
    const result: DatapackLoadOrderObservationResult = {
      schemaVersion: 1,
      workspaceId: record.workspaceId,
      analysisId: record.analysisId,
      inventorySha256: record.inventorySha256,
      observationId: record.observationId,
      evidenceSha256: record.evidenceSha256,
      datapackCount: record.observation.datapacks.length,
      outcome: replayed ? 'replayed' : 'observed',
      completedAt: record.createdAt,
    };
    if (!validateDatapackLoadOrderObservationResult(result).success) {
      throw new DatapackLoadOrderCapabilityError('persistence-failed');
    }
    return Object.freeze(result);
  }

  async #auditFailure(
    command: DatapackLoadOrderObservationCommand,
    jobId: string,
    correlationId: string,
    code: DatapackLoadOrderCapabilityErrorCode,
  ): Promise<void> {
    const occurredAt = this.#clock();
    if (Number.isNaN(occurredAt.valueOf())) return;
    await this.#options.repositories.audit.append({
      schemaVersion: 1,
      id: this.#idGenerator(),
      occurredAt: occurredAt.toISOString(),
      correlationId,
      actor: { type: 'agent', id: this.#options.agentId },
      source: 'agent',
      action: AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
      resource: { type: 'workspace', id: command.workspaceId },
      outcome: 'failed',
      reason: code,
      metadata: {
        jobId,
        analysisId: command.analysisId,
        inventorySha256: command.inventorySha256,
      },
    }, 'datapack-load-order').then(() => undefined, () => undefined);
  }
}

export function createDatapackLoadOrderObservationHandler(options: {
  readonly repositories: Repositories;
  readonly capability: DatapackLoadOrderObservationCapability;
  readonly serverInstanceId: string;
  readonly clock?: () => Date;
}): (lease: AgentWorkLease) => Promise<LeaseHandlerResult> {
  const clock = options.clock ?? (() => new Date());
  const unsupported: LeaseHandlerResult = {
    outcome: 'failed',
    failureCode: 'unsupported-parameters',
  };

  return async (lease: AgentWorkLease): Promise<LeaseHandlerResult> => {
    if (
      lease.capability !== AGENT_DATAPACK_LOAD_ORDER_CAPABILITY ||
      lease.jobType !== AGENT_DATAPACK_LOAD_ORDER_CAPABILITY ||
      lease.parameters.resourceType !== 'server-instance' ||
      lease.parameters.resourceId !== options.serverInstanceId
    ) {
      return unsupported;
    }
    if (Date.parse(lease.expiresAt) <= clock().getTime()) {
      return { outcome: 'failed', failureCode: 'lease-expired' };
    }

    const job = await options.repositories.jobs.findById(lease.jobId);
    if (
      job === undefined || job.type !== AGENT_DATAPACK_LOAD_ORDER_CAPABILITY ||
      job.resource.type !== 'server-instance' || job.resource.id !== options.serverInstanceId ||
      job.correlationId !== lease.correlationId || job.payload.schemaVersion !== 1 ||
      !isRecord(job.payload.parameters) || !hasExactKeys(job.payload.parameters, ['command'])
    ) {
      return unsupported;
    }

    try {
      await options.capability.execute({
        command: job.payload.parameters.command,
        jobId: job.id,
        correlationId: job.correlationId,
        lockOwnerId: lease.leaseId,
        lockExpiresAt: lease.expiresAt,
      });
      return { outcome: 'succeeded' };
    } catch (error) {
      return error instanceof DatapackLoadOrderCapabilityError
        ? handlerFailure(error.code)
        : { outcome: 'failed', failureCode: 'operation-failed' };
    }
  };
}

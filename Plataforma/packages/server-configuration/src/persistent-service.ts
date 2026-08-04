import { randomUUID } from 'node:crypto';

import type { ActorRef } from '@voidfall/contracts';
import {
  ConfigurationPersistenceError,
  type CompletedConfigurationOperation,
  type ConfigurationRepository,
  type OperationalLockRepository,
} from '@voidfall/database';

import {
  ConfigurationOperationError,
  type ApplyConfigurationPlan,
  type ConfigurationMutationReceipt,
  type RollbackConfigurationPlan,
} from './types.js';
import type { FilesystemConfigurationService } from './service.js';
import { validateApplyPlan, validateRollbackPlan } from './validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_LOCK_LEASE_MS = 15 * 60 * 1_000;

export interface PersistedApplyConfigurationPlan extends ApplyConfigurationPlan {
  readonly actor: ActorRef;
  readonly correlationId: string;
  readonly expectedStateVersion: number;
}

export interface PersistedRollbackConfigurationPlan extends RollbackConfigurationPlan {
  readonly actor: ActorRef;
  readonly correlationId: string;
  readonly expectedStateVersion: number;
}

export interface PersistedConfigurationMutationReceipt {
  readonly filesystem: ConfigurationMutationReceipt;
  readonly persistence: CompletedConfigurationOperation;
}

export type PersistentConfigurationServiceErrorCode =
  | 'invalid-options'
  | 'invalid-plan'
  | 'persistence-failed'
  | 'lock-release-failed';

export class PersistentConfigurationServiceError extends Error {
  public readonly code: PersistentConfigurationServiceErrorCode;

  public constructor(code: PersistentConfigurationServiceErrorCode) {
    super(`persistent-configuration:${code}`);
    this.name = 'PersistentConfigurationServiceError';
    this.code = code;
  }
}

export interface PersistentConfigurationServiceOptions {
  readonly serverInstanceId: string;
  readonly filesystem: FilesystemConfigurationService;
  readonly configurationRepository: ConfigurationRepository;
  readonly operationalLocks: OperationalLockRepository;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly lockLeaseMs?: number;
}

function canonicalNow(clock: () => Date): string {
  let now: Date;
  try {
    now = clock();
  } catch {
    throw new PersistentConfigurationServiceError('invalid-plan');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new PersistentConfigurationServiceError('invalid-plan');
  }
  return now.toISOString();
}

function generatedUuid(generator: () => string): string {
  let value: string;
  try {
    value = generator();
  } catch {
    throw new PersistentConfigurationServiceError('persistence-failed');
  }
  if (!UUID.test(value)) throw new PersistentConfigurationServiceError('persistence-failed');
  return value;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export class PersistentConfigurationService {
  readonly #serverInstanceId: string;
  readonly #filesystem: FilesystemConfigurationService;
  readonly #configurationRepository: ConfigurationRepository;
  readonly #operationalLocks: OperationalLockRepository;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #lockLeaseMs: number;

  public constructor(options: PersistentConfigurationServiceOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.serverInstanceId !== 'string' ||
      !UUID.test(options.serverInstanceId) ||
      options.filesystem === undefined ||
      typeof options.filesystem.applyConfiguration !== 'function' ||
      typeof options.filesystem.rollbackConfiguration !== 'function' ||
      options.configurationRepository === undefined ||
      typeof options.configurationRepository.prepare !== 'function' ||
      options.operationalLocks === undefined ||
      typeof options.operationalLocks.acquire !== 'function' ||
      typeof options.operationalLocks.release !== 'function'
    ) {
      throw new PersistentConfigurationServiceError('invalid-options');
    }
    const lockLeaseMs = options.lockLeaseMs ?? 5 * 60 * 1_000;
    if (
      !Number.isSafeInteger(lockLeaseMs) ||
      lockLeaseMs < 1_000 ||
      lockLeaseMs > MAXIMUM_LOCK_LEASE_MS
    ) {
      throw new PersistentConfigurationServiceError('invalid-options');
    }
    this.#serverInstanceId = options.serverInstanceId;
    this.#filesystem = options.filesystem;
    this.#configurationRepository = options.configurationRepository;
    this.#operationalLocks = options.operationalLocks;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#lockLeaseMs = lockLeaseMs;
  }

  public async applyConfiguration(
    input: PersistedApplyConfigurationPlan,
  ): Promise<PersistedConfigurationMutationReceipt> {
    if (
      !exactObject(input, [
        'resourceId',
        'revisionId',
        'expectedCurrentSha256',
        'reasonCode',
        'changes',
        'actor',
        'correlationId',
        'expectedStateVersion',
      ])
    ) {
      throw new PersistentConfigurationServiceError('invalid-plan');
    }
    const plan = validateApplyPlan({
      resourceId: input.resourceId,
      revisionId: input.revisionId,
      expectedCurrentSha256: input.expectedCurrentSha256,
      reasonCode: input.reasonCode,
      changes: input.changes,
    });
    return this.#execute(
      { ...plan, actor: input.actor, correlationId: input.correlationId, expectedStateVersion: input.expectedStateVersion },
      'update',
      null,
      Object.keys(plan.changes).sort(),
      () =>
        this.#filesystem.applyConfiguration({
          resourceId: plan.resourceId,
          revisionId: plan.revisionId,
          expectedCurrentSha256: plan.expectedCurrentSha256,
          reasonCode: plan.reasonCode,
          changes: plan.changes,
        }),
    );
  }

  public async rollbackConfiguration(
    input: PersistedRollbackConfigurationPlan,
  ): Promise<PersistedConfigurationMutationReceipt> {
    if (
      !exactObject(input, [
        'resourceId',
        'revisionId',
        'sourceRevisionId',
        'expectedCurrentSha256',
        'reasonCode',
        'actor',
        'correlationId',
        'expectedStateVersion',
      ])
    ) {
      throw new PersistentConfigurationServiceError('invalid-plan');
    }
    const plan = validateRollbackPlan({
      resourceId: input.resourceId,
      revisionId: input.revisionId,
      sourceRevisionId: input.sourceRevisionId,
      expectedCurrentSha256: input.expectedCurrentSha256,
      reasonCode: input.reasonCode,
    });
    return this.#execute(
      { ...plan, actor: input.actor, correlationId: input.correlationId, expectedStateVersion: input.expectedStateVersion },
      'rollback',
      plan.sourceRevisionId,
      [],
      () =>
      this.#filesystem.rollbackConfiguration({
        resourceId: plan.resourceId,
        revisionId: plan.revisionId,
        sourceRevisionId: plan.sourceRevisionId,
        expectedCurrentSha256: plan.expectedCurrentSha256,
        reasonCode: plan.reasonCode,
      }),
    );
  }

  async #execute(
    input: PersistedApplyConfigurationPlan | PersistedRollbackConfigurationPlan,
    operation: 'update' | 'rollback',
    sourceRevisionId: string | null,
    requestedFields: readonly string[],
    mutate: () => Promise<ConfigurationMutationReceipt>,
  ): Promise<PersistedConfigurationMutationReceipt> {
    if (
      typeof input.correlationId !== 'string' ||
      !UUID.test(input.correlationId) ||
      !Number.isSafeInteger(input.expectedStateVersion) ||
      input.expectedStateVersion < 1
    ) {
      throw new PersistentConfigurationServiceError('invalid-plan');
    }
    const ownerId = generatedUuid(this.#idGenerator);
    const acquiredAt = canonicalNow(this.#clock);
    const leaseExpiresAt = new Date(
      new Date(acquiredAt).getTime() + this.#lockLeaseMs,
    ).toISOString();
    await this.#operationalLocks.acquire({
      serverInstanceId: this.#serverInstanceId,
      lockName: 'minecraft-exclusive',
      ownerId,
      operation: `configuration.${operation}`,
      acquiredAt,
      leaseExpiresAt,
    });
    let primaryError: unknown;
    let result: PersistedConfigurationMutationReceipt | undefined;
    try {
      const prepared = await this.#configurationRepository.prepare({
        revisionId: input.revisionId,
        serverInstanceId: this.#serverInstanceId,
        resourceId: input.resourceId,
        operation,
        sourceRevisionId,
        expectedCurrentSha256: input.expectedCurrentSha256,
        expectedStateVersion: input.expectedStateVersion,
        requestedFields,
        actor: input.actor,
        reasonCode: input.reasonCode,
        correlationId: input.correlationId,
        createdAt: acquiredAt,
      });
      try {
        const filesystem = await mutate();
        const persistence = await this.#configurationRepository.markApplied({
          revisionId: input.revisionId,
          expectedRevisionVersion: prepared.revision.version,
          expectedStateVersion: prepared.state.version,
          previousSha256: filesystem.previousSha256,
          currentSha256: filesystem.currentSha256,
          manifestSha256: filesystem.manifestSha256,
          changedFields: filesystem.changedFields,
          restartRequired: filesystem.restartRequired,
          completedAt: canonicalNow(this.#clock),
          auditEventId: generatedUuid(this.#idGenerator),
        });
        result = Object.freeze({ filesystem, persistence });
      } catch (error) {
        if (error instanceof ConfigurationOperationError) {
          await this.#configurationRepository.markFailed({
            revisionId: input.revisionId,
            expectedRevisionVersion: prepared.revision.version,
            expectedStateVersion: prepared.state.version,
            failureCode: error.code,
            failureStage: error.stage,
            completedAt: canonicalNow(this.#clock),
            auditEventId: generatedUuid(this.#idGenerator),
          });
          primaryError = error;
        } else {
          primaryError = error;
        }
      }
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        const released = await this.#operationalLocks.release({
          serverInstanceId: this.#serverInstanceId,
          lockName: 'minecraft-exclusive',
          ownerId,
        });
        if (!released && primaryError === undefined) {
          primaryError = new PersistentConfigurationServiceError('lock-release-failed');
        }
      } catch {
        if (primaryError === undefined) {
          primaryError = new PersistentConfigurationServiceError('lock-release-failed');
        }
      }
    }
    if (primaryError !== undefined) {
      if (
        primaryError instanceof ConfigurationOperationError ||
        primaryError instanceof ConfigurationPersistenceError ||
        primaryError instanceof PersistentConfigurationServiceError
      ) {
        throw primaryError;
      }
      throw new PersistentConfigurationServiceError('persistence-failed');
    }
    if (result === undefined) {
      throw new PersistentConfigurationServiceError('persistence-failed');
    }
    return result;
  }
}

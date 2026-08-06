import { randomUUID, type KeyLike } from 'node:crypto';

import { computeAgentPayloadHash, createOpaqueToken, signAgentEnvelope } from '@voidfall/authentication';
import {
  validateAgentEnvelope,
  validateConfigurationOperationCommand,
  validateConfigurationOperationResult,
  type AgentEnvelope,
  type AgentWorkLease,
  type ConfigurationOperationCommand,
  type ConfigurationOperationResult,
} from '@voidfall/contracts';
import {
  ConfigurationPersistenceError,
  type ConfigurationRepository,
  type OperationalLockRepository,
  type Repositories,
} from '@voidfall/database';
import {
  ConfigurationOperationError,
  FilesystemConfigurationService,
  PersistentConfigurationService,
  PersistentConfigurationServiceError,
  createReviewedConfigurationResource,
  type ConfigurationValue,
  type OfflineExclusiveConfigurationGuard,
} from '@voidfall/server-configuration';

import type { AgentIdentity } from './agent-client.js';
import type { LeaseHandlerResult } from './supervisor.js';

/**
 * Typed configuration capability for the Server Agent.
 *
 * There is deliberately no generic executor here. The command that crosses the
 * boundary carries identifiers and reviewed scalar values only; the filesystem
 * root, the target path, the schema and the codec are resolved exclusively from
 * this agent's own trusted local configuration. A command can therefore select
 * a reviewed resource, never describe one.
 *
 * In Phase 7.3 the capability runs against an integration directory only. The
 * private Minecraft runtime stays disconnected and no process is started,
 * stopped or restarted; `restartRequired` remains metadata.
 */
export const AGENT_CONFIGURATION_CAPABILITY = 'configuration.apply' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Failure codes the agent is allowed to publish. Anything outside this closed
 * set is reported as `operation-failed` so an unexpected internal error cannot
 * turn into a channel for paths, stages or host details.
 */
const PUBLISHABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'concurrent-modification',
  'content-too-large',
  'invalid-content',
  'invalid-plan',
  'no-change',
  'resource-not-found',
  'revision-conflict',
  'schema-mismatch',
  'unsupported-entry',
  'unsafe-path',
  'verification-failed',
  'replacement-failed',
  'recovery-failed',
  'revision-integrity-mismatch',
  'consistency-unavailable',
  'invalid-transition',
  'lock-unavailable',
]);

const GENERIC_FAILURE_CODE = 'operation-failed';

/**
 * Trusted local configuration of the host. It is constructed by the operator
 * from agent configuration, never received over the wire.
 */
export interface TrustedConfigurationRuntime {
  /** Absolute instance directory that contains the reviewed relative paths. */
  readonly configurationRoot: string;
  /** Absolute directory holding revision storage for this host. */
  readonly revisionRepositoryRoot: string;
  /** Reviewed resource identifiers this host may operate, as an allowlist. */
  readonly authorizedResourceIds: readonly string[];
}

export interface ConfigurationOperationCapabilityOptions {
  readonly serverInstanceId: string;
  readonly runtime: TrustedConfigurationRuntime;
  /**
   * Exclusive offline access proof. It stays an injected trust boundary in this
   * phase: durable reconciliation with start/stop arrives with Phase 9.
   */
  readonly guard: OfflineExclusiveConfigurationGuard;
  readonly configurationRepository: ConfigurationRepository;
  readonly operationalLocks: OperationalLockRepository;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export type ConfigurationCapabilityErrorCode =
  | 'invalid-options'
  | 'invalid-command'
  | 'resource-not-authorized'
  | 'server-instance-mismatch';

/**
 * Raised only when a command must not be executed at all. A rejected command
 * never becomes a persisted revision or an audited operation.
 */
export class ConfigurationCapabilityError extends Error {
  public readonly code: ConfigurationCapabilityErrorCode;

  public constructor(code: ConfigurationCapabilityErrorCode) {
    super(`agent-configuration:${code}`);
    this.name = 'ConfigurationCapabilityError';
    this.code = code;
  }
}

function publishableFailureCode(error: unknown): string {
  const code =
    error instanceof ConfigurationOperationError ||
    error instanceof ConfigurationPersistenceError ||
    error instanceof PersistentConfigurationServiceError
      ? error.code
      : undefined;
  return code !== undefined && PUBLISHABLE_FAILURE_CODES.has(code) ? code : GENERIC_FAILURE_CODE;
}

function changesRecord(
  changes: ConfigurationOperationCommand['changes'],
): Readonly<Record<string, ConfigurationValue>> {
  const record: Record<string, ConfigurationValue> = {};
  for (const change of changes) {
    if (Object.hasOwn(record, change.name)) {
      throw new ConfigurationCapabilityError('invalid-command');
    }
    record[change.name] = change.value;
  }
  return Object.freeze(record);
}

export class ConfigurationOperationCapability {
  readonly #serverInstanceId: string;
  readonly #runtime: TrustedConfigurationRuntime;
  readonly #guard: OfflineExclusiveConfigurationGuard;
  readonly #configurationRepository: ConfigurationRepository;
  readonly #operationalLocks: OperationalLockRepository;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(options: ConfigurationOperationCapabilityOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.serverInstanceId !== 'string' ||
      !UUID.test(options.serverInstanceId) ||
      options.runtime === null ||
      typeof options.runtime !== 'object' ||
      typeof options.runtime.configurationRoot !== 'string' ||
      typeof options.runtime.revisionRepositoryRoot !== 'string' ||
      !Array.isArray(options.runtime.authorizedResourceIds) ||
      options.runtime.authorizedResourceIds.length === 0 ||
      options.runtime.authorizedResourceIds.length > 64 ||
      options.runtime.authorizedResourceIds.some((id) => typeof id !== 'string') ||
      options.guard === undefined ||
      typeof options.guard.runWithExclusiveOfflineAccess !== 'function' ||
      options.configurationRepository === undefined ||
      options.operationalLocks === undefined
    ) {
      throw new ConfigurationCapabilityError('invalid-options');
    }
    this.#serverInstanceId = options.serverInstanceId;
    this.#runtime = Object.freeze({
      configurationRoot: options.runtime.configurationRoot,
      revisionRepositoryRoot: options.runtime.revisionRepositoryRoot,
      authorizedResourceIds: Object.freeze([...options.runtime.authorizedResourceIds]),
    });
    this.#guard = options.guard;
    this.#configurationRepository = options.configurationRepository;
    this.#operationalLocks = options.operationalLocks;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  public capabilities(): readonly string[] {
    return Object.freeze([AGENT_CONFIGURATION_CAPABILITY]);
  }

  /**
   * Executes one typed configuration command. A refused command throws; an
   * accepted command always resolves to a sanitized result, including failure.
   */
  public async execute(input: unknown): Promise<ConfigurationOperationResult> {
    const validation = validateConfigurationOperationCommand(input);
    if (!validation.success) throw new ConfigurationCapabilityError('invalid-command');
    const command = validation.value;

    if (command.serverInstanceId !== this.#serverInstanceId) {
      throw new ConfigurationCapabilityError('server-instance-mismatch');
    }
    if (!this.#runtime.authorizedResourceIds.includes(command.resourceId)) {
      throw new ConfigurationCapabilityError('resource-not-authorized');
    }

    // Root, path, schema and codec come only from trusted local configuration.
    let filesystem: FilesystemConfigurationService;
    try {
      const resource = createReviewedConfigurationResource(
        this.#runtime.configurationRoot,
        command.resourceId,
      );
      filesystem = new FilesystemConfigurationService({
        repositoryRoot: this.#runtime.revisionRepositoryRoot,
        resources: [resource],
        guard: this.#guard,
        clock: this.#clock,
      });
    } catch {
      throw new ConfigurationCapabilityError('resource-not-authorized');
    }

    const persistent = new PersistentConfigurationService({
      serverInstanceId: this.#serverInstanceId,
      filesystem,
      configurationRepository: this.#configurationRepository,
      operationalLocks: this.#operationalLocks,
      clock: this.#clock,
      idGenerator: this.#idGenerator,
    });

    try {
      const receipt =
        command.operation === 'update'
          ? await persistent.applyConfiguration({
              resourceId: command.resourceId,
              revisionId: command.revisionId,
              expectedCurrentSha256: command.expectedCurrentSha256,
              reasonCode: command.reasonCode,
              changes: changesRecord(command.changes),
              actor: command.actor,
              correlationId: command.correlationId,
              expectedStateVersion: command.expectedStateVersion,
            })
          : await persistent.rollbackConfiguration({
              resourceId: command.resourceId,
              revisionId: command.revisionId,
              sourceRevisionId: requireSourceRevision(command),
              expectedCurrentSha256: command.expectedCurrentSha256,
              reasonCode: command.reasonCode,
              actor: command.actor,
              correlationId: command.correlationId,
              expectedStateVersion: command.expectedStateVersion,
            });
      return this.#result({
        command,
        outcome: 'applied',
        previousSha256: receipt.filesystem.previousSha256,
        currentSha256: receipt.filesystem.currentSha256,
        changedFields: [...receipt.filesystem.changedFields],
        restartRequired: receipt.filesystem.restartRequired,
        failureCode: null,
      });
    } catch (error) {
      if (error instanceof ConfigurationCapabilityError) throw error;
      return this.#result({
        command,
        outcome: 'failed',
        previousSha256: null,
        currentSha256: null,
        changedFields: [],
        restartRequired: false,
        failureCode: publishableFailureCode(error),
      });
    }
  }

  #result(input: {
    readonly command: ConfigurationOperationCommand;
    readonly outcome: 'applied' | 'failed';
    readonly previousSha256: string | null;
    readonly currentSha256: string | null;
    readonly changedFields: readonly string[];
    readonly restartRequired: boolean;
    readonly failureCode: string | null;
  }): ConfigurationOperationResult {
    const result: ConfigurationOperationResult = {
      schemaVersion: 1,
      revisionId: input.command.revisionId,
      resourceId: input.command.resourceId,
      operation: input.command.operation,
      outcome: input.outcome,
      previousSha256: input.previousSha256,
      currentSha256: input.currentSha256,
      changedFields: [...input.changedFields],
      restartRequired: input.restartRequired,
      failureCode: input.failureCode,
      completedAt: this.#clock().toISOString(),
    };
    const validation = validateConfigurationOperationResult(result);
    if (!validation.success) {
      throw new ConfigurationCapabilityError('invalid-command');
    }
    return Object.freeze(result);
  }
}

function requireSourceRevision(command: ConfigurationOperationCommand): string {
  if (command.sourceRevisionId === null) {
    throw new ConfigurationCapabilityError('invalid-command');
  }
  return command.sourceRevisionId;
}

/**
 * The job types `configuration.apply` serves, and the command operation each
 * one must carry.
 *
 * Pairing them is the point. A lease that named `configuration.rollback` while
 * the stored command said `update` would be a job whose type no longer
 * describes what it does, and the agent refuses it rather than picking one of
 * the two to believe.
 */
const CONFIGURATION_JOB_OPERATIONS: Readonly<
  Record<string, ConfigurationOperationCommand['operation']>
> = Object.freeze({
  'configuration.apply': 'update',
  'configuration.rollback': 'rollback',
});

/**
 * Configuration failures that mean the request itself cannot be applied.
 *
 * Nothing was touched and nothing will be: the content is wrong, the schema
 * does not match, the resource is not there. Retrying the identical request
 * produces the identical answer, so it is reported as unsupported rather than
 * as something that failed on the way.
 */
const UNSUPPORTED_FAILURE_CODES: ReadonlySet<string> = new Set([
  'content-too-large',
  'invalid-content',
  'invalid-plan',
  'resource-not-found',
  'schema-mismatch',
  'unsafe-path',
  'unsupported-entry',
]);

/**
 * Failures that mean the world moved under the request.
 *
 * Somebody else edited the resource, the exclusive lock is held, the revision
 * the caller expected is no longer current. The same request may well succeed
 * later, which is exactly what separates it from a failure while applying — an
 * operator reading a receipt needs to know whether to retry or to investigate.
 */
const PRECONDITION_FAILURE_CODES: ReadonlySet<string> = new Set([
  'concurrent-modification',
  'consistency-unavailable',
  'invalid-transition',
  'lock-unavailable',
  'no-change',
  'revision-conflict',
]);

function leaseFailureCode(
  failureCode: string | null,
): NonNullable<LeaseHandlerResult['failureCode']> {
  if (failureCode === null) return 'operation-failed';
  if (UNSUPPORTED_FAILURE_CODES.has(failureCode)) return 'unsupported-parameters';
  if (PRECONDITION_FAILURE_CODES.has(failureCode)) return 'precondition-not-met';
  // Everything else — a replacement that could not be verified, a recovery that
  // did not complete, a revision whose stored bytes no longer match their hash
  // — is a failure during the attempt, not a refusal before it.
  return 'operation-failed';
}

export interface ConfigurationLeaseHandlerOptions {
  readonly repositories: Repositories;
  readonly capability: ConfigurationOperationCapability;
  /** The server this agent is responsible for; a lease for another is refused. */
  readonly serverInstanceId: string;
}

/**
 * Adapts the typed capability to the work loop.
 *
 * The capability is a class that speaks commands; the supervisor speaks leases.
 * Without an adapter `configuration.apply` was the one capability the runtime
 * announced and never registered — the agent would have claimed a configuration
 * job and then refused it as unsupported, which is precisely the outcome
 * readiness exists to prevent.
 *
 * The command is read from the durable job, never from the lease, exactly as
 * the console capability reads its reviewed literal. A lease names a job and a
 * server; the reviewed values were written when an authorized operator's request
 * was accepted, and that stored record is what gets applied. Nothing arriving in
 * the claim response can select a file, a root or a value.
 */
export function createConfigurationApplyHandler(
  options: ConfigurationLeaseHandlerOptions,
): (lease: AgentWorkLease) => Promise<LeaseHandlerResult> {
  const unsupported: LeaseHandlerResult = {
    outcome: 'failed',
    failureCode: 'unsupported-parameters',
  };

  return async (lease: AgentWorkLease): Promise<LeaseHandlerResult> => {
    const expectedOperation = CONFIGURATION_JOB_OPERATIONS[lease.jobType];
    if (expectedOperation === undefined) return unsupported;
    if (
      lease.parameters.resourceType !== 'server-instance' ||
      lease.parameters.resourceId !== options.serverInstanceId
    ) {
      return unsupported;
    }

    const job = await options.repositories.jobs.findById(lease.jobId);
    // The job's own type and resource are re-checked against the lease. They are
    // written by the control plane at different moments, and applying a command
    // whose job disagrees with the lease that delivered it would mean trusting
    // whichever of the two happened to be read second.
    if (
      job === undefined ||
      job.type !== lease.jobType ||
      job.resource.type !== 'server-instance' ||
      job.resource.id !== options.serverInstanceId
    ) {
      return unsupported;
    }

    const validation = validateConfigurationOperationCommand(
      (job.payload.parameters as { readonly command?: unknown }).command,
    );
    if (!validation.success || validation.value.operation !== expectedOperation) {
      return unsupported;
    }

    try {
      const result = await options.capability.execute(validation.value);
      return result.outcome === 'applied'
        ? { outcome: 'succeeded' }
        : { outcome: 'failed', failureCode: leaseFailureCode(result.failureCode) };
    } catch (error) {
      // A refused command never became a revision or an audited operation, so
      // it is reported as one the agent may not serve rather than as work that
      // was attempted and broke.
      if (error instanceof ConfigurationCapabilityError) return unsupported;
      return { outcome: 'failed', failureCode: 'operation-failed' };
    }
  };
}

/**
 * Builds the outbound-only signed envelope that reports a completed typed
 * operation. The agent always initiates the connection; the control plane never
 * dials in, and the payload carries no value, path or host detail.
 */
export function createConfigurationResultEnvelope(
  identity: AgentIdentity,
  input: {
    readonly result: ConfigurationOperationResult;
    readonly correlationId: string;
    readonly observedAt: Date;
    readonly lifetimeMs?: number;
  },
): AgentEnvelope {
  if (!validateConfigurationOperationResult(input.result).success) {
    throw new ConfigurationCapabilityError('invalid-command');
  }
  const payload: AgentEnvelope['payload'] = {
    schemaVersion: 1,
    data: { ...input.result, changedFields: [...input.result.changedFields] },
  };
  const unsigned: Omit<AgentEnvelope, 'signature'> = {
    schemaVersion: 1,
    messageId: randomUUID(),
    correlationId: input.correlationId,
    agentId: identity.agentId,
    serverInstanceId: identity.serverInstanceId,
    kind: 'job.event',
    issuedAt: input.observedAt.toISOString(),
    expiresAt: new Date(input.observedAt.getTime() + (input.lifetimeMs ?? 60_000)).toISOString(),
    nonce: createOpaqueToken(),
    payloadHash: computeAgentPayloadHash({ payload }),
    payload,
  };
  const envelope = signAgentEnvelope(unsigned, identity.privateKey as KeyLike, identity.keyId);
  if (!validateAgentEnvelope(envelope).success) {
    throw new ConfigurationCapabilityError('invalid-command');
  }
  return envelope;
}

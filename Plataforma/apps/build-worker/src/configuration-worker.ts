import {
  validateConfigurationOperationCommand,
  type ConfigurationOperationCommand,
  type ConfigurationOperationResult,
} from '@voidfall/contracts';
import { createRepositories, type Database } from '@voidfall/database';

const CONFIGURATION_LEASE_MS = 5 * 60_000;

/**
 * Durable runner for typed configuration jobs.
 *
 * It reuses the existing SKIP LOCKED queue and the Phase 7.2 state machine:
 * the job payload carries the typed command only, and the executor — the
 * Server Agent capability — owns the revision, lock and audit transitions
 * through PersistentConfigurationService. Nothing is written twice, and this
 * runner never resolves a root, path, schema or codec itself.
 */
export interface ConfigurationOperationExecutor {
  execute(command: ConfigurationOperationCommand): Promise<ConfigurationOperationResult>;
}

export type ConfigurationWorkerResult =
  | { readonly processed: false }
  | {
      readonly processed: true;
      readonly jobId: string;
      readonly outcome: 'applied' | 'failed';
      readonly revisionId: string;
    };

/**
 * Extracts the typed command from a job payload. The payload must contain
 * exactly one `command` parameter that satisfies the public contract; anything
 * else is refused without being executed.
 */
function exactCommand(payload: unknown): ConfigurationOperationCommand | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const document = payload as Record<string, unknown>;
  if (document['schemaVersion'] !== 1) return undefined;
  const parameters = document['parameters'];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return undefined;
  }
  const record = parameters as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return undefined;
  const validation = validateConfigurationOperationCommand(record['command']);
  return validation.success ? validation.value : undefined;
}

function matchesJobType(
  type: string,
  command: ConfigurationOperationCommand,
): boolean {
  return (
    (type === 'configuration.apply' && command.operation === 'update') ||
    (type === 'configuration.rollback' && command.operation === 'rollback')
  );
}

/**
 * Leases at most one configuration job and dispatches it to the typed executor.
 * The job result mirrors the sanitized agent receipt: hashes, changed field
 * names and a failure code, never a configuration value or a path.
 */
export async function runConfigurationWorkerOnce(input: {
  readonly database: Database;
  readonly workerId: string;
  readonly executor: ConfigurationOperationExecutor;
  readonly now?: Date;
}): Promise<ConfigurationWorkerResult> {
  const repositories = createRepositories(input.database);
  const now = input.now ?? new Date();
  const job = await repositories.jobs.lease({
    workerId: input.workerId,
    acceptedTypes: ['configuration.apply', 'configuration.rollback'],
    now,
    leaseMs: CONFIGURATION_LEASE_MS,
  });
  if (job === undefined) return { processed: false };

  const fail = async (code: string, revisionId: string): Promise<ConfigurationWorkerResult> => {
    await repositories.jobs.appendEvent({
      jobId: job.id,
      stage: 'configuration-failed',
      level: 'error',
      message: 'The typed configuration operation did not complete.',
      occurredAt: now,
      metadata: { code, revisionId },
    });
    const failed = await repositories.jobs.fail(
      job.id,
      input.workerId,
      { code, message: 'The typed configuration operation failed.', retryable: false },
      now,
    );
    if (!failed) {
      throw new Error('The configuration job lease was lost before failure was recorded.');
    }
    return { processed: true, jobId: job.id, outcome: 'failed', revisionId };
  };

  const command = exactCommand(job.payload);
  if (command === undefined) return fail('CONFIGURATION_PAYLOAD_INVALID', 'unknown');
  if (!matchesJobType(job.type, command)) {
    return fail('CONFIGURATION_OPERATION_MISMATCH', command.revisionId);
  }

  await repositories.jobs.appendEvent({
    jobId: job.id,
    stage: 'configuration-dispatch',
    level: 'info',
    message: 'The typed configuration command was accepted by the agent capability.',
    occurredAt: now,
    metadata: {
      resourceId: command.resourceId,
      revisionId: command.revisionId,
      operation: command.operation,
      requestedFields: [...command.changes].map((change) => change.name).sort(),
    },
  });

  let result: ConfigurationOperationResult;
  try {
    result = await input.executor.execute(command);
  } catch {
    // A refused command never reached the state machine, so nothing persisted.
    return fail('CONFIGURATION_COMMAND_REFUSED', command.revisionId);
  }

  if (result.outcome === 'failed') {
    return fail(
      `CONFIGURATION_${result.failureCode === null ? 'OPERATION_FAILED' : result.failureCode.toUpperCase().replaceAll('-', '_')}`,
      result.revisionId,
    );
  }

  await repositories.jobs.appendEvent({
    jobId: job.id,
    stage: 'configuration-applied',
    level: 'info',
    message: 'The typed configuration operation was applied and recorded.',
    occurredAt: now,
    metadata: {
      revisionId: result.revisionId,
      currentSha256: result.currentSha256,
      changedFields: [...result.changedFields],
      restartRequired: result.restartRequired,
    },
  });
  const completed = await repositories.jobs.complete(
    job.id,
    input.workerId,
    {
      revisionId: result.revisionId,
      resourceId: result.resourceId,
      operation: result.operation,
      outcome: result.outcome,
      previousSha256: result.previousSha256,
      currentSha256: result.currentSha256,
      changedFields: [...result.changedFields],
      restartRequired: result.restartRequired,
    },
    now,
  );
  if (!completed) throw new Error('The configuration job lease was lost before completion.');
  return { processed: true, jobId: job.id, outcome: 'applied', revisionId: result.revisionId };
}

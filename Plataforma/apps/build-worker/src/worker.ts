import { createRepositories, type Database } from '@voidfall/database';

const NOOP_LEASE_MS = 30_000;
const MODPACK_BUILD_LEASE_MS = 5 * 60_000;

export type NoopWorkerResult =
  | { readonly processed: false }
  | { readonly processed: true; readonly jobId: string };

export interface IsolatedBuildExecutionResult {
  readonly version: string;
  readonly buildId: string;
  readonly manifestSha256: string;
  readonly files: number;
  readonly bytes: number;
  readonly stableEligible: boolean;
}

export interface IsolatedBuildExecutor {
  execute(planId: string): Promise<IsolatedBuildExecutionResult>;
}

export type ModpackBuildWorkerResult =
  | { readonly processed: false }
  | { readonly processed: true; readonly jobId: string; readonly outcome: 'candidate' | 'failed' };

function exactBuildPlanId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const document = payload as Record<string, unknown>;
  if (document['schemaVersion'] !== 1) return undefined;
  const parameters = document['parameters'];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined;
  const record = parameters as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return undefined;
  const planId = record['planId'];
  return typeof planId === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(planId) && planId.length <= 96
    ? planId
    : undefined;
}

function validExecutionResult(value: unknown): value is IsolatedBuildExecutionResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<IsolatedBuildExecutionResult>;
  return (
    typeof result.version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(result.version) &&
    typeof result.buildId === 'string' &&
    /^build-[0-9]{8}-[0-9]{6}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/u.test(result.buildId) &&
    typeof result.manifestSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(result.manifestSha256) &&
    Number.isSafeInteger(result.files) &&
    (result.files ?? 0) > 0 &&
    Number.isSafeInteger(result.bytes) &&
    (result.bytes ?? 0) > 0 &&
    typeof result.stableEligible === 'boolean'
  );
}

/**
 * Leases one modpack.build job whose payload contains only an opaque planId.
 * Filesystem roots, catalog data, release keys and implementations remain in the injected executor.
 */
export async function runModpackBuildWorkerOnce(input: {
  readonly database: Database;
  readonly workerId: string;
  readonly executor: IsolatedBuildExecutor;
  readonly now?: Date;
}): Promise<ModpackBuildWorkerResult> {
  const repositories = createRepositories(input.database);
  const now = input.now ?? new Date();
  const job = await repositories.jobs.lease({
    workerId: input.workerId,
    acceptedTypes: ['modpack.build'],
    now,
    leaseMs: MODPACK_BUILD_LEASE_MS,
  });
  if (job === undefined) return { processed: false };

  const fail = async (code: string): Promise<ModpackBuildWorkerResult> => {
    await repositories.jobs.appendEvent({
      jobId: job.id,
      stage: 'build-failed',
      level: 'error',
      message: 'The isolated modpack build could not produce a candidate.',
      occurredAt: now,
      metadata: { code },
    });
    const failed = await repositories.jobs.fail(
      job.id,
      input.workerId,
      { code, message: 'The isolated modpack build failed.', retryable: false },
      now,
    );
    if (!failed) throw new Error('The modpack build job lease was lost before failure was recorded.');
    return { processed: true, jobId: job.id, outcome: 'failed' };
  };

  const planId = exactBuildPlanId(job.payload);
  if (planId === undefined) return fail('BUILD_PAYLOAD_INVALID');
  await repositories.jobs.appendEvent({
    jobId: job.id,
    stage: 'isolated-build',
    level: 'info',
    message: 'The isolated modpack build executor accepted a trusted plan reference.',
    occurredAt: now,
    metadata: { planId },
  });

  let result: unknown;
  try {
    result = await input.executor.execute(planId);
  } catch {
    return fail('BUILD_EXECUTION_FAILED');
  }
  if (!validExecutionResult(result)) return fail('BUILD_RESULT_INVALID');

  await repositories.jobs.appendEvent({
    jobId: job.id,
    stage: 'candidate-created',
    level: 'info',
    message: 'The isolated modpack build produced an immutable candidate.',
    occurredAt: now,
    metadata: {
      version: result.version,
      buildId: result.buildId,
      manifestSha256: result.manifestSha256,
      stableEligible: result.stableEligible,
    },
  });
  const completed = await repositories.jobs.complete(
    job.id,
    input.workerId,
    {
      version: result.version,
      buildId: result.buildId,
      manifestSha256: result.manifestSha256,
      files: result.files,
      bytes: result.bytes,
      stableEligible: result.stableEligible,
    },
    now,
  );
  if (!completed) throw new Error('The modpack build job lease was lost before completion.');
  return { processed: true, jobId: job.id, outcome: 'candidate' };
}

/**
 * Leases and completes at most one harmless system.noop job.
 * Phase 2 intentionally has no process, shell, filesystem or Minecraft control path.
 */
export async function runNoopWorkerOnce(input: {
  readonly database: Database;
  readonly workerId: string;
  readonly now?: Date;
}): Promise<NoopWorkerResult> {
  const repositories = createRepositories(input.database);
  const now = input.now ?? new Date();
  const job = await repositories.jobs.lease({
    workerId: input.workerId,
    acceptedTypes: ['system.noop'],
    now,
    leaseMs: NOOP_LEASE_MS,
  });
  if (job === undefined) return { processed: false };

  await repositories.jobs.appendEvent({
    jobId: job.id,
    stage: 'noop-execution',
    level: 'info',
    message: 'Harmless Phase 2 no-op job accepted.',
    occurredAt: now,
    metadata: { workerId: input.workerId },
  });
  const completed = await repositories.jobs.complete(
    job.id,
    input.workerId,
    { ok: true, operation: 'noop' },
    now,
  );
  if (!completed) throw new Error('The no-op job lease was lost before completion.');
  await repositories.jobs.appendEvent({
    jobId: job.id,
    stage: 'completed',
    level: 'info',
    message: 'Harmless Phase 2 no-op job completed.',
    occurredAt: now,
  });
  return { processed: true, jobId: job.id };
}

export async function runNoopWorker(input: {
  readonly database: Database;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
}): Promise<void> {
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  while (!input.signal.aborted) {
    const result = await runNoopWorkerOnce(input);
    if (!result.processed) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            clearTimeout(timeout);
            reject(input.signal.reason ?? new Error('Worker stopped.'));
          };
          const timeout = setTimeout(() => {
            input.signal.removeEventListener('abort', onAbort);
            resolve();
          }, pollIntervalMs);
          input.signal.addEventListener('abort', onAbort, { once: true });
        });
      } catch {
        if (!input.signal.aborted) throw new Error('Worker polling was interrupted unexpectedly.');
      }
    }
  }
}

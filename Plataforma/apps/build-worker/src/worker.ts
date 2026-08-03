import { createRepositories, type Database } from '@voidfall/database';

const NOOP_LEASE_MS = 30_000;

export type NoopWorkerResult =
  | { readonly processed: false }
  | { readonly processed: true; readonly jobId: string };

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

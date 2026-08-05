import { Type, type Static } from '@sinclair/typebox';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  JsonObjectSchema,
  ResourceRefSchema,
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

export const JobSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    id: UuidSchema,
    type: Type.Union([
      Type.Literal('modpack.build'),
      Type.Literal('backup.create'),
      Type.Literal('backup.restore'),
      Type.Literal('server.start'),
      Type.Literal('server.stop'),
      Type.Literal('server.restart'),
      Type.Literal('server.force-kill'),
      Type.Literal('configuration.apply'),
      Type.Literal('configuration.rollback'),
      Type.Literal('artifact.inspect'),
      Type.Literal('artifact.analyze'),
      Type.Literal('system.noop'),
    ]),
    resource: ResourceRefSchema,
    status: Type.Union([
      Type.Literal('requested'),
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('succeeded'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('review-required'),
    ]),
    stage: SlugSchema,
    priority: Type.Integer({ minimum: 0, maximum: 100 }),
    payload: Type.Object(
      {
        schemaVersion: Type.Integer({ minimum: 1, maximum: 65_535 }),
        parameters: JsonObjectSchema,
      },
      { additionalProperties: false },
    ),
    idempotencyKey: Type.String({
      minLength: 16,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._:-]+$',
    }),
    requestedBy: ActorRefSchema,
    correlationId: UuidSchema,
    availableAt: IsoDateTimeSchema,
    lease: Type.Optional(
      Type.Object(
        {
          ownerId: UuidSchema,
          acquiredAt: IsoDateTimeSchema,
          expiresAt: IsoDateTimeSchema,
        },
        { additionalProperties: false },
      ),
    ),
    attempt: Type.Integer({ minimum: 0, maximum: 1_000 }),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 1_000 }),
    cancelRequestedAt: Type.Optional(IsoDateTimeSchema),
    startedAt: Type.Optional(IsoDateTimeSchema),
    finishedAt: Type.Optional(IsoDateTimeSchema),
    result: Type.Optional(JsonObjectSchema),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 2, maxLength: 96, pattern: '^[A-Z0-9_]+$' }),
          message: Type.String({ minLength: 1, maxLength: 512 }),
          retryable: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/job.schema.json',
    additionalProperties: false,
  },
);

export type Job = Static<typeof JobSchema>;

export function validateJob(value: unknown): ContractValidationResult<Job> {
  const result = validateContract(JobSchema, value);

  if (!result.success) {
    return result;
  }

  const issues: ContractValidationIssue[] = [];
  const job = result.value;

  if (job.attempt > job.maxAttempts) {
    issues.push(semanticIssue('/attempt', 'attempt cannot exceed maxAttempts'));
  }

  if (job.status === 'running' && job.lease === undefined) {
    issues.push(semanticIssue('/lease', 'a running job requires an active lease'));
  }

  if (job.lease !== undefined && Date.parse(job.lease.expiresAt) <= Date.parse(job.lease.acquiredAt)) {
    issues.push(semanticIssue('/lease/expiresAt', 'lease expiry must be after acquisition'));
  }

  if (
    job.startedAt !== undefined &&
    job.finishedAt !== undefined &&
    Date.parse(job.finishedAt) < Date.parse(job.startedAt)
  ) {
    issues.push(semanticIssue('/finishedAt', 'finishedAt cannot precede startedAt'));
  }

  return appendSemanticIssues(result, issues);
}

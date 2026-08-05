import { Type, type Static } from '@sinclair/typebox';
import { ContractSchemaVersion, IsoDateTimeSchema, UuidSchema } from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contracts for the Phase 10.5 schedules.
 *
 * A schedule is a **typed plan**, never a script. Its steps come from a closed
 * catalogue with declared parameters, so a schedule cannot become a way to run
 * arbitrary work on a timer — which is precisely what a scheduler tends to
 * become when it accepts a command string.
 *
 * The timezone is explicit and mandatory. "Restart at 04:00" means nothing
 * without one: a server whose operators are in São Paulo and whose host runs in
 * UTC would restart during peak hours, and the bug would only show up twice a
 * year when a DST transition moved it again.
 */

export const ScheduleStepKindSchema = Type.Union([
  /** Tell players what is about to happen, at a stated lead time. */
  Type.Literal('warn-players'),
  Type.Literal('backup'),
  /** Refuse to proceed unless the world is in a state worth acting on. */
  Type.Literal('maintenance-check'),
  Type.Literal('restart'),
]);

export const ScheduleStepSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('warn-players'),
      /** How long before the disruptive step this warning goes out. */
      leadSeconds: Type.Integer({ minimum: 10, maximum: 3_600 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('backup'),
      scope: Type.Union([
        Type.Literal('world'),
        Type.Literal('configurations'),
        Type.Literal('complete'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('maintenance-check'),
      /** Skip the whole run when more than this many players are online. */
      maximumPlayersOnline: Type.Integer({ minimum: 0, maximum: 1_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('restart'),
      timeoutSeconds: Type.Integer({ minimum: 5, maximum: 900 }),
    },
    { additionalProperties: false },
  ),
]);

/**
 * When a schedule fires.
 *
 * Daily at a stated local time, or on stated weekdays. Deliberately not cron:
 * a cron expression is a small language, and the shapes it can express beyond
 * these are ones nobody reviewing a maintenance window wants to have to parse.
 */
export const ScheduleTriggerSchema = Type.Object(
  {
    /** IANA zone. Mandatory: a local time without one is not a time. */
    timezone: Type.String({ minLength: 3, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_+\\-]*(?:/[A-Za-z0-9_+\\-]+)*$' }),
    hour: Type.Integer({ minimum: 0, maximum: 23 }),
    minute: Type.Integer({ minimum: 0, maximum: 59 }),
    /** 0 is Sunday. Empty means every day. */
    weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
      maxItems: 7,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const ServerScheduleSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    scheduleId: UuidSchema,
    serverInstanceId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$' }),
    enabled: Type.Boolean(),
    trigger: ScheduleTriggerSchema,
    steps: Type.Array(ScheduleStepSchema, { minItems: 1, maxItems: 8 }),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
    /** When it is next expected to fire, computed and stored. */
    nextRunAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    lastRunAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/server-schedule.schema.json',
    additionalProperties: false,
  },
);

export const ScheduleRunStatusSchema = Type.Union([
  Type.Literal('claimed'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  /** The maintenance check said now was not the time. Not a failure. */
  Type.Literal('skipped'),
]);

export const ScheduleRunSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    runId: UuidSchema,
    scheduleId: UuidSchema,
    serverInstanceId: UuidSchema,
    /**
     * The instant this run is *for*, not when it started.
     *
     * Deduplication keys on it, so a scheduler that woke twice, or two
     * schedulers that woke at once, produce one run for one occurrence — and a
     * crash-recovered scheduler catching up does not fire yesterday's window a
     * second time.
     */
    scheduledFor: IsoDateTimeSchema,
    status: ScheduleRunStatusSchema,
    claimedAt: IsoDateTimeSchema,
    /** The claim expires; a scheduler that died mid-run releases it by lapsing. */
    leaseExpiresAt: IsoDateTimeSchema,
    completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    stepIndex: Type.Integer({ minimum: 0, maximum: 8 }),
    failureCode: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    /**
     * Whether the server was observed healthy after a restart step.
     *
     * `null` when no restart ran. A restart that is never verified is a restart
     * nobody knows the outcome of, so a run is not successful until this is
     * true whenever a restart was part of it.
     */
    postRestartVerified: Type.Union([Type.Boolean(), Type.Null()]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/schedule-run.schema.json',
    additionalProperties: false,
  },
);

export type ScheduleStep = Static<typeof ScheduleStepSchema>;
export type ScheduleTrigger = Static<typeof ScheduleTriggerSchema>;
export type ServerSchedule = Static<typeof ServerScheduleSchema>;
export type ScheduleRunStatus = Static<typeof ScheduleRunStatusSchema>;
export type ScheduleRun = Static<typeof ScheduleRunSchema>;

/** Zones the deployment accepts. A closed list is checkable; `Intl` is not. */
const SUPPORTED_TIMEZONES = new Set([
  'UTC',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Berlin',
]);

export function isSupportedTimezone(value: string): boolean {
  return SUPPORTED_TIMEZONES.has(value);
}

export function validateServerSchedule(
  value: unknown,
): ContractValidationResult<ServerSchedule> {
  const result = validateContract(ServerScheduleSchema, value);
  if (!result.success) return result;
  const schedule = result.value;
  const issues = [];

  if (!isSupportedTimezone(schedule.trigger.timezone)) {
    issues.push(semanticIssue('/trigger/timezone', 'unsupported timezone'));
  }

  const restarts = schedule.steps.filter((step) => step.kind === 'restart').length;
  if (restarts > 1) {
    issues.push(semanticIssue('/steps', 'a schedule restarts at most once'));
  }
  if (schedule.steps.filter((step) => step.kind === 'backup').length > 1) {
    issues.push(semanticIssue('/steps', 'a schedule backs up at most once'));
  }

  // A warning nobody hears is not a warning. Warning players about a run that
  // does not disturb them is noise, and it trains them to ignore the ones that
  // do.
  if (schedule.steps.some((step) => step.kind === 'warn-players') && restarts === 0) {
    issues.push(semanticIssue('/steps', 'a warning belongs to a step that disrupts players'));
  }

  // Ordering carries meaning: warn, then check, then back up, then restart.
  // A backup taken after the restart would capture the world the restart just
  // produced, not the one an operator wanted preserved before touching it.
  const order = ['warn-players', 'maintenance-check', 'backup', 'restart'];
  const positions = schedule.steps.map((step) => order.indexOf(step.kind));
  for (let index = 1; index < positions.length; index += 1) {
    if ((positions[index] ?? 0) < (positions[index - 1] ?? 0)) {
      issues.push(semanticIssue(`/steps/${index}`, 'steps run warn, check, backup, restart'));
      break;
    }
  }

  return appendSemanticIssues(result, issues);
}

export function validateScheduleRun(value: unknown): ContractValidationResult<ScheduleRun> {
  const result = validateContract(ScheduleRunSchema, value);
  if (!result.success) return result;
  const run = result.value;
  const issues = [];
  const settled = run.status === 'succeeded' || run.status === 'failed' || run.status === 'skipped';
  if (settled !== (run.completedAt !== null)) {
    issues.push(semanticIssue('/completedAt', 'only a settled run says when it finished'));
  }
  if ((run.status === 'failed') !== (run.failureCode !== null)) {
    issues.push(semanticIssue('/failureCode', 'a failed run names its failure'));
  }
  if (run.completedAt !== null && Date.parse(run.completedAt) < Date.parse(run.claimedAt)) {
    issues.push(semanticIssue('/completedAt', 'a run cannot finish before it was claimed'));
  }
  if (Date.parse(run.leaseExpiresAt) <= Date.parse(run.claimedAt)) {
    issues.push(semanticIssue('/leaseExpiresAt', 'a claim must expire after it was taken'));
  }
  // A run that restarted and reports success must have seen the server come
  // back. Otherwise "succeeded" means only that the command was sent.
  if (run.status === 'succeeded' && run.postRestartVerified === false) {
    issues.push(
      semanticIssue('/postRestartVerified', 'a successful run verified the server after restarting'),
    );
  }
  return appendSemanticIssues(result, issues);
}

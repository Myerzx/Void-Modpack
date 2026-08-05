import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  IsoDateTimeSchema,
  Sha256Schema,
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
 * Public contracts for the Phase 9.2 agent transport.
 *
 * The protocol is outbound-only: the agent dials the control plane, claims work
 * under a lease and reports the result. Nothing in the control plane opens a
 * connection to an agent, so no inbound port has to exist on the server host.
 *
 * A capability is a *named, reviewed* operation that has to be announced by the
 * agent and granted individually by the control plane. There is deliberately no
 * generic executor: a lease names a job type from a closed union and carries an
 * opaque parameter reference, never a command, a path or a shell fragment.
 */

/**
 * Closed set of capabilities. Adding one is a reviewed act — a capability that
 * is merely announced by an agent but never granted authorizes nothing.
 */
export const AgentCapabilitySchema = Type.Union([
  Type.Literal('heartbeat'),
  Type.Literal('configuration.apply'),
  Type.Literal('artifact.inspect'),
  Type.Literal('artifact.analyze'),
  Type.Literal('process.observe'),
  Type.Literal('process.control'),
  Type.Literal('process.force-kill'),
  Type.Literal('console.command'),
]);

export const AgentCredentialStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('rotated'),
  Type.Literal('revoked'),
]);

/**
 * One credential in an agent's history.
 *
 * Only one credential per agent may be `active`. Rotation supersedes the
 * previous one rather than editing it, so the history stays auditable and a
 * superseded fingerprint can never authenticate again.
 */
export const AgentCredentialSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    credentialId: UuidSchema,
    agentId: UuidSchema,
    certificateFingerprint: Sha256Schema,
    status: AgentCredentialStatusSchema,
    createdAt: IsoDateTimeSchema,
    supersededAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/agent-credential.schema.json',
    additionalProperties: false,
  },
);

/** What the agent asks for when it dials in for work. */
export const AgentWorkClaimPayloadSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    /** Only capabilities the agent can actually serve right now. */
    capabilities: Type.Array(AgentCapabilitySchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
    leaseSeconds: Type.Integer({ minimum: 5, maximum: 900 }),
    /** Identifies one run of the agent, so a restart is visible to the API. */
    bootId: UuidSchema,
  },
  { additionalProperties: false },
);

/**
 * A leased unit of work.
 *
 * `parameters` is an opaque reference the matching capability knows how to
 * resolve. It never carries a path, a root, a command or bytes: the capability
 * resolves those from trusted local configuration, exactly as Phase 7.3
 * established for `configuration.apply`.
 */
export const AgentWorkLeaseSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    leaseId: UuidSchema,
    jobId: UuidSchema,
    capability: AgentCapabilitySchema,
    /**
     * The job type this lease covers. A capability may serve more than one, so
     * without it the agent could not tell a stop from a restart and would have
     * to guess at what it was asked to do.
     */
    jobType: Type.String({ minLength: 3, maxLength: 64, pattern: '^[a-z][a-z0-9.-]{2,63}$' }),
    correlationId: UuidSchema,
    parameters: Type.Object(
      {
        resourceType: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }),
        resourceId: Type.String({ minLength: 1, maxLength: 128 }),
        /** Version of the record the work was leased against. */
        expectedVersion: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
      },
      { additionalProperties: false },
    ),
    leasedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    attempt: Type.Integer({ minimum: 1, maximum: 16 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/agent-work-lease.schema.json',
    additionalProperties: false,
  },
);

export const AgentWorkClaimResponseSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    leases: Type.Array(AgentWorkLeaseSchema, { maxItems: 8 }),
    /** How long the agent should wait before dialling again when idle. */
    retryAfterSeconds: Type.Integer({ minimum: 1, maximum: 3_600 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/agent-work-claim-response.schema.json',
    additionalProperties: false,
  },
);

export const AgentWorkFailureCodeSchema = Type.Union([
  Type.Literal('capability-refused'),
  Type.Literal('precondition-not-met'),
  Type.Literal('lease-expired'),
  Type.Literal('operation-failed'),
  Type.Literal('unsupported-parameters'),
]);

/** What the agent reports back. A result closes a lease; it never opens work. */
export const AgentWorkResultPayloadSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    leaseId: UuidSchema,
    jobId: UuidSchema,
    outcome: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
    failureCode: Type.Union([AgentWorkFailureCodeSchema, Type.Null()]),
    observedLifecycle: Type.Union([
      Type.Literal('unknown'),
      Type.Literal('offline'),
      Type.Literal('starting'),
      Type.Literal('online'),
      Type.Literal('stopping'),
      Type.Literal('error'),
      Type.Null(),
    ]),
    observedPid: Type.Union([Type.Integer({ minimum: 1, maximum: 4_294_967_295 }), Type.Null()]),
    bootId: Type.Union([UuidSchema, Type.Null()]),
    completedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export type AgentCapability = Static<typeof AgentCapabilitySchema>;
export type AgentCredentialStatus = Static<typeof AgentCredentialStatusSchema>;
export type AgentCredential = Static<typeof AgentCredentialSchema>;
export type AgentWorkClaimPayload = Static<typeof AgentWorkClaimPayloadSchema>;
export type AgentWorkLease = Static<typeof AgentWorkLeaseSchema>;
export type AgentWorkClaimResponse = Static<typeof AgentWorkClaimResponseSchema>;
export type AgentWorkFailureCode = Static<typeof AgentWorkFailureCodeSchema>;
export type AgentWorkResultPayload = Static<typeof AgentWorkResultPayloadSchema>;

/** Job types a capability is allowed to serve. Nothing else may be leased. */
const CAPABILITY_JOB_TYPES: Readonly<Record<AgentCapability, readonly string[]>> = Object.freeze({
  heartbeat: [],
  'configuration.apply': ['configuration.apply', 'configuration.rollback'],
  'artifact.inspect': ['artifact.inspect'],
  'artifact.analyze': ['artifact.analyze'],
  'process.observe': [],
  'process.control': ['server.start', 'server.stop', 'server.restart'],
  // Deliberately separate: granting ordinary control must never imply the
  // authority to kill a running server.
  'process.force-kill': ['server.force-kill'],
  // The closed console catalogue is served by its own capability, so console
  // access never rides along with process control.
  'console.command': ['server.command'],
});

export function jobTypesForCapability(capability: AgentCapability): readonly string[] {
  return CAPABILITY_JOB_TYPES[capability];
}

/** Whether a capability may serve a job type at all. */
export function capabilityServesJobType(capability: AgentCapability, jobType: string): boolean {
  return CAPABILITY_JOB_TYPES[capability].includes(jobType);
}

export function validateAgentWorkClaimPayload(
  value: unknown,
): ContractValidationResult<AgentWorkClaimPayload> {
  const result = validateContract(AgentWorkClaimPayloadSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  // Claiming for a capability that can serve no job type is meaningless and
  // usually means the agent is asking for something it should not.
  const claimable = result.value.capabilities.filter(
    (capability) => CAPABILITY_JOB_TYPES[capability].length > 0,
  );
  if (claimable.length === 0) {
    issues.push(semanticIssue('/capabilities', 'no claimed capability can serve leasable work'));
  }
  return appendSemanticIssues(result, issues);
}

export function validateAgentWorkLease(value: unknown): ContractValidationResult<AgentWorkLease> {
  const result = validateContract(AgentWorkLeaseSchema, value);
  if (!result.success) return result;

  const lease = result.value;
  const issues: ContractValidationIssue[] = [];
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.leasedAt)) {
    issues.push(semanticIssue('/expiresAt', 'a lease must expire after it was taken'));
  }
  // A lease may only pair a capability with a job type it is allowed to serve.
  if (jobTypesForCapability(lease.capability).length === 0) {
    issues.push(semanticIssue('/capability', 'this capability serves no leasable work'));
  } else if (!capabilityServesJobType(lease.capability, lease.jobType)) {
    issues.push(semanticIssue('/jobType', 'this capability may not serve that job type'));
  }
  return appendSemanticIssues(result, issues);
}

export function validateAgentWorkResultPayload(
  value: unknown,
): ContractValidationResult<AgentWorkResultPayload> {
  const result = validateContract(AgentWorkResultPayloadSchema, value);
  if (!result.success) return result;

  const payload = result.value;
  const issues: ContractValidationIssue[] = [];
  if (payload.outcome === 'failed' && payload.failureCode === null) {
    issues.push(semanticIssue('/failureCode', 'a failed result must name its failure'));
  }
  if (payload.outcome === 'succeeded' && payload.failureCode !== null) {
    issues.push(semanticIssue('/failureCode', 'a successful result has no failure'));
  }
  // A pid is meaningless without the boot that produced it.
  if (payload.observedPid !== null && payload.bootId === null) {
    issues.push(semanticIssue('/observedPid', 'an observed pid requires its boot id'));
  }
  if (
    payload.observedPid !== null &&
    (payload.observedLifecycle === 'offline' ||
      payload.observedLifecycle === 'unknown' ||
      payload.observedLifecycle === null)
  ) {
    issues.push(semanticIssue('/observedPid', 'a process that is not running has no pid'));
  }
  return appendSemanticIssues(result, issues);
}

export function validateAgentCredential(
  value: unknown,
): ContractValidationResult<AgentCredential> {
  const result = validateContract(AgentCredentialSchema, value);
  if (!result.success) return result;

  const credential = result.value;
  const issues: ContractValidationIssue[] = [];
  // An active credential is the current one, so nothing superseded it.
  if (credential.status === 'active' && credential.supersededAt !== null) {
    issues.push(semanticIssue('/supersededAt', 'an active credential was not superseded'));
  }
  if (credential.status !== 'active' && credential.supersededAt === null) {
    issues.push(semanticIssue('/supersededAt', 'a superseded credential must say when'));
  }
  if (
    credential.supersededAt !== null &&
    Date.parse(credential.supersededAt) < Date.parse(credential.createdAt)
  ) {
    issues.push(semanticIssue('/supersededAt', 'a credential cannot be superseded before it existed'));
  }
  return appendSemanticIssues(result, issues);
}

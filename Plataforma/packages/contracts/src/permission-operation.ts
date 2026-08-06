import { Type, type Static } from '@sinclair/typebox';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
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

/**
 * Typed permission operations, carried to the Forge Bridge.
 *
 * The console catalogue is closed to reviewed literals without arguments, and
 * LuckPerms commands take a player, a group, a node and a context. Widening
 * that catalogue would have turned the console into a parameterised executor —
 * an argument from the control plane concatenated into a command string is how
 * a typed channel becomes a shell with extra steps. So mutation crosses the
 * boundary as named fields with a closed set of kinds, and there is no command
 * text anywhere in this file.
 *
 * **No operation carries a player name or a Minecraft UUID.** That is the
 * single most important property here, and it is enforced structurally rather
 * than by convention: an offline-mode UUID is derived from the name, so
 * accepting either from a screen would let anyone operate on any identity by
 * choosing the right name. An operation names the VoidFall identity and the
 * claim it was decided against; the Bridge resolves that to the current UUID
 * itself, and refuses when the claim it finds is not the one expected.
 *
 * A snapshot, on the other hand, *reports* a UUID: it is an observation of what
 * the provider held, not an instruction about whom to act on.
 */

/** The mutations authorised to start. Nothing outside this set is executable. */
export const PermissionOperationKindSchema = Type.Union([
  Type.Literal('USER_GROUP_ADD'),
  Type.Literal('USER_GROUP_REMOVE'),
  Type.Literal('USER_NODE_SET'),
  Type.Literal('USER_NODE_UNSET'),
]);

/** LuckPerms group names, as the provider accepts them. */
export const PermissionGroupSchema = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)*$',
});

/**
 * A permission node.
 *
 * Deliberately narrow: dotted segments, wildcards allowed only as a whole final
 * segment. A node is matched by prefix, so `a.b.*` grants everything beneath
 * it; permitting a wildcard in the middle would make the blast radius of a
 * typo hard to reason about at review time.
 */
export const PermissionNodeSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\\.\\*)?$',
});

/**
 * What every operation carries regardless of kind.
 *
 * `operationId` is the idempotency key as well as the identifier: a replay with
 * the same id finds the original outcome instead of applying a second effect.
 * It is a v4-shaped uuid and must contain nothing derived from the request, so
 * an honest replay cannot look like a different one.
 */
const operationEnvelope = {
  schemaVersion: ContractSchemaVersion,
  operationId: UuidSchema,
  /** The server this applies to. One instance's operation is not another's. */
  serverInstanceId: UuidSchema,
  /** The stable VoidFall identity, never a name and never a Minecraft UUID. */
  identityId: UuidSchema,
  /**
   * The claim this operation was decided against. If the active claim differs
   * when the Bridge looks, the world moved between the decision and the effect,
   * and applying it anyway would act on the wrong person.
   */
  expectedClaimId: UuidSchema,
  actor: ActorRefSchema,
  reason: Type.String({ minLength: 1, maxLength: 1_000 }),
  issuedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
} as const;

const groupOperation = (kind: 'USER_GROUP_ADD' | 'USER_GROUP_REMOVE') =>
  Type.Object(
    { ...operationEnvelope, kind: Type.Literal(kind), group: PermissionGroupSchema },
    { additionalProperties: false },
  );

export const PermissionOperationSchema = Type.Union(
  [
    groupOperation('USER_GROUP_ADD'),
    groupOperation('USER_GROUP_REMOVE'),
    Type.Object(
      {
        ...operationEnvelope,
        kind: Type.Literal('USER_NODE_SET'),
        node: PermissionNodeSchema,
        /**
         * `false` is a negation, not a removal. LuckPerms distinguishes the two
         * and so does this: unsetting drops the node, setting it false denies
         * it explicitly and outranks an inherited grant.
         */
        value: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...operationEnvelope, kind: Type.Literal('USER_NODE_UNSET'), node: PermissionNodeSchema },
      { additionalProperties: false },
    ),
  ],
  { $id: 'https://schemas.voidfall.invalid/v1/permission-operation.schema.json' },
);

/**
 * Rebinding an identity to a new Minecraft claim, as one operation.
 *
 * A name change moves the offline UUID. Done as a sequence of independent
 * commands, each step can fail alone and leave a state nobody chose:
 * permissions on two UUIDs, or on neither, or a claim revoked before the copy
 * existed. It is one operation so the Bridge can order it such that any
 * interruption leaves the previous state intact — the revocation is the last
 * act, and until it happens the old claim is still the valid one.
 *
 * Both claims are named by id. Neither carries a UUID, for the same reason no
 * other operation does.
 */
export const PermissionRebindOperationSchema = Type.Object(
  {
    ...operationEnvelope,
    kind: Type.Literal('USER_REBIND'),
    /** The claim to become active once the copy is verified. */
    newClaimId: UuidSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/permission-rebind-operation.schema.json',
    additionalProperties: false,
  },
);

/** One node as the provider holds it. */
export const PermissionNodeStateSchema = Type.Object(
  { node: PermissionNodeSchema, value: Type.Boolean() },
  { additionalProperties: false },
);

/**
 * What the provider actually held, when it was read.
 *
 * `source` and `observedAt` travel with it because VoidFall does not own this
 * state — it presents someone else's. A screen showing groups without saying
 * where they came from and how old the reading is invites the reader to treat
 * a cache as the truth, which is precisely the second source of truth this
 * design refuses to create.
 */
export const PermissionSnapshotSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    identityId: UuidSchema,
    claimId: UuidSchema,
    /** Observed, not supplied. This is a report, never an instruction. */
    minecraftUuid: UuidSchema,
    groups: Type.Array(PermissionGroupSchema, { maxItems: 64 }),
    nodes: Type.Array(PermissionNodeStateSchema, { maxItems: 256 }),
    source: Type.Object(
      { providerId: SlugSchema, providerVersion: Type.Union([SlugSchema, Type.Null()]) },
      { additionalProperties: false },
    ),
    observedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/permission-snapshot.schema.json',
    additionalProperties: false,
  },
);

/**
 * Closed set of reasons an operation did not apply.
 *
 * Closed so an unexpected internal fault cannot become a channel for provider
 * messages, paths or host detail — the same rule the configuration capability
 * already follows.
 */
export const PermissionFailureCodeSchema = Type.Union([
  /** The active claim is not the one the operation was decided against. */
  Type.Literal('claim-mismatch'),
  /** The identity has no active claim, so there is nobody to act on. */
  Type.Literal('identity-not-claimed'),
  Type.Literal('server-mismatch'),
  Type.Literal('operation-expired'),
  Type.Literal('provider-unavailable'),
  Type.Literal('group-not-found'),
  Type.Literal('node-rejected'),
  /** The rebind copied but could not verify, so nothing was revoked. */
  Type.Literal('rebind-not-verified'),
  Type.Literal('operation-failed'),
]);

export const PermissionOperationReceiptSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    operationId: UuidSchema,
    outcome: Type.Union([
      Type.Literal('applied'),
      /** The provider already held this. Not a failure, and worth distinguishing. */
      Type.Literal('no-change'),
      Type.Literal('failed'),
    ]),
    failureCode: Type.Union([PermissionFailureCodeSchema, Type.Null()]),
    /**
     * The re-read after the mutation, not the intent that produced it.
     *
     * `null` only when the provider could not be read at all. Returning the
     * requested state instead of the observed one would report a mutation that
     * may not have landed, which is the class of defect nobody sees until it
     * matters.
     */
    snapshot: Type.Union([PermissionSnapshotSchema, Type.Null()]),
    completedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/permission-operation-receipt.schema.json',
    additionalProperties: false,
  },
);

export type PermissionOperationKind = Static<typeof PermissionOperationKindSchema>;
export type PermissionOperation = Static<typeof PermissionOperationSchema>;
export type PermissionRebindOperation = Static<typeof PermissionRebindOperationSchema>;
export type PermissionNodeState = Static<typeof PermissionNodeStateSchema>;
export type PermissionSnapshot = Static<typeof PermissionSnapshotSchema>;
export type PermissionFailureCode = Static<typeof PermissionFailureCodeSchema>;
export type PermissionOperationReceipt = Static<typeof PermissionOperationReceiptSchema>;

/** An operation older than this was decided against a world that has moved. */
const MAXIMUM_OPERATION_LIFETIME_MS = 300_000;

function validateLifetime(
  issuedAt: string,
  expiresAt: string,
  issues: ContractValidationIssue[],
): void {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (expires <= issued) {
    issues.push(semanticIssue('/expiresAt', 'an operation must expire after it was issued'));
    return;
  }
  if (expires - issued > MAXIMUM_OPERATION_LIFETIME_MS) {
    issues.push(
      semanticIssue('/expiresAt', 'a permission operation must expire within five minutes'),
    );
  }
}

export function validatePermissionOperation(
  value: unknown,
): ContractValidationResult<PermissionOperation> {
  const result = validateContract(PermissionOperationSchema, value);
  if (!result.success) return result;
  const issues: ContractValidationIssue[] = [];
  validateLifetime(result.value.issuedAt, result.value.expiresAt, issues);
  return appendSemanticIssues(result, issues);
}

export function validatePermissionRebindOperation(
  value: unknown,
): ContractValidationResult<PermissionRebindOperation> {
  const result = validateContract(PermissionRebindOperationSchema, value);
  if (!result.success) return result;
  const issues: ContractValidationIssue[] = [];
  validateLifetime(result.value.issuedAt, result.value.expiresAt, issues);
  if (result.value.newClaimId === result.value.expectedClaimId) {
    // Rebinding to the claim already active is not a no-op worth running: it
    // would revoke the claim it just promoted.
    issues.push(semanticIssue('/newClaimId', 'a rebind must name a claim other than the active one'));
  }
  return appendSemanticIssues(result, issues);
}

export function validatePermissionSnapshot(
  value: unknown,
): ContractValidationResult<PermissionSnapshot> {
  return validateContract(PermissionSnapshotSchema, value);
}

export function validatePermissionOperationReceipt(
  value: unknown,
): ContractValidationResult<PermissionOperationReceipt> {
  const result = validateContract(PermissionOperationReceiptSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const { outcome, failureCode, snapshot } = result.value;
  if ((outcome === 'failed') !== (failureCode !== null)) {
    issues.push(semanticIssue('/failureCode', 'a failed operation names its failure, and only it'));
  }
  if (outcome !== 'failed' && snapshot === null) {
    // An operation that applied and then could not be read back is reported as
    // failed, not as a success with nothing to show: "it worked, I think" is
    // not an outcome an operator can act on.
    issues.push(
      semanticIssue('/snapshot', 'an applied operation must carry the state that was read back'),
    );
  }
  return appendSemanticIssues(result, issues);
}

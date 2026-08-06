import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  IsoDateTimeSchema,
  SignatureSchema,
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
 * Signed evidence that an identity holds a Minecraft account.
 *
 * The Bridge needs to know which account a VoidFall identity holds, and the
 * table that knows lives in the control plane. Mirroring it into the server
 * would create a second copy to keep in step, and a stale mirror answering
 * "who holds this account" is how an operation lands on the wrong person long
 * after somebody fixed the record.
 *
 * So there is no mirror. Evidence is **carried** by whatever is already
 * crossing the boundary, and only two things ever do:
 *
 *  - the signed login ticket, for a player who is connecting;
 *  - the signed durable operation, for administrative work while the player is
 *    offline.
 *
 * Both are signed by the control plane and verified locally, so evidence is as
 * trustworthy as the channel that carried it and no more. Nothing else is a
 * source: not a name, not a UUID on its own, and not the first record that
 * happens to match.
 */

/** A player name as Minecraft accepts it. Context, never identification. */
export const MinecraftNameSchema = Type.String({
  minLength: 3,
  maxLength: 16,
  pattern: '^[A-Za-z0-9_]+$',
});

export const ClaimEvidenceSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    identityId: UuidSchema,
    claimId: UuidSchema,
    /**
     * Which version of the claim this evidence describes.
     *
     * Carried so the Bridge can reject evidence older than what it already
     * holds. Without it, a replayed ticket from before a revocation would be
     * indistinguishable from a fresh one, and the revocation would only take
     * effect once the ticket expired.
     */
    claimRevision: Type.Integer({ minimum: 1 }),
    serverInstanceId: UuidSchema,
    /**
     * What the connection is expected to present. The Bridge compares the real
     * connection name against this, derives the offline UUID locally, and
     * compares that too — deriving rather than trusting is the whole point,
     * because an offline UUID is a function of the name and a supplied one
     * proves only that somebody could type.
     */
    expectedMinecraftName: MinecraftNameSchema,
    expectedMinecraftUuid: UuidSchema,
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/claim-evidence.schema.json',
    additionalProperties: false,
  },
);

/**
 * Withdrawal of evidence already handed out.
 *
 * Deliberately not claim synchronisation. It says one thing — this claim is no
 * longer valid past this revision — so an active session can be dropped and
 * later evidence at an older revision refused. Turning it into a general feed
 * of claim state would rebuild the mirror this design avoids, by increments.
 */
export const ClaimInvalidationSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    identityId: UuidSchema,
    claimId: UuidSchema,
    /** Evidence at or below this revision is refused from now on. */
    invalidatedThroughRevision: Type.Integer({ minimum: 1 }),
    serverInstanceId: UuidSchema,
    reason: Type.Union([
      Type.Literal('claim-revoked'),
      Type.Literal('claim-rebound'),
      Type.Literal('credential-revoked'),
      Type.Literal('identity-retired'),
    ]),
    /** Whether a session already holding this claim must be dropped. */
    dropActiveSession: Type.Boolean(),
    issuedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/claim-invalidation.schema.json',
    additionalProperties: false,
  },
);

/** Evidence with the control plane's signature over it. */
export const SignedClaimEvidenceSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    evidence: ClaimEvidenceSchema,
    signature: SignatureSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/signed-claim-evidence.schema.json',
    additionalProperties: false,
  },
);

export type MinecraftName = Static<typeof MinecraftNameSchema>;
export type ClaimEvidence = Static<typeof ClaimEvidenceSchema>;
export type ClaimInvalidation = Static<typeof ClaimInvalidationSchema>;
export type SignedClaimEvidence = Static<typeof SignedClaimEvidenceSchema>;

/**
 * Evidence is short-lived on purpose.
 *
 * It asserts a fact that can change — a claim can be revoked or rebound — and
 * the Bridge validates locally without asking the control plane. The window is
 * therefore the latency of a revocation, which is why it is measured in
 * minutes rather than hours.
 */
const MAXIMUM_EVIDENCE_LIFETIME_MS = 300_000;

export function validateClaimEvidence(value: unknown): ContractValidationResult<ClaimEvidence> {
  const result = validateContract(ClaimEvidenceSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const issued = Date.parse(result.value.issuedAt);
  const expires = Date.parse(result.value.expiresAt);
  if (expires <= issued) {
    issues.push(semanticIssue('/expiresAt', 'evidence must expire after it was issued'));
  } else if (expires - issued > MAXIMUM_EVIDENCE_LIFETIME_MS) {
    issues.push(semanticIssue('/expiresAt', 'claim evidence must expire within five minutes'));
  }
  return appendSemanticIssues(result, issues);
}

export function validateSignedClaimEvidence(
  value: unknown,
): ContractValidationResult<SignedClaimEvidence> {
  const result = validateContract(SignedClaimEvidenceSchema, value);
  if (!result.success) return result;
  const inner = validateClaimEvidence(result.value.evidence);
  return inner.success
    ? result
    : appendSemanticIssues(
        result,
        inner.issues.map((issue) => semanticIssue(`/evidence${issue.path}`, issue.message)),
      );
}

export function validateClaimInvalidation(
  value: unknown,
): ContractValidationResult<ClaimInvalidation> {
  return validateContract(ClaimInvalidationSchema, value);
}

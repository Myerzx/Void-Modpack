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
 * The stable identity of a player, and the Minecraft account it holds.
 *
 * The server runs in offline mode by product decision, so a Minecraft UUID is
 * derived from the player's name and proves nothing about who typed it. The
 * stable key is therefore issued by VoidFall and established by authentication;
 * the Minecraft UUID is a **claim** on that identity — observable, revocable,
 * and re-bindable when a name change moves it.
 *
 * `PlayerProfile` and `ModerationCase` are keyed on this identity too. They
 * used to be keyed on `playerUuid`; that field was removed rather than
 * reinterpreted, because giving an existing field a new meaning leaves two
 * readers of the same column disagreeing and nothing recording when it
 * changed.
 */

/** A claim that was never proven is not the same as one that was. */
export const MinecraftClaimStatusSchema = Type.Union([
  /**
   * Carried over from the pre-authentication server. It records that an account
   * existed and grants nothing: the seven accounts found in the audit are
   * name-derived, and the operators behind them must claim again.
   */
  Type.Literal('legacy-unclaimed'),
  Type.Literal('active'),
  Type.Literal('revoked'),
]);

export const MinecraftClaimSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    claimId: UuidSchema,
    identityId: UuidSchema,
    serverInstanceId: UuidSchema,
    minecraftUuid: UuidSchema,
    status: MinecraftClaimStatusSchema,
    /**
     * Bumped whenever the claim changes hands or state.
     *
     * Signed claim evidence carries it, so the Bridge can refuse anything at or
     * below a revision that has been invalidated. Without it a ticket minted
     * before a revocation looks exactly like one minted after.
     */
    revision: Type.Integer({ minimum: 1 }),
    /** `null` exactly while the claim has never been proven. */
    claimedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    revokedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    reasonCode: SlugSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/minecraft-claim.schema.json',
    additionalProperties: false,
  },
);

export const PlayerIdentityStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('retired'),
]);

export const PlayerIdentitySchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    identityId: UuidSchema,
    status: PlayerIdentityStatusSchema,
    /** Absent until the identity has been seen on a server. */
    firstSeenAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    lastSeenAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    createdBy: ActorRefSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    version: Type.Integer({ minimum: 1 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/player-identity.schema.json',
    additionalProperties: false,
  },
);

export type MinecraftClaimStatus = Static<typeof MinecraftClaimStatusSchema>;
export type MinecraftClaim = Static<typeof MinecraftClaimSchema>;
export type PlayerIdentityStatus = Static<typeof PlayerIdentityStatusSchema>;
export type PlayerIdentity = Static<typeof PlayerIdentitySchema>;

export function validateMinecraftClaim(value: unknown): ContractValidationResult<MinecraftClaim> {
  const result = validateContract(MinecraftClaimSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const claim = result.value;
  // A legacy claim was never proven, so it cannot carry the moment it was.
  if ((claim.status === 'legacy-unclaimed') !== (claim.claimedAt === null)) {
    issues.push(
      semanticIssue('/claimedAt', 'only an unproven claim has no moment it was claimed'),
    );
  }
  if ((claim.status === 'revoked') !== (claim.revokedAt !== null)) {
    issues.push(semanticIssue('/revokedAt', 'a revoked claim names when, and only it does'));
  }
  if (claim.claimedAt !== null && Date.parse(claim.claimedAt) < Date.parse(claim.createdAt)) {
    issues.push(semanticIssue('/claimedAt', 'a claim cannot be proven before it existed'));
  }
  if (
    claim.revokedAt !== null &&
    claim.claimedAt !== null &&
    Date.parse(claim.revokedAt) < Date.parse(claim.claimedAt)
  ) {
    issues.push(semanticIssue('/revokedAt', 'a claim cannot be revoked before it was proven'));
  }
  return appendSemanticIssues(result, issues);
}

export function validatePlayerIdentity(value: unknown): ContractValidationResult<PlayerIdentity> {
  const result = validateContract(PlayerIdentitySchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const identity = result.value;
  if (Date.parse(identity.updatedAt) < Date.parse(identity.createdAt)) {
    issues.push(semanticIssue('/updatedAt', 'an identity cannot be updated before it existed'));
  }
  if ((identity.firstSeenAt === null) !== (identity.lastSeenAt === null)) {
    // Either it has been seen or it has not. One half of the pair means a write
    // went in that nobody thought through.
    issues.push(semanticIssue('/lastSeenAt', 'first and last sighting travel together'));
  }
  if (
    identity.firstSeenAt !== null &&
    identity.lastSeenAt !== null &&
    Date.parse(identity.lastSeenAt) < Date.parse(identity.firstSeenAt)
  ) {
    issues.push(semanticIssue('/lastSeenAt', 'the last sighting cannot precede the first'));
  }
  return appendSemanticIssues(result, issues);
}

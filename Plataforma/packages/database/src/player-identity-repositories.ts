import {
  validateMinecraftClaim,
  validatePlayerIdentity,
  type ActorRef,
  type MinecraftClaim,
  type MinecraftClaimStatus,
  type PlayerIdentity,
} from '@voidfall/contracts';

import type { Database, SqlClient } from './database.js';

/**
 * Durable player identity and the Minecraft accounts claimed against it.
 *
 * The property this module exists to hold: **a Minecraft UUID is never an
 * identity.** In offline mode it is derived from the player's name, so the
 * stable key is issued by VoidFall and the account is a claim on it. Every
 * lookup that matters here starts from the identity and ends at the account,
 * never the other way round — resolving an identity *from* a UUID would be the
 * same trust in a name, taken through a different door.
 *
 * Two partial unique indexes carry the invariants rather than application code:
 * one identity holds at most one account per server, and one account is held by
 * at most one identity. The database refuses the second write instead of a
 * read-then-write that a concurrent claim could slip past.
 */

export type PlayerIdentityErrorCode =
  | 'identity-not-found'
  | 'claim-not-found'
  | 'claim-conflict'
  | 'invalid-transition'
  | 'stale-identity'
  | 'invalid-record';

export class PlayerIdentityPersistenceError extends Error {
  public readonly code: PlayerIdentityErrorCode;

  public constructor(code: PlayerIdentityErrorCode) {
    super(`player-identity:${code}`);
    this.name = 'PlayerIdentityPersistenceError';
    this.code = code;
  }
}

interface IdentityRow {
  readonly identity_id: string;
  readonly status: 'active' | 'retired';
  readonly first_seen_at: Date | string | null;
  readonly last_seen_at: Date | string | null;
  readonly created_by: ActorRef | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly version: string | number;
}

interface ClaimRow {
  readonly claim_id: string;
  readonly identity_id: string;
  readonly server_instance_id: string;
  readonly minecraft_uuid: string;
  readonly status: MinecraftClaimStatus;
  readonly claimed_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly reason_code: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function mapIdentity(row: IdentityRow): PlayerIdentity {
  const identity: PlayerIdentity = {
    schemaVersion: 1,
    identityId: row.identity_id,
    status: row.status,
    firstSeenAt: isoOrNull(row.first_seen_at),
    lastSeenAt: isoOrNull(row.last_seen_at),
    createdBy: typeof row.created_by === 'string' ? (JSON.parse(row.created_by) as ActorRef) : row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
  // Storage constraints and the contract state the same invariants. A row that
  // satisfied one but not the other is a defect, not a value to publish.
  const validated = validatePlayerIdentity(identity);
  if (!validated.success) throw new PlayerIdentityPersistenceError('invalid-record');
  return validated.value;
}

function mapClaim(row: ClaimRow): MinecraftClaim {
  const claim: MinecraftClaim = {
    schemaVersion: 1,
    claimId: row.claim_id,
    identityId: row.identity_id,
    serverInstanceId: row.server_instance_id,
    minecraftUuid: row.minecraft_uuid,
    status: row.status,
    claimedAt: isoOrNull(row.claimed_at),
    revokedAt: isoOrNull(row.revoked_at),
    reasonCode: row.reason_code,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  const validated = validateMinecraftClaim(claim);
  if (!validated.success) throw new PlayerIdentityPersistenceError('invalid-record');
  return validated.value;
}

const IDENTITY_COLUMNS = `identity_id, status, first_seen_at, last_seen_at, created_by,
  created_at, updated_at, version`;
const CLAIM_COLUMNS = `claim_id, identity_id, server_instance_id, minecraft_uuid, status,
  claimed_at, revoked_at, reason_code, created_at, updated_at`;

export interface ImportLegacyClaimInput {
  readonly identityId: string;
  readonly claimId: string;
  readonly serverInstanceId: string;
  readonly minecraftUuid: string;
  readonly createdBy: ActorRef;
  readonly reasonCode: string;
  readonly now: Date;
}

export interface ClaimIdentityInput {
  readonly claimId: string;
  readonly identityId: string;
  readonly reasonCode: string;
  readonly now: Date;
}

export class PlayerIdentityRepository {
  public constructor(private readonly database: Database) {}

  async createIdentity(input: {
    readonly identityId: string;
    readonly createdBy: ActorRef;
    readonly now: Date;
  }): Promise<PlayerIdentity> {
    const result = await this.database.query<IdentityRow>(
      `INSERT INTO player_identities (identity_id, created_by, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3, $3)
       RETURNING ${IDENTITY_COLUMNS}`,
      [input.identityId, JSON.stringify(input.createdBy), input.now.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new PlayerIdentityPersistenceError('identity-not-found');
    return mapIdentity(row);
  }

  async findIdentity(identityId: string): Promise<PlayerIdentity | undefined> {
    const result = await this.database.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM player_identities WHERE identity_id = $1`,
      [identityId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapIdentity(row);
  }

  /**
   * Brings an account carried over from the pre-authentication server in as a
   * record, and nothing more.
   *
   * The identity and the claim are written in one transaction, because an
   * identity with no claim is a row nobody can act on and a claim with no
   * identity cannot exist. The claim lands `legacy-unclaimed`: it says an
   * account existed, and grants nothing until somebody proves they hold it.
   */
  async importLegacyClaim(
    input: ImportLegacyClaimInput,
  ): Promise<{ readonly identity: PlayerIdentity; readonly claim: MinecraftClaim }> {
    return this.database.transaction(async (client: SqlClient) => {
      const identity = await client.query<IdentityRow>(
        `INSERT INTO player_identities (identity_id, created_by, created_at, updated_at)
         VALUES ($1, $2::jsonb, $3, $3)
         RETURNING ${IDENTITY_COLUMNS}`,
        [input.identityId, JSON.stringify(input.createdBy), input.now.toISOString()],
      );
      const claim = await client.query<ClaimRow>(
        `INSERT INTO player_minecraft_claims (
           claim_id, identity_id, server_instance_id, minecraft_uuid, status,
           reason_code, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'legacy-unclaimed', $5, $6, $6)
         RETURNING ${CLAIM_COLUMNS}`,
        [
          input.claimId,
          input.identityId,
          input.serverInstanceId,
          input.minecraftUuid,
          input.reasonCode,
          input.now.toISOString(),
        ],
      );
      const identityRow = identity.rows[0];
      const claimRow = claim.rows[0];
      if (identityRow === undefined || claimRow === undefined) {
        throw new PlayerIdentityPersistenceError('claim-not-found');
      }
      return { identity: mapIdentity(identityRow), claim: mapClaim(claimRow) };
    });
  }

  /**
   * Opens a claim on an account for an identity that has proven it.
   *
   * Refused by the database when the identity already holds an account on this
   * server, or when somebody else already holds this one. Both are the partial
   * unique indexes doing the deciding rather than a read this method took a
   * moment ago.
   */
  async openClaim(input: {
    readonly claimId: string;
    readonly identityId: string;
    readonly serverInstanceId: string;
    readonly minecraftUuid: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<MinecraftClaim> {
    try {
      const result = await this.database.query<ClaimRow>(
        `INSERT INTO player_minecraft_claims (
           claim_id, identity_id, server_instance_id, minecraft_uuid, status,
           claimed_at, reason_code, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $5, $5)
         RETURNING ${CLAIM_COLUMNS}`,
        [
          input.claimId,
          input.identityId,
          input.serverInstanceId,
          input.minecraftUuid,
          input.now.toISOString(),
          input.reasonCode,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new PlayerIdentityPersistenceError('claim-not-found');
      return mapClaim(row);
    } catch (error) {
      if (error instanceof PlayerIdentityPersistenceError) throw error;
      throw new PlayerIdentityPersistenceError('claim-conflict');
    }
  }

  /**
   * Proves a legacy claim, turning a record of an account into a held one.
   *
   * This is the re-claim the operators found in the audit must go through
   * before they recover anything. It moves only from `legacy-unclaimed`: a
   * revoked claim is not reopened by claiming it again, because the revocation
   * was a decision and quietly undoing it would erase that.
   */
  async proveLegacyClaim(input: ClaimIdentityInput): Promise<MinecraftClaim> {
    let result;
    try {
      result = await this.database.query<ClaimRow>(
        `UPDATE player_minecraft_claims
            SET status = 'active', claimed_at = $3, reason_code = $4, updated_at = $3
          WHERE claim_id = $1 AND identity_id = $2 AND status = 'legacy-unclaimed'
        RETURNING ${CLAIM_COLUMNS}`,
        [input.claimId, input.identityId, input.now.toISOString(), input.reasonCode],
      );
    } catch {
      throw new PlayerIdentityPersistenceError('claim-conflict');
    }
    const row = result.rows[0];
    if (row === undefined) throw new PlayerIdentityPersistenceError('invalid-transition');
    return mapClaim(row);
  }

  /**
   * Revokes a held claim.
   *
   * The last act of a rebind, and the reason the rebind is ordered the way it
   * is: until this runs, the previous account is still the authoritative one.
   */
  async revokeClaim(input: ClaimIdentityInput): Promise<MinecraftClaim> {
    const result = await this.database.query<ClaimRow>(
      `UPDATE player_minecraft_claims
          SET status = 'revoked', revoked_at = $3, reason_code = $4, updated_at = $3
        WHERE claim_id = $1 AND identity_id = $2 AND status = 'active'
      RETURNING ${CLAIM_COLUMNS}`,
      [input.claimId, input.identityId, input.now.toISOString(), input.reasonCode],
    );
    const row = result.rows[0];
    if (row === undefined) throw new PlayerIdentityPersistenceError('invalid-transition');
    return mapClaim(row);
  }

  /**
   * The account an identity holds right now, or nothing.
   *
   * This is what backs the Bridge's claim resolution. It answers from the
   * identity, and a legacy or revoked claim is not an answer: neither grants
   * anything, and returning one would hand an operation an account nobody has
   * proven they hold.
   */
  async findActiveClaim(input: {
    readonly identityId: string;
    readonly serverInstanceId: string;
  }): Promise<MinecraftClaim | undefined> {
    const result = await this.database.query<ClaimRow>(
      `SELECT ${CLAIM_COLUMNS} FROM player_minecraft_claims
        WHERE identity_id = $1 AND server_instance_id = $2 AND status = 'active'`,
      [input.identityId, input.serverInstanceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapClaim(row);
  }

  /**
   * One named claim, scoped to the identity that must own it.
   *
   * The scoping is the point. A rebind names its destination by id, and looking
   * that id up without checking whose it is would let a rebind move one
   * identity's permissions onto somebody else's account.
   */
  async findClaim(input: {
    readonly identityId: string;
    readonly claimId: string;
  }): Promise<MinecraftClaim | undefined> {
    const result = await this.database.query<ClaimRow>(
      `SELECT ${CLAIM_COLUMNS} FROM player_minecraft_claims
        WHERE claim_id = $1 AND identity_id = $2`,
      [input.claimId, input.identityId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapClaim(row);
  }

  async listClaims(identityId: string): Promise<readonly MinecraftClaim[]> {
    const result = await this.database.query<ClaimRow>(
      `SELECT ${CLAIM_COLUMNS} FROM player_minecraft_claims
        WHERE identity_id = $1 ORDER BY created_at, claim_id`,
      [identityId],
    );
    return result.rows.map(mapClaim);
  }

  /**
   * Records that a name was seen, without treating it as identification.
   *
   * Alias history belongs to the identity rather than to the account, because a
   * rebind moves the account and the history is what survives it. Nothing here
   * ever resolves an identity *from* a name; this table is a record of what was
   * observed, read only in that direction.
   */
  async observeAlias(input: {
    readonly identityId: string;
    readonly serverInstanceId: string;
    readonly name: string;
    readonly source: 'forge-bridge' | 'reviewed-import' | 'manual-review';
    readonly now: Date;
  }): Promise<void> {
    const normalized = input.name.normalize('NFC').toLocaleLowerCase('en-US');
    await this.database.query(
      `INSERT INTO player_aliases (
         identity_id, server_instance_id, normalized_name, name, source,
         first_observed_at, last_observed_at, observation_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $6, 1)
       ON CONFLICT (identity_id, server_instance_id, normalized_name) DO UPDATE
         SET last_observed_at = EXCLUDED.last_observed_at,
             name = EXCLUDED.name,
             observation_count = player_aliases.observation_count + 1`,
      [
        input.identityId,
        input.serverInstanceId,
        normalized,
        input.name,
        input.source,
        input.now.toISOString(),
      ],
    );
  }

  /** Moves the sighting window, which is all this slice records about presence. */
  async recordSighting(input: {
    readonly identityId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.database.query(
      `UPDATE player_identities
          SET first_seen_at = COALESCE(first_seen_at, $2),
              last_seen_at = $2,
              updated_at = $2,
              version = version + 1
        WHERE identity_id = $1`,
      [input.identityId, input.now.toISOString()],
    );
  }
}

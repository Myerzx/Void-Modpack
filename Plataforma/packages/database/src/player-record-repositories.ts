import {
  validateModerationCase,
  type ActorRef,
  type ModerationCase,
} from '@voidfall/contracts';

import type { Database } from './database.js';
import { PlayerIdentityPersistenceError } from './player-identity-repositories.js';

/**
 * Profiles and moderation cases, both about an identity.
 *
 * They share the rule the identity repository holds: a Minecraft UUID is never
 * a key. A case records the account, the name and the claim that were current
 * when the incident happened, and none of the three identifies whom it is
 * about — a punishment has to survive the rename that moves all three.
 *
 * There is no nullable legacy subject. No case has ever been persisted, and a
 * player without an authenticated identity does not get in; an authentication
 * attempt with nothing behind it belongs to the security domain, and a
 * nullable subject here would be an invitation to store one anyway.
 */

/** The profile row. Aliases live beside the identity, not on the profile. */
export interface PlayerProfileRecord {
  readonly identityId: string;
  readonly serverInstanceId: string;
  readonly revision: number;
  readonly status: 'active' | 'retired' | 'erasure-pending';
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProfileRow {
  readonly identity_id: string;
  readonly server_instance_id: string;
  readonly revision: string | number;
  readonly status: PlayerProfileRecord['status'];
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface CaseRow {
  readonly case_id: string;
  readonly subject_identity_id: string;
  readonly server_instance_id: string;
  readonly context_claim_id: string;
  readonly context_minecraft_uuid: string;
  readonly context_minecraft_name: string;
  readonly revision: string | number;
  readonly action: ModerationCase['action'];
  readonly status: ModerationCase['status'];
  readonly reason_code: string;
  readonly reason: string;
  readonly requested_by: ActorRef | string;
  readonly requested_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly transition_kind: NonNullable<ModerationCase['transition']>['kind'] | null;
  readonly transition_occurred_at: Date | string | null;
  readonly transition_executor_id: string | null;
  readonly transition_receipt_id: string | null;
  readonly transition_error_code: string | null;
}

const PROFILE_COLUMNS = 'identity_id, server_instance_id, revision, status, created_at, updated_at';

const CASE_COLUMNS = `case_id, subject_identity_id, server_instance_id, context_claim_id,
  context_minecraft_uuid, context_minecraft_name, revision, action, status, reason_code,
  reason, requested_by, requested_at, expires_at, updated_at, transition_kind,
  transition_occurred_at, transition_executor_id, transition_receipt_id, transition_error_code`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProfile(row: ProfileRow): PlayerProfileRecord {
  return Object.freeze({
    identityId: row.identity_id,
    serverInstanceId: row.server_instance_id,
    revision: Number(row.revision),
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapCase(row: CaseRow): ModerationCase {
  const expiresAt = row.expires_at === null ? null : iso(row.expires_at);
  const moderationCase: ModerationCase = {
    schemaVersion: 1,
    caseId: row.case_id,
    subjectIdentityId: row.subject_identity_id,
    incidentContext: {
      claimId: row.context_claim_id,
      minecraftUuid: row.context_minecraft_uuid,
      minecraftName: row.context_minecraft_name,
    },
    serverInstanceId: row.server_instance_id,
    revision: Number(row.revision),
    action: row.action,
    status: row.status,
    reasonCode: row.reason_code,
    reason: row.reason,
    requestedBy:
      typeof row.requested_by === 'string'
        ? (JSON.parse(row.requested_by) as ActorRef)
        : row.requested_by,
    requestedAt: iso(row.requested_at),
    ...(expiresAt === null ? {} : { expiresAt }),
    updatedAt: iso(row.updated_at),
    ...(row.transition_kind === null || row.transition_occurred_at === null
      ? {}
      : {
          transition: {
            kind: row.transition_kind,
            occurredAt: iso(row.transition_occurred_at),
            ...(row.transition_executor_id === null
              ? {}
              : { executorId: row.transition_executor_id }),
            ...(row.transition_receipt_id === null
              ? {}
              : { receiptId: row.transition_receipt_id }),
            ...(row.transition_error_code === null
              ? {}
              : { errorCode: row.transition_error_code }),
          },
        }),
  };
  // Storage constraints and the contract state the same invariants. A row that
  // satisfied one but not the other is a defect, not a value to publish.
  const validated = validateModerationCase(moderationCase);
  if (!validated.success) throw new PlayerIdentityPersistenceError('invalid-record');
  return validated.value;
}

export class PlayerRecordRepository {
  public constructor(private readonly database: Database) {}

  /** Creates the profile on first sighting, and returns it either way. */
  async ensureProfile(input: {
    readonly identityId: string;
    readonly serverInstanceId: string;
    readonly now: Date;
  }): Promise<PlayerProfileRecord> {
    const result = await this.database.query<ProfileRow>(
      `INSERT INTO player_profiles (identity_id, server_instance_id, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (server_instance_id, identity_id)
         DO UPDATE SET updated_at = player_profiles.updated_at
       RETURNING ${PROFILE_COLUMNS}`,
      [input.identityId, input.serverInstanceId, input.now.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new PlayerIdentityPersistenceError('identity-not-found');
    return mapProfile(row);
  }

  async findProfile(input: {
    readonly identityId: string;
    readonly serverInstanceId: string;
  }): Promise<PlayerProfileRecord | undefined> {
    const result = await this.database.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM player_profiles
        WHERE identity_id = $1 AND server_instance_id = $2`,
      [input.identityId, input.serverInstanceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapProfile(row);
  }

  /**
   * Opens a case against an identity.
   *
   * The context is copied in rather than referenced. A case has to stay
   * readable after the claim it names has been revoked and its row is gone,
   * which is exactly when somebody is most likely to be reading it.
   */
  async openCase(input: {
    readonly caseId: string;
    readonly subjectIdentityId: string;
    readonly serverInstanceId: string;
    readonly incidentContext: ModerationCase['incidentContext'];
    readonly action: ModerationCase['action'];
    readonly reasonCode: string;
    readonly reason: string;
    readonly requestedBy: ActorRef;
    readonly expiresAt: Date | null;
    readonly now: Date;
  }): Promise<ModerationCase> {
    let result;
    try {
      result = await this.database.query<CaseRow>(
        `INSERT INTO moderation_cases (
           case_id, subject_identity_id, server_instance_id, context_claim_id,
           context_minecraft_uuid, context_minecraft_name, action, status, reason_code,
           reason, requested_by, requested_at, expires_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'requested',$8,$9,$10::jsonb,$11,$12,$11)
         RETURNING ${CASE_COLUMNS}`,
        [
          input.caseId,
          input.subjectIdentityId,
          input.serverInstanceId,
          input.incidentContext.claimId,
          input.incidentContext.minecraftUuid,
          input.incidentContext.minecraftName,
          input.action,
          input.reasonCode,
          input.reason,
          JSON.stringify(input.requestedBy),
          input.now.toISOString(),
          input.expiresAt === null ? null : input.expiresAt.toISOString(),
        ],
      );
    } catch {
      // The action/expiry constraint, a duplicate case id, or a subject that
      // does not exist. All three are the request being wrong, not the store.
      throw new PlayerIdentityPersistenceError('invalid-transition');
    }
    const row = result.rows[0];
    if (row === undefined) throw new PlayerIdentityPersistenceError('invalid-transition');
    return mapCase(row);
  }

  /**
   * Settles a case, against the revision it was read at, with its evidence.
   *
   * The transition is not optional. A case that says it was applied without
   * naming who applied it and against what receipt is an assertion nobody can
   * check, which is the opposite of what a moderation record is for — so the
   * database refuses it as well as the contract.
   */
  async settleCase(input: {
    readonly caseId: string;
    readonly expectedRevision: number;
    readonly status: Exclude<ModerationCase['status'], 'requested'>;
    readonly transition: NonNullable<ModerationCase['transition']>;
    readonly now: Date;
  }): Promise<ModerationCase> {
    let result;
    try {
      result = await this.database.query<CaseRow>(
        `UPDATE moderation_cases
            SET status = $3, revision = revision + 1, updated_at = $4,
                transition_kind = $3, transition_occurred_at = $5,
                transition_executor_id = $6, transition_receipt_id = $7,
                transition_error_code = $8
          WHERE case_id = $1 AND revision = $2
        RETURNING ${CASE_COLUMNS}`,
        [
          input.caseId,
          input.expectedRevision,
          input.status,
          input.now.toISOString(),
          input.transition.occurredAt,
          input.transition.executorId ?? null,
          input.transition.receiptId ?? null,
          input.transition.errorCode ?? null,
        ],
      );
    } catch {
      throw new PlayerIdentityPersistenceError('invalid-transition');
    }
    const row = result.rows[0];
    if (row === undefined) throw new PlayerIdentityPersistenceError('invalid-transition');
    return mapCase(row);
  }

  /**
   * The cases against one identity, newest first.
   *
   * Answers from the identity, so a rename cannot hide a history: the account
   * in the context changed, the subject did not.
   */
  async listCasesForSubject(input: {
    readonly subjectIdentityId: string;
    readonly limit?: number;
  }): Promise<readonly ModerationCase[]> {
    const result = await this.database.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM moderation_cases
        WHERE subject_identity_id = $1
        ORDER BY requested_at DESC, case_id
        LIMIT $2`,
      [input.subjectIdentityId, Math.min(Math.max(input.limit ?? 50, 1), 200)],
    );
    return result.rows.map(mapCase);
  }
}

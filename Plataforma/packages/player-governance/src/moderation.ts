import { validateModerationCase, type ModerationCase } from '@voidfall/contracts';
import {
  assertOptions,
  assertActor,
  assertReason,
  assertUuid,
  canonicalTimestamp,
  fingerprint,
  immutable,
  ReplayLedger,
  SLUG,
} from './common.js';
import {
  PlayerGovernanceError,
  type ExecuteModerationPlan,
  type GovernanceRegistryOptions,
  type ModerationExecutionDecision,
  type ModerationExecutionReceipt,
  type ModerationExecutor,
  type RequestModerationCasePlan,
  type RevokeModerationPlan,
} from './types.js';

function requiresExpiry(action: ModerationCase['action']): boolean {
  return action === 'mute' || action === 'temporary-ban';
}

export class ModerationCaseRegistry {
  readonly #options: GovernanceRegistryOptions;
  readonly #executor: ModerationExecutor | undefined;
  readonly #cases = new Map<string, ModerationCase>();
  readonly #replays: ReplayLedger<ModerationCase>;

  public constructor(options: GovernanceRegistryOptions, executor?: ModerationExecutor) {
    assertOptions(options);
    if (executor !== undefined && (!SLUG.test(executor.executorId) || executor.executorId.length > 64)) {
      throw new PlayerGovernanceError('invalid-operation');
    }
    this.#options = immutable(options);
    this.#executor = executor;
    this.#replays = new ReplayLedger(options.maximumReplays);
  }

  public request(plan: RequestModerationCasePlan): ModerationCase {
    const operationFingerprint = fingerprint(plan);
    const replay = this.#replays.replay(plan.operationId, operationFingerprint);
    if (replay !== undefined) return replay;
    assertUuid(plan.caseId);
    assertUuid(plan.subjectIdentityId);
    assertUuid(plan.incidentContext.claimId);
    assertUuid(plan.incidentContext.minecraftUuid);
    assertUuid(plan.serverInstanceId);
    assertActor(plan.requestedBy);
    assertReason(plan.reason);
    if (!SLUG.test(plan.reasonCode)) throw new PlayerGovernanceError('invalid-operation');
    const requestedAt = canonicalTimestamp(plan.requestedAt);
    const expiresAt = plan.expiresAt === undefined ? undefined : canonicalTimestamp(plan.expiresAt);
    if (requiresExpiry(plan.action) !== (expiresAt !== undefined)) {
      throw new PlayerGovernanceError('invalid-operation');
    }
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(requestedAt)) {
      throw new PlayerGovernanceError('invalid-timestamp');
    }
    if (this.#cases.has(plan.caseId)) throw new PlayerGovernanceError('operation-conflict');
    if (this.#cases.size >= this.#options.maximumRecords) {
      throw new PlayerGovernanceError('case-limit-exceeded');
    }
    const moderationCase: ModerationCase = {
      schemaVersion: 1,
      caseId: plan.caseId,
      subjectIdentityId: plan.subjectIdentityId,
      incidentContext: {
        claimId: plan.incidentContext.claimId,
        minecraftUuid: plan.incidentContext.minecraftUuid,
        minecraftName: plan.incidentContext.minecraftName,
      },
      serverInstanceId: plan.serverInstanceId,
      revision: 1,
      action: plan.action,
      status: 'requested',
      reasonCode: plan.reasonCode,
      reason: plan.reason,
      requestedBy: plan.requestedBy,
      requestedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      updatedAt: requestedAt,
    };
    return this.#store(plan.operationId, operationFingerprint, moderationCase);
  }

  public async execute(plan: ExecuteModerationPlan): Promise<ModerationExecutionDecision> {
    const operationFingerprint = fingerprint(plan);
    const replay = this.#replays.replay(plan.operationId, operationFingerprint);
    if (replay !== undefined) {
      return {
        attempted: true,
        reason: replay.status === 'applied' ? 'applied' : 'executor-rejected',
        moderationCase: replay,
      };
    }
    assertUuid(plan.caseId);
    const attemptedAt = canonicalTimestamp(plan.attemptedAt);
    const current = this.#cases.get(plan.caseId);
    if (current === undefined) throw new PlayerGovernanceError('case-not-found');
    if (current.revision !== plan.expectedRevision) throw new PlayerGovernanceError('revision-conflict');
    if (current.status !== 'requested') throw new PlayerGovernanceError('case-not-actionable');
    if (this.#executor === undefined) {
      return { attempted: false, reason: 'executor-unavailable', moderationCase: immutable(current) };
    }

    let receipt: ModerationExecutionReceipt;
    try {
      receipt = await this.#executor.apply({
        caseId: current.caseId,
        caseRevision: current.revision,
        subjectIdentityId: current.subjectIdentityId,
        serverInstanceId: current.serverInstanceId,
        action: current.action,
        reasonCode: current.reasonCode,
        reason: current.reason,
        ...(current.expiresAt === undefined ? {} : { expiresAt: current.expiresAt }),
      });
    } catch {
      return { attempted: false, reason: 'executor-failed', moderationCase: immutable(current) };
    }
    if (!this.#validReceipt(current, attemptedAt, receipt)) {
      return {
        attempted: false,
        reason: 'invalid-executor-receipt',
        moderationCase: immutable(current),
      };
    }
    const updated: ModerationCase = {
      ...current,
      revision: current.revision + 1,
      status: receipt.outcome === 'succeeded' ? 'applied' : 'failed',
      updatedAt: receipt.attemptedAt,
      transition: {
        kind: receipt.outcome === 'succeeded' ? 'applied' : 'failed',
        occurredAt: receipt.attemptedAt,
        executorId: receipt.executorId,
        receiptId: receipt.receiptId,
        ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
      },
    };
    const stored = this.#store(plan.operationId, operationFingerprint, updated);
    return {
      attempted: true,
      reason: receipt.outcome === 'succeeded' ? 'applied' : 'executor-rejected',
      moderationCase: stored,
    };
  }

  public revoke(plan: RevokeModerationPlan): ModerationCase {
    const operationFingerprint = fingerprint(plan);
    const replay = this.#replays.replay(plan.operationId, operationFingerprint);
    if (replay !== undefined) return replay;
    assertUuid(plan.caseId);
    assertActor(plan.actor);
    assertReason(plan.reason);
    const revokedAt = canonicalTimestamp(plan.revokedAt);
    const current = this.#cases.get(plan.caseId);
    if (current === undefined) throw new PlayerGovernanceError('case-not-found');
    if (current.revision !== plan.expectedRevision) throw new PlayerGovernanceError('revision-conflict');
    if (
      current.status !== 'applied' ||
      current.action === 'warning' ||
      current.action === 'kick'
    ) {
      throw new PlayerGovernanceError('case-not-actionable');
    }
    if (Date.parse(revokedAt) < Date.parse(current.updatedAt)) {
      throw new PlayerGovernanceError('invalid-timestamp');
    }
    const revoked: ModerationCase = {
      ...current,
      revision: current.revision + 1,
      status: 'revoked',
      updatedAt: revokedAt,
      transition: { kind: 'revoked', occurredAt: revokedAt },
    };
    return this.#store(plan.operationId, operationFingerprint, revoked);
  }

  public expire(caseId: string, expectedRevision: number, now: string): ModerationCase {
    assertUuid(caseId);
    const occurredAt = canonicalTimestamp(now);
    const current = this.#cases.get(caseId);
    if (current === undefined) throw new PlayerGovernanceError('case-not-found');
    if (current.revision !== expectedRevision) throw new PlayerGovernanceError('revision-conflict');
    if (
      current.status !== 'applied' ||
      current.expiresAt === undefined ||
      Date.parse(occurredAt) < Date.parse(current.expiresAt)
    ) {
      throw new PlayerGovernanceError('case-not-actionable');
    }
    const expired: ModerationCase = {
      ...current,
      revision: current.revision + 1,
      status: 'expired',
      updatedAt: occurredAt,
      transition: { kind: 'expired', occurredAt },
    };
    return this.#store(caseId, fingerprint({ caseId, expectedRevision, occurredAt }), expired, false);
  }

  public find(caseId: string): ModerationCase | undefined {
    assertUuid(caseId);
    const moderationCase = this.#cases.get(caseId);
    return moderationCase === undefined ? undefined : immutable(moderationCase);
  }

  #validReceipt(
    moderationCase: ModerationCase,
    requestedAttemptedAt: string,
    receipt: ModerationExecutionReceipt,
  ): boolean {
    try {
      return (
        this.#executor !== undefined &&
        receipt.executorId === this.#executor.executorId &&
        receipt.caseId === moderationCase.caseId &&
        receipt.caseRevision === moderationCase.revision &&
        canonicalTimestamp(receipt.attemptedAt) === requestedAttemptedAt &&
        receipt.receiptId.length >= 1 &&
        receipt.receiptId.length <= 128 &&
        ((receipt.outcome === 'succeeded' && receipt.errorCode === undefined) ||
          (receipt.outcome === 'failed' &&
            receipt.errorCode !== undefined &&
            SLUG.test(receipt.errorCode)))
      );
    } catch {
      return false;
    }
  }

  #store(
    operationId: string,
    operationFingerprint: string,
    moderationCase: ModerationCase,
    remember = true,
  ): ModerationCase {
    const validation = validateModerationCase(moderationCase);
    if (!validation.success) throw new PlayerGovernanceError('invalid-moderation-transition');
    const stored = immutable(validation.value);
    if (remember) this.#replays.remember(operationId, operationFingerprint, stored);
    this.#cases.set(stored.caseId, stored);
    return immutable(stored);
  }
}

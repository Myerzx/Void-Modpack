import { validatePlayerDataPolicy, type PlayerDataPolicy } from '@voidfall/contracts';
import { canonicalTimestamp, immutable, SLUG } from './common.js';
import {
  PlayerGovernanceError,
  type PlayerDataDecision,
  type PlayerDataDecisionRequest,
} from './types.js';

export class PlayerDataPolicyEngine {
  readonly #policy: PlayerDataPolicy | undefined;

  public constructor(policy?: PlayerDataPolicy) {
    if (policy === undefined) {
      this.#policy = undefined;
      return;
    }
    const validation = validatePlayerDataPolicy(policy);
    if (!validation.success) throw new PlayerGovernanceError('invalid-operation');
    this.#policy = immutable(validation.value);
  }

  public decide(request: PlayerDataDecisionRequest): PlayerDataDecision {
    if (
      !['collect', 'view', 'export'].includes(request.operation) ||
      !['activity', 'chat', 'coordinates'].includes(request.category) ||
      !SLUG.test(request.purposeCode)
    ) {
      throw new PlayerGovernanceError('invalid-operation');
    }
    const evaluatedAt = canonicalTimestamp(request.evaluatedAt);
    const policy = this.#policy;
    if (policy === undefined || policy.status !== 'approved') {
      return { allowed: false, reason: 'policy-unavailable' };
    }
    if (policy.effectiveAt === undefined || Date.parse(evaluatedAt) < Date.parse(policy.effectiveAt)) {
      return this.#deny('policy-not-effective', policy);
    }
    if (request.purposeCode !== policy.purposeCode) {
      return this.#deny('purpose-mismatch', policy);
    }
    const rule = policy.rules.find((candidate) => candidate.category === request.category);
    if (rule === undefined || rule.collection !== 'allowed' || rule.maximumRetentionSeconds === undefined) {
      return this.#deny('collection-disabled', policy);
    }

    if (request.operation === 'collect') {
      if (request.observedAt === undefined || request.retentionExpiresAt !== undefined) {
        return this.#deny('invalid-record-window', policy);
      }
      const observedAt = canonicalTimestamp(request.observedAt);
      if (Date.parse(observedAt) > Date.parse(evaluatedAt)) {
        return this.#deny('invalid-record-window', policy);
      }
      const retentionExpiresAt = new Date(
        Date.parse(observedAt) + rule.maximumRetentionSeconds * 1_000,
      ).toISOString();
      return {
        allowed: true,
        reason: 'allowed',
        policyId: policy.policyId,
        policyRevision: policy.revision,
        retentionExpiresAt,
      };
    }

    if (request.observedAt === undefined || request.retentionExpiresAt === undefined) {
      return this.#deny('invalid-record-window', policy);
    }
    const observedAt = canonicalTimestamp(request.observedAt);
    const retentionExpiresAt = canonicalTimestamp(request.retentionExpiresAt);
    const maximumExpiry = Date.parse(observedAt) + rule.maximumRetentionSeconds * 1_000;
    if (
      Date.parse(retentionExpiresAt) <= Date.parse(observedAt) ||
      Date.parse(retentionExpiresAt) > maximumExpiry
    ) {
      return this.#deny('invalid-record-window', policy);
    }
    if (Date.parse(evaluatedAt) >= Date.parse(retentionExpiresAt)) {
      return this.#deny('retention-expired', policy);
    }
    if (!(request.grantedPanelPermissions ?? []).includes(rule.viewPermission)) {
      return this.#deny('permission-denied', policy);
    }
    if (request.operation === 'export' && rule.export !== 'allowed') {
      return this.#deny('export-disabled', policy);
    }
    return {
      allowed: true,
      reason: 'allowed',
      policyId: policy.policyId,
      policyRevision: policy.revision,
      retentionExpiresAt,
    };
  }

  #deny(reason: Exclude<PlayerDataDecision['reason'], 'allowed'>, policy: PlayerDataPolicy): PlayerDataDecision {
    return {
      allowed: false,
      reason,
      policyId: policy.policyId,
      policyRevision: policy.revision,
    };
  }
}

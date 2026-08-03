import {
  validateMinecraftPermissionBinding,
  type MinecraftPermissionBinding,
} from '@voidfall/contracts';
import {
  assertOptions,
  assertActor,
  assertReason,
  assertUuid,
  canonicalTimestamp,
  compareOrdinal,
  fingerprint,
  IDENTIFIER,
  immutable,
  PERMISSION_NODE,
  ReplayLedger,
  SLUG,
} from './common.js';
import {
  PlayerGovernanceError,
  type GovernanceRegistryOptions,
  type MinecraftGroupProviderReceipt,
  type MinecraftGroupSynchronizationRequest,
  type MinecraftPermissionCheckReceipt,
  type MinecraftPermissionCheckRequest,
  type MinecraftPermissionDecision,
  type MinecraftPermissionProvider,
  type MinecraftSynchronizationDecision,
  type RevokeMinecraftGroupsPlan,
  type SetMinecraftGroupsPlan,
} from './types.js';

function bindingKey(playerUuid: string, serverInstanceId: string): string {
  return `${serverInstanceId}:${playerUuid}`;
}

function validSafeCode(value: string | undefined): boolean {
  return value !== undefined && SLUG.test(value) && value.length <= 64;
}

export class MinecraftPermissionRegistry {
  readonly #options: GovernanceRegistryOptions;
  readonly #provider: MinecraftPermissionProvider | undefined;
  readonly #bindings = new Map<string, MinecraftPermissionBinding>();
  readonly #bindingIds = new Map<string, string>();
  readonly #replays: ReplayLedger<MinecraftPermissionBinding>;

  public constructor(
    options: GovernanceRegistryOptions,
    provider?: MinecraftPermissionProvider,
  ) {
    assertOptions(options);
    if (provider !== undefined && (!SLUG.test(provider.providerId) || provider.providerId.length > 64)) {
      throw new PlayerGovernanceError('invalid-provider');
    }
    this.#options = immutable(options);
    this.#provider = provider;
    this.#replays = new ReplayLedger(options.maximumReplays);
  }

  public setGroups(plan: SetMinecraftGroupsPlan): MinecraftPermissionBinding {
    const operationFingerprint = fingerprint(plan);
    const replay = this.#replays.replay(plan.operationId, operationFingerprint);
    if (replay !== undefined) return replay;
    assertUuid(plan.bindingId);
    assertUuid(plan.playerUuid);
    assertUuid(plan.serverInstanceId);
    assertActor(plan.requestedBy);
    assertReason(plan.reason);
    const requestedAt = canonicalTimestamp(plan.requestedAt);
    const groups = [...new Set(plan.groups)].sort(compareOrdinal);
    if (
      groups.length !== plan.groups.length ||
      groups.length < 1 ||
      groups.length > 32 ||
      !groups.includes('player') ||
      groups.some((group) => group.length < 2 || group.length > 64 || !IDENTIFIER.test(group))
    ) {
      throw new PlayerGovernanceError('invalid-groups');
    }

    const key = bindingKey(plan.playerUuid, plan.serverInstanceId);
    const current = this.#bindings.get(key);
    if (current === undefined) {
      if (plan.expectedRevision !== null) throw new PlayerGovernanceError('revision-conflict');
      if (this.#bindings.size >= this.#options.maximumRecords) {
        throw new PlayerGovernanceError('binding-limit-exceeded');
      }
      if (this.#bindingIds.has(plan.bindingId)) throw new PlayerGovernanceError('operation-conflict');
    } else {
      if (current.bindingId !== plan.bindingId) throw new PlayerGovernanceError('operation-conflict');
      if (current.revision !== plan.expectedRevision) {
        throw new PlayerGovernanceError('revision-conflict');
      }
      if (Date.parse(requestedAt) < Date.parse(current.updatedAt)) {
        throw new PlayerGovernanceError('invalid-timestamp');
      }
    }

    const binding: MinecraftPermissionBinding = {
      schemaVersion: 1,
      bindingId: plan.bindingId,
      playerUuid: plan.playerUuid,
      serverInstanceId: plan.serverInstanceId,
      revision: current === undefined ? 1 : current.revision + 1,
      status: 'pending',
      groups,
      requestedBy: plan.requestedBy,
      reason: plan.reason,
      requestedAt,
      updatedAt: requestedAt,
    };
    return this.#store(key, plan.operationId, operationFingerprint, binding);
  }

  public revoke(plan: RevokeMinecraftGroupsPlan): MinecraftPermissionBinding {
    const operationFingerprint = fingerprint(plan);
    const replay = this.#replays.replay(plan.operationId, operationFingerprint);
    if (replay !== undefined) return replay;
    assertUuid(plan.bindingId);
    assertActor(plan.requestedBy);
    assertReason(plan.reason);
    const requestedAt = canonicalTimestamp(plan.requestedAt);
    const key = this.#bindingIds.get(plan.bindingId);
    if (key === undefined) throw new PlayerGovernanceError('binding-not-found');
    const current = this.#bindings.get(key);
    if (current === undefined) throw new PlayerGovernanceError('binding-not-found');
    if (current.revision !== plan.expectedRevision) {
      throw new PlayerGovernanceError('revision-conflict');
    }
    if (current.status === 'revoked') throw new PlayerGovernanceError('invalid-operation');
    if (Date.parse(requestedAt) < Date.parse(current.updatedAt)) {
      throw new PlayerGovernanceError('invalid-timestamp');
    }
    const { synchronization: _synchronization, ...currentWithoutSynchronization } = current;
    const revoked: MinecraftPermissionBinding = {
      ...currentWithoutSynchronization,
      revision: current.revision + 1,
      status: 'revoked',
      groups: [],
      requestedBy: plan.requestedBy,
      reason: plan.reason,
      requestedAt,
      updatedAt: requestedAt,
    };
    return this.#store(key, plan.operationId, operationFingerprint, revoked);
  }

  public async synchronize(
    request: MinecraftGroupSynchronizationRequest,
  ): Promise<MinecraftSynchronizationDecision> {
    const operationFingerprint = fingerprint(request);
    const replay = this.#replays.replay(request.operationId, operationFingerprint);
    if (replay !== undefined) {
      return {
        attempted: true,
        reason: replay.status === 'synchronized' ? 'synchronized' : 'provider-rejected',
        binding: replay,
      };
    }
    assertUuid(request.bindingId);
    const attemptedAt = canonicalTimestamp(request.attemptedAt);
    const key = this.#bindingIds.get(request.bindingId);
    if (key === undefined) throw new PlayerGovernanceError('binding-not-found');
    const current = this.#bindings.get(key);
    if (current === undefined) throw new PlayerGovernanceError('binding-not-found');
    if (current.revision !== request.expectedRevision) {
      throw new PlayerGovernanceError('revision-conflict');
    }
    if (current.status !== 'pending') throw new PlayerGovernanceError('invalid-operation');
    if (this.#provider === undefined) {
      return { attempted: false, reason: 'provider-unavailable', binding: immutable(current) };
    }

    let receipt: MinecraftGroupProviderReceipt;
    try {
      receipt = await this.#provider.synchronizeGroups({
        bindingId: current.bindingId,
        bindingRevision: current.revision,
        playerUuid: current.playerUuid,
        serverInstanceId: current.serverInstanceId,
        groups: current.groups,
      });
    } catch {
      return { attempted: false, reason: 'provider-failed', binding: immutable(current) };
    }
    if (!this.#validGroupReceipt(current, attemptedAt, receipt)) {
      return { attempted: false, reason: 'invalid-provider-receipt', binding: immutable(current) };
    }

    const updated: MinecraftPermissionBinding = {
      ...current,
      revision: current.revision + 1,
      status: receipt.outcome === 'succeeded' ? 'synchronized' : 'failed',
      updatedAt: receipt.attemptedAt,
      synchronization: {
        providerId: receipt.providerId,
        outcome: receipt.outcome,
        attemptedAt: receipt.attemptedAt,
        receiptId: receipt.receiptId,
        ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
      },
    };
    const stored = this.#store(
      key,
      request.operationId,
      operationFingerprint,
      updated,
    );
    return {
      attempted: true,
      reason: receipt.outcome === 'succeeded' ? 'synchronized' : 'provider-rejected',
      binding: stored,
    };
  }

  public async checkPermission(
    request: MinecraftPermissionCheckRequest,
  ): Promise<MinecraftPermissionDecision> {
    assertUuid(request.playerUuid);
    assertUuid(request.serverInstanceId);
    canonicalTimestamp(request.checkedAt);
    if (request.permissionNode.length > 128 || !PERMISSION_NODE.test(request.permissionNode)) {
      throw new PlayerGovernanceError('invalid-permission-node');
    }
    if (this.#provider === undefined) return { allowed: false, reason: 'provider-unavailable' };

    let receipt: MinecraftPermissionCheckReceipt;
    try {
      receipt = await this.#provider.checkPermission(request);
    } catch {
      return { allowed: false, reason: 'provider-failed' };
    }
    if (!this.#validPermissionReceipt(request, receipt)) {
      return { allowed: false, reason: 'invalid-provider-receipt' };
    }
    return {
      allowed: receipt.allowed,
      reason: receipt.allowed ? 'allowed' : 'denied',
      providerId: receipt.providerId,
      receiptId: receipt.receiptId,
    };
  }

  public find(bindingId: string): MinecraftPermissionBinding | undefined {
    assertUuid(bindingId);
    const key = this.#bindingIds.get(bindingId);
    const binding = key === undefined ? undefined : this.#bindings.get(key);
    return binding === undefined ? undefined : immutable(binding);
  }

  #validGroupReceipt(
    binding: MinecraftPermissionBinding,
    requestedAttemptedAt: string,
    receipt: MinecraftGroupProviderReceipt,
  ): boolean {
    try {
      return (
        this.#provider !== undefined &&
        receipt.providerId === this.#provider.providerId &&
        receipt.bindingId === binding.bindingId &&
        receipt.bindingRevision === binding.revision &&
        receipt.playerUuid === binding.playerUuid &&
        receipt.serverInstanceId === binding.serverInstanceId &&
        canonicalTimestamp(receipt.attemptedAt) === requestedAttemptedAt &&
        receipt.receiptId.length >= 1 &&
        receipt.receiptId.length <= 128 &&
        ((receipt.outcome === 'succeeded' && receipt.errorCode === undefined) ||
          (receipt.outcome === 'failed' && validSafeCode(receipt.errorCode)))
      );
    } catch {
      return false;
    }
  }

  #validPermissionReceipt(
    request: MinecraftPermissionCheckRequest,
    receipt: MinecraftPermissionCheckReceipt,
  ): boolean {
    try {
      return (
        this.#provider !== undefined &&
        receipt.providerId === this.#provider.providerId &&
        receipt.playerUuid === request.playerUuid &&
        receipt.serverInstanceId === request.serverInstanceId &&
        receipt.permissionNode === request.permissionNode &&
        canonicalTimestamp(receipt.checkedAt) === canonicalTimestamp(request.checkedAt) &&
        receipt.receiptId.length >= 1 &&
        receipt.receiptId.length <= 128
      );
    } catch {
      return false;
    }
  }

  #store(
    key: string,
    operationId: string,
    operationFingerprint: string,
    binding: MinecraftPermissionBinding,
  ): MinecraftPermissionBinding {
    const validation = validateMinecraftPermissionBinding(binding);
    if (!validation.success) throw new PlayerGovernanceError('invalid-operation');
    const stored = immutable(validation.value);
    this.#replays.remember(operationId, operationFingerprint, stored);
    this.#bindings.set(key, stored);
    this.#bindingIds.set(stored.bindingId, key);
    return immutable(stored);
  }
}

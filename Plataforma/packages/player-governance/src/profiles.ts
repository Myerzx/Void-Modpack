import { validatePlayerProfile, type PlayerProfile } from '@voidfall/contracts';
import {
  assertOptions,
  assertActor,
  assertReason,
  assertUuid,
  canonicalTimestamp,
  compareOrdinal,
  fingerprint,
  immutable,
  ReplayLedger,
} from './common.js';
import {
  PlayerGovernanceError,
  type ChangePlayerProfileStatusPlan,
  type ObservePlayerAliasPlan,
  type PlayerProfileRegistryOptions,
} from './types.js';

/**
 * A profile is unique per server and identity, so the key is the pair.
 *
 * Keyed on the identity rather than the account: a Minecraft UUID is derived
 * from the name in offline mode, so a profile keyed on it would be lost the
 * moment somebody renamed.
 */
function profileKey(identityId: string, serverInstanceId: string): string {
  return `${serverInstanceId}:${identityId}`;
}

const MINECRAFT_ALIAS = /^[A-Za-z0-9_]{3,16}$/u;

export class PlayerProfileRegistry {
  readonly #options: PlayerProfileRegistryOptions;
  readonly #profiles = new Map<string, PlayerProfile>();
  readonly #replays: ReplayLedger<PlayerProfile>;

  public constructor(options: PlayerProfileRegistryOptions) {
    assertOptions(options);
    if (
      !Number.isSafeInteger(options.maximumAliasesPerProfile) ||
      options.maximumAliasesPerProfile < 1 ||
      options.maximumAliasesPerProfile > 64
    ) {
      throw new PlayerGovernanceError('invalid-options');
    }
    this.#options = immutable(options);
    this.#replays = new ReplayLedger(options.maximumReplays);
  }

  public observeAlias(plan: ObservePlayerAliasPlan): PlayerProfile {
    const operationFingerprint = fingerprint(plan);
    const replay = this.#replays.replay(plan.operationId, operationFingerprint);
    if (replay !== undefined) return replay;

    assertUuid(plan.identityId);
    assertUuid(plan.serverInstanceId);
    if (!MINECRAFT_ALIAS.test(plan.alias)) throw new PlayerGovernanceError('invalid-alias');
    const observedAt = canonicalTimestamp(plan.observedAt);
    const normalizedName = plan.alias.toLocaleLowerCase('en-US');
    const current = this.#profiles.get(profileKey(plan.identityId, plan.serverInstanceId));

    if (current === undefined) {
      if (plan.expectedRevision !== null) throw new PlayerGovernanceError('revision-conflict');
      if (this.#profiles.size >= this.#options.maximumRecords) {
        throw new PlayerGovernanceError('profile-limit-exceeded');
      }
      const created: PlayerProfile = {
        schemaVersion: 1,
        identityId: plan.identityId,
        serverInstanceId: plan.serverInstanceId,
        revision: 1,
        status: 'active',
        createdAt: observedAt,
        updatedAt: observedAt,
        aliases: [
          {
            name: plan.alias,
            normalizedName,
            source: plan.source,
            serverInstanceId: plan.serverInstanceId,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
            observationCount: 1,
          },
        ],
      };
      return this.#store(plan.operationId, operationFingerprint, created);
    }

    if (current.status !== 'active') throw new PlayerGovernanceError('profile-not-active');
    if (plan.expectedRevision !== current.revision) {
      throw new PlayerGovernanceError('revision-conflict');
    }
    const aliases = current.aliases.map((alias) => ({ ...alias }));
    const index = aliases.findIndex((alias) => alias.normalizedName === normalizedName);
    if (index === -1) {
      if (aliases.length >= this.#options.maximumAliasesPerProfile) {
        throw new PlayerGovernanceError('alias-limit-exceeded');
      }
      aliases.push({
        name: plan.alias,
        normalizedName,
        source: plan.source,
        serverInstanceId: plan.serverInstanceId,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        observationCount: 1,
      });
    } else {
      const existing = aliases[index];
      if (existing === undefined) throw new PlayerGovernanceError('invalid-operation');
      if (Date.parse(observedAt) < Date.parse(existing.firstObservedAt)) {
        throw new PlayerGovernanceError('invalid-timestamp');
      }
      aliases[index] = {
        ...existing,
        name: plan.alias,
        lastObservedAt:
          Date.parse(observedAt) > Date.parse(existing.lastObservedAt)
            ? observedAt
            : existing.lastObservedAt,
        observationCount: existing.observationCount + 1,
      };
    }
    aliases.sort((left, right) => compareOrdinal(left.normalizedName, right.normalizedName));
    const updated: PlayerProfile = {
      ...current,
      revision: current.revision + 1,
      updatedAt:
        Date.parse(observedAt) > Date.parse(current.updatedAt) ? observedAt : current.updatedAt,
      aliases,
    };
    return this.#store(plan.operationId, operationFingerprint, updated);
  }

  public changeStatus(plan: ChangePlayerProfileStatusPlan): PlayerProfile {
    const operationFingerprint = fingerprint(plan);
    const replay = this.#replays.replay(plan.operationId, operationFingerprint);
    if (replay !== undefined) return replay;
    assertUuid(plan.identityId);
    assertActor(plan.actor);
    assertReason(plan.reason);
    const changedAt = canonicalTimestamp(plan.changedAt);
    const current = this.#profiles.get(profileKey(plan.identityId, plan.serverInstanceId));
    if (current === undefined) throw new PlayerGovernanceError('profile-not-found');
    if (current.revision !== plan.expectedRevision) {
      throw new PlayerGovernanceError('revision-conflict');
    }
    if (plan.status === current.status) throw new PlayerGovernanceError('invalid-operation');
    if (Date.parse(changedAt) < Date.parse(current.updatedAt)) {
      throw new PlayerGovernanceError('invalid-timestamp');
    }
    const updated: PlayerProfile = {
      ...current,
      revision: current.revision + 1,
      status: plan.status,
      updatedAt: changedAt,
    };
    return this.#store(plan.operationId, operationFingerprint, updated);
  }

  public find(identityId: string, serverInstanceId: string): PlayerProfile | undefined {
    assertUuid(identityId);
    assertUuid(serverInstanceId);
    const profile = this.#profiles.get(profileKey(identityId, serverInstanceId));
    return profile === undefined ? undefined : immutable(profile);
  }

  public list(): readonly PlayerProfile[] {
    return immutable(
      [...this.#profiles.values()].sort((left, right) =>
        compareOrdinal(
          profileKey(left.identityId, left.serverInstanceId),
          profileKey(right.identityId, right.serverInstanceId),
        ),
      ),
    );
  }

  #store(operationId: string, operationFingerprint: string, profile: PlayerProfile): PlayerProfile {
    const validation = validatePlayerProfile(profile);
    if (!validation.success) throw new PlayerGovernanceError('invalid-operation');
    const stored = immutable(validation.value);
    this.#replays.remember(operationId, operationFingerprint, stored);
    this.#profiles.set(profileKey(stored.identityId, stored.serverInstanceId), stored);
    return immutable(stored);
  }
}

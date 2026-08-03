import { PlayerGovernanceError, type GovernanceRegistryOptions } from './types.js';
import type { ActorRef } from '@voidfall/contracts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const IDENTIFIER = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const PERMISSION_NODE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

export function assertOptions(options: GovernanceRegistryOptions): void {
  if (
    !Number.isSafeInteger(options.maximumRecords) ||
    options.maximumRecords < 1 ||
    options.maximumRecords > 1_000_000 ||
    !Number.isSafeInteger(options.maximumReplays) ||
    options.maximumReplays < 1 ||
    options.maximumReplays > 1_000_000
  ) {
    throw new PlayerGovernanceError('invalid-options');
  }
}

export function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new PlayerGovernanceError('invalid-uuid');
}

export function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PlayerGovernanceError('invalid-timestamp');
  return parsed.toISOString();
}

export function assertReason(value: string): void {
  if (value.trim().length < 1 || value.length > 1_000) {
    throw new PlayerGovernanceError('invalid-operation');
  }
}

export function assertActor(value: ActorRef): void {
  const types = new Set(['panel-user', 'minecraft-player', 'agent', 'worker', 'system']);
  if (!types.has(value.type) || value.id.length < 1 || value.id.length > 128) {
    throw new PlayerGovernanceError('invalid-operation');
  }
}

export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareOrdinal)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) output[key] = canonicalValue(child);
  }
  return output;
}

export function fingerprint(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function freezeRecursive(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeRecursive(child);
  Object.freeze(value);
}

export function immutable<T>(value: T): T {
  const clone = structuredClone(value);
  freezeRecursive(clone);
  return clone;
}

export class ReplayLedger<T> {
  readonly #maximum: number;
  readonly #items = new Map<string, { readonly fingerprint: string; readonly result: T }>();

  public constructor(maximum: number) {
    this.#maximum = maximum;
  }

  public replay(operationId: string, operationFingerprint: string): T | undefined {
    assertUuid(operationId);
    const remembered = this.#items.get(operationId);
    if (remembered === undefined) return undefined;
    if (remembered.fingerprint !== operationFingerprint) {
      throw new PlayerGovernanceError('operation-conflict');
    }
    return immutable(remembered.result);
  }

  public remember(operationId: string, operationFingerprint: string, result: T): void {
    if (!this.#items.has(operationId) && this.#items.size >= this.#maximum) {
      throw new PlayerGovernanceError('replay-limit-exceeded');
    }
    this.#items.set(operationId, { fingerprint: operationFingerprint, result: immutable(result) });
  }
}

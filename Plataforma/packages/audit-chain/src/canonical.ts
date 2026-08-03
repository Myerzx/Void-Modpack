import { createHash } from 'node:crypto';

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function visit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => visit(item));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareOrdinal)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) output[key] = visit(child);
  }
  return output;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(visit(value));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

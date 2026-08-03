import { createHash } from 'node:crypto';

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value !== 'object' || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareOrdinal)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalValue(child);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

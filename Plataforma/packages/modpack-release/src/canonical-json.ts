import { createHash } from 'node:crypto';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalize(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not accept non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const record = value as { readonly [key: string]: CanonicalJsonValue };
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right, 'en-US'));
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key] as CanonicalJsonValue)}`)
    .join(',')}}`;
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return canonicalize(value);
}

export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

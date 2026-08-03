import { TextDecoder } from 'node:util';
import { canonicalJsonBytes, sha256Bytes, type CanonicalJsonValue } from './canonical-json.js';
import {
  ReleaseBuildError,
  type ReleaseSanitizationPolicy,
  type ReleaseSanitizationReceipt,
} from './types.js';

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authsecret',
  'password',
  'privatekey',
  'rconpassword',
  'rconport',
  'seed',
  'serveraddress',
  'serverip',
  'token',
  'username',
  'uuid',
]);

export interface SanitizedArtifact {
  readonly bytes: Uint8Array;
  readonly receipt: ReleaseSanitizationReceipt;
}

function normalizedKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US').replaceAll(/[-_.]/gu, '');
}

function validateAllowedKeys(keys: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 1_024) {
    throw new ReleaseBuildError('invalid-plan', 'sanitize');
  }
  const result = new Set<string>();
  for (const key of keys) {
    if (!KEY_PATTERN.test(key) || SENSITIVE_KEYS.has(normalizedKey(key)) || result.has(key)) {
      throw new ReleaseBuildError('invalid-plan', 'sanitize');
    }
    result.add(key);
  }
  return result;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseBuildError('sanitization-failed', 'sanitize');
  }
}

function sanitizeJson(bytes: Uint8Array, allowedKeys: readonly string[]): {
  readonly bytes: Uint8Array;
  readonly removedFieldCount: number;
} {
  const allowed = validateAllowedKeys(allowedKeys);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    throw new ReleaseBuildError('sanitization-failed', 'sanitize');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReleaseBuildError('sanitization-failed', 'sanitize');
  }
  const source = parsed as Record<string, unknown>;
  const output: Record<string, CanonicalJsonValue> = {};
  let removedFieldCount = 0;
  for (const [key, value] of Object.entries(source)) {
    if (!KEY_PATTERN.test(key)) throw new ReleaseBuildError('sanitization-failed', 'sanitize');
    if (!allowed.has(key)) {
      removedFieldCount += 1;
      continue;
    }
    output[key] = value as CanonicalJsonValue;
  }
  try {
    return { bytes: canonicalJsonBytes(output), removedFieldCount };
  } catch {
    throw new ReleaseBuildError('sanitization-failed', 'sanitize');
  }
}

function sanitizeProperties(bytes: Uint8Array, allowedKeys: readonly string[]): {
  readonly bytes: Uint8Array;
  readonly removedFieldCount: number;
} {
  const allowed = validateAllowedKeys(allowedKeys);
  const source = decodeUtf8(bytes);
  if (source.includes('\u0000') || source.includes('\\')) {
    throw new ReleaseBuildError('sanitization-failed', 'sanitize');
  }
  const values = new Map<string, string>();
  let removedFieldCount = 0;
  for (const rawLine of source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new ReleaseBuildError('sanitization-failed', 'sanitize');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!KEY_PATTERN.test(key) || /[\u0000-\u001f\u007f]/u.test(value) || values.has(key)) {
      throw new ReleaseBuildError('sanitization-failed', 'sanitize');
    }
    if (!allowed.has(key)) {
      removedFieldCount += 1;
      continue;
    }
    values.set(key, value);
  }
  const output = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  return { bytes: Buffer.from(output, 'utf8'), removedFieldCount };
}

export function sanitizeReleaseArtifact(input: {
  readonly source: Uint8Array;
  readonly sourceSha256: string;
  readonly policy: ReleaseSanitizationPolicy;
}): SanitizedArtifact {
  const observedSourceSha256 = sha256Bytes(input.source);
  if (observedSourceSha256 !== input.sourceSha256) {
    throw new ReleaseBuildError('source-integrity-mismatch', 'sanitize');
  }

  let result: { readonly bytes: Uint8Array; readonly removedFieldCount: number };
  switch (input.policy.strategy) {
    case 'exact-reviewed-bytes-v1':
      result = { bytes: Uint8Array.from(input.source), removedFieldCount: 0 };
      break;
    case 'canonical-json-object-v1':
      result = sanitizeJson(input.source, input.policy.allowedKeys);
      break;
    case 'java-properties-allowlist-v1':
      result = sanitizeProperties(input.source, input.policy.allowedKeys);
      break;
  }

  const outputSha256 = sha256Bytes(result.bytes);
  return Object.freeze({
    bytes: result.bytes,
    receipt: Object.freeze({
      strategy: input.policy.strategy,
      sourceSha256: observedSourceSha256,
      outputSha256,
      removedFieldCount: result.removedFieldCount,
    }),
  });
}

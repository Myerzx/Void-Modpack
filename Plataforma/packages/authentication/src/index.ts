import {
  createHash,
  randomBytes,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type KeyLike,
} from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import { canonicalize } from 'json-canonicalize';
import type { AgentEnvelope, JsonValue } from '@voidfall/contracts';

const PASSWORD_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1_024) {
    throw new Error('Password length must be between 12 and 1024 characters.');
  }

  return hash(password, PASSWORD_OPTIONS);
}

export async function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  if (candidate.length > 1_024) {
    return false;
  }

  try {
    return await verify(passwordHash, candidate);
  } catch {
    return false;
  }
}

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashOpaqueToken(token: string): string {
  return sha256Hex(token);
}

export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/u.test(left) || !/^[a-f0-9]+$/u.test(right) || left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function canonicalJson(value: JsonValue): string {
  return canonicalize(value);
}

function unsignedEnvelope(envelope: AgentEnvelope): Omit<AgentEnvelope, 'signature'> {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

export function computeAgentPayloadHash(envelope: Pick<AgentEnvelope, 'payload'>): string {
  return sha256Hex(canonicalize(envelope.payload));
}

export function signAgentEnvelope(
  envelope: Omit<AgentEnvelope, 'signature'>,
  privateKey: KeyLike,
  keyId: string,
): AgentEnvelope {
  const signature = signBytes(null, Buffer.from(canonicalize(envelope)), privateKey).toString('base64url');
  return {
    ...envelope,
    signature: { algorithm: 'Ed25519', keyId, value: signature },
  };
}

export function verifyAgentEnvelopeSignature(envelope: AgentEnvelope, publicKey: KeyLike): boolean {
  try {
    return verifyBytes(
      null,
      Buffer.from(canonicalize(unsignedEnvelope(envelope))),
      publicKey,
      Buffer.from(envelope.signature.value, 'base64url'),
    );
  } catch {
    return false;
  }
}

export interface EnvelopeFreshnessOptions {
  readonly now: Date;
  readonly maximumClockSkewMs?: number;
  readonly maximumLifetimeMs?: number;
}

export function isAgentEnvelopeFresh(
  envelope: Pick<AgentEnvelope, 'issuedAt' | 'expiresAt'>,
  options: EnvelopeFreshnessOptions,
): boolean {
  const maximumClockSkewMs = options.maximumClockSkewMs ?? 60_000;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? 5 * 60_000;
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  const now = options.now.getTime();

  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= maximumLifetimeMs &&
    issuedAt <= now + maximumClockSkewMs &&
    expiresAt >= now - maximumClockSkewMs
  );
}

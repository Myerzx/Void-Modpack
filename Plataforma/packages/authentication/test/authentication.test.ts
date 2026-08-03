import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import type { AgentEnvelope } from '@voidfall/contracts';
import {
  computeAgentPayloadHash,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  isAgentEnvelopeFresh,
  safeEqualHex,
  signAgentEnvelope,
  verifyAgentEnvelopeSignature,
  verifyPassword,
} from '../src/index.js';

describe('panel authentication primitives', () => {
  it('hashes passwords with Argon2id and verifies without exposing the password', async () => {
    const encoded = await hashPassword('a-long-local-test-password');
    assert.match(encoded, /^\$argon2id\$/u);
    assert.equal(await verifyPassword(encoded, 'a-long-local-test-password'), true);
    assert.equal(await verifyPassword(encoded, 'wrong-password'), false);
  });

  it('creates opaque tokens and compares only their hashes', () => {
    const token = createOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    assert.equal(token.length >= 43, true);
    assert.equal(safeEqualHex(tokenHash, hashOpaqueToken(token)), true);
    assert.equal(safeEqualHex(tokenHash, hashOpaqueToken('different')), false);
  });
});

describe('agent envelope cryptography', () => {
  it('binds the signature to every unsigned envelope field and payload hash', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const payload = { schemaVersion: 1, data: { status: 'online' } } as const;
    const unsigned: Omit<AgentEnvelope, 'signature'> = {
      schemaVersion: 1,
      messageId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63701',
      correlationId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63702',
      agentId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63703',
      serverInstanceId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63704',
      kind: 'heartbeat',
      issuedAt: '2026-08-03T12:00:00.000Z',
      expiresAt: '2026-08-03T12:05:00.000Z',
      nonce: 'n'.repeat(43),
      payloadHash: computeAgentPayloadHash({ payload }),
      payload,
    };
    const signed = signAgentEnvelope(unsigned, privateKey, 'agent-2026-01');
    assert.equal(verifyAgentEnvelopeSignature(signed, publicKey), true);
    assert.equal(
      verifyAgentEnvelopeSignature({ ...signed, nonce: 'x'.repeat(43) }, publicKey),
      false,
    );
  });

  it('rejects expired, future and overlong envelopes', () => {
    const now = new Date('2026-08-03T12:03:00.000Z');
    assert.equal(
      isAgentEnvelopeFresh(
        { issuedAt: '2026-08-03T12:00:00.000Z', expiresAt: '2026-08-03T12:05:00.000Z' },
        { now },
      ),
      true,
    );
    assert.equal(
      isAgentEnvelopeFresh(
        { issuedAt: '2026-08-03T11:00:00.000Z', expiresAt: '2026-08-03T11:05:00.000Z' },
        { now },
      ),
      false,
    );
  });
});

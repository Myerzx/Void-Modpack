import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  computeAgentPayloadHash,
  verifyAgentEnvelopeSignature,
} from '@voidfall/authentication';
import { validateAgentEnvelope } from '@voidfall/contracts';
import {
  createAgentIdentity,
  createHeartbeatEnvelope,
  VoidFallAgentClient,
  type AgentFetch,
} from '../src/agent-client.js';

describe('outbound-only server agent client', () => {
  it('creates a valid signed heartbeat bound to its identity and payload', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const envelope = createHeartbeatEnvelope(
      {
        agentId: randomUUID(),
        serverInstanceId: randomUUID(),
        privateKey,
        keyId: 'agent-key',
      },
      {
        status: 'online',
        observedAt: new Date('2026-08-03T12:00:00.000Z'),
        softwareVersion: '0.1.0',
      },
    );
    assert.equal(validateAgentEnvelope(envelope).success, true);
    assert.equal(verifyAgentEnvelopeSignature(envelope, publicKey), true);
    assert.equal(envelope.payloadHash, computeAgentPayloadHash(envelope));
  });

  it('requires HTTPS and posts registration plus heartbeat through the supplied mTLS transport', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const transport: AgentFetch = async (url, init) => {
      calls.push({ url: url.toString(), body: JSON.parse(init.body) as unknown });
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    };
    assert.throws(
      () => new VoidFallAgentClient({ baseUrl: 'http://control.voidfall.invalid', fetch: transport }),
      /HTTPS/u,
    );

    const client = new VoidFallAgentClient({
      baseUrl: 'https://control.voidfall.invalid/base/',
      fetch: transport,
    });
    const { privateKey } = generateKeyPairSync('ed25519');
    const agentId = randomUUID();
    const serverInstanceId = randomUUID();
    await client.completeRegistration({
      provisioningToken: 'p'.repeat(43),
      agentId,
      serverInstanceId,
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----',
      certificateFingerprint: 'a'.repeat(64),
      softwareVersion: '0.1.0',
    });
    await client.sendHeartbeat(
      createHeartbeatEnvelope(
        { agentId, serverInstanceId, privateKey, keyId: 'agent-key' },
        {
          status: 'online',
          observedAt: new Date('2026-08-03T12:00:00.000Z'),
          softwareVersion: '0.1.0',
        },
      ),
    );

    assert.deepEqual(
      calls.map((call) => new URL(call.url).pathname),
      ['/agent/v1/register/complete', '/agent/v1/heartbeat'],
    );
  });
});

describe('the signing identity', () => {
  it('derives a stable key id from the key itself, not from configuration', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const agentId = randomUUID();
    const serverInstanceId = randomUUID();

    const first = createAgentIdentity({ agentId, serverInstanceId, privateKeyPem });
    const second = createAgentIdentity({ agentId, serverInstanceId, privateKeyPem });
    // Stable across restarts, so a receipt from yesterday names the same key.
    assert.equal(first.keyId, second.keyId);
    // And the contract accepts it as a slug, which is what carries it on the wire.
    assert.match(first.keyId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

    // Rotating the key changes the id by construction. An id an operator sets
    // by hand is one that can outlive the key it names.
    const rotated = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    assert.notEqual(
      createAgentIdentity({ agentId, serverInstanceId, privateKeyPem: rotated }).keyId,
      first.keyId,
    );

    // The identity actually signs, and the public half verifies it.
    const envelope = createHeartbeatEnvelope(first, {
      status: 'online',
      observedAt: new Date('2026-08-05T12:00:00.000Z'),
      softwareVersion: '0.1.0',
    });
    assert.equal(validateAgentEnvelope(envelope).success, true);
    assert.equal(verifyAgentEnvelopeSignature(envelope, publicKey), true);
    assert.equal(envelope.signature.keyId, first.keyId);
  });
});

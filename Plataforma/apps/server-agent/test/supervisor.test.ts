import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { AgentEnvelope, AgentWorkLease } from '@voidfall/contracts';

import type { AgentIdentity } from '../src/agent-client.js';
import { AgentSupervisor, type SupervisorEvent } from '../src/supervisor.js';
import {
  AgentTransportRequestError,
  AgentWorkTransport,
  createWorkClaimEnvelope,
  createWorkResultEnvelope,
} from '../src/work-transport.js';

/**
 * The supervisor is exercised against a scripted control plane rather than a
 * live one, so the loop's behaviour under failure is observable and
 * deterministic. No real Minecraft process is involved anywhere here.
 */

function identity(): AgentIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    agentId: randomUUID(),
    serverInstanceId: randomUUID(),
    privateKey,
    keyId: 'agent-key-1',
  };
}

function lease(overrides: Partial<AgentWorkLease> = {}): AgentWorkLease {
  return {
    schemaVersion: 1,
    leaseId: randomUUID(),
    jobId: randomUUID(),
    capability: 'artifact.inspect',
    correlationId: randomUUID(),
    parameters: {
      resourceType: 'artifact-submission',
      resourceId: randomUUID(),
      expectedVersion: 2,
    },
    leasedAt: '2026-08-05T12:00:00.000Z',
    expiresAt: '2026-08-05T12:01:00.000Z',
    attempt: 1,
    ...overrides,
  };
}

/** A scripted control plane. Each entry answers one POST in order. */
function scriptedTransport(
  script: readonly (
    | { readonly claim: readonly AgentWorkLease[]; readonly retryAfterSeconds?: number }
    | { readonly status: number }
    | { readonly result: true }
  )[],
): { readonly transport: AgentWorkTransport; readonly seen: { paths: string[]; bodies: unknown[] } } {
  const seen = { paths: [] as string[], bodies: [] as unknown[] };
  let index = 0;
  const transport = new AgentWorkTransport({
    baseUrl: 'http://control.invalid',
    allowInsecureDevelopment: true,
    fetch: async (url, init) => {
      seen.paths.push(url.pathname);
      seen.bodies.push(JSON.parse(init.body) as unknown);
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step !== undefined && 'status' in step) {
        return { ok: false, status: step.status, json: async () => ({}) };
      }
      if (step !== undefined && 'claim' in step) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: 1,
            leases: step.claim,
            retryAfterSeconds: step.retryAfterSeconds ?? 15,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ jobId: randomUUID() }) };
    },
  });
  return { transport, seen };
}

describe('work envelopes', () => {
  it('signs a claim and a result the contract accepts', () => {
    const agent = identity();
    const claim = createWorkClaimEnvelope(agent, {
      capabilities: ['artifact.inspect'],
      leaseSeconds: 60,
      bootId: randomUUID(),
      issuedAt: new Date('2026-08-05T12:00:00Z'),
    });
    assert.equal(claim.kind, 'job.lease-request');
    assert.equal(claim.agentId, agent.agentId);

    const result = createWorkResultEnvelope(agent, {
      leaseId: randomUUID(),
      jobId: randomUUID(),
      correlationId: randomUUID(),
      outcome: 'succeeded',
      issuedAt: new Date('2026-08-05T12:00:30Z'),
    });
    assert.equal(result.kind, 'job.event');
  });

  it('refuses to send a result the control plane would only reject', () => {
    const agent = identity();
    // A failed result with no failure code, and a pid with no boot, are both
    // refused locally rather than sent and bounced.
    assert.throws(() =>
      createWorkResultEnvelope(agent, {
        leaseId: randomUUID(),
        jobId: randomUUID(),
        correlationId: randomUUID(),
        outcome: 'failed',
        issuedAt: new Date('2026-08-05T12:00:30Z'),
      }),
    );
    assert.throws(() =>
      createWorkResultEnvelope(agent, {
        leaseId: randomUUID(),
        jobId: randomUUID(),
        correlationId: randomUUID(),
        outcome: 'succeeded',
        observedLifecycle: 'online',
        observedPid: 4242,
        issuedAt: new Date('2026-08-05T12:00:30Z'),
      }),
    );
  });
});

describe('agent supervisor', () => {
  it('claims, dispatches to the capability handler and reports the result', async () => {
    const work = lease();
    const { transport, seen } = scriptedTransport([{ claim: [work] }, { result: true }]);
    const handled: string[] = [];
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: {
        'artifact.inspect': async (received) => {
          handled.push(received.leaseId);
          return { outcome: 'succeeded', observedLifecycle: 'offline' };
        },
      },
      clock: () => new Date('2026-08-05T12:00:00Z'),
    });

    const waitMs = await supervisor.runOnce();
    assert.deepEqual(handled, [work.leaseId]);
    assert.deepEqual(seen.paths, ['/agent/v1/work/claim', '/agent/v1/work/result']);
    // Work was found, so the next look is prompt rather than idle-delayed.
    assert.equal(waitMs, 0);
  });

  it('waits the interval the control plane asked for when idle', async () => {
    const { transport, seen } = scriptedTransport([{ claim: [], retryAfterSeconds: 30 }]);
    const events: SupervisorEvent[] = [];
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      onEvent: (event) => events.push(event),
      clock: () => new Date('2026-08-05T12:00:00Z'),
    });

    const waitMs = await supervisor.runOnce();
    // No polling harder than the control plane allows.
    assert.equal(waitMs, 30_000);
    assert.equal(seen.paths.length, 1);
    assert.deepEqual(events, [{ kind: 'idle', retryAfterSeconds: 30 }]);
  });

  it('refuses a capability it has no handler for instead of improvising', async () => {
    const work = lease({ capability: 'configuration.apply' });
    const { transport, seen } = scriptedTransport([{ claim: [work] }, { result: true }]);
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      clock: () => new Date('2026-08-05T12:00:00Z'),
    });

    await supervisor.runOnce();
    const reported = seen.bodies[1] as AgentEnvelope;
    const data = reported.payload.data as unknown as {
      readonly outcome: string;
      readonly failureCode: string;
    };
    assert.equal(data.outcome, 'failed');
    assert.equal(data.failureCode, 'unsupported-parameters');
  });

  it('reports a handler that threw as a failure rather than crashing the loop', async () => {
    const { transport, seen } = scriptedTransport([{ claim: [lease()] }, { result: true }]);
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: {
        'artifact.inspect': async () => {
          throw new Error('handler exploded');
        },
      },
      clock: () => new Date('2026-08-05T12:00:00Z'),
    });

    await supervisor.runOnce();
    const reported = seen.bodies[1] as AgentEnvelope;
    const data = reported.payload.data as unknown as { readonly failureCode: string };
    assert.equal(data.failureCode, 'operation-failed');
  });

  it('backs off geometrically to a ceiling while the control plane is down', async () => {
    const { transport } = scriptedTransport([{ status: 503 }]);
    const waits: number[] = [];
    let cycles = 0;
    const controller = new AbortController();

    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      minimumBackoffMs: 1_000,
      maximumBackoffMs: 4_000,
      clock: () => new Date('2026-08-05T12:00:00Z'),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        cycles += 1;
        if (cycles >= 5) controller.abort();
      },
    });

    await supervisor.run(controller.signal);
    // Geometric, and it stops doubling at the ceiling instead of growing.
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  it('recovers and resets its backoff once the control plane answers again', async () => {
    let call = 0;
    const transport = new AgentWorkTransport({
      baseUrl: 'http://control.invalid',
      allowInsecureDevelopment: true,
      fetch: async () => {
        call += 1;
        // Down twice, then healthy and idle.
        if (call <= 2) return { ok: false, status: 503, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ schemaVersion: 1, leases: [], retryAfterSeconds: 7 }),
        };
      },
    });

    const waits: number[] = [];
    const controller = new AbortController();
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      minimumBackoffMs: 1_000,
      maximumBackoffMs: 8_000,
      clock: () => new Date('2026-08-05T12:00:00Z'),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length >= 4) controller.abort();
      },
    });

    await supervisor.run(controller.signal);
    // Two failures back off, then the healthy answer resets to the idle
    // interval the control plane asked for.
    assert.deepEqual(waits.slice(0, 4), [1_000, 2_000, 7_000, 7_000]);
  });

  it('stops cleanly when the signal aborts', async () => {
    const { transport } = scriptedTransport([{ claim: [], retryAfterSeconds: 5 }]);
    const events: SupervisorEvent[] = [];
    const controller = new AbortController();
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      onEvent: (event) => events.push(event),
      clock: () => new Date('2026-08-05T12:00:00Z'),
      sleep: async () => {
        controller.abort();
      },
    });

    await supervisor.run(controller.signal);
    assert.equal(events.at(-1)?.kind, 'stopped');
  });

  it('reports a withdrawn capability instead of retrying in a tight loop', async () => {
    const { transport } = scriptedTransport([{ status: 403 }]);
    const events: SupervisorEvent[] = [];
    const controller = new AbortController();
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      onEvent: (event) => events.push(event),
      clock: () => new Date('2026-08-05T12:00:00Z'),
      sleep: async () => {
        controller.abort();
      },
    });

    await supervisor.run(controller.signal);
    assert.ok(events.some((event) => event.kind === 'unauthorized' && event.status === 403));
    assert.ok(events.some((event) => event.kind === 'error'));
  });

  it('announces a fresh boot id per run so a restart is visible', () => {
    const first = new AgentSupervisor({
      identity: identity(),
      transport: scriptedTransport([{ claim: [] }]).transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
    });
    const second = new AgentSupervisor({
      identity: identity(),
      transport: scriptedTransport([{ claim: [] }]).transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
    });
    assert.notEqual(first.bootId, second.bootId);
    assert.deepEqual([...first.servedCapabilities], ['artifact.inspect']);
  });

  it('refuses to run with no capability handler at all', async () => {
    const supervisor = new AgentSupervisor({
      identity: identity(),
      transport: scriptedTransport([{ claim: [] }]).transport,
      handlers: {},
    });
    await assert.rejects(supervisor.runOnce(), /no capability handler/u);
  });

  it('surfaces the transport status on a failed request', async () => {
    const { transport } = scriptedTransport([{ status: 500 }]);
    await assert.rejects(
      transport.claim(
        createWorkClaimEnvelope(identity(), {
          capabilities: ['artifact.inspect'],
          leaseSeconds: 60,
          bootId: randomUUID(),
          issuedAt: new Date('2026-08-05T12:00:00Z'),
        }),
      ),
      (error: unknown) => error instanceof AgentTransportRequestError && error.status === 500,
    );
  });
});

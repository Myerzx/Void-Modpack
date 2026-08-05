import { randomUUID } from 'node:crypto';

import {
  computeAgentPayloadHash,
  createOpaqueToken,
  signAgentEnvelope,
} from '@voidfall/authentication';
import {
  validateAgentEnvelope,
  validateAgentWorkClaimPayload,
  validateAgentWorkResultPayload,
  type AgentCapability,
  type AgentEnvelope,
  type AgentWorkClaimResponse,
  type AgentWorkFailureCode,
  type AgentWorkLease,
} from '@voidfall/contracts';

import type { AgentFetch, AgentIdentity } from './agent-client.js';

/**
 * Outbound-only work transport for the Server Agent.
 *
 * The agent dials the control plane to claim work and to report the result; it
 * never listens. Every message is the same signed, single-use envelope the
 * heartbeat already uses, so there is one authentication mechanism rather than
 * a second one invented for work.
 */

export interface WorkClaimInput {
  readonly capabilities: readonly AgentCapability[];
  readonly leaseSeconds: number;
  /** Identifies this run of the agent, so a restart is visible to the API. */
  readonly bootId: string;
  readonly issuedAt: Date;
  readonly lifetimeMs?: number;
}

export interface WorkResultInput {
  readonly leaseId: string;
  readonly jobId: string;
  readonly correlationId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly failureCode?: AgentWorkFailureCode;
  readonly observedLifecycle?: 'unknown' | 'offline' | 'starting' | 'online' | 'stopping' | 'error';
  readonly observedPid?: number;
  readonly bootId?: string;
  readonly issuedAt: Date;
  readonly lifetimeMs?: number;
}

function sign(
  identity: AgentIdentity,
  kind: AgentEnvelope['kind'],
  correlationId: string,
  data: Record<string, unknown>,
  issuedAt: Date,
  lifetimeMs: number,
): AgentEnvelope {
  const payload: AgentEnvelope['payload'] = { schemaVersion: 1, data: data as never };
  const unsigned: Omit<AgentEnvelope, 'signature'> = {
    schemaVersion: 1,
    messageId: randomUUID(),
    correlationId,
    agentId: identity.agentId,
    serverInstanceId: identity.serverInstanceId,
    kind,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + lifetimeMs).toISOString(),
    nonce: createOpaqueToken(),
    payloadHash: computeAgentPayloadHash({ payload }),
    payload,
  };
  const envelope = signAgentEnvelope(unsigned, identity.privateKey, identity.keyId);
  const validation = validateAgentEnvelope(envelope);
  if (!validation.success) {
    throw new Error(`Generated ${kind} envelope is invalid: ${validation.issues[0]?.path ?? '/'}`);
  }
  return envelope;
}

export function createWorkClaimEnvelope(
  identity: AgentIdentity,
  input: WorkClaimInput,
): AgentEnvelope {
  const data = {
    schemaVersion: 1,
    capabilities: [...input.capabilities],
    leaseSeconds: input.leaseSeconds,
    bootId: input.bootId,
  };
  // Refuse to send something the control plane would only reject.
  if (!validateAgentWorkClaimPayload(data).success) {
    throw new Error('Refusing to send an invalid work claim.');
  }
  return sign(
    identity,
    'job.lease-request',
    randomUUID(),
    data,
    input.issuedAt,
    input.lifetimeMs ?? 60_000,
  );
}

export function createWorkResultEnvelope(
  identity: AgentIdentity,
  input: WorkResultInput,
): AgentEnvelope {
  const data = {
    schemaVersion: 1,
    leaseId: input.leaseId,
    jobId: input.jobId,
    outcome: input.outcome,
    failureCode: input.failureCode ?? null,
    observedLifecycle: input.observedLifecycle ?? null,
    observedPid: input.observedPid ?? null,
    bootId: input.bootId ?? null,
    completedAt: input.issuedAt.toISOString(),
  };
  if (!validateAgentWorkResultPayload(data).success) {
    throw new Error('Refusing to send an invalid work result.');
  }
  return sign(
    identity,
    'job.event',
    input.correlationId,
    data,
    input.issuedAt,
    input.lifetimeMs ?? 60_000,
  );
}

export interface WorkClaimOutcome {
  readonly leases: readonly AgentWorkLease[];
  readonly retryAfterSeconds: number;
}

export class AgentWorkTransport {
  readonly #baseUrl: URL;
  readonly #fetch: AgentFetch;

  constructor(input: {
    readonly baseUrl: string;
    readonly fetch: AgentFetch;
    readonly allowInsecureDevelopment?: boolean;
  }) {
    this.#baseUrl = new URL(input.baseUrl);
    if (this.#baseUrl.protocol !== 'https:' && input.allowInsecureDevelopment !== true) {
      throw new Error('The agent control-plane URL must use HTTPS.');
    }
    this.#fetch = input.fetch;
  }

  async claim(envelope: AgentEnvelope): Promise<WorkClaimOutcome> {
    const body = (await this.#post('/agent/v1/work/claim', envelope)) as AgentWorkClaimResponse;
    return {
      leases: Array.isArray(body.leases) ? body.leases : [],
      retryAfterSeconds:
        typeof body.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0
          ? body.retryAfterSeconds
          : 15,
    };
  }

  async report(envelope: AgentEnvelope): Promise<{ readonly jobId: string }> {
    return (await this.#post('/agent/v1/work/result', envelope)) as { readonly jobId: string };
  }

  async #post(pathname: string, payload: object): Promise<unknown> {
    const response = await this.#fetch(new URL(pathname, this.#baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new AgentTransportRequestError(response.status);
    }
    return response.json();
  }
}

export class AgentTransportRequestError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`Control-plane request failed with HTTP ${String(status)}.`);
    this.name = 'AgentTransportRequestError';
    this.status = status;
  }
}

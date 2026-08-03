import { randomUUID, type KeyLike } from 'node:crypto';
import {
  computeAgentPayloadHash,
  createOpaqueToken,
  signAgentEnvelope,
} from '@voidfall/authentication';
import { validateAgentEnvelope, type AgentEnvelope } from '@voidfall/contracts';

export interface AgentHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type AgentFetch = (
  url: URL,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<AgentHttpResponse>;

export interface AgentIdentity {
  readonly agentId: string;
  readonly serverInstanceId: string;
  readonly privateKey: KeyLike;
  readonly keyId: string;
}

export interface HeartbeatInput {
  readonly status: 'online' | 'degraded';
  readonly observedAt: Date;
  readonly softwareVersion: string;
  readonly protocolVersion?: number;
  readonly capabilities?: readonly string[];
  readonly lifetimeMs?: number;
}

export function createHeartbeatEnvelope(
  identity: AgentIdentity,
  input: HeartbeatInput,
): AgentEnvelope {
  const payload: AgentEnvelope['payload'] = {
    schemaVersion: 1,
    data: {
      status: input.status,
      observedAt: input.observedAt.toISOString(),
      protocolVersion: input.protocolVersion ?? 1,
      softwareVersion: input.softwareVersion,
      capabilities: [...(input.capabilities ?? ['heartbeat'])],
    },
  };
  const unsigned: Omit<AgentEnvelope, 'signature'> = {
    schemaVersion: 1,
    messageId: randomUUID(),
    correlationId: randomUUID(),
    agentId: identity.agentId,
    serverInstanceId: identity.serverInstanceId,
    kind: 'heartbeat',
    issuedAt: input.observedAt.toISOString(),
    expiresAt: new Date(input.observedAt.getTime() + (input.lifetimeMs ?? 60_000)).toISOString(),
    nonce: createOpaqueToken(),
    payloadHash: computeAgentPayloadHash({ payload }),
    payload,
  };
  const envelope = signAgentEnvelope(unsigned, identity.privateKey, identity.keyId);
  const validation = validateAgentEnvelope(envelope);
  if (!validation.success) {
    throw new Error(`Generated heartbeat envelope is invalid: ${validation.issues[0]?.path ?? '/'}`);
  }
  return envelope;
}

export class VoidFallAgentClient {
  readonly #baseUrl: URL;
  readonly #fetch: AgentFetch;

  constructor(input: {
    readonly baseUrl: string;
    /** Transport must present the agent client certificate during the TLS handshake. */
    readonly fetch: AgentFetch;
    readonly allowInsecureDevelopment?: boolean;
  }) {
    this.#baseUrl = new URL(input.baseUrl);
    if (this.#baseUrl.protocol !== 'https:' && input.allowInsecureDevelopment !== true) {
      throw new Error('The agent control-plane URL must use HTTPS.');
    }
    this.#fetch = input.fetch;
  }

  async completeRegistration(input: {
    readonly provisioningToken: string;
    readonly agentId: string;
    readonly serverInstanceId: string;
    readonly publicKeyPem: string;
    readonly certificateFingerprint: string;
    readonly softwareVersion: string;
  }): Promise<unknown> {
    return this.#post('/agent/v1/register/complete', {
      ...input,
      capabilities: ['heartbeat'],
    });
  }

  async sendHeartbeat(envelope: AgentEnvelope): Promise<unknown> {
    const validation = validateAgentEnvelope(envelope);
    if (!validation.success || envelope.kind !== 'heartbeat') {
      throw new Error('Refusing to send an invalid heartbeat envelope.');
    }
    return this.#post('/agent/v1/heartbeat', envelope);
  }

  async #post(pathname: string, payload: object): Promise<unknown> {
    const response = await this.#fetch(new URL(pathname, this.#baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Control-plane request failed with HTTP ${response.status}.`);
    return response.json();
  }
}

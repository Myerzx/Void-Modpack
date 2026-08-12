import { createPublicKey } from 'node:crypto';

import {
  AgentEnvelopeSchema,
  validateAgentEnvelope,
  validateAgentWorkClaimPayload,
  validateAgentWorkResultPayload,
  type AgentEnvelope,
  type AgentWorkFailureCode,
  type AgentWorkClaimResponse,
  type AgentWorkLease,
  type ServerOperationFailureCode,
} from '@voidfall/contracts';
import { AgentTransportError, type Repositories } from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Outbound-only work endpoints for the Phase 9.2 agent transport.
 *
 * The agent dials the control plane; nothing here ever opens a connection to
 * an agent, so no inbound port has to exist on the server host.
 *
 * Authentication reuses the existing agent chain exactly — authenticated
 * transport fingerprint, Ed25519 envelope signature, freshness window and
 * single-use nonce — rather than introducing a second mechanism. What is new
 * is authorization: the fingerprint has to resolve to an *active* credential,
 * and the capability has to have been granted, not merely announced.
 */

export type AgentTransportVerifier = (
  request: FastifyRequest,
  expectedCertificateFingerprint: string,
) => boolean | Promise<boolean>;

export interface AgentWorkRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly verifyAgentTransport: AgentTransportVerifier;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
  readonly computePayloadHash: (envelope: AgentEnvelope) => string;
  readonly verifySignature: (envelope: AgentEnvelope, publicKey: ReturnType<typeof createPublicKey>) => boolean;
  readonly isFresh: (envelope: AgentEnvelope, options: { readonly now: Date }) => boolean;
  readonly safeEqualHex: (left: string, right: string) => boolean;
  readonly hashNonce: (nonce: string) => string;
  readonly newId: () => string;
  readonly audit: (input: {
    readonly request: FastifyRequest;
    readonly agentId: string;
    readonly action: string;
    readonly correlationId: string;
    readonly outcome: 'succeeded' | 'failed' | 'denied';
    readonly reason?: string;
  }) => Promise<void>;
  /** Bounds how long a single lease may be held. */
  readonly maximumLeaseSeconds?: number;
}

// A real Forge boot and a multi-gigabyte encrypted restore both exceed five
// minutes on ordinary disks. The contract caps this at fifteen minutes.
const DEFAULT_MAXIMUM_LEASE_SECONDS = 900;
const IDLE_RETRY_SECONDS = 15;

function operationFailureCodeFor(code: AgentWorkFailureCode): ServerOperationFailureCode {
  if (code === 'capability-refused' || code === 'unsupported-parameters') {
    return 'agent-refused';
  }
  return code;
}

export function registerAgentWorkRoutes(
  app: FastifyInstance,
  dependencies: AgentWorkRouteDependencies,
): void {
  const {
    repositories,
    clock,
    verifyAgentTransport,
    apiError,
    computePayloadHash,
    verifySignature,
    isFresh,
    safeEqualHex,
    hashNonce,
    newId,
    audit,
  } = dependencies;
  const maximumLeaseSeconds = dependencies.maximumLeaseSeconds ?? DEFAULT_MAXIMUM_LEASE_SECONDS;

  /**
   * Authenticates one envelope and resolves the identity behind it.
   *
   * The order matters: the transport fingerprint is resolved against the
   * credential history first, so a rotated or revoked identity is refused
   * before any signature work is done on its behalf.
   */
  async function authenticateAgent(
    request: FastifyRequest,
    envelope: AgentEnvelope,
    kind: AgentEnvelope['kind'],
  ): Promise<{ readonly agentId: string; readonly serverInstanceId: string }> {
    const structural = validateAgentEnvelope(envelope);
    if (!structural.success || envelope.kind !== kind) {
      throw apiError(400, 'AGENT_ENVELOPE_INVALID', 'Envelope do agente inválido.');
    }

    const agent = await repositories.agents.findById(envelope.agentId);
    if (agent === undefined || agent.serverInstanceId !== envelope.serverInstanceId) {
      throw apiError(401, 'AGENT_IDENTITY_INVALID', 'Identidade do agente inválida.');
    }

    let identity;
    try {
      identity = await repositories.agentTransport.resolveByFingerprint(agent.certificateFingerprint);
    } catch (error) {
      if (error instanceof AgentTransportError) {
        throw apiError(401, 'AGENT_CREDENTIAL_INVALID', 'Credencial do agente inválida ou revogada.');
      }
      throw error;
    }
    if (identity.agentId !== envelope.agentId) {
      throw apiError(401, 'AGENT_IDENTITY_INVALID', 'Identidade do agente inválida.');
    }

    if (!(await verifyAgentTransport(request, identity.credential.certificateFingerprint))) {
      throw apiError(401, 'AGENT_TRANSPORT_INVALID', 'Transporte autenticado do agente inválido.');
    }

    const now = clock();
    if (
      !safeEqualHex(computePayloadHash(envelope), envelope.payloadHash) ||
      !verifySignature(envelope, createPublicKey(identity.publicKeyPem)) ||
      !isFresh(envelope, { now })
    ) {
      throw apiError(401, 'AGENT_SIGNATURE_INVALID', 'Assinatura ou validade do agente inválida.');
    }

    // Single-use nonce: a replayed envelope is refused even when everything
    // else about it still verifies.
    const accepted = await repositories.agents.consumeNonce(
      identity.agentId,
      hashNonce(envelope.nonce),
      new Date(envelope.expiresAt),
      now,
    );
    if (!accepted) throw apiError(409, 'AGENT_REPLAY_DETECTED', 'Replay detectado.');

    return { agentId: identity.agentId, serverInstanceId: identity.serverInstanceId };
  }

  /**
   * Hands the agent whatever work its granted capabilities may serve.
   *
   * An empty response is the normal idle answer and carries the interval the
   * agent should wait, so the agent backs off instead of polling hard.
   */
  app.post<{ Body: AgentEnvelope }>(
    '/agent/v1/work/claim',
    {
      schema: { body: AgentEnvelopeSchema },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const envelope = request.body;
      const identity = await authenticateAgent(request, envelope, 'job.lease-request');

      const payload = validateAgentWorkClaimPayload(envelope.payload.data);
      if (!payload.success) {
        throw apiError(400, 'AGENT_CLAIM_INVALID', 'Pedido de trabalho inválido.');
      }

      const now = clock();
      // Recovery belongs on the path every live agent already calls. Without
      // this, the repository knew how to reclaim an expired lease but nobody
      // invoked it, leaving both the job and its one-in-flight operation stuck
      // forever after a long copy or a process crash.
      const reclaimed = await repositories.agentTransport.reclaimExpiredLeases({ now });
      for (const stranded of reclaimed) {
        if (stranded.requeued) continue;
        const operation = await repositories.operations.findByJobId(stranded.jobId);
        if (
          operation === undefined ||
          (operation.status !== 'accepted' && operation.status !== 'running')
        ) {
          continue;
        }
        await repositories.operations.settle({
          operationId: operation.operationId,
          eventId: newId(),
          expectedVersion: operation.version,
          outcome: 'failed',
          failureCode: 'lease-expired',
          observedLifecycle: 'unknown',
          now,
        });
      }

      const leaseSeconds = Math.min(payload.value.leaseSeconds, maximumLeaseSeconds);
      let claimed;
      try {
        claimed = await repositories.agentTransport.claimWork({
          agentId: identity.agentId,
          capabilities: payload.value.capabilities,
          bootId: payload.value.bootId,
          maximumLeases: 4,
          leaseMs: leaseSeconds * 1_000,
          now,
          newLeaseId: newId,
        });
      } catch (error) {
        if (error instanceof AgentTransportError && error.code === 'capability-not-granted') {
          await audit({
            request,
            agentId: identity.agentId,
            action: 'agent.work.claim',
            correlationId: envelope.correlationId,
            outcome: 'denied',
            reason: 'capability not granted',
          });
          throw apiError(403, 'AGENT_CAPABILITY_DENIED', 'Capacidade não concedida.');
        }
        throw error;
      }

      if (claimed.length > 0) {
        await audit({
          request,
          agentId: identity.agentId,
          action: 'agent.work.claim',
          correlationId: envelope.correlationId,
          outcome: 'succeeded',
          reason: `leased ${String(claimed.length)}`,
        });
      }

      const leases: AgentWorkLease[] = claimed.map((work) => ({
        schemaVersion: 1,
        leaseId: work.leaseId,
        jobId: work.jobId,
        capability: work.capability,
        jobType: work.jobType,
        correlationId: work.correlationId,
        parameters: {
          resourceType: work.resourceType,
          resourceId: work.resourceId,
          expectedVersion: work.expectedVersion,
          ...(work.timeoutSeconds === undefined ? {} : { timeoutSeconds: work.timeoutSeconds }),
        },
        leasedAt: work.leasedAt,
        expiresAt: work.expiresAt,
        attempt: work.attempt,
      }));

      const response: AgentWorkClaimResponse = {
        schemaVersion: 1,
        leases,
        retryAfterSeconds: leases.length > 0 ? 1 : IDLE_RETRY_SECONDS,
      };
      return response;
    },
  );

  /**
   * Closes one lease and the job behind it.
   *
   * The lease is the unit of authority: a result for a lease this agent does
   * not hold, or one that already expired or was already reported, is refused
   * rather than applied to the job.
   */
  app.post<{ Body: AgentEnvelope }>(
    '/agent/v1/work/result',
    {
      schema: { body: AgentEnvelopeSchema },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const envelope = request.body;
      const identity = await authenticateAgent(request, envelope, 'job.event');

      const payload = validateAgentWorkResultPayload(envelope.payload.data);
      if (!payload.success) {
        throw apiError(400, 'AGENT_RESULT_INVALID', 'Resultado inválido.');
      }
      const result = payload.value;
      const now = clock();

      let settled;
      try {
        settled = await repositories.agentTransport.settleLease({
          leaseId: result.leaseId,
          agentId: identity.agentId,
          expectedJobId: result.jobId,
          outcome: result.outcome,
          ...(result.failureCode === null ? {} : { failureCode: result.failureCode }),
          now,
        });
      } catch (error) {
        if (!(error instanceof AgentTransportError)) throw error;
        await audit({
          request,
          agentId: identity.agentId,
          action: 'agent.work.result',
          correlationId: envelope.correlationId,
          outcome: 'failed',
          reason: error.code,
        });
        if (error.code === 'lease-expired') {
          throw apiError(409, 'AGENT_LEASE_EXPIRED', 'O lease expirou; o trabalho foi devolvido à fila.');
        }
        if (error.code === 'lease-job-mismatch') {
          throw apiError(409, 'AGENT_LEASE_JOB_MISMATCH', 'O resultado não corresponde ao lease.');
        }
        throw apiError(404, 'AGENT_LEASE_NOT_FOUND', 'Lease não encontrado para este agente.');
      }

      if (result.outcome === 'succeeded') {
        await repositories.jobs.complete(
          settled.jobId,
          identity.agentId,
          { outcome: 'succeeded', leaseId: result.leaseId },
          now,
        );
      } else {
        await repositories.jobs.fail(
          settled.jobId,
          identity.agentId,
          {
            code: `AGENT_${(result.failureCode ?? 'operation-failed').toUpperCase().replaceAll('-', '_')}`,
            message: 'The agent reported a failed operation.',
            retryable: false,
          },
          now,
        );
      }

      /**
       * Settles the durable operation the job was created for.
       *
       * The job completing and the operation completing were two different
       * facts, and only the first one was ever written. So the agent claimed
       * the work, started the server, released the lease and went back to
       * idle — and the operation stayed `running` forever, which made every
       * later control call answer `PROCESS_OPERATION_IN_FLIGHT`. In practice:
       * the panel could start a server and then never stop it.
       *
       * Not every job has an operation — an artifact inspection does not — so
       * an absent one is an ordinary outcome and not a failure.
       */
      const operation = await repositories.operations.findByJobId(settled.jobId);
      // `accepted` as well as `running`: whether anything got round to marking
      // it running does not change what the agent just reported, and the
      // transition table allows both. A settled one is final and is left
      // alone — a replayed result returns it rather than reopening it.
      if (
        operation !== undefined &&
        (operation.status === 'running' || operation.status === 'accepted')
      ) {
        await repositories.operations.settle({
          operationId: operation.operationId,
          eventId: newId(),
          expectedVersion: operation.version,
          outcome: result.outcome === 'succeeded' ? 'succeeded' : 'failed',
          ...(result.outcome === 'succeeded' || result.failureCode === null
            ? {}
            : { failureCode: operationFailureCodeFor(result.failureCode) }),
          observedLifecycle: result.observedLifecycle ?? 'unknown',
          ...(result.observedPid === null ? {} : { observedPid: result.observedPid }),
          ...(result.bootId === null ? {} : { bootId: result.bootId }),
          now,
        });
      }

      // An observation the agent made along the way is recorded through the
      // Phase 9.1 state, so the outbox event is written in the same
      // transaction as the state change rather than published separately.
      if (result.observedLifecycle !== null) {
        await repositories.processStates.observe({
          serverInstanceId: identity.serverInstanceId,
          eventId: newId(),
          lifecycle: result.observedLifecycle,
          observedBy: identity.agentId,
          ...(result.bootId === null ? {} : { bootId: result.bootId }),
          ...(result.observedPid === null ? {} : { observedPid: result.observedPid }),
          correlationId: envelope.correlationId,
          now,
        });
      }

      await audit({
        request,
        agentId: identity.agentId,
        action: 'agent.work.result',
        correlationId: envelope.correlationId,
        outcome: result.outcome === 'succeeded' ? 'succeeded' : 'failed',
        reason: result.failureCode ?? 'completed',
      });

      return { acceptedAt: now.toISOString(), jobId: settled.jobId };
    },
  );
}

import { createPublicKey, randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Type, type Static } from '@sinclair/typebox';
import {
  computeAgentPayloadHash,
  createOpaqueToken,
  hashPassword,
  hashOpaqueToken,
  isAgentEnvelopeFresh,
  safeEqualHex,
  sha256Hex,
  verifyAgentEnvelopeSignature,
  verifyPassword,
} from '@voidfall/authentication';
import {
  AgentEnvelopeSchema,
  SemanticVersionSchema,
  validateAgentEnvelope,
  validateAgentHeartbeatPayload,
  type ActorRef,
  type AgentEnvelope,
  type AuditEvent,
  type ResourceRef,
} from '@voidfall/contracts';
import { createRepositories, type Database, type Repositories } from '@voidfall/database';
import {
  hasPermission,
  type PanelPermission,
} from '@voidfall/permissions';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import {
  registerArtifactRoutes,
  type ArtifactPermission,
  type ArtifactQuarantineStore,
} from './artifact-routes.js';
import { registerAgentWorkRoutes } from './agent-work-routes.js';
import { registerProcessRoutes, type ProcessPermission } from './process-routes.js';
import {
  registerOperationalRoutes,
  type OperationalPermission,
} from './operational-routes.js';
import {
  registerConfigurationRoutes,
  type ConfigurationPermission,
  type ConfigurationValueReader,
} from './configuration-routes.js';
import {
  registerAuthorizedFileRoutes,
  type AuthorizedFilePermission,
} from './authorized-file-routes.js';
import type { AuthorizedFileService } from '@voidfall/authorized-files';
import { registerBackupRoutes, type BackupPermission } from './backup-routes.js';

const SESSION_COOKIE = 'voidfall_session';
const ABSOLUTE_SESSION_MS = 12 * 60 * 60_000;
const IDLE_SESSION_MS = 30 * 60_000;

interface AuthContext {
  readonly sessionId: string;
  readonly csrfTokenHash: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
  };
  readonly permissions: readonly PanelPermission[];
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    authContext?: AuthContext;
  }
}

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AgentTransportVerifier = (
  request: FastifyRequest,
  expectedCertificateFingerprint: string,
) => boolean | Promise<boolean>;

export interface BuildControlApiOptions {
  readonly database: Database;
  readonly clock?: () => Date;
  readonly cookieSecure?: boolean;
  readonly logger?: boolean;
  readonly agentTransportVerifier?: AgentTransportVerifier;
  /**
   * Authorized typed reader for configuration values. It is optional and
   * deny-by-default: without it the API reports values as unavailable rather
   * than caching, guessing or persisting them.
   */
  readonly configurationReader?: ConfigurationValueReader;
  /**
   * Store that receives an uploaded artifact as a stream. It is optional and
   * deny-by-default: without it an upload is refused rather than accepted into
   * a location nobody configured.
   */
  readonly artifactQuarantineStore?: ArtifactQuarantineStore;
  /**
   * Service holding the authorized file roots. It is optional and
   * deny-by-default: without it the file routes report themselves unavailable
   * rather than falling back to a root nobody declared.
   */
  readonly authorizedFiles?: AuthorizedFileService;
}

function requestCorrelationId(request: FastifyRequest): string {
  const supplied = request.headers['x-correlation-id'];
  return typeof supplied === 'string' && /^[0-9a-f-]{36}$/iu.test(supplied)
    ? supplied
    : randomUUID();
}

function anonymizeIp(ipAddress: string): string {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(ipAddress)) {
    const parts = ipAddress.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  const groups = ipAddress.split(':').filter(Boolean).slice(0, 4);
  return `${groups.join(':')}::/64`;
}

function normalizedFingerprint(value: string): string {
  return value.replaceAll(':', '').toLocaleLowerCase('en-US');
}

function defaultAgentTransportVerifier(
  request: FastifyRequest,
  expectedCertificateFingerprint: string,
): boolean {
  const socket = request.raw.socket as TLSSocket;
  if (socket.authorized !== true || typeof socket.getPeerCertificate !== 'function') return false;
  const certificate = socket.getPeerCertificate();
  const presented = certificate.fingerprint256;
  return (
    typeof presented === 'string' &&
    safeEqualHex(normalizedFingerprint(presented), expectedCertificateFingerprint)
  );
}

function auditEvent(input: {
  readonly request: FastifyRequest;
  readonly now: Date;
  readonly actor: ActorRef;
  readonly action: string;
  readonly resource: ResourceRef;
  readonly outcome: AuditEvent['outcome'];
  readonly reason?: string;
}): AuditEvent {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    occurredAt: input.now.toISOString(),
    correlationId: input.request.correlationId,
    actor: input.actor,
    source: 'api',
    action: input.action,
    resource: input.resource,
    outcome: input.outcome,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'strict',
    expires: expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'strict',
  });
}

const LoginBodySchema = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: 1_024 }),
  },
  { additionalProperties: false },
);
type LoginBody = Static<typeof LoginBodySchema>;

const AgentRegistrationBodySchema = Type.Object(
  {
    provisioningToken: Type.String({ minLength: 43, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' }),
    agentId: Type.String({ format: 'uuid' }),
    serverInstanceId: Type.String({ format: 'uuid' }),
    publicKeyPem: Type.String({ minLength: 64, maxLength: 4_096, pattern: '^-----BEGIN PUBLIC KEY-----' }),
    certificateFingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    softwareVersion: SemanticVersionSchema,
    // Closed capability list. A capability is a named, reviewed operation; it
    // never authorizes a generic executor.
    capabilities: Type.Array(
      Type.Union([Type.Literal('heartbeat'), Type.Literal('configuration.apply')]),
      { minItems: 1, maxItems: 2, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);
type AgentRegistrationBody = Static<typeof AgentRegistrationBodySchema>;

export async function buildControlApi(options: BuildControlApiOptions): Promise<FastifyInstance> {
  const clock = options.clock ?? (() => new Date());
  const cookieSecure = options.cookieSecure ?? true;
  const verifyAgentTransport = options.agentTransportVerifier ?? defaultAgentTransportVerifier;
  const repositories = createRepositories(options.database);
  // Keep the password verification path equivalent even when the account does not exist.
  const dummyPasswordHash = await hashPassword('voidfall-control-api-dummy-password');
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: false } },
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });

  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = requestCorrelationId(request);
    reply.header('x-correlation-id', request.correlationId);
  });

  app.setErrorHandler((error, request, reply) => {
    const frameworkStatusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const statusCode = error instanceof ApiError ? error.statusCode : frameworkStatusCode;
    const code =
      error instanceof ApiError
        ? error.code
        : statusCode === 400
          ? 'VALIDATION_ERROR'
          : 'INTERNAL_ERROR';
    const message =
      statusCode >= 500
        ? 'A operação não pôde ser concluída.'
        : error instanceof ApiError
          ? error.message
          : 'A solicitação é inválida.';
    void reply.code(statusCode).send({
      error: { code, message, correlationId: request.correlationId, details: [] },
    });
  });

  async function authenticate(request: FastifyRequest): Promise<void> {
    const rawToken = request.cookies[SESSION_COOKIE];
    if (rawToken === undefined) throw new ApiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    const now = clock();
    const session = await repositories.sessions.findActive(hashOpaqueToken(rawToken), now);
    if (session === undefined) throw new ApiError(401, 'SESSION_INVALID', 'Sessão inválida ou expirada.');
    const permissions = await repositories.permissions.forUser(session.userId);
    request.authContext = {
      sessionId: session.id,
      csrfTokenHash: session.csrfTokenHash,
      user: {
        id: session.user.id,
        email: session.user.emailNormalized,
        displayName: session.user.displayName,
      },
      permissions,
    };
    await repositories.sessions.touch(
      session.id,
      now,
      new Date(Math.min(Date.parse(session.expiresAt), now.getTime() + IDLE_SESSION_MS)),
    );
  }

  function requirePermission(permission: PanelPermission) {
    return async (request: FastifyRequest): Promise<void> => {
      const auth = request.authContext;
      if (auth === undefined) throw new ApiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
      if (hasPermission(auth.permissions, permission)) return;
      await repositories.audit.append(
        auditEvent({
          request,
          now: clock(),
          actor: { type: 'panel-user', id: auth.user.id },
          action: 'authorization.denied',
          resource: { type: 'permission', id: permission },
          outcome: 'denied',
          reason: 'deny-by-default RBAC policy',
        }),
      );
      throw new ApiError(403, 'PERMISSION_DENIED', 'Permissão insuficiente.');
    };
  }

  async function requireCsrf(request: FastifyRequest): Promise<void> {
    const auth = request.authContext;
    if (auth === undefined) throw new ApiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    const csrfToken = request.headers['x-csrf-token'];
    if (
      typeof csrfToken !== 'string' ||
      !safeEqualHex(hashOpaqueToken(csrfToken), auth.csrfTokenHash)
    ) {
      throw new ApiError(403, 'CSRF_INVALID', 'Token CSRF ausente ou inválido.');
    }
  }

  app.get('/health/live', async () => ({ status: 'ok', service: 'control-api' }));
  app.get('/health/ready', async () => {
    await options.database.query('SELECT 1 AS ready');
    return { status: 'ready', dependencies: { database: 'available' } };
  });

  app.post<{ Body: LoginBody }>(
    '/api/v1/auth/login',
    {
      schema: { body: LoginBodySchema },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const now = clock();
      const user = await repositories.users.findByEmail(request.body.email);
      const passwordValid = await verifyPassword(
        user?.passwordHash ?? dummyPasswordHash,
        request.body.password,
      );
      const locked =
        user !== undefined &&
        (user.status === 'disabled' ||
          (user.lockedUntil !== undefined && Date.parse(user.lockedUntil) > now.getTime()));
      if (user === undefined || !passwordValid || locked) {
        if (user !== undefined && !locked) await repositories.users.recordFailedLogin(user.id, now);
        await repositories.audit.append(
          auditEvent({
            request,
            now,
            actor: { type: 'system', id: 'anonymous' },
            action: 'auth.login',
            resource: { type: 'panel-session', id: 'new' },
            outcome: 'denied',
            reason: 'invalid credentials or locked account',
          }),
        );
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas.');
      }
      await repositories.users.recordSuccessfulLogin(user.id, now);
      const sessionToken = createOpaqueToken();
      const csrfToken = createOpaqueToken();
      const expiresAt = new Date(now.getTime() + ABSOLUTE_SESSION_MS);
      await repositories.sessions.create({
        userId: user.id,
        tokenHash: hashOpaqueToken(sessionToken),
        csrfTokenHash: hashOpaqueToken(csrfToken),
        now,
        expiresAt,
        idleExpiresAt: new Date(now.getTime() + IDLE_SESSION_MS),
        ipPrefix: anonymizeIp(request.ip),
        ...(request.headers['user-agent'] === undefined
          ? {}
          : { userAgentHash: sha256Hex(request.headers['user-agent']) }),
      });
      setSessionCookie(reply, sessionToken, cookieSecure, expiresAt);
      await repositories.audit.append(
        auditEvent({
          request,
          now,
          actor: { type: 'panel-user', id: user.id },
          action: 'auth.login',
          resource: { type: 'panel-session', id: 'current' },
          outcome: 'succeeded',
        }),
      );
      return {
        user: { id: user.id, email: user.emailNormalized, displayName: user.displayName },
        csrfToken,
        expiresAt: expiresAt.toISOString(),
      };
    },
  );

  app.get(
    '/api/v1/auth/session',
    { preHandler: [authenticate] },
    async (request) => ({
      user: request.authContext?.user,
      permissions: request.authContext?.permissions ?? [],
    }),
  );

  app.post(
    '/api/v1/auth/logout',
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const auth = request.authContext;
      if (auth === undefined) throw new ApiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
      const now = clock();
      await repositories.sessions.revoke(auth.sessionId, now);
      clearSessionCookie(reply, cookieSecure);
      await repositories.audit.append(
        auditEvent({
          request,
          now,
          actor: { type: 'panel-user', id: auth.user.id },
          action: 'auth.logout',
          resource: { type: 'panel-session', id: auth.sessionId },
          outcome: 'succeeded',
        }),
      );
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/servers',
    { preHandler: [authenticate, requirePermission('server.view')] },
    async () => ({ dataQuality: 'stored', servers: await repositories.servers.list() }),
  );

  app.get(
    '/api/v1/audit',
    { preHandler: [authenticate, requirePermission('audit.view')] },
    async () => ({ events: await repositories.audit.list(100) }),
  );

  app.post<{ Body: AgentRegistrationBody }>(
    '/agent/v1/register/complete',
    {
      schema: { body: AgentRegistrationBodySchema },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const now = clock();
      const agent = await repositories.agents.register({
        agentId: request.body.agentId,
        serverInstanceId: request.body.serverInstanceId,
        tokenHash: hashOpaqueToken(request.body.provisioningToken),
        publicKeyPem: request.body.publicKeyPem,
        certificateFingerprint: request.body.certificateFingerprint,
        softwareVersion: request.body.softwareVersion,
        capabilities: request.body.capabilities,
        now,
      });
      if (agent === undefined) {
        throw new ApiError(401, 'PROVISIONING_TOKEN_INVALID', 'Provisionamento inválido ou expirado.');
      }
      await repositories.audit.append(
        auditEvent({
          request,
          now,
          actor: { type: 'agent', id: agent.id },
          action: 'agent.registered',
          resource: { type: 'server-instance', id: agent.serverInstanceId },
          outcome: 'succeeded',
        }),
      );
      return reply.code(201).send({ agentId: agent.id, status: agent.status });
    },
  );

  app.post<{ Body: AgentEnvelope }>(
    '/agent/v1/heartbeat',
    { schema: { body: AgentEnvelopeSchema } },
    async (request) => {
      const now = clock();
      const structural = validateAgentEnvelope(request.body);
      if (!structural.success || request.body.kind !== 'heartbeat') {
        throw new ApiError(400, 'AGENT_ENVELOPE_INVALID', 'Envelope do agente inválido.');
      }
      const agent = await repositories.agents.findById(request.body.agentId);
      if (agent === undefined || agent.serverInstanceId !== request.body.serverInstanceId) {
        throw new ApiError(401, 'AGENT_IDENTITY_INVALID', 'Identidade do agente inválida.');
      }
      if (!(await verifyAgentTransport(request, agent.certificateFingerprint))) {
        throw new ApiError(401, 'AGENT_TRANSPORT_INVALID', 'Transporte autenticado do agente inválido.');
      }
      if (
        !safeEqualHex(computeAgentPayloadHash(request.body), request.body.payloadHash) ||
        !verifyAgentEnvelopeSignature(request.body, createPublicKey(agent.publicKeyPem)) ||
        !isAgentEnvelopeFresh(request.body, { now })
      ) {
        throw new ApiError(401, 'AGENT_SIGNATURE_INVALID', 'Assinatura ou validade do agente inválida.');
      }
      const heartbeat = validateAgentHeartbeatPayload(request.body.payload.data);
      if (!heartbeat.success) {
        throw new ApiError(400, 'HEARTBEAT_PAYLOAD_INVALID', 'Payload de heartbeat inválido.');
      }
      const nonceAccepted = await repositories.agents.consumeNonce(
        agent.id,
        hashOpaqueToken(request.body.nonce),
        new Date(request.body.expiresAt),
        now,
      );
      if (!nonceAccepted) throw new ApiError(409, 'AGENT_REPLAY_DETECTED', 'Replay detectado.');
      await repositories.agents.recordHeartbeat({
        agentId: agent.id,
        status: heartbeat.value.status,
        softwareVersion: heartbeat.value.softwareVersion,
        protocolVersion: heartbeat.value.protocolVersion,
        capabilities: heartbeat.value.capabilities,
        observedAt: new Date(heartbeat.value.observedAt),
      });
      return { acceptedAt: now.toISOString(), nextHeartbeatSeconds: 30 };
    },
  );

  registerConfigurationRoutes(app, {
    repositories,
    clock,
    authenticate,
    requirePermission: (permission: ConfigurationPermission) => requirePermission(permission),
    requireCsrf,
    apiError: (statusCode, code, message) => new ApiError(statusCode, code, message),
    audit: async (input) => {
      await repositories.audit.append(
        auditEvent({
          request: input.request,
          now: clock(),
          actor: input.actor,
          action: input.action,
          resource: { type: 'configuration-resource', id: input.resourceId },
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      );
    },
    ...(options.configurationReader === undefined
      ? {}
      : { configurationReader: options.configurationReader }),
  });

  registerAgentWorkRoutes(app, {
    repositories,
    clock,
    verifyAgentTransport,
    apiError: (statusCode, code, message) => new ApiError(statusCode, code, message),
    computePayloadHash: computeAgentPayloadHash,
    verifySignature: verifyAgentEnvelopeSignature,
    isFresh: isAgentEnvelopeFresh,
    safeEqualHex,
    hashNonce: hashOpaqueToken,
    newId: () => randomUUID(),
    audit: async (input) => {
      await repositories.audit.append({
        schemaVersion: 1,
        id: randomUUID(),
        occurredAt: clock().toISOString(),
        correlationId: input.correlationId,
        actor: { type: 'agent', id: input.agentId },
        source: 'agent',
        action: input.action,
        resource: { type: 'agent', id: input.agentId },
        outcome: input.outcome,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    },
  });

  registerProcessRoutes(app, {
    repositories,
    clock,
    authenticate,
    requirePermission: (permission: ProcessPermission) => requirePermission(permission),
    requireCsrf,
    apiError: (statusCode, code, message) => new ApiError(statusCode, code, message),
    newId: () => randomUUID(),
    audit: async (input) => {
      await repositories.audit.append(
        auditEvent({
          request: input.request,
          now: clock(),
          actor: input.actor,
          action: input.action,
          resource: { type: 'server-instance', id: input.serverId },
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      );
    },
  });

  registerOperationalRoutes(app, {
    repositories,
    authenticate,
    requirePermission: (permission: OperationalPermission) => requirePermission(permission),
    apiError: (statusCode, code, message) => new ApiError(statusCode, code, message),
  });

  registerBackupRoutes(app, {
    repositories,
    clock,
    authenticate,
    requirePermission: (permission: BackupPermission) => requirePermission(permission),
    requireCsrf,
    apiError: (statusCode, code, message) => new ApiError(statusCode, code, message),
    newId: () => randomUUID(),
    audit: async (input) => {
      await repositories.audit.append(
        auditEvent({
          request: input.request,
          now: clock(),
          actor: input.actor,
          action: input.action,
          resource: { type: 'server-instance', id: input.serverId },
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      );
    },
  });

  registerAuthorizedFileRoutes(app, {
    clock,
    authenticate,
    requirePermission: (permission: AuthorizedFilePermission) => requirePermission(permission),
    requireCsrf,
    apiError: (statusCode, code, message) => new ApiError(statusCode, code, message),
    audit: async (input) => {
      await repositories.audit.append(
        auditEvent({
          request: input.request,
          now: clock(),
          actor: input.actor,
          action: input.action,
          resource: { type: 'authorized-file', id: input.rootId },
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      );
    },
    ...(options.authorizedFiles === undefined
      ? {}
      : { authorizedFiles: options.authorizedFiles }),
  });

  registerArtifactRoutes(app, {
    repositories,
    clock,
    authenticate,
    requirePermission: (permission: ArtifactPermission) => requirePermission(permission),
    requireCsrf,
    apiError: (statusCode, code, message) => new ApiError(statusCode, code, message),
    audit: async (input) => {
      await repositories.audit.append(
        auditEvent({
          request: input.request,
          now: clock(),
          actor: input.actor,
          action: input.action,
          resource: { type: 'artifact-submission', id: input.submissionId },
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      );
    },
    ...(options.artifactQuarantineStore === undefined
      ? {}
      : { quarantineStore: options.artifactQuarantineStore }),
  });

  return app;
}

export type { ConfigurationValueReader } from './configuration-routes.js';
export type { ArtifactQuarantineStore } from './artifact-routes.js';

export function repositoriesFor(database: Database): Repositories {
  return createRepositories(database);
}

import { randomUUID, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Type, type Static } from '@sinclair/typebox';
import { BuildIdSchema, SemanticVersionSchema } from '@voidfall/contracts';
import { PinnedReleaseKeyring } from '@voidfall/launcher-protocol';
import {
  ReleaseRepositoryError,
  type FilesystemReleaseRepository,
} from '@voidfall/modpack-release';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

const ChannelParamsSchema = Type.Object(
  { channel: Type.Union([Type.Literal('beta'), Type.Literal('stable')]) },
  { additionalProperties: false },
);
type ChannelParams = Static<typeof ChannelParamsSchema>;

const ReleaseParamsSchema = Type.Object(
  { version: SemanticVersionSchema, buildId: BuildIdSchema },
  { additionalProperties: false },
);
type ReleaseParams = Static<typeof ReleaseParamsSchema>;

const ArtifactParamsSchema = Type.Object(
  { artifactId: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }) },
  { additionalProperties: false },
);
type ArtifactParams = Static<typeof ArtifactParamsSchema>;

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

class LauncherApiError extends Error {
  public constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BuildLauncherApiOptions {
  readonly repository: Pick<
    FilesystemReleaseRepository,
    'readArtifact' | 'readChannel' | 'readRelease'
  >;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
  readonly logger?: boolean;
}

function correlationId(request: FastifyRequest): string {
  const supplied = request.headers['x-correlation-id'];
  return typeof supplied === 'string' && /^[0-9a-f-]{36}$/iu.test(supplied)
    ? supplied
    : randomUUID();
}

function verifyKeyId(
  keys: ReadonlyMap<string, KeyObject>,
  keyId: string,
): void {
  if (!keys.has(keyId)) throw new LauncherApiError(503, 'SIGNATURE_UNTRUSTED', 'Documento indisponível.');
}

export async function buildLauncherApi(options: BuildLauncherApiOptions): Promise<FastifyInstance> {
  const keyring = new PinnedReleaseKeyring(options.publicKeys);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1_024,
    requestIdHeader: false,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: false } },
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = correlationId(request);
    reply.header('x-correlation-id', request.correlationId);
  });

  app.setErrorHandler((error, request, reply) => {
    const repositoryError = error instanceof ReleaseRepositoryError;
    const statusCode =
      error instanceof LauncherApiError
        ? error.statusCode
        : repositoryError && error.code === 'not-found'
          ? 404
          : repositoryError
            ? 503
            : typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
              ? error.statusCode
              : 500;
    const code =
      error instanceof LauncherApiError
        ? error.code
        : statusCode === 404
          ? 'NOT_FOUND'
          : statusCode === 400
            ? 'VALIDATION_ERROR'
            : 'RELEASE_UNAVAILABLE';
    void reply.code(statusCode).send({
      error: {
        code,
        message: statusCode === 404 ? 'Documento não encontrado.' : 'Release indisponível.',
        correlationId: request.correlationId,
      },
    });
  });

  app.get('/health/live', async () => ({ status: 'ok', service: 'launcher-api' }));

  app.get<{ Params: ChannelParams }>(
    '/launcher/v1/channels/:channel',
    { schema: { params: ChannelParamsSchema } },
    async (request, reply) => {
      const channel = await options.repository.readChannel(request.params.channel);
      if (channel === undefined) throw new LauncherApiError(404, 'CHANNEL_NOT_FOUND', 'Canal não encontrado.');
      verifyKeyId(options.publicKeys, channel.signature.keyId);
      if (!keyring.verifyChannel(channel)) {
        throw new LauncherApiError(503, 'SIGNATURE_INVALID', 'Documento indisponível.');
      }
      reply.header('cache-control', 'public, max-age=15, must-revalidate');
      return channel;
    },
  );

  app.get<{ Params: ReleaseParams }>(
    '/launcher/v1/releases/:version/:buildId/manifest',
    { schema: { params: ReleaseParamsSchema } },
    async (request, reply) => {
      const release = await options.repository.readRelease(
        request.params.version,
        request.params.buildId,
      );
      if (release === undefined) {
        throw new LauncherApiError(404, 'RELEASE_NOT_FOUND', 'Release não encontrada.');
      }
      verifyKeyId(options.publicKeys, release.manifest.signature.keyId);
      if (!keyring.verifyManifest(release.manifest)) {
        throw new LauncherApiError(503, 'SIGNATURE_INVALID', 'Documento indisponível.');
      }
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      reply.header('etag', `"sha256-${release.manifestSha256}"`);
      return release.manifest;
    },
  );

  app.get<{ Params: ArtifactParams }>(
    '/launcher/v1/artifacts/:artifactId',
    { schema: { params: ArtifactParamsSchema } },
    async (request, reply) => {
      const sha256 = request.params.artifactId.slice('sha256:'.length);
      const artifact = await options.repository.readArtifact(sha256);
      if (artifact === undefined) {
        throw new LauncherApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact não encontrado.');
      }
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', artifact.size);
      reply.header('etag', `"sha256-${artifact.sha256}"`);
      return reply.send(createReadStream(artifact.path));
    },
  );

  return app;
}

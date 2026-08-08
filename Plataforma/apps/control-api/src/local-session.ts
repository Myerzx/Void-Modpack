import { createOpaqueToken, hashOpaqueToken } from '@voidfall/authentication';
import { createRepositories, type Database } from '@voidfall/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Signing in without a password, in the local environment only.
 *
 * Authentication is deliberately deferred: this is a personal panel on
 * loopback, and typing a generated password to look at your own server is
 * friction that buys nothing until the product is something other people run.
 *
 * What is *not* deferred is the machinery. The session is a real row, the
 * cookie is real and HttpOnly, the CSRF token is real, and every route still
 * goes through `authenticate` and `requirePermission`. Nothing was loosened —
 * the operator simply does not have to prove they are the person sitting at
 * their own machine. When the product is launched, the login screen already
 * exists and this route stops being registered.
 *
 * Three guards, and all three must hold:
 *
 *  - registered only when the local environment asked for it;
 *  - refused unless the request came from loopback, so a bound interface or a
 *    proxy somebody puts in front cannot reach it;
 *  - refused outright when `NODE_ENV` is production.
 */

const SESSION_COOKIE = 'voidfall_session';
const ABSOLUTE_SESSION_MS = 12 * 60 * 60_000;
const IDLE_SESSION_MS = 30 * 60_000;

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface LocalSessionOptions {
  readonly database: Database;
  /** Email of the operator this environment signs in as. */
  readonly ownerEmail: string;
  /** Where to land after the cookie is set. */
  readonly landing?: string;
  readonly clock?: () => Date;
}

function isLoopback(request: FastifyRequest): boolean {
  // `request.ip` is what the socket reports; no forwarded header is trusted,
  // because trusting one is exactly how this route would stop being local.
  return LOOPBACK.has(request.ip);
}

export function registerLocalSession(app: FastifyInstance, options: LocalSessionOptions): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('The local session route cannot be registered in production.');
  }

  const repositories = createRepositories(options.database);
  const clock = options.clock ?? (() => new Date());
  const landing = options.landing ?? '/workspaces';

  const grant = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!isLoopback(request)) {
      return reply.code(403).send({
        error: {
          code: 'LOCAL_ONLY',
          message: 'Esta rota só responde na interface de loopback.',
          correlationId: request.correlationId,
          details: [],
        },
      });
    }

    const user = await repositories.users.findByEmail(options.ownerEmail);
    if (user === undefined) {
      return reply.code(503).send({
        error: {
          code: 'LOCAL_OWNER_MISSING',
          message: 'O operador local ainda não foi provisionado.',
          correlationId: request.correlationId,
          details: [],
        },
      });
    }

    const now = clock();
    const sessionToken = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + ABSOLUTE_SESSION_MS);

    await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashOpaqueToken(sessionToken),
      csrfTokenHash: hashOpaqueToken(csrfToken),
      csrfToken,
      now,
      expiresAt,
      idleExpiresAt: new Date(now.getTime() + IDLE_SESSION_MS),
      ipPrefix: '127.0.0.0/24',
    });
    await repositories.users.recordSuccessfulLogin(user.id, now);

    // Same cookie shape the real login sets. Nothing about the session is
    // weaker here; only the step that produced it is missing.
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      expires: expiresAt,
    });
    return reply.redirect(landing, 302);
  };

  app.get('/local/session', async (request, reply) => grant(request, reply));
}

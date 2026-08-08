import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, relative, resolve, sep } from 'node:path';

import type { FastifyInstance } from 'fastify';

/**
 * Serves the exported panel from the API itself.
 *
 * This is the answer to "how do panel and API end up on the same origin?".
 * The alternatives were a reverse proxy the operator configures, or CORS plus
 * a second origin — one is a tool to install and a file to maintain, the other
 * weakens the cookie rules that the session depends on. Serving the export
 * from the process that already answers `/api` makes same-origin a property of
 * the architecture instead of a deployment instruction.
 *
 * `SameSite=strict` on the session cookie keeps working for exactly this
 * reason: there is no cross-site request to make.
 *
 * No dependency is added for it. A static file server is a path resolution, a
 * content type and a stream, and the path resolution is the part worth owning:
 * every request is resolved against the export root and refused if it lands
 * outside, so no `..`, no absolute path and no symlink escape can read a file
 * that was never published.
 */

/** Paths the API answers itself. The panel never shadows them. */
const RESERVED_PREFIXES: readonly string[] = ['/api/', '/agent/', '/health/'];

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * Turns a request path into a file inside the root, or `null`.
 *
 * `null` is returned for anything that would leave the root. The check is on
 * the resolved path rather than on the requested one, so an encoded traversal
 * and a plain one are refused by the same rule.
 */
function resolveWithinRoot(root: string, decodedPath: string): string | null {
  if (decodedPath.includes('\0')) return null;

  const candidate = resolve(join(root, normalize(decodedPath)));
  const inside = relative(root, candidate);
  if (inside.startsWith('..') || (inside !== '' && resolve(root, inside) !== candidate)) {
    return null;
  }
  return candidate;
}

async function isFile(path: string | null): Promise<string | null> {
  if (path === null) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * The file that answers a path.
 *
 * Three shapes, tried in order, because Next's export produces all of them.
 * `/workspaces` is written as `workspaces.html` *and* as a `workspaces/`
 * directory holding the RSC payload — with no `index.html` in it. Stopping at
 * the directory answered 404 for every nested route, which is exactly what
 * happened the first time this was opened in a browser: the list worked and
 * every page below it did not.
 *
 * The query string is stripped once, here. Appending `.html` to a path that
 * still carried `?id=…` was the second half of the same bug.
 */
async function fileFor(root: string, requestUrl: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestUrl.split('?')[0] ?? '/');
  } catch {
    return null;
  }

  const exact = resolveWithinRoot(root, decoded);
  if (exact === null) return null;

  const asFile = await isFile(exact);
  if (asFile !== null) return asFile;

  const asHtml = await isFile(resolveWithinRoot(root, `${decoded.replace(/\/$/u, '')}.html`));
  if (asHtml !== null) return asHtml;

  return isFile(resolveWithinRoot(root, join(decoded, 'index.html')));
}

export interface StaticPanelOptions {
  /** Absolute path of the exported panel. */
  readonly root: string;
  /** Where `/` sends a signed-out visitor. */
  readonly entryPath?: string;
}

export function registerStaticPanel(app: FastifyInstance, options: StaticPanelOptions): void {
  const root = resolve(options.root);
  const entryPath = options.entryPath ?? '/entrar';

  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url;
    if (RESERVED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      // An unknown API route is a 404 about the API, not a missing page.
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Rota não encontrada.',
          correlationId: request.correlationId,
          details: [],
        },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Rota não encontrada.',
          correlationId: request.correlationId,
          details: [],
        },
      });
    }

    if (url === '/' || url === '') {
      return reply.redirect(entryPath, 302);
    }

    const file = await fileFor(root, url);
    if (file === null) {
      const fallback = await fileFor(root, '/404.html');
      if (fallback === null) {
        return reply.code(404).type('text/plain; charset=utf-8').send('Página não encontrada.');
      }
      return reply.code(404).type('text/html; charset=utf-8').send(createReadStream(fallback));
    }

    // Hashed asset paths are safe to cache hard; a document is not, or a
    // deploy would leave somebody on yesterday's panel.
    const immutable = file.includes(`${sep}_next${sep}static${sep}`);
    return reply
      .type(contentTypeOf(file))
      .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(createReadStream(file));
  });
}

/** Whether an exported panel exists at this path. */
export async function panelExportExists(root: string): Promise<boolean> {
  try {
    return (await stat(join(resolve(root), 'index.html'))).isFile();
  } catch {
    return false;
  }
}

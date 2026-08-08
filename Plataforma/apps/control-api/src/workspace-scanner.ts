import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { WorkspaceInventoryService } from '@voidfall/workspace-inventory';

import type { WorkspaceScanner } from './workspace-routes.js';

/**
 * Wires the real inventory engine into the API.
 *
 * Deliberately thin. Every decision about what a workspace contains, what a
 * mod declares and how far it can be edited already lives in
 * `@voidfall/workspace-inventory`; re-deciding any of it here would create a
 * second answer to maintain. This adapter exists so the route module can stay
 * free of a scanner import, and so the root policy has one home.
 */

export function createWorkspaceScanner(): WorkspaceScanner {
  const service = new WorkspaceInventoryService();
  return {
    async build(options) {
      return service.build({ root: options.root });
    },
  };
}

/**
 * Decides whether a directory may be registered, and in what form it is stored.
 *
 * It returns the canonical path rather than approving the one it was given.
 * The first version demanded that the operator type a canonical path and
 * refused anything else — which rejected `H:/pasta/servidor`, a perfectly
 * valid Windows path, and a trailing separator, and said only "use canonical
 * form" without saying what that meant. Making the caller satisfy a
 * normalisation the callee can do itself is the kind of contract that is
 * technically correct and miserable to use, so it normalises.
 *
 * A refusal names what was wrong and never echoes the path back. The panel
 * sent it, but an error message is read by more people than the one who typed
 * it, and a host path in a browser is a host path in a screenshot.
 *
 * Shape and existence only — this is not an allow-list. On a personal panel
 * the operator is the host owner, and a list of directories they already own
 * would be theatre. An allow-list belongs here the day this runs somewhere the
 * operator is not the owner.
 */
export async function defaultWorkspaceRootPolicy(
  rootPath: string,
): Promise<{ readonly rootPath: string } | { readonly refusal: string }> {
  if (!isAbsolute(rootPath)) {
    return { refusal: 'O caminho precisa ser absoluto.' };
  }
  if (rootPath.split(/[\\/]/u).some((segment) => segment === '..')) {
    // `..` is refused rather than resolved: a root that means something other
    // than what was typed is a root nobody reviewed.
    return { refusal: 'O caminho não pode conter "..".' };
  }
  const canonical = resolve(rootPath);
  try {
    const info = await stat(canonical);
    if (!info.isDirectory()) return { refusal: 'O caminho existe mas não é um diretório.' };
  } catch {
    return { refusal: 'O caminho não existe ou não pode ser lido por este processo.' };
  }
  return { rootPath: canonical };
}

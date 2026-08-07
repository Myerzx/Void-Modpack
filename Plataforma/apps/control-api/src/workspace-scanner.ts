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
 * Decides whether a directory may be registered as a workspace.
 *
 * A refusal names what was wrong and never echoes the path back — the panel
 * sent it, but an error message is read by more people than the one who typed
 * it, and a host path in a browser is a host path in a screenshot.
 *
 * This checks shape and existence only. It is not an allow-list: on a personal
 * panel the operator is the host owner, and pretending otherwise would be
 * security theatre over a directory they already own. An allow-list belongs
 * here the day this runs somewhere the operator is not the owner.
 */
export async function defaultWorkspaceRootPolicy(rootPath: string): Promise<string | null> {
  if (!isAbsolute(rootPath)) {
    return 'O caminho precisa ser absoluto.';
  }
  if (resolve(rootPath) !== rootPath.replace(/[\\/]+$/u, '') && resolve(rootPath) !== rootPath) {
    // A path with `..` in it resolves somewhere other than what was typed, and
    // storing the unresolved form would make the registry disagree with what
    // is actually read later.
    return 'O caminho precisa estar em forma canônica, sem "." ou "..".';
  }
  try {
    const info = await stat(rootPath);
    if (!info.isDirectory()) return 'O caminho existe mas não é um diretório.';
  } catch {
    return 'O caminho não existe ou não pode ser lido por este processo.';
  }
  return null;
}

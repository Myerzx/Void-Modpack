import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { detectServerRuntime, RuntimeDetectionError } from '@voidfall/minecraft-process';

/**
 * Points an instance at a directory and reads how the server there starts.
 *
 * Thin, like the other adapters. Which family a layout belongs to and which
 * launch plan it needs is decided in `minecraft-process`; this normalises the
 * path, refuses with a sentence an operator can act on, and hands back the
 * descriptor.
 *
 * The canonical directory is returned rather than the one it was given — the
 * same contract the workspace root policy settled on after demanding a
 * pre-normalised path and rejecting `H:/pasta/servidor`, which is a perfectly
 * valid Windows path.
 */

/** Reasons in the operator's language, keyed by the detector's own codes. */
const REFUSALS: Readonly<Record<string, string>> = {
  'directory-unreadable': 'O diretório não existe ou não pode ser lido por este processo.',
  'no-recognised-runtime':
    'Nenhum runtime reconhecido nesse diretório. Esperado Forge, NeoForge, Fabric, Paper, Spigot ou vanilla.',
  'multiple-candidate-jars':
    'Há mais de um servidor nesse diretório. Escolher um seria acertar metade das vezes.',
};

export async function detectServerRuntimeAt(rootPath: string): Promise<
  | {
      readonly rootPath: string;
      readonly runtime: {
        readonly family: string;
        readonly shape: string;
        readonly entry: string;
        readonly evidence: string;
      };
    }
  | { readonly refusal: string }
> {
  if (!isAbsolute(rootPath)) {
    return { refusal: 'O caminho precisa ser absoluto.' };
  }
  if (rootPath.split(/[\\/]/u).some((segment) => segment === '..')) {
    // Refused rather than resolved: a directory that means something other
    // than what was typed is a directory nobody reviewed.
    return { refusal: 'O caminho não pode conter "..".' };
  }

  const canonical = resolve(rootPath);
  try {
    if (!(await stat(canonical)).isDirectory()) {
      return { refusal: 'O caminho existe mas não é um diretório.' };
    }
  } catch {
    return { refusal: REFUSALS['directory-unreadable'] as string };
  }

  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  try {
    const runtime = await detectServerRuntime({ serverDirectory: canonical, platform });
    return { rootPath: canonical, runtime };
  } catch (error) {
    if (error instanceof RuntimeDetectionError) {
      const reason = REFUSALS[error.code] ?? error.code;
      // The detail names what was found, never where it was found.
      return { refusal: error.detail === null ? reason : `${reason} (${error.detail})` };
    }
    throw error;
  }
}

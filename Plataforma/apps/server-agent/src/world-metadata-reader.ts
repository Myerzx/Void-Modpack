import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  WORLD_METADATA_NBT_LIMITS,
  type TrustedCompressedWorldMetadataReader,
} from '@voidfall/ecosystem-analysis';

/** The only world metadata location this capability is allowed to open. */
export const REGISTERED_WORLD_METADATA_RELATIVE_PATH = 'world/level.dat' as const;

export type RegisteredWorldMetadataReadErrorCode =
  | 'invalid-registered-root'
  | 'world-metadata-not-found'
  | 'unsafe-filesystem-entry'
  | 'compressed-bytes-limit-exceeded'
  | 'filesystem-read-failed';

export class RegisteredWorldMetadataReadError extends Error {
  public readonly code: RegisteredWorldMetadataReadErrorCode;

  public constructor(code: RegisteredWorldMetadataReadErrorCode) {
    super(`server-agent-world-metadata:${code}`);
    this.name = 'RegisteredWorldMetadataReadError';
    this.code = code;
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/**
 * Reads gzip NBT bytes from a registered server workspace.
 *
 * Construction accepts one absolute root and no relative path. Every read uses
 * the committed literal `world/level.dat`, rejects links in that suffix and
 * bounds the file before handing it to the NBT parser. Errors contain codes
 * only, so a lease result or audit record cannot expose a host path.
 */
export class RegisteredWorldMetadataFileReader implements TrustedCompressedWorldMetadataReader {
  readonly #registeredRoot: string;

  public constructor(registeredRoot: string) {
    if (
      typeof registeredRoot !== 'string' ||
      !isAbsolute(registeredRoot) ||
      registeredRoot.includes('\u0000')
    ) {
      throw new RegisteredWorldMetadataReadError('invalid-registered-root');
    }
    this.#registeredRoot = registeredRoot;
  }

  public async readCompressedWorldMetadata(): Promise<Uint8Array> {
    const worldDirectory = join(this.#registeredRoot, 'world');
    const metadataPath = join(worldDirectory, 'level.dat');
    let handle: FileHandle | undefined;
    try {
      const [rootEntry, worldEntry, metadataEntry, canonicalRoot, canonicalMetadata] =
        await Promise.all([
          lstat(this.#registeredRoot),
          lstat(worldDirectory),
          lstat(metadataPath),
          realpath(this.#registeredRoot),
          realpath(metadataPath),
        ]);
      if (
        !rootEntry.isDirectory() || rootEntry.isSymbolicLink() ||
        !worldEntry.isDirectory() || worldEntry.isSymbolicLink() ||
        !metadataEntry.isFile() || metadataEntry.isSymbolicLink() ||
        !isWithin(canonicalRoot, canonicalMetadata)
      ) {
        throw new RegisteredWorldMetadataReadError('unsafe-filesystem-entry');
      }
      if (metadataEntry.size > WORLD_METADATA_NBT_LIMITS.maximumCompressedBytes) {
        throw new RegisteredWorldMetadataReadError('compressed-bytes-limit-exceeded');
      }

      // O_NOFOLLOW closes the final-component race on hosts that implement it.
      // Windows uses its portable read-only flag and is still protected by the
      // path/handle identity check immediately after opening.
      const flags = process.platform === 'win32'
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(metadataPath, flags);
      const [openedEntry, currentEntry, currentCanonicalMetadata] = await Promise.all([
        handle.stat(),
        lstat(metadataPath),
        realpath(metadataPath),
      ]);
      if (
        !openedEntry.isFile() ||
        !currentEntry.isFile() || currentEntry.isSymbolicLink() ||
        openedEntry.dev !== currentEntry.dev || openedEntry.ino !== currentEntry.ino ||
        currentCanonicalMetadata !== canonicalMetadata ||
        !isWithin(canonicalRoot, currentCanonicalMetadata)
      ) {
        throw new RegisteredWorldMetadataReadError('unsafe-filesystem-entry');
      }
      if (openedEntry.size > WORLD_METADATA_NBT_LIMITS.maximumCompressedBytes) {
        throw new RegisteredWorldMetadataReadError('compressed-bytes-limit-exceeded');
      }

      // Read at most one byte over the limit. A file that grows after stat can
      // be refused without ever allocating or reading an unbounded payload.
      const maximum = WORLD_METADATA_NBT_LIMITS.maximumCompressedBytes;
      const buffer = Buffer.allocUnsafe(maximum + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const read = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset > maximum) {
        throw new RegisteredWorldMetadataReadError('compressed-bytes-limit-exceeded');
      }
      return Uint8Array.from(buffer.subarray(0, offset));
    } catch (error) {
      if (error instanceof RegisteredWorldMetadataReadError) throw error;
      if (nodeErrorCode(error) === 'ENOENT') {
        throw new RegisteredWorldMetadataReadError('world-metadata-not-found');
      }
      if (nodeErrorCode(error) === 'ELOOP') {
        throw new RegisteredWorldMetadataReadError('unsafe-filesystem-entry');
      }
      throw new RegisteredWorldMetadataReadError('filesystem-read-failed');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

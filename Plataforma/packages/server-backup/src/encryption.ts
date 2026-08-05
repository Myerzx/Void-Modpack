import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';

import { BackupOperationError } from './types.js';

/**
 * Payload encryption at rest.
 *
 * A backup holds the whole world and every configuration file, which is the
 * most sensitive thing this platform stores. On disk it is also the copy least
 * protected by anything else: it outlives the server, it gets moved onto other
 * media, and it is what a stolen drive actually yields.
 *
 * AES-256-GCM, one random nonce per file. GCM authenticates as it decrypts, so
 * a modified ciphertext fails to decrypt rather than yielding altered plaintext
 * — the file-level counterpart of what the seal does for the manifest.
 *
 * The manifest keeps the **plaintext** digest and size. Verification therefore
 * proves the backup still restores to the same bytes, rather than proving only
 * that the ciphertext is intact, which is a much weaker claim.
 */

export const BACKUP_ENCRYPTION_ALGORITHM = 'aes-256-gcm' as const;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
/**
 * Files are encrypted whole rather than streamed. A backup entry is bounded by
 * the configured limits well below this, and reading whole means the auth tag is
 * checked before a single plaintext byte is written anywhere.
 */
export const MAXIMUM_ENCRYPTABLE_BYTES = 512 * 1_024 * 1_024;

export interface BackupEncryptionKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export function validateEncryptionKey(key: BackupEncryptionKey): BackupEncryptionKey {
  if (
    key === null ||
    typeof key !== 'object' ||
    typeof key.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(key.keyId) ||
    !(key.secret instanceof Uint8Array) ||
    key.secret.byteLength !== KEY_BYTES
  ) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  return key;
}

/**
 * The stored layout of an encrypted file: `nonce || ciphertext || tag`.
 *
 * Self-describing on purpose. A payload file carries everything needed to
 * decrypt it except the key, so a restore never has to consult a side table
 * that could drift out of step with the bytes.
 */
export function encryptBytes(key: BackupEncryptionKey, plaintext: Uint8Array): Buffer {
  const validated = validateEncryptionKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(BACKUP_ENCRYPTION_ALGORITHM, validated.secret, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

export function decryptBytes(key: BackupEncryptionKey, stored: Uint8Array): Buffer {
  const validated = validateEncryptionKey(key);
  if (stored.byteLength < NONCE_BYTES + TAG_BYTES) {
    throw new BackupOperationError('integrity-mismatch', 'verify');
  }
  const buffer = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  const nonce = buffer.subarray(0, NONCE_BYTES);
  const tag = buffer.subarray(buffer.byteLength - TAG_BYTES);
  const ciphertext = buffer.subarray(NONCE_BYTES, buffer.byteLength - TAG_BYTES);
  const decipher = createDecipheriv(BACKUP_ENCRYPTION_ALGORITHM, validated.secret, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // A failed tag is tampering or the wrong key. Neither is distinguishable
    // from outside, and neither should be.
    throw new BackupOperationError('integrity-mismatch', 'verify');
  }
}

/** Ciphertext is exactly this much longer than its plaintext. */
export function encryptedSizeFor(plaintextBytes: number): number {
  return plaintextBytes + NONCE_BYTES + TAG_BYTES;
}

export async function readWholeFile(path: string, maximumBytes: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (stat.size > maximumBytes) {
      throw new BackupOperationError('limit-exceeded', 'copy');
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof BackupOperationError) throw error;
    throw new BackupOperationError('filesystem-failure', 'copy');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface LockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

export type LocalProcessLockErrorCode = 'already-running' | 'lock-unavailable';

export class LocalProcessLockError extends Error {
  public constructor(
    readonly code: LocalProcessLockErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LocalProcessLock {
  readonly lockDirectory: string;
  release(): Promise<void>;
}

export interface LocalProcessLockOptions {
  readonly pid?: number;
  readonly clock?: () => Date;
  readonly newToken?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    // An inaccessible path still exists. Renaming remains the atomic arbiter.
    return true;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user may not signal it. Any
    // unexpected answer is treated conservatively as alive.
    return !isErrno(error, 'ESRCH');
  }
}

function parseOwner(serialized: string): LockOwner | null {
  try {
    const candidate = JSON.parse(serialized) as Partial<LockOwner>;
    if (
      candidate.schemaVersion !== 1 ||
      !Number.isInteger(candidate.pid) ||
      (candidate.pid ?? 0) <= 0 ||
      typeof candidate.token !== 'string' ||
      candidate.token.length === 0 ||
      typeof candidate.acquiredAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.acquiredAt))
    ) {
      return null;
    }
    return candidate as LockOwner;
  } catch {
    return null;
  }
}

async function readOwner(lockDirectory: string): Promise<LockOwner | null> {
  try {
    return parseOwner(await readFile(resolve(lockDirectory, 'owner.json'), 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

/**
 * Acquires the one local-process lease for a state directory.
 *
 * The candidate directory is complete before its atomic rename makes it
 * visible. A contender therefore never mistakes a live owner for a half-written
 * stale lock, and a crashed owner can be replaced once its PID is gone.
 */
export async function acquireLocalProcessLock(
  stateDirectory: string,
  options: LocalProcessLockOptions = {},
): Promise<LocalProcessLock> {
  const pid = options.pid ?? process.pid;
  const clock = options.clock ?? (() => new Date());
  const newToken = options.newToken ?? randomUUID;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const lockDirectory = `${resolve(stateDirectory)}.lock`;
  const token = newToken();
  const owner: LockOwner = {
    schemaVersion: 1,
    pid,
    token,
    acquiredAt: clock().toISOString(),
  };

  await mkdir(dirname(lockDirectory), { recursive: true });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `${lockDirectory}.candidate-${String(pid)}-${token}`;
    await rm(candidate, { recursive: true, force: true });
    await mkdir(candidate);
    await writeFile(resolve(candidate, 'owner.json'), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    try {
      await rename(candidate, lockDirectory);
      return {
        lockDirectory,
        async release(): Promise<void> {
          const current = await readOwner(lockDirectory);
          if (current?.token !== token) return;
          const released = `${lockDirectory}.released-${String(pid)}-${token}`;
          try {
            await rename(lockDirectory, released);
          } catch (error) {
            if (isErrno(error, 'ENOENT')) return;
            throw error;
          }
          await rm(released, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      if (!(await pathExists(lockDirectory))) throw error;
    }

    const current = await readOwner(lockDirectory);
    if (current === null) {
      throw new LocalProcessLockError(
        'lock-unavailable',
        `O lock local em ${lockDirectory} não contém um proprietário verificável.`,
      );
    }
    if (isProcessAlive(current.pid)) {
      throw new LocalProcessLockError(
        'already-running',
        `Outro ambiente local já usa este estado (PID ${String(current.pid)}).`,
      );
    }

    const stale = `${lockDirectory}.stale-${String(current.pid)}-${newToken()}`;
    try {
      await rename(lockDirectory, stale);
      await rm(stale, { recursive: true, force: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw new LocalProcessLockError(
        'lock-unavailable',
        `Não foi possível substituir o lock local obsoleto em ${lockDirectory}.`,
      );
    }
  }

  throw new LocalProcessLockError(
    'lock-unavailable',
    `Não foi possível adquirir o lock local em ${lockDirectory}.`,
  );
}

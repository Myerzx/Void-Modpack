import { randomUUID } from 'node:crypto';

import type {
  MinecraftProcessOwnershipRecord,
  ProcessOwnershipRepository,
} from '@voidfall/database';
import { ProcessOwnershipPersistenceError } from '@voidfall/database';
import {
  ProcessOwnershipConflictError,
  type ProcessOwnershipCoordinator,
  type ProcessOwnershipLease,
} from '@voidfall/minecraft-process';

export interface ProcessLivenessProbe {
  /** False is proof of absence; true also covers access denied/uncertain. */
  isAlive(pid: number): Promise<boolean>;
}

export class NodeProcessLivenessProbe implements ProcessLivenessProbe {
  public async isAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH is the one safe cleanup signal: no process currently has this
      // PID. EPERM and unknown platform errors remain uncertain and therefore
      // live for policy purposes; a false refusal is safer than a second JVM.
      return !(
        typeof error === 'object' &&
        error !== null &&
        (error as { readonly code?: unknown }).code === 'ESRCH'
      );
    }
  }
}

export type ProcessOwnershipReconciliation =
  | { readonly kind: 'vacant' }
  | { readonly kind: 'current'; readonly correlationId: string }
  | { readonly kind: 'dead-owner-cleared'; readonly correlationId: string }
  | { readonly kind: 'orphaned'; readonly correlationId: string };

export interface ProcessOwnershipReconciler {
  reconcile(): Promise<ProcessOwnershipReconciliation>;
}

export interface DurableProcessOwnershipCoordinatorOptions {
  readonly repository: ProcessOwnershipRepository;
  readonly serverInstanceId: string;
  readonly agentId: string;
  readonly agentBootId: string;
  readonly liveness?: ProcessLivenessProbe;
  readonly clock?: () => Date;
  readonly newOwnershipId?: () => string;
}

class DurableOwnershipLease implements ProcessOwnershipLease {
  #released = false;

  public constructor(
    private readonly ownershipId: string,
    private readonly repository: ProcessOwnershipRepository,
    private readonly clock: () => Date,
  ) {}

  public async attachPid(pid: number): Promise<void> {
    if (this.#released) throw new Error('Cannot attach a PID to released process ownership.');
    await this.repository.attachPid({ ownershipId: this.ownershipId, pid, now: this.#now() });
  }

  public async release(): Promise<void> {
    if (this.#released) return;
    await this.repository.release(this.ownershipId);
    this.#released = true;
  }

  #now(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('Process ownership clock returned an invalid date.');
    }
    return now;
  }
}

/**
 * Bridges the process adapter to the durable ownership fence.
 *
 * It deliberately cannot adopt. A record from another boot with a live PID,
 * a reused PID, or no PID at all is marked orphaned and blocks launch. Only a
 * PID proven absent is cleaned automatically.
 */
export class DurableProcessOwnershipCoordinator
  implements ProcessOwnershipCoordinator, ProcessOwnershipReconciler
{
  readonly #repository: ProcessOwnershipRepository;
  readonly #serverInstanceId: string;
  readonly #agentId: string;
  readonly #agentBootId: string;
  readonly #liveness: ProcessLivenessProbe;
  readonly #clock: () => Date;
  readonly #newOwnershipId: () => string;

  public constructor(options: DurableProcessOwnershipCoordinatorOptions) {
    this.#repository = options.repository;
    this.#serverInstanceId = options.serverInstanceId;
    this.#agentId = options.agentId;
    this.#agentBootId = options.agentBootId;
    this.#liveness = options.liveness ?? new NodeProcessLivenessProbe();
    this.#clock = options.clock ?? (() => new Date());
    this.#newOwnershipId = options.newOwnershipId ?? randomUUID;
  }

  public async acquire(): Promise<ProcessOwnershipLease> {
    // Three attempts cover the only expected races: owner disappears between
    // read/delete, or two agents contest an empty unique key. The database is
    // the arbiter; the loop never weakens the ownership decision.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#repository.find(this.#serverInstanceId);
      if (current !== undefined) {
        if ((await this.#clearIfDead(current)) !== 'not-dead') continue;
        try {
          await this.#orphan(current);
        } catch (error) {
          if (
            error instanceof ProcessOwnershipPersistenceError &&
            error.code === 'stale-ownership'
          ) {
            continue;
          }
          throw error;
        }
        throw new ProcessOwnershipConflictError();
      }

      const ownershipId = this.#newOwnershipId();
      const reserved = await this.#repository.reserve({
        serverInstanceId: this.#serverInstanceId,
        ownershipId,
        agentId: this.#agentId,
        agentBootId: this.#agentBootId,
        now: this.#now(),
      });
      if (reserved === undefined) continue;
      return new DurableOwnershipLease(ownershipId, this.#repository, this.#clock);
    }
    throw new ProcessOwnershipConflictError();
  }

  public async reconcile(): Promise<ProcessOwnershipReconciliation> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#repository.find(this.#serverInstanceId);
      if (current === undefined) return { kind: 'vacant' };
      if (current.agentBootId === this.#agentBootId) {
        return { kind: 'current', correlationId: current.ownershipId };
      }
      const dead = await this.#clearIfDead(current);
      if (dead === 'cleared') {
        return { kind: 'dead-owner-cleared', correlationId: current.ownershipId };
      }
      if (dead === 'changed') continue;
      try {
        await this.#orphan(current);
      } catch (error) {
        if (
          error instanceof ProcessOwnershipPersistenceError &&
          error.code === 'stale-ownership'
        ) {
          continue;
        }
        throw error;
      }
      return { kind: 'orphaned', correlationId: current.ownershipId };
    }
    throw new ProcessOwnershipConflictError();
  }

  async #clearIfDead(
    current: MinecraftProcessOwnershipRecord,
  ): Promise<'not-dead' | 'cleared' | 'changed'> {
    if (current.pid === null || (await this.#liveness.isAlive(current.pid))) return 'not-dead';
    return (await this.#repository.release(current.ownershipId)) ? 'cleared' : 'changed';
  }

  async #orphan(current: MinecraftProcessOwnershipRecord): Promise<void> {
    if (current.status === 'orphaned') return;
    await this.#repository.markOrphaned({ ownershipId: current.ownershipId, now: this.#now() });
  }

  #now(): Date {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('Process ownership clock returned an invalid date.');
    }
    return now;
  }
}

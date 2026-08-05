import { randomUUID } from 'node:crypto';

import type { AgentCapability, AgentWorkLease } from '@voidfall/contracts';

import type { AgentIdentity } from './agent-client.js';
import {
  AgentTransportRequestError,
  AgentWorkTransport,
  createWorkClaimEnvelope,
  createWorkResultEnvelope,
} from './work-transport.js';

/**
 * Supervises the outbound work loop.
 *
 * The loop is deliberately unhurried. When there is nothing to do the agent
 * waits the interval the control plane asked for rather than polling hard, and
 * on failure it backs off geometrically up to a ceiling. A restart is visible
 * to the control plane through a fresh boot id, so work leased by a previous
 * run is recognisable and can be reclaimed rather than duplicated.
 *
 * Nothing here decides what an operation means: a lease is dispatched to a
 * named handler for its capability, and a capability with no handler is
 * refused rather than improvised.
 */

export interface LeaseHandlerResult {
  readonly outcome: 'succeeded' | 'failed';
  readonly failureCode?: 'precondition-not-met' | 'operation-failed' | 'unsupported-parameters';
  readonly observedLifecycle?: 'unknown' | 'offline' | 'starting' | 'online' | 'stopping' | 'error';
  readonly observedPid?: number;
}

export type LeaseHandler = (lease: AgentWorkLease) => Promise<LeaseHandlerResult>;

export interface SupervisorOptions {
  readonly identity: AgentIdentity;
  readonly transport: AgentWorkTransport;
  /** One handler per capability the agent actually serves. */
  readonly handlers: Readonly<Partial<Record<AgentCapability, LeaseHandler>>>;
  readonly leaseSeconds?: number;
  readonly minimumBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onEvent?: (event: SupervisorEvent) => void;
}

export type SupervisorEvent =
  | { readonly kind: 'claimed'; readonly count: number }
  | { readonly kind: 'idle'; readonly retryAfterSeconds: number }
  | { readonly kind: 'handled'; readonly leaseId: string; readonly outcome: 'succeeded' | 'failed' }
  | { readonly kind: 'unauthorized'; readonly status: number }
  | { readonly kind: 'error'; readonly backoffMs: number }
  | { readonly kind: 'stopped' };

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_MINIMUM_BACKOFF_MS = 1_000;
const DEFAULT_MAXIMUM_BACKOFF_MS = 60_000;

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class AgentSupervisor {
  readonly #options: SupervisorOptions;
  /** A fresh identifier per run, so a restart is visible to the control plane. */
  readonly #bootId = randomUUID();
  #backoffMs: number;

  public constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#backoffMs = options.minimumBackoffMs ?? DEFAULT_MINIMUM_BACKOFF_MS;
  }

  public get bootId(): string {
    return this.#bootId;
  }

  /** Capabilities this agent can actually serve, from its handlers alone. */
  public get servedCapabilities(): readonly AgentCapability[] {
    return Object.entries(this.#options.handlers)
      .filter(([, handler]) => handler !== undefined)
      .map(([capability]) => capability as AgentCapability)
      .sort();
  }

  /**
   * Runs one cycle: claim, handle whatever came back, report each result.
   * Returns how long to wait before the next cycle.
   */
  public async runOnce(): Promise<number> {
    const clock = this.#options.clock ?? (() => new Date());
    const transport = this.#options.transport;
    const capabilities = this.servedCapabilities;
    if (capabilities.length === 0) {
      throw new Error('The supervisor has no capability handler to serve.');
    }

    const claim = await transport.claim(
      createWorkClaimEnvelope(this.#options.identity, {
        capabilities,
        leaseSeconds: this.#options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
        bootId: this.#bootId,
        issuedAt: clock(),
      }),
    );

    if (claim.leases.length === 0) {
      this.#options.onEvent?.({ kind: 'idle', retryAfterSeconds: claim.retryAfterSeconds });
      return claim.retryAfterSeconds * 1_000;
    }
    this.#options.onEvent?.({ kind: 'claimed', count: claim.leases.length });

    for (const lease of claim.leases) {
      const handler = this.#options.handlers[lease.capability];
      // A capability with no handler is refused explicitly. Improvising would
      // be exactly the generic executor this protocol exists to avoid.
      const result: LeaseHandlerResult =
        handler === undefined
          ? { outcome: 'failed', failureCode: 'unsupported-parameters' }
          : await handler(lease).catch(
              (): LeaseHandlerResult => ({ outcome: 'failed', failureCode: 'operation-failed' }),
            );

      await transport.report(
        createWorkResultEnvelope(this.#options.identity, {
          leaseId: lease.leaseId,
          jobId: lease.jobId,
          correlationId: lease.correlationId,
          outcome: result.outcome,
          ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
          ...(result.observedLifecycle === undefined
            ? {}
            : { observedLifecycle: result.observedLifecycle }),
          ...(result.observedPid === undefined ? {} : { observedPid: result.observedPid }),
          ...(result.observedPid === undefined ? {} : { bootId: this.#bootId }),
          issuedAt: clock(),
        }),
      );
      this.#options.onEvent?.({ kind: 'handled', leaseId: lease.leaseId, outcome: result.outcome });
    }

    // There was work, so look again promptly rather than waiting out the idle
    // interval — without spinning, because the next claim still round-trips.
    return 0;
  }

  /**
   * Runs until the signal aborts.
   *
   * A transport failure backs off geometrically to a ceiling instead of
   * hammering an API that is down, and the loop resumes cleanly once it
   * answers again — an agent that survives a control-plane restart is the
   * whole point.
   */
  public async run(signal: AbortSignal): Promise<void> {
    const sleep = this.#options.sleep ?? defaultSleep;
    const minimum = this.#options.minimumBackoffMs ?? DEFAULT_MINIMUM_BACKOFF_MS;
    const maximum = this.#options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS;

    while (!signal.aborted) {
      try {
        const waitMs = await this.runOnce();
        this.#backoffMs = minimum;
        if (waitMs > 0) await sleep(waitMs, signal);
      } catch (error) {
        if (error instanceof AgentTransportRequestError && error.status === 403) {
          // A withdrawn capability is not a transient fault; report it and keep
          // backing off rather than retrying in a tight loop.
          this.#options.onEvent?.({ kind: 'unauthorized', status: error.status });
        }
        this.#options.onEvent?.({ kind: 'error', backoffMs: this.#backoffMs });
        await sleep(this.#backoffMs, signal);
        this.#backoffMs = Math.min(this.#backoffMs * 2, maximum);
      }
    }
    this.#options.onEvent?.({ kind: 'stopped' });
  }
}

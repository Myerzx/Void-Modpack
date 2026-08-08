import type { ServerInstance } from '@voidfall/database';

export interface LocalAgentProcess {
  readonly description: string;
  run(signal: AbortSignal): Promise<void>;
}

export type LocalAgentFleetEvent =
  | {
      readonly kind: 'started';
      readonly serverInstanceId: string;
      readonly version: number;
      readonly description: string;
    }
  | { readonly kind: 'stopped'; readonly serverInstanceId: string }
  | { readonly kind: 'failed'; readonly serverInstanceId: string; readonly reason: string }
  | { readonly kind: 'sync-failed'; readonly reason: string };

interface ActiveAgent {
  readonly version: number;
  readonly abort: AbortController;
  readonly task: Promise<void>;
}

export interface LocalAgentFleetOptions {
  readonly listInstances: () => Promise<readonly ServerInstance[]>;
  readonly createProcess: (instance: ServerInstance) => Promise<LocalAgentProcess>;
  readonly synchronizationIntervalMs?: number;
  readonly onEvent?: (event: LocalAgentFleetEvent) => void;
}

/**
 * Keeps one logical agent per ServerInstance inside the single local process.
 *
 * AgentRuntime deliberately owns one instance. The fleet preserves that
 * boundary while letting a local host serve every imported/existing instance,
 * and replaces only the one whose version changed after a runtime link.
 */
export class LocalAgentFleet {
  readonly #options: LocalAgentFleetOptions;
  readonly #active = new Map<string, ActiveAgent>();
  #synchronizing: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #shuttingDown = false;

  public constructor(options: LocalAgentFleetOptions) {
    this.#options = options;
  }

  public get activeServerInstanceIds(): readonly string[] {
    return Object.freeze([...this.#active.keys()].sort());
  }

  public synchronize(): Promise<void> {
    if (this.#shuttingDown) return Promise.resolve();
    this.#synchronizing ??= this.#synchronize().finally(() => {
      this.#synchronizing = undefined;
    });
    return this.#synchronizing;
  }

  async #synchronize(): Promise<void> {
    const instances = await this.#options.listInstances();
    if (this.#shuttingDown) return;
    const desiredIds = new Set(instances.map((instance) => instance.id));

    for (const [serverInstanceId, active] of this.#active) {
      if (!desiredIds.has(serverInstanceId)) await this.#stop(serverInstanceId, active);
    }

    for (const instance of instances) {
      if (this.#shuttingDown) return;
      const current = this.#active.get(instance.id);
      if (current?.version === instance.version) continue;
      if (current !== undefined) await this.#stop(instance.id, current);

      try {
        const process = await this.#options.createProcess(instance);
        if (this.#shuttingDown) return;
        const abort = new AbortController();
        let active: ActiveAgent;
        const task = process
          .run(abort.signal)
          .catch((error: unknown) => {
            this.#options.onEvent?.({
              kind: 'failed',
              serverInstanceId: instance.id,
              reason: error instanceof Error ? error.message : 'unknown',
            });
          })
          .finally(() => {
            if (this.#active.get(instance.id) === active) this.#active.delete(instance.id);
          });
        active = { version: instance.version, abort, task };
        this.#active.set(instance.id, active);
        this.#options.onEvent?.({
          kind: 'started',
          serverInstanceId: instance.id,
          version: instance.version,
          description: process.description,
        });
      } catch (error) {
        this.#options.onEvent?.({
          kind: 'failed',
          serverInstanceId: instance.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  async #stop(serverInstanceId: string, active: ActiveAgent): Promise<void> {
    if (this.#active.get(serverInstanceId) !== active) return;
    active.abort.abort();
    await active.task;
    this.#active.delete(serverInstanceId);
    this.#options.onEvent?.({ kind: 'stopped', serverInstanceId });
  }

  public async start(signal: AbortSignal): Promise<void> {
    await this.synchronize();
    if (signal.aborted || this.#shuttingDown) {
      await this.shutdown();
      return;
    }
    const interval = this.#options.synchronizationIntervalMs ?? 2_000;
    this.#timer = setInterval(() => {
      void this.synchronize().catch((error: unknown) => {
        this.#options.onEvent?.({
          kind: 'sync-failed',
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
    }, interval);
    this.#timer.unref();

    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await this.shutdown();
  }

  public async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#synchronizing !== undefined) await this.#synchronizing.catch(() => undefined);
    await Promise.all([...this.#active].map(([id, active]) => this.#stop(id, active)));
  }
}

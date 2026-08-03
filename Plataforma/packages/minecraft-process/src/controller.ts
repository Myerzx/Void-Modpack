import type { MinecraftProcessAdapter, ProcessObservation } from './adapter.js';
import {
  validateProcessLaunchPlan,
  type ProcessLaunchPlan,
} from './launch-plan.js';
import type { ObservedProcessState } from './state-machine.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAXIMUM_REMEMBERED_OPERATIONS = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export type ProcessControlAction = 'start' | 'stop' | 'restart';

export type ProcessControlOutcome =
  | 'succeeded'
  | 'rejected'
  | 'timed-out'
  | 'failed';

export type ProcessControlFailureCode =
  | 'state-conflict'
  | 'operation-timeout'
  | 'unexpected-state'
  | 'adapter-error';

export type ProcessControlEventPhase =
  | 'accepted'
  | 'state-observed'
  | 'start-requested'
  | 'stop-requested'
  | 'succeeded'
  | 'rejected'
  | 'timed-out'
  | 'failed';

export interface ProcessControlRequest {
  readonly idempotencyKey: string;
  readonly action: ProcessControlAction;
}

export interface ProcessControlEvent {
  readonly sequence: number;
  readonly action: ProcessControlAction;
  readonly phase: ProcessControlEventPhase;
  readonly occurredAt: string;
  readonly state?: ObservedProcessState;
}

export interface ProcessControlResult {
  readonly idempotencyKey: string;
  readonly action: ProcessControlAction;
  readonly outcome: ProcessControlOutcome;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly events: readonly ProcessControlEvent[];
  readonly observation?: ProcessObservation;
  readonly failureCode?: ProcessControlFailureCode;
}

export type ProcessControlRequestErrorCode =
  | 'invalid-request'
  | 'invalid-idempotency-key'
  | 'controller-busy'
  | 'idempotency-conflict';

export class ProcessControlRequestError extends Error {
  override readonly name = 'ProcessControlRequestError';

  constructor(
    readonly code: ProcessControlRequestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MinecraftProcessControllerOptions {
  readonly adapter: MinecraftProcessAdapter;
  readonly launchPlan: ProcessLaunchPlan;
  readonly operationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maximumRememberedOperations?: number;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface ActiveOperation {
  readonly action: ProcessControlAction;
  readonly promise: Promise<ProcessControlResult>;
}

interface RememberedOperation {
  readonly action: ProcessControlAction;
  readonly result: ProcessControlResult;
}

interface WaitResult {
  readonly kind: 'reached' | 'terminal' | 'timed-out';
  readonly observation: ProcessObservation;
}

function validateBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} is outside the safe range.`);
  }
}

function copyLaunchPlan(plan: ProcessLaunchPlan): ProcessLaunchPlan {
  validateProcessLaunchPlan(plan);
  return Object.freeze({
    platform: plan.platform,
    executable: plan.executable,
    args: Object.freeze([...plan.args]),
    cwd: plan.cwd,
    shell: false,
    windowsHide: plan.windowsHide,
    stdio: Object.freeze(['pipe', 'pipe', 'pipe'] as const),
  });
}

function validateRequest(request: ProcessControlRequest): ProcessControlRequest {
  if (typeof request !== 'object' || request === null) {
    throw new ProcessControlRequestError('invalid-request', 'Process control request is invalid.');
  }
  if (request.action !== 'start' && request.action !== 'stop' && request.action !== 'restart') {
    throw new ProcessControlRequestError('invalid-request', 'Process control action is invalid.');
  }
  if (
    typeof request.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
  ) {
    throw new ProcessControlRequestError(
      'invalid-idempotency-key',
      'Process control idempotency key is invalid.',
    );
  }
  return Object.freeze({ action: request.action, idempotencyKey: request.idempotencyKey });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class MinecraftProcessController {
  readonly #adapter: MinecraftProcessAdapter;
  readonly #launchPlan: ProcessLaunchPlan;
  readonly #operationTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #maximumRememberedOperations: number;
  readonly #clock: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #remembered = new Map<string, RememberedOperation>();
  #active: Readonly<{ idempotencyKey: string } & ActiveOperation> | undefined;

  constructor(options: MinecraftProcessControllerOptions) {
    const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maximumRememberedOperations =
      options.maximumRememberedOperations ?? DEFAULT_MAXIMUM_REMEMBERED_OPERATIONS;
    validateBoundedInteger(operationTimeoutMs, 100, 300_000, 'operationTimeoutMs');
    validateBoundedInteger(pollIntervalMs, 10, 5_000, 'pollIntervalMs');
    validateBoundedInteger(
      maximumRememberedOperations,
      1,
      1_024,
      'maximumRememberedOperations',
    );
    if (pollIntervalMs > operationTimeoutMs) {
      throw new Error('pollIntervalMs cannot exceed operationTimeoutMs.');
    }
    this.#adapter = options.adapter;
    this.#launchPlan = copyLaunchPlan(options.launchPlan);
    this.#operationTimeoutMs = operationTimeoutMs;
    this.#pollIntervalMs = pollIntervalMs;
    this.#maximumRememberedOperations = maximumRememberedOperations;
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  execute(request: ProcessControlRequest): Promise<ProcessControlResult> {
    const acceptedRequest = validateRequest(request);
    const remembered = this.#remembered.get(acceptedRequest.idempotencyKey);
    if (remembered !== undefined) {
      this.#assertSameAction(acceptedRequest, remembered.action);
      return Promise.resolve(remembered.result);
    }

    if (this.#active !== undefined) {
      if (this.#active.idempotencyKey === acceptedRequest.idempotencyKey) {
        this.#assertSameAction(acceptedRequest, this.#active.action);
        return this.#active.promise;
      }
      throw new ProcessControlRequestError(
        'controller-busy',
        'Another process control operation is already active.',
      );
    }

    const running = this.#run(acceptedRequest);
    let tracked: Promise<ProcessControlResult>;
    tracked = running
      .then((result) => {
        this.#remember(acceptedRequest, result);
        return result;
      })
      .finally(() => {
        if (this.#active?.promise === tracked) this.#active = undefined;
      });
    this.#active = {
      idempotencyKey: acceptedRequest.idempotencyKey,
      action: acceptedRequest.action,
      promise: tracked,
    };
    return tracked;
  }

  async #run(request: ProcessControlRequest): Promise<ProcessControlResult> {
    const startedAt = this.#timestamp();
    const events: ProcessControlEvent[] = [];
    let observation: ProcessObservation | undefined;
    this.#record(events, request.action, 'accepted');

    try {
      observation = await this.#adapter.inspect();
      this.#record(events, request.action, 'state-observed', observation.state);
      if (request.action === 'start') {
        return await this.#runStart(request, startedAt, events, observation);
      }
      if (request.action === 'stop') {
        return await this.#runStop(request, startedAt, events, observation);
      }
      return await this.#runRestart(request, startedAt, events, observation);
    } catch {
      this.#record(events, request.action, 'failed', observation?.state);
      return this.#result(request, startedAt, events, 'failed', observation, 'adapter-error');
    }
  }

  async #runStart(
    request: ProcessControlRequest,
    startedAt: string,
    events: ProcessControlEvent[],
    initial: ProcessObservation,
  ): Promise<ProcessControlResult> {
    if (initial.state !== 'offline') {
      this.#record(events, request.action, 'rejected', initial.state);
      return this.#result(
        request,
        startedAt,
        events,
        'rejected',
        initial,
        'state-conflict',
      );
    }
    const started = await this.#adapter.start(this.#launchPlan);
    this.#record(events, request.action, 'start-requested', started.state);
    return this.#completeWait(
      request,
      startedAt,
      events,
      await this.#waitForState('online', started, request.action, events),
    );
  }

  async #runStop(
    request: ProcessControlRequest,
    startedAt: string,
    events: ProcessControlEvent[],
    initial: ProcessObservation,
  ): Promise<ProcessControlResult> {
    if (initial.state !== 'online') {
      this.#record(events, request.action, 'rejected', initial.state);
      return this.#result(
        request,
        startedAt,
        events,
        'rejected',
        initial,
        'state-conflict',
      );
    }
    const stopped = await this.#adapter.requestGracefulStop();
    this.#record(events, request.action, 'stop-requested', stopped.state);
    return this.#completeWait(
      request,
      startedAt,
      events,
      await this.#waitForState('offline', stopped, request.action, events),
    );
  }

  async #runRestart(
    request: ProcessControlRequest,
    startedAt: string,
    events: ProcessControlEvent[],
    initial: ProcessObservation,
  ): Promise<ProcessControlResult> {
    if (initial.state !== 'online') {
      this.#record(events, request.action, 'rejected', initial.state);
      return this.#result(
        request,
        startedAt,
        events,
        'rejected',
        initial,
        'state-conflict',
      );
    }
    const stopped = await this.#adapter.requestGracefulStop();
    this.#record(events, request.action, 'stop-requested', stopped.state);
    const offline = await this.#waitForState('offline', stopped, request.action, events);
    if (offline.kind !== 'reached') {
      return this.#completeWait(request, startedAt, events, offline);
    }

    const started = await this.#adapter.start(this.#launchPlan);
    this.#record(events, request.action, 'start-requested', started.state);
    return this.#completeWait(
      request,
      startedAt,
      events,
      await this.#waitForState('online', started, request.action, events),
    );
  }

  async #waitForState(
    target: 'online' | 'offline',
    initial: ProcessObservation,
    action: ProcessControlAction,
    events: ProcessControlEvent[],
  ): Promise<WaitResult> {
    let observation = initial;
    const classify = (): WaitResult['kind'] | undefined => {
      if (observation.state === target) return 'reached';
      if (observation.state === 'error') return 'terminal';
      if (target === 'online' && observation.state === 'offline') return 'terminal';
      return undefined;
    };
    const initialKind = classify();
    if (initialKind !== undefined) return { kind: initialKind, observation };

    const maximumPolls = Math.ceil(this.#operationTimeoutMs / this.#pollIntervalMs);
    for (let poll = 0; poll < maximumPolls; poll += 1) {
      await this.#sleep(this.#pollIntervalMs);
      const next = await this.#adapter.inspect();
      if (next.state !== observation.state) {
        this.#record(events, action, 'state-observed', next.state);
      }
      observation = next;
      const kind = classify();
      if (kind !== undefined) return { kind, observation };
    }
    return { kind: 'timed-out', observation };
  }

  #completeWait(
    request: ProcessControlRequest,
    startedAt: string,
    events: ProcessControlEvent[],
    wait: WaitResult,
  ): ProcessControlResult {
    if (wait.kind === 'reached') {
      this.#record(events, request.action, 'succeeded', wait.observation.state);
      return this.#result(request, startedAt, events, 'succeeded', wait.observation);
    }
    if (wait.kind === 'timed-out') {
      this.#record(events, request.action, 'timed-out', wait.observation.state);
      return this.#result(
        request,
        startedAt,
        events,
        'timed-out',
        wait.observation,
        'operation-timeout',
      );
    }
    this.#record(events, request.action, 'failed', wait.observation.state);
    return this.#result(
      request,
      startedAt,
      events,
      'failed',
      wait.observation,
      'unexpected-state',
    );
  }

  #result(
    request: ProcessControlRequest,
    startedAt: string,
    events: ProcessControlEvent[],
    outcome: ProcessControlOutcome,
    observation?: ProcessObservation,
    failureCode?: ProcessControlFailureCode,
  ): ProcessControlResult {
    const frozenEvents = Object.freeze(events.map((event) => Object.freeze({ ...event })));
    return Object.freeze({
      idempotencyKey: request.idempotencyKey,
      action: request.action,
      outcome,
      startedAt,
      completedAt: this.#timestamp(),
      events: frozenEvents,
      ...(observation === undefined ? {} : { observation }),
      ...(failureCode === undefined ? {} : { failureCode }),
    });
  }

  #record(
    events: ProcessControlEvent[],
    action: ProcessControlAction,
    phase: ProcessControlEventPhase,
    state?: ObservedProcessState,
  ): void {
    events.push({
      sequence: events.length + 1,
      action,
      phase,
      occurredAt: this.#timestamp(),
      ...(state === undefined ? {} : { state }),
    });
  }

  #timestamp(): string {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error('Process controller clock returned an invalid date.');
    }
    return value.toISOString();
  }

  #assertSameAction(request: ProcessControlRequest, action: ProcessControlAction): void {
    if (request.action !== action) {
      throw new ProcessControlRequestError(
        'idempotency-conflict',
        'Idempotency key was already used for another process control action.',
      );
    }
  }

  #remember(request: ProcessControlRequest, result: ProcessControlResult): void {
    this.#remembered.set(request.idempotencyKey, { action: request.action, result });
    while (this.#remembered.size > this.#maximumRememberedOperations) {
      const oldest = this.#remembered.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#remembered.delete(oldest);
    }
  }
}

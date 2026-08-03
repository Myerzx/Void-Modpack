export type ObservedProcessState =
  | 'unknown'
  | 'offline'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'error';

export type ProcessStateEvent =
  | 'launch-requested'
  | 'process-spawned'
  | 'boot-confirmed'
  | 'stop-requested'
  | 'process-exited'
  | 'fault-detected'
  | 'observation-reset';

const transitions: Readonly<
  Partial<Record<ObservedProcessState, Partial<Record<ProcessStateEvent, ObservedProcessState>>>>
> = {
  unknown: { 'process-exited': 'offline', 'fault-detected': 'error' },
  offline: { 'launch-requested': 'starting', 'fault-detected': 'error' },
  starting: {
    'process-spawned': 'starting',
    'boot-confirmed': 'online',
    'process-exited': 'error',
    'fault-detected': 'error',
  },
  online: { 'stop-requested': 'stopping', 'process-exited': 'error', 'fault-detected': 'error' },
  stopping: { 'process-exited': 'offline', 'fault-detected': 'error' },
  error: { 'observation-reset': 'unknown', 'process-exited': 'offline' },
};

export function transitionObservedProcessState(
  current: ObservedProcessState,
  event: ProcessStateEvent,
): ObservedProcessState {
  const next = transitions[current]?.[event];
  if (next === undefined) throw new Error(`Invalid process state transition: ${current} + ${event}.`);
  return next;
}

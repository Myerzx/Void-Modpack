import type { AgentCapability } from '@voidfall/contracts';

import type { AgentRuntimeConfiguration } from './runtime-config.js';

/**
 * Which capabilities this agent may announce, and why the others may not.
 *
 * The rule this file exists to enforce: **a capability is announced only when
 * every dependency it needs is present.** The supervisor claims work for the
 * capabilities it advertises, and the control plane will hand it exactly that
 * work. Advertising a capability whose repository, keys or process controller
 * are missing means claiming a job that can only be failed — and a job failed
 * for a reason the agent knew before it started is a job that should never have
 * been leased.
 *
 * Every unavailable capability carries a reason. "Not available" with no cause
 * is indistinguishable from a bug, and an operator has nothing to act on.
 */

export type CapabilityUnavailableReason =
  | 'no-handler-implemented'
  | 'no-authorized-root-configured'
  | 'no-configuration-guard-configured'
  | 'no-reviewed-resource-authorized'
  | 'no-backup-repository-configured'
  | 'no-process-controller-configured'
  | 'no-console-adapter-configured'
  | 'no-server-workspace-registered'
  | 'no-datapack-load-order-guard-configured'
  | 'no-datapack-load-order-reader-configured'
  | 'deliberately-disabled';

export interface CapabilityReadiness {
  readonly capability: AgentCapability;
  readonly available: boolean;
  /** `null` exactly when available. */
  readonly reason: CapabilityUnavailableReason | null;
}

export interface AgentReadiness {
  readonly bootId: string;
  readonly serverInstanceId: string;
  readonly capabilities: readonly CapabilityReadiness[];
  /** What the supervisor will actually claim work for. */
  readonly announced: readonly AgentCapability[];
  readonly schedulerEnabled: boolean;
}

/**
 * What the runtime has to offer, as facts rather than intentions.
 *
 * Each field is "this dependency was successfully constructed", not "the
 * operator asked for it". A repository that was configured but failed to open
 * must arrive here as `false`.
 */
export interface RuntimeDependencies {
  readonly hasAuthorizedFiles: boolean;
  /** The injected proof of exclusive offline access a configuration write needs. */
  readonly hasConfigurationGuard: boolean;
  /** The typed capability was constructed, not merely asked for. */
  readonly hasConfigurationCapability: boolean;
  readonly hasRegisteredServerWorkspace: boolean;
  readonly hasDatapackLoadOrderGuard: boolean;
  readonly hasDatapackLoadOrderCapability: boolean;
  readonly hasBackupService: boolean;
  readonly hasProcessController: boolean;
  readonly hasConsoleAdapter: boolean;
}

/**
 * Capabilities that exist in the contract but have no handler in this agent.
 *
 * Listed explicitly rather than inferred from the handler map, so the absence
 * is a recorded decision instead of an oversight nobody notices. Each is
 * unavailable for a stated reason:
 *
 *  - `heartbeat` is served by the identity client, not by a work lease.
 *  - `artifact.inspect` and `artifact.analyze` belong to the build worker,
 *    which is a different process with a different trust boundary.
 *  - `process.observe` has no handler yet; observation currently rides along
 *    with the control capability's receipt.
 *  - `process.force-kill` is deliberately absent. Killing a server can lose
 *    everything since the last save, and the capability is not implemented
 *    until an operator asks for it with the runtime actually connected.
 */
export const CAPABILITIES_WITHOUT_HANDLERS: Readonly<
  Partial<Record<AgentCapability, CapabilityUnavailableReason>>
> = Object.freeze({
  heartbeat: 'no-handler-implemented',
  'artifact.inspect': 'no-handler-implemented',
  'artifact.analyze': 'no-handler-implemented',
  'process.observe': 'no-handler-implemented',
  'process.force-kill': 'deliberately-disabled',
});

const ALL_CAPABILITIES: readonly AgentCapability[] = Object.freeze([
  'heartbeat',
  'configuration.apply',
  'artifact.inspect',
  'artifact.analyze',
  'process.observe',
  'process.control',
  'process.force-kill',
  'console.command',
  'backup.create',
  'backup.restore',
  'datapack-load-order.observe',
]);

/**
 * What each capability needs before it can honestly be announced.
 *
 * Returning `null` means "nothing beyond a handler". Anything else is the
 * reason it stays unavailable when that dependency is absent.
 */
function missingDependency(
  capability: AgentCapability,
  dependencies: RuntimeDependencies,
): CapabilityUnavailableReason | null {
  switch (capability) {
    case 'configuration.apply':
      // Three separate things, reported separately, because they are three
      // separate fixes. A missing root is a deployment that did not authorize
      // one; a missing guard is a host that cannot yet prove the server is
      // offline while the file is rewritten; a capability that would not build
      // means no reviewed resource applies to it. Collapsing them into one
      // "unavailable" would leave an operator guessing which to go and change.
      if (!dependencies.hasAuthorizedFiles) return 'no-authorized-root-configured';
      if (!dependencies.hasConfigurationGuard) return 'no-configuration-guard-configured';
      return dependencies.hasConfigurationCapability ? null : 'no-reviewed-resource-authorized';
    case 'process.control':
      return dependencies.hasProcessController ? null : 'no-process-controller-configured';
    case 'console.command':
      // A console command needs somewhere to send it *and* the exclusive lock
      // the process controller participates in.
      if (!dependencies.hasConsoleAdapter) return 'no-console-adapter-configured';
      return dependencies.hasProcessController ? null : 'no-process-controller-configured';
    case 'backup.create':
      return dependencies.hasBackupService ? null : 'no-backup-repository-configured';
    case 'backup.restore':
      // Restoring materialises a world and then boots it to verify. Without a
      // controller the verification cannot run, and an unverified restore is
      // one nobody knows the outcome of — so the capability stays unavailable
      // rather than being announced in a form that always ends "unverified".
      if (!dependencies.hasBackupService) return 'no-backup-repository-configured';
      return dependencies.hasProcessController ? null : 'no-process-controller-configured';
    case 'datapack-load-order.observe':
      if (!dependencies.hasRegisteredServerWorkspace) return 'no-server-workspace-registered';
      if (!dependencies.hasDatapackLoadOrderGuard) {
        return 'no-datapack-load-order-guard-configured';
      }
      return dependencies.hasDatapackLoadOrderCapability
        ? null
        : 'no-datapack-load-order-reader-configured';
    default:
      return null;
  }
}

export function evaluateReadiness(input: {
  readonly bootId: string;
  readonly configuration: AgentRuntimeConfiguration;
  readonly dependencies: RuntimeDependencies;
}): AgentReadiness {
  const capabilities = ALL_CAPABILITIES.map((capability): CapabilityReadiness => {
    const withoutHandler = CAPABILITIES_WITHOUT_HANDLERS[capability];
    if (withoutHandler !== undefined) {
      return { capability, available: false, reason: withoutHandler };
    }
    const missing = missingDependency(capability, input.dependencies);
    return missing === null
      ? { capability, available: true, reason: null }
      : { capability, available: false, reason: missing };
  });

  return Object.freeze({
    bootId: input.bootId,
    serverInstanceId: input.configuration.serverInstanceId,
    capabilities: Object.freeze(capabilities),
    announced: Object.freeze(
      capabilities.filter((entry) => entry.available).map((entry) => entry.capability),
    ),
    schedulerEnabled: input.configuration.schedulerEnabled,
  });
}

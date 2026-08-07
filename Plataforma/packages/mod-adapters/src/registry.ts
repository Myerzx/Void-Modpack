import { createMineAndSlashAdapter } from './mine-and-slash.js';
import type { ModConfigurationAdapter } from './types.js';

/**
 * The closed set of mods with an adapter.
 *
 * Closed on purpose. An adapter asserts that somebody looked at a real
 * configuration file and decided where its settings belong; a registry that
 * accepted arbitrary adapters would let that assertion be made by anyone, for
 * any mod, without anybody having looked.
 *
 * A mod with no adapter is not broken. It falls back to the generic inferred
 * form, which is the honest presentation of a file nobody has reviewed.
 */
const ADAPTERS: readonly ModConfigurationAdapter[] = Object.freeze([createMineAndSlashAdapter()]);

export function adapterForPath(path: string): ModConfigurationAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.appliesTo(path));
}

export function adapterForMod(modId: string): ModConfigurationAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.modId === modId);
}

export function registeredAdapterModIds(): readonly string[] {
  return Object.freeze(ADAPTERS.map((adapter) => adapter.modId));
}

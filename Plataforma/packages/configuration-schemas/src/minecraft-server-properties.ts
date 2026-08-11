import type { GenericConfigurationSchema } from './types.js';
import { freezeConfigurationSchema } from './validation.js';

export const MINECRAFT_SERVER_PROPERTIES_SCHEMA_ID = 'minecraft-server-properties';
export const MINECRAFT_SERVER_PROPERTIES_RESOURCE_ID = 'minecraft-server-properties';
export const MINECRAFT_SERVER_PROPERTIES_SCHEMA_VERSION = '1.0.0';
export const MINECRAFT_SERVER_PROPERTIES_FILE_PATH = 'server.properties';
export const MINECRAFT_SERVER_PROPERTIES_MAXIMUM_BYTES = 65_536;

/**
 * Security-only surface for the live Minecraft properties file.
 *
 * Values outside this closed list are preserved as opaque text by the
 * operational codec. They are not published, accepted in an API change set,
 * or regenerated. That includes rcon.password, the seed, addresses and every
 * mod-added property.
 */
export const MINECRAFT_SERVER_PROPERTIES_V1: GenericConfigurationSchema =
  freezeConfigurationSchema({
    schemaId: MINECRAFT_SERVER_PROPERTIES_SCHEMA_ID,
    resourceId: MINECRAFT_SERVER_PROPERTIES_RESOURCE_ID,
    schemaVersion: MINECRAFT_SERVER_PROPERTIES_SCHEMA_VERSION,
    format: 'java-properties',
    filePath: MINECRAFT_SERVER_PROPERTIES_FILE_PATH,
    fields: {
      'broadcast-rcon-to-ops': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: true,
        description: 'Broadcast RCON command output to online operators after restart.',
      },
      'enable-rcon': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: false,
        description: 'Expose the RCON listener after restart. Keep disabled unless explicitly reviewed.',
      },
      'enforce-secure-profile': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: true,
        description: 'Require Mojang-signed public keys for player profiles after restart.',
      },
      'enforce-whitelist': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: true,
        description: 'Remove players who are not allowlisted when the whitelist is reloaded.',
      },
      'online-mode': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: true,
        description: 'Authenticate player identities with Mojang after restart.',
      },
      'white-list': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: true,
        description: 'Allow only listed players after restart.',
      },
    },
  });

export const MINECRAFT_SERVER_PROPERTIES_POLICY_V1 = Object.freeze({
  owner: 'voidfall-product-owner',
  parser: 'preserving-minecraft-properties-v1',
  serializer: 'preserving-minecraft-properties-v1',
  maximumBytes: MINECRAFT_SERVER_PROPERTIES_MAXIMUM_BYTES,
  secretFields: Object.freeze([]) as readonly string[],
  userSuppliedPaths: false,
  preserveUnreviewedProperties: true,
  applyMode: 'offline-only',
  migration: 'strict-compatible-or-manual-review',
});

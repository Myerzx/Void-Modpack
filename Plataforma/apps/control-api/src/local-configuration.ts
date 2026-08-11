import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY,
} from '@voidfall/configuration-schemas';
import type { Repositories, ServerInstance } from '@voidfall/database';
import {
  FilesystemConfigurationService,
  createReviewedConfigurationResource,
  type OfflineExclusiveConfigurationGuard,
} from '@voidfall/server-configuration';

import type { ConfigurationValueReader } from './configuration-routes.js';

/**
 * Readers currently owned by the in-process local agents.
 *
 * The API is created before the fleet, so the registry is injected once and
 * populated as each linked ServerInstance gets its own agent. A lookup is by
 * server id only; neither a panel request nor a lease can provide a root.
 */
export class LocalConfigurationReaders implements ConfigurationValueReader {
  readonly #readers = new Map<string, FilesystemConfigurationService>();

  public register(serverInstanceId: string, reader: FilesystemConfigurationService): void {
    this.#readers.set(serverInstanceId, reader);
  }

  public unregister(serverInstanceId: string): void {
    this.#readers.delete(serverInstanceId);
  }

  public async readConfiguration(serverInstanceId: string, resourceId: string) {
    const reader = this.#readers.get(serverInstanceId);
    if (reader === undefined) throw new Error('local-configuration-reader-unavailable');
    const result = await reader.readConfiguration(resourceId);
    return { currentSha256: result.currentSha256, values: result.values };
  }
}

export interface LocalConfigurationRuntime {
  readonly authorizedFiles: {
    readonly rootId: 'server-config';
    readonly rootPath: string;
    readonly revisionRoot: string;
  };
  readonly guard: OfflineExclusiveConfigurationGuard;
  readonly reader: FilesystemConfigurationService;
  readonly resourceIds: readonly string[];
}

/**
 * Binds the reviewed configuration registry to one linked local instance.
 *
 * Registration is deliberately evidence driven. A new resource is persisted
 * only after the strict filesystem service has opened, bounded, parsed and
 * hashed the reviewed file while the Minecraft process is observed offline.
 * Existing registrations remain available when the file later becomes
 * malformed so the panel can report values as unavailable and a typed apply
 * can fail with a durable receipt instead of silently losing the resource.
 */
export async function provisionLocalConfiguration(input: {
  readonly instance: ServerInstance;
  readonly repositories: Repositories;
  readonly stateDirectory: string;
  readonly actorId: string;
  readonly guard: OfflineExclusiveConfigurationGuard;
  readonly now?: Date;
}): Promise<LocalConfigurationRuntime | null> {
  if (input.instance.runDirectory === null) return null;

  const reviewed = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.list();
  if (reviewed.length === 0) return null;

  const revisionRoot = join(
    input.stateDirectory,
    'configuration-revisions',
    input.instance.id,
  );
  await mkdir(revisionRoot, { recursive: true });
  const resources = reviewed.map((codec) =>
    createReviewedConfigurationResource(input.instance.runDirectory!, codec.schema.resourceId),
  );
  const reader = new FilesystemConfigurationService({
    repositoryRoot: revisionRoot,
    resources,
    guard: input.guard,
  });
  const createdAt = (input.now ?? new Date()).toISOString();
  const registered: string[] = [];

  for (const codec of reviewed) {
    const currentSchema = await input.repositories.configuration.currentSchema(
      codec.schema.schemaId,
    );
    if (currentSchema === undefined) {
      await input.repositories.configuration.registerSchema({
        revisionId: `local-${codec.schema.schemaId}-v1`,
        schema: codec.schema,
        expectedSchemaSha256: null,
        actorId: input.actorId,
        reasonCode: 'local-reviewed-bootstrap',
        createdAt,
      });
    } else if (currentSchema.schemaSha256 !== codec.schemaSha256) {
      throw new Error('local-configuration-schema-mismatch');
    }

    const persisted = await input.repositories.configuration.resource(
      input.instance.id,
      codec.schema.resourceId,
    );
    if (persisted !== undefined) {
      registered.push(codec.schema.resourceId);
      continue;
    }

    // Missing, linked or malformed files remain unregistered. The catalog
    // will state that fact without disclosing the path or parser detail.
    const observed = await reader.readConfiguration(codec.schema.resourceId).catch(() => null);
    if (observed === null) continue;
    await input.repositories.configuration.registerResource({
      serverInstanceId: input.instance.id,
      resourceId: codec.schema.resourceId,
      expectedSchemaSha256: codec.schemaSha256,
      initialCurrentSha256: observed.currentSha256,
      createdAt,
    });
    registered.push(codec.schema.resourceId);
  }

  if (registered.length === 0) return null;
  return {
    authorizedFiles: {
      rootId: 'server-config',
      rootPath: input.instance.runDirectory,
      revisionRoot,
    },
    guard: input.guard,
    reader,
    resourceIds: Object.freeze(registered.sort()),
  };
}

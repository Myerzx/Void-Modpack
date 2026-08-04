import {
  OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES,
  OPENLOADER_ADVANCED_OPTIONS_POLICY_V1,
  OPENLOADER_ADVANCED_OPTIONS_V1,
  parseOpenLoaderAdvancedOptions,
  serializeOpenLoaderAdvancedOptions,
} from './openloader-advanced-options.js';
import { hashConfigurationSchema } from './registry.js';
import type {
  GenericConfigurationSchema,
  GenericConfigurationValue,
} from './types.js';

export type TrustedConfigurationCodecId = 'openloader-advanced-options-v1';

export interface TrustedConfigurationCodec {
  readonly codecId: TrustedConfigurationCodecId;
  readonly schema: GenericConfigurationSchema;
  readonly schemaSha256: string;
  readonly maximumBytes: number;
  readonly applyMode: 'offline-only';
  /**
   * Reviewed field names whose value must never leave the trust boundary.
   * The list comes from the accepted policy, not from caller input, so a
   * reader cannot widen what it is allowed to publish.
   */
  readonly secretFields: readonly string[];
  readonly parse: (input: string) => Readonly<Record<string, GenericConfigurationValue>>;
  readonly serialize: (values: unknown) => string;
}

export type TrustedConfigurationRegistryErrorCode = 'resource-not-reviewed';

export class TrustedConfigurationRegistryError extends Error {
  public readonly code: TrustedConfigurationRegistryErrorCode;

  public constructor(code: TrustedConfigurationRegistryErrorCode) {
    super(`trusted-configuration-registry:${code}`);
    this.name = 'TrustedConfigurationRegistryError';
    this.code = code;
  }
}

function freezeCodec(codec: TrustedConfigurationCodec): TrustedConfigurationCodec {
  return Object.freeze({ ...codec, secretFields: Object.freeze([...codec.secretFields]) });
}

const OPENLOADER_ADVANCED_OPTIONS_CODEC_V1 = freezeCodec({
  codecId: 'openloader-advanced-options-v1',
  schema: OPENLOADER_ADVANCED_OPTIONS_V1,
  schemaSha256: hashConfigurationSchema(OPENLOADER_ADVANCED_OPTIONS_V1),
  maximumBytes: OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES,
  applyMode: OPENLOADER_ADVANCED_OPTIONS_POLICY_V1.applyMode,
  secretFields: OPENLOADER_ADVANCED_OPTIONS_POLICY_V1.secretFields,
  parse: (input) => Object.freeze({ ...parseOpenLoaderAdvancedOptions(input) }),
  serialize: serializeOpenLoaderAdvancedOptions,
});

/**
 * Closed product registry. It intentionally has no public registration method:
 * reviewed codecs are added in code together with fixtures and an ADR.
 */
export class TrustedConfigurationRegistry {
  readonly #byResourceId: ReadonlyMap<string, TrustedConfigurationCodec>;

  private constructor(codecs: readonly TrustedConfigurationCodec[]) {
    this.#byResourceId = new Map(codecs.map((codec) => [codec.schema.resourceId, codec]));
  }

  public static voidFall(): TrustedConfigurationRegistry {
    return new TrustedConfigurationRegistry([OPENLOADER_ADVANCED_OPTIONS_CODEC_V1]);
  }

  public require(resourceId: string): TrustedConfigurationCodec {
    const codec = this.#byResourceId.get(resourceId);
    if (codec === undefined) {
      throw new TrustedConfigurationRegistryError('resource-not-reviewed');
    }
    return codec;
  }

  public list(): readonly TrustedConfigurationCodec[] {
    return Object.freeze(
      [...this.#byResourceId.values()].sort((left, right) =>
        left.schema.resourceId.localeCompare(right.schema.resourceId, 'en'),
      ),
    );
  }
}

export const VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY =
  TrustedConfigurationRegistry.voidFall();

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export type ReviewedDatapackScalar = boolean | number | string;
export type ReviewedDatapackFieldType = 'boolean' | 'number' | 'string';

export interface ReviewedDatapackFieldDefinition {
  readonly path: string;
  readonly label: string;
  readonly type: ReviewedDatapackFieldType;
  readonly editable: boolean;
  readonly description: string | null;
}

export interface ReviewedDatapackSchema {
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly schemaSha256: string;
  readonly parserId: string;
  readonly namespace: string;
  readonly resourceType: string;
  readonly title: string;
  readonly maximumBytes: number;
  readonly fields: readonly ReviewedDatapackFieldDefinition[];
  readonly orderedRanges: readonly {
    readonly minimumPath: string;
    readonly maximumPath: string;
  }[];
}

export type ReviewedDatapackInspectionErrorCode =
  | 'content-too-large'
  | 'invalid-json'
  | 'schema-mismatch'
  | 'identity-mismatch';

export type ReviewedDatapackInspection =
  | {
      readonly success: true;
      readonly schema: ReviewedDatapackSchema;
      readonly values: Readonly<Record<string, ReviewedDatapackScalar>>;
    }
  | {
      readonly success: false;
      readonly schema: ReviewedDatapackSchema;
      readonly code: ReviewedDatapackInspectionErrorCode;
    };

export interface ReviewedDatapackChangeDecision {
  readonly path: string;
  readonly accepted: boolean;
  readonly code?:
    | ReviewedDatapackInspectionErrorCode
    | 'unknown-field'
    | 'field-readonly'
    | 'value-rejected'
    | 'range-order';
}

const GEAR_RARITY_FIELD_PATHS = Object.freeze([
  'affix_rarity_weight',
  'announce_in_chat',
  'base_stat_percents.max',
  'base_stat_percents.min',
  'can_have_runewords',
  'drops_uber_frags',
  'favor_loot_multi',
  'favor_needed',
  'favor_per_hour',
  'guid',
  'higher_rar',
  'is_unique_item',
  'item_model_data_num',
  'item_tier',
  'item_tier_power',
  'item_value_multi',
  'lootable_gear_tier',
  'map_lives',
  'map_resist_req',
  'map_tiers.max',
  'map_tiers.min',
  'map_xp_multi',
  'max_gems',
  'max_runes',
  'min_affixes',
  'min_lvl',
  'min_map_rarity_to_drop',
  'omens.affixes.max',
  'omens.affixes.min',
  'omens.normal.max',
  'omens.normal.min',
  'omens.runed.max',
  'omens.runed.min',
  'omens.specific_slots.max',
  'omens.specific_slots.min',
  'omens.stat_multi',
  'omens.unique.max',
  'omens.unique.min',
  'pot.total',
  'sockets.max',
  'sockets.min',
  'stat_percents.max',
  'stat_percents.min',
  'text_format',
  'type',
  'weight',
]);

const GEAR_RARITY_BOOLEAN_FIELDS = new Set([
  'announce_in_chat',
  'can_have_runewords',
  'drops_uber_frags',
  'is_unique_item',
]);

// These values are identities, registry references or enums whose allowed
// domain is not proven by the resource shape. They remain visible and traced,
// but the semantic editor must not offer a free-form replacement.
const GEAR_RARITY_READ_ONLY_FIELDS = new Set([
  'guid',
  'higher_rar',
  'item_model_data_num',
  'lootable_gear_tier',
  'min_map_rarity_to_drop',
  'text_format',
  'type',
]);

function labelOf(path: string): string {
  const leaf = path.split('.').at(-1) ?? path;
  return leaf
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toLocaleUpperCase('en-US') ?? ''}${part.slice(1)}`)
    .join(' ');
}

function fieldType(path: string): ReviewedDatapackFieldType {
  if (GEAR_RARITY_BOOLEAN_FIELDS.has(path)) return 'boolean';
  if (GEAR_RARITY_READ_ONLY_FIELDS.has(path) && path !== 'item_model_data_num') return 'string';
  return 'number';
}

function descriptionOf(path: string): string | null {
  if (path === 'guid') return 'Resource identity; it must match the JSON file name.';
  if (path.endsWith('.min')) return 'Lower endpoint of a reviewed minimum/maximum pair.';
  if (path.endsWith('.max')) return 'Upper endpoint of a reviewed minimum/maximum pair.';
  return null;
}

const GEAR_RARITY_FIELDS = Object.freeze(
  GEAR_RARITY_FIELD_PATHS.map((path) =>
    Object.freeze({
      path,
      label: labelOf(path),
      type: fieldType(path),
      editable: !GEAR_RARITY_READ_ONLY_FIELDS.has(path),
      description: descriptionOf(path),
    }),
  ),
);

const GEAR_RARITY_ORDERED_RANGES = Object.freeze([
  { minimumPath: 'base_stat_percents.min', maximumPath: 'base_stat_percents.max' },
  { minimumPath: 'map_tiers.min', maximumPath: 'map_tiers.max' },
  { minimumPath: 'omens.affixes.min', maximumPath: 'omens.affixes.max' },
  { minimumPath: 'omens.normal.min', maximumPath: 'omens.normal.max' },
  { minimumPath: 'omens.runed.min', maximumPath: 'omens.runed.max' },
  { minimumPath: 'omens.specific_slots.min', maximumPath: 'omens.specific_slots.max' },
  { minimumPath: 'omens.unique.min', maximumPath: 'omens.unique.max' },
  { minimumPath: 'sockets.min', maximumPath: 'sockets.max' },
  { minimumPath: 'stat_percents.min', maximumPath: 'stat_percents.max' },
].map((range) => Object.freeze(range)));

const GEAR_RARITY_SCHEMA_SHA256 = createHash('sha256').update(JSON.stringify({
  schemaId: 'mmorpg-gear-rarity',
  schemaVersion: '1.0.0',
  parserId: 'strict-json-object-v1',
  namespace: 'mmorpg',
  resourceType: 'mmorpg_gear_rarity',
  maximumBytes: 128 * 1024,
  fields: GEAR_RARITY_FIELDS,
  orderedRanges: GEAR_RARITY_ORDERED_RANGES,
})).digest('hex');

export const MINE_AND_SLASH_GEAR_RARITY_SCHEMA_V1: ReviewedDatapackSchema =
  Object.freeze({
    schemaId: 'mmorpg-gear-rarity',
    schemaVersion: '1.0.0',
    schemaSha256: GEAR_RARITY_SCHEMA_SHA256,
    parserId: 'strict-json-object-v1',
    namespace: 'mmorpg',
    resourceType: 'mmorpg_gear_rarity',
    title: 'Gear rarity',
    maximumBytes: 128 * 1024,
    fields: GEAR_RARITY_FIELDS,
    orderedRanges: GEAR_RARITY_ORDERED_RANGES,
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarMatches(value: unknown, type: ReviewedDatapackFieldType): value is ReviewedDatapackScalar {
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return typeof value === 'number' && Number.isFinite(value);
}

function flatten(
  value: unknown,
  prefix: string,
  output: Map<string, ReviewedDatapackScalar>,
): boolean {
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (isRecord(child)) {
      if (!flatten(child, path, output)) return false;
      continue;
    }
    if (
      typeof child !== 'boolean' &&
      typeof child !== 'string' &&
      !(typeof child === 'number' && Number.isFinite(child))
    ) {
      return false;
    }
    output.set(path, child);
  }
  return true;
}

function keyOccurrencesFromDocument(value: unknown, output = new Map<string, number>()): Map<string, number> {
  if (!isRecord(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    output.set(key, (output.get(key) ?? 0) + 1);
    keyOccurrencesFromDocument(child, output);
  }
  return output;
}

function keyOccurrencesFromSource(input: string): Map<string, number> | null {
  const output = new Map<string, number>();
  for (const match of input.matchAll(/"(?:\\.|[^"\\])*"\s*:/gu)) {
    const token = match[0].slice(0, match[0].lastIndexOf(':')).trim();
    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      return null;
    }
    if (typeof key !== 'string') return null;
    output.set(key, (output.get(key) ?? 0) + 1);
  }
  return output;
}

function sameOccurrences(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, count]) => right.get(key) === count)
  );
}

function resourceStem(resourcePath: string): string | null {
  const file = resourcePath.split('/').at(-1);
  if (file === undefined || !file.toLocaleLowerCase('en-US').endsWith('.json')) return null;
  return file.slice(0, -5);
}

function inspectWithSchema(
  schema: ReviewedDatapackSchema,
  resourcePath: string,
  content: string,
): ReviewedDatapackInspection {
  if (Buffer.byteLength(content, 'utf8') > schema.maximumBytes) {
    return Object.freeze({ success: false, schema, code: 'content-too-large' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return Object.freeze({ success: false, schema, code: 'invalid-json' });
  }
  if (!isRecord(parsed)) {
    return Object.freeze({ success: false, schema, code: 'schema-mismatch' });
  }
  const sourceKeys = keyOccurrencesFromSource(content);
  if (
    sourceKeys === null ||
    !sameOccurrences(sourceKeys, keyOccurrencesFromDocument(parsed))
  ) {
    return Object.freeze({ success: false, schema, code: 'schema-mismatch' });
  }
  const flattened = new Map<string, ReviewedDatapackScalar>();
  if (!flatten(parsed, '', flattened) || flattened.size !== schema.fields.length) {
    return Object.freeze({ success: false, schema, code: 'schema-mismatch' });
  }
  for (const field of schema.fields) {
    if (!flattened.has(field.path) || !scalarMatches(flattened.get(field.path), field.type)) {
      return Object.freeze({ success: false, schema, code: 'schema-mismatch' });
    }
  }
  const stem = resourceStem(resourcePath);
  if (stem === null || flattened.get('guid') !== stem) {
    return Object.freeze({ success: false, schema, code: 'identity-mismatch' });
  }
  return Object.freeze({
    success: true,
    schema,
    values: Object.freeze(Object.fromEntries(schema.fields.map((field) => {
      const value = flattened.get(field.path);
      if (value === undefined) throw new Error('reviewed-datapack-schema:unreachable-missing-field');
      return [field.path, value];
    }))),
  });
}

export class TrustedDatapackSchemaRegistry {
  readonly #schemas: readonly ReviewedDatapackSchema[];

  private constructor(schemas: readonly ReviewedDatapackSchema[]) {
    this.#schemas = Object.freeze([...schemas]);
  }

  public static voidFall(): TrustedDatapackSchemaRegistry {
    return new TrustedDatapackSchemaRegistry([MINE_AND_SLASH_GEAR_RARITY_SCHEMA_V1]);
  }

  public match(namespace: string, resourceType: string): ReviewedDatapackSchema | null {
    return this.#schemas.find(
      (schema) => schema.namespace === namespace && schema.resourceType === resourceType,
    ) ?? null;
  }

  public require(schemaId: string): ReviewedDatapackSchema {
    const schema = this.#schemas.find((entry) => entry.schemaId === schemaId);
    if (schema === undefined) throw new Error('reviewed-datapack-schema:not-reviewed');
    return schema;
  }

  public inspect(input: {
    readonly schemaId: string;
    readonly resourcePath: string;
    readonly content: string;
  }): ReviewedDatapackInspection {
    return inspectWithSchema(this.require(input.schemaId), input.resourcePath, input.content);
  }

  public validateChanges(input: {
    readonly schemaId: string;
    readonly resourcePath: string;
    readonly content: string;
    readonly changes: readonly { readonly path: string; readonly value: unknown }[];
  }): readonly ReviewedDatapackChangeDecision[] {
    const inspected = this.inspect(input);
    if (!inspected.success) {
      return Object.freeze(input.changes.map((change) => Object.freeze({
        path: change.path,
        accepted: false,
        code: inspected.code,
      })));
    }
    const definitions = new Map(inspected.schema.fields.map((field) => [field.path, field]));
    const proposed = new Map(Object.entries(inspected.values));
    const decisions: ReviewedDatapackChangeDecision[] = [];
    for (const change of input.changes) {
      const field = definitions.get(change.path);
      if (field === undefined) {
        decisions.push({ path: change.path, accepted: false, code: 'unknown-field' });
      } else if (!field.editable) {
        decisions.push({ path: change.path, accepted: false, code: 'field-readonly' });
      } else if (!scalarMatches(change.value, field.type)) {
        decisions.push({ path: change.path, accepted: false, code: 'value-rejected' });
      } else {
        proposed.set(change.path, change.value);
        decisions.push({ path: change.path, accepted: true });
      }
    }
    for (const range of inspected.schema.orderedRanges) {
      const minimum = proposed.get(range.minimumPath);
      const maximum = proposed.get(range.maximumPath);
      if (typeof minimum !== 'number' || typeof maximum !== 'number' || minimum <= maximum) continue;
      for (const path of [range.minimumPath, range.maximumPath]) {
        const index = decisions.findIndex((decision) => decision.path === path && decision.accepted);
        if (index >= 0) decisions[index] = { path, accepted: false, code: 'range-order' };
      }
    }
    return Object.freeze(decisions.map((decision) => Object.freeze(decision)));
  }

  public list(): readonly ReviewedDatapackSchema[] {
    return this.#schemas;
  }
}

export const VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY =
  TrustedDatapackSchemaRegistry.voidFall();

import { Type, type Static } from '@sinclair/typebox';

export const ContractSchemaVersion = Type.Literal(1);

export const UuidSchema = Type.String({ format: 'uuid' });

export const IsoDateTimeSchema = Type.String({ format: 'date-time' });

export const Sha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });

export const Base64UrlSchema = Type.String({
  minLength: 43,
  maxLength: 512,
  pattern: '^[A-Za-z0-9_-]+$',
});

export const SlugSchema = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
});

export const RelativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: '^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[^\\u0000\\r\\n]+$',
});

export const FileNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^(?!\\.{1,2}$)(?!.*[/\\\\])[^\\u0000\\r\\n]+$',
});

export const SemanticVersionSchema = Type.String({
  maxLength: 128,
  pattern:
    '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$',
});

export const BuildIdSchema = Type.String({
  maxLength: 96,
  pattern: '^build-[0-9]{8}-[0-9]{6}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$',
});

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// JSON Schema validates documents in the JSON data model. The empty subschema
// therefore represents any JSON value without introducing a recursive $id that
// would collide when the same contract contains multiple extensible objects.
export const JsonValueSchema = Type.Unsafe<JsonValue>({});

export const JsonObjectSchema = Type.Unsafe<JsonObject>({
  type: 'object',
  additionalProperties: true,
});

export const ResourceRefSchema = Type.Object(
  {
    type: SlugSchema,
    id: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const ActorRefSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('panel-user'),
      Type.Literal('minecraft-player'),
      Type.Literal('agent'),
      Type.Literal('worker'),
      Type.Literal('system'),
    ]),
    id: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const SignatureSchema = Type.Object(
  {
    algorithm: Type.Literal('Ed25519'),
    keyId: SlugSchema,
    value: Base64UrlSchema,
  },
  { additionalProperties: false },
);

export type ResourceRef = Static<typeof ResourceRefSchema>;
export type ActorRef = Static<typeof ActorRefSchema>;
export type Signature = Static<typeof SignatureSchema>;

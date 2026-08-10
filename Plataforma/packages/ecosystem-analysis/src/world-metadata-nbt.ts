import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import type { TrustedWorldMetadataDatapackLoadOrderReader } from './datapack-load-order-observer.js';
import type { AnalyzedDatapack, EcosystemAnalysis } from './types.js';

export const WORLD_METADATA_DATAPACK_SELECTION_SCHEMA_VERSION = 1 as const;

export const WORLD_METADATA_NBT_LIMITS = Object.freeze({
  maximumCompressedBytes: 8 * 1024 * 1024,
  maximumDecompressedBytes: 32 * 1024 * 1024,
  maximumDepth: 64,
  maximumTags: 100_000,
  maximumListEntries: 4_096,
  maximumArrayEntries: 1_048_576,
  maximumStringBytes: 16_384,
  maximumPackIdCharacters: 512,
});

export interface WorldMetadataDatapackSelection {
  readonly schemaVersion: typeof WORLD_METADATA_DATAPACK_SELECTION_SCHEMA_VERSION;
  readonly evidenceSha256: string;
  /** Native Minecraft order: the last enabled ID has the highest priority. */
  readonly order: 'lowest-priority-first';
  readonly enabledPackIds: readonly string[];
  readonly disabledPackIds: readonly string[];
}

export type WorldMetadataNbtReadErrorCode =
  | 'compressed-bytes-limit-exceeded'
  | 'decompressed-bytes-limit-exceeded'
  | 'invalid-gzip'
  | 'invalid-nbt'
  | 'nbt-limit-exceeded'
  | 'world-metadata-schema-mismatch'
  | 'invalid-pack-id'
  | 'duplicate-pack-id'
  | 'unmapped-active-openloader-pack'
  | 'no-observed-openloader-datapacks';

export class WorldMetadataNbtReadError extends Error {
  public readonly code: WorldMetadataNbtReadErrorCode;

  public constructor(code: WorldMetadataNbtReadErrorCode) {
    super(`ecosystem-analysis:${code}`);
    this.name = 'WorldMetadataNbtReadError';
    this.code = code;
  }
}

interface SelectionCapture {
  enabledPackIds: string[] | null;
  disabledPackIds: string[] | null;
}

function isExactPath(path: readonly string[], expected: readonly string[]): boolean {
  return path.length === expected.length && path.every((segment, index) => segment === expected[index]);
}

function isTargetContainer(path: readonly string[]): boolean {
  return isExactPath(path, ['Data']) || isExactPath(path, ['Data', 'DataPacks']);
}

function isTargetList(path: readonly string[]): path is readonly ['Data', 'DataPacks', 'Enabled' | 'Disabled'] {
  return isExactPath(path, ['Data', 'DataPacks', 'Enabled']) ||
    isExactPath(path, ['Data', 'DataPacks', 'Disabled']);
}

function addWithoutOverflow(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) throw new WorldMetadataNbtReadError('invalid-nbt');
  return result;
}

class NbtCursor {
  readonly #bytes: Buffer;
  #offset = 0;
  #tagCount = 0;

  public constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  public get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  public parseSelection(): SelectionCapture {
    const capture: SelectionCapture = { enabledPackIds: null, disabledPackIds: null };
    const rootType = this.#u1();
    if (rootType !== 10) throw new WorldMetadataNbtReadError('world-metadata-schema-mismatch');
    this.#countTags(1);
    this.#modifiedUtf8();
    this.#payload(rootType, 1, [], capture);
    if (this.remaining !== 0) throw new WorldMetadataNbtReadError('invalid-nbt');
    return capture;
  }

  #ensure(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || addWithoutOverflow(this.#offset, count) > this.#bytes.length) {
      throw new WorldMetadataNbtReadError('invalid-nbt');
    }
  }

  #skip(count: number): void {
    this.#ensure(count);
    this.#offset += count;
  }

  #u1(): number {
    this.#ensure(1);
    const value = this.#bytes[this.#offset];
    this.#offset += 1;
    if (value === undefined) throw new WorldMetadataNbtReadError('invalid-nbt');
    return value;
  }

  #u2(): number {
    this.#ensure(2);
    const value = this.#bytes.readUInt16BE(this.#offset);
    this.#offset += 2;
    return value;
  }

  #i4(): number {
    this.#ensure(4);
    const value = this.#bytes.readInt32BE(this.#offset);
    this.#offset += 4;
    return value;
  }

  #countTags(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new WorldMetadataNbtReadError('invalid-nbt');
    this.#tagCount = addWithoutOverflow(this.#tagCount, count);
    if (this.#tagCount > WORLD_METADATA_NBT_LIMITS.maximumTags) {
      throw new WorldMetadataNbtReadError('nbt-limit-exceeded');
    }
  }

  #depth(depth: number): void {
    if (depth > WORLD_METADATA_NBT_LIMITS.maximumDepth) {
      throw new WorldMetadataNbtReadError('nbt-limit-exceeded');
    }
  }

  #length(limit: number): number {
    const length = this.#i4();
    if (length < 0) throw new WorldMetadataNbtReadError('invalid-nbt');
    if (length > limit) throw new WorldMetadataNbtReadError('nbt-limit-exceeded');
    return length;
  }

  /** Java DataInput modified UTF-8, the encoding used by NBT strings. */
  #modifiedUtf8(): string {
    const byteLength = this.#u2();
    if (byteLength > WORLD_METADATA_NBT_LIMITS.maximumStringBytes) {
      throw new WorldMetadataNbtReadError('nbt-limit-exceeded');
    }
    this.#ensure(byteLength);
    const end = this.#offset + byteLength;
    const codeUnits: number[] = [];
    while (this.#offset < end) {
      const first = this.#u1();
      if (first > 0 && first <= 0x7f) {
        codeUnits.push(first);
        continue;
      }
      if ((first & 0xe0) === 0xc0) {
        if (this.#offset >= end) throw new WorldMetadataNbtReadError('invalid-nbt');
        const second = this.#u1();
        if ((second & 0xc0) !== 0x80) throw new WorldMetadataNbtReadError('invalid-nbt');
        const value = ((first & 0x1f) << 6) | (second & 0x3f);
        if (value !== 0 && value < 0x80) throw new WorldMetadataNbtReadError('invalid-nbt');
        codeUnits.push(value);
        continue;
      }
      if ((first & 0xf0) === 0xe0) {
        if (this.#offset + 1 >= end) throw new WorldMetadataNbtReadError('invalid-nbt');
        const second = this.#u1();
        const third = this.#u1();
        if ((second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) {
          throw new WorldMetadataNbtReadError('invalid-nbt');
        }
        const value = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
        if (value < 0x800) throw new WorldMetadataNbtReadError('invalid-nbt');
        codeUnits.push(value);
        continue;
      }
      throw new WorldMetadataNbtReadError('invalid-nbt');
    }
    let result = '';
    for (let index = 0; index < codeUnits.length; index += 8_192) {
      result += String.fromCharCode(...codeUnits.slice(index, index + 8_192));
    }
    return result;
  }

  #payload(type: number, depth: number, path: readonly string[], capture: SelectionCapture): void {
    this.#depth(depth);
    switch (type) {
      case 1: this.#skip(1); return;
      case 2: this.#skip(2); return;
      case 3:
      case 5: this.#skip(4); return;
      case 4:
      case 6: this.#skip(8); return;
      case 7: this.#skip(this.#length(WORLD_METADATA_NBT_LIMITS.maximumArrayEntries)); return;
      case 8: void this.#modifiedUtf8(); return;
      case 9: this.#list(depth, path, capture); return;
      case 10: this.#compound(depth, path, capture); return;
      case 11: this.#skip(this.#length(WORLD_METADATA_NBT_LIMITS.maximumArrayEntries) * 4); return;
      case 12: this.#skip(this.#length(WORLD_METADATA_NBT_LIMITS.maximumArrayEntries) * 8); return;
      default: throw new WorldMetadataNbtReadError('invalid-nbt');
    }
  }

  #list(depth: number, path: readonly string[], capture: SelectionCapture): void {
    const elementType = this.#u1();
    const length = this.#length(WORLD_METADATA_NBT_LIMITS.maximumListEntries);
    if (elementType > 12 || (elementType === 0 && length !== 0)) {
      throw new WorldMetadataNbtReadError('invalid-nbt');
    }
    this.#countTags(length);
    if (isTargetList(path)) {
      if (elementType !== 8 && !(length === 0 && elementType === 0)) {
        throw new WorldMetadataNbtReadError('world-metadata-schema-mismatch');
      }
      const values = Array.from({ length }, () => this.#modifiedUtf8());
      if (path[2] === 'Enabled') capture.enabledPackIds = values;
      else capture.disabledPackIds = values;
      return;
    }
    for (let index = 0; index < length; index += 1) {
      this.#payload(elementType, depth + 1, [...path, '*'], capture);
    }
  }

  #compound(depth: number, path: readonly string[], capture: SelectionCapture): void {
    const keys = new Set<string>();
    for (;;) {
      const type = this.#u1();
      if (type === 0) return;
      if (type > 12) throw new WorldMetadataNbtReadError('invalid-nbt');
      this.#countTags(1);
      const name = this.#modifiedUtf8();
      if (keys.has(name)) throw new WorldMetadataNbtReadError('invalid-nbt');
      keys.add(name);
      const childPath = [...path, name];
      if (isTargetContainer(childPath) && type !== 10) {
        throw new WorldMetadataNbtReadError('world-metadata-schema-mismatch');
      }
      if (isTargetList(childPath) && type !== 9) {
        throw new WorldMetadataNbtReadError('world-metadata-schema-mismatch');
      }
      this.#payload(type, depth + 1, childPath, capture);
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isBufferLimitError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE';
}

function validatePackIds(values: readonly string[], other: ReadonlySet<string>): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      value.length === 0 ||
      value.length > WORLD_METADATA_NBT_LIMITS.maximumPackIdCharacters ||
      /[\u0000-\u001f\u007f\\]/u.test(value)
    ) {
      throw new WorldMetadataNbtReadError('invalid-pack-id');
    }
    if (seen.has(value) || other.has(value)) {
      throw new WorldMetadataNbtReadError('duplicate-pack-id');
    }
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}

/**
 * Extracts only `Data.DataPacks.Enabled` and `Disabled` from a gzip-compressed
 * Minecraft 1.20.1 world metadata document. No world path crosses this API.
 */
export function readWorldMetadataDatapackSelection(
  compressedBytes: Uint8Array,
): WorldMetadataDatapackSelection {
  if (!(compressedBytes instanceof Uint8Array)) {
    throw new WorldMetadataNbtReadError('invalid-gzip');
  }
  if (compressedBytes.byteLength > WORLD_METADATA_NBT_LIMITS.maximumCompressedBytes) {
    throw new WorldMetadataNbtReadError('compressed-bytes-limit-exceeded');
  }

  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(Buffer.from(compressedBytes), {
      maxOutputLength: WORLD_METADATA_NBT_LIMITS.maximumDecompressedBytes,
    });
  } catch (error) {
    throw new WorldMetadataNbtReadError(
      isBufferLimitError(error) ? 'decompressed-bytes-limit-exceeded' : 'invalid-gzip',
    );
  }
  if (decompressed.byteLength > WORLD_METADATA_NBT_LIMITS.maximumDecompressedBytes) {
    throw new WorldMetadataNbtReadError('decompressed-bytes-limit-exceeded');
  }

  const capture = new NbtCursor(decompressed).parseSelection();
  if (capture.enabledPackIds === null || capture.disabledPackIds === null) {
    throw new WorldMetadataNbtReadError('world-metadata-schema-mismatch');
  }
  const enabledPackIds = validatePackIds(capture.enabledPackIds, new Set());
  const disabledPackIds = validatePackIds(capture.disabledPackIds, new Set(enabledPackIds));
  return Object.freeze({
    schemaVersion: WORLD_METADATA_DATAPACK_SELECTION_SCHEMA_VERSION,
    evidenceSha256: sha256(compressedBytes),
    order: 'lowest-priority-first',
    enabledPackIds,
    disabledPackIds,
  });
}

export interface TrustedCompressedWorldMetadataReader {
  /** Reads the configured world's compressed metadata without exposing its path. */
  readCompressedWorldMetadata(): Promise<Uint8Array>;
}

function openLoaderPackId(datapack: AnalyzedDatapack): string | null {
  if (datapack.loader !== 'openloader') return null;
  const segments = datapack.rootPath.split('/');
  if (
    segments.length !== 4 ||
    segments[0]?.toLocaleLowerCase('en-US') !== 'config' ||
    segments[1]?.toLocaleLowerCase('en-US') !== 'openloader' ||
    segments[2]?.toLocaleLowerCase('en-US') !== 'data' ||
    segments[3] !== datapack.name
  ) {
    return null;
  }
  return `data/${datapack.name}`;
}

/**
 * Trusted adapter from bounded NBT evidence to the observer's normalized port.
 * It recognizes only OpenLoader's reviewed `data/<candidate filename>` IDs.
 */
export class BoundedNbtWorldMetadataDatapackLoadOrderReader
implements TrustedWorldMetadataDatapackLoadOrderReader {
  readonly #reader: TrustedCompressedWorldMetadataReader;

  public constructor(reader: TrustedCompressedWorldMetadataReader) {
    this.#reader = reader;
  }

  public async readNormalizedEvidence(analysis: EcosystemAnalysis): Promise<unknown> {
    const selection = readWorldMetadataDatapackSelection(
      await this.#reader.readCompressedWorldMetadata(),
    );
    const datapacksByNativeId = new Map<string, AnalyzedDatapack>();
    for (const datapack of analysis.datapacks) {
      const nativeId = openLoaderPackId(datapack);
      if (nativeId === null) continue;
      if (datapacksByNativeId.has(nativeId)) {
        throw new WorldMetadataNbtReadError('world-metadata-schema-mismatch');
      }
      datapacksByNativeId.set(nativeId, datapack);
    }

    const datapacks = [];
    for (const packId of selection.enabledPackIds) {
      if (!packId.startsWith('data/')) continue;
      const datapack = datapacksByNativeId.get(packId);
      if (datapack === undefined) {
        throw new WorldMetadataNbtReadError('unmapped-active-openloader-pack');
      }
      datapacks.push({ rootPath: datapack.rootPath, sha256: datapack.sha256 });
    }
    if (datapacks.length === 0) {
      throw new WorldMetadataNbtReadError('no-observed-openloader-datapacks');
    }
    return Object.freeze({
      schemaVersion: 1,
      evidenceSha256: selection.evidenceSha256,
      order: selection.order,
      datapacks: Object.freeze(datapacks),
    });
  }
}

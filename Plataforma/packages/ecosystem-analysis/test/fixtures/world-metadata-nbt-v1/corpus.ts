import { gzipSync } from 'node:zlib';

export interface SyntheticNbtEntry {
  readonly type: number;
  readonly name: string;
  readonly payload: Buffer;
}

function i4(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeInt32BE(value);
  return result;
}

/** Encodes Java DataOutput modified UTF-8, including NUL and surrogate code units. */
export function modifiedUtf8(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit > 0 && codeUnit <= 0x7f) bytes.push(codeUnit);
    else if (codeUnit <= 0x7ff) {
      bytes.push(0xc0 | (codeUnit >> 6), 0x80 | (codeUnit & 0x3f));
    } else {
      bytes.push(
        0xe0 | (codeUnit >> 12),
        0x80 | ((codeUnit >> 6) & 0x3f),
        0x80 | (codeUnit & 0x3f),
      );
    }
  }
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, Buffer.from(bytes)]);
}

export function namedTag(type: number, name: string, payload: Buffer): SyntheticNbtEntry {
  return { type, name, payload };
}

export function compound(entries: readonly SyntheticNbtEntry[]): Buffer {
  return Buffer.concat([
    ...entries.map((entry) => Buffer.concat([
      Buffer.from([entry.type]),
      modifiedUtf8(entry.name),
      entry.payload,
    ])),
    Buffer.from([0]),
  ]);
}

export function stringPayload(value: string): Buffer {
  return modifiedUtf8(value);
}

export function stringList(values: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from([values.length === 0 ? 0 : 8]),
    i4(values.length),
    ...values.map(modifiedUtf8),
  ]);
}

export function declaredStringListLength(length: number): Buffer {
  return Buffer.concat([Buffer.from([8]), i4(length)]);
}

export function nestedCompounds(depth: number): Buffer {
  let payload = compound([]);
  for (let index = 0; index < depth; index += 1) {
    payload = compound([namedTag(10, `Depth${String(index)}`, payload)]);
  }
  return payload;
}

function representativeUnrelatedTags(): readonly SyntheticNbtEntry[] {
  const short = Buffer.alloc(2); short.writeInt16BE(-12);
  const integer = i4(42);
  const long = Buffer.alloc(8); long.writeBigInt64BE(123n);
  const float = Buffer.alloc(4); float.writeFloatBE(1.5);
  const double = Buffer.alloc(8); double.writeDoubleBE(2.5);
  return [
    namedTag(1, 'Byte', Buffer.from([1])),
    namedTag(2, 'Short', short),
    namedTag(3, 'Int', integer),
    namedTag(4, 'Long', long),
    namedTag(5, 'Float', float),
    namedTag(6, 'Double', double),
    namedTag(7, 'ByteArray', Buffer.concat([i4(3), Buffer.from([1, 2, 3])])),
    namedTag(8, 'String', stringPayload('sanitized\u0000metadata')),
    namedTag(9, 'List', Buffer.concat([Buffer.from([3]), i4(2), i4(1), i4(2)])),
    namedTag(10, 'Compound', compound([namedTag(1, 'NestedByte', Buffer.from([0]))])),
    namedTag(11, 'IntArray', Buffer.concat([i4(2), i4(3), i4(4)])),
    namedTag(12, 'LongArray', Buffer.concat([i4(1), long])),
  ];
}

export function worldMetadataNbt(options: {
  readonly enabled?: readonly string[];
  readonly disabled?: readonly string[];
  readonly rootEntries?: readonly SyntheticNbtEntry[];
  readonly dataEntries?: readonly SyntheticNbtEntry[];
  readonly dataPackEntries?: readonly SyntheticNbtEntry[];
  readonly includeRepresentativeUnrelatedTags?: boolean;
} = {}): Buffer {
  const dataPackEntries = options.dataPackEntries ?? [
    namedTag(9, 'Enabled', stringList(options.enabled ?? ['vanilla'])),
    namedTag(9, 'Disabled', stringList(options.disabled ?? [])),
  ];
  const dataEntries = options.dataEntries ?? [
    ...(options.includeRepresentativeUnrelatedTags === true ? representativeUnrelatedTags() : []),
    namedTag(10, 'DataPacks', compound(dataPackEntries)),
  ];
  const root = Buffer.concat([
    Buffer.from([10]),
    modifiedUtf8(''),
    compound([
      ...(options.rootEntries ?? []),
      namedTag(10, 'Data', compound(dataEntries)),
    ]),
  ]);
  return gzipSync(root);
}

import { Buffer } from 'node:buffer';

export interface ClassFileInspectionLimits {
  readonly maximumBytes: number;
  readonly maximumConstantPoolEntries: number;
  readonly maximumMembers: number;
  readonly maximumAttributes: number;
  readonly maximumInstructions: number;
  readonly maximumFacts: number;
}

export const DEFAULT_CLASS_FILE_INSPECTION_LIMITS: ClassFileInspectionLimits = Object.freeze({
  maximumBytes: 1024 * 1024,
  maximumConstantPoolEntries: 32_768,
  maximumMembers: 4_096,
  maximumAttributes: 8_192,
  maximumInstructions: 100_000,
  maximumFacts: 8_192,
});

export type ClassFileInspectionErrorCode = 'invalid-class-file' | 'class-file-limit-exceeded';

export class ClassFileInspectionError extends Error {
  public readonly code: ClassFileInspectionErrorCode;

  public constructor(code: ClassFileInspectionErrorCode) {
    super(code === 'invalid-class-file' ? 'The Java class file is malformed.' : 'The Java class file exceeds its inspection limit.');
    this.name = 'ClassFileInspectionError';
    this.code = code;
  }
}

export interface ClassMemberReference {
  readonly owner: string;
  readonly name: string;
  readonly descriptor: string;
  readonly kind: 'field' | 'method' | 'interface-method';
}

export interface ClassInvocation extends ClassMemberReference {
  readonly methodName: string;
  readonly offset: number;
}

export interface ClassAnnotation {
  readonly descriptor: string;
  readonly memberName: string | null;
  readonly classValues: readonly string[];
  readonly stringValues: readonly string[];
}

export type ClassConfigurationDefinitionType =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'enum'
  | 'string-list'
  | 'number-list'
  | 'boolean-list'
  | 'unknown';

export interface ClassConfigurationDefinition {
  readonly path: string;
  readonly key: string;
  readonly fieldName: string | null;
  readonly type: ClassConfigurationDefinitionType;
  readonly defaultValue: boolean | number | string | readonly (boolean | number | string)[] | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly comment: string | null;
  readonly methodName: string;
  readonly offset: number;
}

export interface ClassFileInspection {
  readonly majorVersion: number;
  readonly className: string;
  readonly superClass: string | null;
  readonly interfaces: readonly string[];
  readonly sourceFile: string | null;
  readonly referencedClasses: readonly string[];
  readonly memberReferences: readonly ClassMemberReference[];
  readonly invocations: readonly ClassInvocation[];
  readonly annotations: readonly ClassAnnotation[];
  readonly configurationDefinitions: readonly ClassConfigurationDefinition[];
}

type ConstantPoolEntry =
  | { readonly tag: 'utf8'; readonly value: string }
  | { readonly tag: 'integer' | 'float' | 'double'; readonly value: number }
  | { readonly tag: 'long'; readonly value: bigint }
  | { readonly tag: 'class' | 'string' | 'method-type' | 'module' | 'package'; readonly index: number }
  | { readonly tag: 'field' | 'method' | 'interface-method'; readonly classIndex: number; readonly nameAndTypeIndex: number }
  | { readonly tag: 'name-and-type'; readonly nameIndex: number; readonly descriptorIndex: number }
  | { readonly tag: 'method-handle'; readonly referenceKind: number; readonly referenceIndex: number }
  | { readonly tag: 'dynamic' | 'invoke-dynamic'; readonly bootstrapIndex: number; readonly nameAndTypeIndex: number };

class Reader {
  public offset = 0;

  public constructor(private readonly value: Buffer) {}

  public get remaining(): number {
    return this.value.length - this.offset;
  }

  public u1(): number {
    this.ensure(1);
    return this.value[this.offset++] ?? 0;
  }

  public u2(): number {
    this.ensure(2);
    const result = this.value.readUInt16BE(this.offset);
    this.offset += 2;
    return result;
  }

  public u4(): number {
    this.ensure(4);
    const result = this.value.readUInt32BE(this.offset);
    this.offset += 4;
    return result;
  }

  public bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0) throw new ClassFileInspectionError('invalid-class-file');
    this.ensure(length);
    const result = this.value.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  public child(length: number): Reader {
    return new Reader(this.bytes(length));
  }

  private ensure(length: number): void {
    if (this.offset + length > this.value.length) throw new ClassFileInspectionError('invalid-class-file');
  }
}

type SymbolicValue =
  | { readonly kind: 'scalar'; readonly value: boolean | number | string }
  | { readonly kind: 'list'; readonly value: readonly (boolean | number | string)[] }
  | { readonly kind: 'field'; readonly owner: string; readonly name: string; readonly descriptor: string }
  | { readonly kind: 'definition'; readonly index: number }
  | { readonly kind: 'unknown' };

const UNKNOWN: SymbolicValue = Object.freeze({ kind: 'unknown' as const });

function resolveLimits(input?: Partial<ClassFileInspectionLimits>): ClassFileInspectionLimits {
  const limits = { ...DEFAULT_CLASS_FILE_INSPECTION_LIMITS, ...input };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ClassFileInspectionError('class-file-limit-exceeded');
  }
  return Object.freeze(limits);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US')));
}

function descriptorClasses(descriptor: string): readonly string[] {
  const found: string[] = [];
  for (const match of descriptor.matchAll(/L([^;]+);/gu)) {
    const name = match[1];
    if (name !== undefined) found.push(name);
  }
  return found;
}

function descriptorArguments(descriptor: string): { readonly arguments: readonly string[]; readonly result: string } {
  if (!descriptor.startsWith('(')) return { arguments: [], result: 'V' };
  const argumentsList: string[] = [];
  let cursor = 1;
  const readType = (): string => {
    const start = cursor;
    while (descriptor[cursor] === '[') cursor += 1;
    if (descriptor[cursor] === 'L') {
      const end = descriptor.indexOf(';', cursor);
      if (end < 0) return '';
      cursor = end + 1;
      return descriptor.slice(start, cursor);
    }
    cursor += 1;
    return descriptor.slice(start, cursor);
  };
  while (cursor < descriptor.length && descriptor[cursor] !== ')') {
    const type = readType();
    if (type.length === 0) return { arguments: [], result: 'V' };
    argumentsList.push(type);
  }
  cursor += 1;
  const result = cursor < descriptor.length ? descriptor.slice(cursor) : 'V';
  return { arguments: argumentsList, result };
}

function instructionLength(code: Buffer, offset: number): number {
  const opcode = code[offset];
  if (opcode === undefined) throw new ClassFileInspectionError('invalid-class-file');
  // 0xca is reserved for debuggers and 0xcb-0xff are reserved or
  // implementation-dependent. None may occur in a class-file Code array.
  if (opcode >= 0xca) throw new ClassFileInspectionError('invalid-class-file');
  if (opcode === 0xaa || opcode === 0xab) {
    const padding = (4 - ((offset + 1) % 4)) % 4;
    const base = offset + 1 + padding;
    if (base + 8 > code.length) throw new ClassFileInspectionError('invalid-class-file');
    if (opcode === 0xaa) {
      if (base + 12 > code.length) throw new ClassFileInspectionError('invalid-class-file');
      const low = code.readInt32BE(base + 4);
      const high = code.readInt32BE(base + 8);
      const count = high - low + 1;
      if (count < 0 || count > 65_536) throw new ClassFileInspectionError('class-file-limit-exceeded');
      return 1 + padding + 12 + count * 4;
    }
    const pairs = code.readInt32BE(base + 4);
    if (pairs < 0 || pairs > 65_536) throw new ClassFileInspectionError('class-file-limit-exceeded');
    return 1 + padding + 8 + pairs * 8;
  }
  if (opcode === 0xc4) {
    if (offset + 1 >= code.length) throw new ClassFileInspectionError('invalid-class-file');
    const widened = code[offset + 1];
    if (widened === 0x84) return 6;
    if (
      widened === undefined ||
      !(
        (widened >= 0x15 && widened <= 0x19) ||
        (widened >= 0x36 && widened <= 0x3a) ||
        widened === 0xa9
      )
    ) {
      throw new ClassFileInspectionError('invalid-class-file');
    }
    return 4;
  }
  if (opcode === 0xb9 || opcode === 0xba) return 5;
  if (opcode === 0xc5) return 4;
  if (opcode === 0xc8 || opcode === 0xc9) return 5;
  if (
    opcode === 0x11 || opcode === 0x13 || opcode === 0x14 || opcode === 0x84 ||
    (opcode >= 0x99 && opcode <= 0xa8) ||
    (opcode >= 0xb2 && opcode <= 0xb8) ||
    opcode === 0xbb || opcode === 0xbd || opcode === 0xc0 || opcode === 0xc1 ||
    opcode === 0xc6 || opcode === 0xc7
  ) return 3;
  if (
    opcode === 0x10 || opcode === 0x12 ||
    (opcode >= 0x15 && opcode <= 0x19) ||
    (opcode >= 0x36 && opcode <= 0x3a) ||
    opcode === 0xa9 || opcode === 0xbc
  ) return 2;
  return 1;
}

/**
 * Parses facts from a Java class without linking, loading or executing it.
 *
 * The parser accepts only the JVM class-file grammar and keeps hard limits on
 * bytes, pool entries, members, attributes, instructions and emitted facts.
 */
export function inspectClassFile(
  input: Uint8Array,
  partialLimits?: Partial<ClassFileInspectionLimits>,
): ClassFileInspection {
  const limits = resolveLimits(partialLimits);
  if (!(input instanceof Uint8Array) || input.byteLength < 10) throw new ClassFileInspectionError('invalid-class-file');
  if (input.byteLength > limits.maximumBytes) throw new ClassFileInspectionError('class-file-limit-exceeded');
  const content = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const reader = new Reader(content);
  if (reader.u4() !== 0xcafebabe) throw new ClassFileInspectionError('invalid-class-file');
  reader.u2();
  const majorVersion = reader.u2();
  const poolCount = reader.u2();
  if (poolCount < 1 || poolCount > limits.maximumConstantPoolEntries) {
    throw new ClassFileInspectionError('class-file-limit-exceeded');
  }
  const pool: Array<ConstantPoolEntry | null> = new Array(poolCount).fill(null);
  for (let index = 1; index < poolCount; index += 1) {
    const tag = reader.u1();
    if (tag === 1) {
      const bytes = reader.bytes(reader.u2());
      const value = bytes.toString('utf8');
      if (!Buffer.from(value, 'utf8').equals(bytes)) throw new ClassFileInspectionError('invalid-class-file');
      pool[index] = { tag: 'utf8', value };
    } else if (tag === 3) {
      pool[index] = { tag: 'integer', value: reader.bytes(4).readInt32BE(0) };
    } else if (tag === 4) {
      pool[index] = { tag: 'float', value: reader.bytes(4).readFloatBE(0) };
    } else if (tag === 5) {
      pool[index] = { tag: 'long', value: reader.bytes(8).readBigInt64BE(0) };
      index += 1;
    } else if (tag === 6) {
      pool[index] = { tag: 'double', value: reader.bytes(8).readDoubleBE(0) };
      index += 1;
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      const mapped = tag === 7 ? 'class' : tag === 8 ? 'string' : tag === 16 ? 'method-type' : tag === 19 ? 'module' : 'package';
      pool[index] = { tag: mapped, index: reader.u2() };
    } else if (tag === 9 || tag === 10 || tag === 11) {
      pool[index] = {
        tag: tag === 9 ? 'field' : tag === 10 ? 'method' : 'interface-method',
        classIndex: reader.u2(),
        nameAndTypeIndex: reader.u2(),
      };
    } else if (tag === 12) {
      pool[index] = { tag: 'name-and-type', nameIndex: reader.u2(), descriptorIndex: reader.u2() };
    } else if (tag === 15) {
      pool[index] = { tag: 'method-handle', referenceKind: reader.u1(), referenceIndex: reader.u2() };
    } else if (tag === 17 || tag === 18) {
      pool[index] = {
        tag: tag === 17 ? 'dynamic' : 'invoke-dynamic',
        bootstrapIndex: reader.u2(),
        nameAndTypeIndex: reader.u2(),
      };
    } else {
      throw new ClassFileInspectionError('invalid-class-file');
    }
  }

  const entry = (index: number): ConstantPoolEntry => {
    const found = pool[index];
    if (found === undefined || found === null) throw new ClassFileInspectionError('invalid-class-file');
    return found;
  };
  const utf8 = (index: number): string => {
    const found = entry(index);
    if (found.tag !== 'utf8') throw new ClassFileInspectionError('invalid-class-file');
    return found.value;
  };
  const className = (index: number): string => {
    const found = entry(index);
    if (found.tag !== 'class') throw new ClassFileInspectionError('invalid-class-file');
    return utf8(found.index);
  };
  const memberReference = (index: number): ClassMemberReference => {
    const found = entry(index);
    if (found.tag !== 'field' && found.tag !== 'method' && found.tag !== 'interface-method') {
      throw new ClassFileInspectionError('invalid-class-file');
    }
    const nameAndType = entry(found.nameAndTypeIndex);
    if (nameAndType.tag !== 'name-and-type') throw new ClassFileInspectionError('invalid-class-file');
    return {
      owner: className(found.classIndex),
      name: utf8(nameAndType.nameIndex),
      descriptor: utf8(nameAndType.descriptorIndex),
      kind: found.tag,
    };
  };
  const constant = (index: number): SymbolicValue => {
    const found = entry(index);
    if (found.tag === 'integer' || found.tag === 'float' || found.tag === 'double') {
      return { kind: 'scalar', value: found.value };
    }
    if (found.tag === 'long') {
      return Number.isSafeInteger(Number(found.value)) ? { kind: 'scalar', value: Number(found.value) } : UNKNOWN;
    }
    if (found.tag === 'string') return { kind: 'scalar', value: utf8(found.index) };
    return UNKNOWN;
  };

  const annotations: ClassAnnotation[] = [];
  const invocations: ClassInvocation[] = [];
  const definitions: Array<Omit<ClassConfigurationDefinition, 'fieldName'> & { fieldName: string | null }> = [];
  let attributeCount = 0;
  let instructionCount = 0;
  let sourceFile: string | null = null;

  const parseElementValue = (valueReader: Reader, classValues: string[], stringValues: string[]): void => {
    const tag = String.fromCharCode(valueReader.u1());
    if ('BCDFIJSZs'.includes(tag)) {
      const index = valueReader.u2();
      if (tag === 's') stringValues.push(utf8(index));
      return;
    }
    if (tag === 'e') {
      utf8(valueReader.u2());
      stringValues.push(utf8(valueReader.u2()));
      return;
    }
    if (tag === 'c') {
      classValues.push(...descriptorClasses(utf8(valueReader.u2())));
      return;
    }
    if (tag === '@') {
      parseAnnotation(valueReader, null);
      return;
    }
    if (tag === '[') {
      const count = valueReader.u2();
      if (count > limits.maximumFacts) throw new ClassFileInspectionError('class-file-limit-exceeded');
      for (let index = 0; index < count; index += 1) parseElementValue(valueReader, classValues, stringValues);
      return;
    }
    throw new ClassFileInspectionError('invalid-class-file');
  };

  const parseAnnotation = (annotationReader: Reader, memberName: string | null): void => {
    const descriptor = utf8(annotationReader.u2());
    const classValues: string[] = [];
    const stringValues: string[] = [];
    const pairs = annotationReader.u2();
    if (pairs > limits.maximumFacts) throw new ClassFileInspectionError('class-file-limit-exceeded');
    for (let index = 0; index < pairs; index += 1) {
      utf8(annotationReader.u2());
      parseElementValue(annotationReader, classValues, stringValues);
    }
    annotations.push({
      descriptor,
      memberName,
      classValues: uniqueSorted(classValues),
      stringValues: uniqueSorted(stringValues),
    });
  };

  const parseAnnotations = (attributeReader: Reader, memberName: string | null): void => {
    const count = attributeReader.u2();
    if (count > limits.maximumFacts) throw new ClassFileInspectionError('class-file-limit-exceeded');
    for (let index = 0; index < count; index += 1) parseAnnotation(attributeReader, memberName);
  };

  const scalar = (value: SymbolicValue, descriptor: string): boolean | number | string | readonly (boolean | number | string)[] | null => {
    if (value.kind === 'list') return value.value;
    if (value.kind === 'field') return value.name;
    if (value.kind !== 'scalar') return null;
    if (descriptor === 'Z' && typeof value.value === 'number' && (value.value === 0 || value.value === 1)) return value.value === 1;
    return value.value;
  };

  const definitionType = (descriptor: string, value: SymbolicValue): ClassConfigurationDefinitionType => {
    if (descriptor === 'Z') return 'boolean';
    if ('BCSIJ'.includes(descriptor)) return 'integer';
    if (descriptor === 'F' || descriptor === 'D') return 'number';
    if (descriptor === 'Ljava/lang/String;') return 'string';
    if (value.kind === 'field') return 'enum';
    if (value.kind === 'list') {
      const first = value.value[0];
      return typeof first === 'number' ? 'number-list' : typeof first === 'boolean' ? 'boolean-list' : 'string-list';
    }
    return 'unknown';
  };

  const analyzeCode = (code: Buffer, methodName: string): void => {
    const stack: SymbolicValue[] = [];
    const configPath: string[] = [];
    let pendingComment: string | null = null;
    const pop = (): SymbolicValue => stack.pop() ?? UNKNOWN;
    let offset = 0;
    while (offset < code.length) {
      instructionCount += 1;
      if (instructionCount > limits.maximumInstructions) throw new ClassFileInspectionError('class-file-limit-exceeded');
      const opcode = code[offset] ?? 0;
      const length = instructionLength(code, offset);
      if (offset + length > code.length) throw new ClassFileInspectionError('invalid-class-file');
      if (opcode === 0x01) stack.push(UNKNOWN);
      else if (opcode >= 0x02 && opcode <= 0x08) stack.push({ kind: 'scalar', value: opcode - 0x03 });
      else if (opcode === 0x09 || opcode === 0x0a) stack.push({ kind: 'scalar', value: opcode - 0x09 });
      else if (opcode >= 0x0b && opcode <= 0x0d) stack.push({ kind: 'scalar', value: opcode - 0x0b });
      else if (opcode === 0x0e || opcode === 0x0f) stack.push({ kind: 'scalar', value: opcode - 0x0e });
      else if (opcode === 0x10) stack.push({ kind: 'scalar', value: code.readInt8(offset + 1) });
      else if (opcode === 0x11) stack.push({ kind: 'scalar', value: code.readInt16BE(offset + 1) });
      else if (opcode === 0x12) stack.push(constant(code[offset + 1] ?? 0));
      else if (opcode === 0x13 || opcode === 0x14) stack.push(constant(code.readUInt16BE(offset + 1)));
      else if ((opcode >= 0x15 && opcode <= 0x19) || (opcode >= 0x1a && opcode <= 0x35)) stack.push(UNKNOWN);
      else if ((opcode >= 0x36 && opcode <= 0x56)) pop();
      else if (opcode === 0x57) pop();
      else if (opcode === 0x59) stack.push(stack.at(-1) ?? UNKNOWN);
      else if (opcode === 0xbb) stack.push(UNKNOWN);
      else if (opcode === 0xb2) {
        const found = memberReference(code.readUInt16BE(offset + 1));
        stack.push({ kind: 'field', owner: found.owner, name: found.name, descriptor: found.descriptor });
      } else if (opcode === 0xb3) pop();
      else if (opcode === 0xb4) {
        pop();
        const found = memberReference(code.readUInt16BE(offset + 1));
        stack.push({ kind: 'field', owner: found.owner, name: found.name, descriptor: found.descriptor });
      } else if (opcode === 0xb5) {
        const value = pop();
        pop();
        const found = memberReference(code.readUInt16BE(offset + 1));
        if (value.kind === 'definition') {
          const definition = definitions[value.index];
          if (definition !== undefined) definition.fieldName = found.name;
        }
      } else if (opcode >= 0xb6 && opcode <= 0xb9) {
        const found = memberReference(code.readUInt16BE(offset + 1));
        const descriptor = descriptorArguments(found.descriptor);
        const argumentsList = descriptor.arguments.map(() => pop()).reverse();
        if (opcode !== 0xb8) pop();
        invocations.push({ ...found, methodName, offset });
        let result: SymbolicValue = UNKNOWN;
        if (found.owner === 'java/util/List' && found.name === 'of') {
          const values = argumentsList.map((value, index) => scalar(value, descriptor.arguments[index] ?? ''));
          if (values.every((value) => value !== null && !Array.isArray(value))) {
            result = { kind: 'list', value: values as readonly (boolean | number | string)[] };
          }
        } else if (found.owner.endsWith('/ForgeConfigSpec$Builder')) {
          if (found.name === 'comment') {
            const value = argumentsList[0];
            if (value?.kind === 'scalar' && typeof value.value === 'string') pendingComment = value.value;
          } else if (found.name === 'push') {
            const value = argumentsList[0];
            if (value?.kind === 'scalar' && typeof value.value === 'string') configPath.push(value.value);
            // A comment immediately before push documents the category/table,
            // not the first value subsequently defined inside it.
            pendingComment = null;
          } else if (found.name === 'pop') {
            const countValue = argumentsList[0];
            const count = countValue?.kind === 'scalar' && typeof countValue.value === 'number' ? Math.max(1, Math.trunc(countValue.value)) : 1;
            configPath.splice(Math.max(0, configPath.length - count), count);
          } else if (found.name.startsWith('define')) {
            const keyValue = argumentsList[0];
            if (keyValue?.kind === 'scalar' && typeof keyValue.value === 'string') {
              const defaultSymbol = argumentsList[1] ?? UNKNOWN;
              const defaultDescriptor = descriptor.arguments[1] ?? '';
              const minimum = found.name === 'defineInRange' ? scalar(argumentsList[2] ?? UNKNOWN, descriptor.arguments[2] ?? '') : null;
              const maximum = found.name === 'defineInRange' ? scalar(argumentsList[3] ?? UNKNOWN, descriptor.arguments[3] ?? '') : null;
              const definitionIndex = definitions.length;
              definitions.push({
                path: [...configPath, keyValue.value].join('.'),
                key: keyValue.value,
                fieldName: null,
                type: definitionType(defaultDescriptor, defaultSymbol),
                defaultValue: scalar(defaultSymbol, defaultDescriptor),
                minimum: typeof minimum === 'number' ? minimum : null,
                maximum: typeof maximum === 'number' ? maximum : null,
                comment: pendingComment,
                methodName,
                offset,
              });
              result = { kind: 'definition', index: definitionIndex };
              pendingComment = null;
            }
          }
        }
        if (descriptor.result !== 'V') stack.push(result);
      } else if (opcode === 0xba) {
        const dynamic = entry(code.readUInt16BE(offset + 1));
        if (dynamic.tag !== 'invoke-dynamic') throw new ClassFileInspectionError('invalid-class-file');
        const nameAndType = entry(dynamic.nameAndTypeIndex);
        if (nameAndType.tag !== 'name-and-type') throw new ClassFileInspectionError('invalid-class-file');
        const descriptor = descriptorArguments(utf8(nameAndType.descriptorIndex));
        for (const unused of descriptor.arguments) {
          void unused;
          pop();
        }
        if (descriptor.result !== 'V') stack.push(UNKNOWN);
      } else if (
        (opcode >= 0x99 && opcode <= 0xab) || opcode === 0xbf ||
        (opcode >= 0xac && opcode <= 0xb1) || opcode === 0xc6 || opcode === 0xc7 ||
        opcode === 0xc8 || opcode === 0xc9
      ) {
        stack.length = 0;
      }
      offset += length;
    }
  };

  const parseAttributes = (count: number, memberName: string | null, codeAllowed: boolean): void => {
    attributeCount += count;
    if (attributeCount > limits.maximumAttributes) throw new ClassFileInspectionError('class-file-limit-exceeded');
    for (let index = 0; index < count; index += 1) {
      const name = utf8(reader.u2());
      const attributeReader = reader.child(reader.u4());
      if (name === 'RuntimeVisibleAnnotations' || name === 'RuntimeInvisibleAnnotations') {
        parseAnnotations(attributeReader, memberName);
      } else if (name === 'SourceFile' && memberName === null) {
        sourceFile = utf8(attributeReader.u2());
      } else if (name === 'Code' && codeAllowed) {
        attributeReader.u2();
        attributeReader.u2();
        const code = attributeReader.bytes(attributeReader.u4());
        analyzeCode(code, memberName ?? '<unknown>');
        const exceptions = attributeReader.u2();
        attributeReader.bytes(exceptions * 8);
        const nested = attributeReader.u2();
        attributeCount += nested;
        if (attributeCount > limits.maximumAttributes) {
          throw new ClassFileInspectionError('class-file-limit-exceeded');
        }
        for (let nestedIndex = 0; nestedIndex < nested; nestedIndex += 1) {
          utf8(attributeReader.u2());
          attributeReader.bytes(attributeReader.u4());
        }
      }
      if (attributeReader.remaining !== 0) attributeReader.bytes(attributeReader.remaining);
    }
  };

  reader.u2();
  const ownClass = className(reader.u2());
  const superIndex = reader.u2();
  const interfaceCount = reader.u2();
  if (interfaceCount > limits.maximumMembers) throw new ClassFileInspectionError('class-file-limit-exceeded');
  const interfaces = Array.from({ length: interfaceCount }, () => className(reader.u2()));
  const fields = reader.u2();
  if (fields > limits.maximumMembers) throw new ClassFileInspectionError('class-file-limit-exceeded');
  for (let index = 0; index < fields; index += 1) {
    reader.u2();
    const name = utf8(reader.u2());
    utf8(reader.u2());
    parseAttributes(reader.u2(), name, false);
  }
  const methods = reader.u2();
  if (methods > limits.maximumMembers) throw new ClassFileInspectionError('class-file-limit-exceeded');
  for (let index = 0; index < methods; index += 1) {
    reader.u2();
    const name = utf8(reader.u2());
    utf8(reader.u2());
    parseAttributes(reader.u2(), name, true);
  }
  parseAttributes(reader.u2(), null, false);
  if (reader.remaining !== 0) throw new ClassFileInspectionError('invalid-class-file');

  const referencedClasses: string[] = [];
  const memberReferences: ClassMemberReference[] = [];
  for (let index = 1; index < pool.length; index += 1) {
    const found = pool[index];
    if (found?.tag === 'class') referencedClasses.push(...descriptorClasses(`L${utf8(found.index)};`));
    if (found?.tag === 'field' || found?.tag === 'method' || found?.tag === 'interface-method') {
      memberReferences.push(memberReference(index));
    }
    if (found?.tag === 'name-and-type') referencedClasses.push(...descriptorClasses(utf8(found.descriptorIndex)));
  }
  if (
    referencedClasses.length + memberReferences.length + invocations.length + annotations.length + definitions.length >
    limits.maximumFacts
  ) {
    throw new ClassFileInspectionError('class-file-limit-exceeded');
  }
  const memberMap = new Map(memberReferences.map((value) => [`${value.kind}\u0000${value.owner}\u0000${value.name}\u0000${value.descriptor}`, value]));
  return Object.freeze({
    majorVersion,
    className: ownClass,
    superClass: superIndex === 0 ? null : className(superIndex),
    interfaces: uniqueSorted(interfaces),
    sourceFile,
    referencedClasses: uniqueSorted(referencedClasses.filter((value) => value !== ownClass)),
    memberReferences: Object.freeze([...memberMap.values()].sort((left, right) =>
      `${left.owner}.${left.name}${left.descriptor}`.localeCompare(`${right.owner}.${right.name}${right.descriptor}`, 'en-US'),
    )),
    invocations: Object.freeze(invocations),
    annotations: Object.freeze(annotations),
    configurationDefinitions: Object.freeze(definitions),
  });
}

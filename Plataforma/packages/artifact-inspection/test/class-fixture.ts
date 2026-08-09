import { Buffer } from 'node:buffer';

function u1(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function u2(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}

function u4(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

class Pool {
  readonly entries: Buffer[] = [];
  count = 1;

  utf8(value: string): number {
    const bytes = Buffer.from(value, 'utf8');
    return this.add(Buffer.concat([u1(1), u2(bytes.length), bytes]));
  }

  class(value: string): number {
    return this.add(Buffer.concat([u1(7), u2(this.utf8(value))]));
  }

  string(value: string): number {
    return this.add(Buffer.concat([u1(8), u2(this.utf8(value))]));
  }

  double(value: number): number {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    const index = this.add(Buffer.concat([u1(6), bytes]));
    this.count += 1;
    return index;
  }

  member(tag: 9 | 10 | 11, owner: string, name: string, descriptor: string): number {
    const ownerIndex = this.class(owner);
    const nameIndex = this.utf8(name);
    const descriptorIndex = this.utf8(descriptor);
    const nameAndType = this.add(Buffer.concat([u1(12), u2(nameIndex), u2(descriptorIndex)]));
    return this.add(Buffer.concat([u1(tag), u2(ownerIndex), u2(nameAndType)]));
  }

  private add(entry: Buffer): number {
    const index = this.count;
    this.entries.push(entry);
    this.count += 1;
    return index;
  }
}

function instruction(opcode: number, index?: number): Buffer {
  return index === undefined ? u1(opcode) : Buffer.concat([u1(opcode), u2(index)]);
}

export function forgeConfigFixtureClass(): Buffer {
  const pool = new Pool();
  const ownClass = pool.class('example/config/Config');
  const superClass = pool.class('java/lang/Object');
  const initName = pool.utf8('<init>');
  const initDescriptor = pool.utf8('(Lnet/minecraftforge/common/ForgeConfigSpec$Builder;)V');
  const codeName = pool.utf8('Code');
  const annotationName = pool.utf8('RuntimeInvisibleAnnotations');
  const mixinDescriptor = pool.utf8('Lorg/spongepowered/asm/mixin/Mixin;');
  const annotationValue = pool.utf8('value');
  const targetDescriptor = pool.utf8('Lexternal/Target;');
  const push = pool.member(
    10,
    'net/minecraftforge/common/ForgeConfigSpec$Builder',
    'push',
    '(Ljava/lang/String;)Lnet/minecraftforge/common/ForgeConfigSpec$Builder;',
  );
  const comment = pool.member(
    10,
    'net/minecraftforge/common/ForgeConfigSpec$Builder',
    'comment',
    '(Ljava/lang/String;)Lnet/minecraftforge/common/ForgeConfigSpec$Builder;',
  );
  const define = pool.member(
    10,
    'net/minecraftforge/common/ForgeConfigSpec$Builder',
    'define',
    '(Ljava/lang/String;Z)Lnet/minecraftforge/common/ForgeConfigSpec$BooleanValue;',
  );
  const defineRange = pool.member(
    10,
    'net/minecraftforge/common/ForgeConfigSpec$Builder',
    'defineInRange',
    '(Ljava/lang/String;DDD)Lnet/minecraftforge/common/ForgeConfigSpec$DoubleValue;',
  );
  const enabledField = pool.member(
    9,
    'example/config/Config',
    'enabledField',
    'Lnet/minecraftforge/common/ForgeConfigSpec$BooleanValue;',
  );
  const scaleField = pool.member(
    9,
    'example/config/Config',
    'scaleField',
    'Lnet/minecraftforge/common/ForgeConfigSpec$DoubleValue;',
  );
  const integrationCall = pool.member(10, 'external/Target', 'connect', '(Ljava/lang/String;)V');
  const registryCall = pool.member(10, 'external/Target', 'register', '(Ljava/lang/String;)V');
  const general = pool.string('general');
  const enabledComment = pool.string('Enables the tested system.');
  const enabled = pool.string('enabled');
  const scale = pool.string('scale');
  const probe = pool.string('probe');
  const defaultScale = pool.double(1.5);
  const maximumScale = pool.double(10);

  const code = Buffer.concat([
    instruction(0x2b),
    Buffer.concat([u1(0x12), u1(general)]),
    instruction(0xb6, push),
    instruction(0x57),
    instruction(0x2b),
    Buffer.concat([u1(0x12), u1(enabledComment)]),
    instruction(0xb6, comment),
    instruction(0x57),
    instruction(0x2a),
    instruction(0x2b),
    Buffer.concat([u1(0x12), u1(enabled)]),
    instruction(0x04),
    instruction(0xb6, define),
    instruction(0xb5, enabledField),
    instruction(0x2a),
    instruction(0x2b),
    Buffer.concat([u1(0x12), u1(scale)]),
    instruction(0x14, defaultScale),
    instruction(0x0e),
    instruction(0x14, maximumScale),
    instruction(0xb6, defineRange),
    instruction(0xb5, scaleField),
    Buffer.concat([u1(0x12), u1(probe)]),
    instruction(0xb8, integrationCall),
    Buffer.concat([u1(0x12), u1(probe)]),
    instruction(0xb8, registryCall),
    instruction(0xb1),
  ]);
  const codeBody = Buffer.concat([u2(6), u2(2), u4(code.length), code, u2(0), u2(0)]);
  const method = Buffer.concat([
    u2(0x0001),
    u2(initName),
    u2(initDescriptor),
    u2(1),
    u2(codeName),
    u4(codeBody.length),
    codeBody,
  ]);
  const annotation = Buffer.concat([
    u2(1),
    u2(mixinDescriptor),
    u2(1),
    u2(annotationValue),
    u1('['.charCodeAt(0)),
    u2(1),
    u1('c'.charCodeAt(0)),
    u2(targetDescriptor),
  ]);
  return Buffer.concat([
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    u2(0),
    u2(61),
    u2(pool.count),
    ...pool.entries,
    u2(0x0021),
    u2(ownClass),
    u2(superClass),
    u2(0),
    u2(0),
    u2(1),
    method,
    u2(1),
    u2(annotationName),
    u4(annotation.length),
    annotation,
  ]);
}

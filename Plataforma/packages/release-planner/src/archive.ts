import { Buffer } from 'node:buffer';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Writes a ZIP without ever holding an entry in memory.
 *
 * A server archive is around a gigabyte, so nothing here buffers a file, and no
 * external dependency is used anywhere in this repository — the format is
 * written directly. Two details are worth stating because both are easy to get
 * wrong and neither fails loudly:
 *
 * The compression method sits at offset **8** in a local header and offset
 * **10** in a central directory header. Writing it at 8 in both leaves a
 * directory that claims "stored" over deflated bytes; a reader then rejects the
 * size mismatch, which is the correct behaviour and an expensive way to find
 * out. That mistake has already been made once in this repository, in a test
 * fixture, and the inspector caught it.
 *
 * A local header has to carry the CRC *before* the data it describes, which
 * normally forces either buffering the entry or reading it twice. Instead the
 * header is written with a placeholder, the data is streamed through a running
 * CRC, and the four bytes are patched afterwards — one read pass, one write
 * pass, bounded memory.
 */

const LOCAL_SIGNATURE = 0x0403_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const EOCD_SIGNATURE = 0x0605_4b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const LOCAL_HEADER_LENGTH = 30;
const CENTRAL_HEADER_LENGTH = 46;
const EOCD_LENGTH = 22;
const CRC_OFFSET_IN_LOCAL_HEADER = 14;
const CHUNK_BYTES = 1 << 20;

/** Past either of these an archive needs zip64, which this writer refuses. */
const MAXIMUM_TOTAL_BYTES = 0xffff_ffff;
const MAXIMUM_ENTRIES = 0xffff;

/**
 * Deflate is only attempted below this size.
 *
 * Above it an entry is stored and streamed, which keeps memory flat and costs
 * almost nothing: what is large in a modpack is jars, and a jar is already a
 * zip. What compresses — configs, scripts, json — is small.
 */
const DEFLATE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Formats that are already compressed; deflating them again buys nothing. */
const ALREADY_COMPRESSED: ReadonlySet<string> = new Set([
  '.jar',
  '.zip',
  '.gz',
  '.xz',
  '.7z',
  '.png',
  '.jpg',
  '.jpeg',
  '.ogg',
  '.mp3',
]);

export interface ArchiveEntry {
  /** Path inside the archive, `/`-separated. */
  readonly name: string;
  /** Absolute path of the file on disk. */
  readonly source: string;
}

export interface ArchiveReceipt {
  readonly path: string;
  readonly entries: number;
  readonly bytes: number;
  /** Sum of the entries' original sizes, so a ratio can be shown honestly. */
  readonly sourceBytes: number;
}

export type ArchiveErrorCode =
  | 'too-large'
  | 'too-many-entries'
  | 'unsafe-entry-name'
  | 'duplicate-entry-name'
  | 'source-changed';

export class ArchiveError extends Error {
  public readonly code: ArchiveErrorCode;
  /** The entry that caused it, when one did. */
  public readonly entryName: string | null;

  public constructor(code: ArchiveErrorCode, entryName: string | null = null) {
    super(entryName === null ? `archive:${code}` : `archive:${code}:${entryName}`);
    this.name = 'ArchiveError';
    this.code = code;
    this.entryName = entryName;
  }
}

interface CentralRecord {
  readonly name: Buffer;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
  readonly offset: number;
  readonly dosTime: number;
  readonly dosDate: number;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLocaleLowerCase('en-US');
}

/**
 * Refuses a name that would escape the folder somebody extracts into.
 *
 * A `..` inside an archive is how an extraction writes somewhere nobody chose.
 * Refusing at write time means this pipeline never produces one, independently
 * of how careful the extractor is.
 */
function entryNameBytes(name: string): Buffer {
  const segments = name.split('/');
  const hasControl = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes(String.fromCharCode(92)) ||
    /^[A-Za-z]:/u.test(name) ||
    hasControl ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ArchiveError('unsafe-entry-name', name);
  }
  return Buffer.from(name, 'utf8');
}

/** MS-DOS date and time, so extractors show a sane timestamp instead of 1980-00-00. */
function dosDateTime(when: Date): { readonly dosTime: number; readonly dosDate: number } {
  const year = when.getFullYear();
  if (year < 1980 || year > 2107) {
    // Outside what the format can hold. The DOS epoch is the honest floor.
    return { dosTime: 0, dosDate: (0 << 9) | (1 << 5) | 1 };
  }
  return {
    dosTime:
      (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/** Streams one file into the archive, returning its CRC. Never buffers it. */
async function copyStored(input: {
  readonly target: FileHandle;
  readonly source: string;
  readonly at: number;
  readonly expectedSize: number;
  readonly name: string;
}): Promise<number> {
  const handle = await open(input.source, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let checksum = 0;
    let written = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      checksum = crc32(chunk, checksum);
      await input.target.write(chunk, 0, bytesRead, input.at + written);
      written += bytesRead;
      if (written > input.expectedSize) break;
    }
    if (written !== input.expectedSize) {
      // The header already declared the size read a moment ago. A file that
      // changed underneath us would produce an archive whose directory lies,
      // and a lying directory is worse than a failed build.
      throw new ArchiveError('source-changed', input.name);
    }
    return checksum;
  } finally {
    await handle.close();
  }
}

export async function writeZipArchive(input: {
  readonly targetPath: string;
  readonly entries: readonly ArchiveEntry[];
}): Promise<ArchiveReceipt> {
  if (input.entries.length > MAXIMUM_ENTRIES) {
    // Beyond this the central directory needs zip64. Refusing beats writing an
    // archive that some readers silently truncate.
    throw new ArchiveError('too-many-entries');
  }

  const seen = new Set<string>();
  const central: CentralRecord[] = [];
  const target = await open(input.targetPath, 'w');
  let offset = 0;
  let sourceBytes = 0;

  const put = async (chunk: Buffer): Promise<void> => {
    await target.write(chunk, 0, chunk.length, offset);
    offset += chunk.length;
    if (offset > MAXIMUM_TOTAL_BYTES) throw new ArchiveError('too-large');
  };

  try {
    for (const entry of input.entries) {
      const nameBytes = entryNameBytes(entry.name);
      const lower = entry.name.toLowerCase();
      if (seen.has(lower)) {
        // Two entries with one name is how an extraction silently loses a file.
        throw new ArchiveError('duplicate-entry-name', entry.name);
      }
      seen.add(lower);

      const info = await stat(entry.source);
      const { dosTime, dosDate } = dosDateTime(info.mtime);
      const compressible =
        info.size > 0 &&
        info.size <= DEFLATE_LIMIT_BYTES &&
        !ALREADY_COMPRESSED.has(extensionOf(entry.name));

      // Small and compressible entries are deflated in one shot; everything
      // else is stored and streamed, so memory never follows the archive size.
      let payload: Buffer | null = null;
      let method = METHOD_STORE;
      let crc = 0;
      let compressedSize = info.size;

      if (compressible) {
        const handle = await open(entry.source, 'r');
        let original: Buffer;
        try {
          original = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (original.length !== info.size) throw new ArchiveError('source-changed', entry.name);
        crc = crc32(original, 0);
        const deflated = deflateRawSync(original);
        // Incompressible content deflates larger than it started. Storing it is
        // both smaller and faster to read back.
        if (deflated.length < original.length) {
          payload = deflated;
          method = METHOD_DEFLATE;
          compressedSize = deflated.length;
        } else {
          payload = original;
        }
      }

      const local = Buffer.alloc(LOCAL_HEADER_LENGTH);
      local.writeUInt32LE(LOCAL_SIGNATURE, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // Bit 11: the name is UTF-8.
      local.writeUInt16LE(method, 8); // Offset 8 here. Offset 10 in the directory.
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(0, CRC_OFFSET_IN_LOCAL_HEADER); // Patched below when streamed.
      local.writeUInt32LE(compressedSize, 18);
      local.writeUInt32LE(info.size, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      local.writeUInt16LE(0, 28);

      const entryOffset = offset;
      await put(local);
      await put(nameBytes);

      if (payload !== null) {
        if (payload.length > 0) await put(payload);
        // The CRC was known before the header was written.
        const patch = Buffer.alloc(4);
        patch.writeUInt32LE(crc, 0);
        await target.write(patch, 0, 4, entryOffset + CRC_OFFSET_IN_LOCAL_HEADER);
      } else if (info.size > 0) {
        crc = await copyStored({
          target,
          source: entry.source,
          at: offset,
          expectedSize: info.size,
          name: entry.name,
        });
        offset += info.size;
        if (offset > MAXIMUM_TOTAL_BYTES) throw new ArchiveError('too-large');
        const patch = Buffer.alloc(4);
        patch.writeUInt32LE(crc, 0);
        await target.write(patch, 0, 4, entryOffset + CRC_OFFSET_IN_LOCAL_HEADER);
      }

      sourceBytes += info.size;
      central.push({
        name: nameBytes,
        crc,
        compressedSize,
        uncompressedSize: info.size,
        method,
        offset: entryOffset,
        dosTime,
        dosDate,
      });
    }

    const centralStart = offset;
    for (const record of central) {
      const header = Buffer.alloc(CENTRAL_HEADER_LENGTH);
      header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(record.method, 10); // Offset 10, not 8. See the note above.
      header.writeUInt16LE(record.dosTime, 12);
      header.writeUInt16LE(record.dosDate, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.compressedSize, 20);
      header.writeUInt32LE(record.uncompressedSize, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt32LE(record.offset, 42);
      await put(header);
      await put(record.name);
    }

    const end = Buffer.alloc(EOCD_LENGTH);
    end.writeUInt32LE(EOCD_SIGNATURE, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await put(end);
  } finally {
    await target.close();
  }

  return Object.freeze({
    path: input.targetPath,
    entries: central.length,
    bytes: offset,
    sourceBytes,
  });
}

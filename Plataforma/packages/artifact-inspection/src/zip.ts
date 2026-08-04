import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

import { ArtifactInspectionError, type ArtifactInspectionLimits } from './types.js';

/**
 * Bounded ZIP central-directory reader.
 *
 * It reads the directory to learn what an artifact declares and inflates only
 * the handful of metadata entries the caller names. It never expands the whole
 * archive, never writes to disk, never loads a class and never deserializes an
 * arbitrary object — the only decoder used is raw DEFLATE from node:zlib.
 *
 * ZIP64, encryption and unknown compression methods are refused, not guessed.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_END_LOCATOR = 0x07064b50;

const EOCD_MINIMUM_LENGTH = 22;
const MAXIMUM_COMMENT_LENGTH = 0xffff;
const ZIP64_SENTINEL = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

/**
 * True when the name carries a C0 control character or DEL. Checked by code
 * point rather than a regex literal so the guard cannot be weakened by an
 * encoding accident in this source file.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
}

export interface ZipDirectory {
  readonly entries: readonly ZipEntry[];
}

function u16(view: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > view.length) {
    throw new ArtifactInspectionError('truncated-archive', 'directory');
  }
  return view.readUInt16LE(offset);
}

function u32(view: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > view.length) {
    throw new ArtifactInspectionError('truncated-archive', 'directory');
  }
  return view.readUInt32LE(offset);
}

/**
 * An entry name must be a plain relative POSIX path. Anything that could escape
 * a directory, name a drive or hide a control character is refused outright.
 * This package never writes an entry to disk, but a consumer downstream might,
 * so an unsafe name must not even reach a report.
 */
function validateEntryName(name: string, limits: ArtifactInspectionLimits): void {
  if (name.length === 0 || name.length > limits.maximumEntryNameLength) {
    throw new ArtifactInspectionError('entry-name-too-long', 'entry');
  }
  const segments = name.split('/');
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    WINDOWS_DRIVE_PREFIX.test(name) ||
    hasControlCharacter(name) ||
    segments.some((segment) => segment === '..' || segment === '.')
  ) {
    throw new ArtifactInspectionError('unsafe-entry-name', 'entry');
  }
  const depth = segments.filter((segment) => segment.length > 0).length;
  if (depth > limits.maximumEntryDepth) {
    throw new ArtifactInspectionError('entry-depth-exceeded', 'entry');
  }
}

function locateEndOfCentralDirectory(content: Buffer): number {
  if (content.length < EOCD_MINIMUM_LENGTH) {
    throw new ArtifactInspectionError('not-a-zip-container', 'container');
  }
  const earliest = Math.max(0, content.length - EOCD_MINIMUM_LENGTH - MAXIMUM_COMMENT_LENGTH);
  for (let offset = content.length - EOCD_MINIMUM_LENGTH; offset >= earliest; offset -= 1) {
    if (content.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      const commentLength = content.readUInt16LE(offset + 20);
      if (offset + EOCD_MINIMUM_LENGTH + commentLength === content.length) return offset;
    }
  }
  throw new ArtifactInspectionError('not-a-zip-container', 'container');
}

/** Reads and validates the central directory without expanding any entry. */
export function readZipDirectory(content: Buffer, limits: ArtifactInspectionLimits): ZipDirectory {
  const eocd = locateEndOfCentralDirectory(content);

  // A ZIP64 locator immediately before the EOCD means counts or offsets may not
  // fit in 32 bits. This package refuses that shape instead of half-reading it.
  if (eocd >= 20 && content.readUInt32LE(eocd - 20) === ZIP64_END_LOCATOR) {
    throw new ArtifactInspectionError('unsupported-zip-feature', 'container');
  }

  const totalEntries = u16(content, eocd + 10);
  const directorySize = u32(content, eocd + 12);
  const directoryOffset = u32(content, eocd + 16);

  // Multi-disk archives and split directories are out of scope.
  if (
    u16(content, eocd + 4) !== 0 ||
    u16(content, eocd + 6) !== 0 ||
    u16(content, eocd + 8) !== totalEntries
  ) {
    throw new ArtifactInspectionError('unsupported-zip-feature', 'container');
  }
  if (directoryOffset === ZIP64_SENTINEL || directorySize === ZIP64_SENTINEL) {
    throw new ArtifactInspectionError('unsupported-zip-feature', 'container');
  }
  if (totalEntries > limits.maximumEntries) {
    throw new ArtifactInspectionError('too-many-entries', 'directory');
  }
  if (directoryOffset + directorySize > content.length || directoryOffset > eocd) {
    throw new ArtifactInspectionError('truncated-archive', 'directory');
  }

  const directoryEnd = directoryOffset + directorySize;
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > directoryEnd || u32(content, cursor) !== CENTRAL_FILE_HEADER) {
      throw new ArtifactInspectionError('truncated-archive', 'directory');
    }
    const flags = u16(content, cursor + 8);
    const compressionMethod = u16(content, cursor + 10);
    const compressedSize = u32(content, cursor + 20);
    const uncompressedSize = u32(content, cursor + 24);
    const nameLength = u16(content, cursor + 28);
    const extraLength = u16(content, cursor + 30);
    const commentLength = u16(content, cursor + 32);
    const localHeaderOffset = u32(content, cursor + 42);

    // Bit 0 marks an encrypted entry, which can never be inspected.
    if ((flags & 0x1) !== 0) {
      throw new ArtifactInspectionError('encrypted-entry', 'entry');
    }
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new ArtifactInspectionError('unsupported-zip-feature', 'entry');
    }

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > directoryEnd) {
      throw new ArtifactInspectionError('truncated-archive', 'directory');
    }
    // Only names that round-trip as UTF-8 are accepted, so a lossy replacement
    // character can never enter a report.
    const rawName = content.subarray(nameStart, nameEnd);
    const name = rawName.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(rawName)) {
      throw new ArtifactInspectionError('unsafe-entry-name', 'entry');
    }
    validateEntryName(name, limits);

    // Entry data always precedes the central directory in a well-formed archive.
    if (localHeaderOffset >= directoryOffset) {
      throw new ArtifactInspectionError('truncated-archive', 'entry');
    }

    entries.push(
      Object.freeze({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isDirectory: name.endsWith('/'),
      }),
    );

    cursor = nameEnd + extraLength + commentLength;
    if (cursor > directoryEnd) {
      throw new ArtifactInspectionError('truncated-archive', 'directory');
    }
  }

  return Object.freeze({ entries: Object.freeze(entries) });
}

/** Remaining bytes an inspection may still expand across all entries. */
export interface ExpansionBudget {
  remaining: number;
}

/**
 * Inflates exactly one entry, refusing before allocating anything when the
 * declared size, the remaining budget or the compression ratio is implausible.
 */
export function readZipEntry(
  content: Buffer,
  entry: ZipEntry,
  limits: ArtifactInspectionLimits,
  budget: ExpansionBudget,
): Buffer {
  if (entry.isDirectory) {
    throw new ArtifactInspectionError('invalid-metadata', 'entry');
  }
  if (entry.uncompressedSize > limits.maximumMetadataBytes) {
    throw new ArtifactInspectionError('metadata-too-large', 'entry');
  }
  if (entry.uncompressedSize > budget.remaining) {
    throw new ArtifactInspectionError('expansion-limit-exceeded', 'entry');
  }
  // A ZIP bomb declares a tiny compressed size against a huge expansion. This
  // check uses the declared sizes only, so it happens before any allocation.
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > limits.maximumCompressionRatio
  ) {
    throw new ArtifactInspectionError('compression-ratio-exceeded', 'entry');
  }
  if (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATED) {
    throw new ArtifactInspectionError('unsupported-zip-feature', 'entry');
  }
  if (entry.compressionMethod === STORED && entry.compressedSize !== entry.uncompressedSize) {
    throw new ArtifactInspectionError('entry-size-mismatch', 'entry');
  }

  const header = entry.localHeaderOffset;
  if (u32(content, header) !== LOCAL_FILE_HEADER) {
    throw new ArtifactInspectionError('truncated-archive', 'entry');
  }
  const nameLength = u16(content, header + 26);
  const extraLength = u16(content, header + 28);
  const dataStart = header + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > content.length) {
    throw new ArtifactInspectionError('truncated-archive', 'entry');
  }

  const compressed = content.subarray(dataStart, dataEnd);
  let expanded: Buffer;
  if (entry.compressionMethod === STORED) {
    expanded = Buffer.from(compressed);
  } else {
    try {
      // maxOutputLength is a hard stop even if the declared size lied.
      expanded = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
    } catch {
      throw new ArtifactInspectionError('invalid-metadata', 'entry');
    }
  }

  // The declared size is authoritative; a mismatch means the directory lied.
  if (expanded.length !== entry.uncompressedSize) {
    throw new ArtifactInspectionError('entry-size-mismatch', 'entry');
  }
  budget.remaining -= expanded.length;
  return expanded;
}

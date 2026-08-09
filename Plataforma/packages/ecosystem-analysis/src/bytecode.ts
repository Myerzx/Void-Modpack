import {
  ClassFileInspectionError,
  DEFAULT_ARTIFACT_INSPECTION_LIMITS,
  inspectClassFile,
  readSelectedEntries,
  type ClassFileInspection,
  type ZipEntry,
} from '@voidfall/artifact-inspection';

export interface ArchiveBytecodeLimits {
  readonly maximumClasses: number;
  readonly maximumExpandedBytes: number;
  readonly maximumClassBytes: number;
}

export const DEFAULT_ARCHIVE_BYTECODE_LIMITS: ArchiveBytecodeLimits = Object.freeze({
  maximumClasses: 256,
  maximumExpandedBytes: 8 * 1024 * 1024,
  maximumClassBytes: 1024 * 1024,
});

export interface InspectedArchiveClass {
  readonly entry: string;
  readonly report: ClassFileInspection;
}

export interface ArchiveBytecodeInspection {
  readonly eligibleClasses: number;
  readonly inspectedClasses: readonly InspectedArchiveClass[];
  readonly expandedBytes: number;
  readonly refusedClasses: number;
  readonly limited: boolean;
}

const PRIORITY_SEGMENT = /^(?:client)?(?:config|configs|configuration|registry|registries|registrator|registrators|mixin|mixins|compat|compatibility|integration|integrations|plugin|plugins)/u;

export function isPriorityClassEntry(entry: string): boolean {
  if (!entry.endsWith('.class')) return false;
  return entry
    .toLocaleLowerCase('en-US')
    .split('/')
    .some((segment) => PRIORITY_SEGMENT.test(segment));
}

function validatedLimits(input?: Partial<ArchiveBytecodeLimits>): ArchiveBytecodeLimits {
  const limits = { ...DEFAULT_ARCHIVE_BYTECODE_LIMITS, ...input };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('ecosystem-bytecode:invalid-limits');
  }
  return Object.freeze(limits);
}

/**
 * Reads only high-signal class entries selected from an already validated ZIP
 * directory. It neither loads classes nor searches by content.
 */
export function inspectArchiveBytecode(input: {
  readonly content: Uint8Array;
  readonly entries: readonly ZipEntry[];
  readonly limits?: Partial<ArchiveBytecodeLimits>;
}): ArchiveBytecodeInspection {
  const limits = validatedLimits(input.limits);
  const eligible = input.entries
    .filter((entry) => !entry.isDirectory && isPriorityClassEntry(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  const selected: ZipEntry[] = [];
  let declaredBytes = 0;
  for (const entry of eligible) {
    if (selected.length >= limits.maximumClasses) break;
    if (entry.uncompressedSize > limits.maximumClassBytes) continue;
    if (declaredBytes + entry.uncompressedSize > limits.maximumExpandedBytes) continue;
    selected.push(entry);
    declaredBytes += entry.uncompressedSize;
  }
  if (selected.length === 0) {
    return Object.freeze({
      eligibleClasses: eligible.length,
      inspectedClasses: Object.freeze([]),
      expandedBytes: 0,
      refusedClasses: eligible.length,
      limited: eligible.length > 0,
    });
  }
  const read = readSelectedEntries({
    content: input.content,
    names: selected.map((entry) => entry.name),
    budgetBytes: Math.max(1, declaredBytes),
    limits: {
      maximumDirectoryBytes: DEFAULT_ARTIFACT_INSPECTION_LIMITS.maximumDirectoryBytes,
      maximumMetadataBytes: limits.maximumClassBytes,
      maximumExpandedBytes: limits.maximumExpandedBytes,
    },
  });
  const inspected: InspectedArchiveClass[] = [];
  let refusedClasses = eligible.length - selected.length;
  for (const entry of selected) {
    const content = read.get(entry.name.toLocaleLowerCase('en-US'));
    if (content === undefined) {
      refusedClasses += 1;
      continue;
    }
    try {
      inspected.push(Object.freeze({
        entry: entry.name,
        report: inspectClassFile(content, { maximumBytes: limits.maximumClassBytes }),
      }));
    } catch (error) {
      if (!(error instanceof ClassFileInspectionError)) throw error;
      refusedClasses += 1;
    }
  }
  return Object.freeze({
    eligibleClasses: eligible.length,
    inspectedClasses: Object.freeze(inspected),
    expandedBytes: inspected.reduce((total, item) => {
      const entry = selected.find((candidate) => candidate.name === item.entry);
      return total + (entry?.uncompressedSize ?? 0);
    }, 0),
    refusedClasses,
    limited: refusedClasses > 0,
  });
}

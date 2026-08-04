export type MavenVersionRangeResult = 'match' | 'mismatch' | 'unknown';

type Separator = '' | '.' | '-';

interface VersionToken {
  readonly separator: Separator;
  readonly value: string;
  readonly numeric: boolean;
}

interface VersionRestriction {
  readonly lower?: string;
  readonly lowerInclusive: boolean;
  readonly upper?: string;
  readonly upperInclusive: boolean;
}

const QUALIFIER_ORDER = new Map<string, number>([
  ['alpha', 0],
  ['beta', 1],
  ['milestone', 2],
  ['rc', 3],
  ['snapshot', 4],
  ['', 5],
  ['sp', 6],
]);

function qualifier(value: string): string {
  const lowered = value.toLocaleLowerCase('en-US');
  if (lowered === 'cr') return 'rc';
  if (lowered === 'final' || lowered === 'ga' || lowered === 'release') return '';
  if (lowered === 'a') return 'alpha';
  if (lowered === 'b') return 'beta';
  if (lowered === 'm') return 'milestone';
  return lowered;
}

function nullToken(token: VersionToken): boolean {
  return token.numeric ? /^0+$/u.test(token.value) : qualifier(token.value) === '';
}

function tokenizeVersion(value: string): VersionToken[] | undefined {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[0-9A-Za-z][0-9A-Za-z._+\-]*$/u.test(normalized)
  ) {
    return undefined;
  }

  const tokens: VersionToken[] = [];
  let current = '';
  let separator: Separator = '';
  let numeric: boolean | undefined;
  const push = (): void => {
    const valueToPush = current.length === 0 ? '0' : current;
    tokens.push({ separator, value: valueToPush, numeric: /^\d+$/u.test(valueToPush) });
    current = '';
    numeric = undefined;
  };

  for (const character of normalized) {
    if (character === '.' || character === '-' || character === '_') {
      push();
      separator = character === '.' ? '.' : '-';
      continue;
    }
    const nextNumeric = /^\d$/u.test(character);
    if (current.length > 0 && numeric !== nextNumeric) {
      push();
      separator = '-';
    }
    current += character.toLocaleLowerCase('en-US');
    numeric = nextNumeric;
  }
  push();

  while (tokens.length > 1 && nullToken(tokens[tokens.length - 1] as VersionToken)) {
    tokens.pop();
  }
  return tokens;
}

function paddedToken(other: VersionToken): VersionToken {
  if (other.separator === '.' && other.numeric) {
    return { separator: '.', value: '0', numeric: true };
  }
  return { separator: other.separator, value: '', numeric: false };
}

function tokenClass(token: VersionToken): number {
  if (!token.numeric) return 0;
  return token.separator === '.' || token.separator === '' ? 2 : 1;
}

function compareQualifiers(left: string, right: string): number {
  const normalizedLeft = qualifier(left);
  const normalizedRight = qualifier(right);
  const leftRank = QUALIFIER_ORDER.get(normalizedLeft);
  const rightRank = QUALIFIER_ORDER.get(normalizedRight);
  if (leftRank !== undefined || rightRank !== undefined) {
    const actualLeft = leftRank ?? 7;
    const actualRight = rightRank ?? 7;
    if (actualLeft !== actualRight) return actualLeft < actualRight ? -1 : 1;
  }
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function compareTokens(left: VersionToken, right: VersionToken): number {
  const leftClass = tokenClass(left);
  const rightClass = tokenClass(right);
  if (leftClass !== rightClass) return leftClass < rightClass ? -1 : 1;
  if (left.numeric && right.numeric) {
    const normalizedLeft = left.value.replace(/^0+(?=\d)/u, '');
    const normalizedRight = right.value.replace(/^0+(?=\d)/u, '');
    if (normalizedLeft.length !== normalizedRight.length) {
      return normalizedLeft.length < normalizedRight.length ? -1 : 1;
    }
    return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
  }
  if (!left.numeric && !right.numeric) return compareQualifiers(left.value, right.value);
  return left.numeric ? 1 : -1;
}

export function compareMavenVersions(left: string, right: string): number | undefined {
  const leftTokens = tokenizeVersion(left);
  const rightTokens = tokenizeVersion(right);
  if (leftTokens === undefined || rightTokens === undefined) return undefined;

  const length = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index] ?? paddedToken(rightTokens[index] as VersionToken);
    const rightToken = rightTokens[index] ?? paddedToken(leftTokens[index] as VersionToken);
    const compared = compareTokens(leftToken, rightToken);
    if (compared !== 0) return compared;
  }
  return 0;
}

function parseVersionRange(value: string): VersionRestriction[] | undefined {
  const spec = value.trim();
  if (spec.length === 0 || spec.length > 128 || spec === '*') return undefined;

  const restrictions: VersionRestriction[] = [];
  let index = 0;
  while (index < spec.length) {
    const opening = spec[index];
    if (opening !== '[' && opening !== '(') return undefined;
    let closingIndex = index + 1;
    while (
      closingIndex < spec.length &&
      spec[closingIndex] !== ']' &&
      spec[closingIndex] !== ')'
    ) {
      closingIndex += 1;
    }
    if (closingIndex >= spec.length) return undefined;
    const closing = spec[closingIndex] as ']' | ')';
    const body = spec.slice(index + 1, closingIndex).trim();
    const commas = [...body].filter((character) => character === ',').length;
    if (commas === 0) {
      if (opening !== '[' || closing !== ']' || tokenizeVersion(body) === undefined) return undefined;
      restrictions.push({
        lower: body,
        lowerInclusive: true,
        upper: body,
        upperInclusive: true,
      });
    } else if (commas === 1) {
      const [rawLower = '', rawUpper = ''] = body.split(',', 2);
      const lower = rawLower.trim();
      const upper = rawUpper.trim();
      if (
        (lower.length === 0 && upper.length === 0) ||
        (lower.length > 0 && tokenizeVersion(lower) === undefined) ||
        (upper.length > 0 && tokenizeVersion(upper) === undefined)
      ) {
        return undefined;
      }
      restrictions.push({
        ...(lower.length > 0 ? { lower } : {}),
        lowerInclusive: opening === '[',
        ...(upper.length > 0 ? { upper } : {}),
        upperInclusive: closing === ']',
      });
    } else {
      return undefined;
    }

    index = closingIndex + 1;
    if (index === spec.length) break;
    if (spec[index] !== ',') return undefined;
    index += 1;
    while (index < spec.length && /\s/u.test(spec[index] as string)) index += 1;
  }
  return restrictions.length > 0 ? restrictions : undefined;
}

function matchesRestriction(version: string, restriction: VersionRestriction): boolean | undefined {
  if (restriction.lower !== undefined) {
    const compared = compareMavenVersions(version, restriction.lower);
    if (compared === undefined) return undefined;
    if (compared < 0 || (compared === 0 && !restriction.lowerInclusive)) return false;
  }
  if (restriction.upper !== undefined) {
    const compared = compareMavenVersions(version, restriction.upper);
    if (compared === undefined) return undefined;
    if (compared > 0 || (compared === 0 && !restriction.upperInclusive)) return false;
  }
  return true;
}

export function evaluateMavenVersionRange(
  version: string | undefined,
  declaredRange: string | undefined,
): MavenVersionRangeResult {
  if (version === undefined) return 'unknown';
  if (declaredRange === undefined || declaredRange.trim() === '') return 'match';
  const recommendedVersion = declaredRange.trim();
  if (!recommendedVersion.startsWith('[') && !recommendedVersion.startsWith('(')) {
    const compared = compareMavenVersions(version, recommendedVersion);
    return compared === 0 ? 'match' : 'unknown';
  }
  const restrictions = parseVersionRange(declaredRange);
  if (restrictions === undefined) return 'unknown';

  let unknown = false;
  for (const restriction of restrictions) {
    const result = matchesRestriction(version, restriction);
    if (result === true) return 'match';
    if (result === undefined) unknown = true;
  }
  return unknown ? 'unknown' : 'mismatch';
}

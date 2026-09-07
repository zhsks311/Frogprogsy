export interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (number | string)[];
}

export function parseSemVer(value: string): ParsedSemVer | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease: (number | string)[] = [];
  for (const identifier of match[4]?.split(".") ?? []) {
    if (/^\d+$/.test(identifier)) {
      if (!/^(0|[1-9]\d*)$/.test(identifier)) return null;
      const numeric = Number(identifier);
      if (!Number.isSafeInteger(numeric)) return null;
      prerelease.push(numeric);
    } else {
      prerelease.push(identifier);
    }
  }
  return { major, minor, patch, prerelease };
}

export function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Stable package channels use one canonical `X.Y.Z` spelling: no `v`, prerelease, or build metadata. */
export function parseCanonicalStableSemVer(value: string): ParsedSemVer | null {
  const parsed = parseSemVer(value);
  if (!parsed || parsed.prerelease.length > 0) return null;
  return value === `${parsed.major}.${parsed.minor}.${parsed.patch}` ? parsed : null;
}

/** Minimal semver parsing/comparison (major.minor.patch, prerelease sorts lower). */

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string
}

export function parseSemver(version: string): Semver | null {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? '' }
}

/** Compare two versions; unreadable versions sort lowest. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease === right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

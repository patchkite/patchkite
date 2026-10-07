import semver from "semver";

/** Validate a target binary version/range (e.g. "1.0.0", "1.2.x", "^1.2.3", "*"). */
export function isValidVersionRange(range: string): boolean {
  return semver.validRange(range) !== null;
}

/** "1.0" → "1.0.0" so native app versions can still be matched. */
export function normalizeAppVersion(version: string): string {
  const parts = version.trim().split("-")[0]!.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".");
}

export function isAppVersionInRange(appVersion: string, range: string): boolean {
  const v = semver.valid(normalizeAppVersion(appVersion));
  if (!v) return false;
  return semver.satisfies(v, range);
}

/** Whether `range` matches exactly one version (used for the update_app_version message). */
export function isExactVersion(range: string): boolean {
  return semver.valid(range) !== null;
}

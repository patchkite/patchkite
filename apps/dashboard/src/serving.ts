import type { Package } from "@patchkite/shared";
import semver from "semver";

/**
 * Releases still served to devices: enabled releases whose target binary range is
 * not yet fully covered by a newer enabled release (full rollout).
 * E.g. v2 (1.0.0) stays active even with v3 (1.1.x), because app 1.0.0 still receives v2.
 */
/** Newer release that fully replaces history[i] for all of its target binaries. */
export function replacedBy(history: Package[], i: number): Package | undefined {
  const p = history[i]!;
  return history.slice(i + 1).find((later) => {
    if (later.isDisabled || (later.rollout != null && later.rollout < 100)) return false;
    try {
      return semver.subset(p.appVersion, later.appVersion);
    } catch {
      return false;
    }
  });
}

export function activeLabels(history: Package[]): Set<string> {
  const active = new Set<string>();
  history.forEach((p, i) => {
    if (!p.isDisabled && !replacedBy(history, i)) active.add(p.label);
  });
  return active;
}

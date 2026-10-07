import { isAppVersionInRange, isClientInRollout, normalizeAppVersion } from "@patchkite/shared";
import semver from "semver";

export interface HistoryEntry {
  label: string;
  appVersion: string;
  packageHash: string;
  isDisabled: boolean;
  isMandatory: boolean;
  rollout: number | null;
  engineRevision?: string | null;
}

export interface UpdateCheckRequest {
  appVersion: string;
  packageHash?: string;
  label?: string;
  clientUniqueId?: string;
  isCompanion?: boolean;
  engineRevision?: string;
}

export type UpdateDecision<T extends HistoryEntry> =
  | {
      kind: "update";
      package: T;
      isMandatory: boolean;
    }
  | {
      kind: "none";
      /** Client is running an update that is no longer valid → fall back to the binary. */
      shouldRunBinaryVersion: boolean;
      /** All releases target a newer binary version → user needs to update from the store. */
      updateAppVersion: boolean;
      targetBinaryRange: string;
    };

/**
 * Update selection logic:
 * - walk the history from the newest release to the oldest,
 * - skip releases that are disabled / outside the version range / outside the rollout / on a different engine,
 * - the update becomes mandatory if there is a mandatory release between the client's version and the latest.
 */
export function decideUpdate<T extends HistoryEntry>(history: T[], req: UpdateCheckRequest): UpdateDecision<T> {
  const appVersion = normalizeAppVersion(req.appVersion);
  let foundCurrent = false;
  let latestEnabled: T | undefined;
  let latestSatisfying: T | undefined;
  let mandatory = false;

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    const isCurrent =
      (!!req.label && entry.label === req.label) || (!req.label && !!req.packageHash && entry.packageHash === req.packageHash);
    // A client without label/hash (stock binary) is treated as "found" immediately.
    foundCurrent = foundCurrent || isCurrent || (!req.label && !req.packageHash);

    if (entry.isDisabled) continue;
    latestEnabled ??= entry;

    if (!req.isCompanion && !isAppVersionInRange(appVersion, entry.appVersion)) continue;
    if (entry.engineRevision && req.engineRevision && entry.engineRevision !== req.engineRevision) continue;
    if (!isCurrent && req.clientUniqueId && !isClientInRollout(req.clientUniqueId, entry.label, entry.rollout)) continue;
    if (!isCurrent && !req.clientUniqueId && entry.rollout != null && entry.rollout < 100) continue;

    if (!latestSatisfying) {
      latestSatisfying = entry;
      // The latest release itself is mandatory.
      if (entry.isMandatory) mandatory = true;
    }
    if (foundCurrent) break;
    if (entry.isMandatory) {
      mandatory = true;
      break;
    }
  }

  if (!latestSatisfying) {
    const range = latestEnabled?.appVersion ?? "";
    let updateAppVersion = false;
    if (latestEnabled && semver.validRange(range)) {
      updateAppVersion = semver.ltr(appVersion, range);
    }
    return {
      kind: "none",
      shouldRunBinaryVersion: !!req.packageHash,
      updateAppVersion,
      targetBinaryRange: range,
    };
  }

  if (req.packageHash && latestSatisfying.packageHash === req.packageHash) {
    return { kind: "none", shouldRunBinaryVersion: false, updateAppVersion: false, targetBinaryRange: latestSatisfying.appVersion };
  }

  return { kind: "update", package: latestSatisfying, isMandatory: mandatory };
}

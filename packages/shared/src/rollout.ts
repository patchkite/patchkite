import { createHash } from "node:crypto";

/**
 * Deterministic rollout: the same client for the same label always gets the same result.
 */
export function isClientInRollout(clientUniqueId: string, label: string, rollout: number | null | undefined): boolean {
  if (rollout == null || rollout >= 100) return true;
  if (rollout <= 0) return false;
  const digest = createHash("sha256").update(`${clientUniqueId}:${label}`).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < rollout;
}

import { randomBytes } from "node:crypto";

/** Random deployment key (32-char base64url). */
export function generateDeploymentKey(): string {
  return randomBytes(24).toString("base64url");
}

export function generateAccessKey(): string {
  return randomBytes(30).toString("base64url");
}

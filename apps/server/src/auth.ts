import { hash, verify } from "@node-rs/argon2";
import { generateAccessKey, sha256 } from "@patchkite/shared";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Db } from "./db/index.js";
import { accessKeys, users, type DbUser } from "./db/schema.js";
import { unauthorized } from "./errors.js";

export const hashPassword = (password: string) => hash(password);
export const verifyPassword = (hashed: string, password: string) => verify(hashed, password);

/** Max password length; argon2 on very long inputs could be abused to load the CPU. */
export const MAX_PASSWORD_LENGTH = 256;

let dummyHash: Promise<string> | undefined;
/**
 * Verify a login in the same time whether or not the user exists,
 * so the existence of an email can't be inferred from response timing.
 */
export async function verifyLogin(user: { passwordHash: string } | undefined, password: string) {
  if (user) return verifyPassword(user.passwordHash, password);
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummyHash, password);
  return false;
}

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_ACCESS_KEY_TTL = 60 * DAY;
export const SESSION_TTL = 30 * DAY;

export async function issueAccessKey(
  db: Db,
  user: DbUser,
  opts: { friendlyName: string; createdBy: string; ttlMs?: number; isSession?: boolean },
) {
  const key = generateAccessKey();
  const [row] = await db
    .insert(accessKeys)
    .values({
      userId: user.id,
      name: randomBytes(12).toString("base64url"),
      friendlyName: opts.friendlyName,
      keyHash: sha256(key),
      createdBy: opts.createdBy,
      isSession: opts.isSession ?? false,
      expiresAt: new Date(Date.now() + (opts.ttlMs ?? DEFAULT_ACCESS_KEY_TTL)),
    })
    .returning();
  return { key, row: row! };
}

export async function authenticate(db: Db, req: FastifyRequest): Promise<DbUser> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!token) throw unauthorized("Access key required. Run `patchkite login`.");
  const [found] = await db
    .select({ user: users, key: accessKeys })
    .from(accessKeys)
    .innerJoin(users, eq(users.id, accessKeys.userId))
    .where(eq(accessKeys.keyHash, sha256(token)));
  if (!found || found.key.expiresAt.getTime() < Date.now()) throw unauthorized("Access key is invalid or expired");
  return found.user;
}

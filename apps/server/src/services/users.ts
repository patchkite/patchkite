import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth.js";
import type { Db } from "../db/index.js";
import { accessKeys, apps, collaborators, users, type DbUser } from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";

export const generatePassword = () => randomBytes(12).toString("base64url");

export interface UserSummary {
  email: string;
  name: string;
  isAdmin: boolean;
  createdTime: number;
  /** Number of apps owned (Owner). */
  ownedApps: number;
}

/** Account management: own profile and admin operations (create, delete, reset password, role). */
export class UserService {
  constructor(readonly db: Db) {}

  async isEmpty() {
    const [row] = await this.db.select({ n: count() }).from(users);
    return Number(row?.n ?? 0) === 0;
  }

  async create(input: { email: string; name?: string; password: string; isAdmin?: boolean }) {
    const email = input.email.toLowerCase();
    const [exists] = await this.db.select().from(users).where(eq(users.email, email));
    if (exists) throw conflict("Email is already registered");
    // The first user on the server is always an admin, so a new server can be managed.
    const isAdmin = input.isAdmin || (await this.isEmpty());
    const [user] = await this.db
      .insert(users)
      .values({ email, name: input.name ?? email.split("@")[0]!, passwordHash: await hashPassword(input.password), isAdmin })
      .returning();
    return user!;
  }

  async byEmail(email: string) {
    const [u] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (!u) throw notFound(`User "${email}"`);
    return u;
  }

  requireAdmin(user: DbUser) {
    if (!user.isAdmin) throw forbidden("Only server admins can do this");
  }

  async list(): Promise<UserSummary[]> {
    const rows = await this.db
      .select({
        user: users,
        ownedApps: sql<number>`(select count(*) from ${collaborators} where ${collaborators.userId} = ${users.id} and ${collaborators.permission} = 'Owner')`,
      })
      .from(users)
      .orderBy(asc(users.id));
    return rows.map(({ user, ownedApps }) => ({
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      createdTime: user.createdAt.getTime(),
      ownedApps: Number(ownedApps),
    }));
  }

  /** Delete all of the user's login sessions and access keys, except the key currently in use. */
  async revokeKeys(userId: number, opts: { keepKeyHash?: string; sessionsOnly?: boolean } = {}) {
    const conds = [eq(accessKeys.userId, userId)];
    if (opts.keepKeyHash) conds.push(ne(accessKeys.keyHash, opts.keepKeyHash));
    if (opts.sessionsOnly) conds.push(eq(accessKeys.isSession, true));
    await this.db.delete(accessKeys).where(and(...conds));
  }

  async updateProfile(
    user: DbUser,
    patch: { name?: string; currentPassword?: string; newPassword?: string },
    currentKeyHash: string,
  ) {
    const set: Partial<DbUser> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.newPassword !== undefined) {
      if (!patch.currentPassword || !(await verifyPassword(user.passwordHash, patch.currentPassword))) {
        throw unauthorized("Current password is incorrect");
      }
      set.passwordHash = await hashPassword(patch.newPassword);
    }
    if (Object.keys(set).length === 0) throw badRequest("No changes provided");
    await this.db.update(users).set(set).where(eq(users.id, user.id));
    // Changing the password signs out all other login sessions (CI access keys stay valid).
    if (set.passwordHash) await this.revokeKeys(user.id, { keepKeyHash: currentKeyHash, sessionsOnly: true });
  }

  /** Password reset by an admin: temporary password + all sessions and access keys revoked. */
  async resetPassword(email: string) {
    const target = await this.byEmail(email);
    const password = generatePassword();
    await this.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, target.id));
    await this.revokeKeys(target.id);
    return password;
  }

  private async ensureOtherAdmin(target: DbUser) {
    if (!target.isAdmin) return;
    const [row] = await this.db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.isAdmin, true), ne(users.id, target.id)));
    if (Number(row?.n ?? 0) === 0) throw badRequest("The server must have at least one admin");
  }

  async setAdmin(email: string, isAdmin: boolean) {
    const target = await this.byEmail(email);
    if (!isAdmin) await this.ensureOtherAdmin(target);
    await this.db.update(users).set({ isAdmin }).where(eq(users.id, target.id));
  }

  /**
   * Delete a user. Apps owned by the user must be transferred to `transferTo`;
   * otherwise the deletion is rejected so apps don't lose their owner.
   */
  async remove(email: string, transferTo?: string) {
    const target = await this.byEmail(email);
    await this.ensureOtherAdmin(target);
    const owned = await this.db
      .select({ appId: collaborators.appId, name: apps.name })
      .from(collaborators)
      .innerJoin(apps, eq(apps.id, collaborators.appId))
      .where(and(eq(collaborators.userId, target.id), eq(collaborators.permission, "Owner")));

    if (owned.length) {
      if (!transferTo) {
        throw conflict(
          `User still owns apps: ${owned.map((a) => a.name).join(", ")}. Transfer them to another user with transferTo, or delete the apps.`,
        );
      }
      const heir = await this.byEmail(transferTo);
      if (heir.id === target.id) throw badRequest("transferTo must be a different user");
      await this.db
        .insert(collaborators)
        .values(owned.map((a) => ({ appId: a.appId, userId: heir.id, permission: "Owner" as const })))
        .onConflictDoUpdate({ target: [collaborators.appId, collaborators.userId], set: { permission: "Owner" } });
    }
    // Collaborators and access keys are deleted via ON DELETE CASCADE.
    await this.db.delete(users).where(eq(users.id, target.id));
    return { transferred: owned.map((a) => a.name) };
  }
}


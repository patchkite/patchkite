import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, MAX_PASSWORD_LENGTH } from "../auth.js";
import { collectGarbage } from "../services/gc.js";
import type { ManagementService } from "../services/management.js";
import { generatePassword, type UserService } from "../services/users.js";

type P = Record<string, string>;

/** Server-admin-only endpoints: user management and storage cleanup. */
export async function adminRoutes(app: FastifyInstance, svc: ManagementService, users: UserService) {
  const admin = async (req: Parameters<typeof authenticate>[1]) => {
    const user = await authenticate(svc.db, req);
    users.requireAdmin(user);
    return user;
  };

  app.get("/admin/users", async (req) => {
    await admin(req);
    return { users: await users.list() };
  });

  app.post("/admin/users", async (req) => {
    await admin(req);
    const body = z
      .object({
        email: z.email().max(254),
        name: z.string().min(1).max(100).optional(),
        password: z.string().min(8).max(MAX_PASSWORD_LENGTH).optional(),
        isAdmin: z.boolean().optional(),
      })
      .parse(req.body);
    // No password given: generate a temporary password that is shown once to the admin.
    const password = body.password ?? generatePassword();
    const user = await users.create({ ...body, password });
    return { user: { email: user.email, name: user.name, isAdmin: user.isAdmin }, password: body.password ? undefined : password };
  });

  app.patch<{ Params: P }>("/admin/users/:email", async (req) => {
    await admin(req);
    const body = z.object({ isAdmin: z.boolean() }).parse(req.body);
    await users.setAdmin(req.params.email!, body.isAdmin);
    return { ok: true };
  });

  app.post<{ Params: P }>("/admin/users/:email/reset-password", async (req) => {
    await admin(req);
    return { password: await users.resetPassword(req.params.email!) };
  });

  app.delete<{ Params: P; Querystring: P }>("/admin/users/:email", async (req) => {
    await admin(req);
    return users.remove(req.params.email!, req.query.transferTo);
  });

  app.post<{ Querystring: P }>("/admin/gc", async (req) => {
    await admin(req);
    const dryRun = z.stringbool().optional().parse(req.query.dryRun);
    return collectGarbage(svc.db, svc.storage, { graceMs: svc.env.GC_GRACE_MINUTES * 60_000, dryRun });
  });
}

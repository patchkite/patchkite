import { OSES, PLATFORMS, patchMetadataSchema, releaseMetadataSchema, sha256 } from "@patchkite/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { authenticate, issueAccessKey, MAX_PASSWORD_LENGTH, SESSION_TTL, verifyLogin } from "../auth.js";
import { accessKeys, users, type DbUser } from "../db/schema.js";
import { badRequest, conflict, forbidden, HttpError, unauthorized } from "../errors.js";
import type { ManagementService } from "../services/management.js";
import type { UserService } from "../services/users.js";
import { withTempDir } from "../zip.js";

type P = Record<string, string>;

const password = z.string().min(8).max(MAX_PASSWORD_LENGTH);
const resourceName = z.string().min(1).max(100).regex(/^[\w.-]+$/, "Name may only contain letters, digits, '.', '_' and '-'");
/** Access key lifetime, at most 10 years. */
const accessKeyTtl = z.number().int().positive().max(10 * 365 * 24 * 60 * 60 * 1000);
const credentials = z.object({ email: z.email().max(254).transform((e) => e.toLowerCase()), password });

export async function managementRoutes(app: FastifyInstance, svc: ManagementService, userSvc: UserService) {
  const db = svc.db;
  const auth = (req: FastifyRequest): Promise<DbUser> => authenticate(db, req);

  // ---------- Auth ----------
  // Limit login/registration attempts per IP (prevents password brute forcing).
  const authLimit =
    svc.env.RATE_LIMIT_AUTH_PER_MINUTE > 0
      ? { config: { rateLimit: { max: svc.env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } } }
      : {};

  app.post("/auth/register", authLimit, async (req) => {
    const body = credentials.extend({ name: z.string().min(1).max(100).optional(), hostname: z.string().max(100).optional() }).parse(req.body);
    // Open registration can be disabled; the first (admin) account can always be created.
    if (!svc.env.ALLOW_REGISTRATION && !(await userSvc.isEmpty())) {
      throw forbidden("Registration is closed on this server. Ask an admin to create an account for you.");
    }
    const user = await userSvc.create(body);
    const { key } = await issueAccessKey(db, user, {
      friendlyName: `Login-${body.hostname ?? "web"}`,
      createdBy: body.hostname ?? "web",
      isSession: true,
      ttlMs: SESSION_TTL,
    });
    return { accessKey: key };
  });

  app.post("/auth/login", authLimit, async (req) => {
    const body = credentials.extend({ hostname: z.string().max(100).optional() }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    if (!(await verifyLogin(user, body.password)) || !user) throw unauthorized("Incorrect email or password");
    const { key } = await issueAccessKey(db, user, {
      friendlyName: `Login-${body.hostname ?? "web"}`,
      createdBy: body.hostname ?? "web",
      isSession: true,
      ttlMs: SESSION_TTL,
    });
    return { accessKey: key };
  });

  app.post("/auth/logout", async (req) => {
    const user = await auth(req);
    const token = req.headers.authorization!.slice(7).trim();
    await db.delete(accessKeys).where(and(eq(accessKeys.userId, user.id), eq(accessKeys.keyHash, sha256(token))));
    return { ok: true };
  });

  app.get("/account", async (req) => {
    const u = await auth(req);
    return { account: { email: u.email, name: u.name, isAdmin: u.isAdmin } };
  });

  app.patch("/account", async (req) => {
    const user = await auth(req);
    const body = z
      .object({ name: z.string().min(1).max(100).optional(), currentPassword: z.string().max(MAX_PASSWORD_LENGTH).optional(), newPassword: password.optional() })
      .parse(req.body);
    await userSvc.updateProfile(user, body, sha256(req.headers.authorization!.slice(7).trim()));
    return { ok: true };
  });

  // ---------- Access keys ----------
  app.get("/accessKeys", async (req) => ({ accessKeys: await svc.listAccessKeys(await auth(req)) }));

  app.post("/accessKeys", async (req) => {
    const user = await auth(req);
    const body = z
      .object({ friendlyName: z.string().min(1).max(100), ttl: accessKeyTtl.optional(), createdBy: z.string().max(100).optional() })
      .parse(req.body);
    const existing = await svc.listAccessKeys(user);
    if (existing.some((k) => k.friendlyName === body.friendlyName)) throw conflict(`Access key "${body.friendlyName}" already exists`);
    const { key, row } = await issueAccessKey(db, user, {
      friendlyName: body.friendlyName,
      createdBy: body.createdBy ?? "cli",
      ttlMs: body.ttl,
    });
    return {
      accessKey: {
        key,
        name: row.name,
        friendlyName: row.friendlyName,
        createdBy: row.createdBy,
        createdTime: row.createdAt.getTime(),
        expires: row.expiresAt.getTime(),
      },
    };
  });

  app.patch<{ Params: P }>("/accessKeys/:name", async (req) => {
    const body = z.object({ friendlyName: z.string().min(1).max(100).optional(), ttl: accessKeyTtl.optional() }).parse(req.body);
    await svc.patchAccessKey(await auth(req), req.params.name!, body);
    return { ok: true };
  });

  app.delete<{ Params: P }>("/accessKeys/:name", async (req) => {
    await svc.removeAccessKey(await auth(req), req.params.name!);
    return { ok: true };
  });

  app.delete<{ Querystring: P }>("/sessions", async (req) => {
    await svc.removeSessions(await auth(req), req.query.createdBy);
    return { ok: true };
  });

  // ---------- Apps ----------
  app.get("/apps", async (req) => ({ apps: await svc.listApps(await auth(req)) }));

  app.post("/apps", async (req) => {
    const body = z
      .object({
        name: resourceName,
        os: z.enum(OSES),
        platform: z.enum(PLATFORMS),
        manuallyProvisionDeployments: z.boolean().optional(),
      })
      .parse(req.body);
    return { app: await svc.createApp(await auth(req), body) };
  });

  app.get<{ Params: P }>("/apps/:app", async (req) => ({
    app: await svc.serializeApp(await svc.getApp(await auth(req), req.params.app!)),
  }));

  app.patch<{ Params: P }>("/apps/:app", async (req) => {
    const body = z.object({ name: resourceName }).parse(req.body);
    await svc.renameApp(await auth(req), req.params.app!, body.name);
    return { ok: true };
  });

  app.delete<{ Params: P }>("/apps/:app", async (req) => {
    await svc.removeApp(await auth(req), req.params.app!);
    return { ok: true };
  });

  app.post<{ Params: P }>("/apps/:app/transfer/:email", async (req) => {
    await svc.transferApp(await auth(req), req.params.app!, req.params.email!);
    return { ok: true };
  });

  // ---------- Collaborators ----------
  app.get<{ Params: P }>("/apps/:app/collaborators", async (req) => ({
    collaborators: (await svc.serializeApp(await svc.getApp(await auth(req), req.params.app!))).collaborators,
  }));

  app.post<{ Params: P }>("/apps/:app/collaborators/:email", async (req) => {
    await svc.addCollaborator(await auth(req), req.params.app!, req.params.email!);
    return { ok: true };
  });

  app.delete<{ Params: P }>("/apps/:app/collaborators/:email", async (req) => {
    await svc.removeCollaborator(await auth(req), req.params.app!, req.params.email!);
    return { ok: true };
  });

  // ---------- Deployments ----------
  app.get<{ Params: P }>("/apps/:app/deployments", async (req) => ({
    deployments: await svc.listDeployments(await auth(req), req.params.app!),
  }));

  app.post<{ Params: P }>("/apps/:app/deployments", async (req) => {
    const body = z
      .object({
        name: resourceName,
        // Custom keys must be long enough not to be easily guessed.
        key: z.string().min(16).max(128).regex(/^[\w-]+$/, "Key may only contain letters, digits, '_' and '-'").optional(),
      })
      .parse(req.body);
    return { deployment: await svc.createDeployment(await auth(req), req.params.app!, body.name, body.key) };
  });

  app.get<{ Params: P }>("/apps/:app/deployments/:dep", async (req) => {
    const { dep } = await svc.getDeployment(await auth(req), req.params.app!, req.params.dep!);
    return { deployment: await svc.serializeDeployment(dep) };
  });

  app.patch<{ Params: P }>("/apps/:app/deployments/:dep", async (req) => {
    const body = z.object({ name: resourceName }).parse(req.body);
    await svc.renameDeployment(await auth(req), req.params.app!, req.params.dep!, body.name);
    return { ok: true };
  });

  app.delete<{ Params: P }>("/apps/:app/deployments/:dep", async (req) => {
    await svc.removeDeployment(await auth(req), req.params.app!, req.params.dep!);
    return { ok: true };
  });

  app.get<{ Params: P }>("/apps/:app/deployments/:dep/history", async (req) => {
    const { dep } = await svc.getDeployment(await auth(req), req.params.app!, req.params.dep!);
    const history = await svc.history(dep.id);
    return { history: await Promise.all(history.map((p) => svc.toPackage(p))) };
  });

  app.delete<{ Params: P }>("/apps/:app/deployments/:dep/history", async (req) => {
    await svc.clearHistory(await auth(req), req.params.app!, req.params.dep!);
    return { ok: true };
  });

  app.get<{ Params: P }>("/apps/:app/deployments/:dep/metrics", async (req) => ({
    metrics: await svc.getMetrics(await auth(req), req.params.app!, req.params.dep!),
  }));

  app.get<{ Params: P; Querystring: P }>("/apps/:app/deployments/:dep/metrics/daily", async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), label: z.string().max(32).optional() }).parse(req.query);
    return { daily: await svc.getDailyMetrics(await auth(req), req.params.app!, req.params.dep!, q.days, q.label) };
  });

  // ---------- Release ----------
  app.post<{ Params: P }>("/apps/:app/deployments/:dep/release", async (req) => {
    const user = await auth(req);
    return withTempDir(async (dir) => {
      // The zip is written to disk as it is received, never held whole in memory.
      let upload: string | undefined;
      let info: unknown;
      for await (const part of req.parts()) {
        if (part.type === "file" && part.fieldname === "package") {
          upload = path.join(dir, "upload.zip");
          await pipeline(part.file, createWriteStream(upload));
          if (part.file.truncated) throw new HttpError(413, `Package exceeds the ${svc.env.MAX_PACKAGE_SIZE_MB} MB limit`);
        } else if (part.type === "field" && part.fieldname === "packageInfo") {
          try {
            info = JSON.parse(String(part.value));
          } catch {
            throw badRequest("Field `packageInfo` is not valid JSON");
          }
        }
      }
      if (!upload) throw badRequest("Field `package` (zip file) is required");
      const meta = releaseMetadataSchema.parse(info ?? {});
      return { package: await svc.release(user, req.params.app!, req.params.dep!, upload, meta) };
    });
  });

  // ---------- Binary bundles ----------
  app.get<{ Params: P }>("/apps/:app/binaries", async (req) => ({ binaries: await svc.listBinaries(await auth(req), req.params.app!) }));

  app.post<{ Params: P }>("/apps/:app/binaries", async (req) => {
    const user = await auth(req);
    return withTempDir(async (dir) => {
      let file: string | undefined;
      let info: unknown;
      for await (const part of req.parts()) {
        if (part.type === "file" && part.fieldname === "bundle") {
          file = path.join(dir, "bundle");
          await pipeline(part.file, createWriteStream(file));
          if (part.file.truncated) throw new HttpError(413, `Bundle exceeds the ${svc.env.MAX_PACKAGE_SIZE_MB} MB limit`);
        } else if (part.type === "field" && part.fieldname === "info") {
          try {
            info = JSON.parse(String(part.value));
          } catch {
            throw badRequest("Field `info` is not valid JSON");
          }
        }
      }
      if (!file) throw badRequest("Field `bundle` is required");
      const meta = z
        .object({ fileName: z.string().min(1).max(128).regex(/^[\w.-]+$/), appVersion: z.string().max(128).optional() })
        .parse(info ?? {});
      return svc.addBinary(user, req.params.app!, file, meta);
    });
  });

  app.delete<{ Params: P }>("/apps/:app/binaries/:hash", async (req) => {
    await svc.removeBinary(await auth(req), req.params.app!, req.params.hash!);
    return { ok: true };
  });

  app.patch<{ Params: P }>("/apps/:app/deployments/:dep/release", async (req) => {
    const body = z.object({ packageInfo: patchMetadataSchema }).parse(req.body);
    return { package: await svc.patchRelease(await auth(req), req.params.app!, req.params.dep!, body.packageInfo) };
  });

  app.post<{ Params: P }>("/apps/:app/deployments/:dep/promote/:dest", async (req) => {
    const body = z.object({ packageInfo: patchMetadataSchema.optional() }).parse(req.body ?? {});
    return {
      package: await svc.promote(await auth(req), req.params.app!, req.params.dep!, req.params.dest!, body.packageInfo),
    };
  });

  app.post<{ Params: P }>("/apps/:app/deployments/:dep/rollback", async (req) => ({
    package: await svc.rollback(await auth(req), req.params.app!, req.params.dep!),
  }));

  app.post<{ Params: P }>("/apps/:app/deployments/:dep/rollback/:label", async (req) => ({
    package: await svc.rollback(await auth(req), req.params.app!, req.params.dep!, req.params.label),
  }));
}

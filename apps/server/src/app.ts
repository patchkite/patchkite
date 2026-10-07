import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { Db } from "./db/index.js";
import type { Env } from "./env.js";
import { HttpError } from "./errors.js";
import { acquisitionRoutes } from "./routes/acquisition.js";
import { adminRoutes } from "./routes/admin.js";
import { managementRoutes } from "./routes/management.js";
import { ManagementService } from "./services/management.js";
import { PatchBuilder } from "./services/patches.js";
import { UserService } from "./services/users.js";
import type { Storage } from "./storage.js";

export async function buildApp(opts: { db: Db; storage: Storage; env: Env; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, trustProxy: opts.env.TRUST_PROXY });
  await app.register(cors, { origin: true });
  // Per-IP limit. Registered per route group (not globally) so the dashboard and CLI aren't limited.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      Object.assign(new Error(`Too many requests, try again in ${ctx.after}`), { statusCode: ctx.statusCode }),
  });
  await app.register(multipart, {
    limits: { fileSize: opts.env.MAX_PACKAGE_SIZE_MB * 1024 * 1024, files: 1, fields: 5, fieldSize: 64 * 1024, parts: 6 },
  });

  // Basic security headers. CSP restricts the dashboard (which stores the access key in localStorage)
  // to loading scripts from this server only, as a defense-in-depth layer against XSS.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (req.url.startsWith("/web")) {
      reply.header("x-frame-options", "DENY");
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: "Internal server error" });
  });

  const svc = new ManagementService(opts.db, opts.storage, opts.env);
  svc.patches = new PatchBuilder(opts.db, opts.storage, opts.env, app.log);
  app.addHook("onClose", () => svc.patches!.close());
  app.get("/health", async () => ({ status: "ok" }));
  await app.register(async (scope) => {
    if (opts.env.RATE_LIMIT_PUBLIC_PER_MINUTE > 0) {
      scope.addHook("onRequest", scope.rateLimit({ max: opts.env.RATE_LIMIT_PUBLIC_PER_MINUTE, timeWindow: "1 minute" }));
    }
    await acquisitionRoutes(scope, svc);
  });
  const users = new UserService(opts.db);
  await managementRoutes(app, svc, users);
  await adminRoutes(app, svc, users);

  const dashboardDir = opts.env.DASHBOARD_DIR ? path.resolve(opts.env.DASHBOARD_DIR) : undefined;
  if (dashboardDir && existsSync(dashboardDir)) {
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, { root: dashboardDir, prefix: "/web/" });
    app.get("/", (_req, reply) => reply.redirect("/web/"));
    // SPA fallback
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && req.url.startsWith("/web/")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "Not found" });
    });
  }
  return app;
}

import { buildApp } from "./app.js";
import { createPostgresDb } from "./db/index.js";
import { loadEnv } from "./env.js";
import { scheduleGarbageCollection } from "./services/gc.js";
import { createStorage } from "./storage.js";

const env = loadEnv();
const db = await createPostgresDb(env.DATABASE_URL);
const storage = createStorage(env);
await storage.init?.();
const app = await buildApp({ db, storage, env, logger: true });
await app.listen({ port: env.PORT, host: env.HOST });
scheduleGarbageCollection(db, storage, {
  intervalMs: env.GC_INTERVAL_MINUTES * 60_000,
  graceMs: env.GC_GRACE_MINUTES * 60_000,
  log: app.log,
});

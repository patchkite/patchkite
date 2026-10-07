import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Production PostgreSQL connection + run migrations. */
export async function createPostgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db as unknown as Db;
}

/** In-memory database (PGlite) for tests. */
export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db as unknown as Db;
}

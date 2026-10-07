import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createMemoryDb } from "../src/db/index.js";
import { loadEnv, type Env } from "../src/env.js";
import { FsStorage } from "../src/storage.js";
import { createZip } from "../src/zip.js";

function multipart(token: string, zip: Buffer, info: object) {
  const boundary = "----patchkite" + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packageInfo"\r\n\r\n${JSON.stringify(info)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="p.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const bundle = (files: Record<string, string>) => createZip(new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));

async function setup(overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "patchkite-"));
  const env: Env = loadEnv({ STORAGE_DRIVER: "fs", FS_STORAGE_DIR: dir, PUBLIC_URL: "http://test", ...overrides });
  const app = await buildApp({ db: await createMemoryDb(), storage: new FsStorage(dir), env });
  return { app, dir };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("user management", () => {
  let app: FastifyInstance;
  let admin: string;
  beforeAll(async () => {
    ({ app } = await setup({ ALLOW_REGISTRATION: "false", RATE_LIMIT_AUTH_PER_MINUTE: "0" }));
  });
  afterAll(() => app.close());

  const login = async (email: string, password: string) =>
    (await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } })).json().accessKey as string;

  it("makes the first user admin and closes registration afterwards", async () => {
    const first = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "admin@x.io", password: "secret123" } });
    expect(first.statusCode).toBe(200);
    admin = first.json().accessKey;
    expect((await app.inject({ url: "/account", headers: auth(admin) })).json().account.isAdmin).toBe(true);
    const second = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "b@x.io", password: "secret123" } });
    expect(second.statusCode).toBe(403);
  });

  it("lets admin create users with a temporary password", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/users", headers: auth(admin), payload: { email: "Dev@x.io" } });
    const { password } = res.json();
    expect(password).toHaveLength(16);
    const dev = await login("dev@x.io", password);
    expect((await app.inject({ url: "/account", headers: auth(dev) })).json().account).toMatchObject({ email: "dev@x.io", isAdmin: false });
    // Non-admins can't use admin endpoints.
    expect((await app.inject({ url: "/admin/users", headers: auth(dev) })).statusCode).toBe(403);
  });

  it("changes own password and revokes other sessions", async () => {
    const reset = await app.inject({ method: "POST", url: "/admin/users/dev@x.io/reset-password", headers: auth(admin) });
    const temp = reset.json().password;
    const a = await login("dev@x.io", temp);
    const b = await login("dev@x.io", temp);
    const wrong = await app.inject({ method: "PATCH", url: "/account", headers: auth(a), payload: { currentPassword: "nope", newPassword: "newpass123" } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({ method: "PATCH", url: "/account", headers: auth(a), payload: { currentPassword: temp, newPassword: "newpass123" } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: "/account", headers: auth(a) })).statusCode).toBe(200);
    expect((await app.inject({ url: "/account", headers: auth(b) })).statusCode).toBe(401);
    expect(await login("dev@x.io", "newpass123")).toBeTruthy();
  });

  it("revokes all keys on admin password reset", async () => {
    const dev = await login("dev@x.io", "newpass123");
    await app.inject({ method: "POST", url: "/admin/users/dev@x.io/reset-password", headers: auth(admin) });
    expect((await app.inject({ url: "/account", headers: auth(dev) })).statusCode).toBe(401);
  });

  it("requires transferTo when deleting a user who owns apps", async () => {
    const { password } = (await app.inject({ method: "POST", url: "/admin/users", headers: auth(admin), payload: { email: "owner@x.io" } })).json();
    const owner = await login("owner@x.io", password);
    await app.inject({ method: "POST", url: "/apps", headers: auth(owner), payload: { name: "Owned", os: "android", platform: "flutter" } });

    const blocked = await app.inject({ method: "DELETE", url: "/admin/users/owner@x.io", headers: auth(admin) });
    expect(blocked.statusCode).toBe(409);
    const done = await app.inject({ method: "DELETE", url: "/admin/users/owner@x.io?transferTo=admin@x.io", headers: auth(admin) });
    expect(done.json().transferred).toEqual(["Owned"]);
    const apps = (await app.inject({ url: "/apps", headers: auth(admin) })).json().apps;
    expect(apps.map((a: { name: string }) => a.name)).toContain("Owned");
    const list = (await app.inject({ url: "/admin/users", headers: auth(admin) })).json().users;
    expect(list.map((u: { email: string }) => u.email)).toEqual(["admin@x.io", "dev@x.io"]);
  });

  it("keeps at least one admin", async () => {
    const demote = await app.inject({ method: "PATCH", url: "/admin/users/admin@x.io", headers: auth(admin), payload: { isAdmin: false } });
    expect(demote.statusCode).toBe(400);
    await app.inject({ method: "PATCH", url: "/admin/users/dev@x.io", headers: auth(admin), payload: { isAdmin: true } });
    const ok = await app.inject({ method: "PATCH", url: "/admin/users/admin@x.io", headers: auth(admin), payload: { isAdmin: false } });
    expect(ok.statusCode).toBe(200);
  });
});

describe("storage garbage collection", () => {
  it("deletes only blobs no longer referenced", async () => {
    const { app, dir } = await setup({ GC_GRACE_MINUTES: "0" });
    const token = (await app.inject({ method: "POST", url: "/auth/register", payload: { email: "a@x.io", password: "secret123" } })).json().accessKey;
    await app.inject({ method: "POST", url: "/apps", headers: auth(token), payload: { name: "A", os: "ios", platform: "react-native" } });
    const big = Buffer.from(Array.from({ length: 5000 }, () => Math.floor(Math.random() * 256))).toString("base64");
    for (const v of ["1", "2"]) {
      const res = await app.inject({
        method: "POST",
        url: "/apps/A/deployments/Staging/release",
        ...multipart(token, await bundle({ "main.jsbundle": v, "assets/big.txt": big }), { appVersion: "1.0.0" }),
      });
      expect(res.statusCode).toBe(200);
    }
    await app.inject({ method: "POST", url: "/apps/A/deployments/Staging/promote/Production", headers: auth(token), payload: {} });
    const blobs = async () => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
    const before = await blobs();
    expect(before).toBe(5); // 2 package + 2 manifest + 1 diff

    const nothing = (await app.inject({ method: "POST", url: "/admin/gc", headers: auth(token) })).json();
    expect(nothing.orphans).toEqual([]);

    // Staging cleared: package v1 is orphaned, v2 is still used by Production (via promote).
    await app.inject({ method: "DELETE", url: "/apps/A/deployments/Staging/history", headers: auth(token) });
    const dry = (await app.inject({ method: "POST", url: "/admin/gc?dryRun=true", headers: auth(token) })).json();
    expect(dry.orphans.sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^packages\//), expect.stringMatching(/^diffs\//)]));
    expect(dry.orphans).toHaveLength(3);
    expect(await blobs()).toBe(before);

    await app.inject({ method: "POST", url: "/admin/gc", headers: auth(token) });
    expect(await blobs()).toBe(2);
    // The Production release can still be downloaded.
    const [prod] = (await app.inject({ url: "/apps/A/deployments/Production/history", headers: auth(token) })).json().history;
    expect((await app.inject({ url: new URL(prod.blobUrl).pathname })).statusCode).toBe(200);
    await app.close();
  });
});

describe("upload limits and rate limiting", () => {
  it("rejects packages over the size limits", async () => {
    const { app } = await setup({ MAX_PACKAGE_SIZE_MB: "0.001", MAX_UNCOMPRESSED_SIZE_MB: "0.01" });
    const token = (await app.inject({ method: "POST", url: "/auth/register", payload: { email: "a@x.io", password: "secret123" } })).json().accessKey;
    await app.inject({ method: "POST", url: "/apps", headers: auth(token), payload: { name: "A", os: "ios", platform: "react-native" } });
    const random = Buffer.from(Array.from({ length: 4000 }, () => Math.floor(Math.random() * 256))).toString("base64");
    const tooBig = await app.inject({
      method: "POST",
      url: "/apps/A/deployments/Staging/release",
      ...multipart(token, await bundle({ "main.jsbundle": random }), { appVersion: "1.0.0" }),
    });
    expect(tooBig.statusCode).toBe(413);
    // Small zip that expands hugely when extracted (zip bomb).
    const bomb = await app.inject({
      method: "POST",
      url: "/apps/A/deployments/Staging/release",
      ...multipart(token, await bundle({ "main.jsbundle": "0".repeat(50_000) }), { appVersion: "1.0.0" }),
    });
    expect(bomb.statusCode).toBe(413);
    await app.close();
  });

  it("limits login attempts and SDK requests per IP", async () => {
    const { app } = await setup({ RATE_LIMIT_AUTH_PER_MINUTE: "3", RATE_LIMIT_PUBLIC_PER_MINUTE: "2" });
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@x.io", password: "wrongpass" } })).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 429]);
    const sdk = [];
    for (let i = 0; i < 3; i++) sdk.push((await app.inject({ url: "/v1/public/update_check?deployment_key=k&app_version=1.0.0" })).statusCode);
    expect(sdk).toEqual([404, 404, 429]);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    await app.close();
  });
});

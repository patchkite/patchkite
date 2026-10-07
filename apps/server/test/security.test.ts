import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createMemoryDb } from "../src/db/index.js";
import { loadEnv } from "../src/env.js";
import { FsStorage } from "../src/storage.js";
import { createZip } from "../src/zip.js";

let app: FastifyInstance;
let token: string;
let key: string;
const H = () => ({ authorization: `Bearer ${token}` });

function multipart(parts: { name: string; value: string | Buffer; file?: boolean }[]) {
  const boundary = "----patchkite" + Math.random().toString(16).slice(2);
  const chunks = parts.flatMap((p) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.file ? `; filename="p.zip"\r\nContent-Type: application/zip` : ""}\r\n\r\n`,
    ),
    Buffer.from(p.value),
    Buffer.from("\r\n"),
  ]);
  return {
    payload: Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]),
    headers: { ...H(), "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patchkite-"));
  const env = loadEnv({ STORAGE_DRIVER: "fs", FS_STORAGE_DIR: dir, PUBLIC_URL: "http://test", RATE_LIMIT_AUTH_PER_MINUTE: "0" });
  app = await buildApp({ db: await createMemoryDb(), storage: new FsStorage(dir), env });
  token = (await app.inject({ method: "POST", url: "/auth/register", payload: { email: "a@x.io", password: "secret123" } })).json().accessKey;
  await app.inject({ method: "POST", url: "/apps", headers: H(), payload: { name: "S", os: "android", platform: "react-native" } });
  key = (await app.inject({ url: "/apps/S/deployments", headers: H() })).json().deployments[0].key;
  const zip = await createZip(new Map([["index.android.bundle", Buffer.from("v1")]]));
  await app.inject({
    method: "POST",
    url: "/apps/S/deployments/Staging/release",
    ...multipart([
      { name: "packageInfo", value: JSON.stringify({ appVersion: "1.0.0" }) },
      { name: "package", value: zip, file: true },
    ]),
  });
});
afterAll(() => app.close());

describe("security hardening", () => {
  it("gives the same answer for unknown email and wrong password", async () => {
    const unknown = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "nobody@x.io", password: "secret123" } });
    const wrong = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@x.io", password: "wrongpass" } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("rejects oversized passwords before hashing", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@x.io", password: "x".repeat(10_000) } });
    expect(res.statusCode).toBe(400);
  });

  it("only records metrics for releases that exist", async () => {
    const report = (label: string) =>
      app.inject({ method: "POST", url: "/v1/public/report_status/download", payload: { deployment_key: key, label } });
    expect((await report("v1")).statusCode).toBe(200);
    expect((await report("v999")).statusCode).toBe(200);
    expect((await report("../../etc")).statusCode).toBe(400);
    const metrics = (await app.inject({ url: "/apps/S/deployments/Staging/metrics", headers: H() })).json().metrics;
    expect(Object.keys(metrics)).toEqual(["v1"]);
  });

  it("returns 400 for malformed release metadata", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/apps/S/deployments/Staging/release",
      ...multipart([{ name: "packageInfo", value: "{not json" }]),
    });
    expect(res.statusCode).toBe(400);
    const notZip = await app.inject({
      method: "POST",
      url: "/apps/S/deployments/Staging/release",
      ...multipart([
        { name: "packageInfo", value: JSON.stringify({ appVersion: "1.0.0" }) },
        { name: "package", value: "hello", file: true },
      ]),
    });
    expect(notZip.statusCode).toBe(400);
  });

  it("validates custom deployment keys", async () => {
    const short = await app.inject({ method: "POST", url: "/apps/S/deployments", headers: H(), payload: { name: "QA", key: "abc12345" } });
    expect(short.statusCode).toBe(400);
    const taken = await app.inject({ method: "POST", url: "/apps/S/deployments", headers: H(), payload: { name: "QA", key } });
    expect(taken.statusCode).toBe(409);
  });

  it("does not serve blobs outside packages and diffs", async () => {
    for (const url of ["/v1/public/download/manifests/x.json", "/v1/public/download/packages/..%2F..%2Fetc.zip"]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });

  it("sets security headers", async () => {
    const res = await app.inject({ url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

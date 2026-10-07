import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createMemoryDb } from "../src/db/index.js";
import { loadEnv } from "../src/env.js";
import { FsStorage } from "../src/storage.js";
import { createZip, readZip } from "../src/zip.js";

let app: FastifyInstance;
let token: string;
const H = () => ({ authorization: `Bearer ${token}` });

function multipart(zip: Buffer, info: object) {
  const boundary = "----patchkite" + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packageInfo"\r\n\r\n${JSON.stringify(info)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="p.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { ...H(), "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const bundle = (files: Record<string, string>) =>
  createZip(new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));

async function release(dep: string, files: Record<string, string>, info: object = { appVersion: "1.0.0" }) {
  const res = await app.inject({ method: "POST", url: `/apps/MyApp/deployments/${dep}/release`, ...multipart(await bundle(files), info) });
  return res;
}

let stagingKey: string;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patchkite-"));
  const env = loadEnv({ STORAGE_DRIVER: "fs", FS_STORAGE_DIR: dir, PUBLIC_URL: "http://test" });
  app = await buildApp({ db: await createMemoryDb(), storage: new FsStorage(dir), env });
});
afterAll(() => app.close());

describe("management + acquisition flow", () => {
  it("registers and logs in", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "Dev@Example.com", password: "secret123" } });
    expect(reg.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "dev@example.com", password: "secret123" } });
    token = login.json().accessKey;
    const me = await app.inject({ url: "/account", headers: H() });
    expect(me.json().account.email).toBe("dev@example.com");
    const bad = await app.inject({ url: "/account", headers: { authorization: "Bearer nope" } });
    expect(bad.statusCode).toBe(401);
  });

  it("creates app with default deployments", async () => {
    const res = await app.inject({ method: "POST", url: "/apps", headers: H(), payload: { name: "MyApp", os: "android", platform: "react-native" } });
    expect(res.json().app.deployments).toEqual(["Staging", "Production"]);
    const deps = await app.inject({ url: "/apps/MyApp/deployments", headers: H() });
    stagingKey = deps.json().deployments[0].key;
    expect(stagingKey).toBeTruthy();
  });

  it("releases, detects duplicates, and serves update_check", async () => {
    const r1 = await release("Staging", { "index.android.bundle": "console.log(1)", "assets/a.png": "A" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().package.label).toBe("v1");

    const dup = await release("Staging", { "index.android.bundle": "console.log(1)", "assets/a.png": "A" });
    expect(dup.statusCode).toBe(409);

    const check = await app.inject({ url: `/v1/public/update_check?deployment_key=${stagingKey}&app_version=1.0.0` });
    const info = check.json().update_info;
    expect(info).toMatchObject({ is_available: true, label: "v1", is_diff: false });

    const dl = await app.inject({ url: info.download_url.replace("http://test", "") });
    expect(dl.statusCode).toBe(200);
    expect((await readZip(dl.rawPayload)).size).toBe(2);
  });

  it("generates diff for clients on previous release", async () => {
    const v1Hash = (await app.inject({ url: "/apps/MyApp/deployments/Staging", headers: H() })).json().deployment.package.packageHash;
    const big = (await import("node:crypto")).randomBytes(10000).toString("hex");
    const r2 = await release("Staging", { "index.android.bundle": "console.log(2)", "assets/a.png": "A", "assets/big.bin": big });
    expect(r2.json().package.label).toBe("v2");
    const r3 = await release("Staging", { "index.android.bundle": "console.log(3)", "assets/big.bin": big }, { appVersion: "1.0.0", isMandatory: false });
    const v2Hash = r2.json().package.packageHash;
    expect(Object.keys(r3.json().package.diffPackageMap)).toContain(v2Hash);

    const check = await app.inject({
      url: `/v1/public/update_check?deployment_key=${stagingKey}&app_version=1.0.0&package_hash=${v2Hash}&label=v2`,
    });
    const info = check.json().update_info;
    expect(info).toMatchObject({ is_available: true, label: "v3", is_diff: true });
    const diff = await readZip((await app.inject({ url: info.download_url.replace("http://test", "") })).rawPayload);
    expect([...diff.keys()].sort()).toEqual(["index.android.bundle", "patchkite-diff.json"]);
    expect(JSON.parse(diff.get("patchkite-diff.json")!.toString())).toEqual({ deletedFiles: ["assets/a.png"] });
    expect(v1Hash).not.toBe(v2Hash);
  });

  it("patches, promotes, rolls back", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/apps/MyApp/deployments/Staging/release",
      headers: H(),
      payload: { packageInfo: { isMandatory: true, description: "fix" } },
    });
    expect(patch.json().package).toMatchObject({ label: "v3", isMandatory: true, description: "fix" });

    const promote = await app.inject({ method: "POST", url: "/apps/MyApp/deployments/Staging/promote/Production", headers: H(), payload: {} });
    expect(promote.json().package).toMatchObject({ label: "v1", releaseMethod: "Promote", originalLabel: "v3", originalDeployment: "Staging" });

    const rb = await app.inject({ method: "POST", url: "/apps/MyApp/deployments/Staging/rollback", headers: H() });
    expect(rb.json().package).toMatchObject({ label: "v4", releaseMethod: "Rollback", originalLabel: "v2" });

    const hist = await app.inject({ url: "/apps/MyApp/deployments/Staging/history", headers: H() });
    expect(hist.json().history.map((p: { label: string }) => p.label)).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("enforces unfinished rollout rule", async () => {
    const r = await release("Staging", { "index.android.bundle": "rollout" }, { appVersion: "1.0.0", rollout: 20 });
    expect(r.json().package.rollout).toBe(20);
    const blocked = await release("Staging", { "index.android.bundle": "next" });
    expect(blocked.statusCode).toBe(409);
    const lower = await app.inject({ method: "PATCH", url: "/apps/MyApp/deployments/Staging/release", headers: H(), payload: { packageInfo: { rollout: 10 } } });
    expect(lower.statusCode).toBe(400);
    const full = await app.inject({ method: "PATCH", url: "/apps/MyApp/deployments/Staging/release", headers: H(), payload: { packageInfo: { rollout: 100 } } });
    expect(full.json().package.rollout).toBeNull();
  });

  it("records metrics", async () => {
    await app.inject({ method: "POST", url: "/v1/public/report_status/download", payload: { deployment_key: stagingKey, label: "v5" } });
    await app.inject({
      method: "POST",
      url: "/v1/public/report_status/deploy",
      payload: { deployment_key: stagingKey, app_version: "1.0.0", label: "v5", status: "DeploymentSucceeded", previous_label_or_app_version: "1.0.0" },
    });
    const m = await app.inject({ url: "/apps/MyApp/deployments/Staging/metrics", headers: H() });
    expect(m.json().metrics.v5).toMatchObject({ downloaded: 1, installed: 1, active: 1 });
  });

  it("records daily metrics for charts", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/public/report_status/deploy",
      payload: { deployment_key: stagingKey, app_version: "1.0.0", label: "v5", status: "DeploymentFailed" },
    });
    const res = await app.inject({ url: "/apps/MyApp/deployments/Staging/metrics/daily?days=7", headers: H() });
    const daily = res.json().daily as { day: string; downloaded: number; installed: number; failed: number }[];
    expect(daily).toHaveLength(7);
    expect(daily.at(-1)).toEqual({ day: new Date().toISOString().slice(0, 10), downloaded: 1, installed: 1, failed: 1 });
    expect(daily.slice(0, -1).every((d) => d.installed === 0)).toBe(true);
    const other = await app.inject({ url: "/apps/MyApp/deployments/Staging/metrics/daily?days=1&label=v1", headers: H() });
    expect(other.json().daily[0].installed).toBe(0);
  });

  it("manages access keys", async () => {
    const created = await app.inject({ method: "POST", url: "/accessKeys", headers: H(), payload: { friendlyName: "CI" } });
    expect(created.json().accessKey.key).toBeTruthy();
    const list = await app.inject({ url: "/accessKeys", headers: H() });
    expect(list.json().accessKeys.some((k: { friendlyName: string }) => k.friendlyName === "CI")).toBe(true);
    const rm = await app.inject({ method: "DELETE", url: "/accessKeys/CI", headers: H() });
    expect(rm.statusCode).toBe(200);
  });
});

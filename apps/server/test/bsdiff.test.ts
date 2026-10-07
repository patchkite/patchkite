import { bspatch, sha256 } from "@patchkite/shared";
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
let key: string;
const H = () => ({ authorization: `Bearer ${token}` });

function bundle(lines: number, edit = false) {
  const out = Array.from({ length: lines }, (_, i) => `__d(function(g,r){var x${i}=${(i * 7919) % 1000};e.r${i}=function(){return x${i}*${i}}},${i});`);
  if (edit) out.splice(1500, 2, "__d(function(){console.log('new feature')},99999);");
  return Buffer.from(out.join("\n"));
}

async function release(files: Record<string, Buffer>) {
  const zip = await createZip(new Map(Object.entries(files)));
  const boundary = "----patchkite" + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packageInfo"\r\n\r\n{"appVersion":"1.0.0"}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="p.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/apps/B/deployments/Staging/release",
    payload,
    headers: { ...H(), "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().package as { packageHash: string };
}

const check = (hash: string, features?: string) =>
  app
    .inject({
      url: `/v1/public/update_check?deployment_key=${key}&app_version=1.0.0&package_hash=${hash}${features ? `&client_features=${features}` : ""}`,
    })
    .then((r) => r.json().update_info as { download_url: string; package_size: number; is_diff: boolean });

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "patchkite-"));
  const env = loadEnv({ STORAGE_DRIVER: "fs", FS_STORAGE_DIR: dir, PUBLIC_URL: "http://test", BSDIFF_MIN_FILE_KB: "16" });
  app = await buildApp({ db: await createMemoryDb(), storage: new FsStorage(dir), env });
  token = (await app.inject({ method: "POST", url: "/auth/register", payload: { email: "a@x.io", password: "secret123" } })).json().accessKey;
  await app.inject({ method: "POST", url: "/apps", headers: H(), payload: { name: "B", os: "android", platform: "react-native" } });
  key = (await app.inject({ url: "/apps/B/deployments", headers: H() })).json().deployments[0].key;
});
afterAll(() => app.close());

describe("bsdiff diffs", () => {
  it("serves a binary patch to SDKs that support it and a file diff to the rest", async () => {
    const icon = Buffer.from("icon");
    const v1 = await release({ "index.android.bundle": bundle(5000), "drawable/icon.png": icon });
    const newBundle = bundle(5000, true);
    await release({ "index.android.bundle": newBundle, "drawable/icon.png": icon });

    // Patches are built in the background; wait until available.
    let info = await check(v1.packageHash, "bsdiff");
    for (let i = 0; i < 100 && !info.download_url.endsWith(".bsdiff.zip"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      info = await check(v1.packageHash, "bsdiff");
    }
    expect(info.download_url).toMatch(/\.bsdiff\.zip$/);
    expect(info.is_diff).toBe(true);

    const legacy = await check(v1.packageHash);
    expect(legacy.download_url).not.toMatch(/bsdiff/);
    expect(info.package_size).toBeLessThan(legacy.package_size / 5);

    // Diff contents: applying the patch to the old bundle yields exactly the new bundle.
    const res = await app.inject({ url: new URL(info.download_url).pathname });
    const files = await readZip(res.rawPayload);
    const manifest = JSON.parse(files.get("patchkite-diff.json")!.toString());
    expect(manifest).toEqual({ deletedFiles: [], patchedFiles: ["index.android.bundle"] });
    expect(files.has("index.android.bundle")).toBe(false);
    expect(bspatch(bundle(5000), files.get(".patchkite-patches/index.android.bundle")!).equals(newBundle)).toBe(true);
  });

  it("patches from the bundle shipped in the store binary for first updates", async () => {
    const shipped = bundle(5000);
    const boundary = "----patchkite" + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="info"\r\n\r\n{"fileName":"index.android.bundle","appVersion":"1.0.0"}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="b"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      shipped,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const add = await app.inject({
      method: "POST",
      url: "/apps/B/binaries",
      payload,
      headers: { ...H(), "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().binary.fileHash).toBe(sha256(shipped));
    const list = await app.inject({ url: "/apps/B/binaries", headers: H() });
    expect(list.json().binaries).toHaveLength(1);

    const third = bundle(5000, true).toString().replace("x10=", "x10=1+");
    await release({ "index.android.bundle": Buffer.from(third), "drawable/icon.png": Buffer.from("icon-new") });

    const q = `/v1/public/update_check?deployment_key=${key}&app_version=1.0.0&binary_hash=${sha256(shipped)}`;
    let info = (await app.inject({ url: `${q}&client_features=bsdiff` })).json().update_info;
    for (let i = 0; i < 100 && !info.is_diff; i++) {
      await new Promise((r) => setTimeout(r, 100));
      info = (await app.inject({ url: `${q}&client_features=bsdiff` })).json().update_info;
    }
    expect(info.is_diff).toBe(true);
    expect(info.download_url).toMatch(/binary-[0-9a-f]+\.bsdiff\.zip$/);
    // Without bsdiff support, devices on the binary still download the full package.
    expect((await app.inject({ url: q })).json().update_info.is_diff).toBe(false);

    const files = await readZip((await app.inject({ url: new URL(info.download_url).pathname })).rawPayload);
    expect(JSON.parse(files.get("patchkite-diff.json")!.toString())).toEqual({
      deletedFiles: [],
      patchedFiles: ["index.android.bundle"],
      binaryBase: "index.android.bundle",
    });
    expect(files.get("drawable/icon.png")!.toString()).toBe("icon-new");
    expect(bspatch(shipped, files.get(".patchkite-patches/index.android.bundle")!).toString()).toBe(third);

    const removed = await app.inject({ method: "DELETE", url: `/apps/B/binaries/${sha256(shipped).slice(0, 10)}`, headers: H() });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ url: `${q}&client_features=bsdiff` })).json().update_info.is_diff).toBe(false);
  });
});

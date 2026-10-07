// Fixture generator for native SDK unit tests (Kotlin, Swift).
// Expected values are computed with the real implementation in @patchkite/shared,
// so the SDK tests ensure results are identical to the server and CLI.
// Regenerate: pnpm --filter @patchkite/shared build && node fixtures/generate.mjs && node scripts/sync-fixtures.mjs
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { bsdiff, packageHashFromManifest, sha256 } from "../packages/shared/dist/index.js";

const here = new URL("./", import.meta.url);

/** Package files; names with non-ASCII characters and subfolders are tested too. */
const files = {
  "index.android.bundle": "console.log('Patchkite v1');\n",
  "assets/logo.txt": "logo",
  "assets/image-\u00e9.txt": "unicode NFC",
  "assets/nfd-e\u0301.txt": "unicode NFD",
  "nested/deep/data.json": '{"a":1}',
};
/** Files that must not be included in the package hash. */
const ignoredFiles = {
  ".DS_Store": "junk",
  "__MACOSX/index.android.bundle": "console.log('evil');",
  "assets/.DS_Store": "junk",
};

const manifest = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha256(Buffer.from(c))]));
const packageHash = packageHashFromManifest(manifest);

const b64url = (b) => Buffer.from(b).toString("base64url");
const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey, publicKey } = pair();
const other = pair();
const pem = (k) => k.export({ type: "spki", format: "pem" }).toString();
function jwt(header, payload, key) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign("RSA-SHA256").update(input).sign(key);
  return `${input}.${b64url(sig)}`;
}
const claims = { claimVersion: "1.0.0", contentHash: packageHash, iat: 1790000000 };

/** Minimal zip (store method) so dangerous entry names like "../x" can be created. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

await mkdir(new URL("zips/", here), { recursive: true });
const normal = zip(Object.entries(files));
await writeFile(new URL("zips/normal.zip", here), normal);
await writeFile(new URL("zips/slip.zip", here), zip([["ok.txt", "ok"], ["../evil.txt", "evil"]]));
// Truncated zip: central directory points to an offset beyond the file.
const truncated = Buffer.from(normal);
truncated.writeUInt32LE(0x7fffffff, truncated.length - 6);
await writeFile(new URL("zips/bad-offset.zip", here), truncated);

// Binary patch: old bundle → new bundle (bsdiff output from @patchkite/shared).
await mkdir(new URL("bsdiff/", here), { recursive: true });
const lines = Array.from({ length: 1000 }, (_, i) => `__d(function(g,r){var x${i}=${(i * 7919) % 1000};e.r${i}=function(){return x${i}*${i}}},${i});`);
const oldBundle = Buffer.from(lines.join("\n"));
lines.splice(300, 3, "__d(function(){console.log('new feature')},99999);");
lines[800] = lines[800].replace("return", "return 1+");
const newBundle = Buffer.from(lines.join("\n") + "\n// end");
await writeFile(new URL("bsdiff/old.bin", here), oldBundle);
await writeFile(new URL("bsdiff/new.bin", here), newBundle);
await writeFile(new URL("bsdiff/patch.bin", here), bsdiff(oldBundle, newBundle));

const fixtures = {
  files,
  ignoredFiles,
  packageHash,
  publicKeyPem: pem(publicKey),
  otherPublicKeyPem: pem(other.publicKey),
  validJwt: jwt({ alg: "RS256", typ: "JWT" }, claims, privateKey),
  wrongKeyJwt: jwt({ alg: "RS256", typ: "JWT" }, claims, other.privateKey),
  noneAlgJwt: `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.`,
};
await writeFile(new URL("fixtures.json", here), JSON.stringify(fixtures, null, 2) + "\n");
console.log("fixtures written, packageHash", packageHash);

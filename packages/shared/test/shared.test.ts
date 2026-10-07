import { describe, expect, it } from "vitest";
import {
  diffManifests,
  isAppVersionInRange,
  isClientInRollout,
  normalizeAppVersion,
  packageHashFromManifest,
  sha256,
} from "../src/index.js";

describe("semver", () => {
  it("normalizes short versions", () => {
    expect(normalizeAppVersion("1.0")).toBe("1.0.0");
    expect(normalizeAppVersion("2")).toBe("2.0.0");
  });
  it("matches semver ranges", () => {
    expect(isAppVersionInRange("1.2.3", "1.2.x")).toBe(true);
    expect(isAppVersionInRange("1.3.0", "1.2.x")).toBe(false);
    expect(isAppVersionInRange("1.0", "1.0.0")).toBe(true);
    expect(isAppVersionInRange("5.0.0", "*")).toBe(true);
  });
});

describe("rollout", () => {
  it("is deterministic and roughly proportional", () => {
    expect(isClientInRollout("a", "v1", 50)).toBe(isClientInRollout("a", "v1", 50));
    let hits = 0;
    for (let i = 0; i < 10000; i++) if (isClientInRollout(`c${i}`, "v1", 25)) hits++;
    expect(hits).toBeGreaterThan(2200);
    expect(hits).toBeLessThan(2800);
    expect(isClientInRollout("x", "v1", null)).toBe(true);
  });
});

describe("hash", () => {
  it("is order independent and ignores signature file", () => {
    const a = packageHashFromManifest({ "b.js": "2", "a.js": "1" });
    const b = packageHashFromManifest({ "a.js": "1", "b.js": "2", ".patchkiterelease": "x" });
    expect(a).toBe(b);
  });
  it("treats NFC and NFD file names the same (iOS stores names as NFD)", () => {
    const nfc = packageHashFromManifest({ "assets/caf\u00e9.png": "1", "a.js": "2" });
    const nfd = packageHashFromManifest({ "assets/cafe\u0301.png": "1", "a.js": "2" });
    expect(nfd).toBe(nfc);
    // ASCII names are unaffected by normalization (compatible with older releases).
    expect(packageHashFromManifest({ "b.js": "2", "a.js": "1" })).toBe(sha256(JSON.stringify(["a.js:1", "b.js:2"])));
  });

  it("diffs manifests", () => {
    expect(diffManifests({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" })).toEqual({ changed: ["b", "c"], deleted: [] });
    expect(diffManifests({ a: "1", b: "2" }, { a: "1" })).toEqual({ changed: [], deleted: ["b"] });
  });
});

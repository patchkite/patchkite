import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bsdiff, bspatch } from "../src/index.js";

/** Synthetic "bundle": repetitive JS text with variation, similar to Metro/Hermes output. */
function fakeBundle(lines: number, seed = 0) {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(`__d(function(g,r,i,a,m,e,d){var x${i}=${(i * 7919 + seed) % 1000};e.render${i}=function(){return x${i}*${i}}},${i});`);
  return Buffer.from(out.join("\n"));
}

// Suffix sorting a 20k-line bundle takes a few seconds on CI runners running parallel tasks.
describe("bsdiff", { timeout: 60_000 }, () => {
  it("round-trips random and edge-case inputs", () => {
    const cases: [Buffer, Buffer][] = [
      [Buffer.alloc(0), Buffer.from("hello")],
      [Buffer.from("hello"), Buffer.alloc(0)],
      [Buffer.from("same"), Buffer.from("same")],
      [Buffer.alloc(5000), Buffer.alloc(6000, 1)],
      [randomBytes(3000), randomBytes(3500)],
    ];
    const base = randomBytes(20_000);
    const changed = Buffer.from(base);
    for (let i = 0; i < 200; i++) changed[(i * 97) % changed.length] ^= 0xff;
    cases.push([base, Buffer.concat([changed.subarray(0, 9000), randomBytes(500), changed.subarray(9000)])]);
    for (const [a, b] of cases) expect(bspatch(a, bsdiff(a, b)).equals(b)).toBe(true);
  });

  it("produces small patches for small changes", () => {
    const v1 = fakeBundle(20_000);
    const lines = v1.toString().split("\n");
    lines.splice(5000, 3, "__d(function(){console.log('new feature')},99999);");
    lines[12_345] = lines[12_345]!.replace("return", "return 1+");
    const v2 = Buffer.from(lines.join("\n"));
    const patch = bsdiff(v1, v2);
    expect(bspatch(v1, patch).equals(v2)).toBe(true);
    // The patch is mostly zeros, so it becomes very small after deflate in the zip.
    const { deflateRawSync } = require("node:zlib") as typeof import("node:zlib");
    const compressed = deflateRawSync(patch).length;
    expect(compressed).toBeLessThan(deflateRawSync(v2).length / 20);
  });

  it("rejects corrupt patches", () => {
    expect(() => bspatch(Buffer.from("x"), Buffer.from("not a patch"))).toThrow();
    const patch = bsdiff(Buffer.from("abc"), Buffer.from("abcdef"));
    expect(() => bspatch(Buffer.from("abc"), patch.subarray(0, patch.length - 2))).toThrow();
  });
});

/**
 * Worker thread for bsdiff (CPU- and memory-heavy), so the server event loop stays responsive.
 * Input: { oldFile, newFile, patchFile }. Output: patch size and estimated size after deflate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { bsdiff } from "./bsdiff.js";

parentPort!.on("message", (job: { oldFile: string; newFile: string; patchFile: string }) => {
  try {
    const old = readFileSync(job.oldFile);
    const nw = readFileSync(job.newFile);
    const patch = bsdiff(old, nw);
    writeFileSync(job.patchFile, patch);
    parentPort!.postMessage({
      ok: true,
      patchSize: patch.length,
      patchDeflated: deflateRawSync(patch, { level: 6 }).length,
      newDeflated: deflateRawSync(nw, { level: 6 }).length,
    });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: (e as Error).message });
  }
});

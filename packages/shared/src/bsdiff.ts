/**
 * Binary delta (bsdiff) for large files in a package: JS bundle (React Native) and `libapp.so` (Flutter).
 *
 * Algorithm: port of bsdiff 4.3 (Colin Percival, BSD-2-Clause) with qsufsort (Larsson-Sadakane).
 * Patchkite patch format (uncompressed; the patch is stored in the diff zip, which already uses deflate):
 *
 *   "PATCHK01" | newSize: int64 LE
 *   repeated until newSize bytes are written:
 *     x: int64 LE  — length of the "diff" block: new[i] = old[oldPos + i] + diff[i]
 *     y: int64 LE  — length of the "extra" block: copied verbatim
 *     z: int64 LE  — old position jump (may be negative) after the diff block
 *     x diff bytes, then y extra bytes
 *
 * The Kotlin and Swift SDKs implement `bspatch` with the same format.
 */

export const BSDIFF_MAGIC = "PATCHK01";

/** Suffix array of `old` (qsufsort). I[k] = position of the k-th suffix. */
function qsufsort(old: Uint8Array): Int32Array {
  const n = old.length;
  const I = new Int32Array(n + 1);
  const V = new Int32Array(n + 1);
  const buckets = new Int32Array(256);
  for (let i = 0; i < n; i++) buckets[old[i]!]!++;
  for (let i = 1; i < 256; i++) buckets[i]! += buckets[i - 1]!;
  for (let i = 255; i > 0; i--) buckets[i] = buckets[i - 1]!;
  buckets[0] = 0;
  for (let i = 0; i < n; i++) I[++buckets[old[i]!]!] = i;
  I[0] = n;
  for (let i = 0; i < n; i++) V[i] = buckets[old[i]!]!;
  V[n] = 0;
  for (let i = 1; i < 256; i++) if (buckets[i] === buckets[i - 1]! + 1) I[buckets[i]!] = -1;
  I[0] = -1;

  for (let h = 1; I[0] !== -(n + 1); h += h) {
    let len = 0;
    let i = 0;
    while (i < n + 1) {
      if (I[i]! < 0) {
        len -= I[i]!;
        i -= I[i]!;
      } else {
        if (len) I[i - len] = -len;
        len = V[I[i]!]! + 1 - i;
        split(I, V, i, len, h);
        i += len;
        len = 0;
      }
    }
    if (len) I[i - len] = -len;
  }
  for (let i = 0; i < n + 1; i++) I[V[i]!] = i;
  return I;
}

/**
 * Ternary partition like bsdiff `split`, but with an explicit stack (not recursion)
 * so it is safe for large files. Work order (left → middle → right) is preserved.
 */
function split(I: Int32Array, V: Int32Array, start0: number, len0: number, h: number) {
  // Task: [start, len] to split, or [jj, kk, -1] to mark the middle group.
  const stack: number[][] = [[start0, len0]];
  while (stack.length) {
    const task = stack.pop()!;
    if (task.length === 3) {
      const [jj, kk] = task as [number, number, number];
      for (let i = 0; i < kk - jj; i++) V[I[jj + i]!] = kk - 1;
      if (jj === kk - 1) I[jj] = -1;
      continue;
    }
    const [start, len] = task as [number, number];
    if (len < 16) {
      let j = 1;
      for (let k = start; k < start + len; k += j) {
        j = 1;
        let x = V[I[k]! + h]!;
        for (let i = 1; k + i < start + len; i++) {
          const v = V[I[k + i]! + h]!;
          if (v < x) {
            x = v;
            j = 0;
          }
          if (v === x) {
            const tmp = I[k + j]!;
            I[k + j] = I[k + i]!;
            I[k + i] = tmp;
            j++;
          }
        }
        for (let i = 0; i < j; i++) V[I[k + i]!] = k + j - 1;
        if (j === 1) I[k] = -1;
      }
      continue;
    }

    const x = V[I[start + (len >> 1)]! + h]!;
    let jj = 0;
    let kk = 0;
    for (let i = start; i < start + len; i++) {
      const v = V[I[i]! + h]!;
      if (v < x) jj++;
      if (v === x) kk++;
    }
    jj += start;
    kk += jj;
    let i = start;
    let j = 0;
    let k = 0;
    while (i < jj) {
      const v = V[I[i]! + h]!;
      if (v < x) i++;
      else if (v === x) {
        const tmp = I[i]!;
        I[i] = I[jj + j]!;
        I[jj + j] = tmp;
        j++;
      } else {
        const tmp = I[i]!;
        I[i] = I[kk + k]!;
        I[kk + k] = tmp;
        k++;
      }
    }
    while (jj + j < kk) {
      if (V[I[jj + j]! + h] === x) j++;
      else {
        const tmp = I[jj + j]!;
        I[jj + j] = I[kk + k]!;
        I[kk + k] = tmp;
        k++;
      }
    }
    // LIFO stack: push right, middle, then left so execution order is left → middle → right.
    if (start + len > kk) stack.push([kk, start + len - kk]);
    stack.push([jj, kk, -1]);
    if (jj > start) stack.push([start, jj - start]);
  }
}

function matchlen(old: Uint8Array, oldStart: number, nw: Uint8Array, newStart: number) {
  let i = 0;
  const max = Math.min(old.length - oldStart, nw.length - newStart);
  while (i < max && old[oldStart + i] === nw[newStart + i]) i++;
  return i;
}

/** Find the suffix of `old` with the longest common prefix with nw[newStart..]. */
function search(I: Int32Array, old: Uint8Array, nw: Uint8Array, newStart: number): { pos: number; len: number } {
  let st = 0;
  let en = old.length;
  while (en - st >= 2) {
    const x = st + ((en - st) >> 1);
    const a = I[x]!;
    const n = Math.min(old.length - a, nw.length - newStart);
    const cmp = Buffer.compare(Buffer.from(old.buffer, old.byteOffset + a, n), Buffer.from(nw.buffer, nw.byteOffset + newStart, n));
    if (cmp < 0) st = x;
    else en = x;
  }
  const x = matchlen(old, I[st]!, nw, newStart);
  const y = matchlen(old, I[en]!, nw, newStart);
  return x > y ? { pos: I[st]!, len: x } : { pos: I[en]!, len: y };
}

/** Output writer that accumulates buffer chunks. */
class Out {
  chunks: Buffer[] = [];
  size = 0;
  push(b: Buffer) {
    this.chunks.push(b);
    this.size += b.length;
  }
  i64(v: number) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    this.push(b);
  }
}

/** Create a patch from `old` to `nw`. */
export function bsdiff(old: Uint8Array, nw: Uint8Array): Buffer {
  const I = qsufsort(old);
  const out = new Out();
  out.push(Buffer.from(BSDIFF_MAGIC, "ascii"));
  out.i64(nw.length);

  const oldSize = old.length;
  const newSize = nw.length;
  let scan = 0;
  let len = 0;
  let pos = 0;
  let lastscan = 0;
  let lastpos = 0;
  let lastoffset = 0;

  while (scan < newSize) {
    let oldscore = 0;
    let scsc = (scan += len);
    for (; scan < newSize; scan++) {
      ({ pos, len } = search(I, old, nw, scan));
      for (; scsc < scan + len; scsc++) if (scsc + lastoffset < oldSize && old[scsc + lastoffset] === nw[scsc]) oldscore++;
      if ((len === oldscore && len !== 0) || len > oldscore + 8) break;
      if (scan + lastoffset < oldSize && old[scan + lastoffset] === nw[scan]) oldscore--;
    }

    if (len !== oldscore || scan === newSize) {
      let s = 0;
      let Sf = 0;
      let lenf = 0;
      for (let i = 0; lastscan + i < scan && lastpos + i < oldSize; ) {
        if (old[lastpos + i] === nw[lastscan + i]) s++;
        i++;
        if (s * 2 - i > Sf * 2 - lenf) {
          Sf = s;
          lenf = i;
        }
      }

      let lenb = 0;
      if (scan < newSize) {
        let s2 = 0;
        let Sb = 0;
        for (let i = 1; scan >= lastscan + i && pos >= i; i++) {
          if (old[pos - i] === nw[scan - i]) s2++;
          if (s2 * 2 - i > Sb * 2 - lenb) {
            Sb = s2;
            lenb = i;
          }
        }
      }

      if (lastscan + lenf > scan - lenb) {
        const overlap = lastscan + lenf - (scan - lenb);
        let s3 = 0;
        let Ss = 0;
        let lens = 0;
        for (let i = 0; i < overlap; i++) {
          if (nw[lastscan + lenf - overlap + i] === old[lastpos + lenf - overlap + i]) s3++;
          if (nw[scan - lenb + i] === old[pos - lenb + i]) s3--;
          if (s3 > Ss) {
            Ss = s3;
            lens = i + 1;
          }
        }
        lenf += lens - overlap;
        lenb -= lens;
      }

      const extraLen = scan - lenb - (lastscan + lenf);
      out.i64(lenf);
      out.i64(extraLen);
      out.i64(pos - lenb - (lastpos + lenf));
      const diff = Buffer.allocUnsafe(lenf);
      for (let i = 0; i < lenf; i++) diff[i] = (nw[lastscan + i]! - old[lastpos + i]!) & 0xff;
      out.push(diff);
      out.push(Buffer.from(nw.subarray(lastscan + lenf, lastscan + lenf + extraLen)));

      lastscan = scan - lenb;
      lastpos = pos - lenb;
      lastoffset = pos - scan;
    }
  }
  return Buffer.concat(out.chunks, out.size);
}

/** Apply a patch (reference implementation; the SDKs have streaming Kotlin/Swift versions). */
export function bspatch(old: Uint8Array, patch: Uint8Array): Buffer {
  const p = Buffer.from(patch.buffer, patch.byteOffset, patch.length);
  if (p.length < 16 || p.toString("ascii", 0, 8) !== BSDIFF_MAGIC) throw new Error("Invalid bsdiff patch");
  const newSize = Number(p.readBigInt64LE(8));
  const out = Buffer.alloc(newSize);
  let off = 16;
  let oldPos = 0;
  let newPos = 0;
  while (newPos < newSize) {
    if (off + 24 > p.length) throw new Error("Truncated bsdiff patch");
    const x = Number(p.readBigInt64LE(off));
    const y = Number(p.readBigInt64LE(off + 8));
    const z = Number(p.readBigInt64LE(off + 16));
    off += 24;
    if (x < 0 || y < 0 || newPos + x + y > newSize || off + x + y > p.length) throw new Error("Corrupt bsdiff patch");
    for (let i = 0; i < x; i++) {
      const o = oldPos + i;
      out[newPos + i] = (p[off + i]! + (o >= 0 && o < old.length ? old[o]! : 0)) & 0xff;
    }
    off += x;
    newPos += x;
    oldPos += x;
    p.copy(out, newPos, off, off + y);
    off += y;
    newPos += y;
    oldPos += z;
  }
  return out;
}

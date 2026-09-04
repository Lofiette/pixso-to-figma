// Block-wise difference map between two same-size PNGs.
// usage: node tools/diffmap.mjs <a.png> <b.png> [block] [top]
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
const [, , A_PATH, B_PATH, BLOCK = "24", TOP = "25"] = process.argv;
function px(f) {
  const b = readFileSync(f);
  let p = 8, W = 0, H = 0, ct = 0; const idat = [];
  while (p < b.length) {
    const l = b.readUInt32BE(p), t = b.toString("ascii", p + 4, p + 8);
    if (t === "IHDR") { W = b.readUInt32BE(p + 8); H = b.readUInt32BE(p + 12); ct = b[p + 17]; }
    if (t === "IDAT") idat.push(b.subarray(p + 8, p + 8 + l));
    if (t === "IEND") break;
    p += 12 + l;
  }
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(Buffer.concat(idat));
  const st = W * CH, out = Buffer.alloc(H * st);
  let o = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[o++]; const line = raw.subarray(o, o + st); o += st;
    const cur = out.subarray(y * st, (y + 1) * st), prev = y > 0 ? out.subarray((y - 1) * st, y * st) : null;
    for (let i = 0; i < st; i++) {
      const a = i >= CH ? cur[i - CH] : 0, bb = prev ? prev[i] : 0, c = prev && i >= CH ? prev[i - CH] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += bb; else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
      cur[i] = v & 255;
    }
  }
  return { W, H, CH, out };
}
const A = px(A_PATH), B = px(B_PATH);
if (A.W !== B.W || A.H !== B.H) { console.error("size mismatch"); process.exit(1); }
const S = parseInt(BLOCK, 10);
const bw = Math.ceil(A.W / S), bh = Math.ceil(A.H / S);
const acc = new Float64Array(bw * bh);
for (let y = 0; y < A.H; y++) for (let x = 0; x < A.W; x++) {
  const ia = (y * A.W + x) * A.CH, ib = (y * B.W + x) * B.CH;
  const d = Math.abs(A.out[ia] - B.out[ib]) + Math.abs(A.out[ia + 1] - B.out[ib + 1]) + Math.abs(A.out[ia + 2] - B.out[ib + 2]);
  if (d > 120) acc[Math.floor(y / S) * bw + Math.floor(x / S)]++;
}
const list = [];
for (let i = 0; i < acc.length; i++) if (acc[i] > 0) list.push({ x: (i % bw) * S, y: Math.floor(i / bw) * S, n: acc[i] });
list.sort((a, b) => b.n - a.n);
console.log("blocks with strong diff: " + list.length + " of " + acc.length + " (block " + S + "px)");
console.log("top:");
for (const e of list.slice(0, parseInt(TOP, 10))) console.log("  " + e.x + "," + e.y + "  " + e.n + " px");
// cluster rows
const rows = {};
for (const e of list) rows[e.y] = (rows[e.y] || 0) + e.n;
const rk = Object.keys(rows).map(Number).sort((a, b) => rows[b] - rows[a]).slice(0, 12);
console.log("worst rows (y): " + rk.map((y) => y + ":" + rows[y]).join(", "));

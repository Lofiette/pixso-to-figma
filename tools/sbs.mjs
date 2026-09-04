// Side-by-side two PNGs. usage: node tools/sbs.mjs a.png b.png out.png [scale]
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
const [, , A_PATH, B_PATH, OUT, SCALE = "1"] = process.argv;
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
const s = parseFloat(SCALE);
const aw = Math.round(A.W * s), ah = Math.round(A.H * s), bw = Math.round(B.W * s), bh = Math.round(B.H * s);
const GAP = 16;
const OW = aw + GAP + bw, OH = Math.max(ah, bh);
const stride = OW * 3;
const buf = Buffer.alloc(OH * (stride + 1), 210);
for (let y = 0; y < OH; y++) buf[y * (stride + 1)] = 0;
function blit(src, dx, w, h) {
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.H - 1, Math.floor(y / s));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.W - 1, Math.floor(x / s));
      const si = (sy * src.W + sx) * src.CH;
      const di = y * (stride + 1) + 1 + (dx + x) * 3;
      if (src.CH === 1 || src.CH === 2) { buf[di] = buf[di + 1] = buf[di + 2] = src.out[si]; }
      else { buf[di] = src.out[si]; buf[di + 1] = src.out[si + 1]; buf[di + 2] = src.out[si + 2]; }
    }
  }
}
blit(A, 0, aw, ah);
blit(B, aw + GAP, bw, bh);
function crc32(b) { let c, crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0; }
function mk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, "ascii"), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
const ih = Buffer.alloc(13); ih.writeUInt32BE(OW, 0); ih.writeUInt32BE(OH, 4); ih[8] = 8; ih[9] = 2;
writeFileSync(OUT, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), mk("IHDR", ih), mk("IDAT", deflateSync(buf, { level: 9 })), mk("IEND", Buffer.alloc(0))]));
console.log(OUT + "  " + OW + "x" + OH);

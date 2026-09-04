// Crop / scale a PNG without external deps. usage:
//   node tools/crop.mjs <in.png> <out.png> <x> <y> <w> <h> [zoom]
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const [, , IN, OUT, X, Y, CW, CH, ZOOM = "1"] = process.argv;
const buf = readFileSync(IN);
let p = 8, W = 0, H = 0, depth = 0, color = 0, idat = [];
while (p < buf.length) {
  const len = buf.readUInt32BE(p);
  const type = buf.toString("ascii", p + 4, p + 8);
  const data = buf.subarray(p + 8, p + 8 + len);
  if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
  if (type === "IDAT") idat.push(data);
  if (type === "IEND") break;
  p += 12 + len;
}
if (depth !== 8) throw new Error("only 8-bit supported, got " + depth);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
if (!CHANNELS) throw new Error("unsupported color type " + color);
const raw = inflateSync(Buffer.concat(idat));
const stride = W * CHANNELS;
const px = Buffer.alloc(H * stride);
let off = 0;
for (let y = 0; y < H; y++) {
  const f = raw[off++];
  const line = raw.subarray(off, off + stride); off += stride;
  const cur = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  for (let i = 0; i < stride; i++) {
    const a = i >= CHANNELS ? cur[i - CHANNELS] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= CHANNELS ? prev[i - CHANNELS] : 0;
    let v = line[i];
    if (f === 1) v += a;
    else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) {
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    }
    cur[i] = v & 255;
  }
}
const x0 = Math.max(0, parseInt(X, 10)), y0 = Math.max(0, parseInt(Y, 10));
const cw = Math.min(parseInt(CW, 10), W - x0), ch = Math.min(parseInt(CH, 10), H - y0);
const z = Math.max(1, parseInt(ZOOM, 10));
const ow = cw * z, oh = ch * z, ostride = ow * 3;
const out = Buffer.alloc(oh * (ostride + 1));
for (let y = 0; y < oh; y++) {
  out[y * (ostride + 1)] = 0;
  const sy = y0 + Math.floor(y / z);
  for (let x = 0; x < ow; x++) {
    const sx = x0 + Math.floor(x / z);
    const si = sy * stride + sx * CHANNELS;
    let r, g, b;
    if (CHANNELS === 1) { r = g = b = px[si]; }
    else if (CHANNELS === 2) { r = g = b = px[si]; }
    else { r = px[si]; g = px[si + 1]; b = px[si + 2]; }
    const di = y * (ostride + 1) + 1 + x * 3;
    out[di] = r; out[di + 1] = g; out[di + 2] = b;
  }
}
function crc32(b) { let c, crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0; }
function mk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, "ascii"), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
const ih = Buffer.alloc(13);
ih.writeUInt32BE(ow, 0); ih.writeUInt32BE(oh, 4); ih[8] = 8; ih[9] = 2;
writeFileSync(OUT, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
  mk("IHDR", ih), mk("IDAT", deflateSync(out, { level: 9 })), mk("IEND", Buffer.alloc(0))]));
console.log(IN + " " + W + "x" + H + "  ->  " + OUT + " " + ow + "x" + oh + " (crop " + cw + "x" + ch + " at " + x0 + "," + y0 + ", zoom " + z + ")");

// PNG decode (every colour type and bit depth of the standard, interlaced or not) and 8-bit RGBA
// encode, plus the one geometric operation the migration needs.
//
// Pixso exports indexed PNGs (colour type 3, 2 to 8 bits per pixel, with tRNS) where Figma exports
// 8-bit RGBA: the first live render audit (2026-10-06) failed 305 roots on "does not decode" while
// the decoder took only 8-bit RGB(A) and grey.
//
// A node's render comes back from Pixso in screen orientation. Putting it back on that node as a
// fill re-applies the node's own rotation, so a sideways node gets turned twice. The pixels have to
// be expressed in the node's local frame first, which is what toLocalFrame does.
import { inflateSync, deflateSync } from "node:zlib";

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
// Adam7: x0, y0, dx, dy of each pass; one pass covering everything when not interlaced.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function unfilter(f, cur, prev, bpp) {
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    let v = cur[i];
    if (f === 1) v += a;
    else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) {
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    } else if (f !== 0) throw new Error("PNG filter type " + f + " is not one of 0 to 4");
    cur[i] = v & 255;
  }
}

export function decodePNG(buf) {
  let p = 8, W = 0, H = 0, depth = 0, color = 0, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    if (type === "PLTE") plte = data;
    if (type === "tRNS") trns = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    p += 12 + len;
  }
  const CH = CHANNELS[color];
  if (!CH) throw new Error("unsupported colour type " + color);
  if (DEPTHS[color].indexOf(depth) < 0) throw new Error("bit depth " + depth + " is not allowed with colour type " + color);
  if (color === 3 && !plte) throw new Error("an indexed PNG without a palette (PLTE)");
  if (interlace > 1) throw new Error("unknown interlace method " + interlace);
  const bits = CH * depth, bpp = Math.max(1, bits >> 3), max = (1 << depth) - 1;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(W * H * 4);
  // One sample of a scanline: packed below 8 bits, one byte at 8, big-endian at 16.
  const sample = (line, x, c) => {
    if (depth < 8) { const bit = x * depth; return (line[bit >> 3] >> (8 - depth - (bit & 7))) & max; }
    return depth === 8 ? line[x * CH + c] : line.readUInt16BE((x * CH + c) * 2);
  };
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
  // tRNS for grey and RGB: one colour, at the image's own depth, that is fully transparent.
  const key = trns && (color === 0 || color === 2) ? Array.from({ length: color === 0 ? 1 : 3 }, (_, k) => trns.readUInt16BE(k * 2)) : null;
  const put = (line, x, d) => {
    if (color === 3) {
      const ix = sample(line, x, 0);
      if (ix * 3 + 2 >= plte.length) throw new Error("palette index " + ix + " is outside the palette (" + plte.length / 3 + " entries)");
      rgba[d] = plte[ix * 3]; rgba[d + 1] = plte[ix * 3 + 1]; rgba[d + 2] = plte[ix * 3 + 2];
      rgba[d + 3] = trns && ix < trns.length ? trns[ix] : 255;
      return;
    }
    const s = [];
    for (let c = 0; c < CH; c++) s.push(sample(line, x, c));
    if (color === 0 || color === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = to8(s[0]); }
    else { rgba[d] = to8(s[0]); rgba[d + 1] = to8(s[1]); rgba[d + 2] = to8(s[2]); }
    if (color === 4) rgba[d + 3] = to8(s[1]);
    else if (color === 6) rgba[d + 3] = to8(s[3]);
    else rgba[d + 3] = key && key.every((k, c) => k === s[c]) ? 0 : 255;
  };
  let off = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = Math.ceil((W - x0) / dx), ph = Math.ceil((H - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bits) / 8);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < ph; y++) {
      if (off + 1 + stride > raw.length) throw new Error("the image data ends before the last scanline");
      const f = raw[off++];
      const cur = Buffer.from(raw.subarray(off, off + stride)); off += stride;
      unfilter(f, cur, prev, bpp);
      for (let x = 0; x < pw; x++) put(cur, x, ((y0 + y * dy) * W + x0 + x * dx) * 4);
      prev = cur;
    }
  }
  return { W, H, rgba };
}

function crc32(b) {
  let c, t = crc32.t;
  if (!t) {
    t = crc32.t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  }
  c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePNG(W, H, rgba) {
  const stride = W * 4;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

// Re-express a screen-oriented render in the node's own frame.
//
// The node's absolute linear part [a b; d e] maps local coordinates to screen ones. The render
// covers the screen-space bounding box of the local box, so for every local pixel we ask where it
// lands on screen and read there. For a quarter turn — with or without a mirror — this is an exact
// permutation of pixels, no resampling. `outW`/`outH` are in local pixels.
export function toLocalFrame(img, lin, outW, outH) {
  const [a, b, d, e] = lin;
  const corners = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [u, v] of corners) {
    const x = a * u + b * v, y = d * u + e * v;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const sx = img.W / (maxX - minX), sy = img.H / (maxY - minY);
  const out = Buffer.alloc(outW * outH * 4);
  for (let ly = 0; ly < outH; ly++) {
    const v = ly + 0.5;
    for (let lx = 0; lx < outW; lx++) {
      const u = lx + 0.5;
      const ax = (a * u + b * v - minX) * sx, ay = (d * u + e * v - minY) * sy;
      let px = ax | 0, py = ay | 0;
      if (px < 0) px = 0; else if (px >= img.W) px = img.W - 1;
      if (py < 0) py = 0; else if (py >= img.H) py = img.H - 1;
      img.rgba.copy(out, (ly * outW + lx) * 4, (py * img.W + px) * 4, (py * img.W + px) * 4 + 4);
    }
  }
  return { W: outW, H: outH, rgba: out };
}

// Only a quarter turn, a half turn, or a mirror of one is an exact pixel permutation. Anything
// else would need resampling, and a resampled image is not a faithful transfer — those are left
// to the caller to report rather than quietly blur.
export function isAxisAligned(lin) {
  const near = (x, t) => Math.abs(x - t) < 1e-3;
  const unit = (x) => near(Math.abs(x), 1);
  const zero = (x) => near(x, 0);
  const [a, b, d, e] = lin;
  return (unit(a) && zero(b) && zero(d) && unit(e)) || (zero(a) && unit(b) && unit(d) && zero(e));
}

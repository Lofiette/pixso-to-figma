// Minimal 8-bit PNG decode/encode plus the one geometric operation the migration needs.
//
// A node's render comes back from Pixso in screen orientation. Putting it back on that node as a
// fill re-applies the node's own rotation, so a sideways node gets turned twice. The pixels have to
// be expressed in the node's local frame first, which is what toLocalFrame does.
import { inflateSync, deflateSync } from "node:zlib";

export function decodePNG(buf) {
  let p = 8, W = 0, H = 0, depth = 0, color = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error("only 8-bit PNG supported, got depth " + depth);
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (!CH) throw new Error("unsupported colour type " + color);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * CH;
  const px = Buffer.alloc(H * stride);
  let off = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[off++];
    const line = raw.subarray(off, off + stride); off += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? cur[i - CH] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= CH ? prev[i - CH] : 0;
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
  // Normalise to RGBA so callers have one shape to think about.
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0, n = W * H; i < n; i++) {
    const s = i * CH, d = i * 4;
    if (CH === 1) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; }
    else if (CH === 2) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1]; }
    else if (CH === 3) { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255; }
    else { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3]; }
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

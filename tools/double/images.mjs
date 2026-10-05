// Image bytes as the double sees them (docs/M1.md §6 E, D9): the format from the magic bytes, the size
// from the header, and which P8 case a createImage call falls in. Part E owns it (§9).
//
//   sniffImage(bytes) -> { format: "png"|"jpeg"|"gif"|"webp"|"unknown", width, height }  (0 when unread)
//   p8Case(info)      -> the P8 case the bytes fall in, or null for an ordinary image:
//                        webp -> "webpAsPng"; jpeg -> "jpegAsPng"; png with a side over 4 096 px ->
//                        "longStrip" when that side is at least STRIP_RATIO times the other, else
//                        "png4097"; a png of exactly 4 096 px on its longer side -> "png4096"; anything
//                        else -> null. (The case names say "as PNG" because the archive stores them
//                        under .png; to createImage only the bytes matter.) The strip rule is the
//                        runner's (tools/ir/images.mjs p8Cases); part F aligned the two (docs/M1.md §15).
export const MAX_SIDE = 4096;
export const STRIP_RATIO = 8;

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const ascii = (b, o, n) => String.fromCharCode.apply(null, Array.from(b.subarray(o, o + n)));

export function sniffImage(bytes) {
  const b = bytes;
  const out = { format: "unknown", width: 0, height: 0 };
  if (!b || b.length < 4) return out;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    out.format = "png"; out.width = u32be(b, 16); out.height = u32be(b, 20); return out;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    out.format = "jpeg";
    // Walk the markers to the first start-of-frame.
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = u16be(b, o + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        out.height = u16be(b, o + 5); out.width = u16be(b, o + 7); return out;
      }
      o += 2 + len;
    }
    return out;
  }
  if (ascii(b, 0, 4) === "GIF8" && b.length >= 10) { out.format = "gif"; out.width = u16le(b, 6); out.height = u16le(b, 8); return out; }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    out.format = "webp";
    const kind = ascii(b, 12, 4);
    if (kind === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      out.width = (bits & 0x3fff) + 1; out.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === "VP8X") { out.width = u24le(b, 24) + 1; out.height = u24le(b, 27) + 1; }
    else if (kind === "VP8 " && b.length >= 30) { out.width = u16le(b, 26) & 0x3fff; out.height = u16le(b, 28) & 0x3fff; }
    return out;
  }
  return out;
}

export function p8Case(info) {
  if (info.format === "webp") return "webpAsPng";
  if (info.format === "jpeg") return "jpegAsPng";
  if (info.format !== "png") return null;
  const long = Math.max(info.width, info.height), short = Math.min(info.width, info.height);
  if (long > MAX_SIDE) return short * STRIP_RATIO <= long ? "longStrip" : "png4097";
  if (long === MAX_SIDE) return "png4096";
  return null;
}

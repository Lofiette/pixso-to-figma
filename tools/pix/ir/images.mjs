// The image table (IR.md §11, docs/M1.md D9, §0.3).
//
// Every IMAGE paint the IR holds names its hash, and the hash is listed here, in order of first use.
// `present` means an archive entry named by the hash whose bytes have that SHA-1; an entry whose SHA-1
// differs is treated as missing and noted IMAGE_HASH_MISMATCH. `format` is sniffed from the bytes,
// because some ".png" entries are JPEG or WebP; a missing image has no format.
import { createHash } from "node:crypto";
import { CODE } from "../../ir/schema.mjs";

export function sniff(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return "gif";
  return "unknown";
}

// hashes: the referenced hashes, in order of first use. Returns { images, stats }.
export function imageTable(cx, hashes) {
  const images = [];
  const st = { referenced: hashes.length, present: 0, missing: 0, hashMismatch: 0, formats: {} };
  for (const h of hashes) {
    const entry = cx.pix.images.get(h);
    let present = false, format;
    if (entry) {
      const bytes = entry.data();
      if (createHash("sha1").update(bytes).digest("hex") === h) {
        present = true;
        format = sniff(bytes);
        st.formats[format] = (st.formats[format] || 0) + 1;
      } else {
        st.hashMismatch++;
        cx.noteFile(CODE.IMAGE_HASH_MISMATCH, "the archive entry " + h + ".png has another SHA-1; treated as missing");
      }
    }
    if (present) st.present++; else st.missing++;
    const o = { hash: h, present };
    if (format) o.format = format;
    images.push(o);
  }
  return { images, stats: st };
}

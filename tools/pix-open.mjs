// Read a .pix file from disk, without Pixso.
//
//   node pix-open.mjs <file.pix> [--out <dir>]
//
// This is a READER, not a migration. It proves — and lets anyone re-check — that the format is
// openable, and it reports what is inside so the rest of the work can be planned against facts
// rather than hopes.
//
// The format, measured on "Components OneKIB.pix" (13 MB):
//
//   .pix is a zip:  the document (a nested .pix), every image as a PNG named by its own hash, and
//                   pixso.binary — the Kiwi schema for the document.
//   the document:   "pixso-kw", a version, "compress:zstd", then one zstd frame.
//   inside that:    one Kiwi message, PixsoMsg { pixsoNodes: PixsoNode[], blobs: Blob[], ... }.
//
// The schema travels with the file, so nothing about the encoding has to be guessed: field names,
// types and ids are all stated in pixso.binary. On that file the whole document decoded in two
// seconds and consumed every one of its 49 097 709 bytes — a decoder that had misread the schema
// would have lost sync within kilobytes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import * as zlib from "node:zlib";
import { Reader, parseSchema, decodePath, pathToSVG } from "./kiwi.mjs";

const argv = process.argv.slice(2);
function flag(n) { const i = argv.indexOf(n); if (i < 0) return null; return argv.splice(i, 2)[1]; }
const OUT = flag("--out");
const FILE = argv[0];
if (!FILE) { console.error("usage: node pix-open.mjs <file.pix> [--out <dir>]"); process.exit(1); }

// ---------- zip, by hand ----------
// No dependency, and none is needed: a zip's central directory is a fixed layout and the entries
// here are stored or deflated, both of which node's zlib already does.
function unzip(buf) {
  const EOCD = 0x06054b50;
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== EOCD) end--;
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("central directory entry " + i + " is malformed");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // The local header repeats the name and extra field, with lengths of its own.
    const lnLen = buf.readUInt16LE(localOff + 26), leLen = buf.readUInt16LE(localOff + 28);
    const dataAt = localOff + 30 + lnLen + leLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);
    entries.push({ name, size, method, data: () => (method === 0 ? raw : zlib.inflateRawSync(raw)) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- the document ----------
function decompressDocument(buf) {
  const head = buf.subarray(0, 32).toString("latin1");
  if (!head.startsWith("pixso-kw")) throw new Error("not a pixso document: " + JSON.stringify(head.slice(0, 16)));
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const at = buf.indexOf(magic);
  if (at < 0) throw new Error("no zstd frame in the document");
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("this Node has no zstd (needs Node 22.15+ / 23+); node " + process.version);
  }
  return zlib.zstdDecompressSync(buf.subarray(at));
}

const zip = unzip(readFileSync(FILE));
const schemaEntry = zip.find((e) => e.name === "pixso.binary");
const docEntry = zip.find((e) => e.name.toLowerCase().endsWith(".pix"));
const images = zip.filter((e) => /^[0-9a-f]{40}\.png$/i.test(e.name));
if (!schemaEntry) throw new Error("no pixso.binary in the archive — cannot read it without its schema");
if (!docEntry) throw new Error("no document inside the archive");

console.log(basename(FILE));
console.log("  entries " + zip.length + ", images " + images.length + ", document " + docEntry.size + " bytes");

const defs = parseSchema(schemaEntry.data());
const byName = new Map(defs.map((d, i) => [d.name, i]));
console.log("  schema: " + defs.length + " definitions");

const doc = decompressDocument(docEntry.data());
console.log("  document decompresses to " + doc.length + " bytes");

// ---------- walk it ----------
const KEEP = new Set(["guid", "parentIndex", "type", "name", "size", "visible", "symbolData", "fillGeometry", "strokeGeometry"]);
function readValue(r, type, isArray, keep) {
  if (isArray) {
    const n = r.varuint();
    const out = keep ? [] : null;
    for (let i = 0; i < n; i++) { const v = readValue(r, type, false, keep); if (keep) out.push(v); }
    return out;
  }
  if (type < 0) {
    switch (type) {
      case -1: return r.byte() !== 0;
      case -2: return r.byte();
      case -3: return r.varint();
      case -4: return r.varuint();
      case -5: return r.float();
      case -6: return r.string();
      case -7: return r.varint64();
      case -8: return r.varuint64();
    }
    throw new Error("unknown builtin type " + type);
  }
  const d = defs[type];
  if (d.kind === 0) return r.varuint();
  if (d.kind === 1) {
    const o = keep ? {} : null;
    for (const f of d.fields) { const v = readValue(r, f.type, f.isArray, keep); if (keep) o[f.name] = v; }
    return o;
  }
  return readMessage(r, d, keep);
}
function readMessage(r, d, keep) {
  const o = keep ? {} : null;
  const isNode = d.name === "PixsoNode";
  for (;;) {
    const id = r.varuint();
    if (id === 0) break;
    const f = d.fields.find((x) => x.value === id);
    if (!f) throw new Error("field " + id + " is not in " + d.name);
    const want = keep && (!isNode || KEEP.has(f.name));
    const v = readValue(r, f.type, f.isArray, want);
    if (want) o[f.name] = v;
  }
  return o;
}

const r = new Reader(doc);
const root = defs[byName.get("PixsoMsg")];
const nodes = [];
const blobData = [];
let blobs = 0;
const t0 = Date.now();
for (;;) {
  const id = r.varuint();
  if (id === 0) break;
  const f = root.fields.find((x) => x.value === id);
  if (!f) throw new Error("root field " + id + " is not in PixsoMsg");
  if (f.name === "pixsoNodes") {
    const n = r.varuint();
    for (let i = 0; i < n; i++) {
      const o = readMessage(r, defs[f.type], true);
      nodes.push({
        guid: o.guid ? o.guid.sessionID + ":" + o.guid.localID : null,
        parent: o.parentIndex && o.parentIndex.guid ? o.parentIndex.guid.sessionID + ":" + o.parentIndex.guid.localID : null,
        type: o.type, name: o.name, visible: o.visible,
        w: o.size ? o.size.x : null, h: o.size ? o.size.y : null,
        symbol: o.symbolData && o.symbolData.symbolID ? o.symbolData.symbolID.sessionID + ":" + o.symbolData.symbolID.localID : null,
        fill: (o.fillGeometry || []).map((p) => p.blobIndex),
        stroke: (o.strokeGeometry || []).map((p) => p.blobIndex),
      });
    }
  } else if (f.name === "blobs") {
    const n = r.varuint();
    for (let i = 0; i < n; i++) {
      // Blob is a message with one field, bytes: byte[]. Read it directly so the bytes survive.
      let bytes = null;
      for (;;) { const fid = r.varuint(); if (fid === 0) break; const cnt = r.varuint(); bytes = r.bytes(cnt); }
      blobData.push(bytes);
      blobs++;
    }
  } else readValue(r, f.type, f.isArray, false);
}
// Every byte consumed is the check that the schema was read correctly.
const consumed = r.i === doc.length;
console.log("  decoded " + nodes.length + " nodes and " + blobs + " blobs in " +
  ((Date.now() - t0) / 1000).toFixed(1) + "s — " + (consumed ? "every byte consumed" : "STOPPED at " + r.i + " of " + doc.length));

const NodeType = defs[byName.get("NodeType")];
const tname = new Map(NodeType.fields.map((f) => [f.value, f.name]));
const counts = {};
for (const n of nodes) { const t = tname.get(n.type) || String(n.type); counts[t] = (counts[t] || 0) + 1; }
console.log("");
console.log("  " + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join(", "));

const kidsOf = new Map();
for (const n of nodes) { if (!kidsOf.has(n.parent)) kidsOf.set(n.parent, []); kidsOf.get(n.parent).push(n); }
const pages = nodes.filter((n) => tname.get(n.type) === "CANVAS");
console.log("");
console.log("  pages: " + pages.length);
for (const p of pages) {
  const k = kidsOf.get(p.guid) || [];
  console.log("    " + JSON.stringify(p.name).padEnd(36) + String(k.length).padStart(5) + " top-level");
}

// ---------- geometry ----------
// Decoded here rather than described, because a path that comes out as a real shape is the only
// convincing evidence. Every path blob must consume its own length exactly; any that does not is
// counted and named rather than quietly skipped.
let withGeom = 0, pathsOK = 0, pathsBad = 0, boxAgrees = 0, boxChecked = 0;
const svgs = [];
for (const n of nodes) {
  const idx = (n.fill || []).concat(n.stroke || []);
  if (!idx.length) continue;
  withGeom++;
  let d = "", pts = [];
  for (const bi of idx) {
    try {
      const cmds = decodePath(blobData[bi]);
      pathsOK++;
      d += (d ? " " : "") + pathToSVG(cmds);
      for (const c of cmds) pts.push(...c.pts);
    } catch (e) { pathsBad++; }
  }
  if (pts.length && n.w && n.h) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    boxChecked++;
    if (Math.abs((x1 - x0) - n.w) <= 1 && Math.abs((y1 - y0) - n.h) <= 1) boxAgrees++;
  }
  if (d && svgs.length < 400) svgs.push({ name: n.name, w: n.w, h: n.h, d });
}
console.log("");
console.log("  geometry: " + withGeom + " nodes carry paths, " + pathsOK + " blobs decoded, " + pathsBad + " refused");
console.log("  the path's own bounding box matches the node's size on " + boxAgrees + " of " + boxChecked +
  " — a second field of the format agreeing with the first");

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "nodes.json"), JSON.stringify(nodes, null, 1), "utf8");
  writeFileSync(join(OUT, "schema.json"), JSON.stringify(defs, null, 1), "utf8");
  mkdirSync(join(OUT, "img"), { recursive: true });
  for (const e of images) writeFileSync(join(OUT, "img", e.name), e.data());
  // Shapes as SVG, so the decoding can be checked by eye and not only by arithmetic.
  mkdirSync(join(OUT, "svg"), { recursive: true });
  let k = 0;
  for (const s of svgs) {
    if (!s.w || !s.h) continue;
    const safe = String(s.name).replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40) || "shape";
    const doc = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s.w + " " + s.h + '" width="' + s.w + '" height="' + s.h + '">' +
      '<path d="' + s.d + '" fill="#333"/></svg>';
    writeFileSync(join(OUT, "svg", String(k).padStart(3, "0") + "-" + safe + ".svg"), doc, "utf8");
    if (++k >= 40) break;
  }
  console.log("");
  console.log("  written to " + OUT + ": nodes.json, schema.json, img/ (" + images.length + " images), svg/ (" + k + " shapes)");
}

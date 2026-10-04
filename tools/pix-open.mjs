// Read a .pix file from disk, without Pixso.
//
//   node pix-open.mjs <file.pix> [--out <dir>]
//
// This is a READER, not a migration. It proves — and lets anyone re-check — that the format is
// openable, and it reports what is inside so the rest of the work can be planned against facts
// rather than hopes.
//
// The format, measured on a 13 MB component library:
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
//
// The reading itself lives in tools/pix/read.mjs, so the migration reads a .pix with the same code
// this prints from. A damaged file stops here with a PIX_CORRUPT line and nothing else: it is
// checked whole before anything is reported about it.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { decodePath, pathToSVG } from "./kiwi.mjs";
import { readPix } from "./pix/read.mjs";

const argv = process.argv.slice(2);
function flag(n) { const i = argv.indexOf(n); if (i < 0) return null; return argv.splice(i, 2)[1]; }
const OUT = flag("--out");
const FILE = argv[0];
if (!FILE) { console.error("usage: node pix-open.mjs <file.pix> [--out <dir>]"); process.exit(1); }

// ---------- read it ----------
// Only the fields printed here are kept; every other field is still read and checked, then dropped.
const KEEP = ["guid", "parentIndex", "type", "name", "size", "visible", "symbolData",
  "fillGeometry", "strokeGeometry", "derivedSymbolData"];
let pix;
try { pix = readPix(readFileSync(FILE), { keep: { PixsoNode: KEEP } }); }
catch (e) {
  if (!/^PIX_(CORRUPT|UNSUPPORTED):/.test(e.message)) throw e;
  console.error(e.message);
  process.exit(1);
}
const zip = pix.entries;
const images = zip.filter((e) => /^[0-9a-f]{40}\.png$/i.test(e.name));

console.log(basename(FILE));
console.log("  entries " + zip.length + ", images " + images.length + ", document " + pix.document.size + " bytes");

const defs = pix.schema.defs;
console.log("  schema: " + defs.length + " definitions");

const doc = pix.document.bytes;
console.log("  document decompresses to " + doc.length + " bytes");

const nodes = pix.nodes.map((o) => ({
  guid: o.guid ? o.guid.sessionID + ":" + o.guid.localID : null,
  parent: o.parentIndex && o.parentIndex.guid ? o.parentIndex.guid.sessionID + ":" + o.parentIndex.guid.localID : null,
  type: o.type, name: o.name, visible: o.visible,
  w: o.size ? o.size.x : null, h: o.size ? o.size.y : null,
  symbol: o.symbolData && o.symbolData.symbolID ? o.symbolData.symbolID.sessionID + ":" + o.symbolData.symbolID.localID : null,
  pos: o.parentIndex ? o.parentIndex.position : "",
  derived: (o.derivedSymbolData || []).length,
  fill: (o.fillGeometry || []).map((p) => p.blobIndex),
  stroke: (o.strokeGeometry || []).map((p) => p.blobIndex),
}));
const blobData = pix.blobs;
const blobs = blobData.length;
// Every byte consumed is the check that the schema was read correctly — readPix refuses the file
// otherwise, so reaching this line means it was.
console.log("  decoded " + nodes.length + " nodes and " + blobs + " blobs in " +
  (pix.stats.decodeMs / 1000).toFixed(1) + "s — every byte consumed");

const tname = pix.schema.enums.get("NodeType") || new Map();
const counts = {};
for (const n of nodes) { const t = tname.get(n.type) || String(n.type); counts[t] = (counts[t] || 0) + 1; }
console.log("");
console.log("  " + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join(", "));

const kidsOf = new Map();
for (const n of nodes) { if (!kidsOf.has(n.parent)) kidsOf.set(n.parent, []); kidsOf.get(n.parent).push(n); }
// Siblings are ordered by a fractional index string, not by the order they appear in the file.
for (const [, list] of kidsOf) list.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
const byGuid = new Map(nodes.map((n) => [n.guid, n]));

// An instance is stored with no children at all: its content is the symbol that symbolData points at.
// So the tree Pixso serves is larger than the tree the file stores, and rebuilding it means walking
// into the symbol at every instance. Counted here rather than built, because the count is what can be
// checked against Pixso.
//
// Measured against Pixso over the same open file: 87 114 against 87 265 on one page, 68 against 69 on
// another — the model is right in shape and short by 0.17 %. Ruled out by measurement, so it is not
// re-tested: no override in this file repoints a nested instance at another symbol (0 of 22 276
// instances that carry overrides). What is left is variant selection — symbols live as variants inside
// state groups, and which one the runtime shows depends on the component properties assigned to the
// instance, which this does not yet read.
// The expansion does not have to be re-derived: the file already carries it. Every instance holds
// `derivedSymbolData`, one entry per node inside it, addressed by the same guidPath the overrides use
// and carrying that node's resolved transform, size and geometry. So an instance's expanded size is
// itself plus its derived entries, and nothing below it needs walking — nested instances are already
// included, because the paths run all the way down.
//
// Measured against Pixso over the same open file: 87 265 on one page and 69 on another, **exactly**,
// where re-deriving the walk by hand landed 148 and 0 short. Re-deriving also has to chase variant
// switches (`overriddenSymbolID` on an override, 2 577 of them here); the derived data has already
// resolved them.
function expandedSize(n, depth) {
  if (!n || depth > 60) return 1;                        // a symbol containing itself would not end
  if (tname.get(n.type) === "INSTANCE") return 1 + (n.derived || 0);
  let c = 1;
  for (const k of kidsOf.get(n.guid) || []) c += expandedSize(k, depth + 1);
  return c;
}
const authoredMemo = new Map();
function authoredSize(n) {
  const memo = authoredMemo.get(n.guid);
  if (memo !== undefined) return memo;
  let c = 1;
  for (const k of kidsOf.get(n.guid) || []) c += authoredSize(k);
  authoredMemo.set(n.guid, c);
  return c;
}

const pages = nodes.filter((n) => tname.get(n.type) === "CANVAS");
console.log("");
console.log("  pages: " + pages.length + "     (nodes as stored / as Pixso would serve them)");
for (const p of pages) {
  const k = kidsOf.get(p.guid) || [];
  let a = 0, e = 0;
  for (const c of k) { a += authoredSize(c); e += expandedSize(c, 0); }
  console.log("    " + JSON.stringify(p.name).slice(0, 34).padEnd(36) + String(k.length).padStart(5) + " top-level" +
    String(a).padStart(9) + " /" + String(e).padStart(8));
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

// Read a .pix into memory: the library under tools/pix-open.mjs, and the base of the .pix source.
//
//   import { readPix } from "./pix/read.mjs";
//   const pix = readPix(readFileSync(file));      // throws PIX_CORRUPT / PIX_UNSUPPORTED, or returns:
//   pix.nodes      every PixsoNode, as decoded, in file order
//   pix.blobs      PixsoMsg.blobs as byte views (a Path's blobIndex indexes this), null where empty
//   pix.root       any other PixsoMsg fields
//   pix.schema     { defs, byName, enums }: the file's own schema, and enum value → name per enum
//   pix.entries    every zip entry, bytes unread until entry.data() is called
//   pix.images     lowercase SHA-1 hex → its "<sha1>.png" entry
//   pix.document   { name, size, version, tag, bytes }
//
// The format, measured on a 13 MB component library:
//
//   .pix is a zip:  the document (a nested .pix), every image as a PNG named by its own hash, and
//                   pixso.binary — the Kiwi schema for the document.
//   the document:   "pixso-kw", a version byte, "compress:zstd", then one zstd frame.
//   inside that:    one Kiwi message, PixsoMsg { pixsoNodes: PixsoNode[], blobs: Blob[], ... }.
//
// Everything is decoded and checked before anything is returned. A damaged or hostile file throws
// PIX_CORRUPT here — reading past the end, a field id the file's schema does not define, a document
// that does not end on its last byte, a zip or zstd layer that does not add up — so nothing
// downstream is ever built from half a file.
import * as zlib from "node:zlib";
import { BYTE, createDecoder, parseSchema, corrupt, unsupported } from "../kiwi.mjs";
import { unzip } from "./zip.mjs";

export const DOC_MAGIC = "pixso-kw";
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// Far past any real document (a 13 MB file holds 49 MB), and low enough that a few hundred bytes of
// hostile zstd cannot ask for all of memory.
export const MAX_DOCUMENT_BYTES = 1 << 30;
// The header between the magic and the frame is a version byte and a short tag.
const HEADER_MAX = 4096;
const IMAGE_ENTRY = /^([0-9a-f]{40})\.png$/i;

export function readPix(buffer, opts = {}) {
  const entries = unzip(buffer);
  const schemaEntry = entries.find((e) => e.name === "pixso.binary");
  const docEntry = entries.find((e) => e.name.toLowerCase().endsWith(".pix"));
  if (!schemaEntry) throw corrupt("no pixso.binary in the archive — cannot read it without its schema");
  if (!docEntry) throw corrupt("no document inside the archive");

  const defs = parseSchema(schemaEntry.data());
  checkShape(defs);
  const doc = openDocument(docEntry.data(), opts);

  const t0 = Date.now();
  const msg = createDecoder(defs, { keep: opts.keep }).decode(doc.bytes, "PixsoMsg");
  const decodeMs = Date.now() - t0;

  const root = {};
  for (const k of Object.keys(msg)) if (k !== "pixsoNodes" && k !== "blobs") root[k] = msg[k];
  const images = new Map();
  for (const e of entries) {
    const m = IMAGE_ENTRY.exec(e.name);
    if (m && !images.has(m[1].toLowerCase())) images.set(m[1].toLowerCase(), e);
  }
  return {
    schema: schemaInfo(defs),
    nodes: msg.pixsoNodes || [],
    blobs: (msg.blobs || []).map((b) => (b && b.bytes) || null),
    root,
    entries,
    images,
    document: { name: docEntry.name, size: docEntry.size, version: doc.version, tag: doc.tag, bytes: doc.bytes },
    stats: { decodeMs },
  };
}

// The few things this module itself relies on: nodes and blobs are lists of messages, and a blob's
// bytes are bytes. Everything else in the schema is the file's own business and comes back as
// decoded. A schema that is consistent but shaped otherwise is not damaged, just not one we read.
function checkShape(defs) {
  const t = defs.findIndex((d) => d.name === "PixsoMsg");
  if (t < 0 || defs[t].kind !== 2) throw corrupt("the schema has no message PixsoMsg");
  const field = (d, name) => d.fields.find((f) => f.name === name);
  const listOfMessages = (f) => f.isArray && f.type >= 0 && defs[f.type].kind === 2;
  const nodesF = field(defs[t], "pixsoNodes"), blobsF = field(defs[t], "blobs");
  if (nodesF && !listOfMessages(nodesF)) throw unsupported("PixsoMsg.pixsoNodes is not a list of messages in this schema");
  if (blobsF && !listOfMessages(blobsF)) throw unsupported("PixsoMsg.blobs is not a list of messages in this schema");
  const bytesF = blobsF && field(defs[blobsF.type], "bytes");
  if (bytesF && !(bytesF.isArray && bytesF.type === BYTE)) throw unsupported("Blob.bytes is not a byte array in this schema");
}

// The document entry: magic, version byte, tag, then one zstd frame holding the Kiwi message.
export function openDocument(buf, opts = {}) {
  if (buf.length < 9 || buf.toString("latin1", 0, 8) !== DOC_MAGIC) {
    throw corrupt("not a pixso document: " + JSON.stringify(buf.subarray(0, 16).toString("latin1")));
  }
  const version = buf[8];
  const at = buf.indexOf(ZSTD_MAGIC, 9);
  if (at < 0 || at > HEADER_MAX) {
    const head = buf.toString("latin1", 9, Math.min(buf.length, 9 + 64)).replace(/[^\x20-\x7e]/g, "");
    const m = /compress:[\x21-\x7e]*/.exec(head);
    if (m && m[0] !== "compress:zstd") throw unsupported("the document is compressed as " + JSON.stringify(m[0]));
    throw corrupt("no zstd frame after the document header");
  }
  const tag = buf.toString("latin1", 9, at).replace(/[^\x20-\x7e]/g, "");
  const frame = zstdFrame(buf.subarray(at));
  const max = opts.maxDocumentBytes || MAX_DOCUMENT_BYTES;
  const tooBig = () => unsupported("the document decompresses past the " + Math.round(max / 1048576) + " MB limit (maxDocumentBytes)");
  if (frame.contentSize !== null && frame.contentSize > max) throw tooBig();
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw unsupported("this Node has no zstd (needs Node 22.15+ / 23+); node " + process.version);
  }
  let bytes;
  try { bytes = zlib.zstdDecompressSync(frame.bytes, { maxOutputLength: max }); }
  catch (e) {
    if (e.code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
    throw corrupt("the document's zstd frame does not decompress: " + e.message);
  }
  if (frame.contentSize !== null && bytes.length !== frame.contentSize) {
    throw corrupt("the document's zstd frame declares " + frame.contentSize + " bytes and gives " + bytes.length);
  }
  return { version, tag, bytes };
}

// Walk a zstd frame's header and block headers without decompressing. Needed because node's zstd
// does not complain about a frame that is cut off: it returns what it managed — often nothing — and
// the damage would surface later as a puzzling decode error, or not at all.
export function zstdFrame(b) {
  const label = "the document's zstd frame";
  if (b.length < 6) throw corrupt(label + " is cut off in its header");
  const fhd = b[4];
  if (fhd & 0x08) throw corrupt(label + " sets a reserved header bit");
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  let p = 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag];
  const fcsLen = [single ? 1 : 0, 2, 4, 8][fcsFlag];
  if (p + fcsLen > b.length) throw corrupt(label + " is cut off in its header");
  let contentSize = null;
  if (fcsLen === 1) contentSize = b[p];
  else if (fcsLen === 2) contentSize = b.readUInt16LE(p) + 256;
  else if (fcsLen === 4) contentSize = b.readUInt32LE(p);
  else if (fcsLen === 8) contentSize = Number(b.readBigUInt64LE(p));
  p += fcsLen;
  for (;;) {
    if (p + 3 > b.length) throw corrupt(label + " is cut off at byte " + p + ", where a block should start");
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    if (type === 3) throw corrupt(label + " has a reserved block type at byte " + p);
    p += 3 + (type === 1 ? 1 : size);                    // an RLE block stores its one byte once
    if (p > b.length) throw corrupt(label + " is cut off inside a block");
    if (last) break;
  }
  if (checksum) {
    p += 4;
    if (p > b.length) throw corrupt(label + " is cut off in its checksum");
  }
  return { contentSize, bytes: b.subarray(0, p) };
}

export function schemaInfo(defs) {
  const byName = new Map(defs.map((d, i) => [d.name, i]));
  const enums = new Map();
  for (const d of defs) if (d.kind === 0) enums.set(d.name, new Map(d.fields.map((f) => [f.value, f.name])));
  return { defs, byName, enums };
}

export const guidKey = (g) => (g ? g.sessionID + ":" + g.localID : null);

export const hashHex = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex");

// Children per parent, in the order Pixso shows them. Siblings are ordered by a fractional index
// string, compared as plain strings (not locale-aware), not by the order they appear in the file.
export function childrenByParent(nodes) {
  const kids = new Map();
  for (const n of nodes) {
    const p = n.parentIndex ? guidKey(n.parentIndex.guid) : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n);
  }
  const pos = (n) => (n.parentIndex ? n.parentIndex.position : "");
  for (const list of kids.values()) list.sort((a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0));
  return kids;
}

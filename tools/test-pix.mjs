// The .pix reader, checked on a synthetic file made here — no real file is read, and neither Pixso
// nor Figma is needed.
//
//   node test-pix.mjs
//
// Three things are proved. A file written with our own schema reads back field for field, so the
// decoder and the encoder agree with each other and with Kiwi's layout. A damaged file — cut short,
// carrying a field its schema does not define, running past its last message, or broken at the zip
// or zstd layer — is refused with PIX_CORRUPT and never with some other error, so a caller can stop
// cleanly before building anything. And pix-open.mjs, which designers can run on their own files,
// still prints what it printed before the reading moved into tools/pix/read.mjs.
import { deepStrictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as zlib from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Reader, parseSchema, createDecoder, decodePath, pathToSVG, MAX_DEPTH, UINT } from "./kiwi.mjs";
import { readPix, childrenByParent, guidKey, hashHex } from "./pix/read.mjs";
import { parseKiwiText, encodeSchema, encodeMessage, writeDocument, writePix, Writer } from "./pix/write.mjs";
import { unzip } from "./pix/zip.mjs";
import {
  FIXTURE_SCHEMA, FIXTURE_DOC_NAME, STAR_FILL_SVG, makeFixture,
} from "./pix/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// zstd and crc32 are built into node:zlib from Node 22.15. On an older Node a named import of them
// failed at link time with a SyntaxError that named neither; this says what to install.
if (typeof zlib.zstdCompressSync !== "function" || typeof zlib.crc32 !== "function") {
  console.log("FAIL the .pix checks need Node 22.15 or newer (built-in zstd); this is node " + process.version);
  process.exit(1);
}
const { zstdCompressSync } = zlib;
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (label, fn) => {
  try { const r = fn(); if (r === false) fail(label); else ok(label + (typeof r === "string" ? " (" + r + ")" : "")); }
  catch (e) { fail(label + ": " + e.message.split("\n")[0]); }
};
// Passes only if fn throws an error whose message starts with the prefix, and says what it threw.
const refuses = (label, fn, prefix = "PIX_CORRUPT:", want) => {
  try { fn(); fail(label + ": accepted"); }
  catch (e) {
    if (!e.message.startsWith(prefix)) fail(label + ": threw " + (e.code || e.name) + " instead — " + e.message.split("\n")[0]);
    else if (want && !want.test(e.message)) fail(label + ": wrong reason — " + e.message);
    else ok(label + " — " + e.message);
  }
};
const damaged = (e) => /^PIX_(CORRUPT|UNSUPPORTED):/.test(e.message);

// A deterministic generator for the mutation runs, so a failure can be reproduced.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 1. the schema ----------
const defs = parseKiwiText(FIXTURE_SCHEMA);
check("schema text → binary → parseSchema gives the same definitions", () => {
  deepStrictEqual(parseSchema(encodeSchema(defs)), defs);
  return defs.length + " definitions";
});

// ---------- 2. the round trip ----------
const fx = makeFixture();
let pix = null;
check("the synthetic .pix reads", () => { pix = readPix(fx.pix); return fx.pix.length + " bytes"; });
if (!pix) { console.log(""); console.log("cannot go on without a readable fixture"); process.exit(1); }
const value = fx.value;

check("every node comes back with every field equal", () => {
  deepStrictEqual(pix.nodes, value.pixsoNodes);
  return pix.nodes.length + " nodes";
});
check("every blob comes back byte for byte", () => {
  deepStrictEqual(pix.blobs, value.blobs.map((b) => b.bytes));
  return pix.blobs.length + " blobs";
});
check("the other root fields come back, every builtin type among them", () => {
  deepStrictEqual(pix.root, { fixtureInfo: value.fixtureInfo });
  return "uint64 " + pix.root.fixtureInfo.unsignedBig + ", int64 " + pix.root.fixtureInfo.signedBig;
});
check("the schema read from the file is the one written", () => { deepStrictEqual(pix.schema.defs, defs); });
check("the archive holds what was written, the schema deflated", () => {
  deepStrictEqual(pix.entries.map((e) => e.name), ["pixso.binary", "VERSION", FIXTURE_DOC_NAME, hashHex(fx.image.hash) + ".png"]);
  deepStrictEqual(pix.entries.map((e) => e.method), [8, 0, 0, 0]);
});
check("the document header is read", () => {
  deepStrictEqual([pix.document.name, pix.document.version, pix.document.tag], [FIXTURE_DOC_NAME, 1, "compress:zstd"]);
  deepStrictEqual(pix.document.bytes, fx.message);
});
check("an image is found by its hash and its bytes are read on demand", () => {
  const e = pix.images.get(hashHex(fx.image.hash));
  if (!e) return false;
  deepStrictEqual(e.data(), fx.image.png);
});
check("the same input gives the same file, byte for byte", () => { deepStrictEqual(makeFixture().pix, fx.pix); });

// ---------- 3. what the fixture is there to hold ----------
const E = Object.fromEntries(defs.filter((d) => d.kind === 0).map((d) => [d.name, Object.fromEntries(d.fields.map((f) => [f.name, f.value]))]));
const byName = (name) => pix.nodes.find((n) => n.name === name);
const byGuid = new Map(pix.nodes.map((n) => [guidKey(n.guid), n]));
const kids = childrenByParent(pix.nodes);
const page = byName("Page 1"), internal = byName("Internal Only Canvas");

check("siblings follow their positions by plain string order, not file order", () => {
  const sorted = kids.get(guidKey(page.guid)).map((n) => n.name);
  const stored = pix.nodes.filter((n) => n.parentIndex && guidKey(n.parentIndex.guid) === guidKey(page.guid)).map((n) => n.name);
  deepStrictEqual(sorted, ["Card instance", "Button instance", "Styled", "Badge instance", "Unsupported widget"]);
  if (stored.join() === sorted.join()) throw new Error("the fixture stores them in order, so this proves nothing");
  return sorted.join(" < ");
});
check("a user page and an internal-only canvas", () => page.type === E.NodeType.CANVAS && !page.internalOnly &&
  internal.type === E.NodeType.CANVAS && internal.internalOnly === true);
check("the state group's variants name their axes in different orders", () => {
  const set = byName("Button");
  if (!set.isStateGroup) return false;
  const variants = kids.get(guidKey(set.guid));
  const axes = variants.map((v) => v.name.split(", ").map((p) => p.split("=")[0]));
  deepStrictEqual(axes, [["Size", "State"], ["State", "Size"]]);
  deepStrictEqual(set.stateGroupPropertyValueOrders.map((o) => o.property), ["Size", "State"]);
  return variants.map((v) => v.name).join(" | ");
});
check("every variant carries unnamed BOOL aliases of the set's own property ids", () => {
  const set = byName("Button");
  const roots = set.componentPropDefs;
  if (!roots.every((d) => d.name) || roots.map((d) => d.type).join() !== [E.ComponentPropType.TEXT, E.ComponentPropType.BOOL].join()) return false;
  for (const v of kids.get(guidKey(set.guid))) {
    deepStrictEqual(v.componentPropDefs.map((d) => guidKey(d.id)), roots.map((d) => guidKey(d.id)));
    if (!v.componentPropDefs.every((d) => d.name === "" && d.type === E.ComponentPropType.BOOL)) return false;
  }
  const inst = byName("Button instance");
  deepStrictEqual(inst.componentPropAssignments.map((a) => guidKey(a.defID)), roots.map((d) => guidKey(d.id)));
});
check("a component with a nested instance and a swapped one", () => {
  const card = byName("Card");
  const nested = kids.get(guidKey(card.guid)).filter((n) => n.type === E.NodeType.INSTANCE);
  if (nested.length !== 2) return false;
  const swaps = byName("Card instance").symbolData.symbolOverrides.filter((o) => o.overriddenSymbolID);
  if (swaps.length !== 1) return false;
  const target = byGuid.get(guidKey(swaps[0].guidPath.guids[0]));
  const to = byGuid.get(guidKey(swaps[0].overriddenSymbolID));
  return target.name + " (" + byGuid.get(guidKey(target.symbolData.symbolID)).name + ") → " + to.name;
});
check("exactly one override is stale: its guidPath is in no derivedSymbolData entry", () => {
  const inst = byName("Card instance");
  const pathKey = (p) => p.guids.map(guidKey).join("/");
  const live = new Set(inst.derivedSymbolData.map((d) => pathKey(d.guidPath)));
  const stale = inst.symbolData.symbolOverrides.filter((o) => !live.has(pathKey(o.guidPath)));
  if (stale.length !== 1 || inst.symbolData.symbolOverrides.length !== 3) return false;
  return pathKey(stale[0].guidPath);
});
check("a local style resolves; a dangling reference and the two no-style values do not", () => {
  const style = byGuid.get(guidKey(byName("Uses local style").inheritFillStyleID));
  if (!style || style.styleType !== E.StyleType.FILL || !style.sharedStyleMasterData.styleKey) return false;
  const d = byName("Dangling style");
  if (byGuid.has(guidKey(d.inheritFillStyleID))) return false;
  return guidKey(d.inheritFillStyleID) + " dangles; " + guidKey(d.inheritStrokeStyleID) + " and " + guidKey(d.inheritEffectStyleID) + " mean none";
});
check("one image paint has its PNG in the archive and one does not", () => {
  const hashes = pix.nodes.flatMap((n) => (n.fillPaints || []).filter((p) => p.type === E.PaintType.IMAGE).map((p) => hashHex(p.image.hash)));
  const present = hashes.filter((h) => pix.images.has(h));
  return present.length === 1 && hashes.length === 2 && !pix.images.has(hashHex(fx.missingHash));
});
check("the vector's path blob decodes to the expected SVG path", () => {
  const star = byName("Star");
  const cmds = decodePath(pix.blobs[star.fillGeometry[0].blobIndex]);
  const d = pathToSVG(cmds);
  if (d !== STAR_FILL_SVG) throw new Error("got " + d);
  deepStrictEqual([...new Set(cmds.map((c) => c.op))].sort(), [0, 1, 2, 4]);
  return d;
});
check("the vector's network blob is where vectorData points", () => {
  const star = byName("Star");
  const net = pix.blobs[star.vectorData.vectorNetworkBlob];
  return net.length > 12 && net.readUInt32LE(0) === 3 && net.readUInt32LE(4) === 3 && net.readUInt32LE(8) === 1;
});
check("a node type the builder does not support", () => byName("Unsupported widget").type === E.NodeType.WIDGET);
check("a library copy carries publishFile, publishID, componentKey and overrideKey", () => {
  const b = byName("Badge");
  const layer = kids.get(guidKey(b.guid))[0];
  return !!(b.publishFile && b.publishID && b.componentKey && b.sharedSymbolVersion && layer.overrideKey) &&
    b.publishFile + "@" + guidKey(b.publishID);
});

// ---------- 4. damaged files ----------
refuses("a truncated document", () => readPix(makeFixture("truncated").pix), "PIX_CORRUPT:", /past the end/);
refuses("a field id the file's schema does not define", () => readPix(makeFixture("unknown-field").pix), "PIX_CORRUPT:", /field id 99/);
refuses("bytes after the last message", () => readPix(makeFixture("trailing-bytes").pix), "PIX_CORRUPT:", /left over/);

check("every cut-short prefix of the message is refused with PIX_CORRUPT", () => {
  const dec = createDecoder(defs);
  for (let n = 0; n < fx.message.length; n++) {
    try { dec.decode(fx.message.subarray(0, n), "PixsoMsg"); throw new Error("a prefix of " + n + " bytes was accepted"); }
    catch (e) { if (!e.message.startsWith("PIX_CORRUPT:")) throw new Error("at " + n + " bytes: " + e.message); }
  }
  return fx.message.length + " prefixes";
});
check("random damage to the message is refused with PIX_CORRUPT or read, never anything else", () => {
  const dec = createDecoder(defs), rand = rng(1);
  let refused = 0;
  const TRIALS = 3000;
  for (let t = 0; t < TRIALS; t++) {
    const m = Buffer.from(fx.message);
    const k = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < k; j++) m[Math.floor(rand() * m.length)] = Math.floor(rand() * 256);
    try { dec.decode(m, "PixsoMsg"); }
    catch (e) { if (!e.message.startsWith("PIX_CORRUPT:")) throw new Error("trial " + t + ": " + e.message); refused++; }
  }
  return refused + " of " + TRIALS + " refused, the rest decoded";
});
check("random damage to the schema is refused, or read as some other valid schema, never anything else", () => {
  const rand = rng(2), schema = encodeSchema(defs), doc = writeDocument(fx.message);
  let refused = 0;
  const TRIALS = 300;
  for (let t = 0; t < TRIALS; t++) {
    const s = Buffer.from(schema);
    s[Math.floor(rand() * s.length)] = Math.floor(rand() * 256);
    try { readPix(writePix({ schema: s, document: doc, docName: FIXTURE_DOC_NAME })); }
    catch (e) { if (!damaged(e)) throw new Error("trial " + t + ": " + e.message); refused++; }
  }
  return refused + " of " + TRIALS + " refused";
});
check("random damage anywhere in the .pix is refused with PIX_CORRUPT or PIX_UNSUPPORTED", () => {
  const rand = rng(3);
  let refused = 0;
  const TRIALS = 1000;
  for (let t = 0; t < TRIALS; t++) {
    const f = Buffer.from(fx.pix);
    f[Math.floor(rand() * f.length)] ^= 1 + Math.floor(rand() * 255);
    try { const p = readPix(f); for (const e of p.entries) e.data(); }
    catch (e) { if (!damaged(e)) throw new Error("trial " + t + ": " + e.message); refused++; }
  }
  return refused + " of " + TRIALS + " refused";
});
check("a .pix cut short anywhere is refused with PIX_CORRUPT", () => {
  for (let n = 0; n < fx.pix.length; n += 7) {
    try { readPix(fx.pix.subarray(0, n)); throw new Error("a file of " + n + " bytes was accepted"); }
    catch (e) { if (!e.message.startsWith("PIX_CORRUPT:")) throw new Error("at " + n + " bytes: " + e.message); }
  }
});
refuses("a zstd frame cut short inside a sound archive", () => {
  const doc = writeDocument(fx.message);
  readPix(writePix({ schema: encodeSchema(defs), document: doc.subarray(0, doc.length - 5), docName: FIXTURE_DOC_NAME }));
}, "PIX_CORRUPT:", /zstd frame/);
refuses("a document that is not a pixso document", () => {
  readPix(writePix({ schema: encodeSchema(defs), document: Buffer.from("not-pixso and some bytes"), docName: FIXTURE_DOC_NAME }));
}, "PIX_CORRUPT:", /not a pixso document/);
// The fixture with one byte of its PNG flipped: the document is sound, the image fails its CRC.
function damageImage(pixBytes) {
  const f = Buffer.from(pixBytes);
  const e = unzip(f).find((x) => x.name.endsWith(".png"));
  f[f.indexOf(e.data()) + 20] ^= 0xff;
  return f;
}
refuses("an image whose bytes fail their CRC", () => {
  readPix(damageImage(fx.pix)).images.get(hashHex(fx.image.hash)).data();
}, "PIX_CORRUPT:", /CRC/);
refuses("an archive with no document", () => readPix(writePix({ schema: encodeSchema(defs), document: writeDocument(fx.message), docName: "x.bin" })), "PIX_CORRUPT:", /no document/);

// After the document's one zstd frame. node's zstd stops at the end of the first frame whatever
// follows, so these are caught by the reader or not at all.
const withAfterFrame = (extra) => writePix({
  schema: encodeSchema(defs), document: Buffer.concat([writeDocument(fx.message), extra]), docName: FIXTURE_DOC_NAME,
});
const skippableFrame = (n) => { const b = Buffer.alloc(8 + n, 0x5a); b.writeUInt32LE(0x184d2a53, 0); b.writeUInt32LE(n, 4); return b; };
refuses("text after the document's zstd frame", () => readPix(withAfterFrame(Buffer.from("GARBAGE AFTER THE FRAME"))), "PIX_CORRUPT:", /not part of it/);
refuses("zero padding that ends in a byte that is not zero", () => readPix(withAfterFrame(Buffer.from([0, 0, 0, 1]))), "PIX_CORRUPT:", /not part of it/);
refuses("a second zstd frame after the first", () => readPix(withAfterFrame(zstdCompressSync(Buffer.from("more")))), "PIX_UNSUPPORTED:", /second zstd frame/);
refuses("a skippable zstd frame cut short", () => readPix(withAfterFrame(skippableFrame(10).subarray(0, 12))), "PIX_CORRUPT:", /skippable/);
check("zero padding and skippable frames after the frame are let through, and counted", () => {
  if (pix.stats.bytesAfterFrame !== 0) return false;
  const p = readPix(withAfterFrame(Buffer.concat([skippableFrame(10), Buffer.alloc(16)])));
  deepStrictEqual(p.nodes, value.pixsoNodes);
  return p.stats.bytesAfterFrame === 34 && "34 bytes";
});

// The reader's primitives, each made to read past the end.
const R = (bytes) => new Reader(Buffer.from(bytes));
refuses("a varint past the end", () => R([0x80, 0x80]).varuint());
refuses("a varint longer than ten bytes", () => R([...Array(10).fill(0x80), 0x01]).varuint(), "PIX_CORRUPT:", /ten bytes/);
check("a varint of six to ten bytes is consumed whole, as before", () => { const r = R([0x81, 0x80, 0x80, 0x80, 0x80, 0x00, 0x07]); return r.varuint() === 1 && r.byte() === 7; });
refuses("a 64-bit varint past the end", () => R([0xff, 0xff]).varuint64());
refuses("a float cut after its first byte", () => R([0x7f, 0x01]).float());
refuses("a string with no terminator", () => R([0x41, 0x42]).string());
refuses("a byte count past the end", () => R([1, 2, 3]).bytes(4));
refuses("a byte past the end", () => { const r = R([1]); r.byte(); r.byte(); });
check("Kiwi's ninth 64-bit byte carries all eight bits", () => {
  const w = new Writer(); w.varuint64(2n ** 64n - 1n); w.varint64(-(2n ** 63n));
  const r = new Reader(w.toBuffer());
  return r.varuint64() === 2n ** 64n - 1n && r.varint64() === -(2n ** 63n) && r.done;
});

// Schemas made to hurt.
const schemaBytes = (text) => encodeSchema(parseKiwiTextLoose(text));
function parseKiwiTextLoose(text) { try { return parseKiwiText(text); } catch (e) { throw new Error("test setup: " + e.message); } }
refuses("a schema with a type index past its definitions", () => {
  const d = parseKiwiTextLoose("message M { uint x = 1; }");
  d[0].fields[0].type = 5;
  parseSchema(encodeSchema(d));
}, "PIX_CORRUPT:", /no type/);
refuses("a schema with an unknown kind", () => {
  const b = encodeSchema(parseKiwiTextLoose("message M { uint x = 1; }"));
  b[b.indexOf(0) + 1] = 7;                       // the kind byte follows the first name's terminator
  parseSchema(b);
}, "PIX_CORRUPT:", /kind 7/);
refuses("a schema whose struct contains itself", () => {
  const d = parseKiwiTextLoose("struct S { uint x; } message M { S s = 1; }");
  d[0].fields[0].type = 0;
  parseSchema(encodeSchema(d));
}, "PIX_CORRUPT:", /contains itself/);
refuses("a schema with one field id used twice", () => {
  const d = parseKiwiTextLoose("message M { uint a = 1; uint b = 2; }");
  d[0].fields[1].value = 1;
  parseSchema(encodeSchema(d));
}, "PIX_CORRUPT:", /twice/);
refuses("a schema naming a field __proto__", () => {
  const d = parseKiwiTextLoose("message M { uint a = 1; }");
  d[0].fields[0].name = "__proto__";
  parseSchema(encodeSchema(d));
}, "PIX_CORRUPT:", /__proto__/);
refuses("a schema cut short", () => parseSchema(schemaBytes("message M { uint a = 1; }").subarray(0, 6)));

// Names every plain object already has. The schema comes from the file, so a definition, a field or
// an enum member may be called any of these, and the reader must treat them as plain names.
const HOSTILE_SCHEMA = `
  enum NodeType { DOCUMENT = 0; CANVAS = 1; constructor = 2; __proto__ = 3; toString = 4; }
  struct GUID { uint sessionID; uint localID; }
  struct toString { uint valueOf; }
  message constructor { uint hasOwnProperty = 1; toString toString = 2; }
  message __proto__ { string constructor = 1; }
  message hasOwnProperty { uint isPrototypeOf = 1; }
  message PixsoNode { GUID guid = 1; NodeType type = 2; string name = 3; constructor constructor = 4;
    __proto__ valueOf = 5; hasOwnProperty[] toString = 6; }
  message Blob { byte[] bytes = 1; }
  message PixsoMsg { PixsoNode[] pixsoNodes = 1; Blob[] blobs = 2; }
`;
const hostileDefs = parseKiwiTextLoose(HOSTILE_SCHEMA);
const g = (localID) => ({ sessionID: 0, localID });
const hostileNodes = [
  { guid: g(0), type: 0, name: "Document" },
  { guid: g(1), type: 2, name: "A", constructor: { hasOwnProperty: 7, toString: { valueOf: 3 } } },
  { guid: g(2), type: 3, name: "B", valueOf: { constructor: "x" }, toString: [{ isPrototypeOf: 1 }] },
  { guid: g(3), type: 4, name: "C" },
];
const hostilePix = writePix({
  schema: encodeSchema(hostileDefs), docName: FIXTURE_DOC_NAME,
  document: writeDocument(encodeMessage(hostileDefs, "PixsoMsg", { pixsoNodes: hostileNodes, blobs: [] })),
});
check("definitions, fields and enum members named constructor, __proto__, toString… read as plain names", () => {
  deepStrictEqual(readPix(hostilePix).nodes, hostileNodes);
  deepStrictEqual(readPix(hostilePix, { keep: { PixsoNode: ["guid", "name"] } }).nodes, hostileNodes.map((n) => ({ guid: n.guid, name: n.name })));
  // JSON.parse, because "__proto__" in an object literal sets the prototype instead of a key.
  const keep = JSON.parse('{"PixsoNode":["guid","constructor","valueOf"],"constructor":["toString"],"__proto__":[]}');
  deepStrictEqual(readPix(hostilePix, { keep }).nodes, [
    { guid: g(0) }, { guid: g(1), constructor: { toString: { valueOf: 3 } } }, { guid: g(2), valueOf: {} }, { guid: g(3) },
  ]);
  return "with and without keep";
});

// S0 holds S1 holds … S(n-1), which holds a uint (or nothing); message M holds S0. `reverse` lists
// the definitions last-first, so a walk in the file's order meets the chain from its far end.
function structChain(n, { reverse = false, empty = false } = {}) {
  const at = (i) => (reverse ? n - 1 - i : i);
  const d = new Array(n);
  for (let i = 0; i < n; i++) {
    d[at(i)] = {
      name: "S" + i, kind: 1,
      fields: i + 1 < n ? [{ name: "s", type: at(i + 1), isArray: false, value: 1 }]
        : empty ? [] : [{ name: "x", type: UINT, isArray: false, value: 1 }],
    };
  }
  d.push({ name: "M", kind: 2, fields: [{ name: "s", type: at(0), isArray: false, value: 1 }] });
  return d;
}
check("structs nested " + MAX_DEPTH + " deep, as deep as the decoder goes, parse and decode", () => {
  let v = createDecoder(parseSchema(encodeSchema(structChain(MAX_DEPTH)))).decode(Buffer.from([1, 5, 0]), "M");
  for (let i = 0; i < MAX_DEPTH; i++) v = v.s;
  return v.x === 5;
});
refuses("structs nested " + (MAX_DEPTH + 1) + " deep", () => parseSchema(encodeSchema(structChain(MAX_DEPTH + 1))), "PIX_CORRUPT:", /levels deep/);
refuses("a chain of 20 000 structs, listed first to last", () => parseSchema(encodeSchema(structChain(20000))), "PIX_CORRUPT:", /levels deep/);
refuses("a chain of 20 000 structs, listed last to first", () => parseSchema(encodeSchema(structChain(20000, { reverse: true }))), "PIX_CORRUPT:", /levels deep/);
refuses("a chain of 20 000 empty structs handed straight to createDecoder", () => createDecoder(structChain(20000, { empty: true })), "PIX_CORRUPT:", /levels deep/);

// Messages made to hurt.
check("messages nested " + (MAX_DEPTH - 6) + " deep read", () => {
  const d = parseKiwiTextLoose("message M { M child = 1; }");
  const n = MAX_DEPTH - 6;
  createDecoder(d).decode(Buffer.concat([Buffer.alloc(n, 1), Buffer.alloc(n + 1, 0)]), "M");
});
refuses("messages nested deeper than " + MAX_DEPTH, () => {
  const d = parseKiwiTextLoose("message M { M child = 1; }");
  const n = 100000;
  createDecoder(d).decode(Buffer.concat([Buffer.alloc(n, 1), Buffer.alloc(n + 1, 0)]), "M");
}, "PIX_CORRUPT:", /deeper/);
refuses("an array that claims more elements than there are bytes", () => {
  const w = new Writer(); w.varuint(1); w.varuint(0x7fffffff); w.byte(0);
  createDecoder(parseKiwiTextLoose("message M { uint[] xs = 1; }")).decode(w.toBuffer(), "M");
}, "PIX_CORRUPT:", /longer than/);
refuses("an array of empty structs that claims four billion elements", () => {
  const w = new Writer(); w.varuint(1); w.varuint(0xffffffff); w.varuint(0);
  createDecoder(parseKiwiTextLoose("struct E { } message M { E[] es = 1; }")).decode(w.toBuffer(), "M");
}, "PIX_CORRUPT:", /empty structs/);
check("an array of empty structs of a sane length reads", () => {
  const w = new Writer(); w.varuint(1); w.varuint(3); w.varuint(0);
  deepStrictEqual(createDecoder(parseKiwiTextLoose("struct E { } message M { E[] es = 1; }")).decode(w.toBuffer(), "M"), { es: [{}, {}, {}] });
});
refuses("a .pix whose schema makes nodes and blobs something other than messages", () => {
  const d = parseKiwiTextLoose("message PixsoMsg { uint[] pixsoNodes = 1; string blobs = 2; }");
  readPix(writePix({ schema: encodeSchema(d), document: writeDocument(encodeMessage(d, "PixsoMsg", { blobs: "x" })), docName: FIXTURE_DOC_NAME }));
}, "PIX_UNSUPPORTED:", /not a list of messages/);

// Geometry blobs.
refuses("a path blob with an opcode nobody has seen", () => decodePath(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0])), "PIX_CORRUPT:", /opcode 3/);
refuses("a path blob cut inside a point", () => decodePath(Buffer.from([1, 0, 0, 0])), "PIX_CORRUPT:", /past the end/);

// ---------- 5. pix-open.mjs on the fixture ----------
const tmp = mkdtempSync(join(tmpdir(), "pxf-pix-"));
try {
  const file = join(tmp, "fixture.pix");
  writeFileSync(file, fx.pix);
  const run = (...args) => spawnSync(process.execPath, [join(HERE, "pix-open.mjs"), ...args], { encoding: "utf8" });
  const res = run(file, "--out", join(tmp, "out"));
  const lines = res.stdout.split(/\r?\n/);
  const has = (label, line) => (lines.includes(line) ? ok("pix-open prints " + label) : fail("pix-open does not print " + label + ": " + JSON.stringify(line)));
  if (res.status !== 0) fail("pix-open failed on the fixture: " + res.stderr);
  else {
    has("the archive", "  entries 4, images 1, document " + pix.document.size + " bytes");
    has("the schema", "  schema: " + defs.length + " definitions");
    has("the document size", "  document decompresses to " + fx.message.length + " bytes");
    const decoded = lines.find((l) => l.startsWith("  decoded "));
    if (/^  decoded 30 nodes and 4 blobs in \d+\.\ds — every byte consumed$/.test(decoded || "")) ok("pix-open prints the node and blob counts");
    else fail("pix-open's decode line: " + JSON.stringify(decoded));
    // 8 rectangles counting the style node; 6 symbols: 2 variants, 2 icons, Card, Badge; 5 instances:
    // 3 on the page, 2 nested in Card.
    has("the type counts", "  RECTANGLE 8, SYMBOL 6, INSTANCE 5, TEXT 3, CANVAS 2, FRAME 2, VECTOR 2, DOCUMENT 1, WIDGET 1");
    // Page 1: 5 children; as stored 1+1+5+1+1 = 9; expanded, each instance adds its derived entries:
    // Card instance 1+5, Button instance 1+2, Styled 5, Badge instance 1+1, widget 1 = 17.
    has("the user page", '    "Page 1"                                5 top-level        9 /      17');
    // Internal: set 7, Star 2, Heart 2, Card 4 (6 expanded: each nested icon adds one), Badge 2, style 1.
    has("the internal canvas", '    "Internal Only Canvas"                  6 top-level       18 /      20');
    has("the geometry", "  geometry: 2 nodes carry paths, 3 blobs decoded, 0 refused");
    has("the box check", "  the path's own bounding box matches the node's size on 2 of 2 — a second field of the format agreeing with the first");
    check("pix-open --out writes 30 nodes, the image and two shapes", () => {
      const out = join(tmp, "out");
      if (JSON.parse(readFileSync(join(out, "nodes.json"), "utf8")).length !== 30) return false;
      deepStrictEqual(readFileSync(join(out, "img", hashHex(fx.image.hash) + ".png")), fx.image.png);
      return readdirSync(join(out, "svg")).length === 2;
    });
  }
  const badImage = join(tmp, "bad-image.pix");
  writeFileSync(badImage, damageImage(fx.pix));
  const r3 = run(badImage, "--out", join(tmp, "out-bad"));
  const errs = r3.stderr.split(/\r?\n/).filter(Boolean);
  if (r3.status === 1 && errs.length === 1 && /^PIX_CORRUPT: .*CRC/.test(errs[0]) &&
      r3.stdout.split(/\r?\n/).some((l) => l.endsWith("img/ (0 of 1 images, 1 refused), svg/ (2 shapes)")) &&
      existsSync(join(tmp, "out-bad", "nodes.json")) && readdirSync(join(tmp, "out-bad", "img")).length === 0) {
    ok("pix-open --out skips an image that fails its CRC with one PIX_CORRUPT line, writes the rest and exits 1");
  } else fail("pix-open --out on a damaged image: exit " + r3.status + ", stderr " + JSON.stringify(r3.stderr.slice(0, 300)));
  const r4 = run(badImage);
  if (r4.status === 0 && r4.stderr === "") ok("pix-open without --out does not read images, so the damaged one passes");
  else fail("pix-open on a damaged image without --out: exit " + r4.status + ", stderr " + JSON.stringify(r4.stderr.slice(0, 300)));

  const hostile = join(tmp, "hostile.pix");
  writeFileSync(hostile, hostilePix);
  const r5 = run(hostile);
  if (r5.status === 0 && r5.stdout.split(/\r?\n/).includes("  DOCUMENT 1, constructor 1, __proto__ 1, toString 1")) {
    ok("pix-open counts node types named constructor, __proto__ and toString like any other");
  } else fail("pix-open on hostile names: exit " + r5.status + ", " + JSON.stringify((r5.stderr || r5.stdout).slice(0, 300)));

  const bad = join(tmp, "truncated.pix");
  writeFileSync(bad, makeFixture("truncated").pix);
  const r2 = run(bad);
  if (r2.status === 1 && r2.stderr.startsWith("PIX_CORRUPT:") && r2.stdout === "") ok("pix-open refuses the truncated fixture with one PIX_CORRUPT line and prints nothing else");
  else fail("pix-open on the truncated fixture: exit " + r2.status + ", stderr " + JSON.stringify(r2.stderr.slice(0, 200)));

  // A dump holds the file's own names and images, so --out refuses the repository outside out/.
  const inside = join(HERE, "pxf-dump-refused-" + process.pid);
  const r6 = run(file, "--out", inside);
  if (r6.status === 1 && /^refusing to write a \.pix dump inside the repository/.test(r6.stderr) && !existsSync(inside)) {
    ok("pix-open --out refuses a folder inside the repository and writes nothing there");
  } else fail("pix-open --out inside the repository: exit " + r6.status + ", stderr " + JSON.stringify(r6.stderr.slice(0, 200)));
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log("");
console.log(failed ? failed + " .pix check" + (failed === 1 ? "" : "s") + " FAILED" : "all .pix checks pass");
process.exit(failed ? 1 : 0);

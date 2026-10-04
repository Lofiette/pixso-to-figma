// A synthetic .pix, made in memory from definitions written here. Nothing in it comes from a real
// file: the schema, the names, the keys, the picture and the geometry are all made up, so it can
// live in a public repository and run on any machine (§8 of docs/REWRITE.md).
//
//   import { makeFixture } from "./pix/fixture.mjs";
//   const { pix } = makeFixture();                       // a valid .pix, as a Buffer
//   makeFixture("truncated" | "unknown-field" | "trailing-bytes")
//
//   node tools/pix/fixture.mjs <out.pix> [--variant <name>]    writes one to disk
//
// The document holds one of each case the reader and the plan have to handle, listed at
// fixtureMessage() below.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encodePNG } from "../pngutil.mjs";
import { parseKiwiText, encodeSchema, encodeMessage, writeDocument, writePix } from "./write.mjs";

// Written for this repository. The field names are the ones tools/pix-open.mjs and docs/REWRITE.md
// rely on; the types, ids, enum values and the layout are ours. It is not Pixso's schema and is not
// meant to be: the reader takes the schema from the file it reads, so any self-consistent schema is
// a valid one, and a subset exercises the same decoder.
export const FIXTURE_SCHEMA = `
enum NodeType {
  NONE = 0; DOCUMENT = 1; CANVAS = 2; FRAME = 3; GROUP = 4; RECTANGLE = 5; VECTOR = 6; TEXT = 7;
  SYMBOL = 8; INSTANCE = 9; WIDGET = 10;
}
enum WindingRule { NONZERO = 0; ODD = 1; }
enum PaintType { SOLID = 0; IMAGE = 1; }
enum StyleType { NONE = 0; FILL = 1; STROKE = 2; TEXT = 3; EFFECT = 4; }
enum ComponentPropType { BOOL = 0; TEXT = 1; INSTANCE_SWAP = 2; }
enum ComponentPropNodeField { VISIBLE = 0; TEXT_DATA = 1; OVERRIDDEN_SYMBOL_ID = 2; }

struct GUID { uint sessionID; uint localID; }
struct ParentIndex { GUID guid; string position; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct Color { float r; float g; float b; float a; }

message GUIDPath { GUID[] guids = 1; }
message Image { byte[] hash = 1; string name = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; Image image = 5; }
message Path { WindingRule windingRule = 1; uint blobIndex = 2; }
message VectorData { uint vectorNetworkBlob = 1; Vector normalizedSize = 2; }
message SymbolData { GUID symbolID = 1; PixsoNode[] symbolOverrides = 2; }
message StateGroupPropertyValueOrder { string property = 1; string[] values = 2; }
message ComponentPropValue { bool boolValue = 1; string textValue = 2; GUID guidValue = 3; }
message ComponentPropDef { GUID id = 1; string name = 2; ComponentPropType type = 3; ComponentPropValue initialValue = 4; }
message ComponentPropRef { GUID defID = 1; ComponentPropNodeField componentPropNodeField = 2; }
message ComponentPropAssignment { GUID defID = 1; ComponentPropValue value = 2; }
message SharedStyleMasterData { string styleKey = 1; string sortPosition = 2; string fileKey = 3; }

message PixsoNode {
  GUID guid = 1;
  ParentIndex parentIndex = 2;
  NodeType type = 3;
  string name = 4;
  Vector size = 5;
  Matrix transform = 6;
  bool visible = 7;
  bool internalOnly = 8;
  GUIDPath guidPath = 9;
  SymbolData symbolData = 10;
  PixsoNode[] derivedSymbolData = 11;
  GUID overriddenSymbolID = 12;
  string componentKey = 13;
  string publishFile = 14;
  GUID publishID = 15;
  string sharedSymbolVersion = 16;
  GUID overrideKey = 17;
  bool isStateGroup = 18;
  StateGroupPropertyValueOrder[] stateGroupPropertyValueOrders = 19;
  ComponentPropDef[] componentPropDefs = 20;
  ComponentPropRef[] componentPropRefs = 21;
  ComponentPropAssignment[] componentPropAssignments = 22;
  StyleType styleType = 23;
  string styleID = 24;
  GUID inheritFillStyleID = 25;
  GUID inheritStrokeStyleID = 26;
  GUID inheritTextStyleID = 27;
  GUID inheritEffectStyleID = 28;
  SharedStyleMasterData sharedStyleMasterData = 29;
  Paint[] fillPaints = 30;
  Paint[] strokePaints = 31;
  Path[] fillGeometry = 32;
  Path[] strokeGeometry = 33;
  VectorData vectorData = 34;
  float opacity = 35;
}

message Blob { byte[] bytes = 1; }

// Exists only so that every builtin type is round-tripped at least once.
message FixtureInfo { string label = 1; byte flags = 2; int delta = 3; int64 signedBig = 4; uint64 unsignedBig = 5; float scale = 6; bool ready = 7; }

message PixsoMsg { PixsoNode[] pixsoNodes = 1; Blob[] blobs = 2; FixtureInfo fixtureInfo = 3; }
`;

export const FIXTURE_DOC_NAME = "Fixture.pix";

// Enum name → value, per enum, so the document below is written with names and decodes to numbers.
function enumsOf(defs) {
  const E = {};
  for (const d of defs) if (d.kind === 0) E[d.name] = Object.fromEntries(d.fields.map((f) => [f.name, f.value]));
  return E;
}

const g = (sessionID, localID) => ({ sessionID, localID });
const under = (guid, position) => ({ guid, position });
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const box = (x, y) => ({ x, y });
const path = (...guids) => ({ guids });

// A geometry blob: [opcode][float32 LE x, y]* with the opcodes the reader knows (tools/kiwi.mjs).
export function encodePath(cmds) {
  const parts = [];
  for (const [op, ...xy] of cmds) {
    const b = Buffer.alloc(1 + xy.length * 4);
    b[0] = op;
    xy.forEach((v, k) => b.writeFloatLE(v, 1 + k * 4));
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// A vector network in a layout of our own, modelled on the publicly described .fig one: three u32
// counts; vertices {u32 styleID, f32 x, f32 y}; segments {u32 styleID, u32 start, f32 tx, f32 ty,
// u32 end, f32 tx, f32 ty}; regions {u32 styleID, u32 windingRule, u32 loopCount, then per loop
// u32 count and that many u32 segment indices}. The reader treats blobs as opaque bytes, so this only
// has to be self-consistent here; decoding real networks is later work, measured on real files.
export function encodeVectorNetwork({ vertices, segments, regions }) {
  const u = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); u.push(b); };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); u.push(b); };
  u32(vertices.length); u32(segments.length); u32(regions.length);
  for (const v of vertices) { u32(v.styleID); f32(v.x); f32(v.y); }
  for (const s of segments) { u32(s.styleID); u32(s.start); f32(s.ts[0]); f32(s.ts[1]); u32(s.end); f32(s.te[0]); f32(s.te[1]); }
  for (const r of regions) {
    u32(r.styleID); u32(r.windingRule); u32(r.loops.length);
    for (const loop of r.loops) { u32(loop.length); for (const k of loop) u32(k); }
  }
  return Buffer.concat(u);
}

// A 2x2 picture of four made-up colours, and its hash — the name the archive files it under.
export function fixtureImage() {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
  const png = encodePNG(2, 2, rgba);
  return { png, hash: createHash("sha1").update(png).digest() };
}
// The hash of an image the archive does not hold.
export const MISSING_IMAGE_HASH = createHash("sha1").update("fixture: an image that is not in the archive").digest();

// The expected decode of the path blob, in tools/kiwi.mjs pathToSVG() form.
export const STAR_FILL_SVG = "M0,0 L10,0 C10,5.5 5,10 0,10 Z";

// The document, as the object the decoder must give back. Every float is exact in 32 bits, so the
// round trip can be compared with plain equality. It holds:
//   - a user page and an internalOnly canvas;
//   - a state group whose variant names list their axes in different orders, with root property
//     definitions on the set and variant-local aliases (same id, unnamed BOOL) on every variant;
//   - a component (Card) with two nested instances, and an instance of it whose override swaps one
//     of them (overriddenSymbolID), one live override, and one stale override whose guidPath is in
//     no derivedSymbolData entry;
//   - a library copy carrying publishFile, publishID, componentKey, sharedSymbolVersion, and
//     overrideKey on its layer;
//   - a local style, a node bound to it, and a node whose style reference resolves nowhere, plus the
//     two "no style" values (0:0 and all ones);
//   - an image paint whose PNG is in the archive and one whose PNG is not;
//   - a vector with path blobs (opcodes 0, 1, 2, 4) and a vector-network blob;
//   - a node type the builder does not support (WIDGET);
//   - user-page children stored out of order, positions "B" and "a" among them, so sibling order
//     must come from plain string comparison of the positions — not from file order, not from a
//     locale-aware compare (which would put "a" first).
export function fixtureMessage(defs) {
  const E = enumsOf(defs);
  const T = E.NodeType;
  const solid = (r, gg, b) => ({ type: E.PaintType.SOLID, color: { r, g: gg, b, a: 255 }, opacity: 1, visible: true });
  const { hash: imageHash } = fixtureImage();

  const DOC = g(0, 0), PAGE = g(0, 1), INTERNAL = g(0, 2);
  const SET = g(1, 10), SMALL = g(1, 11), LARGE = g(1, 14);
  const STAR = g(1, 20), STAR_V = g(1, 21), HEART = g(1, 22), HEART_V = g(1, 23);
  const CARD = g(1, 30), CARD_BG = g(1, 31), LEAD = g(1, 32), TRAIL = g(1, 33);
  const BADGE = g(1, 40), BADGE_TEXT = g(1, 41), STYLE = g(1, 50), STYLED = g(1, 63);
  const LABEL_PROP = g(1, 900), ICON_PROP = g(1, 901);
  // Newer Pixso writes a variant-local alias for every property: the set's id, unnamed, BOOL.
  const alias = (id) => ({ id, name: "", type: E.ComponentPropType.BOOL });
  const refs = (label, icon) => [
    { guid: label, type: T.TEXT, name: "Label", componentPropRefs: [{ defID: LABEL_PROP, componentPropNodeField: E.ComponentPropNodeField.TEXT_DATA }] },
    { guid: icon, type: T.RECTANGLE, name: "Icon", componentPropRefs: [{ defID: ICON_PROP, componentPropNodeField: E.ComponentPropNodeField.VISIBLE }] },
  ];

  const nodes = [
    { guid: DOC, type: T.DOCUMENT, name: "Document", visible: true },
    { guid: PAGE, parentIndex: under(DOC, "a"), type: T.CANVAS, name: "Page 1", visible: true },
    { guid: INTERNAL, parentIndex: under(DOC, "b"), type: T.CANVAS, name: "Internal Only Canvas", visible: false, internalOnly: true },

    // ---- the user page, children stored out of position order ----
    { guid: g(1, 62), parentIndex: under(PAGE, "d"), type: T.INSTANCE, name: "Badge instance", size: box(64, 24), transform: at(0, 200),
      symbolData: { symbolID: BADGE },
      derivedSymbolData: [{ guidPath: path(BADGE_TEXT), size: box(40, 16), transform: at(12, 4) }] },
    { guid: g(1, 60), parentIndex: under(PAGE, "B"), type: T.INSTANCE, name: "Card instance", size: box(200, 40), transform: at(0, 0),
      symbolData: {
        symbolID: CARD,
        symbolOverrides: [
          { guidPath: path(TRAIL), overriddenSymbolID: HEART },                          // swap a nested instance
          { guidPath: path(CARD_BG), fillPaints: [solid(255, 0, 0)] },                   // live
          { guidPath: path(g(1, 99)), name: "Removed layer" },                           // stale: in no derived entry
        ],
      },
      derivedSymbolData: [
        { guidPath: path(CARD_BG), size: box(200, 40), transform: at(0, 0) },
        { guidPath: path(LEAD), size: box(10, 10), transform: at(8, 15) },
        { guidPath: path(LEAD, STAR_V), size: box(10, 10), transform: at(0, 0) },
        { guidPath: path(TRAIL), size: box(8, 8), transform: at(184, 16) },
        // Already resolved through the swap: the trailing icon's layer is Heart's, not Star's.
        { guidPath: path(TRAIL, HEART_V), size: box(8, 8), transform: at(0, 0), fillGeometry: [{ windingRule: E.WindingRule.ODD, blobIndex: 3 }] },
      ] },
    { guid: g(1, 68), parentIndex: under(PAGE, "e"), type: T.WIDGET, name: "Unsupported widget", size: box(50, 50), transform: at(300, 0) },
    { guid: g(1, 61), parentIndex: under(PAGE, "a"), type: T.INSTANCE, name: "Button instance", size: box(160, 48), transform: at(0, 100),
      symbolData: { symbolID: LARGE },
      componentPropAssignments: [
        { defID: LABEL_PROP, value: { textValue: "OK" } },
        { defID: ICON_PROP, value: { boolValue: false } },
      ],
      derivedSymbolData: [
        { guidPath: path(g(1, 15)), size: box(120, 24), transform: at(32, 12) },
        { guidPath: path(g(1, 16)), size: box(16, 16), transform: at(12, 16) },
      ] },
    { guid: STYLED, parentIndex: under(PAGE, "c"), type: T.FRAME, name: "Styled", size: box(400, 100), transform: at(0, 300) },
    { guid: g(1, 64), parentIndex: under(STYLED, "a"), type: T.RECTANGLE, name: "Uses local style", size: box(20, 20), transform: at(0, 0),
      inheritFillStyleID: STYLE, fillPaints: [solid(0, 85, 255)] },
    { guid: g(1, 65), parentIndex: under(STYLED, "b"), type: T.RECTANGLE, name: "Dangling style", size: box(20, 20), transform: at(30, 0),
      inheritFillStyleID: g(77, 77), inheritStrokeStyleID: g(0, 0), inheritEffectStyleID: g(0xffffffff, 0xffffffff),
      fillPaints: [solid(10, 20, 30)] },
    { guid: g(1, 66), parentIndex: under(STYLED, "c"), type: T.RECTANGLE, name: "Image present", size: box(20, 20), transform: at(60, 0),
      fillPaints: [{ type: E.PaintType.IMAGE, image: { hash: imageHash, name: "present" }, opacity: 1, visible: true }] },
    { guid: g(1, 67), parentIndex: under(STYLED, "d"), type: T.RECTANGLE, name: "Image missing", size: box(20, 20), transform: at(90, 0),
      fillPaints: [{ type: E.PaintType.IMAGE, image: { hash: MISSING_IMAGE_HASH, name: "missing" }, opacity: 0.5, visible: true }] },

    // ---- definitions, on the internal canvas ----
    { guid: SET, parentIndex: under(INTERNAL, "a"), type: T.FRAME, name: "Button", size: box(240, 48), transform: at(0, 0),
      isStateGroup: true,
      stateGroupPropertyValueOrders: [
        { property: "Size", values: ["Small", "Large"] },
        { property: "State", values: ["Default", "Hover"] },
      ],
      componentPropDefs: [
        { id: LABEL_PROP, name: "Label", type: E.ComponentPropType.TEXT, initialValue: { textValue: "Button" } },
        { id: ICON_PROP, name: "Show icon", type: E.ComponentPropType.BOOL, initialValue: { boolValue: true } },
      ] },
    { guid: SMALL, parentIndex: under(SET, "a"), type: T.SYMBOL, name: "Size=Small, State=Default", size: box(96, 32), transform: at(0, 0),
      componentPropDefs: [alias(LABEL_PROP), alias(ICON_PROP)] },
    ...refs(g(1, 12), g(1, 13)).map((n, k) => ({ ...n, parentIndex: under(SMALL, "ab"[k]) })),
    { guid: LARGE, parentIndex: under(SET, "b"), type: T.SYMBOL, name: "State=Hover, Size=Large", size: box(160, 48), transform: at(100, 0),
      componentPropDefs: [alias(LABEL_PROP), alias(ICON_PROP)] },
    ...refs(g(1, 15), g(1, 16)).map((n, k) => ({ ...n, parentIndex: under(LARGE, "ab"[k]) })),

    { guid: STAR, parentIndex: under(INTERNAL, "b"), type: T.SYMBOL, name: "Icon/Star", size: box(10, 10), transform: at(0, 100) },
    { guid: STAR_V, parentIndex: under(STAR, "a"), type: T.VECTOR, name: "Star", size: box(10, 10), transform: at(0, 0),
      fillPaints: [solid(255, 200, 0)],
      fillGeometry: [{ windingRule: E.WindingRule.NONZERO, blobIndex: 0 }],
      strokeGeometry: [{ windingRule: E.WindingRule.NONZERO, blobIndex: 1 }],
      vectorData: { vectorNetworkBlob: 2, normalizedSize: box(10, 10) } },
    { guid: HEART, parentIndex: under(INTERNAL, "c"), type: T.SYMBOL, name: "Icon/Heart", size: box(8, 8), transform: at(20, 100) },
    { guid: HEART_V, parentIndex: under(HEART, "a"), type: T.VECTOR, name: "Heart", size: box(8, 8), transform: at(0, 0),
      fillGeometry: [{ windingRule: E.WindingRule.ODD, blobIndex: 3 }] },

    { guid: CARD, parentIndex: under(INTERNAL, "d"), type: T.SYMBOL, name: "Card", size: box(200, 40), transform: at(0, 200) },
    { guid: CARD_BG, parentIndex: under(CARD, "a"), type: T.RECTANGLE, name: "Background", size: box(200, 40), transform: at(0, 0),
      fillPaints: [solid(240, 240, 240)] },
    { guid: LEAD, parentIndex: under(CARD, "b"), type: T.INSTANCE, name: "Leading icon", size: box(10, 10), transform: at(8, 15),
      symbolData: { symbolID: STAR },
      derivedSymbolData: [{ guidPath: path(STAR_V), size: box(10, 10), transform: at(0, 0) }] },
    { guid: TRAIL, parentIndex: under(CARD, "c"), type: T.INSTANCE, name: "Trailing icon", size: box(10, 10), transform: at(182, 15),
      symbolData: { symbolID: STAR },
      derivedSymbolData: [{ guidPath: path(STAR_V), size: box(10, 10), transform: at(0, 0) }] },

    // A copy of a library component: identity is (publishFile, publishID), never the name.
    { guid: BADGE, parentIndex: under(INTERNAL, "e"), type: T.SYMBOL, name: "Badge", size: box(64, 24), transform: at(0, 300),
      publishFile: "fixturelibraryfilekey00", publishID: g(50, 7),
      componentKey: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", sharedSymbolVersion: "fixture-version-3" },
    { guid: BADGE_TEXT, parentIndex: under(BADGE, "a"), type: T.TEXT, name: "Текст ✓", size: box(40, 16), transform: at(12, 4),
      overrideKey: g(50, 8) },

    { guid: STYLE, parentIndex: under(INTERNAL, "f"), type: T.RECTANGLE, name: "Brand/Primary", size: box(10, 10), transform: at(0, 400),
      styleType: E.StyleType.FILL, styleID: "fixture-style-1",
      sharedStyleMasterData: { styleKey: "fixture-style-key-1", sortPosition: "a", fileKey: "fixtureownfilekey000000" },
      fillPaints: [solid(0, 85, 255)] },
  ];

  const blobs = [
    // 0: the star's fill, every opcode once: M, L, C, Z.
    encodePath([[1, 0, 0], [2, 10, 0], [4, 10, 5.5, 5, 10, 0, 10], [0]]),
    // 1: its stroke.
    encodePath([[1, 0, 0], [2, 10, 10]]),
    // 2: its vector network: a triangle, one region, a corner radius style on one vertex.
    encodeVectorNetwork({
      vertices: [{ styleID: 0, x: 0, y: 0 }, { styleID: 1, x: 10, y: 0 }, { styleID: 0, x: 0, y: 10 }],
      segments: [
        { styleID: 0, start: 0, ts: [0, 0], end: 1, te: [0, 0] },
        { styleID: 0, start: 1, ts: [0, 2.5], end: 2, te: [2.5, 0] },
        { styleID: 0, start: 2, ts: [0, 0], end: 0, te: [0, 0] },
      ],
      regions: [{ styleID: 0, windingRule: 0, loops: [[0, 1, 2]] }],
    }),
    // 3: the heart's fill.
    encodePath([[1, 1, 1], [2, 9, 1], [2, 5, 9], [0]]),
  ];

  return {
    pixsoNodes: nodes,
    blobs: blobs.map((bytes) => ({ bytes })),
    fixtureInfo: {
      label: "synthetic fixture", flags: 0xa5, delta: -12345,
      signedBig: -(2n ** 62n), unsignedBig: 2n ** 64n - 1n, scale: 0.25, ready: true,
    },
  };
}

export const VARIANTS = ["valid", "truncated", "unknown-field", "trailing-bytes"];

// Build the .pix. Every variant but "valid" is damaged in exactly one way, inside an archive and a
// zstd frame that are themselves sound, so the Kiwi layer is what has to notice:
//   truncated       the message is cut after 60 % of its bytes;
//   unknown-field   one node carries a field (id 99) that the schema stored in the file lacks;
//   trailing-bytes  two bytes follow the end of the message.
export function makeFixture(variant = "valid") {
  if (!VARIANTS.includes(variant)) throw new Error("no fixture variant " + variant + "; one of " + VARIANTS.join(", "));
  const defs = parseKiwiText(FIXTURE_SCHEMA);
  const value = fixtureMessage(defs);
  let writeDefs = defs;
  if (variant === "unknown-field") {
    writeDefs = defs.map((d) => (d.name !== "PixsoNode" ? d : { ...d, fields: [...d.fields, { name: "fixtureOnly", type: -6, isArray: false, value: 99 }] }));
    const widget = value.pixsoNodes.find((n) => n.name === "Unsupported widget");
    widget.fixtureOnly = "not in the schema stored in the file";
  }
  let message = encodeMessage(writeDefs, "PixsoMsg", value);
  if (variant === "truncated") message = message.subarray(0, Math.floor(message.length * 0.6));
  if (variant === "trailing-bytes") message = Buffer.concat([message, Buffer.from([0x00, 0x2a])]);

  const schema = encodeSchema(defs);
  const image = fixtureImage();
  const pix = writePix({
    schema,
    document: writeDocument(message),
    docName: FIXTURE_DOC_NAME,
    images: [{ name: image.hash.toString("hex") + ".png", data: image.png }],
  });
  return { pix, defs, schema, value, message, image, missingHash: MISSING_IMAGE_HASH };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const vi = argv.indexOf("--variant");
  const variant = vi >= 0 ? argv.splice(vi, 2)[1] : "valid";
  if (!argv[0]) { console.error("usage: node tools/pix/fixture.mjs <out.pix> [--variant " + VARIANTS.join("|") + "]"); process.exit(1); }
  const { pix } = makeFixture(variant);
  writeFileSync(argv[0], pix);
  console.log("wrote " + argv[0] + " (" + variant + ", " + pix.length + " bytes)");
}

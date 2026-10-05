// A synthetic .pix, made in memory from definitions written here. Nothing in it comes from a real
// design file: the names, the keys, the pictures and the geometry are all made up, so it can live in
// a public repository and run on any machine (§8 of docs/REWRITE.md).
//
//   import { makeFixture } from "./pix/fixture.mjs";
//   const { pix } = makeFixture();                       // a valid .pix, as a Buffer
//   makeFixture("truncated" | "unknown-field" | "trailing-bytes" | "renumbered")
//   makeFixture("valid", { mutate(value, defs) { … } })  // the document changed before it is encoded
//
//   node tools/pix/fixture.mjs <out.pix> [--variant <name>]    writes one to disk
//
// The document holds one of each case the reader and the plan have to handle, listed at
// fixtureMessage() below. Image hashes are computed at run time, never written here.
import { createHash } from "node:crypto";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodePNG } from "../pngutil.mjs";
import { parseKiwiText, encodeSchema, encodeMessage, writeDocument, writePix } from "./write.mjs";
import { encodeVectorNetwork } from "./network.mjs";

// FORMAT METADATA, NO DESIGN CONTENT. The subset of Pixso's own Kiwi schema that the .pix → IR reader
// reads (docs/M1.md §6 A), with Pixso's message and field names, field ids and enum numbering, so the
// fixture exercises the reader on the layout real files have. Only the fields and enum members the
// reader or the tests use are kept; the reader takes the schema from the file it reads, so a subset is
// a valid schema. FixtureInfo (id 100 of PixsoMsg) is the fixture's own, to round-trip every builtin
// type. The "renumbered" variant renumbers every enum, to prove that the reader resolves enum values
// by name through the file's schema and never by number (docs/M1.md §6 A, "Rules").
export const FIXTURE_SCHEMA = `
enum NodeType {
  NONE = 1; DOCUMENT = 2; CANVAS = 3; GROUP = 4; FRAME = 5; BOOLEAN_OPERATION = 6; VECTOR = 7; STAR = 8; LINE = 9;
  ELLIPSE = 10; RECTANGLE = 11; REGULAR_POLYGON = 12; ROUNDED_RECTANGLE = 13; TEXT = 14; SLICE = 15; SYMBOL = 16;
  INSTANCE = 17; CONNECTLINE = 18; DIRECTORY = 19; SECTION = 104; PATH_TEXT = 151; RADIAL_PATTERN = 152;
  VARIABLE = 153; VARIABLE_SET = 154; TRANSFORM = 155;
}
enum BooleanOperation { UNION = 1; INTERSECT = 2; SUBTRACT = 3; XOR = 4; }
enum BlendMode { PASS_THROUGH = 1; NORMAL = 2; DARKEN = 3; MULTIPLY = 4; SCREEN = 8; OVERLAY = 11; }
enum EffectType { INNER_SHADOW = 1; DROP_SHADOW = 2; FOREGROUND_BLUR = 3; BACKGROUND_BLUR = 4; MOTION_BLUR = 5; }
enum StackAlignItemMode { MIN = 1; CENTER = 2; MAX = 3; SPACE_EVENLY = 4; }
enum StackSize { FIXED = 1; RESIZE_TO_FIT = 2; }
enum StackMode { NONE = 1; HORIZONTAL = 2; VERTICAL = 3; GRID = 4; }
enum StrokeAlign { CENTER = 1; INSIDE = 2; OUTSIDE = 3; }
enum StrokeCap { NONE = 1; ROUND = 2; SQUARE = 3; ARROW_LINES = 4; ARROW_EQUILATERAL = 5; TRIANGLE_FILLED = 6;
  DIAMOND_FILLED = 7; HOLLOW_ROUND = 8; SOLID_ROUND = 9; VERTICAL_LINE = 10; }
enum StrokeJoin { MITER = 1; BEVEL = 2; ROUND = 3; }
enum StyleType { NONE = 1; FILL = 2; STROKE = 3; TEXT = 4; EFFECT = 5; EXPORT = 6; GRID = 7; }
enum TextAlignHorizontal { LEFT = 1; CENTER = 2; RIGHT = 3; JUSTIFIED = 4; }
enum TextAlignVertical { TOP = 1; CENTER = 2; BOTTOM = 3; }
enum TextAutoResize { NONE = 1; WIDTH_AND_HEIGHT = 2; HEIGHT = 3; }
enum TextCase { ORIGINAL = 1; UPPER = 2; LOWER = 3; TITLE = 4; SMALL_CAPS = 5; SMALL_CAPS_FORCED = 6; }
enum TextDecoration { NONE = 1; UNDERLINE = 2; STRIKETHROUGH = 3; }
enum ConstraintType { MIN = 1; CENTER = 2; MAX = 3; STRETCH = 4; SCALE = 5; FIXED_MIN = 6; FIXED_MAX = 7; }
enum NumberUnits { RAW = 1; PIXELS = 2; PERCENT = 3; }
enum ScrollDirection { NONE = 1; HORIZONTAL = 2; VERTICAL = 3; BOTH = 4; }
enum PaintType { SOLID = 1; GRADIENT_LINEAR = 2; GRADIENT_RADIAL = 3; GRADIENT_ANGULAR = 4; GRADIENT_DIAMOND = 5; IMAGE = 6;
  EMOJI = 7; GIF = 8; VIDEO = 9; PATTERN = 10; }
enum ImageScaleMode { STRETCH = 1; FIT = 2; FILL = 3; TILE = 4; }
enum WindingRule { NONZERO = 1; ODD = 2; INVERSE_NONZERO = 3; INVERSE_ODD = 4; }
enum VectorMirror { NONE = 1; ANGLE = 2; ANGLE_AND_LENGTH = 3; RIGHT_ANGLE = 4; }
enum TextListStyle { PLAIN = 0; ORDERED_LIST = 1; UNORDERED_LIST = 2; }
enum TextTruncation { DISABLED = 0; ENDING = 1; }
enum MaskType { ALPHA = 0; OUTLINE = 1; LUMINANCE = 2; }
enum LeadingTrim { NONE = 0; CAP_HEIGHT = 1; }
enum WrapMode { NO_WRAP = 0; WRAP = 1; }
enum StackAlign { AUTO = 0; SPACE_BETWEEN = 1; }
enum ComponentPropType { BOOL = 0; TEXT = 1; COLOR = 2; INSTANCE_SWAP = 3; }
enum ComponentPropNodeField { VISIBLE = 0; TEXT_DATA = 1; OVERRIDDEN_SYMBOL_ID = 2; INHERIT_FILL_STYLE_ID = 3; }
enum ImageType { PNG = 1; JPEG = 2; SVG = 3; PDF = 4; SKETCH = 5; EPS = 6; TIFF = 7; WEBP = 8; }
enum ExportConstraintType { CONTENT_SCALE = 1; CONTENT_WIDTH = 2; CONTENT_HEIGHT = 3; }

struct GUID { uint sessionID; uint localID; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct Color { float r; float g; float b; float a; }

message ParentIndex { GUID guid = 1; string position = 2; }
message GUIDPath { GUID[] guids = 1; }
message ImageMessage { byte[] hash = 1; string name = 2; }
message PaintFilterMessage { float tint = 1; float shadows = 2; float highlights = 3; float exposure = 4;
  float temperature = 5; float vibrance = 6; float contrast = 7; float hue = 8; }
message ColorStop { Color color = 1; float position = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; BlendMode blendMode = 5;
  ColorStop[] stops = 6; Matrix transform = 7; ImageMessage image = 8; ImageScaleMode imageScaleMode = 12;
  float rotation = 13; float scale = 14; PaintFilterMessage paintFilter = 15; }
message Path { int blobIndex = 1; WindingRule windingRule = 2; }
message VectorStyleData { int styleID = 1; float cornerRadius = 2; StrokeCap strokeCap = 3; StrokeJoin strokeJoin = 4;
  VectorMirror handleMirroring = 5; }
message VectorData { int vectorNetworkBlob = 1; Vector normalizedSize = 2; VectorStyleData[] styleOverrideTable = 3; }
message ArcData { float startingAngle = 1; float endingAngle = 2; float innerRadius = 3; }
message Effect { EffectType type = 1; Color color = 2; Vector offset = 3; float radius = 4; bool visible = 5;
  BlendMode blendMode = 6; float spread = 7; bool showShadowBehindNode = 8; }
message SymbolData { GUID symbolID = 1; PixsoNode[] symbolOverrides = 2; }
message ExportConstraint { ExportConstraintType type = 1; float value = 2; }
message ExportSettings { string suffix = 1; ImageType imageType = 2; ExportConstraint constraint = 3; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message Number { float value = 1; NumberUnits units = 2; }
message Hyperlink { string url = 1; GUID guid = 2; }
message TextStyleData { int styleID = 1; float fontSize = 2; float paragraphIndent = 3; float paragraphSpacing = 4;
  Number letterSpacing = 5; Number lineHeight = 6; TextCase textCase = 7; TextDecoration textDecoration = 8;
  FontName fontName = 12; Hyperlink hyperlink = 13; Paint[] fillPaints = 14; }
message Baseline { Vector position = 1; float width = 2; float lineY = 3; float lineHeight = 4; float lineAscent = 5;
  int firstCharacter = 6; int endCharacter = 7; }
message Glyph { int blobIndex = 1; Vector position = 2; int styleID = 3; float fontSize = 4; int firstCharacter = 5;
  float advance = 6; }
message ParagraphStyle { TextListStyle listType = 1; uint indentationLevel = 2; }
message TextData { string characters = 1; int[] characterStyleIDs = 2; TextStyleData[] styleOverrideTable = 3;
  Vector layoutSize = 4; Baseline[] baselines = 5; Glyph[] glyphs = 6; ParagraphStyle[] paragraphStyle = 12; }
message PropValueData { string property = 1; string[] values = 2; }
message ComponentPropValue { TextData textValue = 1; GUID guidValue = 2; bool boolValue = 3; }
message ComponentPropDef { GUID id = 1; string name = 2; ComponentPropValue initialValue = 3; ComponentPropType type = 6; }
message ComponentPropRef { GUID defID = 1; ComponentPropNodeField componentPropNodeField = 3; }
message ComponentPropAssignment { GUID defID = 1; ComponentPropValue value = 2; }
message SharedStyleMasterData { string styleKey = 1; string sortPosition = 2; string fileKey = 3; }

message PixsoNode {
  GUID guid = 1;
  GUIDPath guidPath = 2;
  ParentIndex parentIndex = 3;
  Matrix transform = 5;
  NodeType type = 6;
  string name = 7;
  VectorData vectorData = 8;
  bool visible = 10;
  int count = 11;
  Vector size = 12;
  BooleanOperation booleanOperation = 13;
  ArcData arcData = 14;
  BlendMode blendMode = 15;
  float cornerRadius = 16;
  float opacity = 18;
  bool locked = 19;
  Effect[] effects = 20;
  Path[] fillGeometry = 21;
  Paint[] fillPaints = 22;
  float[] dashPattern = 23;
  StackSize stackCounterSizing = 25;
  StackMode stackMode = 29;
  float stackSpacing = 31;
  StrokeAlign strokeAlign = 34;
  StrokeCap strokeCap = 35;
  Path[] strokeGeometry = 36;
  StrokeJoin strokeJoin = 37;
  Paint[] strokePaints = 38;
  float strokeWeight = 39;
  int styleID = 41;
  StyleType styleType = 42;
  SymbolData symbolData = 43;
  bool mask = 46;
  float starInnerScale = 48;
  float miterLimit = 49;
  Color backgroundColor = 50;
  ExportSettings[] exportSettings = 56;
  FontName fontName = 58;
  float fontSize = 59;
  TextAlignHorizontal textAlignHorizontal = 63;
  TextAutoResize textAutoResize = 65;
  TextData textData = 67;
  Number letterSpacing = 71;
  Number lineHeight = 72;
  ConstraintType horizontalConstraint = 73;
  ConstraintType verticalConstraint = 74;
  PixsoNode[] derivedSymbolData = 75;
  string componentKey = 77;
  GUID inheritEffectStyleID = 78;
  GUID inheritFillStyleID = 80;
  GUID inheritStrokeStyleID = 84;
  GUID inheritTextStyleID = 85;
  GUID overriddenSymbolID = 88;
  GUID overrideKey = 89;
  ScrollDirection scrollDirection = 112;
  float rectangleBottomLeftCornerRadius = 113;
  float rectangleBottomRightCornerRadius = 114;
  float rectangleTopLeftCornerRadius = 117;
  float rectangleTopRightCornerRadius = 118;
  bool frameMaskDisabled = 119;
  Hyperlink hyperlink = 120;
  SharedStyleMasterData sharedStyleMasterData = 121;
  bool internalOnly = 125;
  string publishFile = 129;
  GUID publishID = 130;
  string sharedSymbolVersion = 133;
  PropValueData[] stateGroupPropertyValueOrders = 136;
  bool isStateGroup = 137;
  float stackPaddingRight = 138;
  float stackPaddingLeft = 139;
  float stackPaddingTop = 140;
  float stackPaddingBottom = 141;
  StackSize stackPrimarySizing = 142;
  StackSize stackChildPrimarySizing = 143;
  StackSize stackChildCounterSizing = 144;
  StackAlignItemMode stackPrimaryAlignItems = 145;
  StackAlignItemMode stackCounterAlignItems = 146;
  StrokeCap dashCap = 148;
  float borderTopWeight = 154;
  float borderBottomWeight = 155;
  float borderLeftWeight = 156;
  float borderRightWeight = 157;
  Path[] strokePaddingPath = 162;
  bool autoLayoutAbsolutePos = 163;
  bool autoLayoutItemReverseDraw = 164;
  TextTruncation textTruncation = 170;
  MaskType maskType = 171;
  LeadingTrim leadingTrim = 172;
  int maxLines = 181;
  float stackCounterSpacing = 184;
  StackAlign stackCounterAlignContent = 185;
  WrapMode stackWrap = 186;
  Vector minSize = 187;
  Vector maxSize = 188;
  ComponentPropDef[] componentPropDef = 189;
  ComponentPropRef[] componentPropRef = 190;
  ComponentPropAssignment[] componentPropAssignment = 191;
}

message Blob { byte[] bytes = 1; }

// The fixture's own: exists only so that every builtin type is round-tripped at least once.
message FixtureInfo { string label = 1; byte flags = 2; int delta = 3; int64 signedBig = 4; uint64 unsignedBig = 5; float scale = 6; bool ready = 7; }

message PixsoMsg { PixsoNode[] pixsoNodes = 3; Blob[] blobs = 4; FixtureInfo fixtureInfo = 100; }
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
// Rectangles as closed subpaths, clockwise; a ring is an outer rectangle and an inner one wound the
// other way, so the nonzero rule leaves the hole empty.
const rectCmds = (x0, y0, x1, y1) => [[1, x0, y0], [2, x1, y0], [2, x1, y1], [2, x0, y1], [0]];
const rectCmdsCCW = (x0, y0, x1, y1) => [[1, x0, y0], [2, x0, y1], [2, x1, y1], [2, x1, y0], [0]];

// The vector network layout of real files (tools/pix/network.mjs), re-exported for the tests.
export { encodeVectorNetwork };

// A 2x2 picture of four made-up colours, and its hash — the name the archive files it under.
export function fixtureImage() {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
  const png = encodePNG(2, 2, rgba);
  return { png, hash: createHash("sha1").update(png).digest() };
}
// A JPEG stored under a ".png" name, as some real archives hold them: only its header matters (the
// reader sniffs the format and checks the SHA-1; it decodes nothing).
export function fixtureJpeg() {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\u0000synthetic fixture bytes", "latin1"), Buffer.from([0xff, 0xd9])]);
  return { jpg, hash: createHash("sha1").update(jpg).digest() };
}
// An archive entry filed under a name that is not its SHA-1 (IMAGE_HASH_MISMATCH).
export function fixtureMismatch() {
  const bytes = encodePNG(1, 1, Buffer.from([10, 20, 30, 255]));
  return { bytes, name: createHash("sha1").update("fixture: a name that is not this entry's SHA-1").digest() };
}
// The hash of an image the archive does not hold.
export const MISSING_IMAGE_HASH = createHash("sha1").update("fixture: an image that is not in the archive").digest();

// The expected decode of the path blob, in tools/kiwi.mjs pathToSVG() form.
export const STAR_FILL_SVG = "M0,0 L10,0 C10,5.5 5,10 0,10 Z";

// The guids of the fixture's M1 cases, for the tests (docs/M1.md §6 A, "Tests").
export const IDS = {
  directory: "0:3", casesPage: "0:4",
  sides: "3:1", indep: "3:2", partial: "3:3", ring: "3:4", planted: "3:5", dashed: "3:6", noPath: "3:7",
  cornersFields: "3:8", cornerRadiusOnly: "3:9", cornersEqual: "3:10", absolute: "3:13",
  evenlyOne: "3:20", evenlyOneA: "3:21", evenlyOneB: "3:22", evenlyTwo: "3:23", evenlyTwoA: "3:24", evenlyTwoB: "3:25",
  text: "3:30", textNoLines: "3:31", textFromStyle: "3:32", textStyle: "3:33",
  effects: "3:40",
  boolA: "3:50", boolARect1: "3:51", boolARect2: "3:52", boolNested: "3:53", boolNestedA: "3:54", boolNestedB: "3:55",
  boolXor: "3:56", boolXorRect: "3:57", boolXorEllipse: "3:58",
  boolB: "3:60", boolBLine1: "3:61", boolBLine2: "3:62", boolBInner: "3:63", boolBInnerA: "3:64", boolBInnerB: "3:65",
  boolEmpty: "3:66",
  vNet: "3:70", vLoop: "3:71", vNoFill: "3:72", vWinding: "3:73", vBounds: "3:74", vOpen: "3:75", vRight: "3:76",
  nanGroup: "3:77", nanVector: "3:78", nanBad: "3:79", connect: "3:80", lineHeight: "3:81", section: "3:82",
  maskGroup: "3:83", maskShape: "3:84", maskContent: "3:85", jpegRect: "3:86", mismatchRect: "3:87",
  unsupported: "1:68", star: "1:21", heart: "1:23", badgeText: "1:41", label: "1:12",
};
const G = (s) => { const [a, b] = s.split(":").map(Number); return g(a, b); };

// The document, as the object the decoder must give back. Every float is exact in 32 bits (or NaN),
// so the round trip can be compared with plain equality. It holds:
//   - a user page with a background colour, an internalOnly canvas, and a DIRECTORY holding a second
//     user page with the M1 cases; no DOCUMENT node, as no real file stores one;
//   - a state group whose variant names list their axes in different orders, with root property
//     definitions on the set and variant-local aliases (same id, unnamed BOOL) on every variant;
//   - a component (Card) with two nested instances, and an instance of it whose override swaps one
//     of them (overriddenSymbolID), one live override, and one stale override whose guidPath is in
//     no derivedSymbolData entry;
//   - a library copy carrying publishFile, publishID, componentKey, sharedSymbolVersion, and
//     overrideKey on its layer;
//   - style definitions (no transform), a node bound to one, and a node whose style reference
//     resolves nowhere, plus the two "no style" values (0:0 and all ones);
//   - image paints: a PNG in the archive, one missing, a JPEG under a .png name, and an entry whose
//     SHA-1 is not its name;
//   - a vector with path blobs (opcodes 0, 1, 2, 4) and a vector-network blob in the real layout;
//   - a node type the IR has no type for (RADIAL_PATTERN);
//   - user-page children stored out of order, positions "B" and "a" among them, so sibling order
//     must come from plain string comparison of the positions — not from file order, not from a
//     locale-aware compare (which would put "a" first);
//   - the M1 cases (IDS): independent, partial, four-by-weight, planted-disagreement, dashed and
//     path-less borders with stroke-area paths; corner fields; auto layout with grow, stretch and an
//     absolute child; SPACE_EVENLY with one and with two visible flow children; text with an astral
//     character, style ranges, a list paragraph, a hyperlink, baselines and glyphs, a text without
//     baselines and one whose font comes from its text style; effects; booleans of both classes, a
//     nested one and an empty one; networks (per-vertex radius, a region-less loop, a region with no
//     fill geometry, a winding and a bounds disagreement, an open region under no fill, RIGHT_ANGLE);
//     a NaN size with geometry, a group taking its box from that child, and a NaN path; a
//     CONNECTLINE; a LINE with height; a SECTION with a stroke; a group mask.
export function fixtureMessage(defs) {
  const E = enumsOf(defs);
  const T = E.NodeType;
  const solid = (r, gg, b, a = 255) => ({ type: E.PaintType.SOLID, color: { r, g: gg, b, a }, opacity: a / 255, visible: true });
  const { hash: imageHash } = fixtureImage();
  const { hash: jpegHash } = fixtureJpeg();
  const { name: mismatchName } = fixtureMismatch();
  const geom = (blobIndex, rule = "NONZERO") => [{ blobIndex, windingRule: E.WindingRule[rule] }];

  const PAGE = g(0, 1), INTERNAL = g(0, 2), DOC = g(0, 0), DIR = G(IDS.directory), CASES = G(IDS.casesPage);
  const SET = g(1, 10), SMALL = g(1, 11), LARGE = g(1, 14);
  const STAR = g(1, 20), STAR_V = g(1, 21), HEART = g(1, 22), HEART_V = g(1, 23);
  const CARD = g(1, 30), CARD_BG = g(1, 31), LEAD = g(1, 32), TRAIL = g(1, 33);
  const BADGE = g(1, 40), BADGE_TEXT = g(1, 41), STYLE = g(1, 50), STYLED = g(1, 63);
  const LABEL_PROP = g(1, 900), ICON_PROP = g(1, 901);
  // Newer Pixso writes a variant-local alias for every property: the set's id, unnamed, BOOL.
  const alias = (id) => ({ id, name: "", type: E.ComponentPropType.BOOL });
  const refs = (label, icon) => [
    { guid: label, type: T.TEXT, name: "Label", size: box(40, 16), transform: at(4, 4), fontName: { family: "Inter", style: "Regular", postscript: "" }, componentPropRef: [{ defID: LABEL_PROP, componentPropNodeField: E.ComponentPropNodeField.TEXT_DATA }] },
    { guid: icon, type: T.RECTANGLE, name: "Icon", size: box(8, 8), transform: at(60, 4), componentPropRef: [{ defID: ICON_PROP, componentPropNodeField: E.ComponentPropNodeField.VISIBLE }] },
  ];
  const textValue = (characters) => ({ textValue: { characters } });

  // Blob indices, in the order of `blobs` below.
  const B = {
    starFill: 0, starStroke: 1, starNet: 2, heartFill: 3,
    indepPad: 4, partialPad: 5, ringPad: 6, plantedPad: 7, dashedPad: 8, glyph: 9,
    rect10: 10, rect10b: 11, ellipse10: 12, boolAResult: 13, lineStroke: 14, boolBResult: 15,
    netSquare: 16, netSquareFill: 17, netLoop: 18, netLoopFill: 19, netNoFill: 20, netWinding: 21, netBounds: 22, netBoundsFill: 23,
    netOpen: 24, netOpenFill: 25, netRight: 26, nanFill: 27, nanPath: 28, connectNet: 29, connectStroke: 30,
  };

  const C = (s) => G(IDS[s]);
  const stroke = (w) => ({ strokePaints: [solid(20, 20, 20)], strokeWeight: w });
  const cases = [
    // ---- side strokes and corners, in an auto-layout frame ----
    { guid: C("sides"), parentIndex: under(CASES, "a"), type: T.FRAME, name: "Sides", size: box(400, 60), transform: at(0, 0),
      stackMode: E.StackMode.HORIZONTAL, stackSpacing: 8, stackPaddingLeft: 4, stackPaddingRight: 4, stackPaddingTop: 2, stackPaddingBottom: 2,
      stackPrimarySizing: E.StackSize.FIXED, stackCounterSizing: E.StackSize.RESIZE_TO_FIT, stackCounterAlignItems: E.StackAlignItemMode.CENTER,
      autoLayoutItemReverseDraw: true, frameMaskDisabled: true, fillPaints: [solid(255, 255, 255)], scrollDirection: E.ScrollDirection.VERTICAL },
    { guid: C("indep"), parentIndex: under(C("sides"), "a"), type: T.RECTANGLE, name: "Independent sides", size: box(40, 20), transform: at(4, 2),
      ...stroke(2), strokeAlign: E.StrokeAlign.INSIDE, borderTopWeight: 0, borderRightWeight: 2, borderBottomWeight: 4, borderLeftWeight: 0,
      strokePaddingPath: geom(B.indepPad) },
    { guid: C("partial"), parentIndex: under(C("sides"), "b"), type: T.RECTANGLE, name: "Partial sides", size: box(40, 20), transform: at(52, 2),
      ...stroke(1), strokeAlign: E.StrokeAlign.INSIDE, borderBottomWeight: 3, strokePaddingPath: geom(B.partialPad) },
    { guid: C("ring"), parentIndex: under(C("sides"), "c"), type: T.RECTANGLE, name: "Four sides by weight", size: box(40, 20), transform: at(100, 2),
      ...stroke(1), strokeAlign: E.StrokeAlign.INSIDE, strokePaddingPath: geom(B.ringPad), miterLimit: Math.fround(11.4783) },
    { guid: C("planted"), parentIndex: under(C("sides"), "d"), type: T.RECTANGLE, name: "Planted disagreement", size: box(40, 20), transform: at(148, 2),
      ...stroke(2), strokeAlign: E.StrokeAlign.INSIDE, borderTopWeight: 2, borderRightWeight: 2, borderBottomWeight: 2, borderLeftWeight: 2,
      strokePaddingPath: geom(B.plantedPad) },
    { guid: C("dashed"), parentIndex: under(C("sides"), "e"), type: T.RECTANGLE, name: "Dashed border", size: box(40, 20), transform: at(196, 2),
      ...stroke(1), strokeAlign: E.StrokeAlign.INSIDE, dashPattern: [4, 2], dashCap: E.StrokeCap.ROUND, strokePaddingPath: geom(B.dashedPad) },
    { guid: C("noPath"), parentIndex: under(C("sides"), "f"), type: T.FRAME, name: "No stroke-area path", size: box(40, 20), transform: at(244, 2),
      ...stroke(1), strokeAlign: E.StrokeAlign.CENTER },
    { guid: C("cornersFields"), parentIndex: under(C("sides"), "g"), type: T.RECTANGLE, name: "Corner fields", size: box(20, 20), transform: at(292, 2),
      fillPaints: [solid(200, 0, 0)], cornerRadius: 4, rectangleTopLeftCornerRadius: 4, rectangleBottomRightCornerRadius: 8 },
    { guid: C("cornerRadiusOnly"), parentIndex: under(C("sides"), "h"), type: T.RECTANGLE, name: "Corner radius only", size: box(20, 20), transform: at(320, 2),
      fillPaints: [solid(0, 200, 0)], cornerRadius: 6, stackChildPrimarySizing: E.StackSize.RESIZE_TO_FIT },
    { guid: C("cornersEqual"), parentIndex: under(C("sides"), "i"), type: T.RECTANGLE, name: "Equal corner fields", size: box(20, 56), transform: at(348, 2),
      fillPaints: [solid(0, 0, 200)], rectangleTopLeftCornerRadius: 5, rectangleTopRightCornerRadius: 5, rectangleBottomRightCornerRadius: 5,
      rectangleBottomLeftCornerRadius: 5, stackChildCounterSizing: E.StackSize.RESIZE_TO_FIT },
    { guid: C("absolute"), parentIndex: under(C("sides"), "j"), type: T.ELLIPSE, name: "Absolute", size: box(10, 10), transform: at(380, 40),
      fillPaints: [solid(9, 9, 9)], autoLayoutAbsolutePos: true, horizontalConstraint: E.ConstraintType.FIXED_MAX, verticalConstraint: E.ConstraintType.SCALE,
      arcData: { startingAngle: 0, endingAngle: 3.1415927410125732, innerRadius: 0.5 } },

    // ---- SPACE_EVENLY with one and with two visible flow children ----
    { guid: C("evenlyOne"), parentIndex: under(CASES, "b"), type: T.FRAME, name: "Evenly, one visible", size: box(100, 20), transform: at(0, 80),
      stackMode: E.StackMode.HORIZONTAL, stackPrimaryAlignItems: E.StackAlignItemMode.SPACE_EVENLY, stackWrap: E.WrapMode.NO_WRAP },
    { guid: C("evenlyOneA"), parentIndex: under(C("evenlyOne"), "a"), type: T.RECTANGLE, name: "Shown", size: box(10, 10), transform: at(45, 5) },
    { guid: C("evenlyOneB"), parentIndex: under(C("evenlyOne"), "b"), type: T.RECTANGLE, name: "Hidden", size: box(10, 10), transform: at(0, 5), visible: false },
    { guid: C("evenlyTwo"), parentIndex: under(CASES, "c"), type: T.FRAME, name: "Evenly, two visible", size: box(100, 20), transform: at(120, 80),
      stackMode: E.StackMode.VERTICAL, stackPrimaryAlignItems: E.StackAlignItemMode.SPACE_EVENLY, stackWrap: E.WrapMode.WRAP, stackCounterSpacing: 4,
      stackCounterAlignContent: E.StackAlign.SPACE_BETWEEN, minSize: box(50, NaN), maxSize: box(3.4028234663852886e38, 300) },
    { guid: C("evenlyTwoA"), parentIndex: under(C("evenlyTwo"), "a"), type: T.RECTANGLE, name: "First", size: box(10, 10), transform: at(0, 0) },
    { guid: C("evenlyTwoB"), parentIndex: under(C("evenlyTwo"), "b"), type: T.RECTANGLE, name: "Second", size: box(10, 10), transform: at(0, 10) },

    // ---- text ----
    // "Hi 😀 there\nsecond": 17 code points, 18 UTF-16 units; the astral character is code point 3,
    // units 3-4. Style 1 covers code points 3-6 ("😀 th": units 3-8), style 2 the second paragraph
    // ("second": units 12-18), which is an unordered list item.
    { guid: C("text"), parentIndex: under(CASES, "d"), type: T.TEXT, name: "Styled text", size: box(120, 40), transform: at(0, 120),
      fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 14, fillPaints: [solid(0, 0, 0)],
      letterSpacing: { value: 0.0625, units: E.NumberUnits.PERCENT }, lineHeight: { value: 1.25, units: E.NumberUnits.PERCENT },
      textAutoResize: E.TextAutoResize.HEIGHT, textAlignHorizontal: E.TextAlignHorizontal.CENTER,
      textData: {
        characters: "Hi \u{1F600} there\nsecond",
        characterStyleIDs: [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2],
        styleOverrideTable: [
          { styleID: 1, fontSize: 20, fillPaints: [solid(255, 0, 0)] },
          { styleID: 2, fontName: { family: "Inter", style: "Bold", postscript: "" }, hyperlink: { url: "https://example.invalid/" } },
        ],
        layoutSize: box(120, 40),
        baselines: [
          { position: box(0, 14), width: 80, lineY: 0, lineHeight: 20, lineAscent: 14, firstCharacter: 0, endCharacter: 12 },
          { position: box(0, 34), width: 50, lineY: 20, lineHeight: 20, lineAscent: 14, firstCharacter: 12, endCharacter: 18 },
        ],
        glyphs: [{ blobIndex: B.glyph, position: box(0, 14), styleID: 0, fontSize: 14, firstCharacter: 0, advance: 8 }],
        paragraphStyle: [{ listType: E.TextListStyle.PLAIN }, { listType: E.TextListStyle.UNORDERED_LIST, indentationLevel: 1 }],
      } },
    { guid: C("textNoLines"), parentIndex: under(CASES, "e"), type: T.TEXT, name: "No baselines", size: box(60, 16), transform: at(140, 120),
      fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 12, textData: { characters: "plain" },
      lineHeight: { value: 0, units: E.NumberUnits.PERCENT }, textTruncation: E.TextTruncation.ENDING, maxLines: 2 },
    { guid: C("textFromStyle"), parentIndex: under(CASES, "f"), type: T.TEXT, name: "Font from its style", size: box(60, 16), transform: at(220, 120),
      inheritTextStyleID: C("textStyle"), lineHeight: { value: 1, units: E.NumberUnits.RAW },
      textData: { characters: "styled", baselines: [{ position: box(0, 12), width: 40, firstCharacter: 0, endCharacter: 6 }] } },

    // ---- effects, a gradient, export settings ----
    { guid: C("effects"), parentIndex: under(CASES, "g"), type: T.RECTANGLE, name: "Effects", size: box(40, 40), transform: at(0, 180),
      fillPaints: [{ type: E.PaintType.GRADIENT_LINEAR, stops: [{ color: { r: 255, g: 0, b: 0, a: 255 }, position: 0 }, { color: { r: 0, g: 0, b: 255, a: 128 }, position: 1 }],
        transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 }, opacity: 1, visible: true, blendMode: E.BlendMode.MULTIPLY }],
      effects: [
        { type: E.EffectType.DROP_SHADOW, color: { r: 0, g: 0, b: 0, a: 64 }, offset: box(0, 2), radius: 4, spread: 1, visible: true, blendMode: E.BlendMode.NORMAL },
        { type: E.EffectType.INNER_SHADOW, color: { r: 255, g: 255, b: 255, a: 255 }, offset: box(1, 1), radius: 2, visible: true },
        { type: E.EffectType.FOREGROUND_BLUR, radius: 3, visible: false },
        { type: E.EffectType.MOTION_BLUR, radius: 3, visible: true },
      ],
      exportSettings: [{ suffix: "@2x", imageType: E.ImageType.PNG, constraint: { type: E.ExportConstraintType.CONTENT_SCALE, value: 2 } }, { suffix: "", imageType: E.ImageType.TIFF }],
      opacity: 0.5, blendMode: E.BlendMode.PASS_THROUGH },

    // ---- booleans ----
    // Class A: two filled rectangles and a nested class A boolean, UNION.
    { guid: C("boolA"), parentIndex: under(CASES, "h"), type: T.BOOLEAN_OPERATION, name: "Union of fills", size: box(20, 10), transform: at(60, 180),
      booleanOperation: E.BooleanOperation.UNION, fillPaints: [solid(0, 128, 0)], fillGeometry: geom(B.boolAResult) },
    { guid: C("boolARect1"), parentIndex: under(C("boolA"), "a"), type: T.RECTANGLE, name: "A1", size: box(10, 10), transform: at(0, 0), fillPaints: [solid(1, 1, 1)], fillGeometry: geom(B.rect10) },
    { guid: C("boolARect2"), parentIndex: under(C("boolA"), "b"), type: T.RECTANGLE, name: "A2", size: box(10, 10), transform: at(10, 0), fillPaints: [solid(1, 1, 1)] },
    { guid: C("boolNested"), parentIndex: under(C("boolA"), "c"), type: T.BOOLEAN_OPERATION, name: "Nested", size: box(10, 10), transform: at(5, 0),
      booleanOperation: E.BooleanOperation.INTERSECT, fillPaints: [solid(1, 1, 1)], fillGeometry: geom(B.rect10) },
    { guid: C("boolNestedA"), parentIndex: under(C("boolNested"), "a"), type: T.RECTANGLE, name: "N1", size: box(10, 10), transform: at(0, 0) },
    { guid: C("boolNestedB"), parentIndex: under(C("boolNested"), "b"), type: T.ELLIPSE, name: "N2", size: box(10, 10), transform: at(0, 0) },
    // Class A: XOR of a rectangle and an ellipse.
    { guid: C("boolXor"), parentIndex: under(CASES, "i"), type: T.BOOLEAN_OPERATION, name: "Exclusive", size: box(10, 10), transform: at(100, 180),
      booleanOperation: E.BooleanOperation.XOR, fillPaints: [solid(0, 0, 128)], fillGeometry: geom(B.rect10, "ODD") },
    { guid: C("boolXorRect"), parentIndex: under(C("boolXor"), "a"), type: T.RECTANGLE, name: "X1", size: box(10, 10), transform: at(0, 0) },
    { guid: C("boolXorEllipse"), parentIndex: under(C("boolXor"), "b"), type: T.ELLIPSE, name: "X2", size: box(10, 10), transform: at(0, 0), fillGeometry: geom(B.ellipse10) },
    // Class B: a union of two stroked lines, holding a class A boolean that folds with it.
    { guid: C("boolB"), parentIndex: under(CASES, "j"), type: T.BOOLEAN_OPERATION, name: "Union of strokes", size: box(10, 10), transform: at(120, 180),
      booleanOperation: E.BooleanOperation.UNION, fillPaints: [solid(128, 0, 0)], fillGeometry: geom(B.boolBResult), strokeGeometry: geom(B.boolBResult) },
    { guid: C("boolBLine1"), parentIndex: under(C("boolB"), "a"), type: T.LINE, name: "L1", size: box(10, 0), transform: at(0, 5), ...stroke(1), strokeGeometry: geom(B.lineStroke) },
    { guid: C("boolBLine2"), parentIndex: under(C("boolB"), "b"), type: T.LINE, name: "L2", size: box(10, 0), transform: { m00: 0, m01: -1, m02: 5, m10: 1, m11: 0, m12: 0 }, ...stroke(1), strokeGeometry: geom(B.lineStroke) },
    { guid: C("boolBInner"), parentIndex: under(C("boolB"), "c"), type: T.BOOLEAN_OPERATION, name: "Folded inner", size: box(10, 10), transform: at(0, 0),
      booleanOperation: E.BooleanOperation.SUBTRACT, fillGeometry: geom(B.rect10) },
    { guid: C("boolBInnerA"), parentIndex: under(C("boolBInner"), "a"), type: T.RECTANGLE, name: "F1", size: box(10, 10), transform: at(0, 0) },
    { guid: C("boolBInnerB"), parentIndex: under(C("boolBInner"), "b"), type: T.RECTANGLE, name: "F2", size: box(5, 5), transform: at(0, 0) },
    // No operand and no geometry: not carried.
    { guid: C("boolEmpty"), parentIndex: under(CASES, "k"), type: T.BOOLEAN_OPERATION, name: "Empty", size: box(0, 0), transform: at(140, 180) },

    // ---- vectors ----
    // A real-layout network at half the node's size, with a corner radius on one vertex, one closed region.
    { guid: C("vNet"), parentIndex: under(CASES, "l"), type: T.VECTOR, name: "Network", size: box(20, 20), transform: at(0, 240),
      fillPaints: [solid(10, 10, 10)], fillGeometry: geom(B.netSquareFill), strokeJoin: E.StrokeJoin.ROUND, strokeCap: E.StrokeCap.SOLID_ROUND,
      vectorData: { vectorNetworkBlob: B.netSquare, normalizedSize: box(10, 10),
        styleOverrideTable: [{ styleID: 1, cornerRadius: 2, strokeJoin: E.StrokeJoin.ROUND, handleMirroring: E.VectorMirror.ANGLE }] } },
    // A region-less open loop with stored fill geometry: built from the geometry.
    { guid: C("vLoop"), parentIndex: under(CASES, "m"), type: T.VECTOR, name: "Region-less loop", size: box(10, 10), transform: at(30, 240),
      fillPaints: [solid(10, 10, 10)], ...stroke(1), fillGeometry: geom(B.netLoopFill), strokeGeometry: geom(B.lineStroke),
      vectorData: { vectorNetworkBlob: B.netLoop, normalizedSize: box(10, 10) } },
    // A region and no stored fill geometry.
    { guid: C("vNoFill"), parentIndex: under(CASES, "n"), type: T.VECTOR, name: "Region without fill", size: box(10, 10), transform: at(50, 240),
      vectorData: { vectorNetworkBlob: B.netNoFill, normalizedSize: box(10, 10) } },
    // A region wound NONZERO over a stored path wound ODD (network at 20 over a 10 px node).
    { guid: C("vWinding"), parentIndex: under(CASES, "o"), type: T.VECTOR, name: "Winding", size: box(10, 10), transform: at(70, 240),
      fillPaints: [solid(10, 10, 10)], fillGeometry: geom(B.rect10, "ODD"),
      vectorData: { vectorNetworkBlob: B.netWinding, normalizedSize: box(20, 20) } },
    // A region over 0..10 and a stored path over 0..20.
    { guid: C("vBounds"), parentIndex: under(CASES, "p"), type: T.VECTOR, name: "Bounds", size: box(20, 20), transform: at(90, 240),
      fillPaints: [solid(10, 10, 10)], fillGeometry: geom(B.netBoundsFill), vectorData: { vectorNetworkBlob: B.netBounds, normalizedSize: box(20, 20) } },
    // An open region loop under no visible fill: the loop is dropped, the stroke stays.
    { guid: C("vOpen"), parentIndex: under(CASES, "q"), type: T.VECTOR, name: "Open region", size: box(10, 10), transform: at(120, 240),
      fillPaints: [{ ...solid(10, 10, 10), visible: false }], ...stroke(1), fillGeometry: geom(B.netOpenFill),
      vectorData: { vectorNetworkBlob: B.netOpen, normalizedSize: box(10, 10) } },
    // RIGHT_ANGLE handle mirroring on a vertex.
    { guid: C("vRight"), parentIndex: under(CASES, "r"), type: T.VECTOR, name: "Right angle", size: box(10, 10), transform: at(140, 240),
      ...stroke(1), vectorData: { vectorNetworkBlob: B.netRight, normalizedSize: box(10, 10),
        styleOverrideTable: [{ styleID: 3, handleMirroring: E.VectorMirror.RIGHT_ANGLE }] } },
    // NaN sizes: a group whose box comes from its child, a vector whose box comes from its geometry,
    // and a vector whose geometry is NaN too.
    { guid: C("nanGroup"), parentIndex: under(CASES, "s"), type: T.GROUP, name: "NaN group", size: box(NaN, NaN), transform: at(160, 240) },
    { guid: C("nanVector"), parentIndex: under(C("nanGroup"), "a"), type: T.VECTOR, name: "NaN vector", size: box(NaN, NaN), transform: at(2, 3),
      fillPaints: [solid(10, 10, 10)], fillGeometry: geom(B.nanFill) },
    { guid: C("nanBad"), parentIndex: under(CASES, "t"), type: T.VECTOR, name: "NaN path", size: box(NaN, NaN), transform: at(180, 240),
      fillGeometry: geom(B.nanPath) },
    { guid: C("connect"), parentIndex: under(CASES, "u"), type: T.CONNECTLINE, name: "Connector", size: box(10, 10), transform: at(200, 240),
      ...stroke(2), strokeGeometry: geom(B.connectStroke), vectorData: { vectorNetworkBlob: B.connectNet, normalizedSize: box(10, 10) } },
    { guid: C("lineHeight"), parentIndex: under(CASES, "v"), type: T.LINE, name: "Line with height", size: box(20, 6), transform: at(220, 240), ...stroke(1) },
    { guid: C("section"), parentIndex: under(CASES, "w"), type: T.SECTION, name: "Section", size: box(100, 50), transform: at(0, 300),
      fillPaints: [solid(240, 240, 240)], ...stroke(1), frameMaskDisabled: true },
    // A group whose first child masks the rest.
    { guid: C("maskGroup"), parentIndex: under(CASES, "x"), type: T.GROUP, name: "Masked", size: box(20, 20), transform: at(120, 300) },
    { guid: C("maskShape"), parentIndex: under(C("maskGroup"), "a"), type: T.ELLIPSE, name: "Mask", size: box(20, 20), transform: at(0, 0),
      mask: true, maskType: E.MaskType.OUTLINE, fillPaints: [solid(0, 0, 0)] },
    { guid: C("maskContent"), parentIndex: under(C("maskGroup"), "b"), type: T.RECTANGLE, name: "Masked content", size: box(20, 20), transform: at(0, 0),
      fillPaints: [solid(255, 128, 0)] },
    // Image paints: a JPEG stored under a .png name, and an entry whose SHA-1 is not its name.
    { guid: C("jpegRect"), parentIndex: under(CASES, "y"), type: T.RECTANGLE, name: "JPEG under png", size: box(20, 20), transform: at(160, 300),
      fillPaints: [{ type: E.PaintType.IMAGE, image: { hash: jpegHash, name: "jpeg" }, imageScaleMode: E.ImageScaleMode.STRETCH,
        transform: { m00: 0.5, m01: 0, m02: 0.25, m10: 0, m11: 0.5, m12: 0.25 }, opacity: 1, visible: true }] },
    { guid: C("mismatchRect"), parentIndex: under(CASES, "z"), type: T.RECTANGLE, name: "Mismatched entry", size: box(20, 20), transform: at(190, 300),
      fillPaints: [{ type: E.PaintType.IMAGE, image: { hash: mismatchName, name: "mismatch" }, imageScaleMode: E.ImageScaleMode.TILE, scale: 0.5,
        rotation: 450, paintFilter: { exposure: 0.25, vibrance: 0.5 }, opacity: 1, visible: true }] },
  ];

  const nodes = [
    { guid: PAGE, parentIndex: under(DOC, "a"), type: T.CANVAS, name: "Page 1", visible: true, backgroundColor: { r: 230, g: 230, b: 230, a: 255 } },
    { guid: INTERNAL, parentIndex: under(DOC, "c"), type: T.CANVAS, name: "Internal Only Canvas", visible: false, internalOnly: true },
    { guid: DIR, parentIndex: under(DOC, "b"), type: T.DIRECTORY, name: "Folder" },
    { guid: CASES, parentIndex: under(DIR, "a"), type: T.CANVAS, name: "M1 cases" },

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
        { guidPath: path(TRAIL, HEART_V), size: box(8, 8), transform: at(0, 0), fillGeometry: geom(B.heartFill, "ODD") },
      ] },
    { guid: G(IDS.unsupported), parentIndex: under(PAGE, "e"), type: T.RADIAL_PATTERN, name: "Unsupported pattern", size: box(50, 50), transform: at(300, 0) },
    { guid: g(1, 61), parentIndex: under(PAGE, "a"), type: T.INSTANCE, name: "Button instance", size: box(160, 48), transform: at(0, 100),
      symbolData: { symbolID: LARGE },
      componentPropAssignment: [
        { defID: LABEL_PROP, value: textValue("OK") },
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
      fillPaints: [{ type: E.PaintType.IMAGE, image: { hash: imageHash, name: "present" }, imageScaleMode: E.ImageScaleMode.FILL, opacity: 1, visible: true }] },
    { guid: g(1, 67), parentIndex: under(STYLED, "d"), type: T.RECTANGLE, name: "Image missing", size: box(20, 20), transform: at(90, 0),
      fillPaints: [{ type: E.PaintType.IMAGE, image: { hash: MISSING_IMAGE_HASH, name: "missing" }, imageScaleMode: E.ImageScaleMode.FIT, opacity: 0.5, visible: true }] },

    // ---- definitions, on the internal canvas ----
    { guid: SET, parentIndex: under(INTERNAL, "a"), type: T.FRAME, name: "Button", size: box(240, 48), transform: at(0, 0),
      isStateGroup: true, frameMaskDisabled: true,
      stateGroupPropertyValueOrders: [
        { property: "Size", values: ["Small", "Large"] },
        { property: "State", values: ["Default", "Hover"] },
      ],
      componentPropDef: [
        { id: LABEL_PROP, name: "Label", type: E.ComponentPropType.TEXT, initialValue: textValue("Button") },
        { id: ICON_PROP, name: "Show icon", type: E.ComponentPropType.BOOL, initialValue: { boolValue: true } },
      ] },
    { guid: SMALL, parentIndex: under(SET, "a"), type: T.SYMBOL, name: "Size=Small, State=Default", size: box(96, 32), transform: at(0, 0),
      componentPropDef: [alias(LABEL_PROP), alias(ICON_PROP)] },
    ...refs(g(1, 12), g(1, 13)).map((n, k) => ({ ...n, parentIndex: under(SMALL, "ab"[k]) })),
    { guid: LARGE, parentIndex: under(SET, "b"), type: T.SYMBOL, name: "State=Hover, Size=Large", size: box(160, 48), transform: at(100, 0),
      componentPropDef: [alias(LABEL_PROP), alias(ICON_PROP)] },
    ...refs(g(1, 15), g(1, 16)).map((n, k) => ({ ...n, parentIndex: under(LARGE, "ab"[k]) })),

    { guid: STAR, parentIndex: under(INTERNAL, "b"), type: T.SYMBOL, name: "Icon/Star", size: box(10, 10), transform: at(0, 100) },
    { guid: STAR_V, parentIndex: under(STAR, "a"), type: T.VECTOR, name: "Star", size: box(10, 10), transform: at(0, 0),
      fillPaints: [solid(255, 200, 0)],
      fillGeometry: geom(B.starFill),
      strokeGeometry: geom(B.starStroke),
      vectorData: { vectorNetworkBlob: B.starNet, normalizedSize: box(10, 10) } },
    { guid: HEART, parentIndex: under(INTERNAL, "c"), type: T.SYMBOL, name: "Icon/Heart", size: box(8, 8), transform: at(20, 100) },
    { guid: HEART_V, parentIndex: under(HEART, "a"), type: T.VECTOR, name: "Heart", size: box(8, 8), transform: at(0, 0),
      fillGeometry: geom(B.heartFill, "ODD") },

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
      overrideKey: g(50, 8), fontName: { family: "Inter", style: "Regular", postscript: "" },
      textData: { characters: "New", baselines: [{ position: box(0, 12), width: 20, firstCharacter: 0, endCharacter: 3 }] } },

    // Style definitions: the bodies of styles, with no transform and no size (not node records).
    { guid: STYLE, parentIndex: under(INTERNAL, "f"), type: T.RECTANGLE, name: "Brand/Primary",
      styleType: E.StyleType.FILL, styleID: 1,
      sharedStyleMasterData: { styleKey: "fixture-style-key-1", sortPosition: "a", fileKey: "fixtureownfilekey000000" },
      fillPaints: [solid(0, 85, 255)] },
    { guid: C("textStyle"), parentIndex: under(INTERNAL, "g"), type: T.TEXT, name: "Body/Regular", styleType: E.StyleType.TEXT, styleID: 2,
      fontName: { family: "Inter", style: "Medium", postscript: "" }, fontSize: 16 },

    ...cases,
  ];

  const square = (s) => encodeVectorNetwork({
    vertices: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s, styleID: 1 }, { x: 0, y: s }],
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
    regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2, 3]] }],
  });
  const blobs = [
    // 0: the star's fill, every opcode once: M, L, C, Z.
    encodePath([[1, 0, 0], [2, 10, 0], [4, 10, 5.5, 5, 10, 0, 10], [0]]),
    // 1: its stroke.
    encodePath([[1, 0, 0], [2, 10, 10]]),
    // 2: its vector network: a triangle with a curved side, one region.
    encodeVectorNetwork({
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2, tangentStart: { x: 0, y: 5.5 }, tangentEnd: { x: 5, y: 0 } }, { start: 2, end: 0 }],
      regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }],
    }),
    // 3: the heart's fill.
    encodePath([[1, 1, 1], [2, 9, 1], [2, 5, 9], [0]]),
    // 4-8: stroke-area paths of the side cases, in the node's frame (40 x 20).
    encodePath([...rectCmds(38, 0, 40, 20), ...rectCmds(0, 16, 40, 20)]),          // right 2, bottom 4
    encodePath(rectCmds(0, 17, 40, 20)),                                            // bottom 3
    encodePath([...rectCmds(0, 0, 40, 20), ...rectCmdsCCW(1, 1, 39, 19)]),          // a 1 px ring
    encodePath([...rectCmds(0, 0, 40, 2), ...rectCmds(0, 18, 40, 20)]),             // top and bottom only
    encodePath([...rectCmds(0, 0, 40, 20), ...rectCmdsCCW(1, 1, 39, 19)]),          // dashed: no oracle
    // 9: a glyph outline.
    encodePath([[1, 0, 0], [2, 6, 0], [2, 3, 8], [0]]),
    // 10-12: a 10 px square, another, a 10 px circle-ish shape.
    encodePath(rectCmds(0, 0, 10, 10)),
    encodePath(rectCmds(10, 0, 20, 10)),
    encodePath([[1, 5, 0], [4, 8, 0, 10, 2, 10, 5], [4, 10, 8, 8, 10, 5, 10], [4, 2, 10, 0, 8, 0, 5], [4, 0, 2, 2, 0, 5, 0], [0]]),
    // 13: the union's stored result.
    encodePath(rectCmds(0, 0, 20, 10)),
    // 14: a line's stroke outline.
    encodePath(rectCmds(0, -0.5, 10, 0.5)),
    // 15: the class B result: the outline of the two strokes.
    encodePath([[1, 0, 4.5], [2, 4.5, 4.5], [2, 4.5, 0], [2, 5.5, 0], [2, 5.5, 4.5], [2, 10, 4.5], [2, 10, 5.5], [2, 5.5, 5.5], [2, 5.5, 10], [2, 4.5, 10], [2, 4.5, 5.5], [2, 0, 5.5], [0]]),
    // 16-17: a 10 px square network (scaled 2x by its node) and its stored fill, 20 px.
    square(10),
    encodePath(rectCmds(0, 0, 20, 20)),
    // 18-19: an open chain with no region, and the fill Pixso stored for it (the closed triangle).
    encodeVectorNetwork({ vertices: [{ x: 0, y: 10 }, { x: 5, y: 0 }, { x: 10, y: 10 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }], regions: [] }),
    encodePath([[1, 0, 10], [2, 5, 0], [2, 10, 10], [0]]),
    // 20: a closed region with no stored fill.
    square(10),
    // 21: a closed region wound NONZERO (the stored path is ODD), at 20 over a 10 px node.
    square(20),
    // 22-23: a region over 0..10 at scale 1, and a stored fill over 0..20.
    square(10),
    encodePath(rectCmds(0, 0, 20, 20)),
    // 24-25: an open region loop (a chevron) and the fill Pixso stored for it.
    encodeVectorNetwork({ vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
      regions: [{ windingRule: "NONZERO", loops: [[0, 1]] }] }),
    encodePath([[1, 0, 0], [2, 5, 5], [2, 10, 0], [0]]),
    // 26: a network whose vertex 1 is RIGHT_ANGLE mirrored (style 3), no region.
    encodeVectorNetwork({ vertices: [{ x: 0, y: 0 }, { x: 5, y: 5, styleID: 3 }, { x: 10, y: 0 }],
      segments: [{ start: 0, end: 1, tangentEnd: { x: -2, y: 0 } }, { start: 1, end: 2, tangentStart: { x: 2, y: 0 } }], regions: [] }),
    // 27: the NaN-sized vector's fill (a 6 x 4 box at 1,1), 28: a path of NaN.
    encodePath(rectCmds(1, 1, 7, 5)),
    encodePath([[1, NaN, NaN], [2, NaN, NaN], [0]]),
    // 29-30: a connector's network (two points) and its stroke outline.
    encodeVectorNetwork({ vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }], segments: [{ start: 0, end: 1 }], regions: [] }),
    encodePath(rectCmds(0, 0, 10, 10)),
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

export const VARIANTS = ["valid", "truncated", "unknown-field", "trailing-bytes", "renumbered"];

// Every enum renumbered: its members in reverse order from 300 up. Field names and ids stay; only
// the numbers that stand for enum names change.
function renumber(defs) {
  return defs.map((d) => (d.kind !== 0 ? d : { ...d, fields: d.fields.map((f, k) => ({ ...f, value: 300 + d.fields.length - 1 - k })) }));
}

// Build the .pix. Every variant but "valid" and "renumbered" is damaged in exactly one way, inside
// an archive and a zstd frame that are themselves sound, so the Kiwi layer is what has to notice:
//   truncated       the message is cut after 60 % of its bytes;
//   unknown-field   one node carries a field (id 99) that the schema stored in the file lacks;
//   trailing-bytes  two bytes follow the end of the message.
// opts.mutate(value, defs) changes the document before it is encoded (the reader's tests plant
// damaged text data and networks with it); opts.images replaces the archive's image entries.
export function makeFixture(variant = "valid", opts = {}) {
  if (!VARIANTS.includes(variant)) throw new Error("no fixture variant " + variant + "; one of " + VARIANTS.join(", "));
  let defs = parseKiwiText(FIXTURE_SCHEMA);
  if (variant === "renumbered") defs = renumber(defs);
  const value = fixtureMessage(defs);
  if (opts.mutate) opts.mutate(value, defs);
  let writeDefs = defs;
  if (variant === "unknown-field") {
    writeDefs = defs.map((d) => (d.name !== "PixsoNode" ? d : { ...d, fields: [...d.fields, { name: "fixtureOnly", type: -6, isArray: false, value: 99 }] }));
    const odd = value.pixsoNodes.find((n) => n.name === "Unsupported pattern");
    odd.fixtureOnly = "not in the schema stored in the file";
  }
  let message = encodeMessage(writeDefs, "PixsoMsg", value);
  if (variant === "truncated") message = message.subarray(0, Math.floor(message.length * 0.6));
  if (variant === "trailing-bytes") message = Buffer.concat([message, Buffer.from([0x00, 0x2a])]);

  const schema = encodeSchema(defs);
  const image = fixtureImage(), jpeg = fixtureJpeg(), mismatch = fixtureMismatch();
  const images = opts.images || [
    { name: image.hash.toString("hex") + ".png", data: image.png },
    { name: jpeg.hash.toString("hex") + ".png", data: jpeg.jpg },
    { name: mismatch.name.toString("hex") + ".png", data: mismatch.bytes },
  ];
  const pix = writePix({ schema, document: writeDocument(message), docName: FIXTURE_DOC_NAME, images });
  return { pix, defs, schema, value, message, image, jpeg, mismatch, missingHash: MISSING_IMAGE_HASH };
}

// Compared by real path: through a symlink or a directory junction argv[1] and import.meta.url differ,
// and a plain comparison wrote nothing and exited 0 (the trap tools/mcp-codes.mjs records).
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const vi = argv.indexOf("--variant");
  const variant = vi >= 0 ? argv.splice(vi, 2)[1] : "valid";
  if (!argv[0]) { console.error("usage: node tools/pix/fixture.mjs <out.pix> [--variant " + VARIANTS.join("|") + "]"); process.exit(1); }
  const { pix } = makeFixture(variant);
  writeFileSync(argv[0], pix);
  console.log("wrote " + argv[0] + " (" + variant + ", " + pix.length + " bytes)");
}

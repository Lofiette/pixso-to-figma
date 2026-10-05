// The IR schema, checked with neither editor and no real file.
//
//   node tools/test-ir.mjs
//
// Every IR here is synthetic. Valid ones must pass; each kind of broken one must fail, and fail at
// the path that names the broken thing, because "the IR is invalid" with no path is a support
// conversation. The complete example in docs/IR.md is validated too, so the document and the
// validator cannot drift apart unnoticed.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as schema from "./ir/schema.mjs";
import * as props from "./ir/props.mjs";
import { validate } from "./ir/validate.mjs";

const { validateIR, valueSignature, fnv1a64, snapshotId, canonicalJSON, REASON_CODES, VERSION, CODE } = schema;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- synthetic IRs ----------
const SHA = "0".repeat(62) + "a1";
const LIB = "SyntheticLibKey0000002";

function header(kind) {
  return {
    format: "pix2fig.ir", version: VERSION,
    source: kind === "mcp"
      ? { kind: "mcp", fileKey: "SyntheticFileKey000001", readAt: "2026-01-02T03:04:05Z", changedDuringRead: false }
      : { kind: "pix", sha256: SHA, fileKey: null },
    scope: { kind: "file" },
    capabilities: kind === "mcp"
      ? { authoredOverrides: false, resolvedOverrides: true, overrideKeys: false, publishIds: false,
        symbolVersions: false, derivedBoxes: false, inkBounds: true, renders: true }
      : { authoredOverrides: true, resolvedOverrides: false, overrideKeys: true, publishIds: true,
        symbolVersions: true, derivedBoxes: true, inkBounds: false, renders: false },
    settings: { mode: "design", overrides: "fidelity", drift: "link", deleted: "publish",
      resync: "pixso-unless-edited", textFit: "widen", booleans: "auto", spaceEvenlySingle: "between", kitmaps: "default" },
  };
}

// The props a record of each kind always carries in version 2: its box, and the NEVER_OMIT props of
// its type (values[0] is the empty list in every IR below).
const T0 = [1, 0, 0, 0, 1, 0];
const PAINTED = { fills: 0, strokes: 0, strokeWeight: 1, strokeAlign: "INSIDE", blendMode: "PASS_THROUGH" };
const frameProps = (w, h, more) => Object.assign({ relativeTransform: T0.slice(), width: w, height: h }, PAINTED,
  { clipsContent: true, layoutMode: "NONE" }, more || {});
const shapeProps = (w, h, more) => Object.assign({ relativeTransform: T0.slice(), width: w, height: h }, PAINTED, more || {});

// The smallest useful IR: one page, one frame.
const minimal = () => ({
  header: header("pix"),
  pages: [{ guid: "0:1", name: "Page 1", internal: false }],
  values: [[]],
  nodes: [{ parent: -1, page: 0, guid: "1:2", type: "FRAME", name: "Frame", props: frameProps(10, 10) }],
});

// An MCP IR: an instance of a master that is not in the IR, known only by library and componentKey,
// with overrides found by comparison (resolved), and ink bounds the live renderer provides.
const mcp = () => ({
  header: header("mcp"),
  pages: [{ guid: "0:1", name: "Page 1", internal: false }],
  values: [[], [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }]],
  nodes: [
    { parent: -1, page: 0, guid: "1:2", type: "FRAME", name: "Frame", props: frameProps(100, 50, { inkBounds: [0, 0, 100, 50] }) },
    { parent: 0, guid: "1:3", type: "INSTANCE", name: "Icon", props: { relativeTransform: [1, 0, 4, 0, 1, 4], width: 16, height: 16 },
      instance: {
        master: { library: { publishFile: LIB, componentKey: "c0ffee" + "0".repeat(33) + "3" } },
        overrides: [{ path: ["7:1"], fields: { fills: 1 } }],
        overrideBasis: "resolved",
      } },
  ],
});

// The complete example from docs/IR.md, which is itself a test.
const IR_MD = readFileSync(join(ROOT, "docs", "IR.md"), "utf8");
let example = null;
{
  const at = IR_MD.indexOf("<!-- ir-example: valid -->");
  const m = at >= 0 ? /```json\r?\n([\s\S]*?)\r?\n```/.exec(IR_MD.slice(at)) : null;
  try { example = m ? JSON.parse(m[1]) : null; } catch (e) { fail("the example in docs/IR.md is not JSON: " + e.message); }
  if (!example && !failed) fail("docs/IR.md has no example marked <!-- ir-example: valid -->");
}
const rich = () => clone(example);

// ---------- expectations ----------
function expectValid(label, ir) {
  let r;
  try { r = validate(ir); } catch (e) { fail(label + ": the validator threw: " + e.message); return; }
  if (r.ok && r.errors.length === 0) ok(label);
  else fail(label + ": " + r.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join(" | "));
}
// Fails unless the IR is refused AND one of the errors is at exactly the path that names the fault.
function expectError(label, ir, path, onlyOne) {
  let r;
  try { r = validate(ir); } catch (e) { fail(label + ": the validator threw: " + e.message); return; }
  const hit = r.errors.find((e) => e.path === path);
  if (r.ok) fail(label + ": accepted");
  else if (!hit) fail(label + ": refused, but not at " + path + ": " + r.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join(" | "));
  else if (onlyOne && r.errors.length !== 1) fail(label + ": expected only " + path + ", got " + r.errors.length + " errors");
  else ok(label + "  ->  " + hit.path + ": " + hit.message);
}
const mut = (base, f) => { const ir = base(); f(ir); return ir; };

// ---------- valid ----------
expectValid("a minimal .pix IR passes", minimal());
expectValid("an MCP IR with an external master and resolved overrides passes", mcp());
if (example) expectValid("the complete example in docs/IR.md passes", rich());
expectValid("empty tables may be left out", { header: header("pix") });
expectValid("a pages scope lists its guids", mut(minimal, (ir) => { ir.header.scope = { kind: "pages", ids: ["0:1"] }; }));

// ---------- the format and the version are refused before anything else ----------
expectError("unknown format", mut(minimal, (ir) => { ir.header.format = "pix2fig.payload"; }), "header.format", true);
expectError("unknown version", mut(minimal, (ir) => { ir.header.version = VERSION + 1; ir.nodes[0].parent = 5; }), "header.version", true);
expectError("the previous version, which is not migrated", mut(minimal, (ir) => { ir.header.version = VERSION - 1; }), "header.version", true);
expectError("a version written as a string", mut(minimal, (ir) => { ir.header.version = String(VERSION); }), "header.version", true);
expectError("no header at all", { nodes: [] }, "header");

// ---------- the header ----------
expectError("bad capability type", mut(minimal, (ir) => { ir.header.capabilities.renders = "yes"; }), "header.capabilities.renders");
expectError("missing capability", mut(minimal, (ir) => { delete ir.header.capabilities.inkBounds; }), "header.capabilities.inkBounds");
expectError("unknown capability", mut(minimal, (ir) => { ir.header.capabilities.vectorNetworks = true; }), "header.capabilities.vectorNetworks");
expectError("setting outside its enum", mut(minimal, (ir) => { ir.header.settings.drift = "always"; }), "header.settings.drift");
expectError("text-fit outside its enum", mut(minimal, (ir) => { ir.header.settings.textFit = "shrink"; }), "header.settings.textFit");
expectError("missing kitmaps setting", mut(minimal, (ir) => { delete ir.header.settings.kitmaps; }), "header.settings.kitmaps");
expectError("a .pix snapshot that is not a SHA-256", mut(minimal, (ir) => { ir.header.source.sha256 = "abc"; }), "header.source.sha256");
expectError("an MCP snapshot without its read time", mut(mcp, (ir) => { delete ir.header.source.readAt; }), "header.source.readAt");
expectError("an unknown source kind", mut(minimal, (ir) => { ir.header.source.kind = "fig"; }), "header.source.kind");
expectError("a selection scope with no ids", mut(minimal, (ir) => { ir.header.scope = { kind: "selection" }; }), "header.scope.ids");

// ---------- parent-first records ----------
expectError("child before parent", mut(minimal, (ir) => {
  ir.nodes = [
    { parent: 1, guid: "1:3", type: "RECTANGLE", name: "Child" },
    { parent: -1, page: 0, guid: "1:2", type: "FRAME", name: "Parent" },
  ];
}), "nodes[0].parent");
expectError("parent out of range", mut(minimal, (ir) => { ir.nodes.push({ parent: 7, guid: "1:3", type: "RECTANGLE", name: "R" }); }), "nodes[1].parent");
expectError("a top-level record without its page", mut(minimal, (ir) => { delete ir.nodes[0].page; }), "nodes[0].page");
expectError("duplicate guid", mut(minimal, (ir) => { ir.nodes.push({ parent: 0, guid: "1:2", type: "RECTANGLE", name: "R" }); }), "nodes[1].guid");
expectError("unknown node type", mut(minimal, (ir) => { ir.nodes[0].type = "STICKY"; }), "nodes[0].type");
expectError("a misspelt record key", mut(minimal, (ir) => { ir.nodes[0].parnet = -1; }), "nodes[0].parnet");
if (example) expectError("a record under an instance", mut(rich, (ir) => { ir.nodes.push({ parent: 1, guid: "1:90", type: "TEXT", name: "T" }); }), "nodes[12].parent");

// ---------- dictionary and table indexes ----------
if (example) {
  expectError("dictionary index out of range", mut(rich, (ir) => { ir.nodes[0].props.fills = 99; }), "nodes[0].props.fills");
  expectError("dictionary index in a text range", mut(rich, (ir) => { ir.nodes[3].props.textRanges[0].fields.fills = 50; }), "nodes[3].props.textRanges[0].fields.fills");
  expectError("dictionary index in an override", mut(rich, (ir) => { ir.nodes[1].instance.overrides[0].fields.fills = -1; }), "nodes[1].instance.overrides[0].fields.fills");
  expectError("style index out of range", mut(rich, (ir) => { ir.nodes[3].props.fillStyle = 4; }), "nodes[3].props.fillStyle");
  expectError("a paint style used as a text style", mut(rich, (ir) => { ir.nodes[3].props.textStyle = 0; }), "nodes[3].props.textStyle");
  expectError("a text range outside the characters", mut(rich, (ir) => { ir.nodes[3].props.textRanges[0].end = 99; }), "nodes[3].props.textRanges[0]");
  expectError("an image paint whose hash is not listed", mut(rich, (ir) => { ir.images = []; }), "values[2][0].imageHash");
  expectError("an image paint with no hash", mut(rich, (ir) => { delete ir.values[2][0].imageHash; }), "values[2][0].imageHash", true);
  expectError("an image paint whose hash is null", mut(rich, (ir) => { ir.values[2][0].imageHash = null; }), "values[2][0].imageHash", true);
  expectError("a font that is not declared", mut(rich, (ir) => { ir.fonts = []; }), "nodes[3].props.fontName");
  expectError("a value interned twice", mut(rich, (ir) => { ir.values.push({ style: "Regular", family: "Inter" }); }), "values[7]");
  expectError("fills pointing at a value that is not a list", mut(rich, (ir) => { ir.nodes[0].props.fills = 3; }), "nodes[0].props.fills");
  expectError("a line count that is not a count", mut(rich, (ir) => { ir.nodes[3].props.lines = "one"; }), "nodes[3].props.lines");
  expectError("a page and a node sharing a guid", mut(rich, (ir) => { ir.pages[1].guid = "2:30"; }), "nodes[9].guid");
  expectError("a style and a node sharing a guid", mut(rich, (ir) => { ir.styles[0].guid = "1:13"; }), "styles[0].guid");
  expectError("a derived box outside the master", mut(rich, (ir) => { ir.nodes[1].instance.derived[0].path = ["2:31"]; }), "nodes[1].instance.derived[0].path[0]");
  // A derived entry may carry the sublayer's vector paths, for a fallback frame (REWRITE.md §3).
  const withPaths = (ir) => { ir.values.push([{ windingRule: "NONZERO", data: "M 0 0 L 88 0 L 88 20 Z" }]); ir.nodes[1].instance.derived[0].fillGeometry = ir.values.length - 1; };
  expectValid("a derived box with its fill geometry passes", mut(rich, withPaths));
  expectError("derived geometry index out of range", mut(rich, (ir) => { withPaths(ir); ir.nodes[1].instance.derived[0].strokeGeometry = 40; }), "nodes[1].instance.derived[0].strokeGeometry", true);
  expectError("derived geometry pointing at an object", mut(rich, (ir) => { ir.nodes[1].instance.derived[0].fillGeometry = 3; }), "nodes[1].instance.derived[0].fillGeometry", true);
  expectError("a note with an empty path", mut(rich, (ir) => { ir.notes[1].path = []; }), "notes[1].path");
}

// ---------- reason codes ----------
if (example) {
  expectError("unknown reason code", mut(rich, (ir) => { ir.notes[0].code = "LOOKS_FINE"; }), "notes[0].code");
  expectError("a note naming a record that does not exist", mut(rich, (ir) => { ir.notes[0].node = 40; }), "notes[0].node");
}

// ---------- masters, families and overrides ----------
if (example) {
  expectError("dangling master reference", mut(rich, (ir) => { ir.nodes[1].instance.master = { guid: "9:99" }; }), "nodes[1].instance.master");
  expectError("a master reference to a frame", mut(rich, (ir) => { ir.nodes[1].instance.master = { guid: "1:10" }; }), "nodes[1].instance.master.guid");
  expectError("a master reference with neither guid nor library", mut(rich, (ir) => { ir.nodes[1].instance.master = {}; }), "nodes[1].instance.master");
  expectError("a library identity that names no master", mut(rich, (ir) => { ir.nodes[1].instance.master = { library: { publishFile: LIB } }; }), "nodes[1].instance.master.library");
  expectError("a dangling swap target", mut(rich, (ir) => { ir.nodes[1].instance.overrides[0].swap = { guid: "9:98" }; }), "nodes[1].instance.overrides[0].swap");
  expectError("a master reference that disagrees with its definition", mut(rich, (ir) => { ir.nodes[1].instance.master.library.publishID = "5:77"; }), "nodes[1].instance.master.library");
  expectError("an instance inside its own master", mut(rich, (ir) => {
    ir.nodes.push({ parent: 7, guid: "2:25", type: "INSTANCE", name: "Self", instance: { master: { guid: "2:23" } } });
  }), "nodes[12].instance.master");
  expectError("an assignment from another family (stale)", mut(rich, (ir) => { ir.nodes[1].instance.properties[0].family = "2:30"; }), "nodes[1].instance.properties[0].family");
  expectError("an assignment to an unknown property", mut(rich, (ir) => { ir.nodes[1].instance.properties[0].id = "Nope#0:9"; }), "nodes[1].instance.properties[0].id");
  expectError("an assignment of the wrong type", mut(rich, (ir) => { ir.nodes[1].instance.properties[0].value = true; }), "nodes[1].instance.properties[0].value");
  expectError("an override whose first hop is outside the master", mut(rich, (ir) => { ir.nodes[1].instance.overrides[0].path = ["2:22"]; }), "nodes[1].instance.overrides[0].path[0]");
  expectError("two override entries for one path", mut(rich, (ir) => { ir.nodes[1].instance.overrides.push({ path: ["2:24"], fields: { visible: false } }); }), "nodes[1].instance.overrides[1].path");
  expectError("an override that changes nothing", mut(rich, (ir) => { ir.nodes[1].instance.overrides[0].fields = {}; }), "nodes[1].instance.overrides[0]");
  expectError("a duplicate variant coordinate", mut(rich, (ir) => { ir.components[1].variant.State = "Default"; }), "components[1].variant");
  expectError("a coordinate off its axis", mut(rich, (ir) => { ir.components[1].variant.State = "Pressed"; }), "components[1].variant.State");
  expectError("a member declaring its own properties", mut(rich, (ir) => { ir.components[0].properties = [{ id: "X#1:1", name: "X", type: "BOOLEAN", default: false }]; }), "components[0].properties");
  expectError("a component record with no definition", mut(rich, (ir) => { ir.components.pop(); }), "nodes[9]");
  expectError("a layer bound to a property of the wrong type", mut(rich, (ir) => { ir.sets[0].properties[0].type = "BOOLEAN"; ir.sets[0].properties[0].default = true; ir.nodes[1].instance.properties = []; }), "nodes[6].props.componentPropertyReferences.characters");
  expectError("a layer bound to a property its family lacks", mut(rich, (ir) => { ir.nodes[10].props.componentPropertyReferences.visible = "Label#0:1"; }), "nodes[10].props.componentPropertyReferences.visible");
  for (const f of ["constructor", "__proto__", "toString"]) {
    const ir = rich();
    ir.nodes[10].props.componentPropertyReferences = JSON.parse("{" + JSON.stringify(f) + ": \"Dot#0:2\"}");
    const r = validate(ir);
    const hit = r.errors.find((e) => e.path === "nodes[10].props.componentPropertyReferences." + f);
    if (!r.ok && hit && /^a layer binds only /.test(hit.message)) ok("a layer bound through " + f + " is refused as an unknown field  ->  " + hit.path + ": " + hit.message);
    else fail("a layer bound through " + f + ": " + JSON.stringify(r.errors.slice(0, 2)));
  }
}

// ---------- capabilities: the content claims nothing the header does not declare ----------
if (example) {
  expectError("publishID without capabilities.publishIds", mut(rich, (ir) => { ir.header.capabilities.publishIds = false; }), "components[0].library.publishID");
  expectError("overrideKey without capabilities.overrideKeys", mut(rich, (ir) => { ir.header.capabilities.overrideKeys = false; }), "nodes[6].overrideKey");
  expectError("derived boxes without capabilities.derivedBoxes", mut(rich, (ir) => { ir.header.capabilities.derivedBoxes = false; }), "nodes[1].instance.derived");
  expectError("authored overrides from a source that has none", mut(rich, (ir) => { ir.header.capabilities.authoredOverrides = false; }), "nodes[1].instance.overrideBasis");
  expectError("sharedSymbolVersion without capabilities.symbolVersions", mut(rich, (ir) => { ir.header.capabilities.symbolVersions = false; }), "components[0].library.sharedSymbolVersion");
}
expectError("ink bounds without capabilities.inkBounds", mut(mcp, (ir) => { ir.header.capabilities.inkBounds = false; }), "nodes[0].props.inkBounds");

// ---------- styles ----------
if (example) {
  expectError("a style whose signature is not its value's", mut(rich, (ir) => { ir.styles[0].signature = "fnv1a64:0000000000000000"; }), "styles[0].signature");
  expectError("two styles with one identity", mut(rich, (ir) => { ir.styles.push(Object.assign({}, ir.styles[0], { guid: "3:2", name: "Copy" })); }), "styles[1]");
  const twoValues = mut(rich, (ir) => { ir.styles.push(Object.assign({}, ir.styles[0], { guid: "3:2", value: 1, signature: valueSignature(ir.values[1]) })); });
  expectValid("one styleKey with two different values is two styles", twoValues);
}

// ---------- version 2: props, sides, vectors, text (docs/M1.md §5.1) ----------
{
  let threw = "";
  try { validateIR(minimal()); } catch (e) { threw = e.message; }
  if (/needs the prop tables/.test(threw)) ok("validateIR without the prop tables throws, rather than answering ok on unchecked props");
  else fail("validateIR without the prop tables: " + (threw || "did not throw"));
}
expectError("a record with no props", mut(minimal, (ir) => { delete ir.nodes[0].props; }), "nodes[0].props");
expectError("a record with no relativeTransform", mut(minimal, (ir) => { delete ir.nodes[0].props.relativeTransform; }), "nodes[0].props.relativeTransform");
expectError("a relativeTransform with a NaN", mut(minimal, (ir) => { ir.nodes[0].props.relativeTransform[2] = NaN; }), "nodes[0].props.relativeTransform");
expectError("a record with no width", mut(minimal, (ir) => { delete ir.nodes[0].props.width; }), "nodes[0].props.width");
expectError("a negative height", mut(minimal, (ir) => { ir.nodes[0].props.height = -1; }), "nodes[0].props.height");
expectError("a NaN width", mut(minimal, (ir) => { ir.nodes[0].props.width = NaN; }), "nodes[0].props.width");
for (const k of props.NEVER_OMIT.filter((p) => props.KNOWN_PROPS.FRAME[p] !== undefined)) {
  expectError("a FRAME without " + k + " (NEVER_OMIT)", mut(minimal, (ir) => { delete ir.nodes[0].props[k]; }), "nodes[0].props." + k, true);
}
if (example) expectError("a TEXT without textAutoResize (NEVER_OMIT)", mut(rich, (ir) => { delete ir.nodes[3].props.textAutoResize; }), "nodes[3].props.textAutoResize", true);
for (const [k, v] of [["x", 3], ["rotation", 90], ["strokeTopWeight", 1], ["topLeftRadius", 4]]) {
  expectError("superseded prop " + k, mut(minimal, (ir) => { ir.nodes[0].props[k] = v; }), "nodes[0].props." + k, true);
}
expectError("a prop the type does not have (characters on a FRAME)", mut(minimal, (ir) => { ir.nodes[0].props.characters = "x"; }), "nodes[0].props.characters", true);
expectError("a misspelt prop", mut(minimal, (ir) => { ir.nodes[0].props.opactiy = 1; }), "nodes[0].props.opactiy", true);
expectError("a num prop given a string", mut(minimal, (ir) => { ir.nodes[0].props.opacity = "1"; }), "nodes[0].props.opacity", true);
expectError("a bool prop given a number", mut(minimal, (ir) => { ir.nodes[0].props.clipsContent = 1; }), "nodes[0].props.clipsContent", true);
expectError("an enum prop outside its values", mut(minimal, (ir) => { ir.nodes[0].props.layoutMode = "GRID"; }), "nodes[0].props.layoutMode", true);
if (example) expectError("an int prop given a fraction", mut(rich, (ir) => { ir.nodes[3].props.maxLines = 1.5; }), "nodes[3].props.maxLines", true);
expectError("strokeWeights of three sides", mut(minimal, (ir) => { ir.nodes[0].props.strokeWeights = [1, 1, 1]; }), "nodes[0].props.strokeWeights", true);
expectError("a negative side weight", mut(minimal, (ir) => { ir.nodes[0].props.strokeWeights = [1, -1, 1, 1]; }), "nodes[0].props.strokeWeights", true);
expectError("cornerRadii with a string", mut(minimal, (ir) => { ir.nodes[0].props.cornerRadii = [1, "2", 3, 4]; }), "nodes[0].props.cornerRadii", true);
expectError("cornerRadius next to cornerRadii", mut(minimal, (ir) => { ir.nodes[0].props.cornerRadii = [1, 2, 3, 4]; ir.nodes[0].props.cornerRadius = 2; }), "nodes[0].props.cornerRadius", true);
expectError("oracleSides that are not booleans", mut(minimal, (ir) => { ir.nodes[0].props.oracleSides = [true, 1, true, true]; }), "nodes[0].props.oracleSides", true);
if (example) expectError("oracleSides on a TEXT", mut(rich, (ir) => { ir.nodes[3].props.oracleSides = [true, true, true, true]; }), "nodes[3].props.oracleSides", true);
expectError("strokes on a SECTION (dropped by the reader, docs/M1.md D13)", mut(minimal, (ir) => {
  ir.nodes[0] = { parent: -1, page: 0, guid: "1:2", type: "SECTION", name: "S", props: { relativeTransform: T0.slice(), width: 10, height: 10, fills: 0, strokes: 0 } };
}), "nodes[0].props.strokes", true);
expectValid("a GROUP with no paints, a SECTION with fills only", mut(minimal, (ir) => {
  ir.nodes.push({ parent: 0, guid: "1:3", type: "GROUP", name: "G", props: { relativeTransform: T0.slice(), width: 5, height: 5, blendMode: "PASS_THROUGH", isMask: true } });
  ir.nodes.push({ parent: -1, page: 0, guid: "1:4", type: "SECTION", name: "S", props: { relativeTransform: T0.slice(), width: 50, height: 50, fills: 0 } });
}));
expectValid("a page background that is a fills list", mut(minimal, (ir) => { ir.pages[0].background = 0; }));
if (example) expectError("a page background that is not a fills list", mut(rich, (ir) => { ir.pages[0].background = 3; }), "pages[0].background", true);
expectError("a page background out of range", mut(minimal, (ir) => { ir.pages[0].background = 9; }), "pages[0].background", true);
expectError("the booleans setting outside its enum", mut(minimal, (ir) => { ir.header.settings.booleans = "frame"; }), "header.settings.booleans", true);
expectError("the spaceEvenlySingle setting missing", mut(minimal, (ir) => { delete ir.header.settings.spaceEvenlySingle; }), "header.settings.spaceEvenlySingle", true);

// Vectors: the IR below has a frame, and a VECTOR at nodes[1] built from a network; values[1] is the
// network, values[2] its stored fill geometry.
const TRI = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8, cornerRadius: 1 }],
  segments: [{ start: 0, end: 1 }, { start: 1, end: 2, tangentStart: { x: 0, y: 1 }, tangentEnd: { x: 1, y: 0 } }, { start: 2, end: 0 }],
  regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }] };
const GEO = [{ windingRule: "NONZERO", data: "M 0 0 L 10 0 C 10 4 7 8 5 8 Z" }];
const vec = () => mut(minimal, (ir) => {
  ir.values.push(clone(TRI), clone(GEO));
  ir.nodes.push({ parent: 0, guid: "1:3", type: "VECTOR", name: "V", props: shapeProps(10, 8, { vectorNetwork: 1, oracleFillGeometry: 2 }) });
});
expectValid("a VECTOR built from its network, with its oracle", vec());
expectValid("a VECTOR built from its stored geometry, with its note", mut(vec, (ir) => {
  delete ir.nodes[1].props.vectorNetwork; delete ir.nodes[1].props.oracleFillGeometry;
  ir.nodes[1].props.fillGeometry = 2; ir.nodes[1].props.strokeGeometry = 2;
  ir.notes = [{ code: "VECTOR_FROM_GEOMETRY", node: 1 }];
}));
expectError("a geometry-built VECTOR without a note saying why", mut(vec, (ir) => {
  delete ir.nodes[1].props.vectorNetwork; delete ir.nodes[1].props.oracleFillGeometry; ir.nodes[1].props.fillGeometry = 2;
}), "nodes[1].props.fillGeometry", true);
expectError("a VECTOR with two build sources", mut(vec, (ir) => { ir.nodes[1].props.fillGeometry = 2; ir.notes = [{ code: "VECTOR_FROM_GEOMETRY", node: 1 }]; }), "nodes[1].props");
expectError("a VECTOR with no build source", mut(vec, (ir) => { delete ir.nodes[1].props.vectorNetwork; delete ir.nodes[1].props.oracleFillGeometry; }), "nodes[1].props", true);
expectError("strokeGeometry as the only source", mut(vec, (ir) => { ir.nodes[1].props.strokeGeometry = 2; }), "nodes[1].props.strokeGeometry", true);
expectError("an oracle next to a geometry source", mut(vec, (ir) => {
  delete ir.nodes[1].props.vectorNetwork; ir.nodes[1].props.fillGeometry = 2; ir.notes = [{ code: "VECTOR_FROM_GEOMETRY", node: 1 }];
}), "nodes[1].props.oracleFillGeometry", true);
expectError("vector geometry on a RECTANGLE", mut(vec, (ir) => { ir.nodes[1].type = "RECTANGLE"; }), "nodes[1].props.vectorNetwork");
expectError("a STAR with build-source geometry", mut(vec, (ir) => { ir.nodes[1].type = "STAR"; }), "nodes[1].props.vectorNetwork", true);
expectValid("a BOOLEAN_OPERATION over its operands, with its stored result as the oracle", mut(vec, (ir) => {
  ir.nodes[1] = { parent: 0, guid: "1:3", type: "BOOLEAN_OPERATION", name: "B", props: shapeProps(10, 8, { booleanOperation: "EXCLUDE", oracleFillGeometry: 2 }) };
  ir.nodes.push({ parent: 1, guid: "1:4", type: "RECTANGLE", name: "R", props: shapeProps(6, 6) });
  ir.nodes.push({ parent: 1, guid: "1:5", type: "ELLIPSE", name: "E", props: shapeProps(6, 6, { relativeTransform: [1, 0, 4, 0, 1, 2] }) });
}));
expectError("a geometry value whose winding rule is Pixso's", mut(vec, (ir) => { ir.values[2][0].windingRule = "ODD"; }), "nodes[1].props.oracleFillGeometry", true);
for (const [label, data] of [["an unknown command", "M 0 0 X 1 1"], ["commas", "M0,0 L10,0 Z"], ["a missing number", "M 0 0 L 10"], ["no leading M", "L 0 0 Z"], ["an empty path", " "]]) {
  expectError("a geometry path with " + label, mut(vec, (ir) => { ir.values[2][0].data = data; }), "nodes[1].props.oracleFillGeometry", true);
}
expectError("a network segment past the vertices", mut(vec, (ir) => { ir.values[1].segments[2].end = 7; }), "nodes[1].props.vectorNetwork", true);
expectError("a network region whose loop is open", mut(vec, (ir) => { ir.values[1].regions[0].loops = [[0, 1]]; }), "nodes[1].props.vectorNetwork", true);
expectError("a network loop naming a missing segment", mut(vec, (ir) => { ir.values[1].regions[0].loops = [[0, 1, 9]]; }), "nodes[1].props.vectorNetwork", true);
expectError("a network vertex with Pixso's RIGHT_ANGLE mirroring", mut(vec, (ir) => { ir.values[1].vertices[0].handleMirroring = "RIGHT_ANGLE"; }), "nodes[1].props.vectorNetwork", true);
expectError("a network with an unknown key", mut(vec, (ir) => { ir.values[1].extra = 1; }), "nodes[1].props.vectorNetwork", true);
expectValid("a region-less network (an open path)", mut(vec, (ir) => { ir.values[1].regions = []; delete ir.nodes[1].props.oracleFillGeometry; ir.values.pop(); }));
expectValid("a VECTOR_ORACLE_DIFFERS note with its class", mut(vec, (ir) => { ir.notes = [{ code: "VECTOR_ORACLE_DIFFERS", node: 1, detail: "network-bounds: 1.4 px" }]; }));
expectError("a VECTOR_ORACLE_DIFFERS note with no class", mut(vec, (ir) => { ir.notes = [{ code: "VECTOR_ORACLE_DIFFERS", node: 1, detail: "bounds differ" }]; }), "notes[0].detail", true);
expectError("a VECTOR_ORACLE_DIFFERS note on a frame", mut(vec, (ir) => { ir.notes = [{ code: "VECTOR_ORACLE_DIFFERS", node: 0, detail: "winding" }]; }), "notes[0].node", true);
for (const c of ["INSTANCE_DEFERRED", "OUT_OF_SCOPE", "PLUGIN_STALLED"]) {
  expectError("a " + REASON_CODES[c].stage + "-stage code in the IR's notes (" + c + ")", mut(minimal, (ir) => { ir.notes = [{ code: c, node: 0 }]; }), "notes[0].code", true);
}

// Text: ranges in UTF-16 units that never split a surrogate pair, and range fields of their kinds.
if (example) {
  const astral = () => mut(rich, (ir) => { ir.nodes[3].props.characters = "a😀b"; ir.nodes[3].props.textRanges = [{ start: 1, end: 3, fields: { fontSize: 20 } }]; });
  expectValid("a range around an astral character, in UTF-16 units", astral());
  expectError("a range that starts inside a surrogate pair", mut(astral, (ir) => { ir.nodes[3].props.textRanges[0].start = 2; }), "nodes[3].props.textRanges[0].start", true);
  expectError("a range that ends inside a surrogate pair", mut(astral, (ir) => { ir.nodes[3].props.textRanges[0].end = 2; }), "nodes[3].props.textRanges[0].end", true);
  expectError("a range field that is not one", mut(rich, (ir) => { ir.nodes[3].props.textRanges[0].fields.fontWeight = 700; }), "nodes[3].props.textRanges[0].fields.fontWeight", true);
  expectError("a range field of the wrong kind", mut(rich, (ir) => { ir.nodes[3].props.textRanges[0].fields.textCase = "SHOUT"; }), "nodes[3].props.textRanges[0].fields.textCase", true);
  expectValid("a range carrying a hyperlink and list options, interned", mut(rich, (ir) => {
    ir.values.push({ type: "URL", value: "https://example.invalid/" }, { type: "UNORDERED" });
    Object.assign(ir.nodes[3].props.textRanges[0].fields, { hyperlink: ir.values.length - 2, listOptions: ir.values.length - 1, indentation: 1 });
  }));
}

// The tables themselves (tools/ir/props.mjs): what the validator and the builder rely on.
{
  const P = props, S = schema, bad = [];
  const kindOk = (k) => S.PROP_KINDS.indexOf(k) >= 0 || (/^enum:[A-Z0-9_]+(\|[A-Z0-9_]+)*$/.test(k));
  for (const t of S.NODE_TYPES) if (!P.KNOWN_PROPS[t]) bad.push("no KNOWN_PROPS for " + t);
  for (const t of Object.keys(P.KNOWN_PROPS)) {
    if (S.NODE_TYPES.indexOf(t) < 0) bad.push("KNOWN_PROPS has a type the IR does not: " + t);
    const T = P.KNOWN_PROPS[t];
    for (const p of ["relativeTransform", "width", "height"]) if (!T[p]) bad.push(t + " lacks " + p);
    for (const p of Object.keys(T)) {
      const k = T[p];
      if (!kindOk(k)) bad.push(t + "." + p + " has an unknown kind " + k);
      if (S.SUPERSEDED_PROPS.indexOf(p) >= 0) bad.push(t + "." + p + " is superseded");
      if ((k === "value") !== (S.INTERNED_PROPS.indexOf(p) >= 0)) bad.push(t + "." + p + ": kind value exactly when interned");
      if ((k === "style") !== Object.prototype.hasOwnProperty.call(S.STYLE_REFS, p)) bad.push(t + "." + p + ": kind style exactly for STYLE_REFS");
      if (S.GEOMETRY_PROPS.indexOf(p) >= 0 && S.VECTOR_TYPES.indexOf(t) < 0) bad.push(t + "." + p + ": geometry on a type that is not a vector type");
      if (k === "own" && S.IR_OWN_PROPS.indexOf(p) < 0) bad.push(t + "." + p + ": kind own, but not an IR-own prop");
    }
  }
  for (const p of Object.keys(P.RANGE_FIELDS)) {
    const k = P.RANGE_FIELDS[p];
    if (!kindOk(k) || k === "own") bad.push("RANGE_FIELDS." + p + " has kind " + k);
    if (k === "value" && S.INTERNED_PROPS.indexOf(p) < 0) bad.push("RANGE_FIELDS." + p + " is a value but not interned");
  }
  for (const p of P.NEVER_OMIT) {
    if (!Object.keys(P.KNOWN_PROPS).some((t) => P.KNOWN_PROPS[t][p])) bad.push("NEVER_OMIT " + p + " applies to no type");
    if (Object.prototype.hasOwnProperty.call(P.DEFAULTS, p)) bad.push("NEVER_OMIT " + p + " also has a default");
  }
  for (const p of Object.keys(P.DEFAULTS)) {
    const kinds = Object.keys(P.KNOWN_PROPS).map((t) => P.KNOWN_PROPS[t][p]).filter(Boolean).concat(P.RANGE_FIELDS[p] ? [P.RANGE_FIELDS[p]] : []);
    const v = P.DEFAULTS[p];
    if (!kinds.length) { bad.push("DEFAULTS." + p + " applies to no type"); continue; }
    if (S.IR_OWN_PROPS.indexOf(p) >= 0) bad.push("DEFAULTS." + p + " is an IR-own prop");
    for (const k of new Set(kinds)) {
      const good = k === "num" ? typeof v === "number" : k === "int" ? Number.isInteger(v) : k === "bool" ? typeof v === "boolean" : k === "str" ? typeof v === "string"
        : k === "value" ? (S.LIST_VALUES.indexOf(p) >= 0 ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v))
        : k.indexOf("enum:") === 0 ? k.slice(5).split("|").indexOf(v) >= 0 : false;
      if (!good) bad.push("DEFAULTS." + p + " = " + JSON.stringify(v) + " is not of its kind " + k);
    }
  }
  if (S.ORACLE_PROPS.some((p) => S.IR_OWN_PROPS.indexOf(p) < 0)) bad.push("an oracle prop that is not IR-own");
  for (const k of Object.keys(S.SETTINGS)) if (k !== "mode" && S.SETTINGS[k].indexOf(S.SETTING_DEFAULTS[k]) < 0) bad.push("SETTING_DEFAULTS." + k + " is not one of its values");
  if (bad.length) bad.forEach((b) => fail("props.mjs: " + b));
  else ok("props.mjs: every node type has its props, every kind is known, value and style kinds match INTERNED_PROPS and STYLE_REFS, geometry only on vector types, DEFAULTS of their kinds and apart from NEVER_OMIT; every setting has a default of its own values");
}

// ---------- the validator never throws, whatever it is given ----------
for (const [label, v] of [["null", null], ["an array", []], ["a string", "pix2fig.ir"], ["a number", 1],
  ["a header of null", { header: null }], ["records of the wrong kind", { header: header("pix"), nodes: [null, 3, "x"], pages: {} }]]) {
  try {
    const r = validate(v);
    if (r.ok) fail("garbage accepted: " + label);
    else ok("garbage refused without throwing: " + label + "  ->  " + r.errors[0].path + ": " + r.errors[0].message);
  } catch (e) { fail("the validator threw on " + label + ": " + e.message); }
}

// ---------- helpers ----------
if (valueSignature({ a: 1, b: [1, 2] }) === valueSignature({ b: [1, 2], a: 1 }) && valueSignature({ a: 1 }) !== valueSignature({ a: 2 })) ok("a value signature ignores key order and sees the value");
else fail("valueSignature is not a function of the value alone");
if (canonicalJSON({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}') ok("canonical JSON sorts keys at every depth");
else fail("canonicalJSON: " + canonicalJSON({ b: 1, a: { d: 2, c: 3 } }));
if (snapshotId(header("pix")) === "pix:" + SHA && snapshotId(header("mcp")) === "mcp:SyntheticFileKey000001@2026-01-02T03:04:05Z") ok("snapshot ids for both sources");
else fail("snapshotId: " + snapshotId(header("pix")) + " / " + snapshotId(header("mcp")));

// FNV-1a 64 without BigInt: the published test vectors, then agreement with a BigInt and
// TextEncoder reference (Node has both) on strings that exercise every UTF-8 length and lone
// surrogates, which TextEncoder turns into U+FFFD.
{
  const vectors = [["", "cbf29ce484222325"], ["a", "af63dc4c8601ec8c"], ["foobar", "85944171f73967e8"]];
  const bad = vectors.filter(([s, h]) => fnv1a64(s) !== h);
  if (bad.length) fail("fnv1a64 test vectors: " + bad.map(([s, h]) => JSON.stringify(s) + " gives " + fnv1a64(s) + ", not " + h).join("; "));
  else ok("fnv1a64 gives the published FNV-1a 64 test vectors");
  const ref = (s) => {
    const bytes = new TextEncoder().encode(s);
    let h = 0xcbf29ce484222325n;
    for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return h.toString(16).padStart(16, "0");
  };
  // A fixed pseudo-random sequence, so a failure reproduces.
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const samples = ["Текст ✓", "😀 grin", "\ud800", "a\udc00b", "x\ud83d", "\u007f\u0080߿ࠀ￿"];
  for (let i = 0; i < 3000; i++) { let s = ""; for (let j = rnd(24); j > 0; j--) s += String.fromCharCode(rnd(65536)); samples.push(s); }
  const differ = samples.filter((s) => fnv1a64(s) !== ref(s));
  if (differ.length) fail("fnv1a64 disagrees with the BigInt reference on " + differ.length + " of " + samples.length + " strings, e.g. " + JSON.stringify(differ[0]));
  else ok("fnv1a64 agrees with a BigInt and TextEncoder reference on " + samples.length + " strings");
}

// The validator runs where neither TextEncoder nor BigInt nor any Node global exists, as the
// plugin's main-thread sandbox may be: its source is evaluated in a bare context with those
// names removed, and must give the same answers as the module.
// The same holds for every module the plugin bundles (tools/build-plugin.mjs): no import, nothing
// the sandbox may lack, and `export` only at the start of a line, where the bundler strips it.
const BUNDLED = ["schema.mjs", "props.mjs"];
{
  const banned = [[/^\s*import\b/m, "an import"], [/\bTextEncoder\b/, "TextEncoder"], [/\b(?:0x[0-9a-f]+|\d+)n\b/i, "a BigInt literal"], [/\bBigInt\s*\(/, "a BigInt call"],
    [/\S[ \t]*\bexport\s/, "an export that is not at the start of a line"], [/^export\s+(?!const |function )/m, "an export other than export const or export function"]];
  const uses = (code) => banned.filter(([re]) => re.test(code)).map(([, what]) => what);
  // Whole-line comments may name what the code avoids; only code counts.
  const codeOf = (f) => readFileSync(join(HERE, "ir", f), "utf8").split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const planted = uses("import x from \"y\";\nconst b = new TextEncoder().encode(s);\nlet h = 0xcbf29ce484222325n;\nh ^= BigInt(b);\nconst q = 1; export const r = 2;\nexport default 3;");
  if (planted.length !== banned.length) fail("the sandbox scan misses planted uses: found only " + planted.join(", "));
  for (const f of BUNDLED) {
    const found = uses(codeOf(f));
    if (found.length) fail("tools/ir/" + f + " uses " + found.join(", ") + ", which the plugin sandbox or the bundler cannot take");
    else ok("tools/ir/" + f + " has no import, TextEncoder or BigInt, and exports only at line starts (the scan finds all six when planted)");
  }
  const code = codeOf("schema.mjs");
  try {
    const bareProps = runInNewContext(codeOf("props.mjs").replace(/^export (const|function) /gm, "$1 ") + "\n;({ KNOWN_PROPS, RANGE_FIELDS, NEVER_OMIT, DEFAULTS });",
      { TextEncoder: undefined, TextDecoder: undefined, BigInt: undefined });
    const bare = runInNewContext(code.replace(/^export (const|function) /gm, "$1 ") + "\n;({ validateIR, valueSignature });",
      { TextEncoder: undefined, TextDecoder: undefined, BigInt: undefined });
    const cases = [example ? ["the docs example", example] : null, ["a broken IR", mut(minimal, (ir) => { ir.nodes[0].parent = 3; ir.header.settings.drift = "x"; ir.nodes[0].props.opacity = "1"; })]].filter((c) => c && c[1]);
    const same = cases.every(([, ir]) => JSON.stringify(bare.validateIR(clone(ir), { props: bareProps })) === JSON.stringify(validate(clone(ir))));
    const sig = bare.valueSignature({ a: "Текст", b: [1, 2.5] }) === valueSignature({ a: "Текст", b: [1, 2.5] });
    if (same && sig) ok("the validator gives the same answers in a context without TextEncoder, BigInt or Node globals (" + cases.map((c) => c[0]).join(", ") + ")");
    else fail("the validator answers differently without TextEncoder and BigInt");
  } catch (e) { fail("the validator does not run without TextEncoder, BigInt or Node globals: " + e.message); }
}

// ---------- the vocabulary: code, docs/IR.md and docs/REWRITE.md agree ----------
{
  const inDoc = new Map();
  for (const m of IR_MD.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| (run|read|plan|build) \|/gm)) inDoc.set(m[1], m[2]);
  const missing = Object.keys(REASON_CODES).filter((c) => !inDoc.has(c));
  const extra = [...inDoc.keys()].filter((c) => !REASON_CODES[c]);
  const stage = [...inDoc.keys()].filter((c) => REASON_CODES[c] && REASON_CODES[c].stage !== inDoc.get(c));
  if (missing.length || extra.length || stage.length) fail("docs/IR.md and REASON_CODES disagree: missing in docs " + missing.join(",") + "; unknown to code " + extra.join(",") + "; stage differs " + stage.join(","));
  else ok("all " + inDoc.size + " reason codes are documented in docs/IR.md, with their stage");
  const named = Object.keys(REASON_CODES).filter((c) => REASON_CODES[c].plan === null);
  const unexplained = named.filter((c) => !REASON_CODES[c].from);
  if (unexplained.length) fail("codes named here without the REWRITE.md sentence they come from: " + unexplained.join(","));
  else ok(named.length + " codes named by the IR for conditions REWRITE.md counts without naming, each with its source sentence");
}
{
  // The run's own reports use the same vocabulary: every code the run writes into states.json
  // (reason, stopReason) or throws from the reader is in it. In those two files every quoted
  // UPPER_SNAKE string is such a code; anything else written that way there would have to be listed.
  const SOURCES = ["extract-lib.mjs", "kiwi.mjs"];
  const used = new Map();
  for (const s of SOURCES) {
    const src = readFileSync(join(HERE, s), "utf8");
    for (const m of src.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)) if (!used.has(m[1])) used.set(m[1], s);
  }
  const unknown = [...used.keys()].filter((c) => !REASON_CODES[c]);
  const expect = ["PIXSO_UNAVAILABLE", "EXTRACT_FAILED", "NO_ID", "IDENTITY_CHANGED", "PIX_CORRUPT", "PIX_UNSUPPORTED"];
  const unseen = expect.filter((c) => !used.has(c));
  if (unseen.length) fail("the scan of " + SOURCES.join(", ") + " misses codes they are known to write: " + unseen.join(", "));
  else if (unknown.length) fail("codes the run writes that the vocabulary lacks: " + unknown.map((c) => c + " (" + used.get(c) + ")").join(", "));
  else ok("every one of the " + used.size + " codes the run writes (" + SOURCES.join(", ") + ") is in the vocabulary");
}
{
  // Every M1 file writes codes as CODE.X, never quoted (docs/M1.md §5.1): a quoted code in one of them
  // is a failure, and so is a CODE.X that names no code. Figma's and Pixso's enum values look the
  // same (SPACE_BETWEEN) and are not codes, so only a quoted name that IS a code is flagged.
  const quotedCodes = (src) => [...src.matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g)].map((m) => m[1]).filter((c) => REASON_CODES[c]);
  const badRefs = (src) => [...src.matchAll(/\bCODE\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]).filter((c) => !Object.prototype.hasOwnProperty.call(REASON_CODES, c));
  const planted = "note(\"PIX_CORRUPT\"); ctx.code('BOOLEAN_FALLBACK'); x = CODE.NOT_A_CODE; y = CODE.PIX_CORRUPT; z = \"SPACE_BETWEEN\";";
  if (quotedCodes(planted).join() !== "PIX_CORRUPT,BOOLEAN_FALLBACK" || badRefs(planted).join() !== "NOT_A_CODE") fail("the M1 vocabulary scan misses planted uses: " + quotedCodes(planted) + " / " + badRefs(planted));
  const list = (dir, re) => { try { return readdirSync(join(ROOT, dir)).filter((f) => re.test(f)).map((f) => dir + "/" + f); } catch (e) { return []; } };
  const files = [].concat(list("tools/pix/ir", /\.mjs$/), list("tools/ir", /\.mjs$/), list("figma-plugin/src/ir", /\.js$/),
    ["tools/pix/network.mjs", "tools/pix-to-ir.mjs", "tools/pix-run.mjs", "tools/m1-accept.mjs"].filter((f) => existsSync(join(ROOT, f))));
  const hits = [];
  for (const f of files) {
    // Whole-line comments may name a code to explain it; only code counts.
    const src = readFileSync(join(ROOT, f), "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    for (const c of quotedCodes(src)) hits.push(f + ": quoted " + c + " (write CODE." + c + ")");
    for (const c of badRefs(src)) hits.push(f + ": CODE." + c + " names no code");
  }
  if (!files.some((f) => f === "tools/ir/schema.mjs")) fail("the M1 vocabulary scan found no tools/ir/schema.mjs to scan");
  else if (hits.length) hits.forEach((h) => fail("M1 vocabulary: " + h));
  else ok("no quoted code and no unknown CODE.X in the " + files.length + " M1 files (the scan finds both when planted)");
  const frozen = Object.isFrozen(CODE) && Object.keys(CODE).length === Object.keys(REASON_CODES).length && Object.keys(CODE).every((k) => CODE[k] === k && REASON_CODES[k]);
  if (frozen) ok("CODE is a frozen map of every code to itself");
  else fail("CODE is not a frozen map of every code to itself");
}
{
  // The plan may live in this tree (after it merges) or only on its branch. Enum values of Pixso
  // and Figma are written the same way and are not codes; tools/ir/not-codes.json lists them.
  const NOT_CODES = new Set(JSON.parse(readFileSync(join(HERE, "ir", "not-codes.json"), "utf8")).notCodes);
  let plan = null, from = null;
  const local = join(ROOT, "docs", "REWRITE.md");
  if (existsSync(local)) { plan = readFileSync(local, "utf8"); from = "docs/REWRITE.md"; }
  else {
    for (const ref of ["claude/rewrite-plan", "origin/claude/rewrite-plan"]) {
      try { plan = execFileSync("git", ["-C", ROOT, "show", ref + ":docs/REWRITE.md"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); from = ref; break; } catch (e) { /* next */ }
    }
  }
  if (!plan) console.log("skip the plan's codes: docs/REWRITE.md is neither in this tree nor on a local branch");
  else {
    const codes = new Set((plan.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || []).filter((c) => !NOT_CODES.has(c)));
    const missing = [...codes].filter((c) => !REASON_CODES[c]);
    const stale = Object.keys(REASON_CODES).filter((c) => REASON_CODES[c].plan !== null && !codes.has(c));
    if (missing.length) fail("codes REWRITE.md names that the vocabulary lacks (" + from + "): " + missing.join(", "));
    else ok("every one of the " + codes.size + " codes REWRITE.md names is in the vocabulary (" + from + ")");
    if (stale.length) fail("codes marked as the plan's that it no longer names: " + stale.join(", "));
    else ok("every code attributed to REWRITE.md is still named there");
  }
}

console.log("");
console.log(failed ? failed + " IR check" + (failed === 1 ? "" : "s") + " FAILED" : "all IR checks pass");
process.exit(failed ? 1 : 0);

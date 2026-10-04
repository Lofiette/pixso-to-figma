// The IR schema, checked with neither editor and no real file.
//
//   node tools/test-ir.mjs
//
// Every IR here is synthetic. Valid ones must pass; each kind of broken one must fail, and fail at
// the path that names the broken thing, because "the IR is invalid" with no path is a support
// conversation. The complete example in docs/IR.md is validated too, so the document and the
// validator cannot drift apart unnoticed.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIR, valueSignature, snapshotId, canonicalJSON, REASON_CODES } from "./ir/schema.mjs";

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
    format: "pix2fig.ir", version: 1,
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
      resync: "pixso-unless-edited", textFit: "widen", kitmaps: "default" },
  };
}

// The smallest useful IR: one page, one frame.
const minimal = () => ({
  header: header("pix"),
  pages: [{ guid: "0:1", name: "Page 1", internal: false }],
  values: [],
  nodes: [{ parent: -1, page: 0, guid: "1:2", type: "FRAME", name: "Frame", props: { width: 10, height: 10 } }],
});

// An MCP IR: an instance of a master that is not in the IR, known only by library and componentKey,
// with overrides found by comparison (resolved), and ink bounds the live renderer provides.
const mcp = () => ({
  header: header("mcp"),
  pages: [{ guid: "0:1", name: "Page 1", internal: false }],
  values: [[{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }]],
  nodes: [
    { parent: -1, page: 0, guid: "1:2", type: "FRAME", name: "Frame", props: { width: 100, height: 50, inkBounds: [0, 0, 100, 50] } },
    { parent: 0, guid: "1:3", type: "INSTANCE", name: "Icon",
      instance: {
        master: { library: { publishFile: LIB, componentKey: "c0ffee" + "0".repeat(33) + "3" } },
        overrides: [{ path: ["7:1"], fields: { fills: 0 } }],
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
  try { r = validateIR(ir); } catch (e) { fail(label + ": the validator threw: " + e.message); return; }
  if (r.ok && r.errors.length === 0) ok(label);
  else fail(label + ": " + r.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join(" | "));
}
// Fails unless the IR is refused AND one of the errors is at exactly the path that names the fault.
function expectError(label, ir, path, onlyOne) {
  let r;
  try { r = validateIR(ir); } catch (e) { fail(label + ": the validator threw: " + e.message); return; }
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
expectError("unknown version", mut(minimal, (ir) => { ir.header.version = 2; ir.nodes[0].parent = 5; }), "header.version", true);
expectError("a version written as a string", mut(minimal, (ir) => { ir.header.version = "1"; }), "header.version", true);
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
if (example) expectError("a record under an instance", mut(rich, (ir) => { ir.nodes.push({ parent: 1, guid: "1:90", type: "TEXT", name: "T" }); }), "nodes[11].parent");

// ---------- dictionary and table indexes ----------
if (example) {
  expectError("dictionary index out of range", mut(rich, (ir) => { ir.nodes[0].props.fills = 99; }), "nodes[0].props.fills");
  expectError("dictionary index in a text range", mut(rich, (ir) => { ir.nodes[3].props.textRanges[0].fields.fills = 5; }), "nodes[3].props.textRanges[0].fields.fills");
  expectError("dictionary index in an override", mut(rich, (ir) => { ir.nodes[1].instance.overrides[0].fields.fills = -1; }), "nodes[1].instance.overrides[0].fields.fills");
  expectError("style index out of range", mut(rich, (ir) => { ir.nodes[3].props.fillStyle = 4; }), "nodes[3].props.fillStyle");
  expectError("a paint style used as a text style", mut(rich, (ir) => { ir.nodes[3].props.textStyle = 0; }), "nodes[3].props.textStyle");
  expectError("a text range outside the characters", mut(rich, (ir) => { ir.nodes[3].props.textRanges[0].end = 99; }), "nodes[3].props.textRanges[0]");
  expectError("an image paint whose hash is not listed", mut(rich, (ir) => { ir.images = []; }), "values[2][0].imageHash");
  expectError("a font that is not declared", mut(rich, (ir) => { ir.fonts = []; }), "nodes[3].props.fontName");
  expectError("a value interned twice", mut(rich, (ir) => { ir.values.push({ style: "Regular", family: "Inter" }); }), "values[5]");
  expectError("fills pointing at a value that is not a list", mut(rich, (ir) => { ir.nodes[0].props.fills = 3; }), "nodes[0].props.fills");
  expectError("a line count that is not a count", mut(rich, (ir) => { ir.nodes[3].props.lines = "one"; }), "nodes[3].props.lines");
  expectError("a page and a node sharing a guid", mut(rich, (ir) => { ir.pages[1].guid = "2:30"; }), "nodes[9].guid");
  expectError("a style and a node sharing a guid", mut(rich, (ir) => { ir.styles[0].guid = "1:13"; }), "styles[0].guid");
  expectError("a derived box outside the master", mut(rich, (ir) => { ir.nodes[1].instance.derived[0].path = ["2:31"]; }), "nodes[1].instance.derived[0].path[0]");
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
  }), "nodes[11].instance.master");
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

// ---------- the validator never throws, whatever it is given ----------
for (const [label, v] of [["null", null], ["an array", []], ["a string", "pix2fig.ir"], ["a number", 1],
  ["a header of null", { header: null }], ["records of the wrong kind", { header: header("pix"), nodes: [null, 3, "x"], pages: {} }]]) {
  try {
    const r = validateIR(v);
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
  // The plan may live in this tree (after it merges) or only on its branch. Enum values of Pixso
  // and Figma are written the same way and are not codes.
  const NOT_CODES = new Set(["FOREGROUND_BLUR", "LAYER_BLUR", "SPACE_BETWEEN", "SPACE_EVENLY"]);
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

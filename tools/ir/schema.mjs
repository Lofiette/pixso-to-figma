// The IR, version 2: what a source (a saved .pix or live Pixso) tells the builder, as data only.
// docs/IR.md describes it; this file is the part of that description a program can check.
//
//   import { validate } from "./ir/validate.mjs";   // every caller: it passes the prop tables in
//   const { ok, errors } = validate(ir);             // errors: [{ path: "nodes[3].parent", message }]
//
//   validateIR(ir, { props, maxErrors })             // the same check with the tables given as data;
//                                                    // props = tools/ir/props.mjs; throws without it
//
// Dependency-free, free of Node built-ins, and free of TextEncoder and BigInt, which the plugin's
// main-thread sandbox may lack: the runner refuses an IR before anything is built, and the plugin
// bundles this file (tools/build-plugin.mjs, as PXF_SCHEMA) for its codes and enums. tools/test-ir.mjs
// runs it in a context without them. Its syntax is ES2015 (const, arrow functions, Map, Set,
// for-of). It imports nothing, so the per-type prop tables (tools/ir/props.mjs) come in as data.
//
// What it checks is structure and reference integrity — the things that, wrong, make the builder
// do something silently different from what the reader meant: an unknown format or version, the
// header, parent-first order, every index into a table, every reason code, every master reference,
// the props each node type may carry and their kinds, vector build sources, path and network
// shapes, and that the content never claims more than the header's capabilities declare. It does
// not re-derive what the reader decided (variant parsing, swap-aware path resolution, stale and echo
// classification, the side rule, boolean classes); those have their own tests where they are
// computed.
//
// New code never writes a reason code as a quoted string: it writes CODE.X (below), and
// tools/test-ir.mjs fails on a quoted code in any M1 file and on a CODE.X that names no code.

export const FORMAT = "pix2fig.ir";
export const VERSION = 2;

export const SOURCE_KINDS = ["pix", "mcp"];
export const SCOPE_KINDS = ["file", "pages", "page", "selection"];

// What the source can provide. The builder, the kit-map resolver and the verifier use only what
// the header declares (REWRITE.md §4), so a validator that let content through without its
// capability would let a consumer rely on something the source never promised.
export const CAPABILITY_KEYS = ["authoredOverrides", "resolvedOverrides", "overrideKeys", "publishIds",
  "symbolVersions", "derivedBoxes", "inkBounds", "renders"];

// The owner's policies (REWRITE.md §11), each a designer-changeable setting, recorded so two runs
// are comparable. kitmaps is a directory, not an enum, and is checked separately.
export const SETTINGS = {
  mode: ["design", "kit"],
  overrides: ["fidelity", "link"],
  drift: ["link", "local"],
  deleted: ["publish", "skip"],
  resync: ["pixso-unless-edited", "report-only"],
  textFit: ["widen", "source-box"],
  // docs/M1.md D5 and D14: how a boolean is carried, and where a single flow child of SPACE_EVENLY goes.
  booleans: ["auto", "native", "flatten"],
  spaceEvenlySingle: ["between", "center"],
};
export const SETTING_KEYS = Object.keys(SETTINGS).concat(["kitmaps"]);
export const SETTING_FLAGS = { mode: "--mode", overrides: "--overrides", drift: "--drift", deleted: "--deleted",
  resync: "--resync", textFit: "--text-fit", booleans: "--booleans", spaceEvenlySingle: "--space-evenly-single",
  kitmaps: "--kitmaps" };
// The owner's default for each (docs/M1.md §3, REWRITE.md §11). mode has none: it is chosen per run.
export const SETTING_DEFAULTS = { overrides: "fidelity", drift: "link", deleted: "publish",
  resync: "pixso-unless-edited", textFit: "widen", booleans: "auto", spaceEvenlySingle: "center", kitmaps: "default" };   // spaceEvenlySingle: P18, 2026-10-05

// Figma's node types, which the IR speaks. Pixso never produces SLOT, but the Figma Сова kit uses
// it inside its components, and the matcher and verifier read Figma trees with this same list.
export const NODE_TYPES = ["FRAME", "GROUP", "SECTION", "COMPONENT", "COMPONENT_SET", "INSTANCE",
  "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE", "VECTOR", "BOOLEAN_OPERATION", "TEXT", "SLICE", "SLOT"];

// Variants are not a property type in Pixso and are not one here either: a variant is an axis on
// its set and a coordinate on each member.
export const PROPERTY_TYPES = ["BOOLEAN", "TEXT", "INSTANCE_SWAP"];
export const STYLE_TYPES = ["PAINT", "TEXT", "EFFECT", "GRID"];
export const IMAGE_FORMATS = ["png", "jpeg", "webp", "gif", "unknown"];
export const OVERRIDE_BASES = ["authored", "resolved"];

// Properties whose value is an index into `values`, wherever they appear: node props, text range
// fields and override fields. Today's payload interns the same kinds (pack4.mjs).
// Version 2 adds the oracle geometry (docs/M1.md D3) and two text range objects, hyperlink and
// listOptions, which travel as range fields and are interned like any other.
export const INTERNED_PROPS = ["fills", "strokes", "effects", "layoutGrids", "exportSettings", "dashPattern",
  "constraints", "fontName", "letterSpacing", "lineHeight", "arcData", "vectorNetwork", "fillGeometry",
  "strokeGeometry", "oracleFillGeometry", "hyperlink", "listOptions"];
// Of those, the ones whose value is a list; the rest point at an object.
export const LIST_VALUES = ["fills", "strokes", "effects", "layoutGrids", "exportSettings", "dashPattern", "fillGeometry",
  "strokeGeometry", "oracleFillGeometry"];
// Properties whose value is an index into `styles`, and the style type each must point at.
export const STYLE_REFS = { fillStyle: "PAINT", strokeStyle: "PAINT", textStyle: "TEXT", effectStyle: "EFFECT",
  gridStyle: "GRID" };
// Keys of props.componentPropertyReferences, and the property type each may be bound to.
export const PROPERTY_REF_FIELDS = { characters: "TEXT", visible: "BOOLEAN", mainComponent: "INSTANCE_SWAP" };

// ---------- version 2: props, vectors, oracles ----------
// The node types drawn from paths. A VECTOR record is built from exactly one source, its
// vectorNetwork or its fillGeometry (docs/M1.md D3). LINE, STAR, POLYGON and BOOLEAN_OPERATION are
// built natively (a boolean from its operands) and carry no build-source geometry, only, optionally,
// the oracle of what Pixso drew.
export const VECTOR_TYPES = ["VECTOR", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION"];
export const NATIVE_VECTOR_TYPES = ["LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION"];
export const GEOMETRY_PROPS = ["vectorNetwork", "fillGeometry", "strokeGeometry", "oracleFillGeometry"];
// The IR's own props (docs/IR.md §7): not Figma properties, or not written to Figma as they stand.
export const IR_OWN_PROPS = ["relativeTransform", "width", "height", "strokeWeights", "cornerRadii", "textRanges",
  "lines", "inkBounds", "fillStyle", "strokeStyle", "textStyle", "effectStyle", "gridStyle",
  "componentPropertyReferences", "oracleFillGeometry", "oracleSides"];
// What Pixso drew, kept for the judge and never sent to the plugin: the planner strips these from
// every task (docs/M1.md §5.2), and tools/ir/task.mjs refuses a task that carries one.
export const ORACLE_PROPS = ["oracleFillGeometry", "oracleSides"];
// Figma properties the IR expresses another way. Version 1 let them through; version 2 refuses them,
// so a record never says one thing twice in two ways that could disagree.
export const SUPERSEDED_PROPS = ["x", "y", "rotation", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight",
  "strokeLeftWeight", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
export const SUPERSEDED_BY = { x: "relativeTransform", y: "relativeTransform", rotation: "relativeTransform",
  strokeTopWeight: "strokeWeights", strokeRightWeight: "strokeWeights", strokeBottomWeight: "strokeWeights",
  strokeLeftWeight: "strokeWeights", topLeftRadius: "cornerRadii", topRightRadius: "cornerRadii",
  bottomRightRadius: "cornerRadii", bottomLeftRadius: "cornerRadii" };
// The classes of VECTOR_ORACLE_DIFFERS, pre-registered (docs/M1.md §8.3). The note's detail is the
// class, optionally followed by ": " and free text; the judge excuses only that class.
export const ORACLE_CLASSES = ["region-no-fill", "network-bounds", "winding"];
// The class a BOOLEAN_OPERATION record's VECTOR_ORACLE_DIFFERS takes (docs/M1.md §15.13): its stored
// result is out of date against its own operands (tools/ir/operands.mjs), so the judge holds it to
// them; the vector classes above are for VECTOR records built from their network.
export const BOOLEAN_ORACLE_CLASSES = ["boolean-operands"];
export const WINDING_RULES = ["NONZERO", "EVENODD"];
export const HANDLE_MIRRORING = ["NONE", "ANGLE", "ANGLE_AND_LENGTH"];
// The prop kinds of tools/ir/props.mjs, plus "enum:A|B|…". `own` is an IR-own prop whose rule is
// written out in the validator below.
export const PROP_KINDS = ["num", "int", "bool", "str", "value", "style", "own"];

// ---------- reason codes ----------
// One vocabulary for IR notes and for run reports. `plan` is where docs/REWRITE.md names the code;
// null marks the codes this IR names for conditions REWRITE.md counts without naming them, each
// with the sentence it comes from in `from`. Stages: run (the run's own: it stops the run, or fails
// or skips one object of it), read (source -> IR), plan (preflight and kit-map resolution), build
// (in Figma). Every code the run writes today (tools/extract-lib.mjs, tools/kiwi.mjs) is here, and
// tools/test-ir.mjs fails on one that is not.
export const REASON_CODES = {
  PIX_CORRUPT: { stage: "run", plan: "§6", meaning: "the .pix is truncated, uses a field id its schema does not define, or does not end on its last byte; nothing is built" },
  PIX_UNSUPPORTED: { stage: "run", plan: null, from: "§6: the runner requires Node 22.15 or newer (built-in zstd); a .pix that cannot be read stops the run with PIX_CORRUPT before anything is built", meaning: "the .pix is sound but in a form the reader does not read (another compression, a second zstd frame, a Node without zstd); nothing is built" },
  IDENTITY_CHANGED: { stage: "run", plan: "§4", meaning: "after a reconnect the file open in Pixso is not the file being read; the run stops" },
  KIT_FILEKEY_CONFLICT: { stage: "run", plan: "§5", meaning: "sources disagree about a kit's own Pixso file key; the run stops and no kit map is written" },
  PIXSO_UNAVAILABLE: { stage: "run", plan: null, from: "§6: the run stops issuing work, writes the checkpoint and says \"Pixso stopped answering at object X: N done, M left\"", meaning: "the Pixso channel's circuit breaker: the object whose call did not reach Pixso fails, and if Pixso is not back within 10 minutes the run stops and the rest are skipped; a re-run resumes" },
  EXTRACT_FAILED: { stage: "run", plan: null, from: "§6: the verdict counts them, so a failed extraction is a failed object", meaning: "Pixso answered and the object's extraction still failed; the whole error is in its extract-error.log, and a re-run tries it again" },
  NO_ID: { stage: "run", plan: null, from: "§6: every object ends in a recorded state: built, built-with-fallbacks, failed or skipped", meaning: "reading the file gave the object no id, so it cannot be extracted; it is skipped and counted as a loss" },

  VARIANT_SET_REJECTED: { stage: "read", plan: "§3", meaning: "a state group whose member names do not parse into one set of axes; its members become standalone components" },
  STALE_ASSIGNMENT: { stage: "read", plan: "§3", meaning: "a property assignment whose definition cannot be reached from the instance's current family; dropped, never matched by name" },
  STYLE_MISSING_IN_SOURCE: { stage: "read", plan: "§3", meaning: "a style reference that resolves to no style definition of its kind in the file, or to one with no value there; the node keeps its own values, unbound" },
  STYLE_VALUE_DIFFERS: { stage: "read", plan: "§3", meaning: "the node's own value differs from its resolved style's by more than 1/255 per channel or unit; Pixso draws the style's, so the style's value is written and the style bound (the node's own is a stale copy)" },
  VECTOR_FROM_GEOMETRY: { stage: "read", plan: "§3", meaning: "a vector with fill geometry but no region, built from its stored fill and stroke geometry" },
  OVERRIDE_STALE: { stage: "read", plan: null, from: "§3: entries whose path is absent from derivedSymbolData are provably stale: dropped and counted", meaning: "an override entry whose path is absent from derivedSymbolData; dropped" },
  OVERRIDE_ECHO: { stage: "read", plan: null, from: "§3: many override fields only echo the master's value and must be dropped before applying", meaning: "an override field equal to the master's value; dropped" },
  NODE_TYPE_UNSUPPORTED: { stage: "read", plan: null, from: "§7: coverage, with every loss given a reason code; §8: the fixture covers an unsupported node type", meaning: "a source node of a type the IR has no type for; it and its subtree are not carried" },
  // M1 (docs/M1.md §5.1).
  TEXT_LINES_UNKNOWN: { stage: "read", plan: null, from: "§3: Pixso's own line breaks are stored, which gives a direct check for the one-pixel heading wrap (decision 9)", meaning: "a buildable text with no stored baselines; it carries no lines, so its line count is not checked" },
  SOURCE_FEATURE_UNSUPPORTED: { stage: "read", plan: null, from: "§7: Source vs IR. Coverage, with every loss given a reason code", meaning: "a Pixso feature Figma lacks; the detail starts with the feature, from an open list (CONNECTLINE, LINE with height, SECTION strokes, SECTION corner radius, RIGHT_ANGLE, vibrance, hue filter, dashCap, deformationTransform, fontVariations, GRID, counter alignment <X>, strokeCap <X>, effect <TYPE>, an exportSettings format, paint type <X>, image paint without an image, text without a font name, inverse winding, open region loop, operand strokes, an operand without fill geometry, boolean without stored geometry, built natively); dropped or converted, and counted" },
  GEOMETRY_INVALID: { stage: "read", plan: null, from: "§7: Source vs IR. Coverage, with every loss given a reason code", meaning: "a NaN size, transform or path, or a boolean with no operand and no geometry; the box comes from the geometry or the children, or the node is not carried" },
  IMAGE_HASH_MISMATCH: { stage: "read", plan: null, from: "§4: Pixso MCP bytes by hash (the SHA-1 is checked)", meaning: "an archive image entry whose SHA-1 is not its name; it is treated as missing (a file-level note: no node, the name in the detail)" },
  VECTOR_ORACLE_DIFFERS: { stage: "read", plan: null, from: "§3: Regions and fillGeometry disagree on 35 and 220 vectors", meaning: "the stored network and the stored fill geometry disagree in a pre-registered class (region-no-fill, network-bounds, winding), or a boolean's stored result is out of date against its operands (boolean-operands); the judge excuses only that class" },
  SIDE_RULE_UNPROVEN: { stage: "read", plan: null, from: "§3: The stored stroke-area path proves how per-side weights work", meaning: "the side rule and the stroke-area path disagree; the IR follows the path" },
  BOOLEAN_FLATTENED: { stage: "read", plan: null, from: "§7: Source vs IR. Coverage, with every loss given a reason code", meaning: "a boolean carried as one VECTOR from its stored fill geometry; its operands are not carried" },
  OUT_OF_SCOPE: { stage: "plan", plan: null, from: "§6: Every object ends in a recorded state: built, built-with-fallbacks, failed or skipped", meaning: "an IR record the chosen M1 scope does not build; the detail names its population" },
  FONT_MISSING: { stage: "plan", plan: null, from: "§4: missing fonts are listed in the preflight table with install, restart Figma, run again", meaning: "an IR font Figma does not have, listed in the preflight; the run stops unless the designer continues" },
  SOURCE_IDENTITY_MISMATCH: { stage: "plan", plan: null, from: "§4: Before it uses Pixso for renders, the runner checks that the open file matches the .pix (root name, page ids, a sample of node ids)", meaning: "the file open in Pixso is not the .pix; the MCP image links are skipped" },
  VECTOR_NETWORK_REFUSED: { stage: "build", plan: null, from: "§10 M1: for every vector, VERIFY's fill path count and per-path bounds equal the .pix fillGeometry within 1 px, or the vector carries a reason code", meaning: "setVectorNetworkAsync threw; the vector keeps no paths" },
  BOOLEAN_FALLBACK: { stage: "build", plan: null, from: "§6: Every object ends in a recorded state: built, built-with-fallbacks, failed or skipped", meaning: "Figma threw on the boolean operation; the operands stay in a frame" },
  MASK_UNSUPPORTED: { stage: "build", plan: null, from: "§7: Source vs IR. Coverage, with every loss given a reason code", meaning: "Figma refused or ignored a mask on a group built as a frame; built unmasked" },
  VECTOR_GEOMETRY_DIFFERS: { stage: "build", plan: null, from: "§10 M1: for every vector, VERIFY's fill path count and per-path bounds equal the .pix fillGeometry within 1 px, or the vector carries a reason code", meaning: "the judge found a vector whose built paths differ from the oracle outside every excuse; a defect" },
  TEXT_LINES_DIFFER: { stage: "build", plan: null, from: "§10 M1: every text whose Figma line count differs from Pixso's stored baselines is counted and named", meaning: "the built text's line count differs from the stored baselines" },
  PLUGIN_STALLED: { stage: "run", plan: null, from: "§6: The runner warns after 60 s without an advance, and stops the run (FAIL, resumable) after 5 min without one, or when a per-task ceiling scaled by node count is reached", meaning: "the progress counter did not advance for the fail time, or the task passed its ceiling; the task failed and is resumable" },
  BUILD_FAILED: { stage: "run", plan: null, from: "§6: Full error text is kept, in the local run log", meaning: "the plugin refused the task or threw outside a counted fallback; the full error is kept" },
  ROOT_NOT_FOUND: { stage: "run", plan: null, from: "§4: Resume, clean and verify find nodes by stamp, as today", meaning: "VERIFY found no root for the task, by registry or by stamp" },

  KIT_MAP_MISSING: { stage: "plan", plan: "§5", meaning: "no kit map is loaded for the copy's library; a local copy is built" },
  MASTER_NOT_IN_MAP: { stage: "plan", plan: "§5", meaning: "the kit map has no entry publishFile@publishID; a local copy is built" },
  MASTER_NOT_BUILT: { stage: "plan", plan: "§5", meaning: "the kit map lists the master but it was not built in the Figma kit; a local copy is built" },
  MASTER_HIDDEN: { stage: "plan", plan: "§5", meaning: "the kit master is hidden in the Figma kit; a local copy is built" },
  IMPORT_FAILED: { stage: "plan", plan: "§5", meaning: "importing the Figma key failed in preflight; a local copy is built" },
  VERSION_DRIFT: { stage: "plan", plan: "§5", meaning: "sharedSymbolVersion differs from the kit map's; linked if every touched layer still maps (decision 2)" },
  DRIFT_UNMAPPABLE: { stage: "plan", plan: "§5", meaning: "a drifted or MCP-read copy whose touched layers do not all map to the kit master; a local copy is built" },
  STYLE_NOT_IN_MAP: { stage: "plan", plan: "§5", meaning: "a library style with no entry in its kit map; raw values are kept" },
  PROP_NOT_IN_MAP: { stage: "plan", plan: "§5", meaning: "a property assignment the kit map cannot translate (decision 1)" },
  SWAP_TARGET_UNMAPPED: { stage: "plan", plan: "§5", meaning: "an instance swap whose target master is not in any loaded kit map (decision 1)" },
  OVERRIDE_PATH_UNRESOLVED: { stage: "plan", plan: "§5", meaning: "an override path that does not translate hop by hop to a kit layer (decision 1)" },
  OVERRIDE_VIA_LOCAL_MIRROR: { stage: "plan", plan: "§5", meaning: "warning: an override translated through an unpublished local duplicate of the library set, matched exactly once" },
  OVERRIDE_FIELD_UNSUPPORTED: { stage: "plan", plan: "§5, §9 P13", meaning: "an override field Figma refuses or ignores on instance sublayers (size, position, rotation, constraints); decision 1" },

  OVERRIDE_APPLY_FAILED: { stage: "build", plan: "§5", meaning: "Figma threw while applying an override (decision 1)" },
  INSTANCE_DEFERRED: { stage: "build", plan: "§10 M1", meaning: "an instance built as a counted placeholder with the instance's box, until components land" },
  TEXT_WIDENED_TO_SOURCE_LINES: { stage: "build", plan: "§11 decision 9", meaning: "a text Pixso draws on one line, widened so Figma does too" },
  IMAGE_PLACEHOLDER: { stage: "build", plan: null, from: "§4: a counted placeholder. A missing image is never an empty fill", meaning: "no bytes for an image hash from the archive, Pixso or a render; a placeholder is drawn" },
  FILTER_UNRENDERED: { stage: "build", plan: null, from: "§4: the placeholder and unrendered-filter counts", meaning: "a filter Figma lacks (Hue and others) that could not be rendered by Pixso; the paint is built without it" },
  FONT_SUBSTITUTED: { stage: "build", plan: null, from: "§4: every substitution is counted per node and per style", meaning: "a font missing in Figma; the text falls back to the fixed font" },
  STYLE_TARGET_NOT_BUILT: { stage: "build", plan: null, from: "§3: a soft-deleted target is bound if it was built; otherwise raw values are kept and counted", meaning: "the referenced style is soft-deleted and was not built; raw values are kept" },
};
export const REASON_CODE_LIST = Object.keys(REASON_CODES);
// Every code by name: CODE.PIX_CORRUPT === "PIX_CORRUPT". New code writes codes only this way, so a
// misspelt one is an undefined property and tools/test-ir.mjs's scan names it.
export const CODE = Object.freeze(REASON_CODE_LIST.reduce((o, c) => { o[c] = c; return o; }, {}));
// The read-stage codes that may explain a VECTOR built from its stored fillGeometry (docs/M1.md D3,
// D5, D13). A geometry-built VECTOR record without one of them is refused here and in a task.
export const GEOMETRY_SOURCE_CODES = [CODE.VECTOR_FROM_GEOMETRY, CODE.BOOLEAN_FLATTENED, CODE.SOURCE_FEATURE_UNSUPPORTED];

// ---------- helpers ----------
const GUID = /^\d+:\d+$/;
// An image hash is a SHA-1. A componentKey is assumed (A) to be 40 lowercase hex as well: the
// plan only shows that keys match by their 12-hex prefix (REWRITE.md §3), and Q4 checks full keys.
// M1/M2a confirm it on a real file; if real keys differ, every real IR fails here, loudly.
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const isNum = (v) => typeof v === "number" && isFinite(v);
const isGuid = (v) => typeof v === "string" && GUID.test(v);
const isStr = (v) => typeof v === "string";
const show = (v) => { let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } if (s === undefined) s = String(v); return s.length > 60 ? s.slice(0, 57) + "..." : s; };

// Key order is not significant to JSON, but it is to a signature, so keys are sorted.
export function canonicalJSON(v) {
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonicalJSON(x))).join(",") + "]";
  if (isObj(v)) {
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalJSON(v[k])).join(",") + "}";
  }
  const s = JSON.stringify(v);
  return s === undefined ? "null" : s;
}

// FNV-1a 64 over the UTF-8 bytes of a string, as 16 hex digits. Written without TextEncoder and
// BigInt (see the top of this file): the UTF-8 is encoded by hand (a lone surrogate becomes U+FFFD,
// as TextEncoder does), and the 64-bit state is two 32-bit halves. The prime is 2^40 + 0x1b3, so
// h * prime = h * 0x1b3 + (h << 40); each half times 0x1b3 stays below 2^41, exact in a double.
export function fnv1a64(str) {
  let hi = 0xcbf29ce4, lo = 0x84222325;
  const step = (b) => {
    lo = (lo ^ b) >>> 0;
    const l = lo * 0x1b3;
    hi = (hi * 0x1b3 + Math.floor(l / 4294967296) + ((lo << 8) >>> 0)) >>> 0;
    lo = l >>> 0;
  };
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00);
      i++;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) step(c);
    else if (c < 0x800) { step(0xc0 | (c >> 6)); step(0x80 | (c & 63)); }
    else if (c < 0x10000) { step(0xe0 | (c >> 12)); step(0x80 | ((c >> 6) & 63)); step(0x80 | (c & 63)); }
    else { step(0xf0 | (c >> 18)); step(0x80 | ((c >> 12) & 63)); step(0x80 | ((c >> 6) & 63)); step(0x80 | (c & 63)); }
  }
  return ("0000000" + hi.toString(16)).slice(-8) + ("0000000" + lo.toString(16)).slice(-8);
}

// A style's value signature: FNV-1a 64 over the UTF-8 of its canonical JSON. Identity, not
// security; it keeps two copies of one styleKey with different values apart (REWRITE.md §3).
export function valueSignature(v) {
  return "fnv1a64:" + fnv1a64(canonicalJSON(v));
}

// The string every built node is stamped with (pxSnap): a stamped root is resumed only when its
// snapshot equals the current IR's.
export function snapshotId(header) {
  const s = header && header.source;
  if (!s) return null;
  if (s.kind === "pix") return "pix:" + s.sha256;
  if (s.kind === "mcp") return "mcp:" + s.fileKey + "@" + s.readAt;
  return null;
}

// A Figma path string, as `vectorPaths` and `fillGeometry` hold it: commands M, L, Q, C and Z, each
// letter and number separated by white space ("M 0 0 L 10 0 Z"). Returns null when it is one, or
// what is wrong with it.
const PATH_ARGS = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
export function figmaPathError(data) {
  if (typeof data !== "string") return "a path is a string";
  const t = data.trim();
  if (!t) return "an empty path";
  const tok = t.split(/\s+/);
  let i = 0, cmds = 0;
  while (i < tok.length) {
    const c = tok[i];
    if (!Object.prototype.hasOwnProperty.call(PATH_ARGS, c)) return "token " + (i + 1) + " is " + show(c) + ", not one of M L Q C Z";
    if (cmds === 0 && c !== "M") return "a path starts with M";
    const n = PATH_ARGS[c];
    for (let k = 1; k <= n; k++) {
      const v = tok[i + k];
      if (v === undefined) return c + " at token " + (i + 1) + " needs " + n + " numbers";
      if (!NUMBER.test(v) || !isFinite(Number(v))) return "token " + (i + k + 1) + " is " + show(v) + ", not a number";
    }
    i += n + 1; cmds++;
  }
  return null;
}

// ---------- the validator ----------
export function validateIR(ir, options) {
  // The tables are data (this file imports nothing). Without them every node would pass unchecked,
  // so a caller that forgets them is told at once rather than given a meaningless ok.
  const PT = options && options.props;
  if (!isObj(PT) || !isObj(PT.KNOWN_PROPS) || !isObj(PT.RANGE_FIELDS) || !Array.isArray(PT.NEVER_OMIT)) {
    throw new TypeError("validateIR(ir, { props }) needs the prop tables of tools/ir/props.mjs; call validate() from tools/ir/validate.mjs");
  }
  const maxErrors = (options && options.maxErrors) || 200;
  const errors = [];
  let dropped = 0;
  const err = (path, message) => { if (errors.length < maxErrors) errors.push({ path, message }); else dropped++; };
  const done = () => {
    if (dropped) errors.push({ path: "", message: dropped + " more error" + (dropped === 1 ? "" : "s") + " not listed" });
    return { ok: errors.length === 0, errors };
  };
  // A record's keys are a closed set; a misspelt key would otherwise be silently ignored.
  const closed = (o, allowed, path) => {
    for (const k of Object.keys(o)) if (allowed.indexOf(k) < 0) err(path ? path + "." + k : k, "unknown key " + show(k));
  };
  const table = (v, path) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { err(path, "must be an array"); return []; }
    return v;
  };

  if (!isObj(ir)) { err("", "the IR must be a JSON object"); return done(); }
  closed(ir, ["header", "pages", "values", "nodes", "sets", "components", "styles", "images", "fonts", "notes"], "");
  const H = ir.header;
  if (!isObj(H)) { err("header", "missing; an IR starts with its header"); return done(); }
  // Format and version first, and nothing else if either is wrong: an unknown version is refused,
  // not read as the nearest thing this code knows.
  if (H.format !== FORMAT) { err("header.format", "unknown format " + show(H.format) + "; expected " + show(FORMAT)); return done(); }
  if (H.version !== VERSION) { err("header.version", "unsupported version " + show(H.version) + "; this reader knows version " + VERSION + " only"); return done(); }
  closed(H, ["format", "version", "source", "scope", "capabilities", "settings"], "header");

  // ---------- header ----------
  const src = H.source;
  if (!isObj(src)) err("header.source", "missing; the source snapshot is required");
  else if (src.kind === "pix") {
    closed(src, ["kind", "sha256", "fileKey", "documentName"], "header.source");
    if (!isStr(src.sha256) || !HEX64.test(src.sha256)) err("header.source.sha256", "a .pix snapshot is the file's SHA-256, 64 lowercase hex; got " + show(src.sha256));
    if (src.fileKey !== undefined && src.fileKey !== null && !(isStr(src.fileKey) && FILE_KEY.test(src.fileKey))) err("header.source.fileKey", "must be a file key or null; got " + show(src.fileKey));
    if (src.documentName !== undefined && !isStr(src.documentName)) err("header.source.documentName", "must be a string");
  } else if (src.kind === "mcp") {
    closed(src, ["kind", "fileKey", "readAt", "changedDuringRead", "documentName"], "header.source");
    if (!(isStr(src.fileKey) && FILE_KEY.test(src.fileKey))) err("header.source.fileKey", "an MCP snapshot needs the Pixso file key; got " + show(src.fileKey));
    if (!(isStr(src.readAt) && ISO_UTC.test(src.readAt) && !isNaN(Date.parse(src.readAt)))) err("header.source.readAt", "an MCP snapshot needs the read time as ISO 8601 UTC; got " + show(src.readAt));
    if (typeof src.changedDuringRead !== "boolean") err("header.source.changedDuringRead", "must be a boolean; got " + show(src.changedDuringRead));
    if (src.documentName !== undefined && !isStr(src.documentName)) err("header.source.documentName", "must be a string");
  } else err("header.source.kind", "must be one of " + SOURCE_KINDS.join(", ") + "; got " + show(src.kind));

  const sc = H.scope;
  if (!isObj(sc)) err("header.scope", "missing");
  else {
    closed(sc, ["kind", "ids"], "header.scope");
    if (SCOPE_KINDS.indexOf(sc.kind) < 0) err("header.scope.kind", "must be one of " + SCOPE_KINDS.join(", ") + "; got " + show(sc.kind));
    else if (sc.kind === "file") { if (sc.ids !== undefined && !(Array.isArray(sc.ids) && sc.ids.length === 0)) err("header.scope.ids", "a whole-file scope lists no ids"); }
    else if (!Array.isArray(sc.ids) || sc.ids.length === 0) err("header.scope.ids", "a " + sc.kind + " scope lists the guids it covers");
    else sc.ids.forEach((g, i) => { if (!isGuid(g)) err("header.scope.ids[" + i + "]", "not a guid: " + show(g)); });
  }

  const caps = {};
  const C = H.capabilities;
  if (!isObj(C)) err("header.capabilities", "missing; the IR declares what its source provides");
  else {
    closed(C, CAPABILITY_KEYS, "header.capabilities");
    for (const k of CAPABILITY_KEYS) {
      if (typeof C[k] !== "boolean") err("header.capabilities." + k, (C[k] === undefined ? "missing" : "must be a boolean, got " + show(C[k])));
      caps[k] = C[k] === true;
    }
  }

  const S = H.settings;
  if (!isObj(S)) err("header.settings", "missing; the settings used are recorded so two runs are comparable");
  else {
    closed(S, SETTING_KEYS, "header.settings");
    for (const k of Object.keys(SETTINGS)) {
      if (SETTINGS[k].indexOf(S[k]) < 0) err("header.settings." + k, (S[k] === undefined ? "missing" : "got " + show(S[k])) + "; must be one of " + SETTINGS[k].join(", ") + " (" + SETTING_FLAGS[k] + ")");
    }
    if (!(isStr(S.kitmaps) && S.kitmaps.length > 0)) err("header.settings.kitmaps", "must be \"default\" or the directory given with --kitmaps; got " + show(S.kitmaps));
  }

  // ---------- pages ----------
  const pages = table(ir.pages, "pages");
  const pageGuids = new Set();
  pages.forEach((p, i) => {
    const P = "pages[" + i + "]";
    if (!isObj(p)) { err(P, "must be an object"); return; }
    closed(p, ["guid", "name", "internal", "background"], P);
    if (!isGuid(p.guid)) err(P + ".guid", "not a guid: " + show(p.guid));
    else if (pageGuids.has(p.guid)) err(P + ".guid", "duplicate page guid " + p.guid);
    else pageGuids.add(p.guid);
    if (!isStr(p.name)) err(P + ".name", "must be a string");
    if (typeof p.internal !== "boolean") err(P + ".internal", "must be a boolean");
  });

  // ---------- values ----------
  const values = table(ir.values, "values");
  // The page background is a fills list in values (the page's own paints, docs/M1.md §5.1).
  pages.forEach((p, i) => {
    if (!isObj(p) || p.background === undefined) return;
    if (!isInt(p.background) || p.background < 0 || p.background >= values.length) err("pages[" + i + "].background", "index " + show(p.background) + " is not in values (" + values.length + ")");
    else if (!Array.isArray(values[p.background])) err("pages[" + i + "].background", "values[" + p.background + "] is not a fills list");
  });
  {
    const seen = new Map();
    values.forEach((v, i) => {
      const k = canonicalJSON(v);
      if (seen.has(k)) err("values[" + i + "]", "duplicate of values[" + seen.get(k) + "]; the writer interns each value once");
      else seen.set(k, i);
    });
  }

  // ---------- nodes, pass 1: structure ----------
  const nodes = table(ir.nodes, "nodes");
  const guidIndex = new Map();
  const nodeOk = nodes.map((n) => isObj(n));
  nodes.forEach((n, i) => {
    const P = "nodes[" + i + "]";
    if (!isObj(n)) { err(P, "must be an object"); return; }
    closed(n, ["parent", "page", "guid", "type", "name", "props", "instance", "overrideKey"], P);
    if (!isInt(n.parent)) err(P + ".parent", "must be an integer (-1 for a page's top-level node); got " + show(n.parent));
    else if (n.parent === -1) {
      if (!isInt(n.page) || n.page < 0 || n.page >= pages.length) err(P + ".page", "a top-level record names its page; " + show(n.page) + " is not an index into pages (" + pages.length + ")");
    } else {
      if (n.parent < -1 || n.parent >= nodes.length) err(P + ".parent", "index " + n.parent + " out of range (" + nodes.length + " records)");
      else if (n.parent >= i) err(P + ".parent", "parent " + n.parent + " does not precede this record; records are parent-first");
      if (n.page !== undefined) err(P + ".page", "only a top-level record names its page");
    }
    if (!isGuid(n.guid)) err(P + ".guid", "not a guid: " + show(n.guid));
    else if (guidIndex.has(n.guid)) err(P + ".guid", "duplicate guid " + n.guid + " (also nodes[" + guidIndex.get(n.guid) + "])");
    else if (pageGuids.has(n.guid)) err(P + ".guid", n.guid + " is also a page's guid; a file has one guid space");
    else guidIndex.set(n.guid, i);
    if (NODE_TYPES.indexOf(n.type) < 0) err(P + ".type", "unknown node type " + show(n.type));
    if (!isStr(n.name)) err(P + ".name", "must be a string");
    if (!isObj(n.props)) err(P + ".props", n.props === undefined ? "missing; every record carries at least relativeTransform, width and height" : "must be an object");
    if (n.overrideKey !== undefined) {
      if (!caps.overrideKeys) err(P + ".overrideKey", "present, but the header does not declare capabilities.overrideKeys");
      else if (!isGuid(n.overrideKey)) err(P + ".overrideKey", "not a guid: " + show(n.overrideKey));
    }
    if (n.type === "INSTANCE" && !isObj(n.instance)) err(P + ".instance", "an INSTANCE record carries its instance data");
    if (n.type !== "INSTANCE" && n.instance !== undefined) err(P + ".instance", "only an INSTANCE record carries instance data");
    // Placed by parent-first order, so the parent's type is already known to be valid or reported.
    if (isInt(n.parent) && n.parent >= 0 && n.parent < i && nodeOk[n.parent]) {
      const pt = nodes[n.parent].type;
      if (pt === "INSTANCE") err(P + ".parent", "an instance has no child records; its content is its master's, changed by overrides");
      if (pt === "COMPONENT_SET" && n.type !== "COMPONENT") err(P + ".type", "a component set holds only components; got " + show(n.type));
    }
  });
  const nodeAt = (i) => (isInt(i) && i >= 0 && i < nodes.length && nodeOk[i] ? nodes[i] : null);

  // ---------- reference checks shared by props, text ranges and override fields ----------
  const styles = table(ir.styles, "styles");
  const fontRefs = []; // [path, value index]
  const checkFields = (f, P) => {
    for (const k of INTERNED_PROPS) {
      if (f[k] === undefined) continue;
      if (!isInt(f[k]) || f[k] < 0 || f[k] >= values.length) { err(P + "." + k, "index " + show(f[k]) + " is not in values (" + values.length + ")"); continue; }
      const list = LIST_VALUES.indexOf(k) >= 0;
      if (list ? !Array.isArray(values[f[k]]) : !isObj(values[f[k]])) { err(P + "." + k, "values[" + f[k] + "] is not " + (list ? "a list" : "an object") + ", which " + k + " needs"); continue; }
      if (k === "fontName") fontRefs.push([P + "." + k, f[k]]);
    }
    for (const k of Object.keys(STYLE_REFS)) {
      if (f[k] === undefined) continue;
      if (!isInt(f[k]) || f[k] < 0 || f[k] >= styles.length) { err(P + "." + k, "index " + show(f[k]) + " is not in styles (" + styles.length + ")"); continue; }
      const st = styles[f[k]];
      if (isObj(st) && STYLE_TYPES.indexOf(st.type) >= 0 && st.type !== STYLE_REFS[k]) err(P + "." + k, "points at a " + st.type + " style; " + k + " takes a " + STYLE_REFS[k] + " style");
    }
  };

  // ---------- nodes, pass 2: props ----------
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const kindOf = (type, k) => (own(PT.KNOWN_PROPS, type) && isObj(PT.KNOWN_PROPS[type]) && own(PT.KNOWN_PROPS[type], k) ? PT.KNOWN_PROPS[type][k] : undefined);
  // The scalar kinds; value and style are index checks (checkFields), own props have rules below.
  const checkKind = (kind, v, at, k) => {
    if (kind === "num") { if (!isNum(v)) err(at, k + " is a finite number; got " + show(v)); }
    else if (kind === "int") { if (!isInt(v)) err(at, k + " is an integer; got " + show(v)); }
    else if (kind === "bool") { if (typeof v !== "boolean") err(at, k + " is true or false; got " + show(v)); }
    else if (kind === "str") { if (!isStr(v)) err(at, k + " is a string; got " + show(v)); }
    else if (isStr(kind) && kind.indexOf("enum:") === 0) {
      const vals = kind.slice(5).split("|");
      if (vals.indexOf(v) < 0) err(at, k + " must be one of " + vals.join(", ") + "; got " + show(v));
    }
  };
  const quad = (v, test) => Array.isArray(v) && v.length === 4 && v.every(test);
  const nonNeg = (x) => isNum(x) && x >= 0;
  // Codes the reader noted per record, for the vector build-source rule. Read defensively: the
  // notes themselves are checked at the end.
  const notedCodes = new Map();
  if (Array.isArray(ir.notes)) ir.notes.forEach((nt) => {
    if (isObj(nt) && isInt(nt.node)) { if (!notedCodes.has(nt.node)) notedCodes.set(nt.node, []); notedCodes.get(nt.node).push(nt.code); }
  });

  // Value shapes for geometry and networks, checked once per values index.
  const shapeCache = new Map();
  const geometryError = (v) => {
    if (!Array.isArray(v)) return "a geometry value is a list of {windingRule, data}";
    for (let j = 0; j < v.length; j++) {
      const g = v[j];
      if (!isObj(g)) return "[" + j + "] is not {windingRule, data}";
      for (const k of Object.keys(g)) if (k !== "windingRule" && k !== "data") return "[" + j + "] has unknown key " + show(k);
      if (WINDING_RULES.indexOf(g.windingRule) < 0) return "[" + j + "].windingRule must be one of " + WINDING_RULES.join(", ") + "; got " + show(g.windingRule);
      const pe = figmaPathError(g.data);
      if (pe) return "[" + j + "].data is not a Figma path string: " + pe;
    }
    return null;
  };
  const networkError = (v) => {
    if (!isObj(v)) return "a vector network is {vertices, segments, regions}";
    for (const k of Object.keys(v)) if (["vertices", "segments", "regions"].indexOf(k) < 0) return "unknown key " + show(k);
    if (!Array.isArray(v.vertices) || !Array.isArray(v.segments) || !Array.isArray(v.regions)) return "a vector network is {vertices[], segments[], regions[]}";
    const nv = v.vertices.length, ns = v.segments.length;
    for (let j = 0; j < nv; j++) {
      const x = v.vertices[j];
      if (!isObj(x)) return "vertices[" + j + "] is not an object";
      for (const k of Object.keys(x)) if (["x", "y", "strokeCap", "strokeJoin", "cornerRadius", "handleMirroring"].indexOf(k) < 0) return "vertices[" + j + "] has unknown key " + show(k);
      if (!isNum(x.x) || !isNum(x.y)) return "vertices[" + j + "] needs finite x and y";
      if (x.cornerRadius !== undefined && !nonNeg(x.cornerRadius)) return "vertices[" + j + "].cornerRadius must be a number >= 0";
      // RIGHT_ANGLE is Pixso's, and Figma throws on it: the reader strips it (docs/M1.md D3).
      if (x.handleMirroring !== undefined && HANDLE_MIRRORING.indexOf(x.handleMirroring) < 0) return "vertices[" + j + "].handleMirroring must be one of " + HANDLE_MIRRORING.join(", ") + "; got " + show(x.handleMirroring);
      if (x.strokeCap !== undefined && !isStr(x.strokeCap)) return "vertices[" + j + "].strokeCap must be a string";
      if (x.strokeJoin !== undefined && !isStr(x.strokeJoin)) return "vertices[" + j + "].strokeJoin must be a string";
    }
    const tangent = (t) => t === undefined || (isObj(t) && isNum(t.x) && isNum(t.y) && Object.keys(t).length === 2);
    for (let j = 0; j < ns; j++) {
      const s = v.segments[j];
      if (!isObj(s)) return "segments[" + j + "] is not an object";
      for (const k of Object.keys(s)) if (["start", "end", "tangentStart", "tangentEnd"].indexOf(k) < 0) return "segments[" + j + "] has unknown key " + show(k);
      if (!isInt(s.start) || !isInt(s.end) || s.start < 0 || s.end < 0 || s.start >= nv || s.end >= nv) return "segments[" + j + "] joins vertices " + show(s.start) + " and " + show(s.end) + "; there are " + nv;
      if (!tangent(s.tangentStart) || !tangent(s.tangentEnd)) return "segments[" + j + "] tangents are {x, y}";
    }
    for (let j = 0; j < v.regions.length; j++) {
      const r = v.regions[j];
      if (!isObj(r)) return "regions[" + j + "] is not an object";
      for (const k of Object.keys(r)) if (["windingRule", "loops", "fills"].indexOf(k) < 0) return "regions[" + j + "] has unknown key " + show(k);
      if (WINDING_RULES.indexOf(r.windingRule) < 0) return "regions[" + j + "].windingRule must be one of " + WINDING_RULES.join(", ");
      if (r.fills !== undefined && !Array.isArray(r.fills)) return "regions[" + j + "].fills must be a list";
      if (!Array.isArray(r.loops) || r.loops.length === 0) return "regions[" + j + "] has no loops";
      for (let q = 0; q < r.loops.length; q++) {
        const L = r.loops[q], at = "regions[" + j + "].loops[" + q + "]";
        if (!Array.isArray(L) || L.length === 0) return at + " is not a non-empty list of segment indices";
        const deg = new Map();
        for (const si of L) {
          if (!isInt(si) || si < 0 || si >= ns) return at + " names segment " + show(si) + "; there are " + ns;
          const s = v.segments[si];
          deg.set(s.start, (deg.get(s.start) || 0) + 1);
          deg.set(s.end, (deg.get(s.end) || 0) + 1);
        }
        // Closed: each segment meets the next (the last meets the first), and every vertex is entered
        // as often as it is left.
        for (let a = 0; a < L.length && L.length > 1; a++) {
          const s = v.segments[L[a]], t = v.segments[L[(a + 1) % L.length]];
          if (s.start !== t.start && s.start !== t.end && s.end !== t.start && s.end !== t.end) return at + " is not closed: segments " + L[a] + " and " + L[(a + 1) % L.length] + " do not meet";
        }
        for (const [vx, d] of deg) if (d % 2) return at + " is not closed: vertex " + vx + " is an open end";
      }
    }
    return null;
  };
  const checkShape = (k, idx, at) => {
    // An index out of range, or at a value of the wrong container, is checkFields' to report.
    if (!isInt(idx) || idx < 0 || idx >= values.length) return;
    if (k === "vectorNetwork" ? !isObj(values[idx]) : !Array.isArray(values[idx])) return;
    const key = (k === "vectorNetwork" ? "n" : "g") + idx;
    if (!shapeCache.has(key)) shapeCache.set(key, k === "vectorNetwork" ? networkError(values[idx]) : geometryError(values[idx]));
    const e = shapeCache.get(key);
    if (e) err(at, "values[" + idx + "]: " + e);
  };

  nodes.forEach((n, i) => {
    if (!nodeOk[i] || !isObj(n.props)) return;
    const P = "nodes[" + i + "].props";
    const pr = n.props;
    const typed = NODE_TYPES.indexOf(n.type) >= 0;
    if (typed && !isObj(PT.KNOWN_PROPS[n.type])) { err(P, "tools/ir/props.mjs has no KNOWN_PROPS entry for " + n.type); return; }
    // Every key: superseded, misplaced geometry, unknown for the type, or of the wrong kind.
    if (typed) for (const k of Object.keys(pr)) {
      const at = P + "." + k;
      if (SUPERSEDED_PROPS.indexOf(k) >= 0) { err(at, "superseded in version 2: write " + SUPERSEDED_BY[k]); continue; }
      if (GEOMETRY_PROPS.indexOf(k) >= 0 && VECTOR_TYPES.indexOf(n.type) < 0) { err(at, "vector geometry is carried only on " + VECTOR_TYPES.join(", ") + " records (and in an instance's derived boxes)"); continue; }
      const kind = kindOf(n.type, k);
      if (kind === undefined && GEOMETRY_PROPS.indexOf(k) >= 0) { err(at, "a " + n.type + " is built natively and carries no build-source geometry (only oracleFillGeometry); a shape built from geometry is a VECTOR record"); continue; }
      if (kind === undefined) { err(at, "unknown prop " + show(k) + " for a " + n.type + " record (tools/ir/props.mjs KNOWN_PROPS)"); continue; }
      checkKind(kind, pr[k], at, k);
    }
    checkFields(pr, P);
    for (const k of GEOMETRY_PROPS) if (pr[k] !== undefined && VECTOR_TYPES.indexOf(n.type) >= 0) checkShape(k, pr[k], P + "." + k);

    // Geometry every record has.
    if (!(Array.isArray(pr.relativeTransform) && pr.relativeTransform.length === 6 && pr.relativeTransform.every(isNum))) err(P + ".relativeTransform", (pr.relativeTransform === undefined ? "missing; " : "") + "every record has six finite numbers [a, b, tx, c, d, ty]");
    for (const k of ["width", "height"]) if (!nonNeg(pr[k])) err(P + "." + k, (pr[k] === undefined ? "missing; " : "") + "every record has a finite " + k + " >= 0; got " + show(pr[k]));
    // Written even at their default, because Figma's defaults differ by node type.
    if (typed) for (const k of PT.NEVER_OMIT) if (kindOf(n.type, k) !== undefined && pr[k] === undefined) err(P + "." + k, "missing; " + k + " is never left out of a " + n.type + " record (props.mjs NEVER_OMIT)");

    // Sides and corners.
    if (pr.strokeWeights !== undefined && !quad(pr.strokeWeights, nonNeg)) err(P + ".strokeWeights", "must be four finite numbers >= 0 [top, right, bottom, left]");
    if (pr.cornerRadii !== undefined && !quad(pr.cornerRadii, nonNeg)) err(P + ".cornerRadii", "must be four finite numbers >= 0 [topLeft, topRight, bottomRight, bottomLeft]");
    if (pr.cornerRadii !== undefined && pr.cornerRadius !== undefined) err(P + ".cornerRadius", "a record with cornerRadii carries no cornerRadius");
    // Only when they differ (docs/IR.md §7): four equal sides are strokeWeight, four equal corners
    // cornerRadius, so one record never says the same thing in two ways a builder could read apart.
    const allSame = (q) => q.every((x) => x === q[0]);
    if (quad(pr.strokeWeights, nonNeg) && allSame(pr.strokeWeights)) err(P + ".strokeWeights", "four equal sides are written as strokeWeight; strokeWeights only when the sides differ");
    if (quad(pr.cornerRadii, nonNeg) && allSame(pr.cornerRadii)) err(P + ".cornerRadii", "four equal corners are written as cornerRadius; cornerRadii only when the corners differ");
    if (pr.oracleSides !== undefined && !quad(pr.oracleSides, (x) => typeof x === "boolean")) err(P + ".oracleSides", "must be four booleans [top, right, bottom, left]: does the stroke-area path draw that side");

    // Vectors: one build source per VECTOR record (docs/M1.md D3). The natively built types list no
    // build-source geometry in KNOWN_PROPS, so the key loop above has refused any.
    if (n.type === "VECTOR") {
      const has = ["vectorNetwork", "fillGeometry"].filter((k) => pr[k] !== undefined);
      if (has.length !== 1) err(P, "a VECTOR record has exactly one build source, vectorNetwork or fillGeometry; it has " + (has.length ? has.join(" and ") : "neither"));
      if (pr.strokeGeometry !== undefined && pr.fillGeometry === undefined) err(P + ".strokeGeometry", "strokeGeometry is never a build source alone; it travels only next to fillGeometry");
      if (pr.oracleFillGeometry !== undefined && pr.vectorNetwork === undefined) err(P + ".oracleFillGeometry", "the oracle sits only next to a vectorNetwork; a geometry-built record is its own oracle");
      if (pr.fillGeometry !== undefined) {
        const why = (notedCodes.get(i) || []).filter((c) => GEOMETRY_SOURCE_CODES.indexOf(c) >= 0);
        if (!why.length) err(P + ".fillGeometry", "a VECTOR built from its stored geometry carries a note saying why: " + GEOMETRY_SOURCE_CODES.join(", "));
      }
    }

    if (pr.inkBounds !== undefined) {
      if (!caps.inkBounds) err(P + ".inkBounds", "present, but the header does not declare capabilities.inkBounds");
      else if (!(Array.isArray(pr.inkBounds) && pr.inkBounds.length === 4 && pr.inkBounds.every(isNum))) err(P + ".inkBounds", "must be [x, y, width, height]");
    }
    if (pr.lines !== undefined && (n.type !== "TEXT" || !isInt(pr.lines) || pr.lines < 0)) err(P + ".lines", "the number of lines Pixso drew: a TEXT record's non-negative integer; got " + show(pr.lines));
    if (pr.textRanges !== undefined && n.type === "TEXT") {
      if (!Array.isArray(pr.textRanges)) err(P + ".textRanges", "must be an array");
      else {
        const chars = isStr(pr.characters) ? pr.characters : "";
        const len = chars.length;
        // A bound between the two halves of a surrogate pair would style half a character.
        const splits = (at) => at > 0 && at < len && chars.charCodeAt(at - 1) >= 0xd800 && chars.charCodeAt(at - 1) <= 0xdbff &&
          chars.charCodeAt(at) >= 0xdc00 && chars.charCodeAt(at) <= 0xdfff;
        let prevEnd = 0;
        pr.textRanges.forEach((r, j) => {
          const R = P + ".textRanges[" + j + "]";
          if (!isObj(r)) { err(R, "must be an object"); return; }
          closed(r, ["start", "end", "fields"], R);
          if (!isInt(r.start) || !isInt(r.end) || r.start < 0 || r.end <= r.start || r.end > len) { err(R, "range [" + show(r.start) + ", " + show(r.end) + ") is not inside the " + len + " UTF-16 units of characters"); return; }
          if (r.start < prevEnd) err(R + ".start", "ranges are ascending and do not overlap; this one starts at " + r.start + " before the previous end " + prevEnd);
          prevEnd = r.end;
          if (splits(r.start)) err(R + ".start", r.start + " splits a surrogate pair");
          if (splits(r.end)) err(R + ".end", r.end + " splits a surrogate pair");
          if (!isObj(r.fields)) { err(R + ".fields", "must be an object"); return; }
          for (const k of Object.keys(r.fields)) {
            if (!own(PT.RANGE_FIELDS, k)) err(R + ".fields." + k, "not a text range field (props.mjs RANGE_FIELDS)");
            else checkKind(PT.RANGE_FIELDS[k], r.fields[k], R + ".fields." + k, k);
          }
          checkFields(r.fields, R + ".fields");
        });
      }
    }
  });

  // ---------- component definitions ----------
  const sets = table(ir.sets, "sets");
  const comps = table(ir.components, "components");
  const families = new Map(); // family guid -> Map(id -> definition)
  const setOfNode = new Map(), compOfNode = new Map();
  const propDefs = (arr, P, family) => {
    const m = new Map();
    if (arr === undefined) return m;
    if (!Array.isArray(arr)) { err(P, "must be an array"); return m; }
    arr.forEach((d, j) => {
      const D = P + "[" + j + "]";
      if (!isObj(d)) { err(D, "must be an object"); return; }
      closed(d, ["id", "name", "type", "default", "preferredValues"], D);
      if (!(isStr(d.id) && d.id.length)) { err(D + ".id", "must be a non-empty string"); return; }
      if (m.has(d.id)) err(D + ".id", "duplicate property id " + show(d.id) + " in family " + family + "; definitions are keyed by (family, id)");
      if (!isStr(d.name)) err(D + ".name", "must be a string");
      if (PROPERTY_TYPES.indexOf(d.type) < 0) err(D + ".type", "must be one of " + PROPERTY_TYPES.join(", ") + "; got " + show(d.type));
      m.set(d.id, { def: d, path: D });
    });
    return m;
  };

  sets.forEach((s, i) => {
    const P = "sets[" + i + "]";
    if (!isObj(s)) { err(P, "must be an object"); return; }
    closed(s, ["node", "axes", "properties", "library"], P);
    const n = nodeAt(s.node);
    if (!n) { err(P + ".node", "index " + show(s.node) + " is not a node record"); return; }
    if (n.type !== "COMPONENT_SET") err(P + ".node", "nodes[" + s.node + "] is a " + show(n.type) + ", not a COMPONENT_SET");
    if (setOfNode.has(s.node)) err(P + ".node", "nodes[" + s.node + "] already belongs to sets[" + setOfNode.get(s.node) + "]");
    setOfNode.set(s.node, i);
    if (!Array.isArray(s.axes) || s.axes.length === 0) err(P + ".axes", "an accepted set has at least one axis (a rejected one is a VARIANT_SET_REJECTED note)");
    else {
      const names = new Set();
      s.axes.forEach((a, j) => {
        const A = P + ".axes[" + j + "]";
        if (!isObj(a)) { err(A, "must be an object"); return; }
        closed(a, ["name", "values"], A);
        if (!(isStr(a.name) && a.name.length)) err(A + ".name", "must be a non-empty string");
        else if (names.has(a.name)) err(A + ".name", "duplicate axis " + show(a.name));
        else names.add(a.name);
        if (!Array.isArray(a.values) || a.values.length === 0 || !a.values.every(isStr)) err(A + ".values", "must be a non-empty array of strings");
        else if (new Set(a.values).size !== a.values.length) err(A + ".values", "duplicate value on axis " + show(a.name));
      });
    }
    if (isGuid(n.guid)) families.set(n.guid, propDefs(s.properties, P + ".properties", n.guid));
  });

  const coords = new Map(); // set index -> Map(coordinate -> component index)
  comps.forEach((c, i) => {
    const P = "components[" + i + "]";
    if (!isObj(c)) { err(P, "must be an object"); return; }
    closed(c, ["node", "set", "variant", "properties", "library", "deleted", "ancestorPath"], P);
    const n = nodeAt(c.node);
    if (!n) { err(P + ".node", "index " + show(c.node) + " is not a node record"); return; }
    if (n.type !== "COMPONENT") err(P + ".node", "nodes[" + c.node + "] is a " + show(n.type) + ", not a COMPONENT");
    if (compOfNode.has(c.node)) err(P + ".node", "nodes[" + c.node + "] already has components[" + compOfNode.get(c.node) + "]");
    compOfNode.set(c.node, i);
    if (c.set === null || c.set === undefined) {
      if (c.variant !== undefined && c.variant !== null) err(P + ".variant", "a standalone component has no variant coordinate");
      const pn = nodeAt(n.parent);
      if (pn && pn.type === "COMPONENT_SET") err(P + ".set", "the record sits inside a component set, so it is a member of sets[" + setOfNode.get(n.parent) + "]");
      if (isGuid(n.guid)) families.set(n.guid, propDefs(c.properties, P + ".properties", n.guid));
    } else if (!isInt(c.set) || c.set < 0 || c.set >= sets.length || !isObj(sets[c.set])) err(P + ".set", "index " + show(c.set) + " is not in sets (" + sets.length + ")");
    else {
      const s = sets[c.set];
      if (n.parent !== s.node) err(P + ".set", "a member's record is a child of its set's record; nodes[" + c.node + "].parent is " + show(n.parent) + ", the set is nodes[" + show(s.node) + "]");
      // Type, name and default come from the root definition on the set (REWRITE.md §3); a member
      // carrying its own would reintroduce the variant-local aliases the reader exists to remove.
      if (c.properties !== undefined && !(Array.isArray(c.properties) && c.properties.length === 0)) err(P + ".properties", "a set member declares no properties; they belong to its set");
      if (!isObj(c.variant)) err(P + ".variant", "a set member has a variant coordinate");
      else if (Array.isArray(s.axes)) {
        const axes = s.axes.filter(isObj);
        for (const k of Object.keys(c.variant)) if (!axes.some((a) => a.name === k)) err(P + ".variant." + k, "not an axis of sets[" + c.set + "]");
        for (const a of axes) {
          const v = c.variant[a.name];
          if (v === undefined) err(P + ".variant", "no value for axis " + show(a.name));
          else if (!Array.isArray(a.values) || a.values.indexOf(v) < 0) err(P + ".variant." + a.name, show(v) + " is not a value of axis " + show(a.name));
        }
        // Normalised to axis order, so mixed axis order in the source cannot make two keys.
        const key = canonicalJSON(axes.map((a) => c.variant[a.name]));
        if (!coords.has(c.set)) coords.set(c.set, new Map());
        const m = coords.get(c.set);
        if (m.has(key)) err(P + ".variant", "same coordinate as components[" + m.get(key) + "]; a set with a duplicate coordinate is rejected at read time");
        else m.set(key, i);
      }
    }
    if (c.library !== undefined && c.library !== null) checkLibrary(c.library, P + ".library");
    if (c.deleted !== undefined && typeof c.deleted !== "boolean") err(P + ".deleted", "must be a boolean");
    if (c.ancestorPath !== undefined) {
      if (c.deleted !== true) err(P + ".ancestorPath", "only a deleted master records its path before deletion");
      else if (!Array.isArray(c.ancestorPath) || !c.ancestorPath.every(isStr)) err(P + ".ancestorPath", "must be an array of names");
    }
  });
  nodes.forEach((n, i) => {
    if (!nodeOk[i]) return;
    if (n.type === "COMPONENT" && !compOfNode.has(i)) err("nodes[" + i + "]", "a COMPONENT record with no entry in components");
    if (n.type === "COMPONENT_SET" && !setOfNode.has(i)) err("nodes[" + i + "]", "a COMPONENT_SET record with no entry in sets");
  });

  // The library identity every library copy carries. publishFile names the library; publishID or
  // componentKey names the master in it. What the header does not declare must not appear.
  function checkLibrary(l, P) {
    if (!isObj(l)) { err(P, "must be an object"); return false; }
    closed(l, ["publishFile", "publishID", "componentKey", "sharedSymbolVersion"], P);
    let good = true;
    if (!(isStr(l.publishFile) && FILE_KEY.test(l.publishFile))) { err(P + ".publishFile", "must be the library's file key; got " + show(l.publishFile)); good = false; }
    if (l.publishID !== undefined) {
      if (!caps.publishIds) { err(P + ".publishID", "present, but the header does not declare capabilities.publishIds"); good = false; }
      else if (!isGuid(l.publishID)) { err(P + ".publishID", "not a guid: " + show(l.publishID)); good = false; }
    }
    if (l.componentKey !== undefined && !(isStr(l.componentKey) && HEX40.test(l.componentKey))) { err(P + ".componentKey", "must be 40 lowercase hex; got " + show(l.componentKey)); good = false; }
    if (l.sharedSymbolVersion !== undefined) {
      if (!caps.symbolVersions) { err(P + ".sharedSymbolVersion", "present, but the header does not declare capabilities.symbolVersions"); good = false; }
      else if (!isStr(l.sharedSymbolVersion)) { err(P + ".sharedSymbolVersion", "must be a string"); good = false; }
    }
    if (l.publishID === undefined && l.componentKey === undefined) { err(P, "names no master: publishID or componentKey is required"); good = false; }
    return good;
  }

  const familyOfComp = (ci) => {
    const c = comps[ci];
    const s = isInt(c.set) ? sets[c.set] : null;
    const owner = s ? nodeAt(s.node) : nodeAt(c.node);
    return owner ? owner.guid : null;
  };

  // A master reference resolves to a definition in this IR (by the master's source guid) or, when
  // the master is not in the IR, to a library identity the kit map can resolve later.
  // Returns the component index, -1 for an external master, or null when it does not resolve.
  function resolveMaster(ref, P) {
    if (!isObj(ref)) { err(P, "a master reference is an object {guid, library}"); return null; }
    closed(ref, ["guid", "library"], P);
    const hasLib = ref.library !== undefined && ref.library !== null;
    const libOk = hasLib ? checkLibrary(ref.library, P + ".library") : false;
    if (ref.guid !== undefined) {
      if (!isGuid(ref.guid)) { err(P + ".guid", "not a guid: " + show(ref.guid)); return null; }
      const ni = guidIndex.get(ref.guid);
      if (ni !== undefined && compOfNode.has(ni)) {
        const ci = compOfNode.get(ni);
        const own = isObj(comps[ci]) ? comps[ci].library : null;
        const L = ref.library;
        const differ = (k) => isObj(own) && own[k] !== undefined && L[k] !== undefined && own[k] !== L[k];
        if (hasLib && libOk && (differ("publishFile") || differ("publishID") || differ("componentKey")))
          err(P + ".library", "disagrees with the library identity of components[" + ci + "]");
        return ci;
      }
      if (ni !== undefined) { err(P + ".guid", ref.guid + " is a " + nodes[ni].type + " record, not a component definition"); return null; }
      if (libOk) return -1;
      err(P, "dangling master reference: " + ref.guid + " is not a component definition in this IR and no library identity is given");
      return null;
    }
    if (libOk) return -1;
    if (!hasLib) err(P, "dangling master reference: neither a guid nor a library identity");
    return null;
  }

  const inSubtree = (ni, root) => {
    for (let k = ni, guard = 0; isInt(k) && k >= 0 && guard <= nodes.length; guard++) {
      if (k === root) return true;
      const n = nodeAt(k);
      if (!n) return false;
      k = n.parent;
    }
    return false;
  };

  const checkValue = (def, v, P) => {
    if (def.type === "BOOLEAN" && typeof v !== "boolean") err(P, "a BOOLEAN property takes true or false; got " + show(v));
    else if (def.type === "TEXT" && !isStr(v)) err(P, "a TEXT property takes a string; got " + show(v));
    else if (def.type === "INSTANCE_SWAP") resolveMaster(v, P);
  };
  // Property assignments. masterFamily is the family the instance's master belongs to, or null
  // when that is unknown (an external master, or a nested instance whose path this does not walk).
  const checkAssignments = (arr, P, masterFamily, external) => {
    if (arr === undefined) return 0;
    if (!Array.isArray(arr)) { err(P, "must be an array"); return 0; }
    const seen = new Set();
    arr.forEach((a, j) => {
      const A = P + "[" + j + "]";
      if (!isObj(a)) { err(A, "must be an object"); return; }
      closed(a, ["family", "id", "value"], A);
      if (!isGuid(a.family)) { err(A + ".family", "not a guid: " + show(a.family)); return; }
      const k = a.family + "|" + a.id;
      if (seen.has(k)) err(A, "property (" + a.family + ", " + show(a.id) + ") assigned twice");
      seen.add(k);
      if (masterFamily && a.family !== masterFamily) { err(A + ".family", "the master's family is " + masterFamily + "; an assignment from another family is stale and is dropped at read time (STALE_ASSIGNMENT)"); return; }
      const fam = families.get(a.family);
      if (!fam) { if (!external) err(A + ".family", a.family + " is not a component or set in this IR"); return; }
      const d = fam.get(a.id);
      if (!d) { err(A + ".id", "no property " + show(a.id) + " in family " + a.family); return; }
      checkValue(d.def, a.value, A + ".value");
    });
    return arr.length;
  };

  // Property defaults and preferred values may point at masters; resolved once everything is indexed.
  for (const m of families.values()) {
    for (const { def, path } of m.values()) {
      if (PROPERTY_TYPES.indexOf(def.type) < 0) continue;
      if (def.default === undefined) err(path + ".default", "missing; a property's default comes from its root definition");
      else checkValue(def, def.default, path + ".default");
      if (def.preferredValues !== undefined) {
        if (def.type !== "INSTANCE_SWAP") err(path + ".preferredValues", "only an INSTANCE_SWAP property has preferred values");
        else if (!Array.isArray(def.preferredValues)) err(path + ".preferredValues", "must be an array");
        else def.preferredValues.forEach((r, j) => resolveMaster(r, path + ".preferredValues[" + j + "]"));
      }
    }
  }

  // Layers bound to a property of the definition that encloses them.
  nodes.forEach((n, i) => {
    if (!nodeOk[i] || !isObj(n.props) || n.props.componentPropertyReferences === undefined) return;
    const P = "nodes[" + i + "].props.componentPropertyReferences";
    const refs = n.props.componentPropertyReferences;
    if (!isObj(refs)) { err(P, "must be an object"); return; }
    let k = i, ci = -1;
    for (let guard = 0; guard <= nodes.length && nodeAt(k); guard++) {
      if (compOfNode.has(k)) { ci = compOfNode.get(k); break; }
      k = nodes[k].parent;
    }
    if (ci < 0) { err(P, "a property reference outside any component definition"); return; }
    const famGuid = familyOfComp(ci);
    const fam = famGuid ? families.get(famGuid) : null;
    for (const f of Object.keys(refs)) {
      // An own-property test: the key is the IR's, and "constructor" is not a field.
      if (!Object.prototype.hasOwnProperty.call(PROPERTY_REF_FIELDS, f)) { err(P + "." + f, "a layer binds only " + Object.keys(PROPERTY_REF_FIELDS).join(", ")); continue; }
      const d = fam ? fam.get(refs[f]) : null;
      if (!d) err(P + "." + f, "no property " + show(refs[f]) + " in family " + famGuid);
      else if (d.def.type !== PROPERTY_REF_FIELDS[f]) err(P + "." + f, f + " binds a " + PROPERTY_REF_FIELDS[f] + " property; " + show(refs[f]) + " is " + d.def.type);
    }
  });

  // ---------- instances ----------
  nodes.forEach((n, i) => {
    if (!nodeOk[i] || n.type !== "INSTANCE" || !isObj(n.instance)) return;
    const P = "nodes[" + i + "].instance";
    const inst = n.instance;
    closed(inst, ["master", "properties", "overrides", "overrideBasis", "derived"], P);
    const ci = resolveMaster(inst.master, P + ".master");
    const local = isInt(ci) && ci >= 0;
    // The first hop of a guidPath is a layer of this instance's master. Later hops go through
    // nested instances and swaps; resolving those is the reader's job (M2a), not this check's.
    const firstHop = (g, at) => {
      if (!local) return;
      const root = comps[ci].node, ni = guidIndex.get(g);
      if (ni === undefined || ni === root || !inSubtree(ni, root)) err(at, g + " is not a layer inside the master (" + nodes[root].guid + ")");
    };
    const masterFamily = local ? familyOfComp(ci) : null;
    if (local && inSubtree(i, comps[ci].node)) err(P + ".master", "an instance inside its own master");
    checkAssignments(inst.properties, P + ".properties", masterFamily, ci === -1);

    const ov = inst.overrides;
    if (ov !== undefined) {
      if (!Array.isArray(ov)) err(P + ".overrides", "must be an array");
      else {
        const paths = new Map();
        ov.forEach((o, j) => {
          const O = P + ".overrides[" + j + "]";
          if (!isObj(o)) { err(O, "must be an object"); return; }
          closed(o, ["path", "fields", "swap", "properties"], O);
          if (!Array.isArray(o.path) || o.path.length === 0) { err(O + ".path", "a guidPath is a non-empty array of guids"); return; }
          let good = true;
          o.path.forEach((g, k) => { if (!isGuid(g)) { err(O + ".path[" + k + "]", "not a guid: " + show(g)); good = false; } });
          if (!good) return;
          const key = o.path.join("/");
          if (paths.has(key)) err(O + ".path", "same path as overrides[" + paths.get(key) + "]; one entry per path");
          else paths.set(key, j);
          firstHop(o.path[0], O + ".path[0]");
          let any = false;
          if (o.fields !== undefined) {
            if (!isObj(o.fields)) err(O + ".fields", "must be an object");
            else { checkFields(o.fields, O + ".fields"); if (Object.keys(o.fields).length) any = true; }
          }
          if (o.swap !== undefined) { resolveMaster(o.swap, O + ".swap"); any = true; }
          if (checkAssignments(o.properties, O + ".properties", null, true)) any = true;
          if (!any) err(O, "changes nothing; an override has fields, a swap or properties");
        });
        if (ov.length) {
          if (OVERRIDE_BASES.indexOf(inst.overrideBasis) < 0) err(P + ".overrideBasis", "must be one of " + OVERRIDE_BASES.join(", ") + "; got " + show(inst.overrideBasis));
          else if (!caps[inst.overrideBasis + "Overrides"]) err(P + ".overrideBasis", inst.overrideBasis + " overrides, but the header does not declare capabilities." + inst.overrideBasis + "Overrides");
        }
      }
    }
    if (inst.derived !== undefined) {
      if (!caps.derivedBoxes) err(P + ".derived", "present, but the header does not declare capabilities.derivedBoxes");
      else if (!Array.isArray(inst.derived)) err(P + ".derived", "must be an array");
      else inst.derived.forEach((d, j) => {
        const D = P + ".derived[" + j + "]";
        if (!isObj(d)) { err(D, "must be an object"); return; }
        // A fallback frame takes geometry and vector paths from derivedSymbolData (REWRITE.md §3),
        // so an entry may carry the sublayer's fill and stroke geometry, interned like node props.
        closed(d, ["path", "size", "transform", "fillGeometry", "strokeGeometry"], D);
        if (!Array.isArray(d.path) || d.path.length === 0 || !d.path.every(isGuid)) err(D + ".path", "a guidPath is a non-empty array of guids");
        else firstHop(d.path[0], D + ".path[0]");
        if (!(Array.isArray(d.size) && d.size.length === 2 && d.size.every(isNum))) err(D + ".size", "must be [width, height]");
        if (!(Array.isArray(d.transform) && d.transform.length === 6 && d.transform.every(isNum))) err(D + ".transform", "must be six numbers [a, b, tx, c, d, ty]");
        checkFields(d, D);
        for (const k of ["fillGeometry", "strokeGeometry"]) if (d[k] !== undefined) checkShape(k, d[k], D + "." + k);
      });
    }
  });

  // ---------- styles ----------
  const identities = new Map(), styleGuids = new Set();
  styles.forEach((s, i) => {
    const P = "styles[" + i + "]";
    if (!isObj(s)) { err(P, "must be an object"); return; }
    closed(s, ["guid", "type", "name", "styleKey", "value", "signature", "library", "deleted"], P);
    if (!isGuid(s.guid)) err(P + ".guid", "not a guid: " + show(s.guid));
    else if (styleGuids.has(s.guid)) err(P + ".guid", "duplicate style guid " + s.guid);
    else if (guidIndex.has(s.guid) || pageGuids.has(s.guid)) err(P + ".guid", s.guid + " is also a node's or a page's guid; a file has one guid space");
    if (isGuid(s.guid)) styleGuids.add(s.guid);
    if (STYLE_TYPES.indexOf(s.type) < 0) err(P + ".type", "must be one of " + STYLE_TYPES.join(", ") + "; got " + show(s.type));
    if (!isStr(s.name)) err(P + ".name", "must be a string");
    if (s.styleKey !== null && !(isStr(s.styleKey) && s.styleKey.length)) err(P + ".styleKey", "must be a string, or null when the source has none");
    if (!isInt(s.value) || s.value < 0 || s.value >= values.length) { err(P + ".value", "index " + show(s.value) + " is not in values (" + values.length + ")"); return; }
    const sig = valueSignature(values[s.value]);
    if (s.signature !== sig) err(P + ".signature", "is " + show(s.signature) + "; the value's signature is " + sig);
    // Identity is styleKey plus value, never the name and never the guid alone, so two copies of
    // one key with different values are two styles; two with the same value are one.
    if (isStr(s.styleKey)) {
      const id = s.styleKey + "|" + sig;
      if (identities.has(id)) err(P, "same styleKey and value as styles[" + identities.get(id) + "]; one style per identity");
      else identities.set(id, i);
    }
    if (s.type === "TEXT" && isObj(values[s.value]) && values[s.value].fontName !== undefined) fontRefs.push([P + ".value", null, values[s.value].fontName]);
    if (s.library !== undefined && s.library !== null) {
      if (!isObj(s.library)) err(P + ".library", "must be an object");
      else {
        closed(s.library, ["publishFile"], P + ".library");
        if (!(isStr(s.library.publishFile) && FILE_KEY.test(s.library.publishFile))) err(P + ".library.publishFile", "must be the library's file key");
      }
    }
    if (s.deleted !== undefined && typeof s.deleted !== "boolean") err(P + ".deleted", "must be a boolean");
  });

  // ---------- images ----------
  const images = table(ir.images, "images");
  const hashes = new Set();
  images.forEach((m, i) => {
    const P = "images[" + i + "]";
    if (!isObj(m)) { err(P, "must be an object"); return; }
    closed(m, ["hash", "present", "format"], P);
    if (!(isStr(m.hash) && HEX40.test(m.hash))) err(P + ".hash", "an image hash is the SHA-1 of its bytes, 40 lowercase hex; got " + show(m.hash));
    else if (hashes.has(m.hash)) err(P + ".hash", "duplicate image " + m.hash);
    else hashes.add(m.hash);
    if (typeof m.present !== "boolean") err(P + ".present", "must be a boolean: are the bytes in the source?");
    if (m.format !== undefined && IMAGE_FORMATS.indexOf(m.format) < 0) err(P + ".format", "must be one of " + IMAGE_FORMATS.join(", "));
  });
  // Every image paint, wherever it sits in values, names a listed image: a missing image is a
  // counted placeholder later, never an empty fill, and that needs the hash on the list. An image
  // paint with no hash at all (Figma allows imageHash null) would be exactly that empty fill.
  values.forEach((v, i) => {
    (function walk(x, P) {
      if (Array.isArray(x)) { x.forEach((y, j) => walk(y, P + "[" + j + "]")); return; }
      if (!isObj(x)) return;
      if (x.type === "IMAGE") {
        if (!isStr(x.imageHash)) err(P + ".imageHash", "an IMAGE paint names its image's hash; got " + show(x.imageHash) + " (a missing image is a placeholder later, never an empty fill)");
        else if (!hashes.has(x.imageHash)) err(P + ".imageHash", show(x.imageHash) + " is not in images");
      }
      for (const k of Object.keys(x)) walk(x[k], P + "." + k);
    })(v, "values[" + i + "]");
  });

  // ---------- fonts ----------
  const fonts = table(ir.fonts, "fonts");
  const fontSet = new Set();
  fonts.forEach((f, i) => {
    const P = "fonts[" + i + "]";
    if (!isObj(f)) { err(P, "must be an object"); return; }
    closed(f, ["family", "style"], P);
    if (!isStr(f.family) || !isStr(f.style)) { err(P, "a font is {family, style}"); return; }
    const k = f.family + "|" + f.style;
    if (fontSet.has(k)) err(P, "duplicate font " + f.family + " " + f.style);
    fontSet.add(k);
  });
  // Every font the IR uses is declared, because all of them are loaded before the first text write.
  for (const [P, idx, inline] of fontRefs) {
    const f = inline !== undefined ? inline : values[idx];
    if (!isObj(f) || !isStr(f.family) || !isStr(f.style)) { err(P, "a fontName is {family, style}; got " + show(f)); continue; }
    if (!fontSet.has(f.family + "|" + f.style)) err(P, "font " + f.family + " " + f.style + " is not declared in fonts");
  }

  // ---------- notes ----------
  table(ir.notes, "notes").forEach((nt, i) => {
    const P = "notes[" + i + "]";
    if (!isObj(nt)) { err(P, "must be an object"); return; }
    closed(nt, ["code", "node", "guid", "path", "detail"], P);
    if (!Object.prototype.hasOwnProperty.call(REASON_CODES, nt.code)) err(P + ".code", "unknown reason code " + show(nt.code) + "; codes come from the vocabulary in docs/IR.md");
    // The IR records what the reader decided; plan, build and run codes belong to the run's reports.
    else if (REASON_CODES[nt.code].stage !== "read") err(P + ".code", "IR notes carry read-stage codes only; " + nt.code + " is a " + REASON_CODES[nt.code].stage + "-stage code");
    else if (nt.code === CODE.VECTOR_ORACLE_DIFFERS) {
      const cls = isStr(nt.detail) ? nt.detail.split(": ")[0] : null;
      const vn = nodeAt(nt.node);
      if (BOOLEAN_ORACLE_CLASSES.indexOf(cls) >= 0) {
        if (!vn || vn.type !== "BOOLEAN_OPERATION" || !isObj(vn.props) || vn.props.oracleFillGeometry === undefined) err(P + ".node", "a " + nt.code + " " + cls + " note names a BOOLEAN_OPERATION record with its stored result");
      } else {
        if (ORACLE_CLASSES.indexOf(cls) < 0) err(P + ".detail", "a " + nt.code + " detail starts with its class, one of " + ORACLE_CLASSES.concat(BOOLEAN_ORACLE_CLASSES).join(", ") + "; got " + show(nt.detail));
        if (!vn || vn.type !== "VECTOR" || !isObj(vn.props) || vn.props.vectorNetwork === undefined) err(P + ".node", "a " + nt.code + " note names a VECTOR record built from its network");
      }
    }
    if (nt.node !== undefined && !nodeAt(nt.node)) err(P + ".node", "index " + show(nt.node) + " is not a node record");
    if (nt.guid !== undefined && !isGuid(nt.guid)) err(P + ".guid", "not a guid: " + show(nt.guid));
    if (nt.path !== undefined && !(Array.isArray(nt.path) && nt.path.length > 0 && nt.path.every(isGuid))) err(P + ".path", "a guidPath is a non-empty array of guids");
    if (nt.detail !== undefined && !isStr(nt.detail)) err(P + ".detail", "must be a string");
  });

  return done();
}

// The IR, version 1: what a source (a saved .pix or live Pixso) tells the builder, as data only.
// docs/IR.md describes it; this file is the part of that description a program can check.
//
//   import { validateIR } from "./ir/schema.mjs";
//   const { ok, errors } = validateIR(ir);      // errors: [{ path: "nodes[3].parent", message }]
//
// Dependency-free, free of Node built-ins, and free of TextEncoder and BigInt, which the plugin's
// main-thread sandbox may lack: the runner refuses an IR before anything is built, and the plugin
// may want the same check later. tools/test-ir.mjs runs it in a context without them. Its syntax
// is ES2015 (const, arrow functions, Map, Set, for-of); nothing in REWRITE.md §9 has checked that
// syntax in Figma's sandbox yet, so bundling it into the plugin needs that check (or a transpile).
//
// What it checks is structure and reference integrity — the things that, wrong, make the builder
// do something silently different from what the reader meant: an unknown format or version, the
// header, parent-first order, every index into a table, every reason code, every master reference,
// and that the content never claims more than the header's capabilities declare. It does not
// re-derive what the reader decided (variant parsing, swap-aware path resolution, stale and echo
// classification); those have their own tests where they are computed.

export const FORMAT = "pix2fig.ir";
export const VERSION = 1;

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
};
export const SETTING_KEYS = Object.keys(SETTINGS).concat(["kitmaps"]);
export const SETTING_FLAGS = { mode: "--mode", overrides: "--overrides", drift: "--drift", deleted: "--deleted",
  resync: "--resync", textFit: "--text-fit", kitmaps: "--kitmaps" };

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
export const INTERNED_PROPS = ["fills", "strokes", "effects", "layoutGrids", "exportSettings", "dashPattern",
  "constraints", "fontName", "letterSpacing", "lineHeight", "arcData", "vectorNetwork", "fillGeometry",
  "strokeGeometry"];
// Of those, the ones whose value is a list; the rest point at an object.
export const LIST_VALUES = ["fills", "strokes", "effects", "layoutGrids", "exportSettings", "dashPattern", "fillGeometry",
  "strokeGeometry"];
// Properties whose value is an index into `styles`, and the style type each must point at.
export const STYLE_REFS = { fillStyle: "PAINT", strokeStyle: "PAINT", textStyle: "TEXT", effectStyle: "EFFECT",
  gridStyle: "GRID" };
// Keys of props.componentPropertyReferences, and the property type each may be bound to.
export const PROPERTY_REF_FIELDS = { characters: "TEXT", visible: "BOOLEAN", mainComponent: "INSTANCE_SWAP" };

// ---------- reason codes ----------
// One vocabulary for IR notes and for run reports. `plan` is where docs/REWRITE.md names the code;
// null marks the codes this IR names for conditions REWRITE.md counts without naming them, each
// with the sentence it comes from in `from`. Stages: run (stops the run), read (source -> IR),
// plan (preflight and kit-map resolution), build (in Figma).
export const REASON_CODES = {
  PIX_CORRUPT: { stage: "run", plan: "§6", meaning: "the .pix is truncated, uses a field id its schema does not define, or does not end on its last byte; nothing is built" },
  IDENTITY_CHANGED: { stage: "run", plan: "§4", meaning: "after a reconnect the file open in Pixso is not the file being read; the run stops" },
  KIT_FILEKEY_CONFLICT: { stage: "run", plan: "§5", meaning: "sources disagree about a kit's own Pixso file key; the run stops and no kit map is written" },

  VARIANT_SET_REJECTED: { stage: "read", plan: "§3", meaning: "a state group whose member names do not parse into one set of axes; its members become standalone components" },
  STALE_ASSIGNMENT: { stage: "read", plan: "§3", meaning: "a property assignment whose definition cannot be reached from the instance's current family; dropped, never matched by name" },
  STYLE_MISSING_IN_SOURCE: { stage: "read", plan: "§3", meaning: "a style reference that resolves nowhere; the node keeps its raw values" },
  STYLE_VALUE_DIFFERS: { stage: "read", plan: "§3", meaning: "the node's own value differs from its style's by more than 1/255 per channel; the raw value stays, the style is not bound" },
  VECTOR_FROM_GEOMETRY: { stage: "read", plan: "§3", meaning: "a vector with fill geometry but no region, built from its stored fill and stroke geometry" },
  OVERRIDE_STALE: { stage: "read", plan: null, from: "§3: entries whose path is absent from derivedSymbolData are provably stale: dropped and counted", meaning: "an override entry whose path is absent from derivedSymbolData; dropped" },
  OVERRIDE_ECHO: { stage: "read", plan: null, from: "§3: many override fields only echo the master's value and must be dropped before applying", meaning: "an override field equal to the master's value; dropped" },
  NODE_TYPE_UNSUPPORTED: { stage: "read", plan: null, from: "§7: coverage, with every loss given a reason code; §8: the fixture covers an unsupported node type", meaning: "a source node of a type the IR has no type for; it and its subtree are not carried" },

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

// ---------- the validator ----------
export function validateIR(ir, options) {
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
    closed(p, ["guid", "name", "internal"], P);
    if (!isGuid(p.guid)) err(P + ".guid", "not a guid: " + show(p.guid));
    else if (pageGuids.has(p.guid)) err(P + ".guid", "duplicate page guid " + p.guid);
    else pageGuids.add(p.guid);
    if (!isStr(p.name)) err(P + ".name", "must be a string");
    if (typeof p.internal !== "boolean") err(P + ".internal", "must be a boolean");
  });

  // ---------- values ----------
  const values = table(ir.values, "values");
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
    if (n.props !== undefined && !isObj(n.props)) err(P + ".props", "must be an object");
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
  nodes.forEach((n, i) => {
    if (!nodeOk[i] || !isObj(n.props)) return;
    const P = "nodes[" + i + "].props";
    const pr = n.props;
    checkFields(pr, P);
    if (pr.inkBounds !== undefined) {
      if (!caps.inkBounds) err(P + ".inkBounds", "present, but the header does not declare capabilities.inkBounds");
      else if (!(Array.isArray(pr.inkBounds) && pr.inkBounds.length === 4 && pr.inkBounds.every(isNum))) err(P + ".inkBounds", "must be [x, y, width, height]");
    }
    if (pr.relativeTransform !== undefined && !(Array.isArray(pr.relativeTransform) && pr.relativeTransform.length === 6 && pr.relativeTransform.every(isNum))) err(P + ".relativeTransform", "must be six numbers [a, b, tx, c, d, ty]");
    if (n.type === "TEXT" && pr.characters !== undefined && !isStr(pr.characters)) err(P + ".characters", "must be a string");
    if (pr.lines !== undefined && (n.type !== "TEXT" || !isInt(pr.lines) || pr.lines < 0)) err(P + ".lines", "the number of lines Pixso drew: a TEXT record's non-negative integer; got " + show(pr.lines));
    if (pr.textRanges !== undefined) {
      if (n.type !== "TEXT") err(P + ".textRanges", "only a TEXT record has text ranges");
      else if (!Array.isArray(pr.textRanges)) err(P + ".textRanges", "must be an array");
      else {
        const len = isStr(pr.characters) ? pr.characters.length : 0;
        let prevEnd = 0;
        pr.textRanges.forEach((r, j) => {
          const R = P + ".textRanges[" + j + "]";
          if (!isObj(r)) { err(R, "must be an object"); return; }
          closed(r, ["start", "end", "fields"], R);
          if (!isInt(r.start) || !isInt(r.end) || r.start < 0 || r.end <= r.start || r.end > len) { err(R, "range [" + show(r.start) + ", " + show(r.end) + ") is not inside the " + len + " UTF-16 units of characters"); return; }
          if (r.start < prevEnd) err(R + ".start", "ranges are ascending and do not overlap; this one starts at " + r.start + " before the previous end " + prevEnd);
          prevEnd = r.end;
          if (!isObj(r.fields)) err(R + ".fields", "must be an object");
          else checkFields(r.fields, R + ".fields");
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
    if (nt.node !== undefined && !nodeAt(nt.node)) err(P + ".node", "index " + show(nt.node) + " is not a node record");
    if (nt.guid !== undefined && !isGuid(nt.guid)) err(P + ".guid", "not a guid: " + show(nt.guid));
    if (nt.path !== undefined && !(Array.isArray(nt.path) && nt.path.length > 0 && nt.path.every(isGuid))) err(P + ".path", "a guidPath is a non-empty array of guids");
    if (nt.detail !== undefined && !isStr(nt.detail)) err(P + ".detail", "must be a string");
  });

  return done();
}

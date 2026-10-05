// A task: one unit of work the runner hands the plugin, cut from the IR by the planner
// (docs/M1.md §5.2). Data only; it names one op of the plugin's `ir` command and carries the IR
// records that op needs, never code and never Pixso's oracle.
//
//   import { validateTask } from "./ir/validate.mjs";          // Node: the schema is passed for you
//   validateTask(task, { maxChars })  -> { ok, errors: [{ path, message }] }
//
//   PXF_TASK.validateTask(task, { schema: PXF_SCHEMA })        // the plugin (tools/build-plugin.mjs)
//
// validateTask(task, { schema, maxChars, maxErrors }): `schema` is tools/ir/schema.mjs (its codes,
// node types, interned props and enums), passed as data because this file imports nothing: the
// plugin bundles it as PXF_TASK, ES2015, no Node built-in. Without `schema` it throws a TypeError,
// because "ok" from a check that could not run would be a lie. It never throws on the task itself.
// maxChars is the size cap in characters of the task's JSON (MAX_TASK_CHARS by default; a value
// above MAX_TASK_CHARS_CEILING is taken as the ceiling). At most maxErrors (200) errors are listed.
//
// The shape, every record closed (an unknown key is an error):
//
//   { format: "pix2fig.task", version: 1, op: "fonts"|"build"|"verify"|"clean",
//     runId: 16 lowercase hex, taskNo: 1.., of: taskNo.., snapshot: snapshotId(IR header), irVersion: 2,
//     settings: { textFit: "widen"|"source-box", layoutOrder: "creation"|"deepestFirst",
//                 textRead: "measure"|"inLoop", fallbackFont: { family, style } },
//     page: { index: IR page index | null, guid: page guid | "m1-service", name, service: bool,
//             background: values key | null } | null,
//     roots: [{ i, attachTo: "page" | { i }, place: [x, y] | null }],
//     nodes: [{ i, parent, guid, type, name, props, instance? }],
//     notes: [{ code, i, detail: string | null }],
//     values: { "<IR values index>": value },
//     fonts: [{ family, style }],
//     images: [{ hash, source: "archive"|"mcp"|"render"|"none", format, reason: string | null }],
//     expect: { count, nonInstance, placeholders } | null }
//
// What each part of it means:
// - nodes: IR records by their IR index i, parent-first, with the IR parent index (-1 for a page's
//   top-level record). props are the IR's props with ORACLE_PROPS stripped; interned props are keys
//   of `values` (the IR's own indices, as strings). instance is the IR's instance data, INSTANCE only.
//   type is the IR type; BUILT_TYPE says what Figma node it becomes.
// - roots: where each subtree of this task attaches. A node whose parent is not in the task is a root.
//   attachTo "page": a top-level record (parent -1), or any S2 master on the service page.
//   attachTo { i }: a split root whose IR parent i was built by an earlier task; i is its parent.
//   place: the S2 grid position on the service page, or null. It never enters a comparison.
// - notes: the IR notes of these records (read-stage codes). A VECTOR built from fillGeometry must
//   have one of schema.GEOMETRY_SOURCE_CODES among them (docs/M1.md §5.2).
// - values: exactly the values the task references, no more.
// - fonts: every font the task's text uses (all loaded before the first text write).
// - images: every image hash an IMAGE paint in values names, with where its bytes came from;
//   "none" means the builder draws IMAGE_PLACEHOLDER.
// - expect: what VERIFY should find, for build and verify; count = nodes, placeholders = INSTANCE
//   records, nonInstance = the rest.
// Per op: fonts carries only settings and fonts (page null, everything else empty); clean carries the
// root records only (no expect); build and verify carry a page, roots, nodes and expect.

export const TASK_FORMAT = "pix2fig.task";
export const TASK_VERSION = 1;
// The IR version the task's records come from; tools/test-m1-contract.mjs checks it equals schema.VERSION.
export const TASK_IR_VERSION = 2;
export const TASK_OPS = ["fonts", "build", "verify", "clean"];
// 4 MB of JSON text; --max-task-mb lowers or raises it, never above 16 MB (P3: the largest message
// measured to cross the plugin boundary, and the report slices are 400 000 characters).
export const MAX_TASK_CHARS = 4194304;
export const MAX_TASK_CHARS_CEILING = 16777216;
// The page S2 masters are built on: stamped pxPage = SERVICE_PAGE_GUID instead of a page guid.
export const SERVICE_PAGE_GUID = "m1-service";
// The Figma node an IR type becomes (docs/M1.md D4, D6). COMPONENT_SET, SLICE and SLOT are not
// built in M1, so a task carrying one is refused.
export const BUILT_TYPE = Object.freeze({ FRAME: "FRAME", GROUP: "FRAME", SECTION: "SECTION", COMPONENT: "COMPONENT",
  INSTANCE: "FRAME", RECTANGLE: "RECTANGLE", ELLIPSE: "ELLIPSE", POLYGON: "POLYGON", STAR: "STAR", LINE: "LINE",
  VECTOR: "VECTOR", BOOLEAN_OPERATION: "BOOLEAN_OPERATION", TEXT: "TEXT" });
// The builder's settings (docs/M1.md §3, D11); textFit's values are the IR's (schema.SETTINGS.textFit).
export const TASK_SETTINGS = { layoutOrder: ["creation", "deepestFirst"], textRead: ["measure", "inLoop"] };
export const TASK_SETTING_DEFAULTS = { textFit: "widen", layoutOrder: "creation", textRead: "measure",
  fallbackFont: { family: "Inter", style: "Regular" } };
export const IMAGE_SOURCES = ["archive", "mcp", "render", "none"];

// --max-task-mb n -> the cap in characters. n is 1..16; anything else throws.
export function maxTaskChars(mb) {
  if (typeof mb !== "number" || !(mb >= 1 && mb <= 16)) throw new RangeError("--max-task-mb is 1 to 16; got " + mb);
  return Math.floor(mb * 1048576);
}

// The size the cap is measured on: the task's JSON text, as the runner sends it.
export function taskChars(task) {
  return JSON.stringify(task).length;
}

export function validateTask(task, deps) {
  const S = deps && deps.schema;
  if (!S || typeof S.REASON_CODES !== "object" || !Array.isArray(S.INTERNED_PROPS)) {
    throw new TypeError("validateTask(task, { schema }) needs tools/ir/schema.mjs; call validateTask from tools/ir/validate.mjs, or pass PXF_SCHEMA");
  }
  const maxErrors = (deps && deps.maxErrors) || 200;
  let maxChars = (deps && deps.maxChars) || MAX_TASK_CHARS;
  if (maxChars > MAX_TASK_CHARS_CEILING) maxChars = MAX_TASK_CHARS_CEILING;
  const errors = [];
  let dropped = 0;
  const err = (path, message) => { if (errors.length < maxErrors) errors.push({ path, message }); else dropped++; };
  const done = () => {
    if (dropped) errors.push({ path: "", message: dropped + " more error" + (dropped === 1 ? "" : "s") + " not listed" });
    return { ok: errors.length === 0, errors };
  };
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isInt = (v) => typeof v === "number" && Number.isInteger(v);
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const isStr = (v) => typeof v === "string";
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const show = (v) => { let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } if (s === undefined) s = String(v); return s.length > 60 ? s.slice(0, 57) + "..." : s; };
  const closed = (o, allowed, path) => { for (const k of Object.keys(o)) if (allowed.indexOf(k) < 0) err(path ? path + "." + k : k, "unknown key " + show(k)); };
  const GUID = /^\d+:\d+$/;

  if (!isObj(task)) { err("", "a task is a JSON object"); return done(); }
  if (task.format !== TASK_FORMAT) { err("format", "unknown format " + show(task.format) + "; expected " + show(TASK_FORMAT)); return done(); }
  if (task.version !== TASK_VERSION) { err("version", "unsupported task version " + show(task.version) + "; this plugin knows version " + TASK_VERSION + " only"); return done(); }
  closed(task, ["format", "version", "op", "runId", "taskNo", "of", "snapshot", "irVersion", "settings", "page", "roots",
    "nodes", "notes", "values", "fonts", "images", "expect"], "");
  let size = -1;
  try { size = taskChars(task); } catch (e) { err("", "the task does not serialise: " + ((e && e.message) || e)); }
  if (size > maxChars) err("", "the task is " + size + " characters; the cap is " + maxChars + " (--max-task-mb)");
  if (task.irVersion !== S.VERSION) err("irVersion", "the task's records are IR version " + show(task.irVersion) + "; this build knows version " + S.VERSION);
  const op = task.op;
  if (TASK_OPS.indexOf(op) < 0) err("op", "must be one of " + TASK_OPS.join(", ") + "; got " + show(op));
  if (!(isStr(task.runId) && /^[0-9a-f]{16}$/.test(task.runId))) err("runId", "16 lowercase hex; got " + show(task.runId));
  if (!isInt(task.taskNo) || task.taskNo < 1) err("taskNo", "an integer from 1; got " + show(task.taskNo));
  else if (!isInt(task.of) || task.of < task.taskNo) err("of", "the number of tasks in the run, at least taskNo; got " + show(task.of));
  if (!(isStr(task.snapshot) && /^(pix|mcp):./.test(task.snapshot))) err("snapshot", "the IR's snapshotId (pix:… or mcp:…); got " + show(task.snapshot));

  const st = task.settings;
  if (!isObj(st)) err("settings", "missing; the builder's settings travel with every task");
  else {
    closed(st, ["textFit", "layoutOrder", "textRead", "fallbackFont"], "settings");
    if (S.SETTINGS.textFit.indexOf(st.textFit) < 0) err("settings.textFit", "must be one of " + S.SETTINGS.textFit.join(", ") + "; got " + show(st.textFit));
    for (const k of Object.keys(TASK_SETTINGS)) if (TASK_SETTINGS[k].indexOf(st[k]) < 0) err("settings." + k, "must be one of " + TASK_SETTINGS[k].join(", ") + "; got " + show(st[k]));
    const f = st.fallbackFont;
    if (!isObj(f) || !isStr(f.family) || !f.family || !isStr(f.style) || !f.style || Object.keys(f).length !== 2) err("settings.fallbackFont", "a font {family, style}; got " + show(f));
  }

  const values = isObj(task.values) ? task.values : {};
  if (!isObj(task.values)) err("values", "an object keyed by IR values index");
  else for (const k of Object.keys(values)) if (!/^(0|[1-9]\d*)$/.test(k)) err("values." + k, "a key is an IR values index");
  const used = new Set();
  const useValue = (idx, path, what) => {
    const k = String(idx);
    if (!isInt(idx) || idx < 0) { err(path, what + " is an IR values index; got " + show(idx)); return undefined; }
    if (!own(values, k)) { err(path, "values[" + k + "] is not carried by the task"); return undefined; }
    used.add(k);
    return values[k];
  };

  const page = task.page;
  if (page === null || page === undefined) {
    if (op === "build" || op === "verify") err("page", "a " + op + " task names its page");
  } else if (!isObj(page)) err("page", "an object or null");
  else {
    closed(page, ["index", "guid", "name", "service", "background"], "page");
    if (typeof page.service !== "boolean") err("page.service", "must be a boolean");
    if (page.service === true) {
      if (page.guid !== SERVICE_PAGE_GUID || page.index !== null) err("page", "the service page has guid " + show(SERVICE_PAGE_GUID) + " and index null");
    } else {
      if (!(isStr(page.guid) && GUID.test(page.guid))) err("page.guid", "a page guid; got " + show(page.guid));
      if (!isInt(page.index) || page.index < 0) err("page.index", "an IR page index; got " + show(page.index));
    }
    if (!isStr(page.name)) err("page.name", "must be a string");
    if (page.background !== null) {
      const v = useValue(page.background, "page.background", "background");
      if (v !== undefined && !Array.isArray(v)) err("page.background", "values[" + page.background + "] is not a fills list");
    }
  }

  // Nodes, parent-first.
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  if (!Array.isArray(task.nodes)) err("nodes", "must be an array");
  const at = new Map();
  const posOf = new Map();
  nodes.forEach((n, j) => { if (isObj(n) && isInt(n.i) && !posOf.has(n.i)) posOf.set(n.i, j); });
  const fontRefs = [];
  let placeholders = 0;
  nodes.forEach((n, j) => {
    const P = "nodes[" + j + "]";
    if (!isObj(n)) { err(P, "must be an object"); return; }
    closed(n, ["i", "parent", "guid", "type", "name", "props", "instance"], P);
    if (!isInt(n.i) || n.i < 0) { err(P + ".i", "an IR index; got " + show(n.i)); return; }
    if (at.has(n.i)) { err(P + ".i", "IR record " + n.i + " twice"); return; }
    if (!isInt(n.parent) || n.parent < -1) err(P + ".parent", "the IR parent index, or -1; got " + show(n.parent));
    else if (posOf.has(n.parent) && posOf.get(n.parent) > j) err(P + ".parent", "parent " + n.parent + " comes after this record; records are parent-first");
    if (!(isStr(n.guid) && GUID.test(n.guid))) err(P + ".guid", "not a guid: " + show(n.guid));
    if (!own(BUILT_TYPE, n.type)) err(P + ".type", show(n.type) + " is not built in M1 (BUILT_TYPE: " + Object.keys(BUILT_TYPE).join(", ") + ")");
    if (!isStr(n.name)) err(P + ".name", "must be a string");
    if (n.type === "INSTANCE") { placeholders++; if (n.instance !== undefined && !isObj(n.instance)) err(P + ".instance", "must be an object"); }
    else if (n.instance !== undefined) err(P + ".instance", "only an INSTANCE record carries instance data");
    at.set(n.i, n);
    const pr = n.props;
    if (!isObj(pr)) { err(P + ".props", "must be an object"); return; }
    for (const k of S.ORACLE_PROPS) if (own(pr, k)) err(P + ".props." + k, "Pixso's oracle never travels to the plugin; the planner strips it");
    if (!(Array.isArray(pr.relativeTransform) && pr.relativeTransform.length === 6 && pr.relativeTransform.every(isNum))) err(P + ".props.relativeTransform", "six finite numbers");
    for (const k of ["width", "height"]) if (!(isNum(pr[k]) && pr[k] >= 0)) err(P + ".props." + k, "a finite number >= 0; got " + show(pr[k]));
    const fields = (f, FP) => {
      for (const k of S.INTERNED_PROPS) {
        if (f[k] === undefined) continue;
        const v = useValue(f[k], FP + "." + k, k);
        if (v !== undefined && k === "fontName") fontRefs.push([FP + "." + k, v]);
      }
    };
    fields(pr, P + ".props");
    if (Array.isArray(pr.textRanges)) pr.textRanges.forEach((r, q) => { if (isObj(r) && isObj(r.fields)) fields(r.fields, P + ".props.textRanges[" + q + "].fields"); });
    if (n.type === "VECTOR") {
      const has = ["vectorNetwork", "fillGeometry"].filter((k) => pr[k] !== undefined);
      if (has.length !== 1) err(P + ".props", "a VECTOR carries exactly one build source, vectorNetwork or fillGeometry; it has " + (has.length ? has.join(" and ") : "neither"));
    }
  });

  // Roots.
  const roots = Array.isArray(task.roots) ? task.roots : [];
  if (!Array.isArray(task.roots)) err("roots", "must be an array");
  const rootSet = new Set();
  roots.forEach((r, j) => {
    const P = "roots[" + j + "]";
    if (!isObj(r)) { err(P, "must be an object"); return; }
    closed(r, ["i", "attachTo", "place"], P);
    const n = at.get(r.i);
    if (!n) { err(P + ".i", "IR record " + show(r.i) + " is not among the task's nodes"); return; }
    if (rootSet.has(r.i)) err(P + ".i", "root " + r.i + " twice");
    rootSet.add(r.i);
    if (r.attachTo === "page") {
      if (n.parent !== -1 && !(isObj(page) && page.service === true)) err(P + ".attachTo", "only a top-level record, or an S2 master on the service page, attaches to the page");
    } else if (isObj(r.attachTo) && Object.keys(r.attachTo).length === 1 && isInt(r.attachTo.i)) {
      if (r.attachTo.i !== n.parent) err(P + ".attachTo.i", "a split root attaches to its IR parent " + show(n.parent) + "; got " + r.attachTo.i);
      else if (at.has(r.attachTo.i)) err(P + ".attachTo.i", "the parent is in this task, so the record is not a root");
    } else err(P + ".attachTo", "\"page\" or { i }; got " + show(r.attachTo));
    if (r.place !== null) {
      if (!(Array.isArray(r.place) && r.place.length === 2 && r.place.every(isNum))) err(P + ".place", "[x, y] or null; got " + show(r.place));
      else if (!(isObj(page) && page.service === true)) err(P + ".place", "a grid position is given only on the service page");
    }
  });
  // Every record whose parent is not in the task is a root, and only those.
  nodes.forEach((n, j) => {
    if (!isObj(n) || !isInt(n.i) || at.get(n.i) !== n) return;
    const inTask = isInt(n.parent) && n.parent >= 0 && at.has(n.parent);
    if (!inTask && !rootSet.has(n.i)) err("nodes[" + j + "]", "IR record " + n.i + " has no parent in the task and is not listed in roots");
    if (inTask && rootSet.has(n.i)) err("nodes[" + j + "]", "IR record " + n.i + " is listed in roots but its parent is in the task");
  });

  // Notes.
  const notes = Array.isArray(task.notes) ? task.notes : [];
  if (!Array.isArray(task.notes)) err("notes", "must be an array");
  const noted = new Map();
  notes.forEach((nt, j) => {
    const P = "notes[" + j + "]";
    if (!isObj(nt)) { err(P, "must be an object"); return; }
    closed(nt, ["code", "i", "detail"], P);
    if (!own(S.REASON_CODES, nt.code)) err(P + ".code", "unknown reason code " + show(nt.code));
    else if (S.REASON_CODES[nt.code].stage !== "read") err(P + ".code", "a task carries the IR's notes, read-stage codes only; " + nt.code + " is " + S.REASON_CODES[nt.code].stage);
    if (!at.has(nt.i)) err(P + ".i", "IR record " + show(nt.i) + " is not among the task's nodes");
    else { if (!noted.has(nt.i)) noted.set(nt.i, []); noted.get(nt.i).push(nt.code); }
    if (nt.detail !== null && !isStr(nt.detail)) err(P + ".detail", "a string or null");
  });
  // A geometry-built vector says why (docs/M1.md §5.2): a task error otherwise, not a silent build.
  nodes.forEach((n, j) => {
    if (!isObj(n) || n.type !== "VECTOR" || !isObj(n.props) || n.props.fillGeometry === undefined) return;
    if (!(noted.get(n.i) || []).some((c) => S.GEOMETRY_SOURCE_CODES.indexOf(c) >= 0)) err("nodes[" + j + "].props.fillGeometry", "a VECTOR built from geometry carries one of " + S.GEOMETRY_SOURCE_CODES.join(", ") + " in notes");
  });

  // Fonts.
  const fonts = Array.isArray(task.fonts) ? task.fonts : [];
  if (!Array.isArray(task.fonts)) err("fonts", "must be an array");
  const fontSet = new Set();
  fonts.forEach((f, j) => {
    const P = "fonts[" + j + "]";
    if (!isObj(f)) { err(P, "must be an object"); return; }
    closed(f, ["family", "style"], P);
    if (!isStr(f.family) || !isStr(f.style)) { err(P, "a font is {family, style}"); return; }
    const k = f.family + "|" + f.style;
    if (fontSet.has(k)) err(P, "duplicate font " + f.family + " " + f.style);
    fontSet.add(k);
  });
  for (const [P, f] of fontRefs) {
    if (!isObj(f) || !isStr(f.family) || !isStr(f.style)) err(P, "a fontName is {family, style}");
    else if (!fontSet.has(f.family + "|" + f.style)) err(P, "font " + f.family + " " + f.style + " is not in the task's fonts");
  }

  // Images: every IMAGE paint in the task's values names a listed image.
  const images = Array.isArray(task.images) ? task.images : [];
  if (!Array.isArray(task.images)) err("images", "must be an array");
  const hashes = new Set();
  images.forEach((m, j) => {
    const P = "images[" + j + "]";
    if (!isObj(m)) { err(P, "must be an object"); return; }
    closed(m, ["hash", "source", "format", "reason"], P);
    if (!(isStr(m.hash) && /^[0-9a-f]{40}$/.test(m.hash))) err(P + ".hash", "40 lowercase hex");
    else if (hashes.has(m.hash)) err(P + ".hash", "duplicate image");
    else hashes.add(m.hash);
    if (IMAGE_SOURCES.indexOf(m.source) < 0) err(P + ".source", "must be one of " + IMAGE_SOURCES.join(", ") + "; got " + show(m.source));
    if (S.IMAGE_FORMATS.indexOf(m.format) < 0) err(P + ".format", "must be one of " + S.IMAGE_FORMATS.join(", "));
    if (m.reason !== null && !isStr(m.reason)) err(P + ".reason", "a string or null");
  });
  for (const k of Object.keys(values)) {
    (function walk(x, P) {
      if (Array.isArray(x)) { x.forEach((y, q) => walk(y, P + "[" + q + "]")); return; }
      if (!isObj(x)) return;
      if (x.type === "IMAGE" && !hashes.has(x.imageHash)) err(P + ".imageHash", show(x.imageHash) + " is not in the task's images");
      for (const q of Object.keys(x)) walk(x[q], P + "." + q);
    })(values[k], "values." + k);
  }
  for (const k of Object.keys(values)) if (!used.has(k)) err("values." + k, "not referenced by the task; a task carries only the values it uses");

  // What VERIFY should find.
  const ex = task.expect;
  if (op === "build" || op === "verify") {
    if (!isObj(ex)) err("expect", "a " + op + " task says what VERIFY should find: {count, nonInstance, placeholders}");
    else {
      closed(ex, ["count", "nonInstance", "placeholders"], "expect");
      if (ex.count !== nodes.length) err("expect.count", "is " + show(ex.count) + "; the task has " + nodes.length + " records");
      if (ex.placeholders !== placeholders) err("expect.placeholders", "is " + show(ex.placeholders) + "; the task has " + placeholders + " INSTANCE records");
      if (ex.nonInstance !== nodes.length - placeholders) err("expect.nonInstance", "is " + show(ex.nonInstance) + "; the task has " + (nodes.length - placeholders));
    }
  } else if (ex !== null) err("expect", "a " + show(op) + " task has expect null");

  // Per op.
  if (op === "fonts") {
    if (page !== null) err("page", "a fonts task has page null");
    for (const k of ["roots", "nodes", "notes", "images"]) if (Array.isArray(task[k]) && task[k].length) err(k, "a fonts task carries none");
    if (Object.keys(values).length) err("values", "a fonts task carries none");
  } else if (op === "clean") {
    if (!roots.length) err("roots", "a clean task names the roots it may replace");
    if (nodes.length !== roots.length) err("nodes", "a clean task carries the root records only");
  } else if (op === "build" || op === "verify") {
    if (!roots.length) err("roots", "a " + op + " task has at least one root");
  }
  return done();
}

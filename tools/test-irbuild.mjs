// Part B's tests: the IR builder in the plugin, run as bundled (tools/ir/plugin-vm.mjs) against the
// headless double (tools/double/index.mjs), from hand-made IR tasks (docs/M1.md §6 B).
//
//   node tools/test-irbuild.mjs
//
// Every task here is synthetic and passes tools/ir/validate.mjs validateTask first (the refusal cases
// apart), so the builder is tested on what the planner may hand it. Image hashes are computed at run
// time (tools/test-hygiene.mjs). The checks that needed part E's layout engine and text model printed
// "pending: E" on the P0 double; part F made them plain checks after E merged (docs/M1.md §15).
import { createHash } from "node:crypto";
import * as schema from "./ir/schema.mjs";
import * as props from "./ir/props.mjs";
import * as taskMod from "./ir/task.mjs";
import { validateTask } from "./ir/validate.mjs";
import { judgeTask } from "./ir/judge.mjs";
import { makeDouble, loadVerdicts, DOUBLE_FEATURES } from "./double/index.mjs";
import { loadPluginBundle, defaultHost } from "./ir/plugin-vm.mjs";
import { irBundle, IR_SRC_DIR } from "./build-plugin.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why !== undefined ? " — " + String(why).slice(0, 400) : "")));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ============================================================================================
// synthetic tasks
// ============================================================================================
const SNAP = schema.snapshotId({ source: { kind: "pix", sha256: "0".repeat(62) + "a1" } });
const RUN = "0123456789abcdef", RUN2 = "fedcba9876543210";
const SETTINGS = () => clone({ textFit: "widen", layoutOrder: "creation", textRead: "measure", fallbackFont: { family: "Inter", style: "Regular" } });
const T6 = (x, y) => [1, 0, x, 0, 1, y];
const ROT90 = (x, y) => [0, -1, x, 1, 0, y];
const SOLID = (r, g, b) => ({ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r, g, b } });
const INTER = { family: "Inter", style: "Regular" };
const painted = (o) => Object.assign({ fills: [], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", blendMode: "PASS_THROUGH" }, o || {});
const frameProps = (o) => painted(Object.assign({ clipsContent: true, layoutMode: "NONE", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" }, o || {}));
let G = 100;
const rec = (i, parent, type, box, p) => ({ i, parent, guid: "1:" + (G + i), type, name: type.slice(0, 1) + i,
  props: Object.assign({ relativeTransform: box[0], width: box[1], height: box[2] }, p || {}) });
const frame = (i, parent, box, p) => rec(i, parent, "FRAME", box, frameProps(p));
const component = (i, parent, box, p) => rec(i, parent, "COMPONENT", box, frameProps(p));
const rect = (i, parent, box, p) => rec(i, parent, "RECTANGLE", box, painted(p));
const text = (i, parent, box, chars, p) => rec(i, parent, "TEXT", box, painted(Object.assign({ characters: chars, fontName: INTER, fontSize: 12, textAutoResize: "NONE", strokeAlign: "OUTSIDE" }, p || {})));
const group = (i, parent, box, p) => rec(i, parent, "GROUP", box, Object.assign({ blendMode: "PASS_THROUGH" }, p || {}));
const instance = (i, parent, box, p) => rec(i, parent, "INSTANCE", box, p);
const vector = (i, parent, box, p) => rec(i, parent, "VECTOR", box, painted(Object.assign({ strokeAlign: "CENTER" }, p || {})));
const boolean = (i, parent, box, op, p) => rec(i, parent, "BOOLEAN_OPERATION", box, painted(Object.assign({ booleanOperation: op, strokeAlign: "CENTER" }, p || {})));
const NET_SQUARE = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
  regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2, 3]] }] };
const GEO_TRI = [{ windingRule: "EVENODD", data: "M 0 0 L 10 0 L 5 8 Z" }];

// Interns every interned prop (node props, range fields, the page background) into values, as the
// planner does, collects the fonts, lists the roots, and fills expect. Raw values in, a task out.
function mkTask(o) {
  const values = {}, keyOf = new Map();
  const intern = (v) => {
    const k = schema.canonicalJSON(v);
    if (!keyOf.has(k)) { const idx = keyOf.size; keyOf.set(k, idx); values[String(idx)] = clone(v); }
    return keyOf.get(k);
  };
  const fonts = [], fontSet = new Set();
  const font = (f) => { const k = f.family + "|" + f.style; if (!fontSet.has(k)) { fontSet.add(k); fonts.push({ family: f.family, style: f.style }); } };
  const nodes = o.nodes.map((n) => {
    const r = clone(n);
    for (const k of schema.INTERNED_PROPS) {
      if (r.props[k] === undefined || typeof r.props[k] === "number") continue;
      if (k === "fontName") font(r.props[k]);
      r.props[k] = intern(r.props[k]);
    }
    if (Array.isArray(r.props.textRanges)) for (const rg of r.props.textRanges) for (const k of Object.keys(rg.fields)) {
      if (schema.INTERNED_PROPS.indexOf(k) < 0 || typeof rg.fields[k] === "number") continue;
      if (k === "fontName") font(rg.fields[k]);
      rg.fields[k] = intern(rg.fields[k]);
    }
    return r;
  });
  const page = o.page === undefined ? { index: 0, guid: "0:1", name: "Page A", service: false, background: null } : clone(o.page);
  if (page && page.background !== null && typeof page.background !== "number") page.background = intern(page.background);
  const inTask = new Set(nodes.map((n) => n.i));
  const roots = o.roots || nodes.filter((n) => !inTask.has(n.parent)).map((n) => ({ i: n.i, attachTo: n.parent === -1 || (page && page.service) ? "page" : { i: n.parent, guid: "1:" + (G + n.parent) }, place: null }));
  const placeholders = nodes.filter((n) => n.type === "INSTANCE").length;
  const op = o.op || "build";
  return { format: "pix2fig.task", version: 1, op, runId: o.runId || RUN, taskNo: o.taskNo || 1, of: o.of || 9, snapshot: o.snapshot || SNAP, irVersion: 2,
    settings: Object.assign(SETTINGS(), o.settings || {}), page, roots, nodes, notes: o.notes || [], values, fonts: o.fonts || fonts,
    images: o.images || [], expect: op === "build" || op === "verify" ? { count: nodes.length, nonInstance: nodes.length - placeholders, placeholders } : null };
}
function valid(label, task) {
  const v = validateTask(task);
  if (!v.ok) fail("the test task is valid (" + label + ") — " + v.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join(" | "));
  return v.ok;
}

// A fresh double, host and bundled IR layer.
function env(o = {}) {
  const D = makeDouble(o.double || {});
  const host = defaultHost();
  host.phase = D.setPhase;
  if (o.images) host.images = () => o.images;
  if (o.imageErrors) host.imageErrors = () => o.imageErrors;
  if (o.measure) host.measure = o.measure;
  const figma = o.wrap ? o.wrap(D.figma) : D.figma;
  const bundle = loadPluginBundle({ figma, host, sources: o.irFiles ? { irFiles: o.irFiles } : undefined });
  return { D, host, IR: bundle.PXF_IR, context: bundle.context, figma };
}
async function build(E, task, jobId) {
  const ctx = E.IR.makeCtx(E.figma, task, { id: jobId || "t" + task.taskNo });
  const R = await E.IR.ops.build(ctx, task);
  return { R, ctx };
}
const nodeOf = (E, ctx, i) => E.D.node(ctx.S.nodes[String(i)]);
function findTree(t, id) { if (t.id === id) return t; for (const c of t.children || []) { const f = findTree(c, id); if (f) return f; } return null; }
function dfs(t, out = []) { out.push(t); for (const c of t.children || []) dfs(c, out); return out; }
const writesOf = (E, id) => E.D.writes.filter((w) => w.id === id);
const mul6 = (m, n) => [m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
  m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5]];
const flat = (m) => [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2]];
const sameM = (a, b) => a.every((x, j) => near(x, b[j], 1e-6));

// ============================================================================================
// 1. one build of every type: shape of the report, one node per record, DFS order, no layout read
// ============================================================================================
const H1 = sha1("pxf synthetic image one");
const mixedNodes = () => [
  frame(0, -1, [T6(10, 20), 400, 300], { fills: [SOLID(1, 1, 1)], strokes: [SOLID(0, 0, 0)], strokeWeight: 2, strokeWeights: [1, 0, 3, 0], cornerRadii: [4, 0, 4, 0] }),
  rect(1, 0, [T6(5, 5), 20, 10], { fills: [{ type: "IMAGE", scaleMode: "FILL", imageHash: H1, visible: true, opacity: 1 }] }),
  text(2, 0, [T6(40, 5), 60, 14], "Hello", { fills: [SOLID(0, 0, 0)] }),
  vector(3, 0, [T6(110, 5), 10, 10], { vectorNetwork: NET_SQUARE, fills: [SOLID(0, 0, 1)] }),
  vector(4, 0, [T6(130, 5), 10, 8], { fillGeometry: GEO_TRI, strokeGeometry: GEO_TRI, fills: [SOLID(0, 1, 0)] }),
  rec(5, 0, "ELLIPSE", [T6(150, 5), 12, 12], painted({ arcData: { startingAngle: 0, endingAngle: 3.14, innerRadius: 0.5 } })),
  rec(6, 0, "STAR", [T6(170, 5), 12, 12], painted({ pointCount: 5, innerRadius: 0.4 })),
  rec(7, 0, "POLYGON", [T6(190, 5), 12, 12], painted({ pointCount: 6 })),
  rec(8, 0, "LINE", [T6(210, 5), 30, 0], painted({ strokes: [SOLID(0, 0, 0)], strokeAlign: "CENTER" })),
  group(9, 0, [T6(5, 40), 50, 50], { opacity: 0.5 }),
  rect(10, 9, [T6(2, 2), 10, 10]),
  instance(11, 0, [T6(70, 40), 30, 30], { layoutPositioning: "AUTO", visible: false }),
  component(12, 0, [T6(110, 40), 40, 40]),
  rect(13, 12, [T6(1, 1), 5, 5]),
  boolean(14, 0, [T6(160, 40), 30, 20], "UNION", { fills: [SOLID(1, 0, 0)] }),
  rect(15, 14, [T6(0, 0), 20, 20]),
  rect(16, 14, [T6(10, 0), 20, 20]),
];
{
  const task = mkTask({ nodes: mixedNodes(), notes: [{ code: "VECTOR_FROM_GEOMETRY", i: 4, detail: null }],
    images: [{ hash: H1, source: "archive", format: "png", reason: null }] });
  valid("mixed", task);
  const E = env({ images: { [H1]: H1 } });
  const before = E.D.tree().children.length;
  const { R, ctx } = await build(E, task);
  // The report's shape (docs/M1.md §6 B).
  const KEYS = ["op", "taskNo", "runId", "ms", "codes", "coded", "failures", "plugin", "roots", "built", "placeholders", "msTotal", "storedNodes",
    "fontSubs", "textWidened", "textPinned", "counters", "settings", "detail"];
  check(same(Object.keys(R).sort(), KEYS.slice().sort()) && R.op === "build" && R.taskNo === 1 && R.runId === RUN,
    "the build report has docs/M1.md §6 B's keys (and detail)", Object.keys(R).join(","));
  check(same(Object.keys(R.ms), taskMod.BUILD_PHASES) && Object.values(R.ms).every((v) => typeof v === "number" && v >= 0) && typeof R.msTotal === "number",
    "ms has every build phase, in BUILD_PHASES order, and msTotal is a number", Object.keys(R.ms).join(","));
  check(same(Object.keys(R.counters).sort(), ["sizeRepaired", "sizeRejected", "layoutDroppedForSize", "rotPinned", "flowAligned", "flowAbsolute", "flowStillOff",
    "flowRejected", "flowReverted", "flowGroups", "textTrimmed", "textTrimReverted", "constraintsSet", "sideStrokes", "vectorsNetwork", "vectorsGeometry",
    "booleansNative", "imagesPlaced"].sort()) && Object.values(R.counters).every((v) => Number.isInteger(v)), "counters has exactly the listed keys, all integers");
  check(R.built === 16 && R.placeholders === 1 && R.storedNodes === 17 && same(R.roots, [{ i: 0, id: ctx.S.nodes["0"] }]) && same(R.settings, task.settings),
    "built counts the non-instance records, placeholders the INSTANCE ones, storedNodes all; roots and settings echoed", JSON.stringify([R.built, R.placeholders, R.storedNodes, R.roots]));
  check(R.failures.length === 0, "no failure entries on a sound task", JSON.stringify(R.failures));
  // One node per record, of its built type, in the order VERIFY walks (task.nodes[k] = built DFS[k]).
  const tr = E.D.tree();
  const page = tr.children.find((p) => (p.sharedPluginData.pix2fig || {}).pxPage === "0:1");
  const root = findTree(tr, ctx.S.nodes["0"]);
  const walk = dfs(root);
  check(tr.children.length === before + 1 && page && page.children.length === 1 && page.children[0].id === root.id,
    "the task's page is made and stamped pxPage, and holds the one root");
  check(walk.length === task.nodes.length && walk.every((n, k) => n.id === ctx.S.nodes[String(task.nodes[k].i)]),
    "one node per record, ctx.S.nodes maps every IR index, and the built DFS order is the task's order", walk.map((n) => n.name).join(","));
  check(walk.every((n, k) => n.type === taskMod.BUILT_TYPE[task.nodes[k].type]) && walk.every((n, k) => n.name === task.nodes[k].name),
    "every record is built as BUILT_TYPE says (GROUP and INSTANCE as FRAME, the boolean native), with its name", walk.map((n) => n.type).join(","));
  // Write-only phases read no layout.
  const wo = taskMod.WRITE_ONLY_PHASES.filter((p) => E.D.reads.byPhase[p]);
  check(wo.length === 0 && (E.D.reads.byPhase["(none)"] || 0) === 0, "no layout read in fonts, images, pages, create, vectors or booleans", JSON.stringify(E.D.reads.byPhase));
  check(E.D.reads.total > 0 && E.D.reads.byPhase.settle > 0, "the passes after creation do read layout (the counter works), settle included", JSON.stringify(E.D.reads.byPhase));
  // The placeholder (D6).
  const ph = findTree(tr, ctx.S.nodes["11"]);
  check(ph.type === "FRAME" && ph.children.length === 0 && same(ph.props.fills, []) && same(ph.props.strokes, []) && same(ph.props.effects, []) &&
    ph.props.clipsContent === false && ph.props.layoutMode === "NONE" && ph.props.visible === false && ph.width === 30 && ph.height === 30 &&
    same(ph.sharedPluginData, {}) && same(ph.pluginData, {}),
    "an INSTANCE is an unstamped placeholder frame: its box and visibility, nothing drawn, no flow, no child", JSON.stringify(ph.props).slice(0, 200));
  check(R.codes.INSTANCE_DEFERRED === 1 && R.coded.some((c) => c.code === "INSTANCE_DEFERRED" && c.i === 11), "the placeholder is counted INSTANCE_DEFERRED in the build report");
  // The group (D4) and side weights.
  const grp = findTree(tr, ctx.S.nodes["9"]);
  check(grp.type === "FRAME" && same(grp.props.fills, []) && same(grp.props.strokes, []) && grp.props.clipsContent === false && grp.props.opacity === 0.5,
    "a GROUP is a frame with fills [], no strokes, no clipping, and its own opacity");
  const r0 = findTree(tr, ctx.S.nodes["0"]), w0 = writesOf(E, r0.id).map((w) => w.prop);
  check(r0.props.strokeTopWeight === 1 && r0.props.strokeRightWeight === 0 && r0.props.strokeBottomWeight === 3 && r0.props.strokeLeftWeight === 0 &&
    w0.indexOf("strokeWeight") >= 0 && w0.indexOf("strokeWeight") < w0.indexOf("strokeTopWeight") && R.counters.sideStrokes === 1,
    "the side weights are written after strokeWeight and survive it", JSON.stringify([r0.props.strokeTopWeight, r0.props.strokeBottomWeight, w0.indexOf("strokeWeight"), w0.indexOf("strokeTopWeight")]));
  check(r0.props.topLeftRadius === 4 && r0.props.topRightRadius === 0 && r0.props.bottomRightRadius === 4 && w0.indexOf("cornerRadius") < 0,
    "cornerRadii become the four corners, and no cornerRadius is written beside them");
  // DEFAULTS and empty fills, explicitly.
  const r10 = writesOf(E, ctx.S.nodes["10"]);
  const wrote = (p, v) => r10.some((w) => w.prop === p && same(w.value, v));
  check(wrote("fills", []) && wrote("strokes", []) && wrote("opacity", 1) && wrote("effects", []) && wrote("cornerRadius", 0) && wrote("strokeJoin", "MITER") &&
    wrote("dashPattern", []) && wrote("visible", true) && wrote("isMask", false) && wrote("exportSettings", []) && wrote("cornerSmoothing", 0),
    "DEFAULTS are written explicitly where the record leaves them out, and an empty fills list is written (Figma's rectangle is grey)",
    r10.map((w) => w.prop).join(","));
  check(findTree(tr, ctx.S.nodes["10"]).props.fills.length === 0, "the rectangle with fills [] is built with no fill");
  // Types.
  const el = findTree(tr, ctx.S.nodes["5"]), sr = findTree(tr, ctx.S.nodes["6"]), pg = findTree(tr, ctx.S.nodes["7"]), ln = findTree(tr, ctx.S.nodes["8"]);
  check(near(el.props.arcData.endingAngle, 3.14) && sr.props.pointCount === 5 && near(sr.props.innerRadius, 0.4) && pg.props.pointCount === 6 && ln.width === 30 && ln.height === 0,
    "an ellipse takes its arcData, a star and a polygon their points, a line its length with height 0");
  {
    // Review figma F1: a full sweep (the IR default, or a donut stored at 6.283185) is written as
    // exactly 2π past its start, never one 32-bit step short of Figma's 2π (an arc with a seam).
    const E2 = env();
    const { ctx: c2 } = await build(E2, mkTask({ nodes: [frame(0, -1, [T6(0, 0), 100, 100]), rec(1, 0, "ELLIPSE", [T6(0, 0), 20, 20], painted()),
      rec(2, 0, "ELLIPSE", [T6(30, 0), 20, 20], painted({ arcData: { startingAngle: 0, endingAngle: 6.283185, innerRadius: 0.5 } }))] }));
    const full = E2.D.node(c2.S.nodes["1"]), donut = E2.D.node(c2.S.nodes["2"]);
    const raw = E2.D.figma.createEllipse(); raw.resize(20, 20); raw.arcData = { startingAngle: 0, endingAngle: 6.283185, innerRadius: 0 };
    check(full.arcData.endingAngle === 2 * Math.PI && donut.arcData.endingAngle === 2 * Math.PI && donut.arcData.innerRadius === 0.5 &&
      !/^M 10 10 L/.test(full.fillGeometry[0].data) && /^M 10 10 L/.test(raw.fillGeometry[0].data),
      "a full sweep is written as exactly 2π, so the ellipse stays closed (6.283185 written as is draws a pie in the double, as it would in Figma)",
      JSON.stringify([full.arcData, donut.arcData]));
  }
  const cmp = findTree(tr, ctx.S.nodes["12"]);
  check(cmp.type === "COMPONENT" && (cmp.sharedPluginData.pix2fig || {}).pxDef === "1:112", "a COMPONENT record is a component stamped pxDef (its guid)");
  const rs = r0.sharedPluginData.pix2fig || {};
  check(rs.pxSrc === "1:100" && rs.pxIdx === "0" && rs.pxRun === RUN && rs.pxSnap === SNAP && rs.pxIr === "2" && rs.pxState === "built",
    "the root carries pxSrc, pxIdx, pxRun, pxSnap, pxIr 2 and pxState built", JSON.stringify(rs));
  const states = E.D.writes.filter((w) => w.id === r0.id && w.prop === "setSharedPluginData()" && w.value[1] === "pxState").map((w) => w.phase + ":" + w.value[2]);
  check(same(states, ["create:partial", "stamp:built"]), "a root is stamped partial as soon as it is made, and built in the stamp phase", states.join(","));
  const stamped = walk.filter((n) => n.sharedPluginData.pix2fig && Object.keys(n.sharedPluginData.pix2fig).length).map((n) => n.id);
  check(same(stamped.sort(), [r0.id, cmp.id].sort()), "nothing but the root (and the component's pxDef) is stamped");
  const v3 = E.D.node(ctx.S.nodes["3"]), v4 = E.D.node(ctx.S.nodes["4"]);
  check(same(v3.vectorNetwork.vertices, NET_SQUARE.vertices) && v3.fillGeometry.length === 1 && R.counters.vectorsNetwork === 1,
    "a network record is built through setVectorNetworkAsync (vectorsNetwork)");
  check(same(v4.vectorPaths, GEO_TRI) && R.counters.vectorsGeometry === 1 && writesOf(E, v4.id).every((w) => w.prop !== "resize()"),
    "a geometry record is built from its fillGeometry as vectorPaths (vectorsGeometry), and a vector is never resized");
  // Determinism: the same task on a fresh double writes the same things in the same order.
  const E2 = env({ images: { [H1]: H1 } });
  await build(E2, mkTask({ nodes: mixedNodes(), notes: [{ code: "VECTOR_FROM_GEOMETRY", i: 4, detail: null }], images: [{ hash: H1, source: "archive", format: "png", reason: null }] }));
  const sig = (D) => D.writes.map((w) => w.phase + " " + w.type + " " + w.prop + " " + (w.prop.endsWith("()") ? "" : JSON.stringify(w.value))).join("\n");
  check(sig(E.D) === sig(E2.D), "two builds of the same task write the same props in the same order");
}

// ============================================================================================
// 2. every Figma prop KNOWN_PROPS lists is written somewhere (or deliberately not, with a reason)
// ============================================================================================
{
  const E = env();
  const W = E.IR.B.WRITES, T = E.IR.textWrites;
  const handled = new Set([].concat(W.box, W.paints, W.plain, W.sides, W.corners, W.autoLayout, W.childSize, W.childFlow, W.geometry, W.boolean, W.notWritten, T.props));
  const missing = [];
  for (const type of Object.keys(taskMod.BUILT_TYPE)) for (const p of Object.keys(props.KNOWN_PROPS[type])) if (!handled.has(p)) missing.push(type + "." + p);
  check(!missing.length, "every prop KNOWN_PROPS gives a built type has a writer in the builder or a stated reason not to be written", missing.join(", "));
  const rmissing = Object.keys(props.RANGE_FIELDS).filter((f) => T.rangeFields.indexOf(f) < 0 && T.rangeNotWritten.indexOf(f) < 0);
  check(!rmissing.length, "every RANGE_FIELDS field has a setRange* call in IR.writeTextProps or a stated reason (styles: M2b)", rmissing.join(", "));
}

// ============================================================================================
// 3. images: archive, unknown, refused, none, mismatching archive and MCP, render remap
// ============================================================================================
{
  const h = (s) => sha1("pxf synthetic image " + s);
  const [OK, UNK, BAD, NONE, MISA, MISM, REND, OTHER] = ["ok", "unknown", "refused", "none", "mis-archive", "mis-mcp", "render", "other"].map(h);
  const img = (hash, extra) => [Object.assign({ type: "IMAGE", scaleMode: "FILL", imageHash: hash, visible: true, opacity: 0.7 }, extra || {})];
  const nodes = [frame(0, -1, [T6(0, 0), 300, 50])].concat([OK, UNK, BAD, NONE, MISA, MISM, REND].map((hh, j) => rect(j + 1, 0, [T6(j * 30, 0), 20, 20], { fills: img(hh) })));
  nodes.push(text(8, 0, [T6(0, 30), 60, 14], "Hi there", { textRanges: [{ start: 0, end: 2, fields: { fills: img(UNK) } }] }));
  const images = [[OK, "archive"], [UNK, "archive"], [BAD, "archive"], [NONE, "none"], [MISA, "archive"], [MISM, "mcp"], [REND, "render"]]
    .map(([hash, source]) => ({ hash, source, format: "png", reason: source === "none" ? "no bytes anywhere" : null }));
  const task = mkTask({ nodes, images });
  valid("images", task);
  const E = env({ images: { [OK]: OK, [MISA]: OTHER, [MISM]: OTHER, [REND]: OTHER }, imageErrors: { [BAD]: "Image is too large" } });
  const { R, ctx } = await build(E, task);
  const fillOf = (i) => E.D.node(ctx.S.nodes[String(i)]).fills[0];
  const grey = (p) => p.type === "SOLID" && same(p.color, { r: 0.8, g: 0.8, b: 0.8 }) && near(p.opacity, 0.7);
  check(fillOf(1).type === "IMAGE" && fillOf(1).imageHash === OK, "an archive image Figma holds under the same hash is written as an IMAGE paint");
  check([2, 3, 4, 5, 6].every((i) => grey(fillOf(i))), "unknown, refused, none and mismatching archive and MCP images are a fixed grey SOLID placeholder, never an unknown hash",
    JSON.stringify([2, 3, 4, 5, 6].map((i) => fillOf(i).type)));
  check(fillOf(7).type === "IMAGE" && fillOf(7).imageHash === OTHER && R.detail.imagesRemapped === 1, "a render image takes Figma's hash, and the remap is counted");
  check(R.codes.IMAGE_PLACEHOLDER === 6 && R.coded.filter((c) => c.code === "IMAGE_PLACEHOLDER").map((c) => c.i).sort().join() === "2,3,4,5,6,8",
    "IMAGE_PLACEHOLDER once per node and hash, a range fill's included", JSON.stringify(R.coded.filter((c) => c.code === "IMAGE_PLACEHOLDER")));
  check(/none: no bytes anywhere/.test(R.coded.find((c) => c.code === "IMAGE_PLACEHOLDER" && c.i === 4).detail) &&
    /refused: Image is too large/.test(R.coded.find((c) => c.code === "IMAGE_PLACEHOLDER" && c.i === 3).detail), "each placeholder says why");
  const imgFail = R.failures.filter((f) => f.prop === "images");
  check(imgFail.length === 2 && imgFail.some((f) => /\(archive\)/.test(f.msg)) && imgFail.some((f) => /\(mcp\)/.test(f.msg)),
    "a mismatching archive or MCP hash is an error (a failure entry), never a silent remap", JSON.stringify(R.failures));
  check(R.counters.imagesPlaced === 2, "imagesPlaced counts the IMAGE paints written", R.counters.imagesPlaced);
  const rng = E.D.writes.find((w) => w.id === ctx.S.nodes["8"] && w.prop === "setRangeFills()");
  check(rng && grey(rng.value[2][0]), "an image in a range fill is mapped the same way");
}

// ============================================================================================
// 4. vectors: RIGHT_ANGLE refused, geometry without its note refused, a moved origin kept in place
// ============================================================================================
{
  const net = clone(NET_SQUARE); net.vertices[1].handleMirroring = "RIGHT_ANGLE";
  const task = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 50, 50]), vector(1, 0, [T6(5, 5), 10, 10], { vectorNetwork: net })] });
  const E = env();
  const { R, ctx } = await build(E, task);
  const v = E.D.node(ctx.S.nodes["1"]);
  check(R.codes.VECTOR_NETWORK_REFUSED === 1 && R.coded[R.coded.length - 1].i === 1 && v.fillGeometry.length === 0 && R.counters.vectorsNetwork === 0,
    "setVectorNetworkAsync refusing RIGHT_ANGLE gives VECTOR_NETWORK_REFUSED, and the vector keeps no paths", JSON.stringify(R.codes));
  check(R.failures.length === 0, "a refused network is a counted fallback, not a failure entry");

  const t2 = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 50, 50]), vector(1, 0, [T6(5, 5), 10, 8], { fillGeometry: GEO_TRI })] });
  check(!validateTask(t2).ok, "validateTask refuses a geometry vector without its note");
  const E2 = env();
  const nBefore = E2.D.tree().children.length;
  const e = await rejects(build(E2, t2));
  check(e && e.refused === true && /fillGeometry without a note/.test(e.message) && E2.D.writes.length === 0 && E2.D.tree().children.length === nBefore,
    "the builder refuses a geometry record without its note itself, before creating anything", e && e.message);
  const t3 = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 50, 50]), vector(1, 0, [T6(5, 5), 10, 8], { fillGeometry: GEO_TRI, vectorNetwork: NET_SQUARE })] });
  const e3 = await rejects(build(env(), t3));
  check(e3 && e3.refused && /2 build sources/.test(e3.message), "a VECTOR with two build sources is refused", e3 && e3.message);

  // Figma may move a vector's origin to its paths' bounds (§11). A stand-in that does so: the
  // drawing must stay where the IR puts it.
  const shifting = (figma) => new Proxy(figma, { get(t, p) {
    const v = t[p];
    if (p !== "createVector") return v;
    return () => {
      const n = v();
      return new Proxy(n, { get(nt, q) {
        if (q !== "setVectorNetworkAsync") return nt[q];
        return (net0) => {
          const mx = Math.min(...net0.vertices.map((x) => x.x)), my = Math.min(...net0.vertices.map((x) => x.y));
          return nt.setVectorNetworkAsync(Object.assign({}, net0, { vertices: net0.vertices.map((x) => Object.assign({}, x, { x: x.x - mx, y: x.y - my })) }));
        };
      }, set(nt, q, val) { nt[q] = val; return true; } });
    };
  } });
  const off = clone(NET_SQUARE); off.vertices.forEach((x) => { x.x += 3; x.y += 2; });
  const t4 = mkTask({ nodes: [frame(0, -1, [T6(100, 100), 50, 50]), vector(1, 0, [ROT90(30, 5), 13, 12], { vectorNetwork: off })] });
  valid("offset network", t4);
  const E4 = env({ wrap: shifting });
  const { R: R4, ctx: c4 } = await build(E4, t4);
  const vn = E4.D.node(c4.S.nodes["1"]);
  const abs = flat(vn.absoluteTransform), stored = vn.vectorNetwork.vertices[0];
  const want = mul6(mul6(T6(100, 100), ROT90(30, 5)), [1, 0, off.vertices[0].x, 0, 1, off.vertices[0].y]);
  const got = mul6(abs, [1, 0, stored.x, 0, 1, stored.y]);
  check(stored.x === 0 && R4.detail.vectorOriginShifted === 1 && near(got[2], want[2], 1e-9) && near(got[5], want[5], 1e-9),
    "a vector whose origin Figma moves keeps its drawing in place (the wanted transform takes the shift, on a rotated vector too)", JSON.stringify([got[2], got[5], want[2], want[5]]));
}

// ============================================================================================
// 5. text: one writer, its order, fonts substituted, decision 9
// ============================================================================================
{
  const MISSING = { family: "Synthetic Sans", style: "Regular" };
  const nodes = [frame(0, -1, [T6(0, 0), 300, 100]),
    text(1, 0, [T6(10, 10), 100, 14], "Hello world", { fills: [SOLID(0, 0, 0)], fontSize: 14, textTruncation: "DISABLED", maxLines: 2, textCase: "UPPER",
      textRanges: [{ start: 0, end: 5, fields: { fontName: MISSING, fontSize: 18, fills: [SOLID(1, 0, 0)], textStyle: 0 } }, { start: 6, end: 11, fields: { textDecoration: "UNDERLINE", hyperlink: { type: "URL", value: "https://example.com" } } }] }),
    text(2, 0, [T6(10, 40), 100, 14], "Truncated", { fontName: MISSING, textTruncation: "ENDING", maxLines: 1, textAutoResize: "HEIGHT" })];
  const task = mkTask({ nodes });
  // textStyle is a style reference: no style table travels in M1, so the task cannot carry one. It is
  // dropped from the task (the builder ignores it anyway; the coverage check above names it).
  delete task.nodes[1].props.textRanges[0].fields.textStyle;
  valid("text", task);
  const E = env();
  const { R, ctx } = await build(E, task);
  const id1 = ctx.S.nodes["1"], id2 = ctx.S.nodes["2"];
  const w1 = writesOf(E, id1).filter((w) => w.phase === "create").map((w) => w.prop);
  const at = (p) => w1.indexOf(p);
  check(at("fills") >= 0 && at("fills") < at("fontName") && at("fontName") < at("characters") && at("characters") < at("fontSize") &&
    at("fontSize") < at("setRangeFontName()") && at("setRangeFontName()") < at("setRangeFontSize()") && w1.lastIndexOf("textAutoResize") === w1.length - 1,
    "IR.writeTextProps writes fontName, characters, the text props, the ranges (a range font first), and textAutoResize last, after the node's fills", w1.join(","));
  check(at("maxLines") < 0 && writesOf(E, id2).some((w) => w.prop === "maxLines" && w.value === 1), "maxLines is written only under textTruncation ENDING");
  check(writesOf(E, id1).some((w) => w.prop === "setRangeHyperlink()" && w.value[2].value === "https://example.com") &&
    writesOf(E, id1).some((w) => w.prop === "setRangeTextDecoration()" && same(w.value, [6, 11, "UNDERLINE"])) &&
    writesOf(E, id1).some((w) => w.prop === "setRangeFills()" && same(w.value, [0, 5, [SOLID(1, 0, 0)]])) &&
    writesOf(E, id1).some((w) => w.prop === "letterSpacing" && same(w.value, props.DEFAULTS.letterSpacing)),
    "range fields go through their setRange* calls, interned ones resolved, and text DEFAULTS are written");
  const rf = writesOf(E, id1).find((w) => w.prop === "setRangeFontName()");
  check(same(rf.value, [0, 5, INTER]) && E.D.node(id2).fontName.family === "Inter", "a missing font is written as the fallback, in a range and on a node");
  check(R.codes.FONT_SUBSTITUTED === 2 && R.coded.filter((c) => c.code === "FONT_SUBSTITUTED").every((c) => /Synthetic Sans Regular -> Inter Regular/.test(c.detail)) &&
    same(R.fontSubs, [{ family: "Synthetic Sans", style: "Regular", nodes: 2 }]) && ctx.S.fonts["Synthetic Sans|Regular"] === "sub" && ctx.S.fonts["Inter|Regular"] === "ok",
    "FONT_SUBSTITUTED once per node, fontSubs per font with its node count, the session remembers the substitution", JSON.stringify([R.codes, R.fontSubs]));
  const bad = mkTask({ nodes, settings: { fallbackFont: { family: "Nowhere", style: "Regular" } } });
  delete bad.nodes[1].props.textRanges[0].fields.textStyle;
  const eb = await rejects(build(env(), bad));
  check(eb && eb.refused && /fallback font Nowhere Regular does not load/.test(eb.message), "a fallback font that does not load refuses the task", eb && eb.message);
  // A font not loaded when the writer runs: it throws (fontName), as the contract says.
  const E3 = env();
  const c3 = E3.IR.makeCtx(E3.D.figma, task, { id: "w" });
  const tn = E3.D.figma.createText();
  let threw = "";
  try { E3.IR.writeTextProps(c3, tn, task.nodes[2]); } catch (e) { threw = e.message; }
  check(/unloaded font/.test(threw), "IR.writeTextProps throws when the font is not loaded", threw);
}
{
  // Decision 9 (docs/M1.md §6 B step 9). The host's measure is the text model here: a line breaks
  // below a natural width 1.5 px over the source box.
  const W0 = 80, NAT = W0 + 1.5;
  const measure = (c, node) => ({ lines: node.width + 1e-9 >= NAT ? 1 : 2, approx: false });
  const mk = (align, extra) => mkTask({ nodes: [frame(0, -1, [T6(0, 0), 300, 200]),
    text(1, 0, [T6(50, 20), W0, 14], "One line heading", Object.assign({ textAlignHorizontal: align, lines: 1 }, extra || {})),
    text(2, 0, [T6(50, 60), W0, 28], "Two line body", { textAlignHorizontal: align, lines: 2 })] });
  for (const [align, shift] of [["CENTER", 0.5], ["RIGHT", 1], ["LEFT", 0]]) {
    const task = mk(align);
    valid("decision 9 " + align, task);
    const E = env({ measure });
    const { R, ctx } = await build(E, task);
    const n1 = E.D.node(ctx.S.nodes["1"]), n2 = E.D.node(ctx.S.nodes["2"]);
    const dw = n1.width - W0;
    check(n1.width >= NAT && near(n1.relativeTransform[0][2], 50 - shift * dw, 1e-9) && n1.relativeTransform[1][2] === 20 && n2.width === W0 &&
      same(R.textWidened, [1]) && R.codes.TEXT_WIDENED_TO_SOURCE_LINES === 1 && /2 -> 1 lines/.test(R.coded.find((c) => c.code === "TEXT_WIDENED_TO_SOURCE_LINES").detail),
      "decision 9, " + align + ": a one-line text that wraps is widened until it does not, moved left by " + (shift ? shift + " of " : "none of ") + "the widening, counted and recounted; a two-line text is left alone",
      JSON.stringify([n1.width, n1.relativeTransform[0][2], R.textWidened]));
  }
  const E = env({ measure });
  const sourceBox = mk("CENTER");
  sourceBox.settings.textFit = "source-box";
  const { R } = await build(E, sourceBox);
  check(R.textWidened.length === 0 && !R.codes.TEXT_WIDENED_TO_SOURCE_LINES, "textFit source-box keeps the source box: nothing is widened");
  // Turned 90°: the shift follows the text's own x axis.
  const tr = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 300, 200]), text(1, 0, [ROT90(100, 20), W0, 14], "One line", { textAlignHorizontal: "RIGHT", lines: 1 })] });
  const Er = env({ measure });
  const { ctx: cr } = await build(Er, tr);
  const nr = Er.D.node(cr.S.nodes["1"]), dwr = nr.width - W0;
  check(near(nr.relativeTransform[0][2], 100, 1e-9) && near(nr.relativeTransform[1][2], 20 - dwr, 1e-9), "decision 9 on a turned text moves it along its own x axis", JSON.stringify(nr.relativeTransform));
  // countLines missing from the build (a bundle without part C's measure.js) is a failure entry, not a crash.
  const files = Object.fromEntries(readdirSync(IR_SRC_DIR).filter((f) => f.endsWith(".js") && !/^measure/.test(f)).map((f) => [f, readFileSync(join(IR_SRC_DIR, f), "utf8")]));
  const Ec = env({ irFiles: files });
  const { R: Rc } = await build(Ec, mk("LEFT"));
  check(typeof Ec.IR.countLines !== "function" && Rc.failures.some((f) => f.prop === "lines" && /countLines/.test(f.msg)),
    "a text that cannot be measured is a failure entry (lines), and the build goes on");
}
{
  // Part F: the build measures through part C's countLines on part E's text model (no host.measure),
  // and leaves no scratch node and no service page of its own behind (IR.prepareMeasure, IR.dropScratch).
  const nodes = [frame(0, -1, [T6(0, 0), 300, 100]), text(1, 0, [T6(10, 10), 30, 14], "One line that Figma wraps", { lines: 1 })];
  const E = env();
  const pagesBefore = E.D.tree().children.length;
  const { R, ctx } = await build(E, mkTask({ nodes }));
  const made = E.D.writes.filter((w) => w.prop === "setSharedPluginData()" && w.value[1] === "pxScratch");
  const tree = JSON.stringify(E.D.tree());
  check(made.length === 1 && E.D.node(made[0].id) === null && tree.indexOf("pxScratch") < 0 && E.D.tree().children.length === pagesBefore + 1 &&
    ctx.S.scratchTextId === null && same(R.textWidened, [1]) && R.failures.length === 0,
    "a build that measures (decision 9 through countLines) removes its scratch node and the service page it made", JSON.stringify([made.length, R.textWidened, R.failures, E.D.tree().children.length - pagesBefore]));
}
{
  // Review figma F2: a label truncated with an ellipsis in a fixed box (ENDING, no maxLines) that
  // Pixso stores as one line is drawn cut, not widened to its full one-line width.
  const nodes = [frame(0, -1, [T6(0, 0), 100, 20]), text(1, 0, [T6(0, 0), 80, 15], "Very long product name that does not fit", { textTruncation: "ENDING", lines: 1 })];
  const E = env();
  const task = mkTask({ nodes, settings: { textFit: "widen" } });
  const { R, ctx } = await build(E, task);
  const n = E.D.node(ctx.S.nodes["1"]);
  const m = E.IR.countLines(ctx, n, task.nodes[1]);
  E.IR.dropScratch(ctx);
  check(R.textWidened.length === 0 && !R.codes.TEXT_WIDENED_TO_SOURCE_LINES && near(n.width, 80, 0.5) && m.lines === 1,
    "a truncated one-line label in a fixed box is not widened, and countLines counts the one line it draws", JSON.stringify([n.width, R.textWidened, m]));
}
{
  // Review figma F3: a 24 x 1 divider turned a quarter in a row stays in the flow, built 1 x 24
  // unturned (pack4's leaf bake), so its siblings keep their places; the judge holds it to the swap.
  const nodes = [frame(0, -1, [T6(0, 0), 200, 24], { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", itemSpacing: 8 }),
    rect(1, 0, [T6(0, 0), 40, 24]), rect(2, 0, [ROT90(49, 0), 24, 1]), rect(3, 0, [T6(57, 0), 40, 24]), rect(4, 0, [T6(105, 0), 40, 24]),
    rect(5, 0, [ROT90(170, 0), 24, 1], { effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 2, spread: 0, visible: true, blendMode: "NORMAL" }] })];
  const task = mkTask({ nodes });
  const E = env();
  const { R, ctx } = await build(E, task);
  const n2 = nodeOf(E, ctx, 2), n5 = nodeOf(E, ctx, 5);
  const flows = [1, 2, 3, 4].every((i) => nodeOf(E, ctx, i).layoutPositioning !== "ABSOLUTE");
  check(flows && R.detail.quarterTurnsBaked === 1 && R.counters.rotPinned === 1 && R.counters.flowGroups === 0 && same(n2.relativeTransform, [[1, 0, 48], [0, 1, 0]]) &&
    n2.width === 1 && n2.height === 24 && near(nodeOf(E, ctx, 3).relativeTransform[0][2], 57, 1e-9) && n5.layoutPositioning === "ABSOLUTE",
    "a turned flow leaf is built unturned with its size swapped and stays in the flow; one with a shadow keeps its turn and leaves the flow alone",
    JSON.stringify([n2.relativeTransform, n2.width, n2.height, R.counters.rotPinned, R.counters.flowGroups, R.detail.quarterTurnsBaked]));
  const vt = Object.assign({}, task, { op: "verify" });
  const V = await E.IR.ops.verify(E.IR.makeCtx(E.figma, vt, { id: "v" }), vt);
  const values = []; for (const k of Object.keys(task.values)) values[Number(k)] = task.values[k];
  const ir = { nodes: task.nodes.map((t) => ({ parent: t.parent, guid: t.guid, type: t.type, name: t.name, props: t.props })), values, notes: [] };
  const J = judgeTask({ ir, task, build: R, verify: JSON.parse(JSON.stringify(V)) });
  check(J.geometry.visibleOver05 === 0 && J.geometry.sizeVisibleOver05 === 0 && J.geometry.classified.quarterTurnBaked === 1 && J.count.ok,
    "the judge holds the baked leaf to its swapped size in the same box: no finding", JSON.stringify([J.geometry, J.count]));
}
{
  // Review figma F4: a 32 px child saying STRETCH in a 36 px row hugging its counter axis, which
  // Pixso centres (y = 2). Figma ignores a child's MIN / CENTER / MAX (docs/FINDINGS.md: 0 aligned),
  // so the flow pass takes it out of the flow onto its place, and it stays there.
  const nodes = [frame(0, -1, [T6(0, 0), 200, 36], { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO", itemSpacing: 8 }),
    rect(1, 0, [T6(0, 0), 40, 36]), rect(2, 0, [T6(48, 2), 32, 32], { layoutAlign: "STRETCH" })];
  const E = env();
  const { R, ctx } = await build(E, mkTask({ nodes }));
  const n = nodeOf(E, ctx, 2);
  check(near(n.relativeTransform[1][2], 2, 0.5) && near(n.relativeTransform[0][2], 48, 0.5) && R.counters.flowAligned === 0 && R.counters.flowAbsolute === 1,
    "a child Pixso centres in a hugging row ends at its place out of the flow; no per-child alignment is counted as done", JSON.stringify([n.relativeTransform, R.counters.flowAligned, R.counters.flowAbsolute]));
}
{
  // Review figma F7 and F9: native booleans in an auto-layout flow. One ABSOLUTE at (250, 40), one
  // turned 90° (pinned out of the flow): each ends on its wanted matrix, and making them reads no
  // layout in the write-only booleans phase (the holder's matrix in a flow is a layout read).
  const nodes = [
    frame(0, -1, [T6(0, 0), 400, 100], { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", itemSpacing: 10 }),
    rect(1, 0, [T6(0, 0), 50, 50]),
    boolean(2, 0, [T6(250, 40), 30, 20], "UNION", { fills: [SOLID(1, 0, 0)], layoutPositioning: "ABSOLUTE" }),
    rect(3, 2, [T6(0, 0), 20, 20]), rect(4, 2, [T6(10, 0), 20, 20]),
    boolean(5, 0, [ROT90(120, 0), 30, 20], "UNION", { fills: [SOLID(0, 1, 0)] }),
    rect(6, 5, [T6(0, 0), 20, 20]), rect(7, 5, [T6(10, 0), 20, 20]),
  ];
  const task = mkTask({ nodes });
  valid("booleans in a flow", task);
  const E = env();
  const { R, ctx } = await build(E, task);
  const a = flat(nodeOf(E, ctx, 2).relativeTransform), b = flat(nodeOf(E, ctx, 5).relativeTransform);
  check(R.counters.booleansNative === 2 && sameM(a, [1, 0, 250, 0, 1, 40]) && sameM(b, [0, -1, 120, 1, 0, 0]) && nodeOf(E, ctx, 2).layoutPositioning === "ABSOLUTE" &&
    !E.D.reads.byPhase.booleans,
    "an ABSOLUTE and a turned native boolean in a flow end on their wanted matrices, and the booleans phase reads no layout", JSON.stringify([a, b, E.D.reads.byPhase]));
}
{
  // Review figma F6: the pin reads every text and then writes, so MEASURE costs a fixed number of
  // layout passes, not one per text (a read after the previous text's write lays the tree out again).
  const passesIn = async (N, textRead) => {
    const nodes = [frame(0, -1, [T6(0, 0), 300, 20 * N], { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" })];
    for (let i = 1; i <= N; i++) nodes.push(text(i, 0, [T6(0, 20 * (i - 1)), 37, 20], "Label " + i, { textAutoResize: "WIDTH_AND_HEIGHT" }));
    const E = env();
    const by = {}; let cur = null, last = 0;
    const set = E.host.phase;
    E.host.phase = (p) => { by[cur] = (by[cur] || 0) + E.D.layoutPasses - last; last = E.D.layoutPasses; cur = p; set(p); };
    const { R } = await build(E, mkTask({ nodes, settings: { textRead, textFit: "source-box" } }));
    return { measure: by.measure || 0, pinned: R.textPinned.length };
  };
  const a = await passesIn(20, "measure"), b = await passesIn(80, "measure");
  check(a.pinned === 20 && b.pinned === 80 && a.measure === b.measure && b.measure <= 3,
    "MEASURE pins 20 or 80 texts in the same few layout passes (" + b.measure + "), not one per text", JSON.stringify([a, b]));
}
{
  // Review figma F5: the measuring scratch is reused; a bulleted, indented text measured first must
  // not leave its list style on the next text (new characters take the first character's style).
  const list = text(1, 0, [T6(0, 0), 200, 14], "Item", { lines: 1, textRanges: [{ start: 0, end: 4, fields: { listOptions: { type: "UNORDERED" }, indentation: 1 } }] });
  const plain = text(2, 0, [T6(0, 20), 200, 14], "Plain paragraph", { lines: 1 });
  const task = mkTask({ op: "verify", nodes: [frame(0, -1, [T6(0, 0), 300, 100]), list, plain] });
  const E = env();
  await E.D.figma.loadFontAsync(INTER);
  const ctx = E.IR.makeCtx(E.D.figma, task, { id: "m" });
  await E.IR.prepareMeasure(ctx);
  const host = E.D.figma.createText(); host.resize(200, 14);
  E.IR.countLines(ctx, host, task.nodes[1]);
  E.IR.countLines(ctx, host, task.nodes[2]);
  // The value in effect at the first character: the last range of each field covering it.
  const eff = {};
  for (const r of E.D.rangesOf(ctx.S.scratchTextId)) if (r.start === 0) eff[r.name] = r.value;
  const left = [["setRangeListOptions", eff.setRangeListOptions], ["setRangeIndentation", eff.setRangeIndentation]]
    .filter(([k, v]) => v !== undefined && (k === "setRangeListOptions" ? v.type !== "NONE" : v !== 0));
  E.IR.dropScratch(ctx);
  check(!left.length, "countLines clears the scratch's list and indentation before writing the next text", JSON.stringify(left));
}
{
  // The text box pin and P6's in-loop read: measure pins after the settle, inLoop during creation.
  // The P0 double keeps a text at the size it is given, so a stand-in sizes an auto-sized text to
  // 6 px per character (part E's text model replaces it).
  const autoSizing = (figma) => new Proxy(figma, { get(t, p) {
    const v = t[p];
    if (p !== "createText") return v;
    return () => {
      const n = v();
      return new Proxy(n, { get: (nt, q) => nt[q], set(nt, q, val) {
        nt[q] = val;
        if (q === "textAutoResize" && val === "WIDTH_AND_HEIGHT") nt.resize(Math.max(1, String(nt.characters).length * 6), 14);
        return true;
      } });
    };
  } });
  const nodes = [frame(0, -1, [T6(0, 0), 300, 100]), text(1, 0, [T6(10, 10), 100, 20], "Auto sized", { textAutoResize: "WIDTH_AND_HEIGHT" })];
  for (const mode of ["measure", "inLoop"]) {
    const E = env({ wrap: autoSizing });
    const { R, ctx } = await build(E, mkTask({ nodes, settings: { textRead: mode } }));
    const n = E.D.node(ctx.S.nodes["1"]);
    // Part E's double also logs the NONE a resize in creation sets on a new (auto-width) text, as
    // Figma does; the pin is the last NONE written (merge of part E).
    const pinIn = E.D.writes.filter((w) => w.id === n.id && w.prop === "textAutoResize" && w.value === "NONE").pop();
    check(same(R.textPinned, [1]) && n.width === 100 && n.height === 20 && n.textAutoResize === "NONE" && pinIn && pinIn.phase === (mode === "measure" ? "measure" : "create") &&
      (mode === "measure" ? !E.D.reads.byPhase.create : E.D.reads.byPhase.create > 0),
      "textRead " + mode + ": a text whose built box differs from the source is pinned to it, " + (mode === "measure" ? "after the settle, with no read in creation" : "inside the creation loop (P6)"),
      JSON.stringify([R.textPinned, pinIn && pinIn.phase, E.D.reads.byPhase]));
  }
}
{
  // textLine: a line height off the font's natural one is trimmed (leadingTrim CAP_HEIGHT), the
  // scratch node is stamped pxScratch and removed.
  const task = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 300, 100]), text(1, 0, [T6(10, 10), 100, 40], "Tall", { lineHeight: { unit: "PIXELS", value: 40 } }),
    text(2, 0, [T6(10, 60), 100, 14], "Natural", { lineHeight: { unit: "PIXELS", value: 14 } })] });
  const E = env();
  const { R, ctx } = await build(E, task);
  const scratch = E.D.writes.find((w) => w.prop === "setSharedPluginData()" && w.value[1] === "pxScratch");
  check(E.D.node(ctx.S.nodes["1"]).leadingTrim === "CAP_HEIGHT" && E.D.node(ctx.S.nodes["2"]).leadingTrim === "NONE" && R.counters.textTrimmed === 1 &&
    scratch && E.D.node(scratch.id) === null, "textLine trims a line height off the natural one, leaves a natural one, and removes its stamped scratch node", JSON.stringify(R.counters));
}

// ============================================================================================
// 6. booleans: native with composed matrices, nested, fallback
// ============================================================================================
{
  const nodes = [frame(0, -1, [T6(100, 50), 300, 300]),
    boolean(1, 0, [ROT90(80, 10), 40, 30], "SUBTRACT", { fills: [SOLID(1, 0, 0)], opacity: 0.8 }),
    rect(2, 1, [T6(0, 0), 40, 30], { fills: [SOLID(0, 0, 1)] }),
    rect(3, 1, [T6(5, 5), 10, 10], { fills: [SOLID(0, 1, 0)] }),
    boolean(4, 0, [T6(150, 150), 50, 40], "UNION", { fills: [SOLID(0, 0, 0)] }),
    boolean(5, 4, [T6(0, 0), 30, 30], "INTERSECT", { fills: [SOLID(1, 1, 0)] }),
    rect(6, 5, [T6(0, 0), 30, 30]),
    rec(7, 5, "ELLIPSE", [T6(10, 10), 20, 20], painted()),
    rect(8, 4, [T6(20, 10), 30, 30])];
  const task = mkTask({ nodes });
  valid("booleans", task);
  const E = env();
  const { R, ctx } = await build(E, task);
  const nb = E.D.node(ctx.S.nodes["1"]);
  const absOf = (i) => flat(E.D.node(ctx.S.nodes[String(i)]).absoluteTransform);
  const irAbs = (i) => { const r = task.nodes.find((n) => n.i === i); const p = r.parent === -1 ? null : r.parent; return p === null ? r.props.relativeTransform : mul6(irAbs(p), r.props.relativeTransform); };
  check(nb.type === "BOOLEAN_OPERATION" && nb.booleanOperation === "SUBTRACT" && same(nb.fills, [SOLID(1, 0, 0)]) && nb.opacity === 0.8 && nb.name === "B1",
    "a class A boolean is native: Figma's operation, its own paints and props, its name");
  check([2, 3].every((i) => sameM(absOf(i), irAbs(i))), "the operands keep the absolute matrices the IR composes (frame · turned boolean · operand)",
    JSON.stringify([absOf(3), irAbs(3)]));
  check([6, 7, 8].every((i) => sameM(absOf(i), irAbs(i))) && E.D.node(ctx.S.nodes["5"]).type === "BOOLEAN_OPERATION" &&
    E.D.node(ctx.S.nodes["5"]).parent.id === ctx.S.nodes["4"] && R.counters.booleansNative === 3, "a nested boolean is built first, inside the outer one, and every operand stays in place");
  const tr = E.D.tree(), root = findTree(tr, ctx.S.nodes["0"]), walk = dfs(root);
  check(walk.length === task.nodes.length && walk.every((n, k) => n.id === ctx.S.nodes[String(task.nodes[k].i)]),
    "no holder frame is left: the built DFS order is still the task's", walk.map((n) => n.name + ":" + n.type).join(","));
  check(!E.D.reads.byPhase.booleans, "the booleans phase reads no layout");
  const ops = E.D.writes.filter((w) => /^(union|subtract|intersect|exclude)\(\)$/.test(w.prop)).map((w) => w.prop);
  check(same(ops, ["intersect()", "union()", "subtract()"]), "booleans are made deepest first (the nested one before the one it is an operand of)", ops.join(","));

  const Ef = env({ double: { faults: { subtract: "the operation is refused" } } });
  const { R: Rf, ctx: cf } = await build(Ef, mkTask({ nodes: nodes.slice(0, 4) }));
  const fb = Ef.D.node(cf.S.nodes["1"]);
  const absF = (i) => flat(Ef.D.node(cf.S.nodes[String(i)]).absoluteTransform);
  check(fb.type === "FRAME" && fb.children.length === 2 && Rf.codes.BOOLEAN_FALLBACK === 1 && /SUBTRACT: the operation is refused/.test(Rf.coded.find((c) => c.code === "BOOLEAN_FALLBACK").detail) &&
    [2, 3].every((i) => sameM(absF(i), irAbs(i))) && Rf.failures.length === 0,
    "a boolean Figma throws on is BOOLEAN_FALLBACK: its operands stay in a frame with the boolean's box, in place", JSON.stringify(Rf.codes));
}

// ============================================================================================
// 7. masks on a group built as a frame (P19B frameMask)
// ============================================================================================
for (const [verdict, expectCode, detail] of [["throw", 1, /refused/], ["drop", 1, /ignored/], ["pending", 0, null]]) {
  const verdicts = loadVerdicts();
  verdicts.probes.P19B.verdicts.frameMask = verdict;
  const task = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 100, 100]), group(1, 0, [T6(0, 0), 50, 50], { isMask: true }), rect(2, 1, [T6(0, 0), 50, 50])] });
  const E = env({ double: { verdicts } });
  const { R, ctx } = await build(E, task);
  const g = E.D.node(ctx.S.nodes["1"]);
  const code = R.coded.find((c) => c.code === "MASK_UNSUPPORTED");
  check((R.codes.MASK_UNSUPPORTED || 0) === expectCode && (expectCode ? detail.test(code.detail) && g.isMask === false : g.isMask === true) && R.failures.length === 0,
    "frameMask " + verdict + ": " + (expectCode ? "a group mask Figma " + (verdict === "throw" ? "refuses" : "ignores") + " is MASK_UNSUPPORTED, built unmasked" : "the mask holds, no code"),
    JSON.stringify(R.codes));
}

// ============================================================================================
// 8. pages: the service page, S2 masters at their place, pages found again, backgrounds
// ============================================================================================
{
  const SERVICE = { index: null, guid: taskMod.SERVICE_PAGE_GUID, name: "pix2fig service", service: true, background: null };
  const t1 = mkTask({ page: SERVICE, nodes: [component(0, 40, [T6(1000, 2000), 60, 40]), rect(1, 0, [T6(5, 5), 10, 10])],
    roots: [{ i: 0, attachTo: "page", place: [0, 400] }] });
  valid("S2 master", t1);
  const E = env();
  const { ctx } = await build(E, t1);
  const t2 = mkTask({ page: SERVICE, taskNo: 2, nodes: [component(5, 41, [T6(3000, 10), 20, 20])], roots: [{ i: 5, attachTo: "page", place: [200, 400] }] });
  const { ctx: c2 } = await build(E, t2);
  const tr = E.D.tree();
  const svc = tr.children.filter((p) => (p.sharedPluginData.pix2fig || {}).pxPage === "m1-service");
  const m0 = findTree(tr, ctx.S.nodes["0"]), m5 = findTree(tr, c2.S.nodes["5"]);
  check(svc.length === 1 && svc[0].name === "pix2fig service" && svc[0].children.map((c) => c.id).join() === [m0.id, m5.id].join() && ctx.S.pages["m1-service"] === svc[0].id,
    "S2 masters land on one service page, stamped pxPage m1-service, found again by the next task");
  check(m0.type === "COMPONENT" && (m0.sharedPluginData.pix2fig || {}).pxDef === "1:100" && (m5.sharedPluginData.pix2fig || {}).pxDef === "1:105" &&
    m0.relativeTransform[0][2] === 0 && m0.relativeTransform[1][2] === 400 && m5.relativeTransform[0][2] === 200,
    "components on the service page are stamped pxDef, each at its grid place");

  const bg = [SOLID(0.1, 0.2, 0.3)];
  const page = { index: 2, guid: "0:7", name: "Page C", service: false, background: bg };
  const E2 = env();
  await build(E2, mkTask({ page, nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }));
  await build(E2, mkTask({ page, taskNo: 2, nodes: [frame(1, -1, [T6(20, 0), 10, 10])] }));
  const pages = E2.D.tree().children.filter((p) => (p.sharedPluginData.pix2fig || {}).pxPage === "0:7");
  check(pages.length === 1 && pages[0].children.length === 2 && same(pages[0].props.backgrounds, bg) && E2.figma.currentPage.id === pages[0].id,
    "an ordinary page is made once, found again by its pxPage stamp, given its background, and made current");
}

// ============================================================================================
// 9. a split root attaches to the parent an earlier task built, which is stamped as a boundary
// ============================================================================================
{
  const E = env();
  const t1 = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 200, 200]), frame(1, 0, [T6(10, 10), 100, 100])] });
  const { ctx } = await build(E, t1);
  const t2 = mkTask({ taskNo: 2, nodes: [rect(2, 1, [T6(5, 6), 10, 10])] });
  valid("split root", t2);
  const { R, ctx: c2 } = await build(E, t2);
  const p = E.D.node(ctx.S.nodes["1"]), child = E.D.node(c2.S.nodes["2"]);
  const st = (n, k) => n.getSharedPluginData("pix2fig", k);
  check(child.parent.id === p.id && child.relativeTransform[0][2] === 5 && st(p, "pxIdx") === "1" && st(p, "pxSrc") === "1:101" && st(p, "pxSnap") === SNAP &&
    st(p, "pxIr") === "2" && st(child, "pxState") === "built" && R.roots[0].i === 2,
    "a split root is built into its parent from the earlier task, which is stamped as a task-boundary parent (pxSrc, pxIdx, pxSnap, pxIr)");
  // After a plugin restart the session is gone; the boundary stamps find the parent.
  const E3 = env();
  E3.D.figma.createFrame();  // an unrelated node
  const { ctx: c3 } = await build(E3, t1);
  const fresh = loadPluginBundle({ figma: E3.D.figma, host: Object.assign(defaultHost(), { phase: E3.D.setPhase }) }).PXF_IR;
  const parent1 = E3.D.node(c3.S.nodes["1"]);
  for (const [k, v] of [["pxIdx", "1"], ["pxSnap", SNAP], ["pxIr", "2"], ["pxRun", RUN], ["pxSrc", "1:" + (G + 1)]]) parent1.setSharedPluginData("pix2fig", k, v);
  const c4 = fresh.makeCtx(E3.D.figma, t2, { id: "r" });
  await fresh.ops.build(c4, t2);
  check(E3.D.node(c4.S.nodes["2"]).parent.id === parent1.id, "after a restart, the split root's parent is found by its stamps");
  const lost = mkTask({ taskNo: 3, runId: RUN2, nodes: [rect(9, 77, [T6(0, 0), 5, 5])] });
  const e = await rejects(build(env(), lost));
  check(e && e.refused && /built parent 77 of a split root is not found/.test(e.message), "a split root whose parent cannot be found refuses the task", e && e.message);
  // Review S8: after a restart, a node stamped with the parent's index by another run of other reader
  // settings (another record's guid) is not the parent: the task refuses rather than attach inside it.
  const E4 = env();
  const { ctx: c5 } = await build(E4, t1);
  const wrong = E4.D.node(c5.S.nodes["1"]);
  for (const [k, v] of [["pxIdx", "1"], ["pxSnap", SNAP], ["pxIr", "2"], ["pxRun", RUN], ["pxSrc", "9:999"]]) wrong.setSharedPluginData("pix2fig", k, v);
  const fresh2 = loadPluginBundle({ figma: E4.D.figma, host: Object.assign(defaultHost(), { phase: E4.D.setPhase }) }).PXF_IR;
  const e2 = await fresh2.ops.build(fresh2.makeCtx(E4.D.figma, t2, { id: "s8" }), t2).then(() => null, (x) => x);
  check(t2.roots[0].attachTo.guid === "1:" + (G + 1) && e2 && e2.refused && /built parent 1 of a split root is not found/.test(e2.message) && wrong.children.length === 0,
    "a node carrying the parent's index but another guid is not taken as the split root's parent", e2 && e2.message);
  const e3 = await rejects(build(env(), Object.assign(clone(t2), { roots: [{ i: 2, attachTo: { i: 1 }, place: null }] })));
  check(!validateTask(Object.assign(clone(t2), { roots: [{ i: 2, attachTo: { i: 1 }, place: null }] })).ok, "a split root's attachTo without the parent's guid is not a valid task", e3 && e3.message);
}

// ============================================================================================
// 10. layout order, constraints last, no timer
// ============================================================================================
{
  const nodes = () => [frame(0, -1, [T6(0, 0), 300, 300], { layoutMode: "VERTICAL", itemSpacing: 4, paddingTop: 2 }),
    frame(1, 0, [T6(0, 2), 300, 100], { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN" }),
    rect(2, 1, [T6(0, 0), 20, 20], { constraints: { horizontal: "SCALE", vertical: "MAX" } }),
    rect(3, 1, [T6(280, 0), 20, 20], { layoutPositioning: "ABSOLUTE", constraints: { horizontal: "MAX", vertical: "MIN" } }),
    frame(4, 0, [T6(0, 106), 100, 100]),
    rect(5, 4, [T6(10, 10), 20, 20], { constraints: { horizontal: "CENTER", vertical: "STRETCH" } })];
  for (const order of ["creation", "deepestFirst"]) {
    const E = env();
    const { R, ctx } = await build(E, mkTask({ nodes: nodes(), settings: { layoutOrder: order } }));
    const lm = E.D.writes.filter((w) => w.prop === "layoutMode" && w.value !== "NONE");
    const where = order === "creation" ? "create" : "layout";
    const inner = lm.findIndex((w) => w.id === ctx.S.nodes["1"]), outer = lm.findIndex((w) => w.id === ctx.S.nodes["0"]);
    check(lm.length === 2 && lm.every((w) => w.phase === where) && (order === "creation" ? outer < inner : inner < outer) && !E.D.reads.byPhase.layout,
      "layoutOrder " + order + ": auto layout is written in " + where + (order === "creation" ? ", parent first" : ", deepest first") + ", with no layout read in the layout phase",
      JSON.stringify(lm.map((w) => [w.phase, w.id])));
    const cw = E.D.writes.filter((w) => w.prop === "constraints");
    check(cw.length > 0 && cw.every((w) => w.phase === "constraints") && typeof R.ms.constraints === "number" && R.counters.constraintsSet === 2 &&
      E.D.node(ctx.S.nodes["5"]).constraints.horizontal === "CENTER" && E.D.node(ctx.S.nodes["3"]).constraints.horizontal === "MAX" &&
      E.D.node(ctx.S.nodes["2"]).constraints.horizontal === "MIN",
      "constraints are set last, timed under constraints, and not on a child the flow places", JSON.stringify([R.counters.constraintsSet, cw.length]));
    check(E.D.node(ctx.S.nodes["3"]).layoutPositioning === "ABSOLUTE" && E.D.node(ctx.S.nodes["2"]).layoutAlign === "INHERIT",
      "the place pass writes a flow child's positioning, align and grow");
  }
  const E = env();
  let timers = 0;
  E.context.setTimeout = () => { timers++; };
  E.context.setInterval = () => { timers++; };
  await build(E, mkTask({ nodes: mixedNodes(), notes: [{ code: "VECTOR_FROM_GEOMETRY", i: 4, detail: null }], images: [{ hash: H1, source: "archive", format: "png", reason: null }] }));
  const files = irBundle().files.filter((f) => /^build|^text/.test(f));
  check(timers === 0 && files.length >= 2, "no setTimeout or setInterval is reached in a whole build (" + files.join(", ") + ")");
  check(E.host.progressed.length >= 1 && E.host.progressed.every((p) => p.id === "t1"), "the build reports progress to the host with its job id");
}

// ============================================================================================
// 11. the fonts op and the clean op
// ============================================================================================
{
  const E = env();
  const t = Object.assign(mkTask({ op: "fonts", page: null, nodes: [] }), { roots: [], fonts: [INTER, { family: "Synthetic Sans", style: "Bold" }, { family: "Roboto", style: "Regular" }] });
  valid("fonts", t);
  const ctx = E.IR.makeCtx(E.D.figma, t, { id: "f" });
  const R = await E.IR.ops.fonts(ctx, t);
  check(R.op === "fonts" && same(R.available, [INTER, { family: "Roboto", style: "Regular" }]) && same(R.missing, [{ family: "Synthetic Sans", style: "Bold" }]) &&
    ctx.S.fonts["Inter|Regular"] === "ok" && ctx.S.fonts["Roboto|Regular"] === "ok" && !ctx.S.fonts["Synthetic Sans|Bold"] && typeof R.ms.fonts === "number" &&
    same(E.D.loadedFonts().sort(), ["Inter|Regular", "Roboto|Regular"]), "the fonts op lists available and missing fonts and loads the available ones", JSON.stringify(R));
  check(/fonts task/.test((await rejects(E.IR.ops.fonts(ctx, mkTask({ nodes: [frame(0, -1, [T6(0, 0), 1, 1])] })))).message), "the fonts op refuses another op's task");
}
{
  const E = env();
  const page = { index: 0, guid: "0:1", name: "Page A", service: false, background: null };
  await build(E, mkTask({ runId: RUN, page, nodes: [frame(0, -1, [T6(0, 0), 10, 10]), frame(1, 0, [T6(1, 1), 5, 5])] }));
  await build(E, mkTask({ runId: RUN, taskNo: 2, page, nodes: [frame(3, -1, [T6(50, 0), 10, 10])] }));
  // An earlier run's leftover of the same root, and a copy of the stamp nested inside a frame.
  const other = E.D.figma.createPage();
  const old = E.D.figma.createFrame(); other.appendChild(old);
  for (const [k, v] of [["pxSrc", "1:100"], ["pxRun", "a".repeat(16)], ["pxSnap", SNAP]]) old.setSharedPluginData("pix2fig", k, v);
  // The same root guid from another file (another snapshot): never this file's to remove (review S5).
  const foreign = E.D.figma.createFrame(); other.appendChild(foreign);
  for (const [k, v] of [["pxSrc", "1:100"], ["pxRun", "b".repeat(16)], ["pxSnap", "another-snapshot"]]) foreign.setSharedPluginData("pix2fig", k, v);
  const holder = E.D.figma.createFrame(); other.appendChild(holder);
  const nested = E.D.figma.createFrame(); holder.appendChild(nested);
  for (const [k, v] of [["pxSrc", "1:100"], ["pxRun", RUN2]]) nested.setSharedPluginData("pix2fig", k, v);
  const clean = (runId, pg) => Object.assign(mkTask({ op: "clean", runId, page: pg, nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }), { expect: null });
  const c1 = clean(RUN2, null);
  valid("clean", c1);
  const ctx = E.IR.makeCtx(E.D.figma, c1, { id: "c" });
  const R = await E.IR.ops.clean(ctx, c1);
  const stillThere = (n) => E.D.node(n.id) !== null;
  check(R.op === "clean" && R.removed === 2 && R.kept === 0 && !stillThere(old) && stillThere(nested) && stillThere(holder) && stillThere(foreign),
    "clean (page null) removes every top-level node stamped with a root's guid and this snapshot from another run, on every page; never a nested one, nor another snapshot's", JSON.stringify(R));
  const E2 = env();
  await build(E2, mkTask({ runId: RUN, page, nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }));
  const c2 = clean(RUN, page);
  const R2 = await E2.IR.ops.clean(E2.IR.makeCtx(E2.D.figma, c2, { id: "c2" }), c2);
  check(R2.removed === 0 && R2.kept === 1, "clean keeps what this run built (kept), on the task's page");
}
{
  // Review S5: two .pix into one Figma file share page guids ("0:1" is in every file) and the
  // service page. Each snapshot gets its own pages; the second never lands on the first's.
  const E = env();
  const page = { index: 0, guid: "0:1", name: "Page A", service: false, background: null };
  const svc = { index: null, guid: "m1-service", name: "pix2fig service: S2 masters", service: true, background: null };
  const SNAP2 = schema.snapshotId({ source: { kind: "pix", sha256: "0".repeat(62) + "b2" } });
  await build(E, mkTask({ runId: RUN, page, nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }));
  await build(E, mkTask({ runId: RUN, taskNo: 2, page: svc, roots: [{ i: 0, attachTo: "page", place: [0, 0] }], nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }));
  await build(E, mkTask({ runId: RUN2, snapshot: SNAP2, page, nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }));
  await build(E, mkTask({ runId: RUN2, snapshot: SNAP2, taskNo: 2, page: svc, roots: [{ i: 0, attachTo: "page", place: [0, 0] }], nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }));
  const tag = (p) => (p.sharedPluginData.pix2fig || {});
  const pages = E.D.tree().children;
  const userPages = pages.filter((p) => tag(p).pxPage === "0:1"), svcPages = pages.filter((p) => tag(p).pxPage === "m1-service");
  check(userPages.length === 2 && svcPages.length === 2 && userPages.every((p) => p.children.length === 1) && svcPages.every((p) => p.children.length === 1) &&
    new Set(userPages.map((p) => tag(p).pxSnap)).size === 2,
    "two snapshots that share a page guid get a page each, and a service page each; neither lands on the other's", JSON.stringify(pages.map((p) => [tag(p), p.children.length])));
  const c = Object.assign(mkTask({ op: "clean", runId: RUN2, snapshot: SNAP2, page, nodes: [frame(0, -1, [T6(0, 0), 10, 10])] }), { expect: null });
  const R = await E.IR.ops.clean(E.IR.makeCtx(E.D.figma, c, { id: "cs" }), c);
  check(R.removed === 0 && R.kept === 1 && userPages.every((p) => E.D.node(p.id).children.length === 1), "the second snapshot's clean leaves the first snapshot's root alone", JSON.stringify(R));
}

// ============================================================================================
// 12. layout-dependent cases, on part E's layout engine (pending on the P0 double; plain checks since F)
// ============================================================================================
check(DOUBLE_FEATURES.layout === true && DOUBLE_FEATURES.text === true, "the double has part E's layout engine and text model");
{
  {
    const task = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 300, 100]), frame(1, 0, [T6(10, 10), 120, 40], { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" }),
      rect(2, 1, [T6(0, 0), 10, 10])] });
    const E = env();
    const { R, ctx } = await build(E, task);
    const n = E.D.node(ctx.S.nodes["1"]);
    // repair1 fixes it, and repair1 is not counted (builder4.js:381), so sizeRepaired stays 0: the
    // check looks for the repair pass's resize instead (merge of part E).
    const repaired = E.D.writes.some((w) => w.id === n.id && w.prop === "resize()" && /^repair/.test(w.phase));
    check(near(n.width, 120, 0.5) && near(n.height, 40, 0.5) && repaired, "repair: a hugging flow frame is fixed at the source size", JSON.stringify([n.width, n.height, R.counters]));
  }
  {
    const task = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 100, 100]), frame(1, 0, [T6(10, 10), 4, 4], { layoutMode: "HORIZONTAL", paddingLeft: 4, paddingRight: 4 })] });
    const E = env();
    const { R, ctx } = await build(E, task);
    const n = E.D.node(ctx.S.nodes["1"]);
    check(near(n.width, 4, 0.5) && R.counters.layoutDroppedForSize === 1, "repair: a childless flow frame under its padding keeps its size and gives up the flow", JSON.stringify([n.width, R.counters]));
  }
  {
    const task = mkTask({ nodes: [frame(0, -1, [T6(0, 0), 200, 100]), frame(1, 0, [T6(0, 0), 60, 10], { layoutMode: "HORIZONTAL", itemSpacing: 10 }),
      rect(2, 1, [T6(0, 0), 10, 10]), rect(3, 1, [T6(20, 0), 10, 10], { visible: false }), rect(4, 1, [T6(40, 0), 10, 10])] });
    const E = env();
    const { ctx } = await build(E, task);
    const x4 = E.D.node(ctx.S.nodes["4"]).absoluteBoundingBox.x;
    check(near(x4, 40, 0.5), "flow: the visible sibling of a hidden flow child is put back at its source position", x4);
  }
}

console.log("");
if (failed) { console.log(failed + " IR builder check" + (failed === 1 ? "" : "s") + " failed"); process.exit(1); }
console.log("all IR builder checks pass");

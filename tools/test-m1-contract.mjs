// The contract part P0 froze for parts A-E (docs/M1.md §5), checked offline: the task format, the
// outside-the-repository guard, the plugin's IR bundle and its ctx, the headless double's core, the
// surface, the shapes the judge stub promises, and pathgeom's bounds. Owned by P0 alone (docs/M1.md §9):
// a part that finds it wrong says so in its pull request; it does not edit this file.
//
//   node tools/test-m1-contract.mjs
//
// Everything here is synthetic. Hashes are computed at run time (tools/test-hygiene.mjs).
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./ir/schema.mjs";
import * as props from "./ir/props.mjs";
import * as taskMod from "./ir/task.mjs";
import { validate, validateTask } from "./ir/validate.mjs";
import { assertOutsideRepo, REPO_ROOT } from "./ir/outside-repo.mjs";
import { generatePlugin, irBundle, irBundleSource } from "./build-plugin.mjs";
import { loadPluginBundle, loadPluginIR, defaultHost } from "./ir/plugin-vm.mjs";
import { makeDouble, networkRegionPath, loadVerdicts } from "./double/index.mjs";
import { SURFACE, LAYOUT_GETTERS } from "./double/surface.mjs";
import * as judge from "./ir/judge.mjs";
import * as pathgeom from "./ir/pathgeom.mjs";
import { checkPostOpts } from "./jobserver.mjs";
import { BUILDER_SRC, VERIFIER_SRC } from "./builder4.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why !== undefined ? " — " + String(why).slice(0, 300) : "")));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message || String(e); } };
const rejects = async (p) => { try { await p; return ""; } catch (e) { return e.message || String(e); } };
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

// ============================================================================================
// 1. the task format (tools/ir/task.mjs)
// ============================================================================================
const SHA = "0".repeat(62) + "a1";
const SNAP = schema.snapshotId({ source: { kind: "pix", sha256: SHA } });
const IMG = sha1("pxf synthetic image for the task contract");
const T6 = (x, y) => [1, 0, x, 0, 1, y];
const painted = { fills: 0, strokes: 1, strokeWeight: 1, strokeAlign: "INSIDE", blendMode: "PASS_THROUGH" };
const SETTINGS = { textFit: "widen", layoutOrder: "creation", textRead: "measure", fallbackFont: { family: "Inter", style: "Regular" } };
const buildTask = () => ({
  format: "pix2fig.task", version: 1, op: "build", runId: "0123456789abcdef", taskNo: 1, of: 2, snapshot: SNAP, irVersion: 2,
  settings: JSON.parse(JSON.stringify(SETTINGS)),
  page: { index: 0, guid: "0:1", name: "Page 1", service: false, background: 0 },
  roots: [{ i: 0, attachTo: "page", place: null }],
  nodes: [
    { i: 0, parent: -1, guid: "1:2", type: "FRAME", name: "F", props: Object.assign({ relativeTransform: T6(0, 0), width: 100, height: 50, clipsContent: true, layoutMode: "NONE", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" }, painted) },
    { i: 1, parent: 0, guid: "1:3", type: "INSTANCE", name: "I", props: { relativeTransform: T6(4, 4), width: 10, height: 10 } },
    { i: 2, parent: 0, guid: "1:4", type: "VECTOR", name: "V", props: Object.assign({ relativeTransform: T6(20, 4), width: 10, height: 8, fillGeometry: 3 }, painted) },
    { i: 3, parent: 0, guid: "1:5", type: "TEXT", name: "T", props: Object.assign({ relativeTransform: T6(40, 4), width: 30, height: 14, characters: "Hi", fontName: 4, fontSize: 12, textAutoResize: "NONE" }, painted) },
    { i: 4, parent: 0, guid: "1:6", type: "RECTANGLE", name: "R", props: Object.assign({ relativeTransform: T6(70, 4), width: 20, height: 20 }, painted, { fills: 5 }) },
  ],
  notes: [{ code: "VECTOR_FROM_GEOMETRY", i: 2, detail: null }],
  values: { "0": [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], "1": [], "3": [{ windingRule: "NONZERO", data: "M 0 0 L 10 0 L 5 8 Z" }],
    "4": { family: "Inter", style: "Regular" }, "5": [{ type: "IMAGE", scaleMode: "FILL", imageHash: IMG }] },
  fonts: [{ family: "Inter", style: "Regular" }],
  images: [{ hash: IMG, source: "archive", format: "png", reason: null }],
  expect: { count: 5, nonInstance: 4, placeholders: 1 },
});
const fontsTask = () => Object.assign(buildTask(), { op: "fonts", page: null, roots: [], nodes: [], notes: [], values: {}, images: [], expect: null });
const tmut = (base, f) => { const t = base(); f(t); return t; };
function taskOk(label, t, opts) {
  const r = validateTask(t, opts);
  check(r.ok, label, r.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join(" | "));
}
function taskErr(label, t, path, opts) {
  const r = validateTask(t, opts);
  const hit = r.errors.find((e) => e.path === path);
  check(!r.ok && hit, label + (hit ? "  ->  " + hit.path + ": " + hit.message : ""), r.ok ? "accepted" : r.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join(" | "));
}

check(taskMod.TASK_IR_VERSION === schema.VERSION, "the task format's IR version is the schema's (" + schema.VERSION + ")");
check(Object.isFrozen(taskMod.BUILT_TYPE) && Object.keys(taskMod.BUILT_TYPE).every((t) => schema.NODE_TYPES.indexOf(t) >= 0) &&
  Object.keys(taskMod.BUILT_TYPE).every((t) => SURFACE.nodes[taskMod.BUILT_TYPE[t]]) && taskMod.BUILT_TYPE.GROUP === "FRAME" && taskMod.BUILT_TYPE.INSTANCE === "FRAME",
  "BUILT_TYPE is frozen, maps IR types to Figma types the surface has, GROUP and INSTANCE to FRAME");
check(taskMod.MAX_TASK_CHARS === 4194304 && taskMod.maxTaskChars(4) === 4194304 && taskMod.maxTaskChars(16) === taskMod.MAX_TASK_CHARS_CEILING &&
  /1 to 16/.test(threw(() => taskMod.maxTaskChars(17))) && /1 to 16/.test(threw(() => taskMod.maxTaskChars(0.5))),
  "the size cap is 4 MB, --max-task-mb takes 1 to 16");
check(/needs tools\/ir\/schema\.mjs/.test(threw(() => taskMod.validateTask(buildTask()))), "validateTask without the schema throws rather than answering ok");
check(taskMod.BUILD_PHASES.join() === "fonts,images,pages,create,vectors,booleans,layout,settle,measure,repair1,place1,repair2,place2,flowGroup,flow1,flow2,repair3,place3,textLine,constraints,stamp" &&
  taskMod.WRITE_ONLY_PHASES.every((p) => taskMod.BUILD_PHASES.indexOf(p) >= 0) && taskMod.WRITE_ONLY_PHASES.join() === taskMod.BUILD_PHASES.slice(0, 6).join(),
  "the build op's phase table is docs/M1.md §6 B's, and its write-only phases come first");
taskOk("a build task with a frame, a placeholder, a geometry vector, a text and an image passes", buildTask());
taskOk("a verify task of the same records passes", tmut(buildTask, (t) => { t.op = "verify"; }));
taskOk("a fonts task (settings and fonts only) passes", fontsTask());
taskOk("a clean task carrying its root records only passes", tmut(buildTask, (t) => { t.op = "clean"; t.nodes = [t.nodes[0]]; t.notes = []; t.values = { "0": t.values["0"], "1": [] }; t.images = []; t.expect = null; t.page = null; }));
taskOk("a split root attached to its built parent passes", tmut(buildTask, (t) => {
  t.nodes.push({ i: 9, parent: 7, guid: "1:9", type: "FRAME", name: "Split", props: Object.assign({ relativeTransform: T6(0, 60), width: 10, height: 10, clipsContent: false, layoutMode: "NONE", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" }, painted) });
  t.roots.push({ i: 9, attachTo: { i: 7, guid: "1:7" }, place: null }); t.expect = { count: 6, nonInstance: 5, placeholders: 1 };
}));
taskErr("a split root whose attachTo does not name its parent's guid", tmut(buildTask, (t) => {
  t.nodes.push({ i: 9, parent: 7, guid: "1:9", type: "FRAME", name: "Split", props: Object.assign({ relativeTransform: T6(0, 60), width: 10, height: 10, clipsContent: false, layoutMode: "NONE", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" }, painted) });
  t.roots.push({ i: 9, attachTo: { i: 7 }, place: null }); t.expect = { count: 6, nonInstance: 5, placeholders: 1 };
}), "roots[1].attachTo.guid");
taskOk("an S2 master on the service page, attached to the page at its grid place, passes", tmut(buildTask, (t) => {
  t.page = { index: null, guid: taskMod.SERVICE_PAGE_GUID, name: "pix2fig service", service: true, background: null };
  t.nodes[0].parent = 12; t.roots[0].place = [0, 400];
}));
taskErr("an unknown op", tmut(buildTask, (t) => { t.op = "paint"; }), "op");
taskErr("a runId that is not 16 hex", tmut(buildTask, (t) => { t.runId = "run-1"; }), "runId");
taskErr("another task version", tmut(buildTask, (t) => { t.version = 2; }), "version");
taskErr("records of another IR version", tmut(buildTask, (t) => { t.irVersion = 1; }), "irVersion");
taskErr("an unknown key", tmut(buildTask, (t) => { t.extra = 1; }), "extra");
taskErr("a layout order outside its values", tmut(buildTask, (t) => { t.settings.layoutOrder = "random"; }), "settings.layoutOrder");
taskErr("an oracle prop in a node", tmut(buildTask, (t) => { t.nodes[2].props.oracleFillGeometry = 3; }), "nodes[2].props.oracleFillGeometry");
taskErr("oracleSides in a node", tmut(buildTask, (t) => { t.nodes[0].props.oracleSides = [true, true, true, true]; }), "nodes[0].props.oracleSides");
taskErr("a geometry-built vector without its note", tmut(buildTask, (t) => { t.notes = []; }), "nodes[2].props.fillGeometry");
taskErr("a vector with two sources", tmut(buildTask, (t) => { t.nodes[2].props.vectorNetwork = 4; }), "nodes[2].props");
taskErr("a value the task does not carry", tmut(buildTask, (t) => { delete t.values["0"]; t.page.background = null; }), "nodes[0].props.fills");
taskErr("a value the task carries but does not use", tmut(buildTask, (t) => { t.values["9"] = [1]; }), "values.9");
taskErr("an image paint whose hash is not in images", tmut(buildTask, (t) => { t.images = []; }), "values.5[0].imageHash");
taskErr("a font the task does not list", tmut(buildTask, (t) => { t.fonts = []; }), "nodes[3].props.fontName");
taskErr("an expected count that is not the records'", tmut(buildTask, (t) => { t.expect.count = 4; }), "expect.count");
taskErr("an expected placeholder count that is not the INSTANCE records'", tmut(buildTask, (t) => { t.expect.placeholders = 0; t.expect.nonInstance = 5; }), "expect.placeholders");
taskErr("a top-level record that is not a root", tmut(buildTask, (t) => { t.roots = []; }), "nodes[0]");
taskErr("a root whose parent is in the task", tmut(buildTask, (t) => { t.roots.push({ i: 1, attachTo: { i: 0, guid: "1:0" }, place: null }); }), "roots[1].attachTo.i");
taskErr("a split root attached to a parent that is not its own", tmut(buildTask, (t) => {
  t.nodes.push({ i: 9, parent: 7, guid: "1:9", type: "FRAME", name: "Split", props: Object.assign({ relativeTransform: T6(0, 60), width: 10, height: 10, clipsContent: false, layoutMode: "NONE", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" }, painted) });
  t.roots.push({ i: 9, attachTo: { i: 8, guid: "1:8" }, place: null }); t.expect = { count: 6, nonInstance: 5, placeholders: 1 };
}), "roots[1].attachTo.i");
taskErr("a grid place on an ordinary page", tmut(buildTask, (t) => { t.roots[0].place = [0, 0]; }), "roots[0].place");
taskErr("a type M1 does not build", tmut(buildTask, (t) => { t.nodes[0].type = "COMPONENT_SET"; }), "nodes[0].type");
taskErr("a record after its child (not parent-first)", tmut(buildTask, (t) => { t.nodes.reverse(); }), "nodes[0].parent");
taskErr("a build-stage code in the task's notes", tmut(buildTask, (t) => { t.notes.push({ code: "INSTANCE_DEFERRED", i: 1, detail: null }); }), "notes[1].code");
taskErr("an unknown code in the task's notes", tmut(buildTask, (t) => { t.notes.push({ code: "LOOKS_FINE", i: 1, detail: null }); }), "notes[1].code");
taskErr("a task over its size cap", buildTask(), "", { maxChars: 500 });
taskErr("a fonts task carrying nodes", tmut(fontsTask, (t) => { t.nodes = buildTask().nodes.slice(0, 1); t.roots = [{ i: 0, attachTo: "page", place: null }]; t.values = { "0": [], "1": [] }; }), "nodes");
taskErr("a build task without a page", tmut(buildTask, (t) => { t.page = null; }), "page");
taskOk("a clean task with page null for an S2 master (its page is not named, so any root attaches to \"page\")", tmut(buildTask, (t) => {
  t.op = "clean"; t.nodes = [t.nodes[0]]; t.nodes[0].parent = 12; t.notes = []; t.values = { "0": t.values["0"], "1": [] }; t.images = []; t.expect = null; t.page = null;
}));
taskOk("a clean task naming its page passes", tmut(buildTask, (t) => { t.op = "clean"; t.nodes = [t.nodes[0]]; t.notes = []; t.values = { "0": t.values["0"], "1": [] }; t.images = []; t.expect = null; }));
taskErr("a split root attached to index -1", tmut(buildTask, (t) => { t.roots[0].attachTo = { i: -1 }; }), "roots[0].attachTo.i");
taskErr("a prop the record's type does not have (props.mjs KNOWN_PROPS)", tmut(buildTask, (t) => { t.nodes[1].props.fills = 0; }), "nodes[1].props.fills");
taskErr("a prop of the wrong kind", tmut(buildTask, (t) => { t.nodes[0].props.layoutMode = "GRID"; }), "nodes[0].props.layoutMode");
taskErr("a NEVER_OMIT prop left out", tmut(buildTask, (t) => { delete t.nodes[3].props.fontSize; }), "nodes[3].props.fontSize");
check(/props is tools\/ir\/props\.mjs/.test(threw(() => taskMod.validateTask(buildTask(), { schema, props: {} }))), "validateTask with a props argument that is not the tables throws");
{
  // The plugin runs the same check on the bundled text (PXF_TASK with PXF_SCHEMA): the same answers.
  const B = loadPluginBundle({ figma: makeDouble().figma });
  const cases = [buildTask(), tmut(buildTask, (t) => { t.notes = []; t.values["9"] = [1]; t.nodes[0].props.opactiy = 1; delete t.nodes[3].props.fontSize; }), fontsTask()];
  const agree = cases.every((t) => same(B.PXF_TASK.validateTask(JSON.parse(JSON.stringify(t)), { schema: B.PXF_SCHEMA, props: B.PXF_PROPS }), validateTask(t)));
  check(agree, "the bundled PXF_TASK gives the same answers as tools/ir/validate.mjs on valid and broken tasks");
}

// ============================================================================================
// 2. nothing private is written inside the working tree (docs/M1.md D17)
// ============================================================================================
{
  const tmp = mkdtempSync(join(tmpdir(), "pxf-outside-"));
  try {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    mkdirSync(join(tmp, "out"));
    const refused = (p) => { try { assertOutsideRepo(p, { repo }); return ""; } catch (e) { return e.code || e.message; } };
    check(refused(join(repo, "sub", "new", "ir.json")) === "INSIDE_REPO" && refused(repo) === "INSIDE_REPO",
      "a path inside the repository is refused, whether it exists yet or not, and so is the root itself");
    check(refused(join(tmp, "out", "ir.json")) === "" && refused(join(tmp, "repo-sibling", "ir.json")) === "",
      "a path outside is allowed, a sibling whose name starts like the repository's included");
    let junction = "";
    try { symlinkSync(repo, join(tmp, "link"), process.platform === "win32" ? "junction" : "dir"); junction = refused(join(tmp, "link", "sub", "ir.json")); }
    catch (e) { junction = "skip: " + e.message; }
    if (junction.startsWith("skip")) console.log("skip the junction case: " + junction);
    else check(junction === "INSIDE_REPO", "a path through a junction (or symlink) into the repository is refused", junction);
    if (process.platform === "win32" || process.platform === "darwin") {
      const upper = refused(join(repo, "sub", "ir.json").toUpperCase());
      const drive = process.platform === "win32" ? refused(join(repo, "sub", "ir.json").replace(/^[A-Za-z]:/, (d) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()))) : "INSIDE_REPO";
      check(upper === "INSIDE_REPO" && drive === "INSIDE_REPO", "a path that differs only in case (the whole path, or the drive letter) is refused", upper + " / " + drive);
    } else console.log("skip the case-folding case: this file system is case-sensitive");
    check(threw(() => assertOutsideRepo(join(REPO_ROOT, "out", "x.json"))) !== "" && threw(() => assertOutsideRepo(join(tmp, "out", "x.json"))) === "",
      "by default the repository is this checkout");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ============================================================================================
// 3. the plugin's IR bundle (tools/build-plugin.mjs)
// ============================================================================================
{
  const b = irBundle();
  const names = b.files;
  check(names[0] === "common.js" && names.slice(1).join() === names.slice(1).slice().sort().join() &&
    ["build", "measure", "probes", "text", "verify"].every((p) => names.some((f) => f === p + ".js" || f.indexOf(p + "-") === 0)),
    "the bundle puts common.js first, then every other ir/*.js by name, with each part's files present (" + names.join(", ") + ")");
  const text = b.text;
  check(["var PXF_PROPS = (function", "var PXF_SCHEMA = (function", "var PXF_TASK = (function", "var PXF_PATHGEOM = (function", "var PXF_IR = (function", "})(PXF_IR);"].every((s) => text.indexOf(s) >= 0) &&
    !/^export /m.test(text), "the bundle has the four modules as IIFEs, PXF_IR, and the wrapped ir files, and no export left");
  const code = generatePlugin({}).code;
  const at = (s) => code.indexOf(s);
  check(at("async function PXF_VERIFY(") < at("var PXF_PROPS = (function") && at("var PXF_IR = (function") < at("// ---- figma-plugin/src/code.js ----"),
    "dist/code.js places the IR layer between the verifier and the host");
  const v0 = generatePlugin({}).version;
  const files = {};
  for (const f of names) files[f] = readFileSync(join(HERE, "..", "figma-plugin", "src", "ir", f), "utf8");
  const v1 = generatePlugin({ sources: { irFiles: Object.assign({}, files, { "zz.js": "// planted\nIR.planted = 1;\n" }) } }).version;
  const v2 = generatePlugin({ sources: { irModules: { "props.mjs": readFileSync(join(HERE, "ir", "props.mjs"), "utf8") + "\nexport const PLANTED = 1;\n" } } }).version;
  check(v0 !== v1 && v0 !== v2 && v1 !== v2, "an edit to an ir file or a bundled module gives a new build id");
  const timer = threw(() => generatePlugin({ sources: { irFiles: Object.assign({}, files, { "zz.js": "// a timer is named in this comment: setTimeout\nIR.x = function () { return setTimeout(function () {}, 0); };\n" }) } }));
  const commentOnly = threw(() => generatePlugin({ sources: { irFiles: Object.assign({}, files, { "zz.js": "// never setTimeout here\nIR.x = 1;\n" }) } }));
  check(/figma-plugin\/src\/ir\/zz\.js uses setTimeout/.test(timer) && commentOnly === "", "an ir file that uses setTimeout is refused; one that only names it in a comment is not", timer || commentOnly);
  const broken = threw(() => generatePlugin({ sources: { irFiles: Object.assign({}, files, { "zz.js": "IR.a = 1;\nIR.b = = 2;\n" }) } }));
  check(/does not compile/.test(broken) && /figma-plugin\/src\/ir\/zz\.js line 2\b/.test(broken), "an ir file that does not compile is named by its file and line", broken);
  const brokenModule = threw(() => generatePlugin({ sources: { irModules: { "task.mjs": readFileSync(join(HERE, "ir", "task.mjs"), "utf8").replace("export const TASK_VERSION = 1;", "export const TASK_VERSION = = 1;") } } }));
  const line = readFileSync(join(HERE, "ir", "task.mjs"), "utf8").split(/\r?\n/).findIndex((l) => l.startsWith("export const TASK_VERSION")) + 1;
  check(/does not compile/.test(brokenModule) && brokenModule.indexOf("tools/ir/task.mjs line " + line + ")") >= 0, "a bundled module that does not compile is named by its file and line", brokenModule);
  check(/export the bundler does not understand/.test(threw(() => irBundleSource({ irModules: { "pathgeom.mjs": "export default 1;\n" } }))),
    "a bundled module with an export the bundler does not understand is refused");
  check(/common\.js is missing/.test(threw(() => irBundleSource({ irFiles: { "build.js": "IR.x = 1;\n" } }))), "a bundle without common.js is refused");
}

// ============================================================================================
// 4. PXF_IR and its ctx, run as bundled (tools/ir/plugin-vm.mjs) over the double
// ============================================================================================
{
  const D = makeDouble();
  const host = defaultHost();
  host.phase = D.setPhase;
  const B = loadPluginBundle({ figma: D.figma, host });
  const IR = B.PXF_IR;
  check(B.context.setTimeout === undefined && B.context.setInterval === undefined, "the bundle runs in a context with no timers at all");
  check(loadPluginIR({ figma: D.figma }).ops !== IR.ops, "loadPluginIR gives a fresh PXF_IR each time");
  const task = buildTask();
  const ctx = IR.makeCtx(D.figma, task, { id: "j1" });
  check(Object.isFrozen(ctx) && ["figma", "task", "S", "value", "prop", "phase", "breathe", "progress", "settle", "measure", "code", "failure", "stamp", "stampOf", "findRoot", "log", "report"].every((k) => k in ctx),
    "ctx is frozen and has every member docs/M1.md §5.3 lists (plus failure and log)");
  check(same(ctx.report, { op: "build", taskNo: 1, runId: "0123456789abcdef", ms: {}, codes: {}, coded: [], failures: [] }), "ctx.report starts as { op, taskNo, runId, ms, codes, coded, failures }", JSON.stringify(ctx.report));
  check(same(ctx.value(4), { family: "Inter", style: "Regular" }) && /values\[9\] is not in task 1/.test(threw(() => ctx.value(9))), "ctx.value resolves a carried value and throws on one the task does not carry");
  const eff = ctx.prop(task.nodes[0], "effects");
  eff.push("mutated");
  const noTextProp = Object.keys(props.KNOWN_PROPS.FRAME).find((p) => !props.KNOWN_PROPS.TEXT[p] && Object.prototype.hasOwnProperty.call(props.DEFAULTS, p));
  check(same(ctx.prop(task.nodes[0], "fills"), task.values["0"]) && same(ctx.prop(task.nodes[0], "opacity"), props.DEFAULTS.opacity) && same(ctx.prop(task.nodes[0], "effects"), props.DEFAULTS.effects) &&
    ctx.prop(task.nodes[0], "strokeWeight") === 1 && noTextProp && ctx.prop(task.nodes[3], noTextProp) === undefined && same(ctx.prop(task.nodes[0], "constraints"), props.DEFAULTS.constraints),
    "ctx.prop resolves interned props, gives a copy of the default for an absent prop that applies, and nothing for one that does not");
  ctx.phase("create");
  const wroteIn = D.writes.length;
  ctx.phase("vectors");
  ctx.phase(null);
  check(typeof ctx.report.ms.create === "number" && typeof ctx.report.ms.vectors === "number" && wroteIn === D.writes.length, "ctx.phase books each phase's time in report.ms");
  check(host.progressed.length === 1 && host.progressed[0].id === "j1" && host.progressed[0].done >= 1, "progress reaches the host with the job id, at most once a second", JSON.stringify(host.progressed));
  const frame = D.figma.createFrame();
  D.setPhase("measure");
  await ctx.settle(frame);
  check(D.reads.byPhase.measure === 1, "ctx.settle forces layout once, through the root's bounding box", JSON.stringify(D.reads.byPhase));
  const p1 = ctx.breathe(1), p2 = ctx.breathe(400);
  check(typeof p1.then === "function" && typeof p2.then === "function", "ctx.breathe answers a promise, with no timer");
  await Promise.all([p1, p2]);
  ctx.code(IR.CODE.INSTANCE_DEFERRED, 1, "placeholder");
  check(ctx.report.codes.INSTANCE_DEFERRED === 1 && same(ctx.report.coded[0], { code: "INSTANCE_DEFERRED", i: 1, detail: "placeholder" }) &&
    /unknown reason code/.test(threw(() => ctx.code("NOT_A_CODE", 1))), "ctx.code counts and lists a known code and throws on an unknown one");
  ctx.failure(2, "vectorPaths", new Error("synthetic"));
  check(same(ctx.report.failures, [{ i: 2, prop: "vectorPaths", msg: "Error: synthetic" }]), "ctx.failure lists { i, prop, msg }", JSON.stringify(ctx.report.failures));
  ctx.stamp(frame, "pxScratch", "1");
  check(ctx.stampOf(frame, "pxScratch") === "1" && frame.getPluginData("pxScratch") === "1" && frame.getSharedPluginData("pix2fig", "pxScratch") === "1" &&
    /is not a stamp/.test(threw(() => ctx.stamp(frame, "pxNote", "x"))), "ctx.stamp writes shared stamps in namespace pix2fig, pxScratch privately too, and refuses any other key");
  // findRoot: the registry first, then the stamps.
  const stamped = (snap, src, run) => { const f = D.figma.createFrame(); ctx.stamp(f, "pxIdx", "0"); ctx.stamp(f, "pxSnap", snap); ctx.stamp(f, "pxIr", String(schema.VERSION));
    ctx.stamp(f, "pxSrc", src || "1:2"); ctx.stamp(f, "pxRun", run || task.runId); return f; };
  const wrongSnap = stamped("pix:other");
  const right = stamped(SNAP);
  stamped(SNAP, "1:2", "fedcba9876543210");     // an earlier run's build of the same root: this run's wins
  stamped(SNAP, "7:7");                          // index 0 of an IR read with other settings: another guid
  const page2 = D.figma.createPage();
  const later = D.figma.createFrame(); page2.appendChild(later);
  ctx.stamp(later, "pxIdx", "0"); ctx.stamp(later, "pxSnap", SNAP); ctx.stamp(later, "pxIr", "1");
  ctx.S.nodes["0"] = wrongSnap.id;
  const found = await ctx.findRoot(0);
  check(found && found.id === right.id && ctx.S.nodes["0"] === right.id, "ctx.findRoot skips a remembered id whose stamps do not match, finds the root by pxIdx, pxSnap, pxIr and pxSrc (the record's guid), prefers this run's, and remembers it");
  check((await ctx.findRoot(3)) === null, "ctx.findRoot answers null when nothing carries the stamps");
  const ctx2 = IR.makeCtx(D.figma, task, { id: "j2" });
  const ctx3 = IR.makeCtx(D.figma, Object.assign(buildTask(), { runId: "fedcba9876543210" }), { id: "j3" });
  check(ctx2.S === ctx.S && ctx3.S !== ctx.S && same(ctx3.S.nodes, {}), "the session is kept across the tasks of one run and starts again for another run");
  if (IR.countLines.notInThisBuild) check(/IR\.countLines is not in this build: part C/.test(threw(() => ctx.measure(frame, task.nodes[3]))), "ctx.measure calls IR.countLines, which refuses until part C lands");
  host.measure = (c, node, rec) => ({ lines: 2, approx: false, rec: rec.i });
  check(same(ctx.measure(frame, task.nodes[3]), { lines: 2, approx: false, rec: 3 }), "a test's host.measure replaces IR.countLines");
  delete host.measure;
  // The stubs, while they are stubs: each part's real code replaces them, and these checks then stand aside.
  const stubbed = [["ops.fonts", IR.ops.fonts, "B"], ["ops.build", IR.ops.build, "B"], ["ops.clean", IR.ops.clean, "B"], ["ops.verify", IR.ops.verify, "C"],
    ["writeTextProps", IR.writeTextProps, "B"], ["countLines", IR.countLines, "C"]].concat(["P4", "P8", "P19B"].map((p) => ["probes." + p, IR.probes[p].run, "E"]))
    .filter(([, fn]) => fn && fn.notInThisBuild);
  const wrong = stubbed.map(([name, fn, part]) => {
    if (fn.notInThisBuild !== part) return name + " is marked part " + fn.notInThisBuild;
    try { fn(ctx, task); return name + " ran"; } catch (e) { return e.refused && e.code === "NOT_IMPLEMENTED" && e.message.indexOf("part " + part) >= 0 ? "" : name + ": " + e.message; }
  }).filter(Boolean);
  check(!wrong.length, "every stub still in this build refuses, naming its part (" + (stubbed.map((s) => s[0]).join(", ") || "none left") + ")", wrong.join("; "));
  check(/setHost/.test(threw(() => { const fresh = loadPluginBundle({ figma: D.figma }); fresh.PXF_IR.setHost({}); })), "setHost refuses a host without images, imageErrors and progress");
}

// ============================================================================================
// 5. the double's core (tools/double/index.mjs)
// ============================================================================================
{
  const D = makeDouble();
  const f = D.figma;
  const fr = f.createFrame();
  check(/outside the surface/.test(threw(() => fr.characters)) && /outside the surface/.test(threw(() => { fr.characters = "x"; })) &&
    /outside the surface/.test(threw(() => f.notACall)) && /outside the surface/.test(threw(() => { const r = f.createRectangle(); r.layoutMode = "VERTICAL"; })),
    "reading, writing or calling outside the surface throws, naming the type and the property");
  const D2 = makeDouble({ allow: { figma: [], nodes: { RECTANGLE: { write: ["layoutMode"] } } } });
  check(threw(() => { const r = D2.figma.createRectangle(); r.layoutMode = "VERTICAL"; }) === "", "makeDouble({ allow }) admits a listed addition for one test");
  check(fr.parent.id === f.currentPage.id && f.root.children[0].id === f.currentPage.id, "a created node lands on the current page");
  fr.resize(200, 100);
  fr.relativeTransform = [[1, 0, 10], [0, 1, 20]];
  const r = f.createRectangle(); fr.appendChild(r); r.x = 5; r.y = 6; r.resize(10, 10);
  D.setPhase("create");
  const abs = r.absoluteTransform, bb = r.absoluteBoundingBox;
  check(abs[0][2] === 15 && abs[1][2] === 26 && bb.x === 15 && bb.width === 10 && D.reads.byPhase.create === 2 && D.reads.total === 2,
    "transforms compose up to the page, and layout-forcing reads are counted per phase", JSON.stringify([abs, bb, D.reads.byPhase]));
  D.setPhase("styles");
  void r.fills; void r.name;
  check(!D.reads.byPhase.styles, "reads that force no layout are not counted");
  r.strokeTopWeight = 3; r.strokeLeftWeight = 0;
  const mixedRead = r.strokeWeight === f.mixed;
  r.strokeWeight = 2;
  check(mixedRead && r.strokeTopWeight === 2 && r.strokeLeftWeight === 2 && r.strokeWeight === 2, "strokeWeight resets the four side weights, and reads back figma.mixed while they differ");
  r.topLeftRadius = 4;
  const mixedCorner = r.cornerRadius === f.mixed;
  r.cornerRadius = 1;
  check(mixedCorner && r.topLeftRadius === 1, "cornerRadius resets the four corners likewise");
  check(D.writes.some((w) => w.phase === "styles" && w.id === r.id && w.prop === "strokeWeight" && w.value === 2) && D.writes.some((w) => w.prop === "resize()"),
    "the write log has every assignment and mutating call, with its phase");
  // Vectors.
  const v = f.createVector();
  const net = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }],
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2, tangentStart: { x: 0, y: 4 }, tangentEnd: { x: 2, y: 0 } }, { start: 2, end: 0 }],
    regions: [{ windingRule: "EVENODD", loops: [[0, 1, 2]] }] };
  await v.setVectorNetworkAsync(net);
  const g = v.fillGeometry;
  // Figma reads paths back glued ("M0 0L10 0Z", P19B 2026-10-05); pathBounds reads them as Figma writes them.
  check(g.length === 1 && g[0].windingRule === "EVENODD" && g[0].data === "M0 0L10 0C10 4 7 8 5 8L0 0Z" && pathgeom.pathBounds(g[0].data).length === 1,
    "a network's region gives its fillGeometry, lines and cubics, as a Figma path string", JSON.stringify(g));
  // P19 (recorded): an open chain with no region draws no fill. P19B (recorded 2026-10-05): a closed
  // loop with no region is filled (regionlessFill ok); with P19B planted pending, the double's
  // assumption (empty) leaves it unfilled.
  await v.setVectorNetworkAsync({ vertices: net.vertices, segments: net.segments.slice(0, 2), regions: [] });
  const openNone = v.fillGeometry.length === 0;
  await v.setVectorNetworkAsync({ vertices: net.vertices, segments: net.segments, regions: [] });
  const closedOne = v.fillGeometry.length === 1 && v.fillGeometry[0].windingRule === "NONZERO";
  const Dp = makeDouble({ verdicts: { probes: { P19B: { status: "pending", verdicts: {} } } } });
  const vp = Dp.figma.createVector();
  await vp.setVectorNetworkAsync({ vertices: net.vertices, segments: net.segments, regions: [] });
  check(openNone && closedOne && vp.fillGeometry.length === 0,
    "an open region-less network has no fill geometry (P19); a closed one has its loop (P19B regionlessFill ok), none with P19B planted pending",
    JSON.stringify([openNone, v.fillGeometry, vp.fillGeometry]));
  const ra = await rejects(v.setVectorNetworkAsync({ vertices: [{ x: 0, y: 0, handleMirroring: "RIGHT_ANGLE" }, { x: 1, y: 1 }], segments: [{ start: 0, end: 1 }], regions: [] }));
  check(/RIGHT_ANGLE/.test(ra), "setVectorNetworkAsync rejects RIGHT_ANGLE mirroring");
  v.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 4 0 L 4 4 Z" }, { windingRule: "NONE", data: "M 0 0 L 1 1" }];
  check(v.fillGeometry.length === 1 && v.fillGeometry[0].data === "M0 0L4 0L4 4Z", "vectorPaths give the fill geometry directly, without the unfilled ones");
  check(networkRegionPath(net, { windingRule: "NONZERO", loops: [[2, 1, 0]] }).indexOf("Z") > 0, "a loop listed in the other direction still gives a closed path");
  // Text and fonts.
  const t = f.createText();
  check(/unloaded font/.test(threw(() => { t.characters = "Hello"; })), "a text write before loadFontAsync of its font throws");
  await f.loadFontAsync({ family: "Inter", style: "Regular" });
  t.characters = "Hello";
  check(/unloaded font/.test(threw(() => t.setRangeFontName(0, 2, { family: "Inter", style: "Bold" }))) && /not available/.test(await rejects(f.loadFontAsync({ family: "Nonexistent", style: "Regular" }))),
    "a range in a font not loaded throws, and a font Figma lacks will not load");
  await f.loadFontAsync({ family: "Inter", style: "Bold" });
  t.setRangeFontName(0, 2, { family: "Inter", style: "Bold" });
  check(t.getRangeFontName(0, 2).style === "Bold" && t.characters === "Hello" && (await f.listAvailableFontsAsync()).length >= 4, "ranges are kept and read back");
  // Images, booleans, faults, plugin data, masks.
  const bytes = new Uint8Array(Buffer.from("pxf synthetic image bytes"));
  check(f.createImage(bytes).hash === createHash("sha1").update(bytes).digest("hex"), "createImage's hash is the SHA-1 of the bytes");
  const a = f.createRectangle(); a.resize(10, 10);
  const b2 = f.createEllipse(); b2.resize(10, 10); b2.x = 5; b2.y = 5;
  const u = f.union([a, b2], f.currentPage);
  check(u.type === "BOOLEAN_OPERATION" && u.booleanOperation === "UNION" && u.children.length === 2 && u.width === 15 && u.height === 15 && b2.absoluteTransform[0][2] === 5,
    "a boolean operation holds its operands, keeps where they are, and takes their union box");
  const D3 = makeDouble({ faults: { union: "synthetic refusal" } });
  check(/synthetic refusal/.test(threw(() => D3.figma.union([D3.figma.createRectangle()], D3.figma.currentPage))), "makeDouble({ faults }) makes a figma call throw, for fallback tests");
  const D4 = makeDouble({ verdicts: { probes: { P19B: { verdicts: { frameMask: "throw" } } } } });
  check(/isMask refused/.test(threw(() => { D4.figma.createFrame().isMask = true; })) && threw(() => { f.createRectangle().isMask = true; }) === "",
    "a frame mask follows the P19B verdict (here: throw); a shape mask is kept");
  a.setSharedPluginData("pix2fig", "pxSrc", "9:9");
  const hits = f.currentPage.findAllWithCriteria({ sharedPluginData: { namespace: "pix2fig", keys: ["pxSrc"] } });
  check(hits.length === 1 && hits[0].id === a.id && a.getSharedPluginData("pix2fig", "pxSrc") === "9:9" && a.getSharedPluginData("other", "pxSrc") === "",
    "shared plugin data is kept per namespace and found by findAllWithCriteria");
  const tr = D.tree();
  check(tr.type === "DOCUMENT" && tr.children[0].type === "PAGE" && tr.children[0].children.some((c) => c.id === fr.id && c.children[0].id === r.id),
    "tree() gives the document as plain data");
  const gone = f.createFrame(); const gid = gone.id; gone.remove();
  check((await f.getNodeByIdAsync(gid)) === null && gone.removed === true && (await f.getNodeByIdAsync(fr.id)).id === fr.id, "getNodeByIdAsync finds live nodes and not removed ones");
}

// ============================================================================================
// 6. the surface (tools/double/surface.mjs)
// ============================================================================================
{
  const missing = [];
  for (const irType of Object.keys(taskMod.BUILT_TYPE)) {
    const ft = taskMod.BUILT_TYPE[irType];
    for (const p of Object.keys(props.KNOWN_PROPS[irType])) {
      if (schema.IR_OWN_PROPS.indexOf(p) >= 0 || schema.GEOMETRY_PROPS.indexOf(p) >= 0 || p === "width" || p === "height") continue;
      if (SURFACE.nodes[ft].write.indexOf(p) < 0) missing.push(irType + "." + p + " on " + ft);
    }
  }
  check(!missing.length, "every Figma prop KNOWN_PROPS lists for an IR type is writable on the Figma type it is built as", missing.join(", "));
  const notLayout = [];
  for (const t of Object.keys(SURFACE.nodes)) {
    if (t === "DOCUMENT" || t === "PAGE") continue;
    for (const p of LAYOUT_GETTERS) if (!SURFACE.nodes[t].read[p] || SURFACE.nodes[t].read[p].layout !== true) notLayout.push(t + "." + p);
  }
  check(!notLayout.length, "the layout-forcing getters are marked layout: true on every scene type", notLayout.join(", "));
  const used = new Set();
  for (const src of [BUILDER_SRC, VERIFIER_SRC]) for (const m of src.matchAll(/figma\.([A-Za-z]+)\s*\(/g)) used.add(m[1]);
  const notCovered = [...used].filter((c) => SURFACE.figma.calls.indexOf(c) < 0);
  check(!notCovered.length, "the surface covers every figma call builder4 makes (" + [...used].sort().join(", ") + ")", notCovered.join(", "));
  const m1 = ["createVector", "createComponent", "createStar", "createPolygon", "createLine", "union", "subtract", "intersect", "exclude", "loadFontAsync", "listAvailableFontsAsync", "createImage", "getNodeByIdAsync"];
  check(m1.every((c) => SURFACE.figma.calls.indexOf(c) >= 0) && SURFACE.nodes.VECTOR.methods.indexOf("setVectorNetworkAsync") >= 0 && SURFACE.nodes.VECTOR.write.indexOf("vectorPaths") >= 0 &&
    SURFACE.nodes.VECTOR.read.fillGeometry && SURFACE.nodes.TEXT.methods.indexOf("setRangeFontName") >= 0 && SURFACE.nodes.FRAME.methods.indexOf("setSharedPluginData") >= 0 &&
    Object.isFrozen(SURFACE) && Object.isFrozen(SURFACE.nodes.FRAME.write), "the surface has M1's additions and is frozen");
  // Part E's probes: the window round trip (P4) and the image's bytes and size (P4, P8).
  const seen = [];
  const DU = makeDouble({ ui: (m) => seen.push(m) });
  DU.figma.ui.postMessage({ t: "probe", n: 1 });
  // A PNG header alone, w x h: 32 bytes, the size big-endian at bytes 16 and 20.
  const pngHeader = (w, h) => {
    const b = new Uint8Array(32), dv = new DataView(b.buffer);
    b.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); dv.setUint32(16, w); dv.setUint32(20, h);
    return b;
  };
  // 4 096 x 4 095 is P8 png4096, which Figma accepts (recorded 2026-10-05); the sides differ, so a swap shows.
  const im = DU.figma.createImage(pngHeader(4096, 4095));
  const size = await im.getSizeAsync(), back = await im.getBytesAsync();
  check(SURFACE.figma.read.indexOf("ui") >= 0 && SURFACE.ui.methods.indexOf("postMessage") >= 0 && SURFACE.image.methods.indexOf("getSizeAsync") >= 0 &&
    DU.ui.posted.length === 1 && seen.length === 1 && seen[0].n === 1 && size.width === 4096 && size.height === 4095 && back.length === 32 &&
    /outside the surface/.test(threw(() => { DU.figma.ui.onmessage = () => {}; })) && /outside the surface/.test(threw(() => im.getSomething)),
    "figma.ui.postMessage and the Image's hash, bytes and PNG size are in the surface and the double (part E's P4 and P8); onmessage stays the host's");
  // A side over 4 096 px is P8 png4097. Recorded throw (2026-10-05): the double refuses it and names the
  // case. Planted pending, the double follows its assumption (ok) and reads the size back from the header.
  const recorded = loadVerdicts(), pendingP8 = JSON.parse(JSON.stringify(recorded));
  pendingP8.probes.P8.status = "pending";
  for (const k of Object.keys(pendingP8.probes.P8.verdicts)) pendingP8.probes.P8.verdicts[k] = "pending";
  const DP = makeDouble({ verdicts: pendingP8 });
  const sizeP = await DP.figma.createImage(pngHeader(4096, 4097)).getSizeAsync();
  check(recorded.probes.P8.verdicts.png4097 === "throw" && /P8 png4097/.test(threw(() => makeDouble().figma.createImage(pngHeader(4096, 4097)))) &&
    DP.assumed.indexOf("P8.png4097") >= 0 && sizeP.width === 4096 && sizeP.height === 4097,
    "a 4 096 x 4 097 PNG follows P8 png4097: refused as recorded (throw); while the case is pending, taken by assumption with its size read back",
    JSON.stringify(sizeP));
}

// ============================================================================================
// 7. the judge's frozen shapes (a stub until part C)
// ============================================================================================
{
  check(judge.checkJShape(judge.emptyJ()).length === 0 && judge.checkJShape(judge.emptyTotals(), judge.TOTALS_SHAPE).length === 0,
    "emptyJ() and emptyTotals() have exactly the frozen shapes");
  const J = judge.emptyJ();
  delete J.sides.unproven; J.extra = 1; J.text.differ.push({ i: 1, guid: "1:2", irLines: 1, figmaLines: "2", widened: false, fontHeld: false, approx: false });
  const probs = judge.checkJShape(J);
  check(probs.some((p) => /sides\.unproven is missing/.test(p)) && probs.some((p) => /extra is not in the shape/.test(p)) && probs.some((p) => /text\.differ\[0\]\.figmaLines is not a number/.test(p)),
    "checkJShape names a missing key, an extra key and a list item of the wrong kind", probs.join("; "));
  check(judge.ROW.length === 11 && judge.ROW.lines === 10 && judge.VECTOR_DIFF_KINDS.length === 4, "a VERIFY row has eleven fields, lines last");
  if (judge.JUDGE_IMPLEMENTED === false) check(/not in this build; part C/.test(threw(() => judge.judgeTask({}))) && /not in this build; part C/.test(threw(() => judge.judgeRun([]))),
    "judgeTask and judgeRun refuse until part C lands");
}

// ============================================================================================
// 8. pathgeom: exact bounds (P0 wrote it, for part A's network-bounds class; part C owns it after)
// ============================================================================================
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const box = (b, x0, y0, x1, y1) => b && near(b.x0, x0) && near(b.y0, y0) && near(b.x1, x1) && near(b.y1, y1);
  check(pathgeom.PATHGEOM_IMPLEMENTED === true && box(pathgeom.pathBounds("M 0 0 L 10 0 L 10 5 Z")[0], 0, 0, 10, 5), "pathBounds bounds a polygon by its points");
  check(box(pathgeom.pathBounds("M0 0L10 0L10 5Z")[0], 0, 0, 10, 5) && box(pathgeom.pathBounds("M0 0L-1e1 5Z")[0], -10, 0, 0, 5),
    "pathBounds reads Figma's glued form (\"M0 0L10 0Z\", P19B 2026-10-05) and exponents");
  check((() => { try { pathgeom.pathBounds("M0 0X1 1"); return false; } catch (e) { return /cannot read/.test(e.message); } })(), "pathBounds refuses a character outside a path");
  // A quadratic from (0,0) to (10,0) through control (5,10) peaks at t = 1/2, y = 5 (the hull reaches 10).
  check(box(pathgeom.pathBounds("M 0 0 Q 5 10 10 0 Z")[0], 0, 0, 10, 5), "a quadratic's extremum, not its control point", JSON.stringify(pathgeom.pathBounds("M 0 0 Q 5 10 10 0 Z")));
  // The cubic (0,0) (0,10) (10,10) (10,0) peaks at t = 1/2, y = 7.5; the hull reaches 10.
  check(box(pathgeom.pathBounds("M 0 0 C 0 10 10 10 10 0")[0], 0, 0, 10, 7.5), "a cubic's extremum, not its control hull");
  // Its x bulges past the end points when the controls cross: x runs 0, 40, -30, 10, and reaches
  // about 12.84 at t = 0.239 and -2.83 at t = 0.761, inside the hull -30..40.
  const bulge = pathgeom.pathBounds("M 0 0 C 40 1 -30 1 10 0")[0];
  check(Math.abs(bulge.x1 - 12.84) < 0.01 && Math.abs(bulge.x0 + 2.835) < 0.01, "a cubic that bulges past its end points is bounded past them, inside the hull", JSON.stringify(bulge));
  const two = pathgeom.pathBounds("M 0 0 L 1 1 Z M 5 5 L 6 7 Z");
  check(two.length === 2 && box(two[1], 5, 5, 6, 7) && box(pathgeom.unionBounds(two), 0, 0, 6, 7) && pathgeom.unionBounds([]) === null && pathgeom.pathBounds("  ").length === 0,
    "one box per subpath, their union, null for no boxes, [] for an empty path");
  // A matrix maps the control points, so a rotated curve is bounded exactly: the quadratic above
  // turned 90 degrees and moved by (100, 0) spans x 95..100, y 0..10.
  check(box(pathgeom.pathBounds("M 0 0 Q 5 10 10 0", [[0, -1, 100], [1, 0, 0]])[0], 95, 0, 100, 10), "a matrix is applied before bounding",
    JSON.stringify(pathgeom.pathBounds("M 0 0 Q 5 10 10 0", [[0, -1, 100], [1, 0, 0]])));
  check(/^pathBounds: /.test(threw(() => pathgeom.pathBounds("M0,0 L10,0"))) && /^pathBounds: /.test(threw(() => pathgeom.pathBounds("L 0 0"))),
    "a string that is not a Figma path throws, naming pathBounds");
  const B = loadPluginBundle({ figma: makeDouble().figma });
  check(same(B.PXF_PATHGEOM.pathBounds("M 0 0 C 0 10 10 10 10 0 Z M 3 3 L 4 4"), pathgeom.pathBounds("M 0 0 C 0 10 10 10 10 0 Z M 3 3 L 4 4")), "the bundled PXF_PATHGEOM gives the same boxes");
}

// ============================================================================================
// 9. the runner's side of the seam
// ============================================================================================
check(checkPostOpts(undefined) === null && checkPostOpts({ liveness: { warnMs: 60000, failMs: 300000 }, ceilingMs: 140000, onProgress: () => {} }) === null &&
  /below failMs/.test(checkPostOpts({ liveness: { warnMs: 5, failMs: 5 } })) && /unknown option/.test(checkPostOpts({ heartbeat: 1 })) &&
  /function/.test(checkPostOpts({ onProgress: 1 })), "post()'s liveness options are checked for shape: { liveness: { warnMs, failMs }, ceilingMs, onProgress }");
check(schema.SETTING_DEFAULTS.booleans === "auto" && schema.SETTING_DEFAULTS.spaceEvenlySingle === "between" && schema.SETTING_DEFAULTS.textFit === "widen" &&
  taskMod.TASK_SETTING_DEFAULTS.layoutOrder === "creation" && taskMod.TASK_SETTING_DEFAULTS.textRead === "measure" && taskMod.TASK_SETTING_DEFAULTS.fallbackFont.family === "Inter",
  "every M1 setting has its stated default (docs/M1.md §3)");
check(validate({ header: { format: "pix2fig.ir", version: schema.VERSION } }).ok === false, "validate() is the IR check every caller uses");

console.log("");
console.log(failed ? failed + " M1 contract check" + (failed === 1 ? "" : "s") + " FAILED" : "all M1 contract checks pass");
process.exit(failed ? 1 : 0);

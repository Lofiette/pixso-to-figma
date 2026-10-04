// The plugin's fixed commands and the runner's door, checked with neither editor open.
//
//   node test-plugin.mjs
//
// Everything here is synthetic: a two-node tree made up below, rectangles named pxf-test-*, bytes
// from a fixed seed. Nothing is read from a real design file, and nothing leaves this machine — the
// only network is loopback, to job servers this script starts on free ports.
//
//   1. the generated plugin: dist/ holds no eval(, no Function( and no async-function constructor;
//      the key lands in dist/ui.html and nowhere else; both files carry the same build id; a builder
//      that does not compile is caught before anything is written; the manifest runs dist/.
//   2. the payload is data only: tools/pack4.mjs on a synthetic tree writes no B or V.
//   3. dist/code.js compiled with a stand-in for Figma: every command is dispatchable, an unknown kind
//      or operation is refused, nothing a payload carries is ever run.
//   4. the job server: 401 without the key on every route, 403 for any other Origin, 421 for any
//      other Host, 409 for a window of another plugin build, the preflight without a key, /pair once
//      and never after five wrong codes; a malformed request answered and survived; a port held on
//      [::1] alone refused like one held on 127.0.0.1.
//   5. the whole chain — runner, plugin window, plugin — with the real dist/ui.html wired to the
//      real dist/code.js: a build and its verify, the clean rule (tools/test-clean.mjs's own
//      scenario), a render, the probes, a window that has to ask for the pairing code, and a window
//      opened before the sources changed, which must be told to reopen instead of being paired.
//
// The stand-in for Figma implements only what these checks call, with plain geometry: no auto
// layout, no text, no SVG import. It proves the plumbing and the dispatch, not the builder's
// fidelity — that needs the real Figma and the baseline in docs/REWRITE.md §10, M0.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createContext, runInContext, Script } from "node:vm";
import { request, createServer } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { buildPlugin, generatePlugin, forbiddenIn, DIST_DIR } from "./build-plugin.mjs";
import { startJobServer, newSecrets, JOB_KINDS } from "./jobserver.mjs";
import { openSession, waitForPlugin } from "./session.mjs";
import { cleanScenario } from "./test-clean.mjs";
import { buildAll, verdict, staleBuildNote } from "./build-lib.mjs";
import { BUILDER_SRC } from "./builder4.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why ? " — " + why : "")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  throw new Error("timed out waiting for " + what);
}
const scratch = mkdtempSync(join(tmpdir(), "pxf-test-plugin-"));
// Nothing here may wait for ever. A check whose answer never comes — a job nobody takes, a request
// the server holds — fails the run after this long instead of hanging selftest with it.
setTimeout(() => {
  console.log("FAIL test-plugin did not finish within 180 s: something waited on an answer that never came");
  try { rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
  process.exit(1);
}, 180000).unref();

// ============================================================================================
// 1. the generated plugin
// ============================================================================================
const KEY = newSecrets().token;
const distKeyed = buildPlugin({ outDir: join(scratch, "dist-keyed"), token: KEY });
const distBare = buildPlugin({ outDir: join(scratch, "dist-bare"), token: "" });
const CODE = readFileSync(distKeyed.codePath, "utf8");
const UI_KEYED = readFileSync(distKeyed.uiPath, "utf8");
const UI_BARE = readFileSync(distBare.uiPath, "utf8");

// The rule, spelled out here independently of build-plugin.mjs's own guard, so a mistake in the guard
// cannot pass its own test.
for (const [name, text] of [["dist/code.js", CODE], ["dist/ui.html", UI_KEYED]]) {
  const hits = [];
  if (text.indexOf("eval(") >= 0) hits.push("eval(");
  if (text.indexOf("Function(") >= 0) hits.push("Function(");
  if (/AsyncFunction|getPrototypeOf\s*\(\s*async/.test(text)) hits.push("the async-function constructor");
  check(!hits.length, name + " contains no eval(, Function( or async-function constructor", hits.join(", "));
}
check(forbiddenIn("x = eval(y)").length && forbiddenIn("new Function('a')").length &&
  forbiddenIn("Object.getPrototypeOf(async function () {}).constructor").length && forbiddenIn("setTimeout('go()', 1)").length &&
  !forbiddenIn("function f() { return typeof g === 'function'; }").length,
  "the generator's own guard catches each forbidden form and passes ordinary code");
check(CODE.indexOf("async function PXF_BUILD(figma, PAY)") >= 0 && CODE.indexOf("async function PXF_VERIFY(figma, PAY, ROOT_NODE_ID)") >= 0,
  "the builder and the verifier are bundled as ordinary functions");
check(UI_KEYED.split(KEY).length === 2 && CODE.indexOf(KEY) < 0, "the run's key is written into dist/ui.html once, and into nothing else");
check(UI_BARE.indexOf('let TOKEN = "";') >= 0 && UI_BARE.indexOf("__PXF_TOKEN__") < 0, "without a key the window carries none, and asks for the code");
check(generatePlugin({ token: KEY }).version === distKeyed.version && distBare.version === distKeyed.version,
  "the same sources give the same build id, whatever the key");
check(CODE.indexOf("var PXF_VERSION = " + JSON.stringify(distKeyed.version) + ";") >= 0 &&
  UI_KEYED.indexOf("const PLUGIN = " + JSON.stringify(distKeyed.version) + ";") >= 0 && UI_KEYED.indexOf("__PXF_VERSION__") < 0,
  "dist/code.js and dist/ui.html carry the same build id");
const HOST_SRC = readFileSync(join(ROOT, "figma-plugin", "src", "code.js"), "utf8");
const UI_SRC = readFileSync(join(ROOT, "figma-plugin", "src", "ui.html"), "utf8");
{
  const vs = [generatePlugin({ sources: { host: HOST_SRC + "\n// edited\n" } }).version,
    generatePlugin({ sources: { builder: BUILDER_SRC + "\n// edited\n" } }).version,
    generatePlugin({ sources: { ui: UI_SRC.replace("<style>", "<style>\n/* edited */") } }).version];
  check(vs.every((v) => v !== distKeyed.version) && new Set(vs).size === 3, "an edit to the host, the builder or the window gives a new build id");
}
// A mistake in the builder used to be caught by pack4; it is now caught here, before dist/ is touched.
{
  const L = "\n";
  const b = BUILDER_SRC.split(L); b.splice(3, 0, "let = ;");
  const d = join(scratch, "dist-broken");
  let msg = "";
  try { buildPlugin({ outDir: d, sources: { builder: b.join(L) } }); } catch (e) { msg = e.message; }
  check(/dist\/code\.js does not compile/.test(msg) && /builder4\.js \(BUILDER_SRC\) line 4\b/.test(msg) && !existsSync(join(d, "code.js")) && !existsSync(join(d, "ui.html")),
    "a builder that does not compile is refused by the generator, named by its line, and nothing is written", msg);
  const uiLine = UI_SRC.slice(0, UI_SRC.indexOf("let busy = false")).split(L).length;
  let msg2 = "";
  try { generatePlugin({ sources: { ui: UI_SRC.replace("let busy = false", "let busy = = false") } }); } catch (e) { msg2 = e.message; }
  check(/dist\/ui\.html <script> does not compile/.test(msg2) && msg2.indexOf("figma-plugin/src/ui.html line " + uiLine + ")") >= 0,
    "a window script that does not compile is refused the same way, at its line in src/ui.html", msg2);
}
// The command line will not replace the plugin a live runner wrote, unless told to.
{
  const had = existsSync(DIST_DIR);
  const run = (args) => { try { execFileSync("node", [join(HERE, "build-plugin.mjs"), ...args], { stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  const s1 = run([]), s2 = run(["--out", DIST_DIR]);
  check(s1 === 2 && s2 === 2 && existsSync(DIST_DIR) === had, "build-plugin.mjs refuses to write figma-plugin/dist without --out and --force", s1 + "," + s2);
  // Nor will serve.mjs on a port the plugin cannot reach: it would only replace a live runner's key.
  const snap = () => ["code.js", "ui.html"].map((n) => { try { return readFileSync(join(DIST_DIR, n), "utf8"); } catch (e) { return "(none)"; } }).join("\n");
  const before = snap();
  let s3 = 0;
  try { execFileSync("node", [join(HERE, "serve.mjs"), "3779"], { stdio: "pipe", timeout: 20000 }); } catch (e) { s3 = e.status; }
  check(s3 === 2 && snap() === before, "serve.mjs refuses any port but 3778 and leaves figma-plugin/dist alone", String(s3));
}
try { generatePlugin({ token: "not-hex" }); fail("a malformed key was written into the plugin"); }
catch (e) { ok("a malformed key is refused"); }
const manifest = JSON.parse(readFileSync(join(ROOT, "figma-plugin", "manifest.json"), "utf8"));
check(manifest.main === "dist/code.js" && manifest.ui === "dist/ui.html", "the manifest runs the generated plugin");
check(!existsSync(join(ROOT, "figma-plugin", "code.js")) && !existsSync(join(ROOT, "figma-plugin", "ui.html")),
  "no stale hand-written plugin is left beside the manifest");

// A runner that cannot get its port must leave the plugin files as it found them: they hold the key
// of the runner that does have it.
{
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  const d = join(scratch, "dist-live");
  buildPlugin({ outDir: d, token: KEY });
  const before = readFileSync(join(d, "ui.html"), "utf8");
  let refusedPort = false;
  try { const s = await openSession({ port, distDir: d, log: () => {} }); s.close(); }
  catch (e) { refusedPort = /already taken/.test(e.message); }
  blocker.close();
  check(refusedPort && readFileSync(join(d, "ui.html"), "utf8") === before,
    "a runner that finds the port taken says so and puts the live runner's plugin files back");
}
// The same when only [::1] is taken. localhost usually resolves to ::1 first, so a runner that started
// on 127.0.0.1 alone would hand its key to whoever holds [::1] and wait for a plugin that never comes.
{
  const blocker6 = createServer(() => {});
  let port6 = 0;
  try { await new Promise((r, j) => { blocker6.once("error", j); blocker6.listen(0, "::1", r); }); port6 = blocker6.address().port; }
  catch (e) { /* no IPv6 loopback on this machine */ }
  if (!port6) console.log("skip the [::1]-only port check: this machine has no IPv6 loopback");
  else {
    const d = join(scratch, "dist-live6");
    buildPlugin({ outDir: d, token: KEY });
    const before = readFileSync(join(d, "ui.html"), "utf8");
    let code = "";
    try { const s = await openSession({ port: port6, distDir: d, log: () => {} }); s.close(); code = "started"; }
    catch (e) { code = e.code || e.message; }
    const v4free = await new Promise((r) => { const p = createServer(); p.once("error", () => r(false)); p.listen(port6, "127.0.0.1", () => p.close(() => r(true))); });
    blocker6.close();
    check(code === "PORT_TAKEN" && readFileSync(join(d, "ui.html"), "utf8") === before && v4free,
      "a port taken on [::1] only is taken too: PORT_TAKEN, the plugin files put back, and 127.0.0.1 released", code + ", 127.0.0.1 free afterwards: " + v4free);
  }
}

// tools/bootstrap.mjs used to run PAY.B and PAY.V; it now pastes the bundled sources in.
for (const mode of ["build", "verify"]) {
  try {
    const out = execFileSync("node", [join(HERE, "bootstrap.mjs"), mode, "0123abcd", "1:2"], { encoding: "utf8" });
    new Script("(async function (figma) {\n" + out + "\n})");
    check(out.indexOf("PAY.B") < 0 && out.indexOf("PAY.V") < 0 && !forbiddenIn(out).length,
      "bootstrap.mjs " + mode + " compiles and no longer reads code from the payload");
  } catch (e) { fail("bootstrap.mjs " + mode + ": " + String(e.message).slice(0, 160)); }
}

// ============================================================================================
// 2. the payload is data only
// ============================================================================================
// A synthetic object: a frame with a rectangle (carrying an image fill) and an ellipse.
const IMG_BYTES = Buffer.alloc(700000);
for (let i = 0, x = 12345; i < IMG_BYTES.length; i++) { x = (x * 1103515245 + 12345) >>> 0; IMG_BYTES[i] = x >>> 24; }
const IMG_HASH = createHash("sha1").update(IMG_BYTES).digest("hex");
const tree = { id: "9:1", name: "pxf synthetic frame", type: "FRAME", width: 200, height: 120,
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
  children: [
    { id: "9:2", name: "pxf synthetic rect", type: "RECTANGLE", width: 40, height: 30,
      fills: [{ type: "IMAGE", scaleMode: "FILL", imageHash: IMG_HASH, visible: true, opacity: 1, blendMode: "NORMAL" }] },
    { id: "9:3", name: "pxf synthetic ellipse", type: "ELLIPSE", width: 20, height: 20 },
  ] };
const packDir = join(scratch, "pack");
mkdirSync(packDir, { recursive: true });
writeFileSync(join(packDir, "ir.json"), JSON.stringify({ tree }));
writeFileSync(join(packDir, "svg.json"), JSON.stringify({ assets: {}, refs: {} }));
writeFileSync(join(packDir, "bounds.json"), "{}");
writeFileSync(join(packDir, "abs.json"), JSON.stringify({ "": [1, 0, 100, 0, 1, 50], "0": [1, 0, 110, 0, 1, 60], "1": [1, 0, 150, 0, 1, 90] }));
let PAYLOAD = null;
try {
  const env = Object.assign({}, process.env);
  for (const k of ["PX_PAINTSUB", "PX_IMAGEMAP", "PX_TEXTRUNS", "PX_PLACE_ABS"]) delete env[k];
  execFileSync("node", [join(HERE, "pack4.mjs"), join(packDir, "ir.json"), "9:1", join(packDir, "svg.json"),
    join(packDir, "bounds.json"), join(packDir, "abs.json"), join(packDir, "payload.png")], { env, stdio: "pipe", cwd: HERE });
  PAYLOAD = JSON.parse(readFileSync(join(packDir, "payload.json"), "utf8"));
  const keys = Object.keys(PAYLOAD).sort().join(",");
  check(keys === "D,F,R,S" && PAYLOAD.F.length === 3, "pack4 writes a data-only payload (keys " + keys + ", " + PAYLOAD.F.length + " nodes)");
} catch (e) { fail("pack4 on a synthetic tree: " + String(e.stderr || e.message).slice(0, 300)); }

// ============================================================================================
// 3. dist/code.js with a stand-in for Figma
// ============================================================================================
// Plain geometry only: a node is a relative transform and a size, an absolute transform is the
// product up to the page, and a bounding box is that transform applied to the four corners.
function makeFigma() {
  const reg = { seq: 0, byId: new Map(), exportBytes: 16 };
  const mul = (a, b) => [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]]];
  function node(type) {
    const n = {
      id: (type === "DOCUMENT" ? "0:0" : "1:" + (++reg.seq)), type, name: type, removed: false, parent: null,
      width: 100, height: 100, _rt: [[1, 0, 0], [0, 1, 0]], _pd: {},
      get x() { return this._rt[0][2]; }, set x(v) { this._rt[0][2] = v; },
      get y() { return this._rt[1][2]; }, set y(v) { this._rt[1][2] = v; },
      get relativeTransform() { return [this._rt[0].slice(), this._rt[1].slice()]; },
      set relativeTransform(m) { this._rt = [m[0].slice(), m[1].slice()]; },
      get absoluteTransform() {
        const p = this.parent;
        return !p || p.type === "PAGE" || p.type === "DOCUMENT" ? this.relativeTransform : mul(p.absoluteTransform, this._rt);
      },
      get absoluteBoundingBox() {
        const t = this.absoluteTransform;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [cx, cy] of [[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]]) {
          const px = t[0][0] * cx + t[0][1] * cy + t[0][2], py = t[1][0] * cx + t[1][1] * cy + t[1][2];
          x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
        }
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      },
      resize(w, h) { this.width = w; this.height = h; },
      resizeWithoutConstraints(w, h) { this.width = w; this.height = h; },
      setPluginData(k, v) { this._pd[k] = String(v); },
      getPluginData(k) { return this._pd[k] || ""; },
      remove() {
        if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); }
        this.parent = null; this.removed = true; reg.byId.delete(this.id);
      },
      exportAsync() { return Promise.resolve(new Uint8Array(reg.exportBytes)); },
    };
    if (type !== "RECTANGLE" && type !== "ELLIPSE") {
      n.children = [];
      n.appendChild = function (c) {
        if (c.parent) { const i = c.parent.children.indexOf(c); if (i >= 0) c.parent.children.splice(i, 1); }
        c.parent = this; this.children.push(c);
      };
    }
    reg.byId.set(n.id, n);
    return n;
  }
  const root = node("DOCUMENT");
  const page = node("PAGE"); page.name = "Page 1"; root.appendChild(page);
  const figma = {
    root, currentPage: page, ui: { postMessage() {}, onmessage: null }, _reg: reg, _node: node,
    showUI() {},
    createFrame: () => node("FRAME"), createRectangle: () => node("RECTANGLE"), createEllipse: () => node("ELLIPSE"),
    createSection: () => node("SECTION"),
    createPage() { const p = node("PAGE"); root.appendChild(p); return p; },
    createText() { throw new Error("the stand-in has no text"); },
    createNodeFromSvg() { throw new Error("the stand-in has no SVG import"); },
    createImage: (bytes) => ({ hash: createHash("sha1").update(Buffer.from(bytes)).digest("hex") }),
    base64Decode: (s) => new Uint8Array(Buffer.from(s, "base64")),
    base64Encode: (u8) => Buffer.from(u8).toString("base64"),
    getNodeByIdAsync: async (id) => reg.byId.get(id) || null,
    loadAllPagesAsync: async () => {},
    loadFontAsync: async () => {},
    setCurrentPageAsync: async (p) => { figma.currentPage = p; },
  };
  return figma;
}

// The host alone, fed messages the way the window feeds it, recording what it posts back. Probe
// questions are answered the way the window answers them.
function bareHost(opts) {
  const figma = makeFigma(), posted = [];
  figma.ui.postMessage = (m) => {
    posted.push(m);
    if (m.t === "probe-ping") setImmediate(() => figma.ui.onmessage({ t: "probe-answer", k: m.k }));
    if (m.t === "probe-big") setImmediate(() => figma.ui.onmessage({ t: "probe-answer", k: m.k, len: m.s.length }));
    if (m.t === "probe-big-up") setImmediate(() => figma.ui.onmessage({ t: "probe-answer", k: m.k, s: "x".repeat(m.size) }));
    if (m.t === "probe-echo") setImmediate(() => figma.ui.onmessage({ t: "probe-answer", k: m.k, status: 200, echo: "{}", origin: "null" }));
  };
  // Without `performance` the plugin falls back to Date.now, as it would in a sandbox that lacks it.
  const g = { figma, __html__: "", setTimeout, clearTimeout };
  if (!(opts && opts.noPerformance)) g.performance = performance;
  runInContext(CODE, createContext(g));
  let seq = 0;
  async function job(kind, payloadText, meta) {
    const id = "t" + (++seq), from = posted.length;
    await figma.ui.onmessage(Object.assign({ t: "payload-begin", id, kind, total: payloadText.length }, meta || {}));
    for (let o = 0; o < payloadText.length; o += 400000) await figma.ui.onmessage({ t: "payload-chunk", d: payloadText.slice(o, o + 400000) });
    await figma.ui.onmessage({ t: "payload-end" });
    const mine = posted.slice(from).filter((m) => m.id === id);
    const chunks = mine.filter((m) => m.t === "report-chunk");
    if (!mine.some((m) => m.t === "report-end")) throw new Error("no report for " + kind);
    return { report: JSON.parse(chunks.map((c) => c.d).join("")), slices: chunks.length };
  }
  return { figma, posted, job };
}

{
  const H = bareHost();
  check(H.posted.some((m) => m.t === "log" && String(m.m).indexOf(distKeyed.version) >= 0), "the plugin says which build it is when it starts");

  // Refusals: kinds outside the table, including the names every object inherits.
  for (const kind of ["script", "eval", "constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
    const { report } = await H.job(kind, "{}");
    check(report.refused && /unknown job kind/.test(report.error) && report.plugin === distKeyed.version,
      "job kind " + JSON.stringify(kind) + " is refused, and the refusal names the plugin build", JSON.stringify(report).slice(0, 120));
  }
  // The old free-form render job, and operations outside the table.
  {
    const { report } = await H.job("render", JSON.stringify({ V: "RESULT = { pwned: 1 };" }));
    check(report.refused && !report.pwned, "an old-style render job carrying code is refused, and its code never runs");
  }
  for (const op of ["script", "constructor", "__proto__"]) {
    const { report } = await H.job("render", JSON.stringify({ op }));
    check(report.refused, "render operation " + JSON.stringify(op) + " is refused");
  }
  {
    const { report } = await H.job("build", "this is not json");
    check(report.refused && /not JSON/.test(report.error), "a payload that is not JSON is refused");
  }
  {
    const { report } = await H.job("probe", JSON.stringify({ probes: ["P9"] }));
    check(report.refused, "an unknown probe is refused");
  }
  {
    const { report } = await H.job("render", JSON.stringify({ op: "export", id: "1:1", constraint: { type: "SCALE", value: 1e9 } }));
    check(report.refused, "an export with an out-of-range constraint is refused");
  }

  // Every command, dispatched.
  if (PAYLOAD) {
    // Code riding in an old payload is ignored: if it ran, the build would throw.
    const old = Object.assign({}, PAYLOAD, { B: "throw new Error('payload code ran');", V: "throw new Error('payload code ran');" });
    const b = await H.job("build", JSON.stringify(old));
    const r = b.report;
    const root = H.figma._reg.byId.get(r.rootId);
    check(!r.error && r.nodes === 3 && root && root.getPluginData("pxSrc") === "9:1" && root.children.length === 2,
      "build runs the bundled builder (3 nodes, root stamped with its source)", JSON.stringify(r).slice(0, 200));
    check(r.plugin === distKeyed.version, "the build report names the plugin build that made it");
    check(H.posted.some((m) => m.t === "log" && /older packer; it is ignored/.test(m.m)), "builder code riding in an old payload is ignored, and said to be");
    const v = (await H.job("verify", JSON.stringify(PAYLOAD), { rootNodeId: r.rootId })).report;
    check(!v.error && v.count === 3 && v.expected === 3 && (v.visibleOver1 || 0) === 0 && (v.sizeOver || 0) === 0 && v.plugin === distKeyed.version,
      "verify runs the bundled verifier (3 of 3 nodes, none out of position) and names the plugin build", JSON.stringify(v).slice(0, 200));
    const vr = (await H.job("verify", JSON.stringify(PAYLOAD), { rootNodeId: "1:99999" })).report;
    check(vr.rootRelocated && vr.rootUsed === r.rootId, "verify finds the root by its stamp when the id is wrong");

    // The provisional build of a second pass is removed only when it proves to be one.
    const r2 = (await H.job("build", JSON.stringify(PAYLOAD), { cleanupRootId: r.rootId })).report;
    check(!r2.error && H.figma._reg.byId.get(r.rootId) === undefined && H.figma._reg.byId.get(r2.rootId),
      "a second pass removes the provisional root it replaces");
    const stranger = H.figma.createFrame(); H.figma.currentPage.appendChild(stranger); stranger.setPluginData("pxSrc", "someone-else");
    const r3 = (await H.job("build", JSON.stringify(PAYLOAD), { cleanupRootId: stranger.id })).report;
    check(!r3.error && H.figma._reg.byId.get(stranger.id) === stranger, "a cleanup id that names another object's root is not removed");

    // Payload slices: a payload over 400 000 characters arrives in several and is joined.
    const big = Object.assign({}, PAYLOAD, { S: PAYLOAD.S.concat(["<svg>" + "x".repeat(900000) + "</svg>"]) });
    const rb = (await H.job("build", JSON.stringify(big))).report;
    check(!rb.error && rb.nodes === 3, "a payload of " + JSON.stringify(big).length + " characters is joined from its slices");
  }

  // CLEAN only removes top-level objects of a page, whatever id it is handed.
  {
    const f = H.figma.createFrame(); H.figma.currentPage.appendChild(f);
    const inner = H.figma.createRectangle(); f.appendChild(inner);
    const c = (await H.job("clean", JSON.stringify({ want: [{ src: null, id: inner.id }, { src: null, id: H.figma.currentPage.id }, { src: null, id: "0:0" }] }))).report;
    check(c.removed === 0 && c.notTopLevel === 3 && c.spared === 0 && !inner.removed && H.figma.root.children.length >= 1,
      "clean leaves a layer inside a frame, a page and the document named by id, and counts them apart from spared", JSON.stringify(c));
    const bad = (await H.job("clean", JSON.stringify({ want: [{ src: { evil: 1 } }] }))).report;
    check(bad.refused, "clean refuses an entry that is not a short string");
  }

  // The clean rule, through tools/test-clean.mjs's own scenario.
  {
    const lines = [];
    let bad = 0;
    try { bad = await cleanScenario(async (jobDesc, payload) => (await H.job(jobDesc.kind, payload)).report, (l) => lines.push(l)); }
    catch (e) { bad = 1; lines.push("FAIL " + e.message); }
    check(bad === 0, "tools/test-clean.mjs's scenario passes through CLEAN and RENDER (" + lines.filter((l) => l.startsWith("ok")).length + " checks)",
      lines.filter((l) => l.startsWith("FAIL")).join("; "));
  }

  // RENDER export: a report over 400 000 characters goes back in slices.
  {
    H.figma._reg.exportBytes = 500000;
    const n = H.figma.createRectangle(); H.figma.currentPage.appendChild(n); n.resize(10, 20);
    const { report, slices } = await H.job("render", JSON.stringify({ op: "export", id: n.id, constraint: { type: "WIDTH", value: 10 } }));
    check(report.bytes === 500000 && Buffer.from(report.d, "base64").length === 500000 && report.w === 10 && report.h === 20 && slices >= 2,
      "render export photographs the node and its report comes back in " + slices + " slices");
    const gone = (await H.job("render", JSON.stringify({ op: "export", id: "1:424242", constraint: { type: "SCALE", value: 1 } }))).report;
    check(gone.e === "not found", "render export says when there is nothing to photograph");
    const ping = (await H.job("render", JSON.stringify({ op: "ping" }))).report;
    check(ping.ok === 1 && ping.plugin === distKeyed.version, "render ping answers with the plugin build");
  }

  // RENDER export proves the node before photographing it (STATE.md: stamps, not remembered ids).
  {
    H.figma._reg.exportBytes = 16;
    const rect = (w, h, stamp) => {
      const n = H.figma.createRectangle(); H.figma.currentPage.appendChild(n); n.resize(w, h);
      if (stamp) n.setPluginData("pxSrc", stamp);
      return n;
    };
    const olderA = rect(7, 8, "pxf-src-A"), A = rect(11, 12, "pxf-src-A"), B = rect(33, 34, "pxf-src-B"), C = rect(5, 6, "");
    const ex = async (id, src) => (await H.job("render", JSON.stringify({ op: "export", id, src, constraint: { type: "SCALE", value: 1 } }))).report;
    const e1 = await ex(B.id, "pxf-src-A");
    check(e1.relocated === A.id && e1.w === 11 && e1.h === 12,
      "export: an id naming another object's root is not photographed — the newest root carrying the stamp is, and the move is reported", JSON.stringify(e1).slice(0, 160));
    const e2 = await ex("1:999999", "pxf-src-A");
    check(e2.relocated === A.id && e2.w === 11, "export: an id that is gone is found again by its stamp", JSON.stringify(e2).slice(0, 160));
    const e3 = await ex(A.id, "pxf-src-A");
    check(e3.relocated === null && e3.w === 11 && !e3.e, "export: the right id is photographed as asked, nothing relocated");
    const e4 = await ex(B.id, "pxf-src-none");
    check(e4.e && !e4.d, "export: an id naming another object's root, with nothing carrying the stamp, is refused rather than photographed", JSON.stringify(e4).slice(0, 160));
    const e5 = await ex(C.id, "pxf-src-C");
    check(!e5.e && e5.w === 5 && e5.relocated === null, "export: an unstamped node (a build from before stamping) is photographed by its id");
    for (const n of [olderA, A, B, C]) n.remove();
  }

  // PROBE, with the window's answers simulated.
  {
    const p = (await H.job("probe", JSON.stringify({ n: 5, sizesMB: [0.01, 0.5], deadlineMs: 2000 }))).report;
    const p2 = p.probes && p.probes.P2, p3 = p.probes && p.probes.P3;
    check(p.probes && p.probes.P1 && p.probes.P1.status === 200 && p2 &&
      ["setTimeout0", "getNodeByIdAsync", "uiRoundTrip", "resolvedPromise"].every((k) => p2[k] && p2[k].n === 5 && typeof p2[k].median === "number") &&
      p3 && p3.largestDownMB === 0.5 && p3.largestUpMB === 0.5,
      "probe runs P1, P2 (four series of min/median/p95/max) and P3 (both directions)", JSON.stringify(p).slice(0, 200));
    check(p2 && p2.clock === "performance.now" &&
      ["setTimeout0", "getNodeByIdAsync", "uiRoundTrip", "resolvedPromise"].every((k) => typeof p2[k].mean === "number" && typeof p2[k].totalMs === "number" &&
        p2[k].batch && p2[k].batch.steps >= 1 && typeof p2[k].batch.mean === "number"),
      "P2 also times each whole series (mean) and a back-to-back batch", JSON.stringify(p2 && p2.resolvedPromise));
  }
}

// P2 where the sandbox has no performance.now: a millisecond clock, on which a step of microseconds
// reads 0 one at a time. The batch has to give a mean anyway.
{
  const H2 = bareHost({ noPerformance: true });
  const p2 = (await H2.job("probe", JSON.stringify({ probes: ["P2"], n: 5, deadlineMs: 2000 }))).report.probes.P2;
  const rp = p2 && p2.resolvedPromise;
  check(p2 && p2.clock === "Date.now" && rp && rp.batch.steps > 100 && rp.batch.ms >= 1 && rp.batch.mean > 0,
    "on Date.now, P2's batch still gives a mean above zero for a step of microseconds (" + (rp && rp.batch.steps) + " steps)", JSON.stringify(rp));
}

// What tools/build-lib.mjs says about the reports. A fake runner, so nothing is built: the point is
// the sentences, which are all the person running it sees.
{
  const d = join(scratch, "obj-1");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "payload.json"), JSON.stringify(PAYLOAD || { D: [], S: [], F: [] }));
  writeFileSync(join(d, "payload-meta.json"), JSON.stringify({ rootId: "9:1" }));
  writeFileSync(join(d, "build-report.json"), JSON.stringify({ rootId: "1:5" }));
  const OURS = "aaaaaaaaaaaa", OTHER = "bbbbbbbbbbbb";
  const fake = { pluginVersion: OURS, post: async (job) =>
    job.kind === "clean" ? { removed: 1, of: 1, spared: 2, notTopLevel: 1, plugin: OURS }
    : job.kind === "build" ? { rootId: "1:9", nodes: 3, plugin: OTHER }
    : { count: 3, expected: 3, plugin: OURS } };
  const lines = [];
  try { await buildAll({ srv: fake, dirs: [d], pages: null, clean: true, say: (l) => lines.push(l) }); }
  catch (e) { lines.push("threw " + e.message); }
  check(lines.some((l) => l.indexOf("WARNING: this build came from plugin build " + OTHER + ", not " + OURS) >= 0) &&
    !lines.some((l) => /WARNING: this (verify|clean)/.test(l)),
    "build-lib warns when a report comes from another plugin build than the runner wrote, and only then", lines.join(" | ").slice(0, 300));
  check(lines.some((l) => /2 ids now belonged to something else and were left alone/.test(l)) &&
    lines.some((l) => /1 named id is no longer at the top of a page and was left alone/.test(l)),
    "build-lib says apart which ids clean spared and which are no longer at the top of a page", lines.join(" | ").slice(0, 300));
}

// Two ways a run used to end on PASS with nothing proved: a verify that measured nothing, and text the
// second pass could not render. And a report the window made, which names no build, is not a mismatch.
{
  const OURS = "aaaaaaaaaaaa";
  const obj = (name, files) => {
    const d = join(scratch, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "payload.json"), JSON.stringify(PAYLOAD || { D: [], S: [], F: [] }));
    writeFileSync(join(d, "payload-meta.json"), JSON.stringify({ rootId: "9:1" }));
    for (const k of Object.keys(files || {})) writeFileSync(join(d, k), files[k]);
    return d;
  };
  const run = async (dir, post) => {
    const lines = [];
    let results = [], v = {};
    try {
      results = await buildAll({ srv: { pluginVersion: OURS, post }, dirs: [dir], pages: null, clean: false, say: (l) => lines.push(l) });
      v = verdict(results, (l) => lines.push(l));
    } catch (e) { lines.push("threw " + e.message); }
    return { lines, results, v, text: lines.join(" | ").slice(0, 400) };
  };

  // The shape the bundled verifier answers with for a root nobody carries any more, and a report with
  // no counts at all.
  for (const [label, answer] of [["an error", { error: "root 9:9 not found even after loading every page", refused: true, plugin: OURS }],
    ["no node counts", { plugin: OURS }]]) {
    const r = await run(obj("obj-verify-" + label.replace(/ /g, "-")), async (job) =>
      job.kind === "build" ? { rootId: "1:9", nodes: 3, plugin: OURS } : answer);
    check(r.results.length === 1 && /^verify: /.test(r.results[0].error || "") && r.v.errored === 1 && r.v.exact === 0 && r.v.clean === false &&
      r.lines[r.lines.length - 1] === "NOT CLEAN" && !r.lines.some((l) => /undefined/.test(l)),
      "a verify that answers with " + label + " is a failed object, not an exact one, and the run is NOT CLEAN", r.text);
  }

  // ir.json without a tree makes px-lostpaths.mjs fail: a second pass that dies in a child process
  // with the cause on its stderr, with neither Pixso nor the network involved. The verify is exact.
  const d2 = obj("obj-text-lost", { "ir.json": JSON.stringify({ meta: { rootId: "9:1" } }) });
  const r2 = await run(d2, async (job) => job.kind === "build"
    ? { rootId: "1:9", nodes: 3, plugin: OURS, textOverrideLost: [{ i: 1, name: "t", inked: 40, drew: 20 }], fontSubs: ["Synthetic Sans|Regular"] }
    : { count: 3, expected: 3, plugin: OURS });
  const log2 = existsSync(join(d2, "second-pass-error.log")) ? readFileSync(join(d2, "second-pass-error.log"), "utf8") : "";
  check(r2.v.clean === false && r2.v.wrong === 1 && r2.v.heldByFonts === 0 && r2.results[0] && r2.results[0].textLost === 1 &&
    r2.lines.some((l) => /second pass failed: TypeError: Cannot read properties/.test(l)) &&
    r2.lines.some((l) => /1 undisclosed text override\(s\) not rendered: TypeError/.test(l)) && /px-lostpaths\.mjs/.test(log2),
    "text the second pass could not render keeps the run from PASS (fonts or not), with the cause on the console and the whole error in second-pass-error.log", r2.text);

  // The window's own error reports carry its build; one that names none is not called a mismatch.
  const windowReports = (UI_SRC.match(/post\("\/report", \{[^\n]*error: [^\n]*plugin: PLUGIN/g) || []).length;
  check(staleBuildNote({ pluginVersion: OURS }, { error: "no report from the plugin sandbox within 8 minutes" }, "build") === null &&
    /^WARNING/.test(staleBuildNote({ pluginVersion: OURS }, { rootId: "1:9" }, "build") || "") && windowReports === 2,
    "an error report that names no build is not called a mismatch, and both error reports the window makes name its build",
    "window reports naming the build: " + windowReports);
}

// ============================================================================================
// 4. the job server's door
// ============================================================================================
function hreq(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
{
  const said = [];
  const sec = newSecrets();
  const VER = distKeyed.version;
  const srv = startJobServer(0, Object.assign({ log: (m) => said.push(m), pluginVersion: VER }, sec));
  await srv.ready;
  const P = srv.port;
  const good = { Origin: "null", Authorization: "Bearer " + sec.token, "X-PXF-Plugin": VER };
  const routes = [["GET", "/job?client=plugin"], ["GET", "/job/j1/payload"], ["GET", "/image/" + "ab".repeat(20) + "?b64=1"],
    ["POST", "/report"], ["GET", "/control?rev=0"], ["POST", "/start"], ["POST", "/alive"], ["GET", "/echo"]];

  const noKey = [], wrongKey = [], nearKey = [], otherBuild = [];
  // Keys that are nearly right: none at all after the scheme, the first half, the key and one more
  // character. A comparison that only checked a prefix would let the first two through.
  const near = ["Bearer ", "Bearer " + sec.token.slice(0, 32), "Bearer " + sec.token + "0", "Bearer " + sec.token.slice(0, 63)];
  for (const [m, p] of routes) {
    const body = m === "POST" ? "{}" : null;
    const r = await hreq(P, m, p, { Origin: "null", "Content-Type": "application/json", "X-PXF-Plugin": VER }, body);
    if (r.status !== 401 || r.headers["access-control-allow-origin"] !== "null") noKey.push(m + " " + p + " -> " + r.status);
    const w = await hreq(P, m, p, { Origin: "null", Authorization: "Bearer " + "f".repeat(64), "X-PXF-Plugin": VER }, body);
    if (w.status !== 401) wrongKey.push(m + " " + p + " -> " + w.status);
    for (const a of near) {
      const n = await hreq(P, m, p, { Origin: "null", Authorization: a, "X-PXF-Plugin": VER }, body);
      if (n.status !== 401) nearKey.push(m + " " + p + " [" + a.length + " chars] -> " + n.status);
    }
    // The right key from a window of another build, or one that names none: 409, readable by it.
    for (const v of ["0123456789ab", null]) {
      const h = Object.assign({}, good); if (v) h["X-PXF-Plugin"] = v; else delete h["X-PXF-Plugin"];
      const o = await hreq(P, m, p, h, body);
      let ob = {}; try { ob = JSON.parse(o.body); } catch (e) {}
      if (o.status !== 409 || o.headers["access-control-allow-origin"] !== "null" || ob.reopen !== true) otherBuild.push(m + " " + p + " (" + v + ") -> " + o.status);
    }
  }
  check(!noKey.length, "no key: 401 on every route (" + routes.map((r) => r[1].split("?")[0].replace(/[0-9a-f]{40}$/, ":hash").replace("/j1/", "/:id/")).join(", ") + "), readable by the window", noKey.join("; "));
  check(!wrongKey.length, "a wrong key: 401 on every route", wrongKey.join("; "));
  check(!nearKey.length, "an empty, half, one-short or one-long key: 401 on every route", nearKey.join("; "));
  check(!otherBuild.length, "the right key from a window of another plugin build, or one naming none: 409 on every route, readable by the window", otherBuild.join("; "));
  check(said.some((l) => /refused 409/.test(l) && /open it again/.test(l) && l.indexOf("runner " + VER) >= 0),
    "a 409 says on the runner's console that the plugin must be closed and reopened");

  const evil = await hreq(P, "GET", "/control?rev=0", { Origin: "https://evil.example", Authorization: good.Authorization });
  const none = await hreq(P, "GET", "/control?rev=0", { Authorization: good.Authorization });
  const evilPre = await hreq(P, "OPTIONS", "/job", { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" });
  check(evil.status === 403 && !evil.headers["access-control-allow-origin"] && none.status === 403 && evilPre.status === 403,
    "any Origin but \"null\" gets 403 — with the key, without an Origin, and on the preflight");
  check(said.some((l) => /refused 403/.test(l) && l.indexOf('Origin "https://evil.example"') >= 0) && said.some((l) => /Origin \(none\)/.test(l)),
    "every refusal logs the Origin it saw");

  const badHosts = [];
  for (const h of ["evil.example:" + P, "localhost:" + (P === 1 ? 2 : 1), "127.0.0.1", "localhost.evil.example:" + P]) {
    const r = await hreq(P, "GET", "/control?rev=0", Object.assign({ Host: h }, good));
    if (r.status !== 421) badHosts.push(h + " -> " + r.status);
  }
  check(!badHosts.length, "any Host but localhost/127.0.0.1/[::1] on this port gets 421", badHosts.join("; "));
  const hostsOk = [];
  for (const h of ["localhost:" + P, "127.0.0.1:" + P, "[::1]:" + P]) {
    const r = await hreq(P, "GET", "/control?rev=0", Object.assign({ Host: h }, good));
    hostsOk.push(r.status);
  }
  check(hostsOk.every((s) => s === 200), "localhost, 127.0.0.1 and [::1] on this port are accepted", hostsOk.join(","));

  const pre = await hreq(P, "OPTIONS", "/job?client=plugin", { Origin: "null", "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "authorization", "Access-Control-Request-Private-Network": "true" });
  check(pre.status === 204 && pre.headers["access-control-allow-origin"] === "null" && /authorization/i.test(pre.headers["access-control-allow-headers"] || "") &&
    /x-pxf-plugin/i.test(pre.headers["access-control-allow-headers"] || "") && pre.headers["access-control-allow-private-network"] === "true",
    "the preflight passes without a key or a build id, allows the Authorization and X-PXF-Plugin headers and answers a private-network check");

  const ctl = await hreq(P, "GET", "/control?rev=0", good);
  const echo = await hreq(P, "GET", "/echo", good);
  let echoed = {};
  try { echoed = JSON.parse(echo.body); } catch (e) {}
  check(ctl.status === 200 && JSON.parse(ctl.body).rev >= 1 && echo.status === 200 && echoed.headers && echoed.headers.origin === "null" &&
    echo.body.indexOf(sec.token) < 0, "with the key it answers, and /echo shows the Origin without echoing the key");

  // /pair from a window of another build: 409 before the code is even looked at — no key, and no try
  // spent (the wrong code below is then still the first of five).
  const pairHdr = { Origin: "null", "Content-Type": "application/json", "X-PXF-Plugin": VER };
  const p0 = await hreq(P, "POST", "/pair", Object.assign({}, pairHdr, { "X-PXF-Plugin": "0123456789ab" }), JSON.stringify({ code: sec.pairCode }));
  check(p0.status === 409 && p0.body.indexOf(sec.token) < 0 && !srv.paired, "/pair from a window of another build: 409, and the right code gives it no key");
  // /pair: the right code once, never twice.
  const wrongCode = String((Number(sec.pairCode) + 1) % 1000000).padStart(6, "0");
  const p1 = await hreq(P, "POST", "/pair", pairHdr, JSON.stringify({ code: wrongCode }));
  const p2 = await hreq(P, "POST", "/pair", pairHdr, JSON.stringify({ code: sec.pairCode }));
  const p3 = await hreq(P, "POST", "/pair", pairHdr, JSON.stringify({ code: sec.pairCode }));
  let got = {}; try { got = JSON.parse(p2.body); } catch (e) {}
  check(p1.status === 403 && JSON.parse(p1.body).left === 4 && p2.status === 200 && got.token === sec.token && p3.status === 410,
    "/pair trades the right code for the key once, and refuses it after", [p1.status, p2.status, p3.status].join(","));
  const pEvil = await hreq(P, "POST", "/pair", { Origin: "https://evil.example" }, JSON.stringify({ code: sec.pairCode }));
  check(pEvil.status === 403 && pEvil.body.indexOf(sec.token) < 0, "/pair from another Origin gets 403 and no key");

  // Nothing a request carries ends the runner. A request target that is not a URL used to throw before
  // any check, and a report of `null` after the key; both outside any catch, so the process died.
  const raw = await new Promise((resolve) => {
    const s = connect(P, "127.0.0.1", () => s.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:" + P + "\r\nConnection: close\r\n\r\n"));
    let got = "";
    s.on("data", (c) => { got += c; });
    s.on("end", () => resolve(got));
    s.on("error", (e) => resolve("socket error " + e.message));
  });
  const nullReport = await hreq(P, "POST", "/report", Object.assign({ "Content-Type": "application/json" }, good), "null");
  const still = await hreq(P, "GET", "/control?rev=0", good);
  check(/^HTTP\/1\.1 400/.test(raw) && nullReport.status === 200 && still.status === 200,
    "a request target that is not a URL gets 400, a report of null is ignored, and the runner still answers",
    raw.split("\r\n")[0] + ", " + nullReport.status + ", " + still.status);

  // Unknown kinds never reach the queue. A short deadline, so that a runner which queued it anyway
  // fails this check in two seconds rather than holding the test for the default twenty minutes.
  let rejected = false;
  try { await srv.post({ kind: "script" }, "{}", new Map(), 2000); } catch (e) { rejected = /unknown job kind/.test(e.message); }
  check(rejected && JOB_KINDS.join(",") === "build,verify,clean,render,probe", "the runner refuses to queue a kind outside build, verify, clean, render, probe");
  srv.close();

  // Five wrong codes, and then not even the right one.
  const sec2 = newSecrets();
  const srv2 = startJobServer(0, Object.assign({ log: () => {} }, sec2));
  await srv2.ready;
  const statuses = [];
  const wrong2 = String((Number(sec2.pairCode) + 7) % 1000000).padStart(6, "0");
  for (let i = 0; i < 5; i++) statuses.push((await hreq(srv2.port, "POST", "/pair", { Origin: "null" }, JSON.stringify({ code: wrong2 }))).status);
  const last = await hreq(srv2.port, "POST", "/pair", { Origin: "null" }, JSON.stringify({ code: sec2.pairCode }));
  check(statuses.every((s) => s === 403) && last.status === 429 && last.body.indexOf(sec2.token) < 0,
    "/pair refuses even the right code after five wrong ones", statuses.concat([last.status]).join(","));
  srv2.close();

  // PX_ALLOW_ORIGIN lets one more Origin through, for diagnostics, still with the key.
  process.env.PX_ALLOW_ORIGIN = "https://diagnostics.example";
  const srv3 = startJobServer(0, { log: () => {} });
  await srv3.ready;
  const d1 = await hreq(srv3.port, "GET", "/control?rev=0", { Origin: "https://diagnostics.example", Authorization: "Bearer " + srv3.token });
  const d2 = await hreq(srv3.port, "GET", "/control?rev=0", { Origin: "https://diagnostics.example" });
  delete process.env.PX_ALLOW_ORIGIN;
  check(d1.status === 200 && d1.headers["access-control-allow-origin"] === "https://diagnostics.example" && d2.status === 401,
    "PX_ALLOW_ORIGIN admits one more Origin, and still demands the key");
  srv3.close();
}

// Tools that post at once first wait for a window holding this session's key (tools/session.mjs). A
// window still holding the last key is answered 401 and does not count; one with this key does.
{
  const sec = newSecrets();
  const srv = startJobServer(0, Object.assign({ log: () => {} }, sec));
  await srv.ready;
  const stale = await hreq(srv.port, "GET", "/job?client=plugin", { Origin: "null", Authorization: "Bearer " + "e".repeat(64) });
  let gaveUp = "";
  try { await waitForPlugin(srv, 700, () => {}); } catch (e) { gaveUp = e.message; }
  const waiting = waitForPlugin(srv, 5000, () => {});
  const alive = await hreq(srv.port, "POST", "/alive", { Origin: "null", Authorization: "Bearer " + sec.token, "Content-Type": "application/json" }, "{}");
  let waited = -1;
  try { waited = await waiting; } catch (e) { gaveUp += " / then: " + e.message; }
  srv.close();
  check(stale.status === 401 && /^no plugin window after/.test(gaveUp) && alive.status === 200 && waited >= 0,
    "waitForPlugin gives up on a window with the last key, and returns once one with this session's key is heard",
    [stale.status, gaveUp, alive.status, waited].join(", "));
}

// ============================================================================================
// 5. the whole chain: runner -> window (dist/ui.html) -> plugin (dist/code.js) -> back
// ============================================================================================
// The window runs in its own context, as in Figma. Its fetch goes to the test server's port and
// carries Origin "null", as a sandboxed frame's does; its postMessage reaches the plugin, and the
// plugin's reaches it, each through a structured clone on a later turn.
function wire(uiHtml, port, code) {
  const figma = makeFigma();
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, textContent: "", className: "", hidden: ["pairrow", "scoperow", "go"].indexOf(id) >= 0,
    disabled: false, onclick: null, onkeydown: null, value: id === "scope" ? "file" : "", style: {} });
  let closed = false, fetches = 0;
  const winFetch = (url, o) => {
    if (closed) return Promise.reject(new TypeError("window closed"));
    fetches++;
    const u = new URL(String(url));
    const oo = Object.assign({}, o || {});
    oo.headers = Object.assign({ Origin: "null" }, oo.headers || {});
    return fetch("http://127.0.0.1:" + port + u.pathname + u.search, oo);
  };
  const a = uiHtml.indexOf("<script>"), b = uiHtml.lastIndexOf("</script>");
  const win = createContext({
    fetch: winFetch, document: { getElementById: el },
    parent: { postMessage: (m) => { const c = structuredClone(m.pluginMessage); setImmediate(() => { if (!closed) figma.ui.onmessage(c); }); } },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Promise, JSON, URL, console,
  });
  figma.ui.postMessage = (m) => { const c = structuredClone(m); setImmediate(() => { if (!closed && win.onmessage) win.onmessage({ data: { pluginMessage: c } }); }); };
  runInContext(uiHtml.slice(a + 8, b), win);
  runInContext(code || CODE, createContext({ figma, __html__: "", setTimeout, clearTimeout, performance }));
  return { figma, el, fetches: () => fetches, close() { closed = true; } };
}

{
  const sec = newSecrets();
  const chainDist = buildPlugin({ outDir: join(scratch, "dist-chain"), token: sec.token });
  const srv = startJobServer(0, Object.assign({ log: () => {}, pluginVersion: chainDist.version }, sec));
  await srv.ready;
  const W = wire(readFileSync(chainDist.uiPath, "utf8"), srv.port);
  try {
    await until(() => srv.lastPoll() > 0, 5000, "the window to ask for work");
    ok("a window carrying the run's key reaches the runner without being asked for a code");

    if (PAYLOAD) {
      const images = new Map([[IMG_HASH, IMG_BYTES]]);
      const r = await srv.post({ kind: "build", page: "pxf synthetic page" }, JSON.stringify(PAYLOAD), images, 30000);
      const pg = W.figma.root.children.find((p) => p.name === "pxf synthetic page");
      check(!r.error && r.nodes === 3 && pg && pg.children.some((n) => n.id === r.rootId),
        "build travels runner -> window -> plugin and back, on the page it names", JSON.stringify(r).slice(0, 200));
      check(r.imageRemapped === 0 && W.el("l").textContent.indexOf("1 new images of 1") >= 0,
        "a " + IMG_BYTES.length + "-byte image crosses as base64 slices and keeps its hash");
      const v = await srv.post({ kind: "verify", rootNodeId: r.rootId, page: "pxf synthetic page" }, JSON.stringify(PAYLOAD), new Map(), 30000);
      check(!v.error && v.count === 3 && v.expected === 3 && (v.visibleOver1 || 0) === 0, "verify travels the same way and measures 3 of 3 exact");
    }

    const lines = [];
    let bad = 0;
    try { bad = await cleanScenario((job, payload) => srv.post(job, payload, new Map(), 30000), (l) => lines.push(l)); }
    catch (e) { bad = 1; lines.push("FAIL " + e.message); }
    check(bad === 0, "tools/test-clean.mjs's scenario passes over the real transport", lines.filter((l) => l.startsWith("FAIL")).join("; "));

    W.figma._reg.exportBytes = 600000;
    const n = W.figma.createRectangle(); W.figma.currentPage.appendChild(n);
    const ex = await srv.post({ kind: "render" }, JSON.stringify({ op: "export", id: n.id, constraint: { type: "SCALE", value: 1 } }), new Map(), 30000);
    check(ex.bytes === 600000 && Buffer.from(ex.d || "", "base64").length === 600000,
      "a render report of " + (ex.d || "").length + " characters reaches the runner whole, through sliced posts");

    const p = await srv.post({ kind: "probe" }, JSON.stringify({ n: 5, sizesMB: [0.01, 0.5], deadlineMs: 5000, label: "test" }), new Map(), 60000);
    let seen = {};
    try { seen = JSON.parse(p.probes.P1.echo); } catch (e) {}
    check(p.probes && p.probes.P1.status === 200 && seen.headers && seen.headers.origin === "null" &&
      p.probes.P2.uiRoundTrip.n === 5 && p.probes.P3.largestUpMB === 0.5 && p.probes.P3.largestDownMB === 0.5,
      "probe travels the whole chain: P1 reads the window's Origin off /echo, P2 times a real round trip, P3 crosses both ways",
      JSON.stringify(p).slice(0, 240));
  } catch (e) { fail("the chain: " + e.message); }
  W.close();
  srv.close();
}

// A window opened before the runner started: it holds no key (or an old one), is told 401, asks for
// the code, takes a wrong one gracefully, and works once given the right one.
{
  const sec = newSecrets();
  const srv = startJobServer(0, Object.assign({ log: () => {}, pluginVersion: distBare.version }, sec));
  await srv.ready;
  const W = wire(UI_BARE, srv.port);
  try {
    await until(() => W.el("pairrow").hidden === false, 5000, "the window to ask for the code");
    check(W.el("s").textContent.indexOf("Введите код") >= 0 && W.el("go").hidden === true,
      "a window without the run's key asks for the code instead of reporting a lost runner", W.el("s").textContent);
    const wrong = String((Number(sec.pairCode) + 3) % 1000000).padStart(6, "0");
    W.el("code").value = wrong;
    await W.el("pairgo").onclick();
    check(/Код не подошёл/.test(W.el("pairmsg").textContent) && /4/.test(W.el("pairmsg").textContent) && W.el("pairrow").hidden === false,
      "a wrong code is refused and the window says how many tries are left", W.el("pairmsg").textContent);
    W.el("code").value = sec.pairCode.slice(0, 3) + " " + sec.pairCode.slice(3);
    await W.el("pairgo").onclick();
    check(W.el("pairrow").hidden === true && srv.paired, "the right code, typed as printed, pairs the window");
    const r = await srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 15000);
    check(r.ok === 1, "after pairing, jobs flow");
  } catch (e) { fail("pairing: " + e.message); }
  W.close();
  srv.close();
}

// A window opened before the runner was restarted from changed sources. It runs the plugin it was
// opened with, so it must not be paired, whatever code is typed into it, and must get no job — it is
// told to close and reopen. Its build differs from the runner's by one comment line in the host.
{
  const sec = newSecrets();
  const said = [];
  const srv = startJobServer(0, Object.assign({ log: (m) => said.push(m), pluginVersion: distKeyed.version }, sec));
  await srv.ready;
  const old = generatePlugin({ token: "", sources: { host: HOST_SRC + "\n// an edit made after this window was opened\n" } });
  const W = wire(old.ui, srv.port, old.code);
  try {
    check(old.version !== distKeyed.version, "a window built from other sources carries another build id");
    await until(() => /Закройте плагин и откройте его снова/.test(W.el("s").textContent), 5000, "the window to ask to be reopened");
    check(W.el("pairrow").hidden === true && W.el("go").hidden === true,
      "a window of another build asks to be closed and reopened, and shows no code field", W.el("s").textContent);
    // An old window that already shows the code field may still have it typed in: it gets no key.
    W.el("code").value = sec.pairCode;
    await W.el("pairgo").onclick();
    check(!srv.paired && /откройте его снова/.test(W.el("s").textContent) && W.el("pairmsg").textContent === "" && W.el("pairrow").hidden === true,
      "the right code typed into it anyway does not pair it, and the window goes on asking to be reopened", W.el("pairmsg").textContent);
    let got = null;
    try { got = await srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 1500); } catch (e) {}
    check(got === null && srv.lastPoll() === 0, "and it is given no job");
    // Parked, not retrying: one 409 is the whole answer, and asking again cannot change it.
    const f0 = W.fetches();
    await sleep(1200);
    check(W.fetches() - f0 <= 1, "having been told, it stops asking (" + (W.fetches() - f0) + " requests in 1.2 s)");
    check(said.some((l) => /refused 409/.test(l) && /open it again/.test(l)), "the runner says on its console that the window must be reopened");
  } catch (e) { fail("a window of another build: " + e.message); }
  W.close();
  srv.close();
}

// openSession wires the build it writes into the server it starts.
{
  const said = [];
  let s = null;
  try {
    s = await openSession({ port: 0, distDir: join(scratch, "dist-session"), log: (m) => said.push(m) });
    const ui = readFileSync(join(scratch, "dist-session", "ui.html"), "utf8");
    const mine = await hreq(s.port, "GET", "/control?rev=0", { Origin: "null", "X-PXF-Plugin": s.pluginVersion });
    const other = await hreq(s.port, "GET", "/control?rev=0", { Origin: "null", "X-PXF-Plugin": "0123456789ab" });
    check(/^[0-9a-f]{12}$/.test(s.pluginVersion) && ui.indexOf("const PLUGIN = " + JSON.stringify(s.pluginVersion) + ";") >= 0 &&
      ui.indexOf(s.token) >= 0 && mine.status === 401 && other.status === 409 && said.some((l) => l.indexOf(s.pluginVersion) >= 0),
      "openSession starts the runner on the build it has just written: that build asks for the key, another is told to reopen",
      [s.pluginVersion, mine.status, other.status].join(","));
  } catch (e) { fail("openSession: " + e.message); }
  if (s) s.close();
}

rmSync(scratch, { recursive: true, force: true });
console.log("");
console.log(failed ? "test-plugin: " + failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "test-plugin: all checks pass");
process.exit(failed ? 1 : 0);

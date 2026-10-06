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
import { VERSION as IR_VERSION } from "./ir/schema.mjs";
import { buildPlugin, generatePlugin, forbiddenIn, DIST_DIR } from "./build-plugin.mjs";
import { startJobServer, newSecrets, JOB_KINDS, IMAGE_TRANSPORTS as IR_TRANSPORTS } from "./jobserver.mjs";
import { p4Images } from "./plugin-probe.mjs";
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
//
// With { dynamicPage: true } it behaves as Figma does under the manifest's documentAccess
// "dynamic-page" (docs/M1.md §6 E): figma.getNodeById throws, figma.currentPage cannot be assigned
// (setCurrentPageAsync loads and switches), and a page that is not loaded lists no children until
// page.loadAsync() or figma.loadAllPagesAsync(). reg.unload(page) makes a page look like one from an
// earlier session.
function makeFigma(opts) {
  const dyn = !!(opts && opts.dynamicPage);
  const reg = { seq: 0, byId: new Map(), exportBytes: 16, loaded: new Set(), createImages: 0 };
  const kidsOf = (p) => p._kids || p.children;
  const mul = (a, b) => [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]]];
  function node(type) {
    const n = {
      id: (type === "DOCUMENT" ? "0:0" : "1:" + (++reg.seq)), type, name: type, removed: false, parent: null,
      width: 100, height: 100, _rt: [[1, 0, 0], [0, 1, 0]], _pd: {}, _spd: {},
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
      setSharedPluginData(ns, k, v) { (this._spd[ns] || (this._spd[ns] = {}))[k] = String(v); },
      getSharedPluginData(ns, k) { return (this._spd[ns] || {})[k] || ""; },
      remove() {
        if (this.parent) { const k = kidsOf(this.parent), i = k.indexOf(this); if (i >= 0) k.splice(i, 1); }
        this.parent = null; this.removed = true; reg.byId.delete(this.id);
      },
      exportAsync() { return Promise.resolve(new Uint8Array(reg.exportBytes)); },
    };
    if (type !== "RECTANGLE" && type !== "ELLIPSE") {
      n.children = [];
      n.appendChild = function (c) {
        if (c.parent) { const k = kidsOf(c.parent), i = k.indexOf(c); if (i >= 0) k.splice(i, 1); }
        c.parent = this; kidsOf(this).push(c);
      };
    }
    if (type === "PAGE") {
      reg.loaded.add(n);
      n.loadAsync = async function () { reg.loaded.add(this); };
      if (dyn) {
        n._kids = n.children;
        delete n.children;
        Object.defineProperty(n, "children", { get() { return reg.loaded.has(this) ? this._kids : []; }, enumerable: true });
      }
    }
    reg.byId.set(n.id, n);
    return n;
  }
  reg.unload = (p) => { reg.loaded.delete(p); };
  const root = node("DOCUMENT");
  const page = node("PAGE"); page.name = "Page 1"; root.appendChild(page);
  let current = page;
  const figma = {
    root, ui: { postMessage() {}, onmessage: null }, _reg: reg, _node: node,
    get currentPage() { return current; },
    set currentPage(p) {
      if (dyn) throw new Error("Cannot set figma.currentPage with documentAccess: dynamic-page; use figma.setCurrentPageAsync");
      current = p;
    },
    showUI() {},
    createFrame: () => node("FRAME"), createRectangle: () => node("RECTANGLE"), createEllipse: () => node("ELLIPSE"),
    createSection: () => node("SECTION"),
    createPage() { const p = node("PAGE"); root.appendChild(p); return p; },
    createText() { throw new Error("the stand-in has no text"); },
    createNodeFromSvg() { throw new Error("the stand-in has no SVG import"); },
    createImage: (bytes) => {
      reg.createImages++;
      if (!bytes || !bytes.length) throw new Error("Image is empty");
      return { hash: createHash("sha1").update(Buffer.from(bytes)).digest("hex") };
    },
    base64Decode: (s) => new Uint8Array(Buffer.from(s, "base64")),
    base64Encode: (u8) => Buffer.from(u8).toString("base64"),
    getNodeByIdAsync: async (id) => reg.byId.get(id) || null,
    loadAllPagesAsync: async () => { for (const p of root.children) reg.loaded.add(p); },
    loadFontAsync: async () => {},
    setCurrentPageAsync: async (p) => { reg.loaded.add(p); current = p; },
  };
  if (dyn) figma.getNodeById = () => { throw new Error("figma.getNodeById is not available with documentAccess: dynamic-page; use getNodeByIdAsync"); };
  return figma;
}

// The host alone, fed messages the way the window feeds it, recording what it posts back. Probe
// questions are answered the way the window answers them.
function bareHost(opts) {
  const figma = makeFigma(opts), posted = [];
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
  // The bundle's top-level vars (PXF_IR, PXF_TASK, …) are globals of this context; the seam checks
  // below reach the IR layer through g.
  let seq = 0;
  async function job(kind, payloadText, meta) {
    const id = "t" + (++seq), from = posted.length;
    await figma.ui.onmessage(Object.assign({ t: "payload-begin", id, kind, total: payloadText.length }, meta || {}));
    for (let o = 0; o < payloadText.length; o += 400000) await figma.ui.onmessage({ t: "payload-chunk", d: payloadText.slice(o, o + 400000) });
    await figma.ui.onmessage({ t: "payload-end" });
    const mine = posted.slice(from).filter((m) => m.id === id);
    const chunks = mine.filter((m) => m.t === "report-chunk");
    if (!mine.some((m) => m.t === "report-end")) throw new Error("no report for " + kind);
    return { report: JSON.parse(chunks.map((c) => c.d).join("")), slices: chunks.length, id };
  }
  return { figma, posted, job, g };
}

// A valid task of the IR path (tools/ir/task.mjs): the fonts preflight, the smallest there is.
const FONTS_TASK = () => ({ format: "pix2fig.task", version: 1, op: "fonts", runId: "0123456789abcdef", taskNo: 1, of: 1,
  snapshot: "pix:" + "0".repeat(62) + "a1", irVersion: IR_VERSION,
  settings: { textFit: "widen", layoutOrder: "creation", textRead: "measure", fallbackFont: { family: "Inter", style: "Regular" } },
  page: null, roots: [], nodes: [], notes: [], values: {}, fonts: [{ family: "Inter", style: "Regular" }], images: [], expect: null });

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

// The IR path's seam (docs/M1.md §5.3): the ir kind, the IR layer's probes, the host it is given, and
// the shared stamps RENDER, CLEAN and the sweep now read.
{
  const H = bareHost();
  const IRG = H.g.PXF_IR;
  check(IRG && typeof IRG.makeCtx === "function" && ["fonts", "build", "verify", "clean"].every((op) => typeof IRG.ops[op] === "function") &&
    ["P4", "P8", "P19B"].every((p) => IRG.probes[p] && typeof IRG.probes[p].run === "function"),
    "the plugin carries the IR layer: PXF_IR with the four task ops and the P4, P8 and P19B probes registered");
  {
    const { report } = await H.job("ir", JSON.stringify({ format: "pix2fig.task", version: 1, op: "build" }));
    check(report.refused && /the task is refused/.test(report.error), "an ir job whose task does not validate is refused, with the paths", String(report.error).slice(0, 160));
    const t = FONTS_TASK(); t.op = "paint";
    const r2 = (await H.job("ir", JSON.stringify(t))).report;
    check(r2.refused && /op: must be one of fonts, build, verify, clean/.test(r2.error), "an ir job naming an op outside the task format is refused", String(r2.error).slice(0, 160));
    // A stand-in op, so this holds whatever part B's fonts op does with a stand-in Figma.
    const was = IRG.ops.fonts;
    IRG.ops.fonts = async (ctx, task) => Object.assign(ctx.report, { reached: task.fonts.length });
    const r3 = (await H.job("ir", JSON.stringify(FONTS_TASK()))).report;
    IRG.ops.fonts = was;
    check(!r3.error && r3.reached === 1 && r3.op === "fonts" && r3.runId === "0123456789abcdef" && r3.plugin === distKeyed.version,
      "a valid task reaches its op with a fresh context, and the report names the plugin build", JSON.stringify(r3).slice(0, 160));
    if (was.notInThisBuild) {
      const r4 = (await H.job("ir", JSON.stringify(FONTS_TASK()))).report;
      check(r4.refused && /not in this build: part B/.test(r4.error), "a stub op refuses, naming the part that implements it", String(r4.error).slice(0, 160));
    }
  }
  // The host given to the IR layer: images created, images refused, and the progress counter.
  {
    await H.figma.ui.onmessage({ t: "image-begin" });
    await H.figma.ui.onmessage({ t: "image-end", hash: "e".repeat(40) });           // no bytes: the stand-in refuses it
    await H.figma.ui.onmessage({ t: "image-begin" });
    await H.figma.ui.onmessage({ t: "image-chunk", d: Buffer.from("pxf synthetic bytes").toString("base64") });
    await H.figma.ui.onmessage({ t: "image-end", hash: "f".repeat(40) });
    const was = IRG.ops.fonts;
    IRG.ops.fonts = async (ctx, task) => {
      ctx.progress();
      ctx.code(IRG.CODE.FONT_SUBSTITUTED, null, "synthetic");
      let unknown = "";
      try { ctx.code("NOT_A_CODE"); } catch (e) { unknown = e.message; }
      let badStamp = "";
      try { ctx.stamp(H.figma.currentPage, "pxOther", "1"); } catch (e) { badStamp = e.message; }
      return Object.assign(ctx.report, { images: ctx.S.images(), errors: ctx.S.imageErrors(), unknown, badStamp, frozen: Object.isFrozen(ctx) });
    };
    const { report, id } = await H.job("ir", JSON.stringify(FONTS_TASK()));
    IRG.ops.fonts = was;
    check(report.images && report.images["f".repeat(40)] && report.errors && /empty/.test(report.errors["e".repeat(40)] || "") && !report.errors["f".repeat(40)],
      "the IR layer sees the images this session created and, by hash, the ones Figma refused", JSON.stringify(report).slice(0, 200));
    check(H.posted.some((m) => m.t === "progress" && m.id === id && m.done >= 1), "ctx.progress() posts { t: progress, id, done } for the window to forward");
    check(report.codes.FONT_SUBSTITUTED === 1 && /unknown reason code/.test(report.unknown) && /not a stamp/.test(report.badStamp) && report.frozen,
      "ctx.code counts known codes and throws on an unknown one; ctx.stamp refuses a key outside the stamp list; ctx is frozen", JSON.stringify(report).slice(0, 200));
  }
  // The IR layer's probes: their own arguments, checked before anything runs.
  {
    const p8 = IRG.probes.P8, was = { args: p8.args, run: p8.run };
    p8.args = (raw) => { if (raw.badArg) throw new Error("badArg is not allowed"); return { size: 7 }; };
    p8.run = async (A) => ({ size: A.size, n: A.n });
    const ok8 = (await H.job("probe", JSON.stringify({ probes: ["P8"], n: 3 }))).report;
    const bad8 = (await H.job("probe", JSON.stringify({ probes: ["P8"], badArg: true }))).report;
    Object.assign(p8, was);
    check(ok8.probes && ok8.probes.P8.size === 7 && ok8.probes.P8.n === 3 && bad8.refused && /badArg is not allowed/.test(bad8.error),
      "an IR probe gets its own validated arguments merged with the common ones, and a bad one refuses the job", JSON.stringify([ok8.probes, bad8.error]).slice(0, 200));
    if (IRG.probes.P19B.run.notInThisBuild) {
      const stub = (await H.job("probe", JSON.stringify({ probes: ["P19B"], n: 1 }))).report;
      check(stub.probes && /not in this build: part E/.test(stub.probes.P19B.error || ""), "a stub probe runs as an error naming the part that implements it", JSON.stringify(stub.probes));
    }
  }
  // Shared stamps: an IR-built root carries pxSrc in namespace pix2fig only, and RENDER, CLEAN and the
  // scratch sweep must find it as they find a private one.
  {
    H.figma._reg.exportBytes = 16;
    const mk = (w, stamp, shared) => {
      const n = H.figma.createRectangle(); H.figma.currentPage.appendChild(n); n.resize(w, w);
      if (stamp) { if (shared) n.setSharedPluginData("pix2fig", "pxSrc", stamp); else n.setPluginData("pxSrc", stamp); }
      return n;
    };
    const other = mk(9, "pxf-src-other", false), irRoot = mk(13, "pxf-src-ir", true);
    const ex = (await H.job("render", JSON.stringify({ op: "export", id: other.id, src: "pxf-src-ir", constraint: { type: "SCALE", value: 1 } }))).report;
    check(ex.relocated === irRoot.id && ex.w === 13, "RENDER export finds a root by its shared stamp", JSON.stringify(ex).slice(0, 160));
    const cl = (await H.job("clean", JSON.stringify({ want: [{ src: "pxf-src-ir", id: null }] }))).report;
    check(cl.removed === 1 && irRoot.removed && !other.removed, "CLEAN removes a root carrying the shared stamp of a source it rebuilds", JSON.stringify(cl));
    other.remove();
    const s =H.figma.createRectangle(); H.figma.currentPage.appendChild(s); s.name = "pxf-test-shared-scratch";
    s.setSharedPluginData("pix2fig", "pxScratch", "1");
    const listed = (await H.job("render", JSON.stringify({ op: "scratch-list" }))).report;
    const swept = (await H.job("render", JSON.stringify({ op: "scratch-sweep" }))).report;
    check(listed.left.indexOf("pxf-test-shared-scratch") >= 0 && swept.swept >= 1 && s.removed,
      "the scratch list and sweep find a node marked pxScratch in shared plugin data", JSON.stringify([listed, swept]));
  }
}

// Part E's probes in the host: real (not stubs), their own arguments refused before anything runs,
// and the window round trip the host hands them (io.ask) reaching the window.
{
  const H = bareHost();
  const IRG = H.g.PXF_IR;
  check(["P4", "P8", "P19B"].every((p) => IRG.probes[p] && !IRG.probes[p].run.notInThisBuild && typeof IRG.probes[p].args === "function"),
    "P4, P8 and P19B are real probes in this build, not stubs");
  const refusals = [];
  for (const [payload, want] of [[{ probes: ["P4"] }, /P4: P4 needs p4/], [{ probes: ["P8"], p8: { cases: ["png9999"] } }, /P8: p8\.cases/],
    [{ probes: ["P19B"], p19b: { keep: "yes" } }, /P19B: p19b\.keep/], [{ probes: ["P1", "P4"], p4: { hashes: ["nothex"] } }, /P4: p4\.hashes/]]) {
    const before = H.posted.length;
    const { report } = await H.job("probe", JSON.stringify(payload));
    if (!(report.refused && want.test(report.error)) || H.posted.slice(before).some((m) => m.t === "probe-echo")) refusals.push(JSON.stringify(payload) + " -> " + report.error);
  }
  check(!refusals.length, "a probe's own bad argument refuses the whole job before any probe runs (P4 without images, P8's cases, P19B's keep)", refusals.join("; "));
  // io.ask: the host's round trip, as P4 uses it. The bare host answers probe-fetch like the window would.
  const bytes = Buffer.from("pxf synthetic bytes for P4"), hash = createHash("sha1").update(bytes).digest("hex");
  const answer = H.figma.ui.postMessage;
  H.figma.ui.postMessage = (m) => {
    answer(m);
    if (m.t === "probe-fetch") setImmediate(() => H.figma.ui.onmessage({ t: "probe-answer", k: m.k, d: m.as === "raw" ? new Uint8Array(bytes) : bytes.toString("base64") }));
  };
  const made = H.figma._reg.createImages;
  const { report } = await H.job("probe", JSON.stringify({ probes: ["P4"], p4: { hashes: [hash], repeat: 2 }, deadlineMs: 2000 }));
  const p4 = report.probes && report.probes.P4;
  check(p4 && p4.verdicts && p4.verdicts.sameHash === "ok" && IR_TRANSPORTS.indexOf(p4.verdicts.transport) >= 0 && H.figma._reg.createImages - made === 4,
    "P4 runs in the host: it asks the window for the bytes both ways (io.ask), creates an image from each, and the hashes hold", JSON.stringify(report.probes).slice(0, 200));
  H.figma.ui.postMessage = answer;
}

// documentAccess "dynamic-page" (manifest.json): builder4's BUILD and VERIFY, CLEAN and RENDER, under
// a stand-in that refuses the synchronous calls and lists no children on a page that is not loaded.
check(JSON.parse(readFileSync(join(ROOT, "figma-plugin", "manifest.json"), "utf8")).documentAccess === "dynamic-page",
  "the manifest sets documentAccess \"dynamic-page\" (docs/REWRITE.md §4)");
{
  const H = bareHost({ dynamicPage: true });
  const f = H.figma;
  check(/dynamic-page/.test((() => { try { f.currentPage = f.root.children[0]; return ""; } catch (e) { return e.message; } })()) &&
    /dynamic-page/.test((() => { try { f.getNodeById("0:0"); return ""; } catch (e) { return e.message; } })()),
    "the dynamic-page stand-in refuses figma.currentPage = … and figma.getNodeById, as Figma does");
  if (PAYLOAD) {
    const b = (await H.job("build", JSON.stringify(PAYLOAD), { page: "pxf synthetic page" })).report;
    const v = (await H.job("verify", JSON.stringify(PAYLOAD), { rootNodeId: b.rootId, page: "pxf synthetic page" })).report;
    check(!b.error && b.nodes === 3 && !v.error && v.count === 3 && (v.visibleOver1 || 0) === 0,
      "under dynamic-page, BUILD makes its page current before writing to it and builds, and VERIFY measures 3 of 3", JSON.stringify([b.error, v.error]));
  }
  // A root built in an earlier session, on a page not loaded: RENDER finds it by its stamp, CLEAN
  // removes it, and the scratch list sees a mark there.
  const other = f.createPage(); other.name = "pxf other page";
  const old = f.createFrame(); other.appendChild(old); old.setSharedPluginData("pix2fig", "pxSrc", "pxf-src-earlier");
  const mark = f.createRectangle(); other.appendChild(mark); mark.name = "pxf-test-dyn-scratch"; mark.setPluginData("pxScratch", "1");
  const gone = f.createFrame(); other.appendChild(gone); gone.setPluginData("pxSrc", "pxf-src-gone");
  f._reg.unload(other);
  const ex = (await H.job("render", JSON.stringify({ op: "export", id: "1:999999", src: "pxf-src-earlier", constraint: { type: "SCALE", value: 1 } }))).report;
  check(ex.relocated === old.id && !ex.e, "under dynamic-page, RENDER export loads the pages before it looks for a root by its stamp", JSON.stringify(ex).slice(0, 160));
  f._reg.unload(other);
  const listed = (await H.job("render", JSON.stringify({ op: "scratch-list" }))).report;
  f._reg.unload(other);
  const cl = (await H.job("clean", JSON.stringify({ want: [{ src: "pxf-src-gone", id: null }] }))).report;
  check(listed.left.indexOf("pxf-test-dyn-scratch") >= 0 && cl.removed === 1 && gone.removed,
    "under dynamic-page, the scratch list and CLEAN load the pages first and find what sits on one not loaded", JSON.stringify([listed, cl]));
  mark.remove();
  f._reg.unload(other);
  const lines = [];
  let bad = 0;
  try { bad = await cleanScenario(async (jobDesc, payload) => (await H.job(jobDesc.kind, payload)).report, (l) => lines.push(l)); }
  catch (e) { bad = 1; lines.push("FAIL " + e.message); }
  check(bad === 0, "tools/test-clean.mjs's scenario passes through CLEAN and RENDER under dynamic-page", lines.filter((l) => l.startsWith("FAIL")).join("; "));
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
  check(rejected && JOB_KINDS.join(",") === "build,verify,clean,render,probe,ir", "the runner refuses to queue a kind outside build, verify, clean, render, probe, ir");
  // post() takes the IR path's liveness options (docs/M1.md §5.3); P0 checks their shape, E enforces them.
  let badOpts = "";
  try { await srv.post({ kind: "ir" }, "{}", new Map(), 2000, { liveness: { warnMs: 5000, failMs: 1000 } }); } catch (e) { badOpts = e.message; }
  check(/warnMs must be below failMs/.test(badOpts), "post() refuses liveness options of the wrong shape before queueing anything", badOpts);
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

// One window per runner. Two plugin windows holding the key (the plugin open in two Figma files) were
// both given every pending job, and the first report won: the second live build of the test kit K,
// 2026-10-05, built a page in one file and verified it in the other. The first window given a job is
// the runner's; another is told 423 on every route that carries a job, and its report counts for
// nothing. Both windows hold a /job request when the job is posted, as two idle windows do.
{
  const said = [];
  const sec = newSecrets();
  const VER = distKeyed.version;
  const srv = startJobServer(0, Object.assign({ log: (m) => said.push(m), pluginVersion: VER }, sec));
  await srv.ready;
  const P = srv.port;
  const as = (w) => ({ Origin: "null", Authorization: "Bearer " + sec.token, "X-PXF-Plugin": VER, "X-PXF-Window": w, "Content-Type": "application/json" });
  const pre = await hreq(P, "OPTIONS", "/job?client=plugin", { Origin: "null", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-pxf-plugin,x-pxf-window" });
  check(pre.status === 204 && /x-pxf-window/i.test(pre.headers["access-control-allow-headers"] || ""), "the preflight allows the X-PXF-Window header a window names itself in");
  const heldA = hreq(P, "GET", "/job?client=plugin", as("win-a"));
  await sleep(80);
  const heldB = hreq(P, "GET", "/job?client=plugin", as("win-b"));
  await sleep(80);
  const IMG = "cd".repeat(20);
  const posted = srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map([[IMG, Buffer.from("x")]]), 5000);
  const [a, b] = await Promise.all([heldA, heldB]);
  let ja = {}, jb = {};
  try { ja = JSON.parse(a.body); } catch (e) {}
  try { jb = JSON.parse(b.body); } catch (e) {}
  check(a.status === 200 && ja.kind === "render" && b.status === 423 && jb.otherWindow === true && b.headers["access-control-allow-origin"] === "null" && srv.window === "win-a",
    "a job posted while two windows wait goes to the one that asked first; the other is told 423, readable by it", [a.status, ja.kind, b.status, srv.window].join(","));
  const routes = [["GET", "/job?client=plugin"], ["GET", "/job/" + ja.id + "/payload"], ["GET", "/image/" + IMG + "?b64=1"], ["POST", "/alive?id=" + ja.id + "&done=5"],
    ["POST", "/report"]];
  const fromB = [];
  for (const [m, p] of routes) {
    const r = await hreq(P, m, p, as("win-b"), m === "POST" ? JSON.stringify({ id: ja.id, i: 0, n: 1, d: JSON.stringify({ ok: 2, from: "b" }) }) : null);
    if (r.status !== 423) fromB.push(m + " " + p.split("?")[0] + " -> " + r.status);
  }
  const noHeader = await hreq(P, "GET", "/job?client=plugin", { Origin: "null", Authorization: "Bearer " + sec.token, "X-PXF-Plugin": VER });
  check(!fromB.length && noHeader.status === 423, "the other window gets 423 on the job, its payload, its images, /alive and /report; a window naming none is another window too", fromB.join("; "));
  const pa = await hreq(P, "GET", "/job/" + ja.id + "/payload", as("win-a"));
  const ra = await hreq(P, "POST", "/report", as("win-a"), JSON.stringify({ id: ja.id, i: 0, n: 1, d: JSON.stringify({ ok: 1, from: "a" }) }));
  const got = await posted;
  check(pa.status === 200 && ra.status === 200 && got.from === "a", "the runner's window takes the payload and its report is the job's; the other's report counted for nothing", JSON.stringify(got));
  // The next job goes to the same window, even when the other asks first.
  const early = await hreq(P, "GET", "/job?client=plugin", as("win-b"));
  const posted2 = srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 5000);
  const late = await hreq(P, "GET", "/job?client=plugin", as("win-b"));
  const mine = await hreq(P, "GET", "/job?client=plugin", as("win-a"));
  let jm = {};
  try { jm = JSON.parse(mine.body); } catch (e) {}
  await hreq(P, "POST", "/report", as("win-a"), JSON.stringify({ id: jm.id, i: 0, n: 1, d: JSON.stringify({ ok: 3 }) }));
  const got2 = await posted2;
  check(early.status === 423 && late.status === 423 && mine.status === 200 && jm.kind === "render" && got2.ok === 3 && srv.othersRefused >= 8,
    "the next job goes to the same window, however early the other asks", [early.status, late.status, mine.status, srv.othersRefused].join(","));
  check(said.some((l) => /refused 423/.test(l) && /another plugin window/.test(l) && /close the other one/.test(l)) && said.some((l) => /plugin window is "win-a"/.test(l)),
    "the runner says which window is its own, and that another one asked and must be closed");
  srv.close();
}
// ...but not for good: the runner's window closed (the designer reopened the plugin, the live kit
// build of 2026-10-05) is silent, and after ownerGoneMs the next window to ask takes the run over and
// does the pending job again. A window that keeps asking keeps the run.
{
  const said = [];
  const sec = newSecrets();
  const VER = distKeyed.version;
  const srv = startJobServer(0, Object.assign({ log: (m) => said.push(m), pluginVersion: VER, ownerGoneMs: 400 }, sec));
  await srv.ready;
  const P = srv.port;
  const as = (w) => ({ Origin: "null", Authorization: "Bearer " + sec.token, "X-PXF-Plugin": VER, "X-PXF-Window": w, "Content-Type": "application/json" });
  const posted = srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 5000);
  const a = await hreq(P, "GET", "/job?client=plugin", as("win-a"));
  let ja = {};
  try { ja = JSON.parse(a.body); } catch (e) {}
  const soon = await hreq(P, "GET", "/job?client=plugin", as("win-b"));
  await sleep(150);
  const keep = await hreq(P, "GET", "/control?rev=0", as("win-a"));
  await sleep(300);
  const stillA = await hreq(P, "GET", "/job?client=plugin", as("win-b"));
  await sleep(500);
  const taken = await hreq(P, "GET", "/job?client=plugin", as("win-b"));
  let jt = {};
  try { jt = JSON.parse(taken.body); } catch (e) {}
  await hreq(P, "POST", "/report", as("win-b"), JSON.stringify({ id: jt.id, i: 0, n: 1, d: JSON.stringify({ ok: 7, from: "b" }) }));
  const got = await posted;
  const lateA = await hreq(P, "GET", "/job?client=plugin", as("win-a"));
  check(a.status === 200 && soon.status === 423 && keep.status === 200 && stillA.status === 423 && taken.status === 200 && jt.id === ja.id &&
    got.from === "b" && srv.window === "win-b" && lateA.status === 423 && said.some((l) => /has been silent for/.test(l) && /takes over this run/.test(l)),
    "a window that keeps asking keeps the run; once it is silent past ownerGoneMs the next window takes the run over and does the pending job again",
    [a.status, soon.status, keep.status, stillA.status, taken.status, jt.id === ja.id, got.from, srv.window, lateA.status].join(","));
  srv.close();
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
function wire(uiHtml, port, code, tap) {
  const figma = makeFigma();
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, textContent: "", className: "", hidden: ["pairrow", "scoperow", "go"].indexOf(id) >= 0,
    disabled: false, onclick: null, onkeydown: null, value: id === "scope" ? "file" : "", style: {} });
  let closed = false, fetches = 0, target = port, held = null;
  // Requests in flight, so a runner's death can be played: the window's open requests fail as a closed
  // socket fails them, and the next ones reach whatever runner now listens (W.retarget).
  const inflight = new Set();
  const winFetch = (url, o) => {
    if (closed) return Promise.reject(new TypeError("window closed"));
    fetches++;
    const u = new URL(String(url));
    const oo = Object.assign({}, o || {});
    oo.headers = Object.assign({ Origin: "null" }, oo.headers || {});
    let cut = null;
    const dead = new Promise((_, rej) => { cut = () => rej(new TypeError("fetch failed (the runner is gone)")); });
    inflight.add(cut);
    // A held path (W.hold) is never sent: it waits, as a request to a dying runner does, until cut.
    if (held && held.test(u.pathname)) return dead.finally(() => inflight.delete(cut));
    return Promise.race([fetch("http://127.0.0.1:" + target + u.pathname + u.search, oo), dead]).finally(() => inflight.delete(cut));
  };
  const a = uiHtml.indexOf("<script>"), b = uiHtml.lastIndexOf("</script>");
  const win = createContext({
    fetch: winFetch, document: { getElementById: el },
    parent: { postMessage: (m) => { const c = structuredClone(m.pluginMessage); if (tap) tap(c); setImmediate(() => { if (!closed) figma.ui.onmessage(c); }); } },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Promise, JSON, URL, console,
  });
  figma.ui.postMessage = (m) => { const c = structuredClone(m); setImmediate(() => { if (!closed && win.onmessage) win.onmessage({ data: { pluginMessage: c } }); }); };
  runInContext(uiHtml.slice(a + 8, b), win);
  const plugin = createContext({ figma, __html__: "", setTimeout, clearTimeout, performance });
  runInContext(code || CODE, plugin);
  return { figma, el, plugin, fetches: () => fetches, close() { closed = true; },
    retarget(p) { held = null; target = p; for (const c of [...inflight]) c(); }, hold(re) { held = re; } };
}

{
  const sec = newSecrets();
  const chainDist = buildPlugin({ outDir: join(scratch, "dist-chain"), token: sec.token });
  const srv = startJobServer(0, Object.assign({ log: () => {}, pluginVersion: chainDist.version }, sec));
  await srv.ready;
  const toPlugin = [];
  const W = wire(readFileSync(chainDist.uiPath, "utf8"), srv.port, null, (m) => toPlugin.push(m));
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

    // The IR path's kind through the real window: the task arrives whole and its (stub) op answers.
    // A stand-in op in the window's plugin, so this holds whatever part B's fonts op does.
    const ops = W.plugin.PXF_IR.ops, was = ops.fonts;
    ops.fonts = async (ctx, task) => Object.assign(ctx.report, { reached: task.fonts.length });
    const irr = await srv.post({ kind: "ir" }, JSON.stringify(FONTS_TASK()), new Map(), 30000);
    ops.fonts = was;
    check(!irr.error && irr.reached === 1 && irr.op === "fonts", "an ir job travels the whole chain, runner -> window -> plugin op -> back", JSON.stringify(irr).slice(0, 200));

    // P4 through the real window: the probe fetches the job's images itself, both ways, and the window
    // does not hand them to the plugin first.
    const p4imgs = p4Images([40, 60]);
    const made = W.figma._reg.createImages;
    const p4 = await srv.post({ kind: "probe" }, JSON.stringify({ probes: ["P4"], p4: { hashes: [...p4imgs.keys()], repeat: 1 }, deadlineMs: 5000 }), p4imgs, 30000);
    const v4 = p4.probes && p4.probes.P4;
    check(v4 && v4.verdicts.sameHash === "ok" && IR_TRANSPORTS.indexOf(v4.verdicts.transport) >= 0 && W.figma._reg.createImages - made === 4 &&
      !toPlugin.some((m) => m.t === "image-begin" && p4imgs.has(m.hash)),
      "P4 travels the whole chain: the window serves /image/<hash> as base64 and as bytes, the hashes hold, and a probe job's images are not pre-made", JSON.stringify(p4).slice(0, 240));

    // The binary image transport (P4's verdict): Uint8Array slices of at most 4 MB, the hash kept.
    const big = Buffer.alloc(5 * 1048576 + 7);
    for (let i = 0, x = 99; i < big.length; i++) { x = (x * 1103515245 + 12345) >>> 0; big[i] = x >>> 24; }
    const bigHash = createHash("sha1").update(big).digest("hex");
    const opsB = W.plugin.PXF_IR.ops, wasB = opsB.fonts;
    opsB.fonts = async (ctx) => Object.assign(ctx.report, { figmaHash: ctx.S.images()[bigHash] || null });
    const mark = toPlugin.length;   // only this job: with P4 recorded as binary, earlier images travel as slices too
    const rb = await srv.post({ kind: "ir", imageTransport: "binary" }, JSON.stringify(FONTS_TASK()), new Map([[bigHash, big]]), 30000);
    opsB.fonts = wasB;
    const slices = toPlugin.slice(mark).filter((m) => m.t === "image-chunk" && typeof m.d === "object");
    check(rb.figmaHash === bigHash && slices.length === 2 && slices.every((m) => m.d.length <= 4 * 1048576) && toPlugin.some((m) => m.t === "image-begin" && m.hash === bigHash && m.binary === true),
      "the binary image transport sends a 5 MB image as two Uint8Array slices of at most 4 MB, and Figma's hash is its SHA-1", JSON.stringify([rb.figmaHash === bigHash, slices.map((m) => m.d.length)]));

    // Liveness through the chain: the plugin's progress counter, forwarded by the window, keeps a task
    // alive past failMs; a task that stops advancing fails with PLUGIN_STALLED.
    const opsL = W.plugin.PXF_IR.ops, wasL = opsL.fonts;
    opsL.fonts = async (ctx) => { for (let k = 0; k < 3; k++) { ctx.progress(); await sleep(1050); } return ctx.report; };
    const heard = [], t0 = Date.now();
    const rl = await srv.post({ kind: "ir" }, JSON.stringify(FONTS_TASK()), new Map(), 30000, { liveness: { warnMs: 600, failMs: 1600 }, ceilingMs: 20000, onProgress: (d) => heard.push(d) });
    check(!rl.error && Date.now() - t0 > 1600 && heard.length >= 3 && heard.every((d, k) => k === 0 || d > heard[k - 1]),
      "progress posted by ctx.progress() reaches the runner through the window (/alive?done=n) and keeps a task alive past failMs", JSON.stringify([rl.error, heard, Date.now() - t0]));
    opsL.fonts = async (ctx) => { ctx.progress(); await sleep(1500); return ctx.report; };
    let stalled = null;
    try { await srv.post({ kind: "ir" }, JSON.stringify(FONTS_TASK()), new Map(), 30000, { liveness: { warnMs: 300, failMs: 700 }, ceilingMs: 20000 }); }
    catch (e) { stalled = e; }
    await sleep(1200);   // the plugin finishes the abandoned task; its late report is ignored
    opsL.fonts = wasL;
    check(stalled && stalled.code === "PLUGIN_STALLED" && stalled.resumable === true, "a task whose counter stops advancing fails with PLUGIN_STALLED through the chain", stalled && stalled.message);
    const after = await srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 15000);
    check(after.ok === 1, "after a stalled task the window takes the next job");
  } catch (e) { fail("the chain: " + e.message); }
  W.close();
  srv.close();
}

// Two real windows (dist/ui.html) open at once, each with its own Figma, as when the plugin is open in
// two files: the build and its verify both go to the window that took the first job, and the other
// window says it does nothing and should be closed.
{
  const sec = newSecrets();
  const twinDist = buildPlugin({ outDir: join(scratch, "dist-twin"), token: sec.token });
  const said = [];
  const srv = startJobServer(0, Object.assign({ log: (m) => said.push(m), pluginVersion: twinDist.version }, sec));
  await srv.ready;
  const ui = readFileSync(twinDist.uiPath, "utf8");
  const W1 = wire(ui, srv.port);
  await until(() => srv.lastPoll() > 0, 5000, "the first window to ask for work");
  await sleep(100);
  const W2 = wire(ui, srv.port);
  try {
    await until(() => W2.fetches() >= 2, 5000, "the second window to ask for work");
    await sleep(150);
    if (PAYLOAD) {
      const r = await srv.post({ kind: "build", page: "pxf twin page" }, JSON.stringify(PAYLOAD), new Map([[IMG_HASH, IMG_BYTES]]), 30000);
      const pageIn = (W) => W.figma.root.children.find((p) => p.name === "pxf twin page");
      const p1 = pageIn(W1), p2 = pageIn(W2);
      await until(() => /в другом окне плагина/.test(W2.el("s").textContent), 5000, "the second window to say another window has the run");
      check(!r.error && p1 && p1.children.some((n) => n.id === r.rootId) && !p2,
        "with two windows open the build lands in the first window's Figma only", JSON.stringify([!!p1, !!p2, r.error]));
      const v = await srv.post({ kind: "verify", rootNodeId: r.rootId, page: "pxf twin page" }, JSON.stringify(PAYLOAD), new Map(), 30000);
      check(!v.error && v.count === 3 && v.expected === 3, "its verify runs in the same Figma and finds the 3 nodes it built", JSON.stringify(v).slice(0, 200));
    } else {
      const r = await srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 15000);
      await until(() => /в другом окне плагина/.test(W2.el("s").textContent), 5000, "the second window to say another window has the run");
      check(r.ok === 1, "with two windows open a job is answered once");
    }
    check(/закройте его/.test(W2.el("s").textContent) && !/в другом окне плагина/.test(W1.el("s").textContent) && srv.window !== null && srv.othersRefused > 0 &&
      said.some((l) => /refused 423/.test(l)),
      "the other window is refused (423) and says it does nothing and should be closed; the runner says so too", W2.el("s").textContent);
    // Parked, not retrying: the answer cannot change while this runner lives.
    const f0 = W2.fetches();
    await sleep(1200);
    check(W2.fetches() - f0 <= 1, "having been told, the other window stops asking (" + (W2.fetches() - f0) + " requests in 1.2 s)");
  } catch (e) { fail("two windows: " + e.message); }
  W1.close();
  W2.close();
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

// A window busy with a job when its runner dies and another one starts (the live session of 2026-10-05,
// docs/M1.md §15.11: the plugin, finishing a job for a dead runner, did not ask for the code). The new
// runner has a new key, so the window's requests get 401: the code field and the state line asking for
// it come up while the job still runs, the job is not disturbed, and once it ends, or after a job that
// failed for want of its runner, the window still asks, and works once paired.
async function busyPairing(label, finish) {
  const secA = newSecrets();
  const dA = buildPlugin({ outDir: join(scratch, "dist-busy-" + label), token: secA.token });
  const A = startJobServer(0, Object.assign({ log: () => {}, pluginVersion: dA.version }, secA));
  await A.ready;
  const W = wire(readFileSync(dA.uiPath, "utf8"), A.port);
  let B = null;
  const ops = W.plugin.PXF_IR.ops, was = ops.fonts;
  try {
    await until(() => A.lastPoll() > 0, 5000, "the window to ask for work");
    let release = null, entered = false, finished = false;
    ops.fonts = async (ctx) => { entered = true; await new Promise((r) => { release = r; }); finished = true; return ctx.report; };
    // "failed": the runner dies while the window fetches the job's payload, so the job fails in the window.
    if (finish === "failed") W.hold(/\/payload$/);
    A.post({ kind: "ir" }, JSON.stringify(FONTS_TASK()), new Map(), 60000).catch(() => {});
    if (finish === "failed") await until(() => /^job j\S+ \(ir\)/m.test(W.el("l").textContent), 5000, "the window to take the job");
    else await until(() => entered, 5000, "the job to start in the plugin");
    // The runner dies with the job unanswered; another starts on the same port, same build, new key.
    A.close();
    const secB = newSecrets();
    B = startJobServer(0, Object.assign({ log: () => {}, pluginVersion: dA.version }, secB));
    await B.ready;
    W.retarget(B.port);
    if (finish === "after") { release(); await until(() => finished, 5000, "the job to end"); }
    let asked = true;
    try { await until(() => W.el("pairrow").hidden === false && /Введите код/.test(W.el("s").textContent), 8000, "the window to ask for the code"); }
    catch (e) { asked = false; }
    check(asked, label + ": the window shows the code field and its state line asks for the code" +
      (finish === "after" ? " once the job for the dead runner has ended" : finish === "failed" ? " after the job failed with its runner" : " while the job for the dead runner still runs"),
      JSON.stringify([W.el("pairrow").hidden, W.el("s").textContent]));
    if (finish === "during") {
      check(!finished && /задани/.test(W.el("s").textContent), label + ": the job is left running, and the line says Figma is still finishing it", W.el("s").textContent);
      W.el("code").value = secB.pairCode;
      await W.el("pairgo").onclick();
      check(W.el("pairrow").hidden === true && B.paired && !finished, label + ": the code pairs the window while the job still runs");
      let early = null;
      const p = B.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 15000).then((r) => { early = r; return r; });
      await sleep(400);
      check(early === null, label + ": a busy window takes no second job before its own has ended");
      release();
      const r = await p;
      check(finished && r.ok === 1, label + ": the job ends, and the window then takes the new runner's job");
    } else {
      W.el("code").value = secB.pairCode;
      await W.el("pairgo").onclick();
      const r = await B.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 15000);
      check(W.el("pairrow").hidden === true && B.paired && r.ok === 1, label + ": paired, the window takes the new runner's job");
    }
  } catch (e) { fail("busy pairing (" + label + "): " + e.message); }
  ops.fonts = was;
  W.close();
  A.close();
  if (B) B.close();
}
await busyPairing("busy", "during");
await busyPairing("just finished", "after");
await busyPairing("failed", "failed");

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

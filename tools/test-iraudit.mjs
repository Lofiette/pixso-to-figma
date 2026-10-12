// The render audit (tools/ir-audit.mjs, tools/ir/render-audit.mjs, docs/M1.md §16), offline.
//
//   node tools/test-iraudit.mjs
//
// The synthetic fixture (tools/pix/fixture.mjs) is read, given a few paints and three changes that make
// the audit's cases (root 2: a white frame holding a placeholder; root 8: a frame at 32 % opacity;
// root 50: a section holding a group), planned, and built and verified by the bundled IR layer on the
// headless double, as tools/test-m1-e2e.mjs does. The audit then renders every root twice: in "Figma"
// through the real generated dist/code.js and its RENDER "export" on the double (whose exportAsync draws
// with the toy rasteriser, tools/double/raster.mjs, applying a node's own opacity and a section's wider
// margin, as Figma does), and in "Pixso" through the fake Pixso (tools/test/fake-pixso.mjs), which draws
// the IR with the same rasteriser the way Pixso exports: with the node's own opacity (as Figma does,
// docs/M1.md §16.2), no margin, an instance drawn as its content. What it proves:
//   - the clean run: every root that draws something is ok, every root the toy rasteriser draws nothing
//     for (a text, a vector) is not compared, the placeholder roots are left to G11; with the first
//     pass's --blank compare every root is ok and m1-accept reads PASS;
//   - a planted colour difference fails, and m1-accept reads FAIL (audit);
//   - a placeholder's region is masked (with --placeholders compare the same root fails);
//   - a 32 % opacity root passes, its opacity undone in both pictures (the first pass's one-sided rules
//     fail it now that Pixso's picture carries the opacity too);
//   - a section's margin passes when cropped to its box, and child by child (compared as it comes, it
//     fails on size);
//   - a missing render fails, in Figma and in Pixso, and never counts as ok; a root its masks cover whole
//     is not compared (ok null), so the verdict cannot read PASS;
//   - SOURCE_IDENTITY_MISMATCH stops the audit before any render, and --accept-identity-mismatch goes on
//     and records the reason;
//   - a second pass keeps the roots already ok; the RENDER export refuses another snapshot's copy;
//   - the verdict: a root not compared covers nothing and fails nothing, INSTANCE roots are not required;
//   - a root whose verify is not done, or whose verified node is gone while an earlier run's copy is in
//     the file, is a missing render; a section's children pair by index only when the counts match;
//   - what the first live pass taught the audit (§16.2), each on pictures drawn here and handed to
//     auditRun directly: pictures registered in the node's box frame (an arrow connector whose cap
//     reaches further in Figma, an instance drawn beyond its box), the search run on both engines'
//     pictures at 4x so one drawing at two sub-pixel phases compares equal; a root neither engine
//     draws, and Pixso's empty export, not compared, while a picture blank on one side fails even where
//     its placeholders cannot be placed; a root under a hidden ancestor not compared and not rendered;
//     a placeholder masked by what its master draws (at a scaled instance's scale, and not at all where
//     its clipping ancestors clip it away); a text with invalid stored glyphs in its own class where the
//     difference lies near it; a 1-device-pixel line on a pixel boundary compared by its two-row band,
//     and every real stroke difference there still failing. Each fails under the first pass's settings;
//   - which pixels a picture draws (--drawn-by, §16.5): visible leaves out what is white on both sides
//     (a white card one engine exports opaque and the other transparent, a shadow's faint edge) and
//     still counts a visible difference on both sides (an image placeholder against an image with white
//     margins in a white frame, drawn here and in the fixture run), where ink makes it one of size;
//   - the offline re-judge (tools/ir-rejudge.mjs): a run audited with --pictures all, judged again from
//     its folder, reproduces itself root for root, and under another setting matches a live pass under
//     it; an export the folder does not keep (another scale, the reports of a search's 4x pictures) is
//     refused or named, and its root set apart.
// Everything is synthetic, and everything written goes to the system's temporary folder.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { deflateSync } from "node:zlib";
import { makeFixture } from "./pix/fixture.mjs";
import { readPix } from "./pix/read.mjs";
import { pixToIR } from "./pix/ir/index.mjs";
import { validate } from "./ir/validate.mjs";
import { cleanTaskFor, planM1 } from "./ir/plan.mjs";
import { resolveImages } from "./ir/images.mjs";
import { newStates, probeStatus, runTasks, saveStates } from "./ir/runstate.mjs";
import { drawingBox, judgeRun } from "./ir/judge.mjs";
import { m1Gates } from "./ir/verdict.mjs";
import { makeDouble, loadVerdicts } from "./double/index.mjs";
import { rasterize, pngOf } from "./double/raster.mjs";
import { loadPluginBundle, defaultHost } from "./ir/plugin-vm.mjs";
import { generatePlugin } from "./build-plugin.mjs";
import { judgeWith } from "./pix-run.mjs";
import { accept } from "./m1-accept.mjs";
import { sampleGuids } from "./ir/identity.mjs";
import { SCRIPTS, assertReadOnlyScript, makeMcpClient, readOnlyProblems } from "./ir/mcp-readonly.mjs";
import { IDENTITY_SCRIPT } from "./extract-lib.mjs";
import { fakePixso } from "./test/fake-pixso.mjs";
import { AUDIT_SETTINGS, GLYPH_NOTE_CODES, auditRoots, auditRun, comparePictures, defaultAuditSettings, guidIndex, parseAuditArgs, placeBox, placeholderBoxes, registration, scaleAlpha } from "./ir/render-audit.mjs";
import { CODE, canonicalJSON } from "./ir/schema.mjs";
import { auditFolder, main as auditMain, readRun } from "./ir-audit.mjs";
import { compareAudits, main as rejudgeMain, rejudge, rejudgeSettings } from "./ir-rejudge.mjs";
import { decodePNG } from "./pngutil.mjs";

let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why !== undefined ? " — " + String(why).slice(0, 600) : "")));
const show = (v) => JSON.stringify(v);
const RUN = "0f1e2d3c4b5a6978";
const SCRATCH = mkdtempSync(join(tmpdir(), "pxf-iraudit-"));
setTimeout(() => { console.log("FAIL test-iraudit did not finish within 300 s"); process.exit(1); }, 300000).unref();
console.log("render audit (tools/ir-audit.mjs)");

// ============================================================================================
// the source: the fixture, with paints and the audit's cases
// ============================================================================================
const FX = makeFixture("valid");
const PIX = readPix(FX.pix);
const READ = pixToIR(FX.pix, { settings: {} });
const STATS = READ.stats;
const IR = JSON.parse(JSON.stringify(READ.ir));
const paint = (r, g, b) => ({ type: "SOLID", color: { r, g, b } });
// Values are interned (IR.md §2): an existing equal value is reused.
const fillsOf = (list) => {
  const k = IR.values.findIndex((v) => JSON.stringify(v) === JSON.stringify(list));
  if (k >= 0) return k;
  IR.values.push(list);
  return IR.values.length - 1;
};
// root 2: a white frame holding a placeholder (INSTANCE 7, moved in from the page)
IR.nodes[2].props.fills = fillsOf([paint(1, 1, 1)]);
IR.nodes[7].parent = 2; delete IR.nodes[7].page; IR.nodes[7].props.relativeTransform = [1, 0, 300, 0, 1, 60];
// root 8: a white frame with coloured children, at 32 % opacity
IR.nodes[8].props.opacity = 0.32;
// root 19: the colour plant's target (rectangle 20, red, on white)
IR.nodes[19].props.fills = fillsOf([paint(1, 1, 1)]);
IR.nodes[20].props.fills = fillsOf([paint(0.9, 0.1, 0.1)]);
// root 55: a solid paint for the image the archive does not hold (root 2 keeps one: the image rule's case)
IR.nodes[55].props.fills = fillsOf([paint(0.2, 0.7, 0.3)]);
// root 50: a section holding a group (51, moved in from the page)
IR.nodes[51].parent = 50; delete IR.nodes[51].page; IR.nodes[51].props.relativeTransform = [1, 0, 10, 0, 1, 10];
{
  const v = validate(IR);
  check(v.ok, "the fixture's IR with the audit's cases is valid IR version 2", show(v.errors.slice(0, 3)));
}

// ============================================================================================
// the run: built and verified on the double, written as pix-run writes its run folder
// ============================================================================================
const VERDICTS = loadVerdicts();
async function buildRun(label) {
  const { bytes, table } = await resolveImages(IR, PIX, { links: ["archive"], verdicts: VERDICTS });
  const plan = planM1(IR, STATS, { m1Scope: "default", images: table, runId: RUN });
  const D = makeDouble({ verdicts: VERDICTS });
  const host = defaultHost();
  host.phase = D.setPhase;
  const figImages = {}, figErrors = {};
  host.images = () => figImages;
  host.imageErrors = () => figErrors;
  const B = loadPluginBundle({ figma: D.figma, host });
  const ctxs = new Map();
  const post = async (task, p) => {
    for (const [hash, buf] of p.images) {
      try { figImages[hash] = D.figma.createImage(new Uint8Array(buf)).hash; } catch (e) { figErrors[hash] = String((e && e.message) || e); }
    }
    const P = JSON.parse(JSON.stringify(task));
    const ctx = B.PXF_IR.makeCtx(D.figma, P, { id: label + "-" + P.taskNo });
    ctxs.set(P.taskNo, ctx);
    return JSON.parse(JSON.stringify(await B.PXF_IR.ops[P.op](ctx, P)));
  };
  const settings = { source: "pix", scope: "file", m1Scope: "default", booleans: "auto", spaceEvenlySingle: "center", textFit: "widen", layoutOrder: "deepestFirst",
    textRead: "measure", images: "archive", noPixso: true, missingFonts: "ask", fallbackFont: { family: "Inter", style: "Regular" }, maxTaskMb: 4,
    livenessWarnS: 60, livenessFailS: 300, ceilingMsPerNode: 20 };
  const states = newStates({ snapshot: plan.tasks[0].snapshot, irVersion: IR.header.version, runId: RUN, settings, probes: probeStatus(VERDICTS),
    pixso: { used: false, identity: null, q5: false }, balance: plan.balance, ledger: plan.ledger });
  const runDir = join(SCRATCH, label);
  mkdirSync(join(runDir, "judge"), { recursive: true });
  mkdirSync(join(runDir, "reports"), { recursive: true });
  const imagesFor = (task) => { const m = new Map(); for (const im of task.images) if (im.source !== "none" && bytes.has(im.hash)) m.set(im.hash, bytes.get(im.hash)); return m; };
  const r = await runTasks({ states, tasks: plan.tasks, post, imagesFor, clean: (t) => cleanTaskFor(t, IR), judge: judgeWith(IR, STATS),
    onReport: (t, rep) => writeFileSync(join(runDir, "reports", t.taskNo + "-" + t.op + ".json"), JSON.stringify(rep)), log: () => {}, missingFonts: "ask" });
  const out = (f, v) => writeFileSync(join(runDir, f), JSON.stringify(v), "utf8");
  out("ir.json", IR);
  out("stats.json", STATS);
  out("plan.json", { balance: plan.balance, preflight: plan.preflight, ledger: plan.ledger, outOfScope: {},
    records: plan.tasks.filter((t) => t.op === "build").reduce((m, t) => { m[t.taskNo] = t.nodes.map((n) => n.i); return m; }, {}) });
  saveStates(join(runDir, "states.json"), states);
  for (const j of r.Js) out(join("judge", j.taskNo + ".json"), j.J);
  const nodeOf = (i) => { for (const c of ctxs.values()) if (c.S.nodes[String(i)]) return D.node(c.S.nodes[String(i)]); return null; };
  return { D, plan, states, runDir, nodeOf, totals: r.Js.length ? judgeRun(r.Js.map((j) => j.J)) : null };
}

// "Figma": the generated dist/code.js on the double. A render job goes in as the window hands it over
// (payload-begin, chunks, payload-end) and its report comes back in slices.
const GEN = generatePlugin({ token: "" });
function figmaHost(D) {
  const posted = [];
  const ui = { onmessage: null, postMessage: (m) => posted.push(m) };
  const figma = new Proxy({}, { get(_, p) { if (p === "showUI") return () => {}; if (p === "ui") return ui; return D.figma[p]; } });
  runInContext(GEN.code, createContext({ figma, __html__: "", setTimeout, clearTimeout }));
  let seq = 0, calls = 0;
  const exportJob = async (job) => {
    calls++;
    const id = "r" + (++seq), text = JSON.stringify(job), from = posted.length;
    await ui.onmessage({ t: "payload-begin", id, kind: "render", total: text.length });
    await ui.onmessage({ t: "payload-chunk", d: text });
    await ui.onmessage({ t: "payload-end" });
    const chunks = posted.slice(from).filter((m) => m.t === "report-chunk" && m.id === id).map((m) => m.d);
    return JSON.parse(chunks.join(""));
  };
  return { exportJob, calls: () => calls };
}

// "Pixso": the IR drawn as Pixso exports a node. Every record is a node of the fake, by its guid.
const CONTENT = paint(0.1, 0.5, 0.9);   // what an instance draws in Pixso (its master's content)
const KIDS = new Map();
IR.nodes.forEach((r, i) => { if (!KIDS.has(r.parent)) KIDS.set(r.parent, []); KIDS.get(r.parent).push(i); });
const m6 = (a, b) => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
const absRec = (i) => { let m = IR.nodes[i].props.relativeTransform; for (let p = IR.nodes[i].parent; p >= 0; p = IR.nodes[p].parent) m = m6(IR.nodes[p].props.relativeTransform, m); return m; };
const to2 = (m) => [[m[0], m[1], m[2]], [m[3], m[4], m[5]]];
function irTree(i, abs) {
  const r = IR.nodes[i], p = r.props;
  return { abs: to2(abs), type: r.type, w: p.width, h: p.height, opacity: p.opacity, visible: p.visible, clips: !!p.clipsContent,
    fills: r.type === "INSTANCE" ? [CONTENT] : p.fills === undefined ? [] : IR.values[p.fills] || [],
    children: (KIDS.get(i) || []).map((c) => irTree(c, m6(abs, IR.nodes[c].props.relativeTransform))) };
}
// A vector exports at the bounds of what it draws (its IR drawing: the box the judge holds Figma to,
// class vectorBox), which this rasteriser leaves empty.
const DRAWING = ["VECTOR", "BOOLEAN_OPERATION"];
function pixsoNode(i) {
  const r = IR.nodes[i];
  return { type: r.type, name: r.name, width: r.props.width, height: r.props.height,
    audit: (scale) => {
      const abs = absRec(i), t = irTree(i, abs);
      const d = DRAWING.indexOf(r.type) >= 0 ? drawingBox(r.props, (k) => IR.values[k]) : null;
      if (d) {
        const at = m6(abs, [1, 0, d.x0, 0, 1, d.y0]), dw = d.x1 - d.x0, dh = d.y1 - d.y0;
        const cs = [[0, 0], [dw, 0], [0, dh], [dw, dh]].map(([x, y]) => [at[0] * x + at[1] * y + at[2], at[3] * x + at[4] * y + at[5]]);
        const rx = Math.min(...cs.map((q) => q[0])), ry = Math.min(...cs.map((q) => q[1]));
        const render = { x: rx, y: ry, width: Math.max(...cs.map((q) => q[0])) - rx, height: Math.max(...cs.map((q) => q[1])) - ry };
        const png = pngOf(rasterize({ abs: to2(at), type: r.type, w: dw, h: dh, opacity: r.props.opacity, fills: [], children: [] }, { scale, ownOpacity: true, margin: 0 }));
        const bs = [[0, 0], [t.w, 0], [0, t.h], [t.w, t.h]].map(([x, y]) => [abs[0] * x + abs[1] * y + abs[2], abs[3] * x + abs[4] * y + abs[5]]);
        const bx = Math.min(...bs.map((q) => q[0])), by = Math.min(...bs.map((q) => q[1]));
        const box = { x: bx, y: by, width: Math.max(...bs.map((q) => q[0])) - bx, height: Math.max(...bs.map((q) => q[1])) - by };
        return { w: t.w, h: t.h, type: r.type, opacity: typeof r.props.opacity === "number" ? r.props.opacity : 1, box, render, n: png.length, d: png.toString("base64") };
      }
      const xs = [[0, 0], [t.w, 0], [0, t.h], [t.w, t.h]].map(([x, y]) => [abs[0] * x + abs[1] * y + abs[2], abs[3] * x + abs[4] * y + abs[5]]);
      const x0 = Math.min(...xs.map((q) => q[0])), y0 = Math.min(...xs.map((q) => q[1]));
      const box = { x: x0, y: y0, width: Math.max(...xs.map((q) => q[0])) - x0, height: Math.max(...xs.map((q) => q[1])) - y0 };
      // Pixso's export carries the node's own opacity, as Figma's does (§16.2: max alpha 51 = 0.2 × 255
      // on both sides of the U audit's roots at 0.2); this fake left it out until then.
      const png = pngOf(rasterize(t, { scale, ownOpacity: true, margin: 0 }));
      return { w: t.w, h: t.h, type: r.type, opacity: typeof r.props.opacity === "number" ? r.props.opacity : 1, box, render: null, n: png.length, d: png.toString("base64") };
    } };
}
const IDENTITY = { file: IR.header.source.documentName, fileKey: null, pageIds: IR.pages.filter((p) => !p.internal).map((p) => p.guid) };
function pixsoState(S) {
  S.identity = JSON.parse(JSON.stringify(IDENTITY));
  S.nodes = new Map(IR.nodes.map((r, i) => [r.guid, pixsoNode(i)]));
  return S;
}
// The same answers in process, for the passes that need no HTTP (the real channel runs the first pass).
function localPixso() {
  const S = pixsoState({ scripts: [] });
  return { S, run: async (src) => {
    const p = readOnlyProblems(src);
    if (p.length) return { ok: false, refused: true, error: p.join("; ") };
    S.scripts.push(src);
    const m = /^const ARGS = (.*);$/m.exec(src), a = m ? JSON.parse(m[1]) : null;
    if (src.indexOf("px:identity") >= 0 && !a) return { ok: true, value: S.identity };
    if (src.indexOf("// px:sample") === 0) return { ok: true, value: a.guids.map((g) => { const n = S.nodes.get(g); return n ? { id: g, type: n.type, name: n.name } : { id: g, missing: true }; }) };
    if (src.indexOf("// px:audit-render") === 0) { const n = S.nodes.get(a.guid); return { ok: true, value: n ? n.audit(a.scale) : { e: "no node" } }; }
    return { ok: false, error: "not a script of the library" };
  } };
}

const quietLog = [];
const qlog = (m) => quietLog.push(String(m));
const auditOf = async (run, io, args) => {
  const o = parseAuditArgs([run.runDir].concat(args || []));
  rmSync(join(run.runDir, "audit"), { recursive: true, force: true });
  return auditFolder(run.runDir, o, Object.assign({ log: qlog }, io));
};
const rootOf = (res, i) => res.audit.roots.find((e) => e.i === i);

// ============================================================================================
// 1. settings, the script, the pictures' rules
// ============================================================================================
{
  const d = defaultAuditSettings();
  check(d.maxSide === 800 && d.ink === 191 && d.grossMax === 0.01 && d.meanMax === 5 && d.section === "crop" && d.placeholders === "mask" && d.opacity === "both" &&
    d.sizeTol === 1 && d.tileMeanMax === 0 && d.register === "bounds" && d.registerFitPx === 4 && d.sizeBy === "drawn" && d.drawnAlpha === 16 &&
    d.placeholderExtent === "drawn" && d.glyphNotes === "mask" && d.hairlines === "band" && d.blank === "not-compared" && d.hiddenInSource === "skip" &&
    d.drawnBy === "alpha" && d.drawnWhiteTol === 16 &&
    Object.keys(AUDIT_SETTINGS).every((f) => AUDIT_SETTINGS[f][2] !== undefined),
    "every policy is a setting with a stated default (" + Object.keys(AUDIT_SETTINGS).length + " settings)");
  let refused = 0;
  for (const bad of [["x", "--section", "middle"], ["x", "--gross-max", "2"], ["x", "--max-side", "nope"], ["x", "--accept-identity-mismatch"], ["x", "--wat"], []]) {
    try { parseAuditArgs(bad); } catch (e) { refused++; }
  }
  check(refused === 6, "a bad value, an unknown flag, an identity override with no reason and a missing run folder are refused");
  const src = SCRIPTS.auditRender("1:2", { scale: 0.5 });
  check(readOnlyProblems(src).length === 0 && assertReadOnlyScript(src), "Pixso's audit render script passes the read-only check");
  let threw = 0;
  for (const bad of [["x", { scale: 1 }], ["1:2", { scale: 0 }], ["1:2", { scale: 100 }]]) { try { SCRIPTS.auditRender(bad[0], bad[1]); } catch (e) { threw++; } }
  check(threw === 3, "its arguments are checked: a guid and a scale from 0.01 to 16");

  // Placing the box: by render bounds, by the box, centred when only a margin explains the size.
  const s = 2, size = [100, 50], lin = [1, 0, 0, 0, 1, 0];
  const pr = placeBox({ W: 220, H: 120, box: { x: 10, y: 10, width: 100, height: 50 }, render: { x: 5, y: 5, width: 110, height: 60 } }, s, size, lin);
  const pb = placeBox({ W: 200, H: 100, box: { x: 0, y: 0, width: 100, height: 50 }, render: null }, s, size, lin);
  const pc = placeBox({ W: 220, H: 120, box: { x: 0, y: 0, width: 100, height: 50 }, render: { x: 0, y: 0, width: 100, height: 50 } }, s, size, lin);
  const pn = placeBox({ W: 100, H: 40, box: null, render: null }, s, size, lin);
  check(pr.rule === "render bounds" && pr.ox === 10 && pr.oy === 10 && pb.rule === "box" && pb.ox === 0 && pc.rule === "centred (guessed)" && pc.ox === 10 && pc.oy === 10 && pn === null,
    "the box is placed by the render bounds, else by the box, else centred (and said so); a picture smaller than the box is not placed", show([pr, pb, pc, pn]));

  // Over white: a transparent pixel is the same whatever its colour channels hold.
  const img = (W, H, f) => { const rgba = Buffer.alloc(W * H * 4); for (let k = 0; k < W * H; k++) f(rgba, k * 4); return { W, H, rgba }; };
  const black0 = img(4, 4, (b, o) => { b[o] = b[o + 1] = b[o + 2] = 0; b[o + 3] = 0; });
  const white0 = img(4, 4, (b, o) => { b[o] = b[o + 1] = b[o + 2] = 255; b[o + 3] = 0; });
  const S = defaultAuditSettings();
  const t = comparePictures({ img: black0, crop: null, masks: [] }, { img: white0, crop: null, masks: [] }, S);
  check(t.same === 1 && t.mean === 0, "a transparent pixel is laid over white before it is compared (Pixso's 0,0,0 and Figma's 255,255,255 agree)", show(t));
  const red = img(4, 4, (b, o) => { b[o] = 255; b[o + 3] = 255; });
  const faded = scaleAlpha(red, 0.32);
  const raw = comparePictures({ img: faded, crop: null, masks: [] }, { img: red, crop: null, masks: [] }, S);
  const undone = comparePictures({ img: scaleAlpha(faded, 1 / 0.32), crop: null, masks: [] }, { img: red, crop: null, masks: [] }, S);
  check(raw.mean > S.meanMax && undone.mean === 0, "a picture at 32 % opacity against one at 100 % differs (mean " + raw.mean + "); with the opacity undone it does not", show([raw, undone]));
}

// ============================================================================================
// 2. the clean run
// ============================================================================================
const GOOD = await buildRun("good");
{
  const g = m1Gates(GOOD.totals, GOOD.states, { ir: IR });
  check(!g.failed.length, "the run with the audit's cases passes every gate on the double", g.verdict);
}
const PX = fakePixso();
await PX.listen();
pixsoState(PX);
const FIG = figmaHost(GOOD.D);
let CLEAN;
{
  const mcp = makeMcpClient({ dir: join(SCRATCH, "mcp-clean"), url: PX.url });
  CLEAN = await auditOf(GOOD, { mcp, figmaExport: FIG.exportJob });
  const A = CLEAN.audit;
  // The toy rasteriser draws no text, path or line: a root holding only those draws nothing in either
  // engine, and is not compared (two blank pictures prove nothing).
  const blank = A ? A.roots.filter((e) => e.ok === null) : [];
  const notOk = A ? A.roots.filter((e) => e.ok !== true && !(e.ok === null && e.class === "blank" && /^not compared: neither engine draws anything/.test(e.why))) : [];
  check(CLEAN.code === 2 && A && A.counts.failed === 0 && A.counts.notCompared === blank.length && A.counts.blank === blank.length && blank.length > 0 && notOk.length === 0 &&
    A.counts.ok + A.counts.blank === A.counts.roots,
    "the clean run, through the real Pixso channel: every root that draws is ok (" + (A ? A.counts.ok : 0) + " of " + (A ? A.counts.roots : 0) + "), the " +
    blank.length + " that draw nothing in either engine are not compared", show(notOk.map((e) => [e.i, e.type, e.why])) + " " + quietLog.slice(-5).join(" | "));
  const accB = accept(GOOD.runDir, { audit: A });
  check(/^BUILT, NOT VISUALLY AUDITED/.test(accB.gates.verdict) && new RegExp(blank.length + " not compared").test(accB.gates.auditLine),
    "m1-accept with it reads BUILT, NOT VISUALLY AUDITED: a root not compared covers nothing", accB.gates.verdict + " | " + accB.gates.auditLine);
  PX.scripts.length = 0;
  // The first pass's rule kept: two blank pictures compare equal, every root is ok, and PASS reads.
  CLEAN = await auditOf(GOOD, { mcp, figmaExport: FIG.exportJob }, ["--blank", "compare"]);
  const B = CLEAN.audit;
  check(CLEAN.code === 0 && B && B.counts.failed === 0 && B.counts.notCompared === 0 && B.counts.ok === B.counts.roots,
    "with --blank compare (the first pass's rule) every root is ok (" + (B ? B.counts.ok : 0) + " of " + (B ? B.counts.roots : 0) + ")", show(B && B.counts));
  check(PX.scripts.every((s) => readOnlyProblems(s).length === 0) && PX.scripts.some((s) => s.indexOf("// px:audit-render") === 0) &&
    PX.scripts.findIndex((s) => s.indexOf("px:identity") >= 0) < PX.scripts.findIndex((s) => s.indexOf("// px:audit-render") === 0),
    "every script Pixso received is read-only, and the identity check came before the first render");
  const placeholderRoots = IR.nodes.map((r, i) => i).filter((i) => GOOD.states.tasks.some((t) => t.op === "build" && t.roots.indexOf(i) >= 0) && IR.nodes[i].type === "INSTANCE");
  check(A && A.placeholderRoots.length === placeholderRoots.length && placeholderRoots.length > 0 && A.roots.every((e) => IR.nodes[e.i].type !== "INSTANCE"),
    "the " + placeholderRoots.length + " roots that are placeholders are not rendered: listed for G11", show(A && A.placeholderRoots));
  check(A && A.format === "pix2fig.audit" && A.version === 2 && A.snapshot === GOOD.states.snapshot && A.runId === RUN && A.roots.every((e) => e.guid === IR.nodes[e.i].guid) &&
    existsSync(join(GOOD.runDir, "audit", "audit.json")) && existsSync(join(GOOD.runDir, "audit", "roots.jsonl")),
    "the audit is version 2 and names its run: snapshot, runId and each root's guid; audit.json and roots.jsonl are in the run folder");
  const acc = accept(GOOD.runDir, { audit: JSON.parse(readFileSync(join(GOOD.runDir, "audit", "audit.json"), "utf8")) });
  check(/^PASS/.test(acc.gates.verdict) && /placeholder roots left to G11/.test(acc.gates.auditLine),
    "m1-accept with that audit reads PASS: every built root covered, the placeholder roots left to G11", acc.gates.verdict + " | " + acc.gates.auditLine);
  CLEAN = await auditOf(GOOD, { mcp: localPixso(), figmaExport: FIG.exportJob });

  const r8 = rootOf(CLEAN, 8);
  check(r8 && r8.ok === true && r8.compared && r8.opacity.value === 0.32 && r8.opacity.rule === "undone in both pictures" && r8.metrics.mean === 0 &&
    r8.opacity.maxAlpha.figma === 82 && r8.opacity.maxAlpha.pixso === 82 && r8.opacity.maxAlpha.atOpacity === 82,
    "a root at 32 % opacity passes: both engines export it at its opacity (max alpha 82 on both sides), and the audit undoes it in both", show(r8 && r8.opacity));
  const r2 = rootOf(CLEAN, 2);
  check(r2 && r2.ok === true && r2.masks.placeholders === 1 && r2.masks.maskedShare > 0 && r2.metrics.gross === 0,
    "a placeholder's region is masked out of both pictures (" + (r2 ? (r2.masks.maskedShare * 100).toFixed(2) : "?") + " % of the root) and the root passes", show(r2));
  const r50 = rootOf(CLEAN, 50);
  check(r50 && r50.ok === true && r50.crop === "the node's box" && r50.figma.place === "centred (guessed)" && r50.pixso.place === "box" &&
    r50.figma.picture[0] > r50.pixso.picture[0],
    "a section rendered with a wider margin in Figma (" + (r50 ? r50.figma.picture.join("x") + " against " + r50.pixso.picture.join("x") : "?") + ") passes, cut to its box", show(r50));
  PX.scripts.length = 0;
}

// ============================================================================================
// 3. the settings that take a rule away, and the other ways through
// ============================================================================================
const LP = localPixso();
{
  const cmp = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--placeholders", "compare"]);
  const r2 = rootOf(cmp, 2);
  check(r2 && r2.ok === false && r2.compared && /ink on one side|mean/.test(r2.why || ""),
    "with --placeholders compare the placeholder's root fails: Pixso draws the instance, Figma an empty frame", show(r2 && [r2.why, r2.metrics]));
  const none = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--section", "none", "--register", "top-left", "--size-by", "picture"]);
  const s0 = rootOf(none, 50);
  const noneR = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--section", "none"]);
  const s0r = rootOf(noneR, 50);
  check(s0 && s0.ok === false && /differ in size/.test(s0.why || "") && s0r && s0r.ok === true && s0r.register.offset.join() === "5,5",
    "with --section none the section fails on its margin under the first pass's top-left registration and picture sizes; registered, its empty margin is no difference",
    show([s0 && s0.why, s0r && [s0r.why, s0r.register]]));
  const kids = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--section", "children"]);
  const s1 = rootOf(kids, 50);
  check(s1 && s1.ok === true && Array.isArray(s1.children) && s1.children.length === 1 && s1.children[0].i === 51 && s1.children[0].ok === true && /own fill is not compared/.test(s1.section),
    "with --section children the section passes child by child, and says its own fill is not compared", show(s1 && s1.children));
  // The first pass's rules assumed Pixso's picture opaque: undoing the opacity in Figma's picture only
  // fails the root (as it failed the U audit's 3 roots at 0.2), and applying it again to Pixso's makes
  // the pictures differ (at this low contrast, under the threshold).
  const undo = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--opacity", "undo"]);
  const u8 = rootOf(undo, 8);
  const apply = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--opacity", "apply"]);
  const a8 = rootOf(apply, 8);
  const raw = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--opacity", "none"]);
  const n8 = rootOf(raw, 8);
  check(u8 && u8.ok === false && u8.opacity.rule === "undone in Figma's picture" && a8 && a8.metrics.mean > 0 && a8.opacity.rule === "applied to Pixso's picture" &&
    n8 && n8.ok === true && n8.metrics.mean === 0 && n8.opacity.rule === "compared as exported",
    "the first pass's one-sided rules make the 32 % root's pictures differ (--opacity undo fails it: " + (u8 && u8.why) + "); --opacity none compares them as exported",
    show([u8 && u8.why, a8 && a8.metrics, n8 && n8.opacity]));
  // Root 2 holds an image the archive does not hold: Figma drew the grey IMAGE_PLACEHOLDER paint.
  const tight = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--mean-max", "0.1"]);
  const t2 = rootOf(tight, 2);
  const tightM = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--mean-max", "0.1", "--image-placeholders", "mask"]);
  const m2 = rootOf(tightM, 2);
  check(t2 && t2.ok === false && t2.masks.imagePlaceholders === 1 && /IMAGE_PLACEHOLDER/.test(t2.why) && m2 && m2.ok === true && m2.masks.masked === 2 && m2.metrics.mean === 0,
    "an image the run could not carry differs by default and the root says it holds an IMAGE_PLACEHOLDER; --image-placeholders mask leaves it out", show([t2 && t2.why, m2 && m2.masks]));
  // Which pixels a picture draws (--drawn-by, §16.5): inside root 2's white frame Figma draws the grey
  // placeholder where Pixso draws nothing over the frame's white (the toy rasteriser draws no image).
  // By visible that white counts on Pixso's side, where Figma's is grey, and every root comes out as by
  // alpha; by ink it does not, and root 2's content difference becomes one of size. Each pass names its
  // settings, whatever the defaults.
  const io = { mcp: LP, figmaExport: FIG.exportJob };
  const byAlpha = await auditOf(GOOD, io, ["--drawn-by", "alpha"]), alphaT = rootOf(await auditOf(GOOD, io, ["--mean-max", "0.1", "--drawn-by", "alpha"]), 2);
  const unlike = [];
  let visT = null;
  for (const t of ["8", "16"]) {
    const vis = await auditOf(GOOD, io, ["--drawn-by", "visible", "--drawn-white-tol", t]);
    for (const e of vis.audit.roots) { const c = rootOf(byAlpha, e.i); if (!c || c.ok !== e.ok || c.why !== e.why) unlike.push([t, e.i, e.why]); }
    const v2 = rootOf(await auditOf(GOOD, io, ["--mean-max", "0.1", "--drawn-by", "visible", "--drawn-white-tol", t]), 2);
    if (!v2 || !alphaT || v2.why !== alphaT.why) unlike.push([t, 2, v2 && v2.why]);
    visT = v2;
  }
  const ink2 = rootOf(await auditOf(GOOD, io, ["--drawn-by", "ink", "--drawn-white-tol", "8"]), 2);
  check(unlike.length === 0 && byAlpha.audit.counts.failed === 0 && alphaT && alphaT.ok === false && !/differ in size/.test(alphaT.why) &&
    ink2 && ink2.ok === false && /differ in size/.test(ink2.why || ""),
    "by --drawn-by visible (within 8 and 16) every root of the fixture run comes out as by alpha, and root 2 under --mean-max 0.1 fails on its content alone (" +
    (visT && visT.why) + "); by ink root 2 differs in size (" + (ink2 && ink2.why) + ")", show([unlike, alphaT && alphaT.why, ink2 && [ink2.why, ink2.metrics.drawn]]));
  // A mask that covers the whole root leaves nothing to compare: not compared, never ok.
  const all = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--mask-pad", "1000", "--blank", "compare"]);
  const n2 = rootOf(all, 2);
  const accN = accept(GOOD.runDir, { audit: all.audit });
  check(all.code === 2 && n2 && n2.ok === null && !n2.compared && n2.class === "masked" && /not compared/.test(n2.why) && all.audit.counts.notCompared === 1 &&
    /^BUILT, NOT VISUALLY AUDITED/.test(accN.gates.verdict) && /1 not compared/.test(accN.gates.auditLine),
    "a root its masks cover whole is not compared (ok null, never true): the verdict stays BUILT, NOT VISUALLY AUDITED", show([n2 && n2.why, accN.gates.auditLine]));
  const sc = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--max-side", "100"]);
  const z8 = rootOf(sc, 8);
  check(z8 && z8.scale === 0.25 && z8.ok === true && z8.figma.picture[0] === 100, "both engines render at one scale from the IR box: --max-side 100 gives a 400 px root at 0.25", show(z8 && [z8.scale, z8.figma.picture]));
}

// ============================================================================================
// 4. a planted colour difference fails
// ============================================================================================
{
  const BAD = await buildRun("colour");
  BAD.nodeOf(20).fills = [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 0.1, g: 0.1, b: 0.9 } }];
  const res = await auditOf(BAD, { mcp: LP, figmaExport: figmaHost(BAD.D).exportJob });
  const r19 = rootOf(res, 19);
  const others = res.audit.roots.filter((e) => e.i !== 19 && e.ok === false);
  check(res.code === 3 && r19 && r19.ok === false && r19.compared && /ink on one side|mean/.test(r19.why || "") && !others.length,
    "a rectangle painted another colour in Figma after the build fails its root (" + (r19 ? r19.why : "?") + "), and only that root", show(others.map((e) => [e.i, e.why])));
  check(existsSync(join(BAD.runDir, "audit", "pictures", "19.figma.png")) && existsSync(join(BAD.runDir, "audit", "pictures", "19.pixso.png")) &&
    !existsSync(join(BAD.runDir, "audit", "pictures", "8.figma.png")), "both pictures of the failed root are kept, and none of a root that passed");
  const acc = accept(BAD.runDir, { audit: res.audit });
  check(/^FAIL \(audit\)/.test(acc.gates.verdict) && !acc.gates.gates.some((x) => x.fail), "m1-accept reads FAIL (audit) though every gate passes: a render difference no gate checks", acc.gates.verdict);
  // A low-contrast change moves the mean, not the share of ink on one side.
  const LOW = await buildRun("low");
  LOW.nodeOf(20).fills = [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 0.6, g: 0.3, b: 0.3 } }];
  const low = await auditOf(LOW, { mcp: LP, figmaExport: figmaHost(LOW.D).exportJob }, ["--mean-max", "0.5"]);
  const l19 = rootOf(low, 19);
  check(l19 && l19.ok === false && l19.metrics.gross === 0 && /mean difference/.test(l19.why || ""), "a low-contrast change has no ink on one side and still fails, on the mean", show(l19 && [l19.why, l19.metrics]));
}

// ============================================================================================
// 5. a missing render fails
// ============================================================================================
{
  const MISS = await buildRun("missing");
  MISS.nodeOf(22).remove();
  const sampled = new Set(sampleGuids(IR).map((i) => IR.nodes[i].guid));
  const gone = [8, 19, 25, 26, 27, 28].find((i) => !sampled.has(IR.nodes[i].guid));
  const P2 = localPixso();
  P2.S.nodes.delete(IR.nodes[gone].guid);
  const res = await auditOf(MISS, { mcp: P2, figmaExport: figmaHost(MISS.D).exportJob });
  const f = rootOf(res, 22), p = rootOf(res, gone);
  check(res.code === 3 && f && f.ok === false && !f.compared && /figma render missing: not found/.test(f.why) && p && p.ok === false && !p.compared && /pixso render missing: no node/.test(p.why) &&
    res.audit.counts.missing === 2,
    "a root gone from Figma and a node gone from Pixso each fail as a missing render, never ok (" + [f && f.why, p && p.why].join(" | ") + ")");
  const acc = accept(MISS.runDir, { audit: res.audit });
  check(/FAIL/.test(acc.gates.verdict) && acc.gates.failed.indexOf("audit") >= 0, "and the verdict fails on the audit", acc.gates.verdict);
}

// ============================================================================================
// 6. the open Pixso file must be the run's .pix
// ============================================================================================
{
  const P3 = localPixso();
  P3.S.identity.file = "Another file";
  const before = FIG.calls();
  const res = await auditOf(GOOD, { mcp: P3, figmaExport: FIG.exportJob });
  check(res.code === 4 && !res.audit && FIG.calls() === before && !P3.S.scripts.some((s) => s.indexOf("// px:audit-render") === 0) &&
    !existsSync(join(GOOD.runDir, "audit", "audit.json")),
    "SOURCE_IDENTITY_MISMATCH stops the audit: nothing rendered in either engine, no audit written");
  // The command itself asks Pixso before it opens the plugin session: with Pixso away it stops there.
  rmSync(join(GOOD.runDir, "audit"), { recursive: true, force: true });
  const said = [], log0 = console.log;
  console.log = (m) => said.push(String(m));
  let code;
  try { code = await auditMain([GOOD.runDir, "--mcp-url", "http://127.0.0.1:9/mcp"]); } finally { console.log = log0; }
  check(code === 1 && said.some((l) => /Pixso is not reachable/.test(l)) && !said.some((l) => /plugin build|Код/.test(l)) && !existsSync(join(GOOD.runDir, "audit", "audit.json")),
    "tools/ir-audit.mjs with Pixso away stops before the plugin session is opened, and writes no audit", said.join(" | "));
  const go = await auditOf(GOOD, { mcp: P3, figmaExport: FIG.exportJob }, ["--accept-identity-mismatch", "renamed nodes"]);
  check(go.code === 2 && go.audit.counts.failed === 0 && go.audit.identity.code === "SOURCE_IDENTITY_MISMATCH" && go.audit.identity.accepted === "renamed nodes" && /root name differs/.test(go.audit.identity.detail),
    "--accept-identity-mismatch goes on and records the difference and the reason in the audit", show(go.audit && go.audit.identity));
}

// The plugin open in another Figma file: every verified id is not found there. The audit stops after
// the first few roots and says so, instead of failing every root (the live audit of 2026-10-06).
{
  quietLog.length = 0;
  let asked = 0;
  const res = await auditOf(GOOD, { mcp: LP, figmaExport: async () => { asked++; return { e: "not found: the node is gone" }; } });
  check(res.code === 1 && asked <= 6 && quietLog.some((l) => /another Figma file/.test(l)) && !existsSync(join(GOOD.runDir, "audit", "audit.json")),
    "with the plugin in another Figma file the audit stops after the first roots, says why, and writes no audit", JSON.stringify({ code: res.code, asked }));
}

// Pixso cannot parse a script in which a function declaration comes before an await statement, and
// answers { error } as an ordinary result (the next live audit, 2026-10-06: every render came back as
// "no picture"). The library holds no such script, the static check refuses one, the channel reads
// Pixso's { error } as a failed script, and the audit stops after the first roots when Pixso gives
// no picture for any of them.
{
  const bad = "// px:x (read-only)\nconst ARGS = {};\nfunction x() { return 1; }\nawait pixso.loadAllPagesAsync();\nreturn x();";
  const lib = [SCRIPTS.auditRender("1:2", { scale: 1 }), SCRIPTS.imageBytes("0".repeat(40)), SCRIPTS.imageRange("0".repeat(40), 0, 1), SCRIPTS.render("1:2"), SCRIPTS.sample(["1:2"])];
  check(readOnlyProblems(bad).some((p) => /function declaration before a statement that starts with await/.test(p)) && lib.every((s) => readOnlyProblems(s).length === 0),
    "the static check refuses a function declaration before an await statement, and passes every library script");
  PX.fails = { "9:9": "SyntaxError: expecting ';'" };
  const r = await makeMcpClient({ dir: join(SCRATCH, "mcp-parse"), url: PX.url }).run("// px:fake-object 9:9\nreturn 1;");
  PX.fails = {};
  check(r.ok === false && !r.transport && /the script failed in Pixso: SyntaxError: expecting/.test(r.error || ""),
    "Pixso's { error } answer is a failed script, not a value", JSON.stringify(r));
  quietLog.length = 0;
  let asked = 0;
  const refusing = { run: async (src) => {
    if (src.indexOf("// px:audit-render") !== 0) return LP.run(src);
    asked++;
    return { ok: false, transport: false, refused: false, error: "the script failed in Pixso: SyntaxError: expecting ';'" };
  } };
  const res = await auditOf(GOOD, { mcp: refusing, figmaExport: FIG.exportJob });
  check(res.code === 1 && asked <= 6 && quietLog.some((l) => /Pixso gave no picture/.test(l) && /SyntaxError/.test(l)) && !existsSync(join(GOOD.runDir, "audit", "audit.json")),
    "with every Pixso render refused the audit stops after the first roots, says why, and writes no audit", JSON.stringify({ code: res.code, asked }));
}

// ============================================================================================
// 7. a second pass, the snapshot, and the verdict's reading of an audit
// ============================================================================================
{
  const o = parseAuditArgs([GOOD.runDir]);
  rmSync(join(GOOD.runDir, "audit"), { recursive: true, force: true });
  await auditFolder(GOOD.runDir, o, { mcp: LP, figmaExport: FIG.exportJob, log: qlog });
  const n0 = FIG.calls();
  const again = await auditFolder(GOOD.runDir, o, { mcp: LP, figmaExport: FIG.exportJob, log: qlog });
  const n1 = FIG.calls();
  const fresh = await auditFolder(GOOD.runDir, Object.assign({}, o, { fresh: true }), { mcp: LP, figmaExport: FIG.exportJob, log: qlog });
  // Only a root that was ok is kept: the ones not compared are rendered again.
  const nc = again.audit ? again.audit.counts.notCompared : -1;
  check(again.code === 2 && nc > 0 && n1 - n0 === nc && fresh.code === 2 && FIG.calls() - n1 === fresh.audit.counts.roots,
    "a second pass keeps every root already ok under the same settings and run (no render; the " + nc + " not compared are rendered again); --fresh renders them all again");
  const n2 = FIG.calls();
  const other = await auditFolder(GOOD.runDir, parseAuditArgs([GOOD.runDir, "--mean-max", "4"]), { mcp: LP, figmaExport: FIG.exportJob, log: qlog });
  check(other.code === 2 && FIG.calls() - n2 === other.audit.counts.roots, "a pass under another threshold renders every root again");

  const r = rootOf(CLEAN, 19);
  const wrong = await FIG.exportJob({ op: "export", id: r.figma.id, src: r.guid, snap: "0".repeat(16), constraint: { type: "SCALE", value: 1 } });
  const right = await FIG.exportJob({ op: "export", id: r.figma.id, src: r.guid, snap: GOOD.states.snapshot, constraint: { type: "SCALE", value: 1 } });
  check(wrong.e && !wrong.d && /another snapshot/.test(wrong.e) && right.d && right.box && right.render && right.type === "FRAME" && right.opacity === 1,
    "the RENDER export refuses a copy of the root built from another snapshot, and reports the node's box, render bounds, type and opacity", show([wrong.e, right.box]));

  const roots = GOOD.states.tasks.filter((t) => t.op === "build").flatMap((t) => t.roots);
  const req = roots.filter((i) => IR.nodes[i].type !== "INSTANCE");
  const base = { format: "pix2fig.audit", version: 2, snapshot: GOOD.states.snapshot, runId: RUN };
  const entries = (f) => req.map((i) => ({ i, guid: IR.nodes[i].guid, ok: f(i) }));
  const g1 = m1Gates(GOOD.totals, GOOD.states, { ir: IR, audit: Object.assign({ roots: entries((i) => (i === req[0] ? null : true)) }, base) });
  const g2 = m1Gates(GOOD.totals, GOOD.states, { ir: IR, audit: Object.assign({ roots: entries(() => true) }, base) });
  const g3 = m1Gates(GOOD.totals, GOOD.states, { audit: Object.assign({ roots: entries(() => true) }, base) });
  check(/^BUILT, NOT VISUALLY AUDITED/.test(g1.verdict) && /1 not compared/.test(g1.auditLine) && /^PASS/.test(g2.verdict) && /^BUILT, NOT VISUALLY AUDITED/.test(g3.verdict),
    "the verdict: a root not compared covers nothing and fails nothing; with the IR the placeholder roots are not required, without it they are", [g1.auditLine, g2.auditLine, g3.auditLine].join(" | "));
}

// ============================================================================================
// 8. what the audit must not take for this run's root
// ============================================================================================
{
  const CP = await buildRun("copies");
  const H = figmaHost(CP.D);
  // A verify that has not run to the end (its report may be an earlier build's) gives no Figma id.
  const st = JSON.parse(JSON.stringify(CP.states));
  const v = st.tasks.find((t) => t.op === "verify" && Number.isInteger(t.build));
  v.state = "failed";
  const bRoots = st.tasks.find((t) => t.taskNo === v.build).roots;
  const { roots } = auditRoots(st, IR, readRun(CP.runDir).reports);
  const of = roots.filter((r) => bRoots.indexOf(r.i) >= 0), rest = roots.filter((r) => bRoots.indexOf(r.i) < 0);
  check(of.length > 0 && of.every((r) => r.figmaId === null) && rest.every((r) => typeof r.figmaId === "string"),
    "a root whose verify is not done gets no Figma id from a report left in the folder (" + of.length + " root" + (of.length === 1 ? "" : "s") + "): a missing render", show(of));
  // An earlier run's copy of root 19 (the same .pix: the same pxSrc, pxIdx, pxSnap and pxIr, another
  // pxRun) is in the file, and the node the verify found is gone: the export takes no other copy.
  const mine = CP.nodeOf(19), impostor = CP.nodeOf(8);
  for (const k of ["pxSrc", "pxIdx", "pxSnap", "pxIr"]) impostor.setSharedPluginData("pix2fig", k, mine.getSharedPluginData("pix2fig", k));
  impostor.setSharedPluginData("pix2fig", "pxRun", "a0a0a0a0a0a0a0a0");
  mine.remove();
  // Section 50 gains a child in Figma that the IR does not have: its children no longer pair by index.
  const extra = CP.D.figma.createRectangle();
  CP.nodeOf(50).appendChild(extra);
  const res = await auditOf(CP, { mcp: LP, figmaExport: H.exportJob }, ["--section", "children"]);
  const r19 = rootOf(res, 19), r50 = rootOf(res, 50);
  check(r19 && r19.ok === false && !r19.compared && /figma render missing: not found/.test(r19.why) && !r19.figma,
    "a root whose verified node is gone is a missing render, though an earlier run's copy of the same source and snapshot is in the file", show(r19));
  check(r50 && r50.ok === false && /cannot be paired by index/.test(r50.why || ""),
    "with --section children a section whose Figma children outnumber the IR's fails: its children cannot be paired by index", show(r50 && r50.why));
}

// ============================================================================================
// 9. the pictures as Pixso exports them: every PNG colour type and bit depth
// ============================================================================================
// Pixso exports indexed PNGs (colour type 3 at 2, 4 and 8 bits, with tRNS); the first live audit
// failed 305 roots on "does not decode" (2026-10-06). The test writes each kind with its own small
// encoder, every filter type, odd widths so packed rows end mid-byte, and Adam7, and checks the
// RGBA the decoder gives against the samples it wrote.
{
  const crcT = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const CHN = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const ADAM = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const filterRow = (f, cur, prev, bpp) => {
    const out = Buffer.alloc(cur.length);
    for (let i = 0; i < cur.length; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let pr = 0;
      if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i] = (cur[i] - pr) & 255;
    }
    return out;
  };
  // samples[y][x] = [s0, s1, …] at the image's own depth.
  const writePNG = (W, H, color, depth, samples, opts) => {
    const o = opts || {}, CH = CHN[color], bits = CH * depth, bpp = Math.max(1, bits >> 3);
    const rows = [];
    let fi = 0;
    for (const [x0, y0, dx, dy] of o.interlace ? ADAM : [[0, 0, 1, 1]]) {
      const pw = Math.ceil((W - x0) / dx), ph = Math.ceil((H - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const stride = Math.ceil((pw * bits) / 8);
      let prev = Buffer.alloc(stride);
      for (let y = 0; y < ph; y++) {
        const cur = Buffer.alloc(stride);
        for (let x = 0; x < pw; x++) {
          const s = samples[y0 + y * dy][x0 + x * dx];
          for (let c = 0; c < CH; c++) {
            if (depth < 8) { const bit = x * depth; cur[bit >> 3] |= s[c] << (8 - depth - (bit & 7)); }
            else if (depth === 8) cur[x * CH + c] = s[c];
            else cur.writeUInt16BE(s[c], (x * CH + c) * 2);
          }
        }
        const f = fi++ % 5;
        rows.push(Buffer.from([f]), filterRow(f, cur, prev, bpp));
        prev = cur;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = o.interlace ? 1 : 0;
    const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
    if (o.plte) parts.push(chunk("PLTE", o.plte));
    if (o.trns) parts.push(chunk("tRNS", o.trns));
    parts.push(chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)));
    return Buffer.concat(parts);
  };
  const W = 13, H = 9, kinds = [];
  for (const color of [0, 2, 3, 4, 6]) for (const depth of { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color]) for (const interlace of [false, true]) kinds.push({ color, depth, interlace });
  const bad = [];
  for (const k of kinds) {
    const max = (1 << k.depth) - 1, CH = CHN[k.color];
    const samples = [];
    for (let y = 0; y < H; y++) { samples.push([]); for (let x = 0; x < W; x++) samples[y].push(Array.from({ length: CH }, (_, c) => ((x * 7 + y * 13 + c * 29) * 2654435761 >>> 0) % (max + 1))); }
    const to8 = (v) => (k.depth === 16 ? v >> 8 : k.depth === 8 ? v : Math.round((v * 255) / max));
    const opts = { interlace: k.interlace };
    let expect;
    if (k.color === 3) {
      const n = max + 1, plte = Buffer.alloc(n * 3), trns = Buffer.alloc(Math.max(1, n >> 1));
      for (let j = 0; j < n; j++) { plte[j * 3] = (j * 37) & 255; plte[j * 3 + 1] = (j * 91) & 255; plte[j * 3 + 2] = (j * 53) & 255; }
      for (let j = 0; j < trns.length; j++) trns[j] = (j * 61) & 255;
      opts.plte = plte; opts.trns = trns;
      expect = (s) => [plte[s[0] * 3], plte[s[0] * 3 + 1], plte[s[0] * 3 + 2], s[0] < trns.length ? trns[s[0]] : 255];
    } else if (k.color === 0 || k.color === 2) {
      const keyS = samples[1][2];
      const trns = Buffer.alloc(2 * CH); keyS.forEach((v, c) => trns.writeUInt16BE(v, c * 2));
      opts.trns = trns;
      expect = (s) => { const g = k.color === 0 ? [s[0], s[0], s[0]] : s; return [to8(g[0]), to8(g[1]), to8(g[2]), s.every((v, c) => v === keyS[c]) ? 0 : 255]; };
    } else if (k.color === 4) expect = (s) => [to8(s[0]), to8(s[0]), to8(s[0]), to8(s[1])];
    else expect = (s) => s.map(to8);
    let im = null, err = null;
    try { im = decodePNG(writePNG(W, H, k.color, k.depth, samples, opts)); } catch (e) { err = e.message; }
    let wrong = err ? 1 : 0;
    if (im) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const e = expect(samples[y][x]), d = (y * W + x) * 4; if (e.some((v, c) => im.rgba[d + c] !== v)) wrong++; }
    if (wrong || !im || im.W !== W || im.H !== H) bad.push({ kind: k, wrong, err });
  }
  check(bad.length === 0, "every PNG colour type and bit depth decodes to the RGBA it holds, filtered, packed and interlaced (" + kinds.length + " kinds)", show(bad.slice(0, 4)));
  const refused = [];
  for (const [what, png] of [["depth 4 RGB", writePNG(2, 2, 2, 8, [[[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 0]]]).fill(4, 24, 25)],
    ["indexed without PLTE", writePNG(2, 2, 3, 8, [[[0], [0]], [[0], [0]]])],
    ["index past the palette", writePNG(2, 1, 3, 8, [[[0], [5]]], { plte: Buffer.from([1, 2, 3]) })]]) {
    try { decodePNG(png); refused.push(what + ": decoded"); } catch (e) { if (!/depth|PLTE|palette|CRC|colour/.test(e.message)) refused.push(what + ": " + e.message); }
  }
  check(refused.length === 0, "a PNG the standard does not allow, an indexed PNG without a palette, and an index past the palette are refused with a reason", show(refused));
}

// A picture drawn from rectangles with box-filter coverage, so an edge at a fraction of a pixel is
// anti-aliased (sections 10 and 11).
const art = (W, H, rects) => {
  const rgba = Buffer.alloc(W * H * 4);
  for (const q of rects || []) {
    const [x0, y0, x1, y1] = q.box, c = q.c || [30, 30, 30], a = q.a === undefined ? 1 : q.a;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
      const cy = Math.min(y + 1, y1) - Math.max(y, y0);
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
        const al = (Math.min(x + 1, x1) - Math.max(x, x0)) * cy * a;
        if (al <= 0) continue;
        const k = (y * W + x) * 4, da = rgba[k + 3] / 255, oa = al + da * (1 - al);
        for (let ch = 0; ch < 3; ch++) rgba[k + ch] = Math.round((c[ch] * al + rgba[k + ch] * da * (1 - al)) / oa);
        rgba[k + 3] = Math.round(oa * 255);
      }
    }
  }
  return { W, H, rgba };
};

// ============================================================================================
// 10. what the first live pass taught the audit (docs/M1.md §16.2)
// ============================================================================================
// Each case is a small IR and two pictures drawn here, handed to auditRun directly: "Figma" and "Pixso"
// answer as the plugin's export and the read-only script do (a PNG, the box, the render bounds when the
// engine has them, the opacity). A picture is drawn from rectangles with box-filter coverage (art), so
// an edge at a fraction of a pixel is anti-aliased, and it starts at what it draws, as both engines'
// exports do. Every case is also run under the first pass's settings, where it fails.
{
  const OLD = ["--register", "top-left", "--size-by", "picture", "--placeholder-extent", "box", "--opacity", "undo", "--blank", "compare",
    "--hidden-in-source", "compare", "--glyph-notes", "compare", "--hairlines", "pixel"];
  let gs = 0;
  const rec = (parent, type, w, h, x, y, props, extra) => Object.assign({ parent, guid: "9:" + (++gs), type, name: type,
    props: Object.assign({ relativeTransform: [1, 0, x, 0, 1, y], width: w, height: h }, props || {}) }, extra || {});
  // F, P: { record index: { img, box, render, opacity } }; P's { empty: true } is Pixso's 0-byte export.
  // draw(scale) in place of img draws the picture at the scale asked, as both engines' exports do (a
  // fixed img is the same picture at any scale: an engine whose finer export is not finer).
  const unit = async (ir, roots, F, P, args, more) => {
    const S = parseAuditArgs(["unit"].concat(args || [])).settings;
    const states = { snapshot: "5".repeat(16), runId: RUN, tasks: [{ op: "build", taskNo: 1, roots }, { op: "verify", taskNo: 2, state: "built", build: 1 }] };
    const reports = new Map([[2, { taskNo: 2, roots: roots.map((i) => ({ i, found: true, id: "u:" + i })) }]]);
    const byGuid = new Map(ir.nodes.map((r, i) => [r.guid, i]));
    const calls = { figma: 0, pixso: 0, scales: [] };
    const A = await auditRun(Object.assign({ states, ir, reports, builds: new Map(), settings: S,
      figmaExport: async (job) => {
        calls.figma++; calls.scales.push(job.constraint.value);
        const i = byGuid.get(job.src), f = F[i], r = ir.nodes[i], png = pngOf(f.draw ? f.draw(job.constraint.value) : f.img);
        return { w: r.props.width, h: r.props.height, type: r.type, opacity: f.opacity === undefined ? 1 : f.opacity, box: f.box, render: f.render || null, bytes: png.length, d: png.toString("base64") };
      },
      pixsoRender: async (guid, scale) => {
        calls.pixso++;
        const i = byGuid.get(guid), p = P[i], r = ir.nodes[i];
        const head = { w: r.props.width, h: r.props.height, type: r.type, opacity: p.opacity === undefined ? 1 : p.opacity, box: p.box, render: p.render || null };
        if (p.empty) return { ok: true, value: Object.assign(head, { n: 0, d: "" }) };
        const png = pngOf(p.draw ? p.draw(scale) : p.img);
        return { ok: true, value: Object.assign(head, { n: png.length, d: png.toString("base64") }) };
      } }, more || {}));
    return { A, calls, e: (i) => A.roots.find((x) => x.i === i) };
  };
  const BLUE = [23, 120, 234], DARK = [30, 30, 30];
  // A condition (or a value for a message) that reads a field the first pass did not write is false
  // (undefined), not a crash: the checks run on the first pass's code as well.
  const holds = (f) => { try { return !!f(); } catch (err) { return false; } };
  const val = (f) => { try { return f(); } catch (err) { return undefined; } };
  const blank1 = art(1, 1, []);

  // C20. An arrow connector (the U audit's 32): a 2 px shaft whose ARROW_LINES cap reaches 7.4 px from it
  // in Figma and 6.66 px in Pixso, so the pictures, each starting at what it draws, are 15 and 14 px
  // across the line and the shaft lies 0.74 px apart in them. Figma reports render bounds, Pixso none.
  {
    const ir = { nodes: [rec(-1, "VECTOR", 100, 0, 0, 50)], values: [], notes: [] };
    const arrow = (reach, s) => { const k = s || 1; return art(100 * k, Math.ceil(reach * 2 * k), [{ box: [0, (reach - 1) * k, 100 * k, (reach + 1) * k] }, { box: [96 * k, 0, 100 * k, reach * 2 * k] }]); };
    const box = { x: 0, y: 50, width: 100, height: 0 };
    const F = { 0: { draw: (s) => arrow(7.4, s), box, render: { x: 0, y: 50 - 7.4, width: 100, height: 14.8 } } };
    const P = { 0: { draw: (s) => arrow(6.66, s), box } };
    const kept = [];
    const now = await unit(ir, [0], F, P, [], { onRoot: (x, pics) => { for (const p of pics) kept.push(p.name + (p.figma && p.pixso ? "" : " (one side)")); } });
    const old = await unit(ir, [0], F, P, ["--register", "top-left"]);
    const e = now.e(0), o = old.e(0);
    // What is left at 4x is the caps' own difference: 1.48 rows of a 4 px cap, about 0.9 of the mean.
    check(holds(() => e.ok === true && e.register.rule.join() === "same extent,fitted" && Math.abs(e.register.offset[1] - 0.74) <= 0.02 && e.register.supersample.k === 4 &&
      e.metrics.mean < 1.5 && now.calls.scales.join() === "1,4" && now.calls.pixso === 2 && kept.join() === "0,0@4x" && o.ok === false && o.metrics.mean > 5),
      "an arrow connector whose cap reaches 7.4 px in Figma and 6.66 in Pixso passes registered, searched on both engines' pictures at 4x, both kept (offset found " +
      val(() => e.register.offset[1]) + " px, mean " + val(() => e.metrics.mean) + "); aligned at the top left it fails (mean " + val(() => o.metrics.mean) + ")", show([e.register, e.metrics, now.calls, kept, o.why]));
    const one = await unit(ir, [0], F, P, ["--register-supersample", "1"]), e1 = one.e(0);
    check(holds(() => e1.ok === true && Math.abs(e1.register.offset[1] - 0.74) <= 0.15 && !e1.register.supersample && one.calls.figma === 1 && e1.metrics.mean > e.metrics.mean),
      "with --register-supersample 1 the search runs on the pictures as exported, resampled: offset " + val(() => e1.register.offset[1]) + " px, mean " + val(() => e1.metrics.mean),
      show([e1.register, e1.metrics]));
    // An engine whose export at 4x is the same picture: the search falls back to the pictures as exported.
    const same = (await unit(ir, [0], F, { 0: { img: arrow(6.66), box } })).e(0);
    check(holds(() => same.ok === true && same.register.supersample.used === false && /not 4 times the first/.test(same.register.supersample.why) && Math.abs(same.register.offset[1] - 0.74) <= 0.15),
      "an export at 4x that is not 4 times finer is not used: the search runs on the pictures as exported, and the root says why", show(same.register));
    const P2 = { 0: { draw: (s) => arrow(6.66, s), box, render: { x: 0, y: 50 - 6.66, width: 100, height: 13.32 } } };
    const two = await unit(ir, [0], F, P2), r = two.e(0), png2 = pngOf(arrow(6.66));
    check(holds(() => r.ok === true && r.register.rule.join() === "render bounds,render bounds" && r.register.offset.join() === "0,0.74" && two.calls.figma === 1),
      "with render bounds from both engines the offset is theirs, not searched (0.74 px)", show(r.register));
    check(holds(() => show(r.figma.box) === show(box) && show(r.figma.render) === show({ x: 0, y: 42.6, width: 100, height: 14.8 }) && show(r.pixso.box) === show(box) &&
      show(r.pixso.render) === show({ x: 0, y: 43.34, width: 100, height: 13.32 }) && r.pixso.bytes === png2.length && show(e.pixso.render) === "null"),
      "each root records both engines' box, render bounds and Pixso's byte count, so a later pass can re-judge it offline", show([r.figma, r.pixso]));
    const far = (await unit(ir, [0], F, P, ["--register-fit-px", "0"])).e(0);
    check(holds(() => far.register.rule[1] === "placed (render bounds, centred (guessed))" && Math.abs(far.register.offset[1] - (7.4 - 7)) < 1e-6),
      "with --register-fit-px 0 nothing is searched: each picture is placed by its own rule (Pixso's centred, recorded so)", show(far.register));
    // A picture 1 px over its box is not placed exactly, whatever the box's rounding noise (the review's
    // two roots of one geometry: boxes of 800 and 800.0000000000001, pictures of 801, placed by two rules).
    const L0 = [1, 0, 0, 0, 1, 0], pb = (W, H, h) => placeBox({ W, H, box: { x: 0, y: 0, width: 100, height: h }, render: null }, 1, [100, h], L0);
    const ex = [800, 800.0000000000001].map((h) => pb(100, 801, h).exact.join() + "/" + pb(100, 800, h).exact.join());
    const rg = [800, 800.0000000000001].map((h) => registration(pb(100, 801, h), pb(100, 800, h), [100, 801], [100, 800], defaultAuditSettings())[1].rule);
    check(ex.join() === "true,false/true,true,true,false/true,true" && rg.join() === "fitted,fitted",
      "a picture of 801 rows for a box of 800 is not placed exactly on that axis, with the box 800 or 800.0000000000001 alike, so both are searched", show([ex, rg]));
    // The same 2 px line drawn by both engines, Figma's picture 15 rows at phase 0 and Pixso's 16 at phase
    // 0.5 (the review's case): searched at 4x the pictures are one; resampled at 1x the split leaves 6.62.
    const lineIR = { nodes: [rec(-1, "VECTOR", 100, 0, 0, 0)], values: [], notes: [] }, lb = { x: 0, y: 0, width: 100, height: 0 };
    const line = (top, rows) => (s) => { const k = s || 1; return art(100 * k, Math.ceil(rows * k), [{ box: [0, (-1 - top) * k, 100 * k, (1 - top) * k] }]); };
    const LF = { 0: { draw: line(-5, 15), box: lb, render: { x: 0, y: -5, width: 100, height: 15 } } }, LP = { 0: { draw: line(-5.5, 16), box: lb } };
    const ln = (await unit(lineIR, [0], LF, LP)).e(0), l1 = (await unit(lineIR, [0], LF, LP, ["--register-supersample", "1"])).e(0);
    check(holds(() => ln.ok === true && ln.metrics.mean < 0.5 && ln.register.offset[1] === -0.5 && l1.ok === false && l1.metrics.mean > 5),
      "one 2 px line drawn at phases 0 and 0.5, the pictures 1 row apart in extent, passes searched at 4x (mean " + val(() => ln.metrics.mean) +
      "); searched on the pictures as exported the split leaves mean " + val(() => l1.metrics.mean), show([ln.register, ln.metrics, l1.register, l1.metrics]));
    // At exactly half a pixel the split is tried both ways: a pair and its mirror image score alike.
    const band = (y0) => art(20, 12, [{ box: [0, y0, 20, y0 + 2] }]);
    const flip = (img) => { const o = Buffer.alloc(img.rgba.length); for (let y = 0; y < img.H; y++) img.rgba.copy(o, (img.H - 1 - y) * img.W * 4, y * img.W * 4, (y + 1) * img.W * 4); return { W: img.W, H: img.H, rgba: o }; };
    const S0 = defaultAuditSettings();
    const ma = comparePictures({ img: band(5), at: [0, 0] }, { img: band(5.75), at: [0, -0.5] }, S0).mean, mb = comparePictures({ img: flip(band(5)), at: [0, 0] }, { img: flip(band(5.75)), at: [0, 0.5] }, S0).mean;
    check(ma === mb, "at exactly half a pixel both ways of splitting the offset are tried: a pair and its mirror image score alike (" + ma + ", " + mb + ")");
  }

  // C20 and C25 together (one root of the U audit): Pixso draws the instance's dot 1 px above its box
  // and its star 2 px below, its picture 3 rows taller and starting 1 row higher; Figma's placeholder is
  // an empty frame. The instance is masked by what its master draws, and the pictures registered.
  {
    const nodes = [rec(-1, "COMPONENT", 60, 20, 0, 0), null, rec(0, "RECTANGLE", 20, 10, 32, 5), rec(-1, "COMPONENT", 20, 20, 0, 100, { clipsContent: false }),
      null, null];
    nodes[1] = rec(0, "INSTANCE", 20, 20, 0, 0, {}, { instance: { master: { guid: nodes[3].guid } } });
    nodes[4] = rec(3, "ELLIPSE", 4, 4, 14, -1);
    nodes[5] = rec(3, "RECTANGLE", 6, 3, 2, 19);
    const ir = { nodes, values: [], notes: [] };
    const box = { x: 0, y: 0, width: 60, height: 20 };
    const F = { 0: { img: art(60, 20, [{ box: [32, 5, 52, 15], c: BLUE }]), box, render: box } };
    const P = { 0: { img: art(60, 23, [{ box: [32, 6, 52, 16], c: BLUE }, { box: [0, 1, 20, 21], c: [200, 200, 200] }, { box: [14, 0, 18, 4], c: [220, 30, 30] }, { box: [2, 20, 8, 23] }]), box } };
    const e = (await unit(ir, [0], F, P)).e(0), o = (await unit(ir, [0], F, P, OLD)).e(0);
    check(holds(() => e.ok === true && e.masks.overflow === 1 && e.register.offset[1] === -1 && e.metrics.mean < 1 && o.ok === false && /differ in size/.test(o.why)),
      "an instance Pixso draws beyond its box (1 px above, 2 below) is masked by what its master draws, and the pictures registered 1 row apart: ok (mean " +
      val(() => e.metrics.mean) + "); under the first pass's settings it fails (" + (o.why || "").slice(0, 80) + ")", show([e.register, e.masks, e.metrics, o.why]));
  }

  // C25. The verifier's case: a 100x20 instance in a clipping 200x300 frame, its master not clipping and
  // holding an ABSOLUTE 100x200 child 24 below its top, which casts a 4 px shadow 4 px down; Pixso draws
  // the child (a drop-down) and its shadow, Figma's placeholder nothing.
  {
    const nodes = [rec(-1, "FRAME", 200, 300, 0, 0, { clipsContent: true }), null, rec(-1, "COMPONENT", 100, 20, 0, 500, { clipsContent: false }), null];
    nodes[1] = rec(0, "INSTANCE", 100, 20, 10, 10, {}, { instance: { master: { guid: nodes[2].guid } } });
    nodes[3] = rec(2, "FRAME", 100, 200, 0, 24, { effects: 0 });
    const ir = { nodes, values: [[{ type: "DROP_SHADOW", visible: true, radius: 4, spread: 0, offset: { x: 0, y: 4 } }]], notes: [] };
    const box = { x: 0, y: 0, width: 200, height: 300 };
    const white = { box: [0, 0, 200, 300], c: [255, 255, 255] };
    const F = { 0: { img: art(200, 300, [white]), box, render: box } };
    const P = { 0: { img: art(200, 300, [white, { box: [10, 10, 110, 30], c: [200, 200, 200] }, { box: [10, 34, 110, 234], c: DARK }, { box: [6, 234, 114, 242], c: DARK, a: 0.3 }]), box } };
    const pb = placeholderBoxes(ir, 0, null, new Set(), { drawn: true, byGuid: guidIndex(ir), memo: new Map() });
    const e = (await unit(ir, [0], F, P)).e(0), o = (await unit(ir, [0], F, P, ["--placeholder-extent", "box"])).e(0);
    check(holds(() => show(pb.instances) === show([[6, 10, 114, 242]]) && pb.overflow === 1 && e.ok === true && e.masks.overflow === 1 && e.masks.maskedShare > 0.4 &&
      o.ok === false && o.masks.overflow === 0),
      "a placeholder is masked by what its master draws: an ABSOLUTE child 24 below and its shadow make [6, 10, 114, 242] of a 100x20 box, " +
      (val(() => e.masks.maskedShare) * 100).toFixed(1) + " % of the root masked, and the root passes; masked by its box (--placeholder-extent box) it fails",
      show([pb, e.masks, o.why]));
    // A resized instance takes its master's overflow, not its master's size; a clipping frame cuts it.
    const n2 = [rec(-1, "FRAME", 200, 100, 0, 0, { clipsContent: false }), null, rec(-1, "COMPONENT", 100, 40, 0, 500, { clipsContent: true }), rec(2, "RECTANGLE", 100, 60, 0, 0),
      rec(0, "FRAME", 120, 30, 0, 50, { clipsContent: true }), null, rec(-1, "COMPONENT", 50, 10, 0, 600, { clipsContent: false }), rec(6, "RECTANGLE", 50, 40, 0, 0)];
    n2[1] = rec(0, "INSTANCE", 100, 10, 0, 0, {}, { instance: { master: { guid: n2[2].guid } } });
    n2[5] = rec(4, "INSTANCE", 50, 10, 5, 5, {}, { instance: { master: { guid: n2[6].guid } } });
    const ir2 = { nodes: n2, values: [], notes: [] };
    const pb2 = placeholderBoxes(ir2, 0, null, new Set(), { drawn: true, byGuid: guidIndex(ir2), memo: new Map() });
    check(holds(() => show(pb2.instances) === show([[0, 0, 100, 10], [5, 55, 55, 80]]) && pb2.overflow === 1),
      "an instance shorter than its master (which clips its taller child) is not grown; one whose master draws 30 below is cut to its clipping frame", show(pb2));
    // A clipping frame wholly outside its clipping root clips everything under it away (the review's
    // case: the instance's master draws 240 to its left and 210 below, which reached back into the root
    // uncut): its instance draws nothing, so it masks nothing; an instance below its clipping frame, its
    // overflow not reaching back into it, likewise. Moved inside, the first is cut to the frame. With
    // --placeholder-extent box both stay masked by their boxes.
    const n3 = [rec(-1, "FRAME", 200, 300, 0, 0, { clipsContent: true }), rec(0, "FRAME", 50, 50, 250, 0, { clipsContent: true }), null, rec(-1, "COMPONENT", 50, 20, 0, 900, { clipsContent: false }),
      rec(3, "RECTANGLE", 50, 200, -240, 30), rec(0, "FRAME", 60, 60, 0, 100, { clipsContent: true }), null];
    n3[2] = rec(1, "INSTANCE", 50, 20, 0, 0, {}, { instance: { master: { guid: n3[3].guid } } });
    n3[6] = rec(5, "INSTANCE", 50, 20, 0, 70, {}, { instance: { master: { guid: n3[3].guid } } });
    const ir3 = { nodes: n3, values: [], notes: [] }, o3 = () => ({ drawn: true, byGuid: guidIndex(ir3), memo: new Map() });
    const out3 = placeholderBoxes(ir3, 0, null, new Set(), o3()), box3 = placeholderBoxes(ir3, 0, null, new Set(), { drawn: false });
    n3[1].props.relativeTransform = [1, 0, 140, 0, 1, 0];
    const in3 = placeholderBoxes(ir3, 0, null, new Set(), o3());
    check(holds(() => out3.instances.length === 0 && out3.clipped === 2 && show(box3.instances) === show([[250, 0, 300, 20], [0, 170, 50, 190]]) &&
      show(in3.instances) === show([[140, 0, 190, 50]]) && in3.clipped === 1),
      "an instance its clipping ancestors clip away whole masks nothing (a frame wholly outside the root, an instance below its frame), and is counted; " +
      "inside, it is cut to the frame", show([out3, box3, in3]));
    // A scaled instance (IR v3's instance.scale) draws its master's overflow at its scale.
    const n4 = [rec(-1, "FRAME", 200, 200, 0, 0), null, rec(-1, "COMPONENT", 20, 10, 0, 500, { clipsContent: false }), rec(2, "RECTANGLE", 20, 20, 0, 0)];
    n4[1] = rec(0, "INSTANCE", 40, 20, 10, 10, {}, { instance: { master: { guid: n4[2].guid }, scale: 2 } });
    const ir4 = { nodes: n4, values: [], notes: [] };
    const pb4 = placeholderBoxes(ir4, 0, null, new Set(), { drawn: true, byGuid: guidIndex(ir4), memo: new Map() });
    check(holds(() => show(pb4.instances) === show([[10, 10, 50, 50]])),
      "an instance at scale 2 whose master draws 10 below its box is masked 20 below its own", show(pb4));
  }

  // C22, C23. Roots neither engine draws: a component at opacity 0 (Figma exports a transparent 1x1,
  // Pixso a transparent box), a hidden text and an empty one (Pixso's export is 0 bytes).
  {
    const ir = { nodes: [rec(-1, "COMPONENT", 20, 20, 0, 0, { opacity: 0 }), rec(-1, "TEXT", 0, 17, 50, 0, { characters: "" }), rec(-1, "TEXT", 40, 17, 100, 0, { visible: false, characters: "x" }),
      rec(-1, "COMPONENT", 20, 20, 150, 0), rec(-1, "TEXT", 40, 17, 200, 0, { characters: "x" })], values: [], notes: [] };
    const b = (i) => ({ x: ir.nodes[i].props.relativeTransform[2], y: 0, width: ir.nodes[i].props.width, height: ir.nodes[i].props.height });
    const F = { 0: { img: blank1, box: b(0), opacity: 0 }, 1: { img: blank1, box: b(1) }, 2: { img: blank1, box: b(2) }, 3: { img: blank1, box: b(3) },
      4: { img: art(40, 17, [{ box: [2, 3, 30, 14] }]), box: b(4), render: b(4) } };
    const P = { 0: { img: art(20, 20, []), box: b(0), opacity: 0 }, 1: { empty: true, box: b(1) }, 2: { empty: true, box: b(2) },
      3: { img: art(20, 20, [{ box: [8, 8, 12, 12] }]), box: b(3) }, 4: { empty: true, box: b(4) } };
    const now = await unit(ir, [0, 1, 2, 3, 4], F, P), old = await unit(ir, [0, 1, 2, 3, 4], F, P, OLD);
    const e = now.e, o = old.e;
    check(holds(() => [0, 1, 2].every((i) => e(i).ok === null && e(i).class === "blank" && !e(i).compared) && /its opacity is 0/.test(e(0).why) && /an empty text/.test(e(1).why) &&
      /it is hidden/.test(e(2).why) && /Pixso's export 0 bytes/.test(e(1).why) && now.A.counts.blank === 3 && now.A.counts.notCompared === 3),
      "a root neither engine draws (opacity 0, an empty text, a hidden text: Pixso's export 0 bytes) is not compared, with its own reason and count (" + now.A.counts.blank + ")",
      show([0, 1, 2].map((i) => [e(i).ok, e(i).why])));
    check(holds(() => e(3).ok === false && e(4).ok === false && /Pixso draws nothing \(its export is 0 bytes\)/.test(e(4).why) && now.A.counts.missing === 0 && !/render missing/.test(e(4).why)),
      "a picture blank on one side only still fails, and Pixso's 0-byte export is an answer, not a missing render", show([e(3).why, e(4).why, now.A.counts]));
    check(holds(() => o(0).ok === false && /differ in size: Figma 1x1, Pixso 20x20/.test(o(0).why) && /^pixso render missing: no picture/.test(o(1).why) && old.A.counts.missing === 3),
      "under the first pass's settings the opacity-0 root fails on size and the empty and hidden texts as missing renders", show([o(0).why, o(1).why, old.A.counts]));
    check(holds(() => e(1).pixso.bytes === 0 && e(4).pixso.bytes === 0 && e(3).pixso.bytes > 0 && e(4).figma.picture.join() === "40,17"),
      "each root records Pixso's byte count (0 for its empty exports), for a later pass to re-judge", show([e(1).pixso, e(3).pixso, e(4).pixso]));
    // A picture blank on one side of a root that holds a placeholder (the review's case: the U audit's root
    // whose Pixso export is 0 bytes, under --register top-left): the placeholder cannot be placed in the blank picture, which needs
    // no mask, and the root still fails under either registration; so does one whose other picture cannot
    // be placed either (smaller than its box, no render bounds). Before, all came out not compared.
    const pn = [rec(-1, "FRAME", 60, 20, 0, 0), null, rec(-1, "COMPONENT", 20, 20, 0, 100)];
    pn[1] = rec(0, "INSTANCE", 20, 20, 0, 0, {}, { instance: { master: { guid: pn[2].guid } } });
    const pir = { nodes: pn, values: [], notes: [] }, pbx = { x: 0, y: 0, width: 60, height: 20 };
    const ink = art(60, 20, [{ box: [30, 5, 50, 15], c: BLUE }]);
    const pairs = [[{ 0: { img: ink, box: pbx, render: pbx } }, { 0: { empty: true, box: pbx } }], [{ 0: { img: blank1, box: pbx } }, { 0: { img: ink, box: pbx } }],
      [{ 0: { img: art(30, 10, [{ box: [5, 2, 25, 8], c: BLUE }]), box: pbx } }, { 0: { empty: true, box: pbx } }]];
    const one = [];
    for (const args of [[], ["--register", "top-left"]]) for (const [FF, PP] of pairs) one.push((await unit(pir, [0], FF, PP, args)).e(0));
    check(holds(() => one.every((x) => x.ok === false && x.masks.placeholders === 1) && /^Pixso draws nothing \(its export is 0 bytes\)/.test(one[3].why) &&
      /cannot be placed in either picture, so what it draws is not known to be masked/.test(one[2].why) && /cannot be placed in either picture/.test(one[5].why)),
      "a picture blank on one side of a root holding a placeholder fails, registered or laid at the top left, also where neither picture places the placeholder",
      show(one.map((x) => [x.ok, x.class, (x.why || "").slice(0, 120)])));
  }

  // C24. Roots under a hidden ancestor in the source (the U audit's 8 masters of a hidden component set):
  // Pixso exports a transparent box, Figma draws the master the planner put on a page of its own.
  {
    const ir = { nodes: [rec(-1, "FRAME", 100, 40, 0, 0, { visible: false }), rec(0, "COMPONENT", 20, 20, 10, 10), rec(-1, "COMPONENT", 20, 20, 200, 0)], values: [], notes: [] };
    const dot = art(20, 20, [{ box: [5, 5, 15, 15], c: BLUE }]), b = (x, y) => ({ x, y, width: 20, height: 20 });
    const F = { 1: { img: dot, box: b(10, 10), render: b(10, 10) }, 2: { img: dot, box: b(200, 0), render: b(200, 0) } };
    const P = { 1: { img: art(20, 20, []), box: b(10, 10) }, 2: { img: dot, box: b(200, 0) } };
    const now = await unit(ir, [1, 2], F, P), old = await unit(ir, [1, 2], F, P, ["--hidden-in-source", "compare"]);
    const e = now.e(1);
    check(holds(() => e.ok === null && e.class === "hidden-in-source" && e.hiddenBy.i === 0 && /hidden in the source/.test(e.why) && now.e(2).ok === true &&
      now.calls.figma === 1 && now.calls.pixso === 1 && now.A.counts.hiddenInSource === 1 && old.e(1).ok === false),
      "a root under a hidden ancestor in the source is not compared and not rendered (counted: " + now.A.counts.hiddenInSource + "); its visible twin is compared; " +
      "--hidden-in-source compare fails it (" + old.e(1).why + ")", show([e, now.calls]));
  }

  // C06. A text whose stored glyph outlines are not glyphs: Pixso draws them (here: nothing), Figma the
  // characters. The reader's note code may not be in this vocabulary yet: the audit looks it up by name,
  // and the case gives it the code as the text reader would write it.
  {
    const GLYPHS = "TEXT_GLYPHS_INVALID";
    const ir = { nodes: [rec(-1, "FRAME", 100, 40, 0, 0), rec(0, "TEXT", 60, 20, 10, 10, { characters: "ab" })], values: [], notes: [{ code: GLYPHS, node: 1, detail: "planted" }] };
    const box = { x: 0, y: 0, width: 100, height: 40 }, white = { box: [0, 0, 100, 40], c: [255, 255, 255] };
    const F = { 0: { img: art(100, 40, [white, { box: [12, 13, 50, 27] }]), box, render: box } }, P = { 0: { img: art(100, 40, [white]), box } };
    const more = { glyphNoteCodes: [GLYPHS] };
    const m = (await unit(ir, [0], F, P, [], more)).e(0), c = await unit(ir, [0], F, P, ["--glyph-notes", "compare"], more), s = (await unit(ir, [0], F, P, ["--glyph-notes", "skip"], more)).e(0);
    const plain = (await unit(ir, [0], F, P, [], { glyphNoteCodes: [] })).e(0);
    check(holds(() => m.ok === true && m.masks.glyphTexts === 1 && m.glyphTexts === 1 && c.e(0).ok === false && c.e(0).class === "source-glyphs" &&
      /stored glyph outlines are not glyphs/.test(c.e(0).why) && c.A.counts.sourceGlyphs === 1 && s.ok === null && s.class === "source-glyphs" && plain.ok === false && !plain.class &&
      GLYPH_NOTE_CODES.every((x) => CODE[x] === x) && GLYPH_NOTE_CODES.length === (CODE[GLYPHS] ? 1 : 0)),
      "a text with invalid stored glyphs (the reader's note) is masked and the root passes; compared, the root fails in its own class; skip does not compare it; " +
      "without the note it is an ordinary failure (the vocabulary " + (CODE[GLYPHS] ? "has" : "does not have yet") + " the code)", show([m.masks, c.e(0).why, s.why, plain.why]));
    // The class only where the difference lies near the flagged texts (the review's case: the U audit's 2
    // drop-down roots, their placeholders masked by their boxes, hold one flagged text each and 96-99 % of
    // their difference is instance overflow). Here a rectangle 270 units right of the flagged text
    // differs: an ordinary failure that holds the text, in the class only with --glyph-class any or a
    // --glyph-near that reaches it. A root that is itself a flagged text, masked whole, is not compared,
    // in the class too (the U audit's one such root was "masked").
    const n2 = [rec(-1, "FRAME", 400, 40, 0, 0), rec(0, "TEXT", 20, 20, 10, 10, { characters: "ab" }), rec(0, "RECTANGLE", 80, 20, 300, 10), rec(-1, "TEXT", 60, 20, 500, 0, { characters: "ab" })];
    const ir2 = { nodes: n2, values: [], notes: [{ code: GLYPHS, node: 1, detail: "planted" }, { code: GLYPHS, node: 3, detail: "planted" }] };
    const b2 = { x: 0, y: 0, width: 400, height: 40 }, w2 = { box: [0, 0, 400, 40], c: [255, 255, 255] }, tb = { x: 500, y: 0, width: 60, height: 20 };
    const F2 = { 0: { img: art(400, 40, [w2, { box: [12, 13, 28, 27] }, { box: [300, 10, 380, 30], c: [220, 30, 30] }]), box: b2, render: b2 }, 3: { img: art(60, 20, [{ box: [2, 3, 50, 17] }]), box: tb, render: tb } };
    const P2 = { 0: { img: art(400, 40, [w2, { box: [10, 10, 30, 30] }, { box: [300, 10, 380, 30], c: BLUE }]), box: b2 }, 3: { img: art(60, 20, [{ box: [0, 0, 60, 20] }]), box: tb } };
    const near = await unit(ir2, [0, 3], F2, P2, [], more), any = (await unit(ir2, [0, 3], F2, P2, ["--glyph-class", "any"], more)).e(0);
    const far = (await unit(ir2, [0, 3], F2, P2, ["--glyph-near", "400"], more)).e(0), r0 = near.e(0), t3 = near.e(3);
    check(holds(() => r0.ok === false && !r0.class && r0.glyphShare === 0 && /but most of the difference lies away from them/.test(r0.why) && any.class === "source-glyphs" &&
      far.class === "source-glyphs" && far.glyphShare === 1 && t3.ok === null && t3.class === "source-glyphs" && /nothing is left once the masks are applied \(1 text whose/.test(t3.why) &&
      near.A.counts.sourceGlyphs === 0 && near.A.counts.sourceGlyphsNotCompared === 1 && near.A.counts.failed === 1),
      "a failing root is in the flagged texts' class only where its difference lies within --glyph-near of them (share " + val(() => r0.glyphShare) + "; with --glyph-near 400 " +
      val(() => far.glyphShare) + "), or with --glyph-class any; a root that is a flagged text masked whole is not compared, in the class and counted apart",
      show([r0.why, r0.glyphShare, any.class, far.glyphShare, t3, near.A.counts]));
  }

  // C16. A 1 px CENTER line at the bottom edge of a 50x20 link (the U audit's underlines): one opaque
  // row above the boundary in Figma's 50x20, two rows at alpha 128 in Pixso's 50x21.
  {
    const ir = { nodes: [rec(-1, "COMPONENT", 50, 20, 0, 0), rec(0, "RECTANGLE", 40, 10, 5, 4), rec(0, "LINE", 50, 0, 0, 20, { strokeAlign: "CENTER", strokeWeight: 1, strokes: 0 })],
      values: [[{ type: "SOLID", color: { r: 23 / 255, g: 120 / 255, b: 234 / 255 } }]], notes: [] };
    const box = { x: 0, y: 0, width: 50, height: 20 }, text = { box: [5, 4, 45, 14], c: DARK };
    const F = { 0: { img: art(50, 20, [text, { box: [0, 19, 50, 20], c: BLUE }]), box, render: box } };
    const pix = (line) => ({ 0: { img: art(50, 21, [text].concat(line)), box } });
    const half = { box: [0, 19, 50, 21], c: BLUE, a: 128 / 255 };
    const e = (await unit(ir, [0], F, pix([half]))).e(0), px = (await unit(ir, [0], F, pix([half]), ["--hairlines", "pixel"])).e(0);
    check(holds(() => e.ok === true && e.hairlines.found === 1 && e.hairlines.compared === 1 && e.metrics.mean < 1 && px.ok === false),
      "a 1-device-pixel line on a pixel boundary, one crisp row in Figma and two half rows in Pixso, is compared by its two-row band and passes (mean " +
      val(() => e.metrics.mean) + "); pixel by pixel it fails (" + px.why + ")", show([e.hairlines, e.metrics, px.why]));
    // Everything else about the line still differs: dashes, colour, a line a whole row away, a shorter line.
    const dashed = [0, 8, 16, 24, 32, 40].map((x) => ({ box: [x, 19, x + 4, 21], c: BLUE, a: 128 / 255 }));
    const cases = { "dashes": dashed, "another colour": [{ box: [0, 19, 50, 21], c: [220, 30, 30], a: 128 / 255 }], "a crisp line a row lower": [{ box: [0, 20, 50, 21], c: BLUE }],
      "a shorter line": [{ box: [0, 19, 30, 21], c: BLUE, a: 128 / 255 }] };
    const still = [];
    for (const k of Object.keys(cases)) { const r = (await unit(ir, [0], F, pix(cases[k]))).e(0); if (r.ok !== false) still.push(k + ": " + show([r.ok, r.metrics, r.hairlines])); }
    check(still.length === 0, "the band hides only where the line's ink sits in it: dashes, another colour, a crisp line a row lower and a shorter line all still fail", still.join(" | "));
  }

  // §16.3, §16.5: which pixels a picture draws (--drawn-by). The second pass failed 4 roots on the size
  // rule whose pictures agree over white (means 0.47-0.54): a shadow's edge at alpha 16-19 in Figma's
  // picture and 12-15 in Pixso's, at most 16 levels off white. visible leaves out what is white on both
  // sides within --drawn-white-tol; alpha counts it; ink leaves out every white pixel, and so makes a
  // content difference inside a white frame one of size. Each case names its settings, whatever the
  // defaults.
  {
    const ALPHA = ["--drawn-by", "alpha"], VIS = (t) => ["--drawn-by", "visible", "--drawn-white-tol", String(t)], INK = (t) => ["--drawn-by", "ink", "--drawn-white-tol", String(t)];
    const ir = { nodes: [rec(-1, "FRAME", 100, 40, 0, 0)], values: [], notes: [] }, box = { x: 0, y: 0, width: 100, height: 40 };
    const text = { box: [12, 13, 50, 27], c: DARK };
    // A white card (a shade off white, 4 levels): opaque in Figma's picture, transparent in Pixso's.
    const F = { 0: { img: art(100, 40, [{ box: [0, 0, 100, 40], c: [251, 251, 252] }, text]), box, render: box } }, P = { 0: { img: art(100, 40, [text]), box } };
    const run = async (args) => (await unit(ir, [0], F, P, args)).e(0);
    const al = await run(ALPHA), vi = await run(VIS(8)), ink = await run(INK(8)), v2 = await run(VIS(2));
    check(holds(() => al.ok === false && /differ in size/.test(al.why) && al.metrics.mean < 5 && vi.ok === true && show(vi.metrics.drawn.figma) === show([12, 13, 50, 27]) &&
      show(vi.metrics.drawn.pixso) === show([12, 13, 50, 27]) && ink.ok === true && v2.ok === false && /differ in size/.test(v2.why)),
      "a white card Figma exports opaque and Pixso transparent, the pictures alike over white (mean " + val(() => al.metrics.mean) + "), fails on size by alpha; " +
      "by visible what is white on both sides is drawn by neither and it passes, as by ink; 4 levels off white is white within --drawn-white-tol 8, not 2",
      show([al.why, vi.metrics, ink.ok, v2.why]));
    // A shadow's faint edge (the 4 roots): a card 92x32 whose shadow reaches 6 px past it, the outer 4 px
    // at alpha 17 in Figma's picture (13 levels off white) and 12 in Pixso's, the inner 2 px at 60 in
    // both. The pictures are the same extent; Figma reports render bounds, Pixso none. The outer edge
    // drawn at alpha 128 in Figma is a visible difference, and still fails.
    const ir2 = { nodes: [rec(-1, "FRAME", 92, 32, 0, 0)], values: [], notes: [] }, b2 = { x: 0, y: 0, width: 92, height: 32 }, SH = [60, 70, 110];
    const card = (outer) => art(104, 44, [[0, 0, 104, 4], [0, 40, 104, 44], [0, 4, 4, 40], [100, 4, 104, 40]].map((q) => ({ box: q, c: SH, a: outer / 255 }))
      .concat([{ box: [4, 4, 100, 40], c: SH, a: 60 / 255 }, { box: [6, 6, 98, 38], c: [255, 255, 255] }, { box: [18, 19, 56, 33], c: DARK }]));
    const SF = (outer) => ({ 0: { img: card(outer), box: b2, render: { x: -6, y: -6, width: 104, height: 44 } } }), SP = { 0: { img: card(12), box: b2 } };
    const sh = async (outer, args) => (await unit(ir2, [0], SF(outer), SP, args)).e(0);
    const fa = await sh(17, ALPHA), f8 = await sh(17, VIS(8)), f16 = await sh(17, VIS(16)), dv = await sh(128, VIS(16));
    check(holds(() => fa.ok === false && /differ in size/.test(fa.why) && fa.register.rule.join() === "same extent,same extent" && fa.metrics.mean < 5 &&
      f8.ok === false && /differ in size/.test(f8.why) && f16.ok === true && show(f16.metrics.drawn.figma) === show([-2, -2, 94, 34]) && show(f16.metrics.drawn.pixso) === show([-2, -2, 94, 34]) &&
      dv.ok === false && /differ in size/.test(dv.why) && show(dv.metrics.drawn.figma) === show([-6, -6, 98, 38]) && show(dv.metrics.drawn.pixso) === show([-2, -2, 94, 34])),
      "a shadow whose outer 4 px are at alpha 17 in Figma and 12 in Pixso fails on size by alpha (mean " + val(() => fa.metrics.mean) + "); by visible that edge, 13 levels " +
      "off white on one side and 9 on the other, is white within --drawn-white-tol 16 and the card passes, not within 8; the edge at alpha 128 in Figma still fails by visible",
      show([fa.why, f8.why, f16.metrics, dv.why]));
    // A visible difference counts on both sides, white or not: an image placeholder (grey) in a white
    // frame against the image, whose white margins are the frame's white. By visible both sides draw the
    // placeholder's box (Pixso's white margins count where Figma's grey is) and the root fails on its
    // content alone, as by alpha; by ink Pixso draws only the image, and it is a size difference too.
    const PF = { 0: { img: art(100, 40, [{ box: [0, 0, 100, 40], c: [255, 255, 255] }, { box: [20, 8, 80, 32], c: [200, 200, 200] }]), box, render: box } };
    const PP = { 0: { img: art(100, 40, [{ box: [0, 0, 100, 40], c: [255, 255, 255] }, { box: [30, 14, 70, 26], c: BLUE }]), box } };
    const pr = async (args) => (await unit(ir, [0], PF, PP, args)).e(0);
    const pa = await pr(ALPHA), pv = await pr(VIS(8)), p32 = await pr(VIS(32)), pi = await pr(INK(8));
    check(holds(() => pa.ok === false && !/differ in size/.test(pa.why) && /mean difference/.test(pa.why) && pv.why === pa.why && p32.why === pa.why &&
      show(pv.metrics.drawn.figma) === show([20, 8, 80, 32]) && show(pv.metrics.drawn.pixso) === show([20, 8, 80, 32]) &&
      pi.ok === false && /differ in size/.test(pi.why) && show(pi.metrics.drawn.pixso) === show([30, 14, 70, 26])),
      "an image placeholder against an image with white margins in a white frame fails on its content (" + pa.why + ") by alpha and by visible (within 8 and 32), " +
      "where both sides draw the placeholder's box; by ink it is a size difference too", show([pa.why, pv.metrics.drawn, p32.why, pi.why]));
  }
}

// ============================================================================================
// 11. the offline re-judge (tools/ir-rejudge.mjs, docs/M1.md §16.4)
// ============================================================================================
// A run audited with --pictures all is judged again from its folder alone, by auditRun with the two
// engines answering from the folder: under the recorded pass's own settings every root comes out as it
// did; under another setting, as a live pass under that setting does. What the folder does not keep (an
// export at another scale, the reports that came with the finer pictures of a registration search) is
// refused or named, and the roots that needed it are apart.
{
  const holds = (f) => { try { return !!f(); } catch (err) { return false; } };
  const val = (f) => { try { return f(); } catch (err) { return undefined; } };
  // The live pass under --placeholders compare first: each audit replaces the folder's audit.
  const liveCmp = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--placeholders", "compare"]);
  const rec = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--pictures", "all"]);
  const searched = rec.audit.roots.filter((e) => e.register && e.register.supersample && e.register.supersample.used !== false).map((e) => e.i);
  const same = await rejudge(GOOD.runDir);
  const rendered = rec.audit.roots.filter((e) => e.figma).length;
  check(same.diff.length === 0 && same.apart.map((x) => x.i).join() === searched.join() && canonicalJSON(same.audit.counts) === canonicalJSON(rec.audit.counts) && rendered > 0,
    "a run audited with --pictures all, re-judged from its folder under the recorded settings, reproduces every root (" + rec.audit.roots.length + ", " + rendered +
    " rendered): ok, why, metrics and every other field", show([same.diff.slice(0, 3), same.apart, searched]));
  const cmp = await rejudge(GOOD.runDir, { settings: rejudgeSettings(rec.audit, { placeholders: "compare" }).settings });
  const d = compareAudits(liveCmp.audit, cmp.audit), r2 = cmp.audit.roots.find((e) => e.i === 2);
  check(d.length === 0 && r2 && r2.ok === false && cmp.diff.some((x) => x.i === 2 && x.fields.indexOf("ok") >= 0),
    "re-judged under --placeholders compare it is the live pass under that setting, root for root (root 2 fails: " + (r2 && r2.why) + ")", show(d.slice(0, 3)));
  // An export at another scale is not in the folder: refused (a render missing, never ok) and apart.
  const small = await rejudge(GOOD.runDir, { settings: rejudgeSettings(rec.audit, { maxSide: 100 }).settings });
  const moved = small.audit.roots.filter((e) => typeof e.scale === "number" && rootOf(rec, e.i) && e.scale !== rootOf(rec, e.i).scale);
  const apartI = small.apart.map((x) => x.i);
  check(moved.length > 0 && moved.every((e) => e.ok === false && /^figma render missing: not kept in the run folder: /.test(e.why) && apartI.indexOf(e.i) >= 0) &&
    small.apart.every((x) => moved.some((e) => e.i === x.i) || searched.indexOf(x.i) >= 0),
    "under --max-side 100 the " + moved.length + " roots that would render at another scale are refused, never judged on the recorded pictures, and apart",
    show([moved.slice(0, 2).map((e) => [e.i, e.ok, e.why]), small.apart.slice(0, 3)]));
  const lines = [];
  const code = await rejudgeMain([GOOD.runDir, "--check"], (m) => lines.push(m));
  const refusedFlag = await rejudgeMain([GOOD.runDir, "--fresh"], (m) => lines.push(m));
  check(code === 0 && refusedFlag === 1 && lines.some((l) => /^changed against the recorded pass: 0 roots/.test(l)),
    "the command re-judges the folder (--check exit 0: nothing changed) and refuses the live audit's own flags", lines.join(" | "));

  // A root searched on pictures at 4x (an arrow connector, as C20 of section 10): the folder keeps the
  // 4x pair and its sizes, not the reports that came with it.
  const dir = join(SCRATCH, "rejudge-fine");
  mkdirSync(join(dir, "reports"), { recursive: true });
  const nodes = [{ parent: -1, guid: "9:900", type: "VECTOR", name: "VECTOR", props: { relativeTransform: [1, 0, 0, 0, 1, 50], width: 100, height: 0 } }];
  writeFileSync(join(dir, "ir.json"), JSON.stringify({ nodes, values: [], notes: [] }));
  writeFileSync(join(dir, "states.json"), JSON.stringify({ snapshot: "6".repeat(16), runId: RUN, tasks: [{ op: "build", taskNo: 1, roots: [0] }, { op: "verify", taskNo: 2, state: "built", build: 1 }] }));
  writeFileSync(join(dir, "reports", "2-verify.json"), JSON.stringify({ taskNo: 2, roots: [{ i: 0, found: true, id: "u:0" }] }));
  const arrow = (reach, s) => art(100 * s, Math.ceil(reach * 2 * s), [{ box: [0, (reach - 1) * s, 100 * s, (reach + 1) * s] }, { box: [96 * s, 0, 100 * s, reach * 2 * s] }]);
  const box = { x: 0, y: 50, width: 100, height: 0 };
  const io = { identity: { same: true, q5: true, code: null, detail: "synthetic" }, log: qlog,
    figmaExport: async (job) => {
      const png = pngOf(arrow(7.4, job.constraint.value));
      return { w: 100, h: 0, type: "VECTOR", opacity: 1, box, render: { x: 0, y: 50 - 7.4, width: 100, height: 14.8 }, bytes: png.length, d: png.toString("base64") };
    },
    mcp: { run: async (src) => {
      const a = JSON.parse(/^const ARGS = (.*);$/m.exec(src)[1]), png = pngOf(arrow(6.66, a.scale));
      return { ok: true, value: { w: 100, h: 0, type: "VECTOR", opacity: 1, box, render: null, n: png.length, d: png.toString("base64") } };
    } } };
  const fr = await auditFolder(dir, parseAuditArgs([dir, "--pictures", "all"]), io);
  const saved = await rejudge(dir), refused = await rejudge(dir, { fine: "refuse" });
  const f0 = val(() => fr.audit.roots[0]), q0 = val(() => refused.audit.roots[0]);
  check(holds(() => f0.ok === true && f0.register.supersample.k === 4 && existsSync(join(dir, "audit", "pictures", "0@4x.pixso.png")) &&
    saved.diff.length === 0 && saved.apart.length === 1 && saved.apart[0].fine === 4 && !saved.apart[0].refused.length &&
    q0.register.supersample.used === false && /is missing: not kept in the run folder/.test(q0.register.supersample.why) &&
    refused.apart.length === 1 && refused.apart[0].refused.length === 1 && refused.diff.length === 1 && refused.diff[0].fields.indexOf("register") >= 0),
    "a root searched on both engines' pictures at 4x re-judges from the saved 4x pair with the reports at the export's scale (the same result, the root apart); " +
    "with --fine refuse the search runs on the pictures as exported (mean " + val(() => q0.metrics.mean) + " against " + val(() => f0.metrics.mean) + "), says why, and is apart",
    show([f0 && f0.register, saved.diff, saved.apart, q0 && q0.register, refused.apart]));
}

await PX.close();
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
console.log(failed ? failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "render audit: all checks pass");
process.exit(failed ? 1 : 0);

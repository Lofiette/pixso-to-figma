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
// the IR with the same rasteriser the way Pixso exports: the node's own opacity left out, no margin, an
// instance drawn as its content. What it proves:
//   - the clean run: every root ok, the placeholder roots left to G11, and m1-accept reads PASS with it;
//   - a planted colour difference fails, and m1-accept reads FAIL (audit);
//   - a placeholder's region is masked (with --placeholders compare the same root fails);
//   - a 32 % opacity root passes (undone in Figma's picture, or applied to Pixso's; compared raw it
//     would fail);
//   - a section's margin passes when cropped to its box, and child by child (compared as it comes, it
//     fails on size);
//   - a missing render fails, in Figma and in Pixso, and never counts as ok; a root its masks cover whole
//     is not compared (ok null), so the verdict cannot read PASS;
//   - SOURCE_IDENTITY_MISMATCH stops the audit before any render, and --accept-identity-mismatch goes on
//     and records the reason;
//   - a second pass keeps the roots already ok; the RENDER export refuses another snapshot's copy;
//   - the verdict: a root not compared covers nothing and fails nothing, INSTANCE roots are not required;
//   - a root whose verify is not done, or whose verified node is gone while an earlier run's copy is in
//     the file, is a missing render; a section's children pair by index only when the counts match.
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
import { AUDIT_SETTINGS, auditRoots, comparePictures, defaultAuditSettings, parseAuditArgs, placeBox, scaleAlpha } from "./ir/render-audit.mjs";
import { auditFolder, main as auditMain, readRun } from "./ir-audit.mjs";
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
        const png = pngOf(rasterize({ abs: to2(at), type: r.type, w: dw, h: dh, fills: [], children: [] }, { scale, ownOpacity: false, margin: 0 }));
        const bs = [[0, 0], [t.w, 0], [0, t.h], [t.w, t.h]].map(([x, y]) => [abs[0] * x + abs[1] * y + abs[2], abs[3] * x + abs[4] * y + abs[5]]);
        const bx = Math.min(...bs.map((q) => q[0])), by = Math.min(...bs.map((q) => q[1]));
        const box = { x: bx, y: by, width: Math.max(...bs.map((q) => q[0])) - bx, height: Math.max(...bs.map((q) => q[1])) - by };
        return { w: t.w, h: t.h, type: r.type, opacity: 1, box, render, n: png.length, d: png.toString("base64") };
      }
      const xs = [[0, 0], [t.w, 0], [0, t.h], [t.w, t.h]].map(([x, y]) => [abs[0] * x + abs[1] * y + abs[2], abs[3] * x + abs[4] * y + abs[5]]);
      const x0 = Math.min(...xs.map((q) => q[0])), y0 = Math.min(...xs.map((q) => q[1]));
      const box = { x: x0, y: y0, width: Math.max(...xs.map((q) => q[0])) - x0, height: Math.max(...xs.map((q) => q[1])) - y0 };
      const png = pngOf(rasterize(t, { scale, ownOpacity: false, margin: 0 }));
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
  check(d.maxSide === 800 && d.ink === 191 && d.grossMax === 0.01 && d.meanMax === 5 && d.section === "crop" && d.placeholders === "mask" && d.opacity === "undo" &&
    d.sizeTol === 1 && d.tileMeanMax === 0 && Object.keys(AUDIT_SETTINGS).every((f) => AUDIT_SETTINGS[f][2] !== undefined),
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
  const notOk = A ? A.roots.filter((e) => e.ok !== true) : [];
  check(CLEAN.code === 0 && A && A.counts.failed === 0 && A.counts.notCompared === 0 && notOk.length === 0,
    "the clean run, through the real Pixso channel: every root is ok (" + (A ? A.counts.ok : 0) + " of " + (A ? A.counts.roots : 0) + ")",
    show(notOk.map((e) => [e.i, e.type, e.why])) + " " + quietLog.slice(-5).join(" | "));
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
    "m1-accept with this audit reads PASS: every built root covered, the placeholder roots left to G11", acc.gates.verdict + " | " + acc.gates.auditLine);

  const r8 = rootOf(CLEAN, 8);
  check(r8 && r8.ok === true && r8.compared && r8.opacity.value === 0.32 && r8.opacity.rule === "undone in Figma's picture" && r8.metrics.mean === 0,
    "a root at 32 % opacity passes: Figma's picture has it, Pixso's does not, and the audit undoes it in Figma's", show(r8));
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
  const none = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--section", "none"]);
  const s0 = rootOf(none, 50);
  check(s0 && s0.ok === false && /differ in size/.test(s0.why || ""), "with --section none the section fails on its margin", show(s0 && s0.why));
  const kids = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--section", "children"]);
  const s1 = rootOf(kids, 50);
  check(s1 && s1.ok === true && Array.isArray(s1.children) && s1.children.length === 1 && s1.children[0].i === 51 && s1.children[0].ok === true && /own fill is not compared/.test(s1.section),
    "with --section children the section passes child by child, and says its own fill is not compared", show(s1 && s1.children));
  const apply = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--opacity", "apply"]);
  const a8 = rootOf(apply, 8);
  check(a8 && a8.ok === true && a8.opacity.rule === "applied to Pixso's picture", "with --opacity apply the 32 % root passes too, the opacity applied to Pixso's picture", show(a8 && a8.opacity));
  // Root 2 holds an image the archive does not hold: Figma drew the grey IMAGE_PLACEHOLDER paint.
  const tight = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--mean-max", "0.1"]);
  const t2 = rootOf(tight, 2);
  const tightM = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--mean-max", "0.1", "--image-placeholders", "mask"]);
  const m2 = rootOf(tightM, 2);
  check(t2 && t2.ok === false && t2.masks.imagePlaceholders === 1 && /IMAGE_PLACEHOLDER/.test(t2.why) && m2 && m2.ok === true && m2.masks.masked === 2 && m2.metrics.mean === 0,
    "an image the run could not carry differs by default and the root says it holds an IMAGE_PLACEHOLDER; --image-placeholders mask leaves it out", show([t2 && t2.why, m2 && m2.masks]));
  // A mask that covers the whole root leaves nothing to compare: not compared, never ok.
  const all = await auditOf(GOOD, { mcp: LP, figmaExport: FIG.exportJob }, ["--mask-pad", "1000"]);
  const n2 = rootOf(all, 2);
  const accN = accept(GOOD.runDir, { audit: all.audit });
  check(all.code === 2 && n2 && n2.ok === null && !n2.compared && /not compared/.test(n2.why) && all.audit.counts.notCompared === 1 &&
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
  const others = res.audit.roots.filter((e) => e.i !== 19 && e.ok !== true);
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
  check(go.code === 0 && go.audit.identity.code === "SOURCE_IDENTITY_MISMATCH" && go.audit.identity.accepted === "renamed nodes" && /root name differs/.test(go.audit.identity.detail),
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
  check(again.code === 0 && n1 === n0 && fresh.code === 0 && FIG.calls() - n1 === fresh.audit.counts.roots,
    "a second pass keeps every root already ok under the same settings and run (no render); --fresh renders them all again");
  const other = await auditFolder(GOOD.runDir, parseAuditArgs([GOOD.runDir, "--mean-max", "4"]), { mcp: LP, figmaExport: FIG.exportJob, log: qlog });
  check(other.code === 0 && FIG.calls() - n1 - fresh.audit.counts.roots === other.audit.counts.roots, "a pass under another threshold renders every root again");

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

await PX.close();
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
console.log(failed ? failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "render audit: all checks pass");
process.exit(failed ? 1 : 0);

// Part E's tests: the headless double, the probes and the plugin channel (docs/M1.md §6 E).
//
//   node tools/test-double.mjs
//
// Offline and synthetic: the double, the plugin's IR bundle run in a vm (tools/ir/plugin-vm.mjs), and
// job servers on free loopback ports. The double's core and its surface are P0's, checked by
// tools/test-m1-contract.mjs; this file covers what part E adds:
//
//   1. conformance: the probe functions of figma-plugin/src/ir/probes-*.js, run against the double,
//      reproduce tools/double/verdicts.json — the recorded results (P2, P19; P4, P8 and P19B since
//      2026-10-05, P19B's measured boxes and boolean winding too), and, with the cases planted
//      pending, the double's stated assumptions for P4, P8 and P19B; and every value the double models
//      for every case, one double per value; a recorded value the double cannot model refuses to build it
//   2. auto layout with expected boxes: hug, fixed, padding, spacing, MIN / CENTER / MAX /
//      SPACE_BETWEEN, grow, stretch, a child's own alignment, hidden and absolute children, the padding
//      floor, min and max, an INSIDE stroke and strokesIncludedInLayout, wrap, nested fill and text,
//      a flow child's rotation dropped, constraints on resize, laziness
//   3. text: the missing-font throws, the width model and its ratio, wrap, decision 9's one-pixel
//      wrap, the countLines formula, paragraphs, maxLines, leading trim, the resize reset semantics,
//      ranges and figma.mixed, UTF-16 range bounds
//   4. vectors and booleans: where a network off the origin lands, resize scaling, region-less loops,
//      a 6.283185 sweep, polygons and stars, booleans following their operands, a hidden operand, a
//      refused operation, stroked and LINE operands, the NONZERO label of every result
//   5. images: formats and sizes from the bytes, P8 refusals and drops, P4 re-encoding
//   6. the probes' own argument checks, and P4 through a simulated window
//   7. liveness in tools/jobserver.mjs: no advance fails the post with PLUGIN_STALLED, an advance keeps
//      it, a heartbeat does not, the ceiling fails it, onProgress hears every advance; and the image
//      transport P4's verdict picks
import { request } from "node:http";
import { createHash } from "node:crypto";
import { makeDouble, loadVerdicts, MODEL, textMetrics, DEFAULT_TEXT_RATIO, sniffImage, DOUBLE_FEATURES } from "./double/index.mjs";
import { loadPluginBundle } from "./ir/plugin-vm.mjs";
import { pathBounds, unionBounds } from "./ir/pathgeom.mjs";
import { startJobServer, newSecrets, IMAGE_TRANSPORTS, defaultImageTransport } from "./jobserver.mjs";
import { CODE } from "./ir/schema.mjs";
import { p4Images, compareLine } from "./plugin-probe.mjs";

let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why !== undefined ? " — " + String(why).slice(0, 400) : "")));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, e = 1e-6) => typeof a === "number" && Math.abs(a - b) <= e;
const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message || String(e); } };
const rejects = async (p) => { try { await p; return ""; } catch (e) { return e.message || String(e); } };
const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLACK = { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: "NORMAL" };
setTimeout(() => { console.log("FAIL test-double did not finish within 120 s"); process.exit(1); }, 120000).unref();

const VERDICTS = loadVerdicts();
// A verdicts object with one case changed.
function withVerdict(probe, kase, value) {
  const v = JSON.parse(JSON.stringify(VERDICTS));
  v.probes[probe].verdicts[kase] = value;
  return v;
}
// A verdicts object with every case of the named probes planted pending, as before the live session.
function pendingFor(probes) {
  const v = JSON.parse(JSON.stringify(VERDICTS));
  for (const p of probes) { v.probes[p].status = "pending"; for (const k of Object.keys(v.probes[p].verdicts)) v.probes[p].verdicts[k] = "pending"; }
  return v;
}
const isPending = (verdicts, probe, kase) => {
  const pv = verdicts.probes[probe] && verdicts.probes[probe].verdicts;
  return !pv || pv[kase] === undefined || pv[kase] === "pending";
};
// What the double follows for each case of a probe: the recorded verdict, or its stated assumption
// while the case is pending (tools/double/behaviour.mjs).
function followed(probe, verdicts) {
  const out = {};
  for (const k of Object.keys(MODEL[probe])) out[k] = isPending(verdicts, probe, k) ? MODEL[probe][k].assumed : verdicts.probes[probe].verdicts[k];
  return out;
}
// "P19B.offsetNetwork", … for every modelled case still pending, in MODEL's order (behaviour().assumed's).
const pendingCases = (verdicts) => Object.keys(MODEL).flatMap((p) => Object.keys(MODEL[p]).filter((k) => isPending(verdicts, p, k)).map((k) => p + "." + k));
const RECORDED_ON = /^run \d{4}-\d{2}-\d{2}/;
function bundle(D) { return loadPluginBundle({ figma: D.figma }); }
function box(n) { const b = n.absoluteBoundingBox; return [b.x, b.y, b.width, b.height]; }
function drawnBox(n) {
  const boxes = [];
  for (const g of n.fillGeometry) boxes.push(...pathBounds(g.data, n.absoluteTransform));
  const u = unionBounds(boxes);
  return u ? [u.x0, u.y0, u.x1, u.y1].map((v) => Math.round(v * 1000) / 1000) : null;
}

check(DOUBLE_FEATURES.layout && DOUBLE_FEATURES.text && DOUBLE_FEATURES.booleans && Object.isFrozen(DOUBLE_FEATURES),
  "the double says what it models (DOUBLE_FEATURES), so part B's and C's tests can leave \"pending: E\"");

// ============================================================================================
// 1. conformance
// ============================================================================================
{
  // P2, as recorded: no performance.now and no timer in the IR layer, and the yield it uses instead,
  // getNodeByIdAsync, answers without one.
  const D = makeDouble();
  let byId = 0;
  const spy = new Proxy({}, { get: (_, p) => (p === "getNodeByIdAsync" ? (id) => { byId++; return D.figma.getNodeByIdAsync(id); } : D.figma[p]) });
  const B = loadPluginBundle({ figma: spy });
  const p2 = VERDICTS.probes.P2.verdicts;
  const ctx = B.PXF_IR.makeCtx(spy, { op: "build", taskNo: 1, runId: "0123456789abcdef", values: {} }, { id: "c1" });
  await ctx.settle(D.figma.createFrame());
  check(p2.performanceNow === "absent" && B.context.performance === undefined && p2.timerYieldWhenMinimised === "throttled" &&
    B.context.setTimeout === undefined && B.context.setInterval === undefined && p2.getNodeByIdAsyncWhenMinimised === "ok" && byId === 1,
    "P2 (recorded): the IR layer runs with no performance.now and no timer, and yields through getNodeByIdAsync, which the double answers at once");
}
{
  const D = makeDouble();
  const IR = bundle(D).PXF_IR;
  const res = await IR.probes.P19B.run(IR.probes.P19B.args({}));
  check(same(res.p19.verdicts, VERDICTS.probes.P19.verdicts), "P19 (recorded): the probe run against the double gives the recorded verdicts",
    JSON.stringify(res.p19.verdicts));
  check(same(res.verdicts, followed("P19B", VERDICTS)),
    "P19B: the probe against the double gives the recorded verdict for each recorded case and the double's stated assumption for each pending one",
    JSON.stringify(res.verdicts));
  // P19B, recorded on 2026-10-05: every case as Figma said, and what the double takes from the
  // measurements (verdicts.json P19B.measured, container coordinates; the probe's container sits at
  // 1000, 1000): the LINE and stroked operands' boxes, and NONZERO on every boolean result path.
  const M19 = VERDICTS.probes.P19B.measured, at = (b) => [b[0] + 1000, b[1] + 1000, b[2] + 1000, b[3] + 1000];
  const bools = ["booleanUnion", "booleanSubtract", "booleanIntersect", "booleanExclude"];
  check(RECORDED_ON.test(VERDICTS.probes.P19B.status) && pendingCases(VERDICTS).every((k) => k.indexOf("P19B.") !== 0) && same(res.verdicts, VERDICTS.probes.P19B.verdicts) &&
    same(res.cases.lineOperand.box, at(M19.lineOperandBox)) && same(res.cases.strokedOperand.box, at(M19.strokedOperandBox)) &&
    bools.every((k) => same(res.cases[k].winding, [M19.booleanResultWinding])) && res.cases.offsetNetwork.originMoved === true,
    "P19B (recorded): the probe against the double gives the recorded verdict for every case, the measured LINE and stroked-operand boxes, and NONZERO on every boolean result",
    JSON.stringify([res.verdicts, res.cases.lineOperand, res.cases.strokedOperand, bools.map((k) => res.cases[k].winding)]));
  check(D.tree().children[0].children.length === 0, "P19B leaves nothing behind in the file");
  // P8, recorded on 2026-10-05: the probe against the double gives back exactly what Figma said.
  const r8 = await IR.probes.P8.run(IR.probes.P8.args({}));
  check(RECORDED_ON.test(VERDICTS.probes.P8.status) && pendingCases(VERDICTS).every((k) => k.indexOf("P8.") !== 0) && same(r8.verdicts, VERDICTS.probes.P8.verdicts) &&
    r8.cases.png4097.width === 4097 && /P8 png4097/.test(r8.cases.png4097.error) && r8.cases.jpegAsPng.hashIsSha1 === true,
    "P8 (recorded): the probe against the double gives the recorded verdict for every case (over 4 096 px and WebP refused, JPEG and an unknown hash kept)",
    JSON.stringify(r8.verdicts));
  // The same probes against a double with P4, P8 and P19B planted pending, as before the live session:
  // the double's stated assumption for every case.
  const DP = makeDouble({ verdicts: pendingFor(["P4", "P8", "P19B"]) });
  const IRP = bundle(DP).PXF_IR;
  const r8p = await IRP.probes.P8.run(IRP.probes.P8.args({}));
  const resP = await IRP.probes.P19B.run(IRP.probes.P19B.args({}));
  const assumedP8 = {}, assumedP19B = {};
  for (const k of Object.keys(MODEL.P8)) assumedP8[k] = MODEL.P8[k].assumed;
  for (const k of Object.keys(MODEL.P19B)) assumedP19B[k] = MODEL.P19B[k].assumed;
  check(same(r8p.verdicts, assumedP8) && r8p.cases.png4097.width === 4097 && r8p.cases.jpegAsPng.hashIsSha1 === true && same(resP.verdicts, assumedP19B),
    "P8 and P19B planted pending: the probe against the double gives the double's stated assumption for every case", JSON.stringify([r8p.verdicts, resP.verdicts]));
  // The assumed list is exactly the cases still pending: none of P4's and P8's since they were recorded,
  // none of P19's; with P4, P8 and P19B planted pending, every case of the three and still none of P19's.
  const allOf = (p) => Object.keys(MODEL[p]).map((k) => p + "." + k);
  check(same(D.assumed, pendingCases(VERDICTS)) && !D.assumed.some((k) => /^(P4|P8|P19)\./.test(k)) &&
    same(DP.assumed, allOf("P4").concat(allOf("P8"), allOf("P19B"))) && DP.assumed.indexOf("P19.openRegionlessNetworkFilled") < 0,
    "the double lists the cases it follows by assumption (none since P19B was recorded; every case of P4, P8 and P19B when planted pending), and none it follows from a recorded verdict",
    JSON.stringify([D.assumed, DP.assumed]));
  console.log("skip P13 (recorded): instance sublayer overrides are not modelled in M1; the double has no instances (M2b)");
}
// Every value the double models, for every case: a double built with that verdict, and the probe run
// against it, give the same value back. This is what keeps the double and the probes honest with each
// other once part F records the live results.
{
  const bad = [];
  let n = 0;
  for (const probe of ["P8", "P19B", "P19"]) {
    for (const kase of Object.keys(MODEL[probe])) {
      for (const value of MODEL[probe][kase].values) {
        const D = makeDouble({ verdicts: withVerdict(probe, kase, value) });
        const IR = bundle(D).PXF_IR;
        let got;
        try {
          if (probe === "P8") got = (await IR.probes.P8.run(IR.probes.P8.args({ p8: { cases: [kase] } }))).verdicts[kase];
          else if (probe === "P19B") got = (await IR.probes.P19B.run(IR.probes.P19B.args({ p19b: { cases: [kase] } }))).verdicts[kase];
          else got = (await IR.probes.P19B.run(IR.probes.P19B.args({ p19b: { cases: ["autoClosedLoop"] } }))).p19.verdicts[kase];
        } catch (e) { got = "probe threw: " + e.message; }
        n++;
        if (got !== value) bad.push(probe + "." + kase + "=" + value + " gave " + got);
      }
    }
  }
  check(!bad.length, "round trip: for each of " + n + " modelled (case, value) pairs of P8, P19B and P19, the probe against a double following that value reports it", bad.join("; "));
  check(/not modelled/.test(threw(() => makeDouble({ verdicts: withVerdict("P19B", "booleanUnion", "differs") }))) &&
    /not modelled/.test(threw(() => makeDouble({ verdicts: withVerdict("P8", "png4096", "maybe") }))),
    "a recorded verdict the double cannot model refuses to build the double, naming the case (the double changes first)");
  const PEND = pendingFor(["P4", "P8", "P19B"]);
  check(compareLine("P19", "openRegionlessNetworkFilled", "empty", VERDICTS) === "as recorded" && compareLine("P19", "perRegionFills", "drop", VERDICTS) === "RECORDED ok" &&
    compareLine("P8", "webpAsPng", "throw", VERDICTS) === "as recorded" && compareLine("P8", "png4097", "ok", VERDICTS) === "RECORDED throw" &&
    compareLine("P4", "transport", "base64", VERDICTS) === "RECORDED binary" &&
    compareLine("P19B", "regionlessFill", "ok", VERDICTS) === "as recorded" && compareLine("P19B", "lineOperand", "ok", VERDICTS) === "RECORDED differs" &&
    compareLine("P19B", "regionlessFill", "ok", PEND) === "THE DOUBLE ASSUMES empty" &&
    compareLine("P8", "webpAsPng", "throw", PEND) === "as the double assumes" && compareLine("P8", "png4097", "throw", PEND) === "THE DOUBLE ASSUMES ok" &&
    compareLine("P4", "transport", "binary", PEND) === "THE DOUBLE ASSUMES base64" && compareLine("P19B", "offsetNetwork", "drop", PEND) === "THE DOUBLE ASSUMES ok",
    "plugin-probe prints each live verdict against the recorded one (P4, P8, P19, P19B), or the double's assumption while pending (planted)");
}

// ============================================================================================
// 2. auto layout
// ============================================================================================
function frame(f, opts) {
  const fr = f.createFrame();
  for (const k of Object.keys(opts || {})) fr[k] = opts[k];
  return fr;
}
function rect(f, parent, w, h, opts) {
  const r = f.createRectangle();
  parent.appendChild(r);
  r.resize(w, h);
  for (const k of Object.keys(opts || {})) r[k] = opts[k];
  return r;
}
{
  const D = makeDouble(), f = D.figma;
  const F = frame(f, { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", paddingLeft: 10, paddingRight: 20,
    paddingTop: 5, paddingBottom: 5, itemSpacing: 8, counterAxisAlignItems: "CENTER" });
  const a = rect(f, F, 30, 20), b = rect(f, F, 40, 10);
  check(same([F.width, F.height, a.x, a.y, b.x, b.y], [108, 30, 10, 5, 48, 10]), "horizontal hug: padding, spacing and a centred counter axis",
    JSON.stringify([F.width, F.height, a.x, a.y, b.x, b.y]));
  F.maxWidth = 50; F.minHeight = 60;
  check(F.width === 50 && F.height === 60, "max and min sizes clamp a hugging frame", F.width + "x" + F.height);
  F.maxWidth = null; F.minHeight = null;
  b.resize(60, 10); a.resize(30, 30);
  const passes = D.layoutPasses;
  b.resize(60, 10);
  const lazy = D.layoutPasses === passes;
  check(lazy && F.width === 128 && D.layoutPasses > passes, "layout is lazy: writes lay nothing out until a read of the tree needs it");

  const V = frame(f, { layoutMode: "VERTICAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", paddingLeft: 10, paddingRight: 10,
    paddingTop: 10, paddingBottom: 10, primaryAxisAlignItems: "SPACE_BETWEEN" });
  V.resize(100, 200);
  const k = [rect(f, V, 50, 20), rect(f, V, 50, 30), rect(f, V, 50, 40)];
  check(same(k.map((c) => [c.x, c.y]), [[10, 10], [10, 75], [10, 150]]), "vertical fixed, SPACE_BETWEEN", JSON.stringify(k.map((c) => [c.x, c.y])));
  V.primaryAxisAlignItems = "MAX"; V.counterAxisAlignItems = "CENTER";
  check(same(k.map((c) => [c.x, c.y]), [[25, 100], [25, 120], [25, 150]]), "primary MAX, counter CENTER", JSON.stringify(k.map((c) => [c.x, c.y])));
  V.primaryAxisAlignItems = "CENTER";
  check(k[0].y === 55, "primary CENTER", k[0].y);
  k[1].layoutAlign = "MAX"; k[2].layoutAlign = "MIN";
  check(k[1].x === 25 && k[2].x === 25 && k[0].x === 25, "a child's own layoutAlign MIN / MAX is ignored: the counter alignment places it (docs/FINDINGS.md: 0 aligned; review figma F4)",
    JSON.stringify(k.map((c) => c.x)));
  k[1].visible = false;
  check(k[2].y === 10 + (180 - 60) / 2 + 20, "a hidden child is out of the flow", k[2].y);
  k[1].visible = true;
  k[1].layoutPositioning = "ABSOLUTE"; k[1].x = 300; k[1].y = 400;
  check(k[1].x === 300 && k[1].y === 400 && k[2].y === 10 + (180 - 60) / 2 + 20, "an ABSOLUTE child is out of the flow and stays where it is put");

  const G = frame(f, { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", itemSpacing: 10, paddingTop: 5, paddingBottom: 5 });
  G.resize(200, 50);
  const g = [rect(f, G, 50, 10), rect(f, G, 10, 10, { layoutGrow: 1 }), rect(f, G, 10, 10, { layoutGrow: 1, layoutAlign: "STRETCH" })];
  check(same(g.map((c) => [c.x, c.width]), [[0, 50], [60, 65], [135, 65]]) && g[2].height === 40 && g[2].y === 5 && g[1].height === 10,
    "grow shares the free primary space; STRETCH takes the inner counter size", JSON.stringify(g.map((c) => [c.x, c.y, c.width, c.height])));
  G.counterAxisSizingMode = "AUTO";
  check(g[2].height === 40 && G.height === 50, "in a hugging counter axis a STRETCH child keeps its size (builder4: Figma pins it)", G.height + " " + g[2].height);
  check(G.layoutSizingVertical === "HUG" && g[1].layoutSizingHorizontal === "FILL" && g[0].layoutSizingHorizontal === "FIXED", "layoutSizing* read back from the modes");

  // The padding floor (builder4.js:302-306, measured): never smaller than the padding on the flow axis,
  // nor on the counter axis (the first live build of U, 2026-10-06: a vertical flow 24 px wide with
  // 35 + 35 px of side padding was built 70 px wide).
  const P = frame(f, { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", paddingLeft: 4, paddingRight: 4, paddingTop: 4, paddingBottom: 4 });
  P.resize(4, 4);
  const floor = [P.width, P.height];
  P.layoutMode = "NONE"; P.resize(4, 4);
  check(same(floor, [8, 8]) && P.width === 4 && P.height === 4 && P.paddingLeft === 4, "the padding floor on both axes, gone with layoutMode NONE while the padding stays", JSON.stringify(floor));
  const PV = frame(f, { layoutMode: "VERTICAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", paddingLeft: 35, paddingRight: 35 });
  PV.resize(24, 24);
  check(PV.width === 70 && PV.height === 24, "the counter-axis floor: a vertical flow 24 px wide with 35 + 35 px of side padding is 70 px wide (U, live)", JSON.stringify([PV.width, PV.height]));

  // layoutPositioning ABSOLUTE is refused under a parent with no flow (U, live: "Can only set
  // layoutPositioning = ABSOLUTE if the parent node has layoutMode !== NONE"); AUTO is taken anywhere,
  // and ABSOLUTE once the parent has its flow.
  const NF = frame(f, {}), nf = rect(f, NF, 10, 10);
  let refused = null;
  try { nf.layoutPositioning = "ABSOLUTE"; } catch (e) { refused = e.message; }
  nf.layoutPositioning = "AUTO";
  NF.layoutMode = "VERTICAL";
  nf.layoutPositioning = "ABSOLUTE";
  check(/Can only set layoutPositioning = ABSOLUTE if the parent node has layoutMode !== NONE/.test(String(refused)) && nf.layoutPositioning === "ABSOLUTE",
    "layoutPositioning ABSOLUTE is refused under a parent with no flow and taken once the flow exists", String(refused));

  const S = frame(f, { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", strokes: [BLACK], strokeWeight: 3, strokeAlign: "INSIDE" });
  const s = rect(f, S, 10, 10);
  const before = [S.width, s.x];
  S.strokesIncludedInLayout = true;
  check(same(before, [10, 0]) && S.width === 16 && s.x === 3 && s.y === 3, "an INSIDE stroke takes no room until strokesIncludedInLayout", JSON.stringify([before, S.width, s.x]));

  const W = frame(f, { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO", layoutWrap: "WRAP", itemSpacing: 10, counterAxisSpacing: 5 });
  W.resize(100, 10);
  const w = [rect(f, W, 40, 10), rect(f, W, 40, 10), rect(f, W, 40, 10)];
  check(W.height === 25 && same([w[1].x, w[2].x, w[2].y], [50, 0, 15]), "wrap: rows broken at the inner width, counterAxisSpacing between them", JSON.stringify([W.height, w.map((c) => [c.x, c.y])]));

  const R = frame(f, { layoutMode: "HORIZONTAL" });
  const rr = rect(f, R, 10, 20);
  rr.relativeTransform = [[0, -1, 5], [1, 0, 5]];
  const free = rect(f, f.createFrame(), 10, 20);
  free.relativeTransform = [[0, -1, 5], [1, 0, 5]];
  check(same(rr.relativeTransform[0].slice(0, 2), [1, 0]) && same(free.relativeTransform[0].slice(0, 2), [0, -1]),
    "a flow child's rotation is dropped when written (builder4.js:381-389, measured); a free child keeps it");

  // Constraints apply when a parent is resized, not when it is resized without them.
  const C = f.createFrame(); C.resize(100, 100);
  const c1 = rect(f, C, 10, 10, { constraints: { horizontal: "MAX", vertical: "MIN" } }); c1.x = 80;
  const c2 = rect(f, C, 20, 10, { constraints: { horizontal: "STRETCH", vertical: "MIN" } }); c2.x = 40;
  const c3 = rect(f, C, 10, 10, { constraints: { horizontal: "CENTER", vertical: "MAX" } }); c3.x = 45; c3.y = 90;
  const c4 = rect(f, C, 20, 10, { constraints: { horizontal: "SCALE", vertical: "MIN" } }); c4.x = 10;
  C.resize(150, 120);
  const after = [c1.x, c2.width, c3.x, c3.y, c4.x, c4.width];
  C.resizeWithoutConstraints(300, 300);
  check(same(after, [130, 70, 70, 110, 15, 30]) && c1.x === 130 && c2.width === 70, "constraints on resize (MAX, STRETCH, CENTER, SCALE), none on resizeWithoutConstraints", JSON.stringify(after));

  // Nested: a fixed-width column, a stretched auto-height text in it, the column hugging the text.
  await f.loadFontAsync({ family: "Inter", style: "Regular" });
  const col = frame(f, { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  col.resize(120, 10);
  const t = f.createText(); col.appendChild(t);
  t.fontSize = 16; t.characters = "one two three four five six seven";
  t.textAutoResize = "HEIGHT"; t.layoutAlign = "STRETCH";
  const style = () => ({ fontName: { family: "Inter", style: "Regular" }, fontSize: 16, letterSpacing: { unit: "PERCENT", value: 0 }, lineHeight: { unit: "AUTO" }, textCase: "ORIGINAL" });
  const at = (wd) => textMetrics({ characters: "one two three four five six seven", styleAt: style }, { width: wd });
  const h120 = col.height, w120 = t.width;
  col.resize(60, col.height);
  check(w120 === 120 && near(h120, at(120).height) && t.width === 60 && near(col.height, at(60).height) && col.height > h120,
    "a stretched auto-height text wraps at the width the flow gives it, and its hugging parent follows", JSON.stringify([w120, h120, t.width, col.height]));

  check(/FILL can only be set on children of auto-layout frames/.test(threw(() => { f.createRectangle().layoutSizingHorizontal = "FILL"; })) &&
    /HUG can only be set/.test(threw(() => { f.createRectangle().layoutSizingVertical = "HUG"; })),
    "layoutSizing FILL outside an auto-layout parent and HUG on a rectangle throw, as Figma does");
  D.setPhase("create"); const r0 = D.reads.total; void F.fills; void F.layoutMode;
  check(D.reads.total === r0, "reading layout props that force no layout is not counted as a layout read");
}

// ============================================================================================
// 3. text
// ============================================================================================
{
  const D = makeDouble(), f = D.figma;
  const t = f.createText();
  check(/unloaded font/.test(threw(() => { t.characters = "x"; })) && /not available/.test(await rejects(f.loadFontAsync({ family: "Nope", style: "Regular" }))),
    "a text write before its font is loaded throws, and a font Figma lacks will not load");
  await f.loadFontAsync({ family: "Roboto", style: "Regular" });
  const ro = f.createText(); ro.fontName = { family: "Roboto", style: "Regular" }; ro.characters = "Roboto only";
  check(ro.width > 0 && D.loadedFonts().join() === "Roboto|Regular", "a text given a new font needs only that font loaded, not the default it replaces");
  await f.loadFontAsync({ family: "Inter", style: "Regular" });
  t.fontSize = 16; t.characters = "Hello world";
  const st = { fontName: { family: "Inter", style: "Regular" }, fontSize: 16, letterSpacing: { unit: "PERCENT", value: 0 }, lineHeight: { unit: "AUTO" }, textCase: "ORIGINAL" };
  const pix = textMetrics({ characters: "Hello world", styleAt: () => st }, { width: null, ratio: 1 });
  check(near(t.width, pix.width * DEFAULT_TEXT_RATIO, 1e-9) && near(t.height, 19.2) && DEFAULT_TEXT_RATIO === 1.0105,
    "auto width: Figma's width is Pixso's times the ratio (1.0105 by default), one line of 1.2 em", JSON.stringify([t.width, pix.width, t.height]));
  // Decision 9: a text that fits its stored box on one line in Pixso wraps in Figma.
  t.resize(pix.width, t.height);
  check(t.textAutoResize === "HEIGHT" && near(t.height, 38.4), "decision 9: a one-line Pixso text at its stored width wraps to two lines here", t.textAutoResize + " " + t.height);
  const D1 = makeDouble({ textRatio: 1 });
  await D1.figma.loadFontAsync({ family: "Inter", style: "Regular" });
  const t1 = D1.figma.createText(); t1.fontSize = 16; t1.characters = "Hello world"; t1.resize(pix.width, t1.height);
  check(near(t1.height, 19.2), "with textRatio 1 the same text stays on one line", t1.height);
  // Reset semantics (A until a live check): an auto-width text given another width becomes auto-height,
  // any auto text given another height becomes fixed; a fixed one stays fixed.
  const r = f.createText(); r.characters = "abc";
  r.resize(200, r.height);
  const m1 = r.textAutoResize;
  r.resize(200, 50);
  const m2 = r.textAutoResize, h2 = r.height;
  r.characters = "a much longer text than before, which would wrap";
  check(m1 === "HEIGHT" && m2 === "NONE" && h2 === 50 && r.height === 50 && r.width === 200, "resize resets textAutoResize: WIDTH_AND_HEIGHT to HEIGHT, then NONE; a fixed box keeps its size", [m1, m2, h2, r.height].join(","));
  // The countLines formula on what the model draws: round((H - paragraphSpacing x (paragraphs - 1)) / L).
  const c = f.createText();
  c.characters = "aaa bbb ccc ddd eee\nfff ggg"; c.lineHeight = { unit: "PIXELS", value: 20 }; c.paragraphSpacing = 10;
  c.resize(60, c.height); c.textAutoResize = "HEIGHT";
  const cm = textMetrics({ characters: "aaa bbb ccc ddd eee\nfff ggg", styleAt: () => Object.assign({}, st, { fontSize: 12, lineHeight: { unit: "PIXELS", value: 20 } }) }, { width: 60 });
  check(cm.lines.length >= 3 && Math.round((c.height - 10 * (2 - 1)) / 20) === cm.lines.length, "the countLines formula gives the model's line count back (paragraph spacing taken out)", c.height + " / " + cm.lines.length);
  c.textTruncation = "ENDING"; c.maxLines = 2;
  check(c.height === 40, "textTruncation ENDING with maxLines 2 shows two lines", c.height);
  const lt = f.createText(); lt.fontSize = 20; lt.characters = "Cap"; lt.lineHeight = { unit: "PIXELS", value: 30 };
  const h0 = lt.height; lt.leadingTrim = "CAP_HEIGHT";
  check(h0 === 30 && near(lt.height, 14), "leading trim CAP_HEIGHT takes the leading and the space above the cap and below the baseline", h0 + " -> " + lt.height);
  // Ranges, figma.mixed, and what clears them.
  const g = f.createText(); g.characters = "Hello world";
  g.setRangeFontSize(0, 5, 32);
  const mixedSize = g.fontSize === f.mixed;
  check(mixedSize && g.getRangeFontSize(0, 5) === 32 && g.getRangeFontSize(0, 11) === f.mixed && near(g.height, 38.4), "a range makes the node-level read figma.mixed, and its line takes the larger line height", g.height);
  g.fontSize = 10;
  check(g.fontSize === 10 && g.getRangeFontSize(0, 5) === 10, "a node-level write clears that field's ranges");
  check(/unloaded font/.test(threw(() => g.setRangeFontName(0, 2, { family: "Inter", style: "Bold" }))), "a range in a font not loaded throws");
  await f.loadFontAsync({ family: "Inter", style: "Bold" });
  g.setRangeFontName(2, 4, { family: "Inter", style: "Bold" });
  const wBold = g.width;
  g.characters = "Hello world";
  check(g.fontName.style === "Regular" && g.width < wBold, "writing characters clears every range past the first character; a bold range draws wider", [g.fontName.style, g.width, wBold].join(","));
  // New characters take the first character's style (A; part F, review figma F5): a list or an
  // indentation on it carries over to whatever text is written next.
  g.setRangeListOptions(0, 11, { type: "UNORDERED" }); g.setRangeIndentation(0, 11, 1);
  g.characters = "Plain text";
  const kept = D.rangesOf(g.id).map((r) => [r.name, r.start, r.end]);
  check(JSON.stringify(kept) === JSON.stringify([["setRangeListOptions", 0, 10], ["setRangeIndentation", 0, 10]]),
    "writing characters keeps the first character's range styles over the new text (a bullet carries over)", JSON.stringify(kept));
  const u = f.createText(); u.characters = "a\u{1F600}b";
  check(threw(() => u.setRangeFontSize(1, 3, 20)) === "" && /outside the characters/.test(threw(() => u.setRangeFontSize(0, 5, 20))), "range bounds are UTF-16 indices (an astral character is two)");
  const e = f.createText();
  check(near(e.height, 14.4) && e.width === 0, "an empty text is one line high and zero wide", e.width + "x" + e.height);
}

// ============================================================================================
// 4. vectors and booleans
// ============================================================================================
{
  const D = makeDouble(), f = D.figma;
  const net = { vertices: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
    regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }] };
  const v = f.createVector(); v.relativeTransform = [[1, 0, 5], [0, 1, 7]];
  await v.setVectorNetworkAsync(net);
  // fillGeometry reads back in Figma's glued form ("M0 0L…", P19B 2026-10-05), starting at the new origin.
  check(same(v.relativeTransform, [[1, 0, 15], [0, 1, 27]]) && v.width === 20 && v.height === 20 && same(drawnBox(v), [15, 27, 35, 47]) && v.fillGeometry[0].data === "M0 0L20 0L20 20L0 0Z",
    "a network off the origin (P19B offsetNetwork ok, recorded): the origin moves to its bounds, the size becomes them, the drawing stays", JSON.stringify([v.relativeTransform, drawnBox(v), v.fillGeometry[0].data]));
  v.resize(40, 10);
  check(same(drawnBox(v), [15, 27, 55, 37]), "resizing a vector scales its drawing", JSON.stringify(drawnBox(v)));
  const Dd = makeDouble({ verdicts: withVerdict("P19B", "offsetNetwork", "drop") });
  const vd = Dd.figma.createVector(); vd.relativeTransform = [[1, 0, 5], [0, 1, 7]];
  await vd.setVectorNetworkAsync(net);
  check(same(vd.relativeTransform, [[1, 0, 5], [0, 1, 7]]) && same(drawnBox(vd), [5, 7, 25, 27]), "with offsetNetwork drop the offset is lost: the drawing moves to the origin");
  const loop = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }], regions: [] };
  // A closed loop with no region is filled, as P19B recorded (regionlessFill ok, 2026-10-05): one
  // NONZERO path, whatever the node's fills (fillGeometry is geometry, as a region's is). With P19B
  // planted pending, the double's assumption (empty) leaves it unfilled; an open chain with no region
  // is never filled (P19 openRegionlessNetworkFilled empty).
  const lv = f.createVector(); lv.fills = []; await lv.setVectorNetworkAsync(loop);
  const lc = f.createVector(); await lc.setVectorNetworkAsync({ vertices: loop.vertices, segments: loop.segments.slice(0, 3), regions: [] });
  const Dp = makeDouble({ verdicts: pendingFor(["P19B"]) });
  const lp = Dp.figma.createVector(); await lp.setVectorNetworkAsync(loop);
  const De = makeDouble({ verdicts: withVerdict("P19B", "regionlessFill", "empty") });
  const le = De.figma.createVector(); await le.setVectorNetworkAsync(loop);
  check(VERDICTS.probes.P19B.verdicts.regionlessFill === "ok" && lv.fillGeometry.length === 1 && lv.fillGeometry[0].windingRule === "NONZERO" &&
    same(drawnBox(lv), [0, 0, 10, 10]) && lc.fillGeometry.length === 0 && lp.fillGeometry.length === 0 && le.fillGeometry.length === 0,
    "a closed loop without a region is filled (P19B regionlessFill ok, recorded), fills [] or not; unfilled when planted pending or empty; an open chain never",
    JSON.stringify([lv.fillGeometry, lc.fillGeometry.length, lp.fillGeometry.length, le.fillGeometry.length]));
  // An ellipse whose sweep is 6.283185 (one 32-bit step below Figma's 2π) draws the whole ellipse, as
  // P19B recorded (arcFullSweep ok); planted pending, the assumption draws a pie short of a turn.
  const sweep = (F) => { const e = F.createEllipse(); e.resize(20, 20); e.arcData = { startingAngle: 0, endingAngle: 6.283185, innerRadius: 0 }; return e.fillGeometry[0].data; };
  const whole = f.createEllipse(); whole.resize(20, 20);
  check(VERDICTS.probes.P19B.verdicts.arcFullSweep === "ok" && sweep(f) === whole.fillGeometry[0].data && sweep(Dp.figma) !== whole.fillGeometry[0].data &&
    /L/.test(sweep(Dp.figma)), "a 6.283185 sweep draws the whole ellipse (P19B arcFullSweep ok, recorded); planted pending, a pie", JSON.stringify([sweep(f).slice(0, 30), sweep(Dp.figma).slice(0, 30)]));
  const pg = f.createPolygon(); pg.resize(30, 20); const sr = f.createStar(); sr.resize(40, 40);
  check(same(drawnBox(pg), [0, 0, 30, 20]) && same(drawnBox(sr), [0, 0, 40, 40]) && pg.fillGeometry[0].data.split("L").length === 3,
    "polygons and stars have their fill geometry, stretched to the node's box");
  const Da = makeDouble({ verdicts: withVerdict("P19B", "autoClosedLoop", "throw") });
  check(/open subpath/.test(threw(() => { Da.figma.createVector().vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 5 0 L 5 5" }]; })),
    "vectorPaths with an open subpath follow P19B autoClosedLoop (here: throw)");

  // Booleans follow their operands, leave hidden ones out, and refuse per verdict or fault.
  const P = f.createFrame(); P.relativeTransform = [[1, 0, 100], [0, 1, 100]];
  const a = rect(f, P, 20, 20), b = rect(f, P, 20, 20); b.x = 10; b.y = 10;
  const h = rect(f, P, 50, 50); h.visible = false;
  const u = f.union([a, b, h], P);
  const first = drawnBox(u);
  a.x = -10;
  check(same(first, [100, 100, 130, 130]) && same(drawnBox(u), [90, 100, 130, 130]) && u.x === -10 && same(box(b), [110, 110, 20, 20]),
    "a boolean is its visible operands' operation, and its box follows an operand that moves", JSON.stringify([first, drawnBox(u)]));
  const i2 = rect(f, P, 20, 20); i2.x = 15;
  const x = f.intersect([rect(f, P, 20, 20), i2], P);
  check(same(drawnBox(x), [115, 100, 120, 120]) && x.width === 5, "an intersection's box is its result's", JSON.stringify(drawnBox(x)));
  const Df = makeDouble({ faults: { subtract: "synthetic refusal" } });
  const Dn = makeDouble({ verdicts: withVerdict("P19B", "nestedBoolean", "throw") });
  const inner = Dn.figma.union([Dn.figma.createRectangle()], Dn.figma.currentPage);
  check(/synthetic refusal/.test(threw(() => Df.figma.subtract([Df.figma.createRectangle()], Df.figma.currentPage))) &&
    /nestedBoolean/.test(threw(() => Dn.figma.union([inner, Dn.figma.createRectangle()], Dn.figma.currentPage))),
    "a boolean Figma refuses: by fault (BOOLEAN_FALLBACK tests) or by verdict");
  // Strokes in a boolean, as P19B recorded (2026-10-05). strokedOperand differs: an unfilled 10 x 10
  // under a 4 px CENTER stroke counts with its stroked box, -2..12. lineOperand differs: a 30 px LINE at
  // y 25 under a 4 px stroke joins a UNION with its own path, no area and no stroke: 0..30 x 0..25 with
  // a 20 x 20 square (the probe's measurement), one path. Planted pending, the assumptions: strokes
  // ignored, a LINE adds nothing.
  const stroked = (F) => { const so = F.createRectangle(); so.resize(10, 10); so.fills = []; so.strokes = [BLACK]; so.strokeWeight = 4; so.strokeAlign = "CENTER"; return F.union([so], F.currentPage); };
  const lined = (F) => {
    const sq = F.createRectangle(); sq.resize(20, 20);
    const l = F.createLine(); l.resize(30, 0); l.relativeTransform = [[1, 0, 0], [0, 1, 25]]; l.strokes = [BLACK]; l.strokeWeight = 4;
    return F.union([sq, l], F.currentPage);
  };
  const su = stroked(f), sp = stroked(Dp.figma), lu = lined(f), lp2 = lined(Dp.figma);
  check(VERDICTS.probes.P19B.verdicts.strokedOperand === "differs" && same(drawnBox(su), [-2, -2, 12, 12]) && same(drawnBox(sp), [0, 0, 10, 10]),
    "strokedOperand differs (recorded): an operand's stroke widens its area by the part outside it; planted pending, strokes are ignored", JSON.stringify([drawnBox(su), drawnBox(sp)]));
  check(VERDICTS.probes.P19B.verdicts.lineOperand === "differs" && same(drawnBox(lu), [0, 0, 30, 25]) && lu.fillGeometry.length === 1 && lu.width === 30 && lu.height === 25 &&
    same(drawnBox(lp2), [0, 0, 20, 20]),
    "lineOperand differs (recorded): a LINE's own path joins a union, its bounds the line's ends and not its stroke's; planted pending, a LINE adds nothing",
    JSON.stringify([drawnBox(lu), lu.fillGeometry.length, drawnBox(lp2)]));
  // Every boolean result path is labelled NONZERO, EXCLUDE included (P19B's m.winding, 2026-10-05),
  // and an EXCLUDE's traced loops still draw its parity under that rule: the overlap is a hole.
  const e1 = rect(f, P, 20, 20), e2 = rect(f, P, 20, 20); e2.x = 10;
  const ex = f.exclude([e1, e2], P);
  const s1 = rect(f, P, 20, 20), s2 = rect(f, P, 20, 20); s2.x = 10;
  const sb = f.subtract([s1, s2], P);
  const subs = (ex.fillGeometry[0].data.match(/M/g) || []).length;
  check([u, x, sb, ex].every((n) => n.fillGeometry.length === 1 && n.fillGeometry[0].windingRule === "NONZERO") && same(drawnBox(ex), [100, 100, 130, 120]) && subs === 2 &&
    same(drawnBox(sb), [100, 100, 110, 120]),
    "every boolean result reads NONZERO (UNION, INTERSECT, SUBTRACT, EXCLUDE), as P19B measured; an EXCLUDE is two loops, its overlap left out",
    JSON.stringify([[u, x, sb, ex].map((n) => n.fillGeometry.map((g) => g.windingRule)), drawnBox(ex), subs]));
}

// ============================================================================================
// 5. images
// ============================================================================================
{
  const D = makeDouble(), f = D.figma;
  const PI = bundle(D).PXF_IR.probeImages;
  const png = PI.pngGray1(3, 2), jpg = PI.jpegGray8(), webp = PI.webp1x1();
  const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 5, 0, 7, 0, 0, 0, 0]);
  check(same([png, jpg, webp, gif].map((bb) => { const s = sniffImage(bb); return [s.format, s.width, s.height]; }), [["png", 3, 2], ["jpeg", 8, 8], ["webp", 1, 1], ["gif", 5, 7]]),
    "format and size from the bytes: PNG, JPEG, WebP, GIF (the probes' synthetic images read as made)");
  const im = f.createImage(jpg);
  check(im.hash === sha1(jpg) && same(await im.getSizeAsync(), { width: 8, height: 8 }) && /webpAsPng/.test(threw(() => f.createImage(webp))),
    "createImage hashes with SHA-1 and reads a JPEG's size; WebP bytes are refused (P8 webpAsPng throw, recorded)");
  const Dd = makeDouble({ verdicts: withVerdict("P8", "jpegAsPng", "drop") });
  const id = Dd.figma.createImage(jpg), rr = Dd.figma.createRectangle();
  rr.fills = [{ type: "IMAGE", imageHash: id.hash, scaleMode: "FILL" }, BLACK];
  const De = makeDouble({ verdicts: withVerdict("P8", "jpegAsPng", "empty") });
  const ie = De.figma.createImage(jpg);
  check(rr.fills.length === 1 && rr.fills[0].type === "SOLID" && same(await ie.getSizeAsync(), { width: 0, height: 0 }) && (await ie.getBytesAsync()).length === 0,
    "P8 drop: the image is made and a fill naming it is dropped; P8 empty: it is made with no bytes and no size");
  const Du = makeDouble({ verdicts: withVerdict("P8", "unknownHash", "throw") });
  const unknown = { type: "IMAGE", imageHash: sha1("pxf no such image"), scaleMode: "FILL" };
  const kept = f.createRectangle(); kept.fills = [unknown];
  check(/unknownHash/.test(threw(() => { Du.figma.createRectangle().fills = [unknown]; })) && kept.fills.length === 1,
    "an IMAGE paint with an unknown hash: kept (P8 unknownHash ok, recorded), a throw when the verdict says so");
  const Dh = makeDouble({ verdicts: withVerdict("P4", "sameHash", "differs") });
  check(Dh.figma.createImage(jpg).hash !== sha1(jpg) && /^[0-9a-f]{40}$/.test(Dh.figma.createImage(jpg).hash), "P4 sameHash differs: a re-encoding Figma, whose hash is not the bytes' SHA-1");
}

// ============================================================================================
// 6. the probes' arguments, and P4 through a simulated window
// ============================================================================================
{
  const D = makeDouble();
  const IR = bundle(D).PXF_IR;
  const H40 = sha1("pxf synthetic");
  check(/P4 needs p4/.test(threw(() => IR.probes.P4.args({}))) && /hashes/.test(threw(() => IR.probes.P4.args({ p4: { hashes: ["xyz"] } }))) &&
    /repeat/.test(threw(() => IR.probes.P4.args({ p4: { hashes: [H40], repeat: 0 } }))) && /p4 is/.test(threw(() => IR.probes.P4.args({ p4: { hashes: [H40], other: 1 } }))) &&
    /p8.cases/.test(threw(() => IR.probes.P8.args({ p8: { cases: ["png9999"] } }))) && /keep/.test(threw(() => IR.probes.P19B.args({ p19b: { keep: "yes" } }))) &&
    /p19b.cases/.test(threw(() => IR.probes.P19B.args({ p19b: { cases: [] } }))) && same(IR.probes.P4.args({ p4: { hashes: [H40] } }), { p4Hashes: [H40], p4Repeat: 3 }),
    "each probe refuses its own bad arguments (P4's hashes and repeat, P8's cases, P19B's keep and cases)");
  const imgs = p4Images([40, 60]);
  const win = (delay, corrupt) => ({
    ask: async (m) => {
      const bb = imgs.get(m.hash);
      if (!bb) return { error: "no such image" };
      await sleep(m.as === "raw" ? delay.raw : delay.b64);
      if (m.as === "raw") { const u = new Uint8Array(bb); if (corrupt) u[u.length - 1] ^= 1; return { d: u }; }
      return { d: bb.toString("base64") };
    } });
  const args = Object.assign({ deadlineMs: 1000 }, IR.probes.P4.args({ p4: { hashes: [...imgs.keys()], repeat: 2 } }));
  const fast = await IR.probes.P4.run(args, win({ raw: 1, b64: 25 }));
  const slow = await IR.probes.P4.run(args, win({ raw: 25, b64: 1 }));
  const bad = await IR.probes.P4.run(args, win({ raw: 1, b64: 25 }, true));
  check(fast.verdicts.sameHash === "ok" && fast.verdicts.transport === "binary" && slow.verdicts.transport === "base64" &&
    bad.verdicts.sameHash === "differs" && bad.verdicts.transport === "base64" && Object.keys(fast.timings.base64).length === 2,
    "P4: the faster transport that keeps the hash wins; bytes damaged on the way make sameHash differs and keep base64", JSON.stringify([fast.verdicts, slow.verdicts, bad.verdicts]));
  const Dh = makeDouble({ verdicts: withVerdict("P4", "sameHash", "differs") });
  const IRh = bundle(Dh).PXF_IR;
  const re = await IRh.probes.P4.run(args, win({ raw: 1, b64: 1 }));
  check(re.verdicts.sameHash === "differs", "P4 against a re-encoding double reports sameHash differs (conformance for P4.sameHash)");
  check(/window/.test(await rejects(IR.probes.P4.run(args, null))), "P4 refuses to run without the window's round trip");
  check(!/[0-9a-f]{40}/.test(JSON.stringify(fast.cases)), "P4's report names images by an 8-character prefix, never a full hash");
}

// ============================================================================================
// 7. liveness in the job server
// ============================================================================================
function hreq(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
{
  const sec = newSecrets(), said = [];
  const srv = startJobServer(0, Object.assign({ log: (m) => said.push(m) }, sec));
  await srv.ready;
  const H = { Origin: "null", Authorization: "Bearer " + sec.token, "Content-Type": "application/json" };
  const alive = (id, done) => hreq(srv.port, "POST", "/alive" + (id ? "?id=" + id + (done !== undefined ? "&done=" + done : "") : ""), H, "{}");
  const report = (id, obj) => hreq(srv.port, "POST", "/report", H, JSON.stringify({ id, i: 0, n: 1, d: JSON.stringify(obj) }));
  const job = () => hreq(srv.port, "GET", "/job", H).then((r) => JSON.parse(r.body));
  const outcome = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));

  // No advance: warned once, then failed with PLUGIN_STALLED, and the job is no longer pending.
  let t0 = Date.now();
  const p1 = outcome(srv.post({ kind: "ir" }, "{}", new Map(), 30000, { liveness: { warnMs: 120, failMs: 400 } }));
  const id1 = (await job()).id;
  const r1 = await p1;
  const took1 = Date.now() - t0;
  check(r1.err && r1.err.code === CODE.PLUGIN_STALLED && r1.err.resumable === true && r1.err.stall === "stalled" && took1 >= 400 && took1 < 3000 &&
    said.filter((l) => /has made no progress/.test(l)).length === 1 && (await job()).kind === "noop",
    "no advancing counter: one warning after warnMs, then PLUGIN_STALLED (failed, resumable) after failMs, and the job is withdrawn", (r1.err && r1.err.message) + " in " + took1 + " ms");

  // An advancing counter keeps a job alive past failMs; onProgress hears each advance; a repeated
  // count, and a count for another job, are not advances.
  const heard = [];
  t0 = Date.now();
  const p2 = outcome(srv.post({ kind: "ir" }, "{}", new Map(), 30000, { liveness: { warnMs: 150, failMs: 300 }, onProgress: (d, id) => heard.push([d, id]) }));
  const id2 = (await job()).id;
  for (let k = 1; k <= 6; k++) { await sleep(120); await alive(id2, k); if (k === 3) await alive(id2, 3); }
  await alive(id1, 99);
  await report(id2, { op: "fonts", fine: 1 });
  const r2 = await p2;
  check(r2.ok && r2.ok.fine === 1 && Date.now() - t0 > 600 && same(heard.map((hh) => hh[0]), [1, 2, 3, 4, 5, 6]) && heard.every((hh) => hh[1] === id2),
    "an advancing counter keeps the job alive well past failMs; onProgress hears every advance once; another job's count is ignored", JSON.stringify([r2, heard]));

  // A heartbeat alone (no count) never extends a task.
  const p3 = outcome(srv.post({ kind: "ir" }, "{}", new Map(), 30000, { liveness: { warnMs: 100, failMs: 350 } }));
  const id3 = (await job()).id;
  for (let k = 0; k < 6; k++) { await sleep(80); await alive(id3); await alive(null); }
  const r3 = await p3;
  check(r3.err && r3.err.code === CODE.PLUGIN_STALLED, "a heartbeat without an advancing counter does not keep a job alive", r3.err ? r3.err.message : JSON.stringify(r3));

  // The ceiling fails a job that keeps advancing.
  const p4 = outcome(srv.post({ kind: "ir" }, "{}", new Map(), 30000, { liveness: { warnMs: 200, failMs: 400 }, ceilingMs: 500 }));
  const j4 = await job(), id4 = j4.id;
  check(j4.ceilingMs === 500, "the job the plugin window takes carries the runner's ceiling, so its watchdog can wait longer (review S10)", JSON.stringify(j4));
  for (let k = 1; k <= 10; k++) { await sleep(80); await alive(id4, k); }
  const r4 = await p4;
  check(r4.err && r4.err.code === CODE.PLUGIN_STALLED && r4.err.stall === "ceiling", "the per-task ceiling fails a job however it advances", r4.err ? r4.err.message : JSON.stringify(r4));

  // Fetching the payload is the job moving too.
  const p5 = outcome(srv.post({ kind: "ir" }, "{\"x\":1}", new Map(), 30000, { liveness: { warnMs: 150, failMs: 300 } }));
  const id5 = (await job()).id;
  for (let k = 0; k < 4; k++) { await sleep(120); await hreq(srv.port, "GET", "/job/" + id5 + "/payload", H); }
  await report(id5, { fine: 5 });
  const r5 = await p5;
  check(r5.ok && r5.ok.fine === 5, "the window fetching the job's payload counts as an advance", JSON.stringify(r5.err && r5.err.message));

  // Without liveness options a job is not watched (the M0 kinds), and the image transport is checked.
  const p6 = outcome(srv.post({ kind: "render" }, "{}", new Map(), 30000));
  const j6 = await job();
  await sleep(450);
  await report(j6.id, { fine: 6 });
  const r6 = await p6;
  const badT = await rejects(srv.post({ kind: "ir", imageTransport: "carrier pigeon" }, "{}", new Map(), 1000));
  check(r6.ok && r6.ok.fine === 6 && VERDICTS.probes.P4.verdicts.transport === "binary" && defaultImageTransport() === "binary" &&
    j6.imageTransport === "binary" && srv.imageTransport === "binary" && /imageTransport/.test(badT) && same(IMAGE_TRANSPORTS, ["base64", "binary"]),
    "a job without liveness options is not watched; a job carries its image transport (binary, as P4 recorded) and an unknown one is refused",
    JSON.stringify([j6.imageTransport, srv.imageTransport]));
  // The default follows P4's verdict: base64 while it is pending (planted) or says base64, binary when
  // it says binary; a job that names base64 gets it whatever the default.
  const p7 = outcome(srv.post({ kind: "ir", imageTransport: "base64" }, "{}", new Map(), 30000));
  const j7 = await job();
  await report(j7.id, { fine: 7 });
  const r7 = await p7;
  check(defaultImageTransport(pendingFor(["P4"])) === "base64" && defaultImageTransport(withVerdict("P4", "transport", "base64")) === "base64" &&
    defaultImageTransport(withVerdict("P4", "transport", "binary")) === "binary" && r7.ok && r7.ok.fine === 7 && j7.imageTransport === "base64",
    "the default image transport is P4's verdict (base64 while P4 is pending), and a job may name its own", JSON.stringify(j7.imageTransport));
  srv.close();
}

console.log("");
console.log(failed ? "test-double: " + failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "test-double: all checks pass");
process.exit(failed ? 1 : 0);

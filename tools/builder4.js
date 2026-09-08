// Builder body. Shipped INSIDE the PNG carrier as PAY.B and eval'd by the bootstrap.
// Globals available when it runs: figma, PAY (={D,S,F,B}).
export const BUILDER_SRC = `
const REPORT = { nodes: 0, svg: 0, failures: [], fontSubs: [], rtFail: 0, textPinned: 0, textOverrideLost: [], textUnderSubstitutedFont: [] };
// family|style -> true once a font failed to load and the fallback was used. A substituted
// font draws to a different width, which the override detector must not read as a lost override.
const SUBBED = {};
const FONTSTATE = {};
const FB = { family: "Inter", style: "Regular" };
const D = PAY.D, S = PAY.S, F = PAY.F;
function tryset(n, k, v, id) { try { n[k] = v; } catch (e) { REPORT.failures.push(id + "." + k + ": " + String(e.message || e).slice(0, 80)); } }

const AL_A = { layoutWrap: "z", primaryAxisSizingMode: "A", counterAxisSizingMode: "B", primaryAxisAlignItems: "C",
  counterAxisAlignItems: "D", paddingLeft: "E", paddingRight: "F", paddingTop: "G", paddingBottom: "H",
  itemSpacing: "I", counterAxisSpacing: "J" };
const PAINT = { N: "fills", O: "strokes", P: "effects" };
const PLAIN = [["t", "strokeWeight"], ["u", "strokeAlign"], ["v", "strokeJoin"], ["w", "dashPattern"],
  ["n", "cornerRadius"], ["o", "topLeftRadius"], ["p", "topRightRadius"], ["q", "bottomLeftRadius"],
  ["r", "bottomRightRadius"], ["s", "cornerSmoothing"], ["m", "clipsContent"], ["e", "opacity"],
  ["f", "blendMode"], ["c", "visible"], ["d", "locked"], ["g", "isMask"],
  ["sC", "strokeCap"], ["sM", "strokeMiterLimit"], ["lG", "layoutGrids"],
  ["eS", "exportSettings"], ["oD", "overflowDirection"]];
const SVG_PLAIN = [["e", "opacity"], ["f", "blendMode"], ["c", "visible"], ["g", "isMask"]];
const TXT = [["T", "fontSize"], ["V", "textAlignHorizontal"], ["W", "textAlignVertical"], ["Y", "textCase"],
  ["Z", "textDecoration"], ["0", "letterSpacing"], ["1", "lineHeight"], ["2", "paragraphIndent"], ["3", "paragraphSpacing"]];
const DICTKEY = { N: 1, O: 1, P: 1, Q: 1, U: 1, "0": 1, "1": 1, w: 1, lG: 1, eS: 1, aD: 1 };
function dv(d, k) { return d[k] === undefined ? undefined : (DICTKEY[k] ? D[d[k]] : d[k]); }

// Image bytes are put into the file by the host before the build; PAY.IMG maps the hash Pixso
// used to the hash this file gave the same bytes. Identical bytes give an identical hash, so it
// is normally the identity map -- but not for images Pixso never held locally, which the runner
// substitutes with a render.
const IMGMAP = PAY.IMG || {};
if (Object.keys(IMGMAP).length) {
  var remapped = 0;
  var seen = [];
  (function fix(v) {
    if (!v || typeof v !== "object" || seen.indexOf(v) >= 0) return;
    seen.push(v);
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) fix(v[i]); return; }
    if (v.imageHash && IMGMAP[v.imageHash] && IMGMAP[v.imageHash] !== v.imageHash) { v.imageHash = IMGMAP[v.imageHash]; remapped++; }
    for (var k in v) fix(v[k]);
  })(D);
  REPORT.imageRemapped = remapped;
}

function makeNode(d) {
  var t = d.b;
  if (t === "SVG") {
    REPORT.svg++;
    var n = figma.createNodeFromSvg(S[d["6"]]);
    try { n.fills = []; } catch (e) {}
    // createNodeFromSvg sizes the frame to the viewBox, which is the INKED box. d.j/d.k are the
    // layout box the source node occupied. Where they differ, d["9"] is where the ink sits inside
    // the layout box. Pin the imported children to MIN/MIN first or resizing scales them.
    var off = d["9"];
    if (off && d.j !== undefined && d.k !== undefined) {
      var ch = n.children;
      for (var oi = 0; oi < ch.length; oi++) { try { ch[oi].constraints = { horizontal: "MIN", vertical: "MIN" }; } catch (e) {} }
      try { n.resize(Math.max(0.01, d.j), Math.max(0.01, d.k)); REPORT.svgInkOffset = (REPORT.svgInkOffset || 0) + 1; } catch (e) {}
      for (var oj = 0; oj < ch.length; oj++) { try { ch[oj].x = ch[oj].x + off[0]; ch[oj].y = ch[oj].y + off[1]; } catch (e) {} }
    }
    return n;
  }
  if (t === "TEXT") return figma.createText();
  if (t === "RECTANGLE") return figma.createRectangle();
  if (t === "ELLIPSE") return figma.createEllipse();
  // A section is a section, not a frame. It only exists at page level, which is where the source
  // has them; createSection throws anywhere else, so fall back rather than lose the whole build.
  if (t === "SECTION") {
    try { REPORT.sections = (REPORT.sections || 0) + 1; return figma.createSection(); }
    catch (e) { REPORT.failures.push("createSection: " + String(e.message || e).slice(0, 60)); }
  }
  return figma.createFrame();
}

// Figma terminates a plugin that holds the thread too long, which is why the two largest
// sections died in their final passes while everything smaller finished. Yield every so many
// iterations inside the long loops, not just between them.
function settle() { return new Promise(function (r) { if (typeof setTimeout === "function") setTimeout(r, 0); else r(); }); }
var YIELD_EVERY = 400;
const T0 = Date.now(); var TMARK = T0;
REPORT.ms = {};
function phase(name) { var t = Date.now(); REPORT.ms[name] = t - TMARK; TMARK = t; }

const built = [];
for (var i = 0; i < F.length; i++) {
  if (i % YIELD_EVERY === 0 && i > 0) await settle();
  var rec = F[i], d = rec.d, id = "#" + i;
  var parent = rec.p < 0 ? figma.currentPage : built[rec.p];
  var node = makeNode(d);
  parent.appendChild(node);
  built[i] = node;
  REPORT.nodes++;
  if (d.a !== undefined) tryset(node, "name", d.a, id);

  if (d.b !== "SVG" && d.j !== undefined && d.k !== undefined) {
    // A section resizes only through resizeWithoutConstraints.
    var rz = node.type === "SECTION" ? node.resizeWithoutConstraints : node.resize;
    if (rz) {
      try { rz.call(node, Math.max(0.01, d.j), Math.max(0.01, d.k)); }
      catch (e) { REPORT.failures.push(id + ".resize: " + String(e.message || e).slice(0, 60)); }
    }
  }

  if (d.b === "TEXT") {
    var fn = dv(d, "U");
    var use = fn && fn.family ? { family: fn.family, style: fn.style } : FB;
    var fkey = use.family + "|" + use.style;
    if (FONTSTATE[fkey] === undefined) {
      try { await figma.loadFontAsync(use); FONTSTATE[fkey] = 1; }
      catch (e2) { FONTSTATE[fkey] = 0; SUBBED[fkey] = true; REPORT.fontSubs.push(fkey); await figma.loadFontAsync(FB); }
    }
    if (!FONTSTATE[fkey]) use = FB;
    node.fontName = use;
    if (d.S !== undefined) tryset(node, "characters", d.S, id);
    for (var t1 = 0; t1 < TXT.length; t1++) if (d[TXT[t1][0]] !== undefined) tryset(node, TXT[t1][1], dv(d, TXT[t1][0]), id);
  }

  if (node.type === "SECTION") {
    // A section holds almost nothing: no strokes, no corners, no clipping, no auto-layout.
    // Setting those would only fill the failure list with noise.
    if (d.N !== undefined) tryset(node, "fills", dv(d, "N"), id);
    if (d.c !== undefined) tryset(node, "visible", d.c, id);
    if (d.d !== undefined) tryset(node, "locked", d.d, id);
  } else if (d.b !== "SVG") {
    for (var pk in PAINT) if (d[pk] !== undefined) tryset(node, PAINT[pk], dv(d, pk), id);
    for (var q = 0; q < PLAIN.length; q++) if (d[PLAIN[q][0]] !== undefined) tryset(node, PLAIN[q][1], dv(d, PLAIN[q][0]), id);
    // Assigning strokeWeight resets the four side weights, so these come after it. Pixso reports
    // strokeWeight as one number even when the sides differ: a frame with only a bottom border
    // arrives as a 1 px box unless the sides are carried.
    if (d.h !== undefined) {
      tryset(node, "strokeTopWeight", d.h, id);
      tryset(node, "strokeRightWeight", d.i, id);
      tryset(node, "strokeBottomWeight", d.l, id);
      tryset(node, "strokeLeftWeight", d.x, id);
      REPORT.sideStrokes = (REPORT.sideStrokes || 0) + 1;
    }

    // An arc or a donut is an ellipse plus arcData; without it Figma draws a full ellipse.
    if (d.aD !== undefined) {
      tryset(node, "arcData", dv(d, "aD"), id);
      REPORT.arcs = (REPORT.arcs || 0) + 1;
    }

    // Per-range text fills. Pixso reports fills as mixed for a two-tone string and returns no
    // segments at all, so px-textruns.mjs rebuilds the runs with getRangeFills and they are
    // applied here, after the node fills have been set.
    if (d.b === "TEXT" && d["5"]) {
      var runs = d["5"];
      for (var rr = 0; rr < runs.length; rr++) {
        try { node.setRangeFills(runs[rr][0], runs[rr][1], D[runs[rr][2]]); }
        catch (er) { REPORT.failures.push(id + ".setRangeFills: " + String(er.message || er).slice(0, 60)); }
      }
      REPORT.textRuns = (REPORT.textRuns || 0) + 1;
    }
  } else {
    if (d.P !== undefined) tryset(node, "effects", dv(d, "P"), id);
    for (var q2 = 0; q2 < SVG_PLAIN.length; q2++) if (d[SVG_PLAIN[q2][0]] !== undefined) tryset(node, SVG_PLAIN[q2][1], dv(d, SVG_PLAIN[q2][0]), id);
  }

  // Pixso GROUPs do not clip and report no clipsContent; createFrame() and createNodeFromSvg()
  // both default to clipping, which cuts off strokes and shadows that render outside the box.
  if (d.m === undefined && node.type === "FRAME") tryset(node, "clipsContent", false, id);

  if (d.y && d.y !== "NONE") {
    tryset(node, "layoutMode", d.y, id);
    for (var ak in AL_A) if (d[AL_A[ak]] !== undefined) tryset(node, ak, d[AL_A[ak]], id);
  }
  if (d.b === "TEXT") {
    if (d.X !== undefined) tryset(node, "textAutoResize", d.X, id);
    // Pixso stores text boxes that its own font metrics do not reproduce here. Source geometry
    // wins over auto-sizing: pin the box when re-measuring would move the layout.
    if (d.j !== undefined && d.k !== undefined && (Math.abs(node.width - d.j) > 0.5 || Math.abs(node.height - d.k) > 0.5)) {
      tryset(node, "textAutoResize", "NONE", id);
      try { node.resize(Math.max(0.01, d.j), Math.max(0.01, d.k)); REPORT.textPinned++; } catch (e4) {}
    }
  }
}

async function placePass() {
for (var j = 0; j < F.length; j++) {
  if (j % YIELD_EVERY === 0 && j > 0) await settle();
  var r2 = F[j], d2 = r2.d, n2 = built[j], id2 = "#" + j;
  if (r2.p < 0) continue;
  var pd = F[r2.p].d;
  if (pd.y && pd.y !== "NONE") {
    if (d2.M !== undefined) tryset(n2, "layoutPositioning", d2.M, id2);
    // Figma will not rotate a child that sits in an auto-layout flow: the rotation is dropped
    // without an error and the child ends up carrying its parent's. Pixso allows it, and a
    // rotated container whose children are counter-rotated to stand upright is an ordinary way
    // to build a sideways panel — the counter-rotation is exactly what disappears, so a toolbar
    // built that way arrives with every icon on its side. A rotated child leaves the flow: the
    // flow cannot express its placement anyway.
    var mm = d2["7"];
    var rotated = mm && (Math.abs(mm[1]) > 1e-6 || Math.abs(mm[3]) > 1e-6);
    if (d2.M !== "ABSOLUTE" && !rotated) {
      if (!PINNED[j]) {
        if (d2.K !== undefined) tryset(n2, "layoutAlign", d2.K, id2);
        if (d2.L !== undefined) tryset(n2, "layoutGrow", d2.L, id2);
      }
      continue;
    }
    if (rotated && d2.M !== "ABSOLUTE") {
      tryset(n2, "layoutPositioning", "ABSOLUTE", id2);
      PINNED[j] = 1;
      REPORT.rotPinned = (REPORT.rotPinned || 0) + 1;
    }
  }
  if (d2.Q !== undefined) tryset(n2, "constraints", dv(d2, "Q"), id2);
  var m = d2["7"];
  if (m) { try { n2.relativeTransform = [[m[0], m[1], m[2]], [m[3], m[4], m[5]]]; } catch (e3) { REPORT.rtFail++; } }
}
}

// Degenerate hug/stretch chains resolve differently in the two engines. Where the size ends up
// wrong, source geometry wins: pin the axis and resize. Two passes, parents settle first.
REPORT.sizeRepaired = 0;
// Nodes whose stretch the repair deliberately cleared, so the placement pass does not put it back.
const PINNED = {};
async function repairPass(countIt) {
{
  await settle();
  for (var s1 = 0; s1 < F.length; s1++) {
    if (s1 % YIELD_EVERY === 0 && s1 > 0) await settle();
    var ds = F[s1].d, ns = built[s1];
    if (ds.j === undefined || ds.k === undefined) continue;
    if (Math.abs(ns.width - ds.j) <= 0.5 && Math.abs(ns.height - ds.k) <= 0.5) continue;
    if (ns.layoutMode && ns.layoutMode !== "NONE") {
      tryset(ns, "primaryAxisSizingMode", "FIXED", "#" + s1);
      tryset(ns, "counterAxisSizingMode", "FIXED", "#" + s1);
    }
    var ps = F[s1].p >= 0 ? F[F[s1].p].d : null;
    if (ps && ps.y && ps.y !== "NONE") {
      // Clearing the stretch is what makes the resize below stick. placePass must then leave this
      // node's layoutAlign alone: restoring STRETCH from the payload hands the child straight back
      // to the engine, which shrinks it to the content box again.
      if (ns.layoutAlign === "STRETCH") { tryset(ns, "layoutAlign", "INHERIT", "#" + s1); PINNED[s1] = 1; }
      if (ns.layoutGrow) { tryset(ns, "layoutGrow", 0, "#" + s1); PINNED[s1] = 1; }
    }
    // re-read before acting: a stale size would pin an axis at the wrong value
    if (Math.abs(ns.width - ds.j) <= 0.5 && Math.abs(ns.height - ds.k) <= 0.5) { REPORT.sizeRejected = (REPORT.sizeRejected || 0) + 1; continue; }
    try { ns.resize(Math.max(0.01, ds.j), Math.max(0.01, ds.k)); if (countIt) REPORT.sizeRepaired++; } catch (e5) {}
  }
}
}
// d["8"] is what Pixso actually inked for this string. Measure the same string here, on a clone so
// the live node is untouched, and flag every node where Pixso drew materially wider than we can:
// those are instance text overrides Pixso never disclosed. Ink bounds exclude side bearings, so a
// faithful string always measures a little WIDER here, never narrower.
// Measuring is a clone + reflow per node, and a large section has thousands of text nodes.
// Width depends only on the string and the style that draws it, so measure once per
// distinct (string, font, size, letter spacing, case) and reuse.
phase("create");
// One scratch text node, reused. Cloning the real node and appending the clone to the page cost a
// page-wide relayout per measurement, and the page holds every section migrated before this one —
// so the same work got slower the later a section was built, until the largest never finished.
var natCache = {};
var probe = null;
for (var tx = 0; tx < F.length; tx++) {
  if (tx % YIELD_EVERY === 0 && tx > 0) await settle();
  var dt = F[tx].d;
  if (dt.b !== "TEXT" || dt["8"] === undefined || !dt.S) continue;
  var ck = JSON.stringify([dt.S, dt.T, dt.U, dt["0"], dt.Y]);
  var natural = natCache[ck];
  try {
    if (natural === undefined) {
      if (!probe) {
        probe = figma.createText();
        probe.name = "pix-to-fig measurement";
        figma.currentPage.appendChild(probe);
      }
      var pfn = dv(dt, "U");
      var puse = pfn && pfn.family && FONTSTATE[pfn.family + "|" + pfn.style] ? { family: pfn.family, style: pfn.style } : FB;
      probe.fontName = puse;
      probe.textAutoResize = "WIDTH_AND_HEIGHT";
      probe.characters = String(dt.S);
      if (dt.T !== undefined) probe.fontSize = dt.T;
      if (dt["0"] !== undefined) probe.letterSpacing = dv(dt, "0");
      probe.textCase = dt.Y === undefined ? "ORIGINAL" : dt.Y;
      natural = probe.width;
      natCache[ck] = natural;
      REPORT.textMeasured = (REPORT.textMeasured || 0) + 1;
    }
    if (dt["8"] - natural > 2) {
      var dfn = dv(dt, "U");
      var rec = { i: tx, name: dt.a, chars: String(dt.S).slice(0, 28), inked: dt["8"], drew: Math.round(natural * 10) / 10 };
      if (dfn && dfn.family && SUBBED[dfn.family + "|" + dfn.style]) { rec.font = dfn.family + " " + dfn.style; REPORT.textUnderSubstitutedFont.push(rec); }
      else REPORT.textOverrideLost.push(rec);
    }
  } catch (e8) { REPORT.failures.push("#" + tx + ".measure: " + String(e8.message || e8).slice(0, 60)); }
}
if (probe) { try { probe.remove(); } catch (e9) {} }

phase("textMeasure");
await repairPass(false); phase("repair1");
await placePass(); phase("place1");
await repairPass(true); phase("repair2");
await placePass(); phase("place2");

// The two engines do not lay out identically. Two differences are real and measured:
//  - Pixso keeps HIDDEN children in the auto-layout flow; Figma drops them, so the visible
//    siblings of a hidden node land somewhere else (worst seen: 70.5 px in a SPACE_BETWEEN row).
//  - layoutAlign STRETCH against an axis that cannot stretch: Pixso centres the child, Figma
//    pins it to counterAxisAlignItems.
// Source position wins. Try to reproduce it while keeping the child in the flow, by choosing the
// counter-axis alignment that lands closest; only take the child out of the flow if nothing does.
REPORT.flowAligned = 0; REPORT.flowAbsolute = 0; REPORT.flowStillOff = 0;
REPORT.flowRejected = 0; REPORT.flowReverted = 0;
// Reading a size or a bounding box can return a layout that has not settled. Through the MCP
// channel something forced a recompute between passes and through the plugin it did not, so the
// same payload produced 23 flow fixes in one and 520 in the other, and the 497 spurious ones
// pinned their parents to the wrong width. Yield to the engine, then never act on a single
// reading: re-read immediately before changing anything, and put it back if it did not help.
var MUL = function (m, n) { return [
  m[0]*n[0]+m[1]*n[3], m[0]*n[1]+m[1]*n[4], m[0]*n[2]+m[1]*n[5]+m[2],
  m[3]*n[0]+m[4]*n[3], m[3]*n[1]+m[4]*n[4], m[3]*n[2]+m[4]*n[5]+m[5]]; };
// Measure exactly what the acceptance test measures: the composed absolute min-corner against
// absoluteBoundingBox, with effective visibility propagated from ancestors. Anything looser fires
// on nodes the verifier considers fine -- including hidden subtrees, whose stored Pixso
// coordinates are stale by design.
async function flowDeltas() {
  var exp = [[1,0,0,0,1,0]], vis = [true], dp = [];
  var rn = built[0], rt0 = rn.absoluteTransform, ox = rt0[0][2], oy = rt0[1][2];
  for (var v = 0; v < F.length; v++) {
    if (v % YIELD_EVERY === 0 && v > 0) await settle();
    var dv2 = F[v].d, pv = F[v].p;
    if (v > 0) { exp[v] = MUL(exp[pv], dv2["7"] || [1,0,0,0,1,0]); vis[v] = vis[pv] && dv2.c !== false; }
    var e = exp[v], ew = dv2.j || 0, eh = dv2.k || 0, mnx = 1e9, mny = 1e9;
    for (var cq = 0; cq < 4; cq++) {
      var cx = (cq === 1 || cq === 2) ? ew : 0, cy = (cq >= 2) ? eh : 0;
      var px = e[0]*cx + e[1]*cy + e[2], py = e[3]*cx + e[4]*cy + e[5];
      if (px < mnx) mnx = px; if (py < mny) mny = py;
    }
    // Reading absoluteBoundingBox forces a layout pass, so it is the expensive part of this by a
    // wide margin. Hidden nodes are never candidates and are never reported, and on a large
    // section they are the majority — 10 959 of 18 719 in one — so they are not measured at all.
    if (!vis[v]) { dp[v] = { dx: 0, dy: 0, d: 0, vis: false }; continue; }
    var bb = built[v].absoluteBoundingBox;
    var ax = bb ? bb.x - ox : mnx, ay = bb ? bb.y - oy : mny;
    dp[v] = { dx: ax - mnx, dy: ay - mny, d: Math.sqrt((ax-mnx)*(ax-mnx) + (ay-mny)*(ay-mny)), vis: true };
  }
  return { dp: dp, exp: exp, ox: ox, oy: oy };
}
// Same rule as flowDeltas, for a single node, so a candidate can be re-checked on the spot.
function deltaOf(idx, expAbs, ox, oy) {
  var d0 = F[idx].d, e = expAbs, ew = d0.j || 0, eh = d0.k || 0, mnx = 1e9, mny = 1e9;
  for (var c = 0; c < 4; c++) {
    var cx = (c === 1 || c === 2) ? ew : 0, cy = (c >= 2) ? eh : 0;
    var px = e[0]*cx + e[1]*cy + e[2], py = e[3]*cx + e[4]*cy + e[5];
    if (px < mnx) mnx = px; if (py < mny) mny = py;
  }
  var bb = built[idx].absoluteBoundingBox;
  var ax = bb ? bb.x - ox : mnx, ay = bb ? bb.y - oy : mny;
  return { dx: ax - mnx, dy: ay - mny, d: Math.sqrt((ax-mnx)*(ax-mnx) + (ay-mny)*(ay-mny)) };
}
async function flowFixPass(last) {
  await settle();
  var fd = await flowDeltas(), dp = fd.dp, EXP = fd.exp, OX = fd.ox, OY = fd.oy;
  for (var g = 1; g < F.length; g++) {
    if (g % YIELD_EVERY === 0 && g > 0) await settle();
    var dg = F[g].d, ng = built[g], pi = F[g].p;
    if (!dp[g].vis || dp[g].d <= 0.5) continue;
    if (dp[pi] && dp[pi].d > 0.5) continue;
    var pdg = F[pi].d, png = built[pi];
    if (!pdg.y || pdg.y === "NONE") continue;
    if (dg.M === "ABSOLUTE") continue;
    var m = dg["7"]; if (!m) continue;
    // Never act on the batch reading alone: re-measure this node now.
    var now = deltaOf(g, EXP[g], OX, OY);
    if (now.d <= 0.5) { REPORT.flowRejected++; continue; }
    dp[g] = { dx: now.dx, dy: now.dy, d: now.d, vis: dp[g].vis };
    var horiz = pdg.y === "HORIZONTAL";
    var primOff = horiz ? dp[g].dx : dp[g].dy, cntOff = horiz ? dp[g].dy : dp[g].dx;
    if (Math.abs(primOff) <= 0.5) {
      var before = ng.layoutAlign, opts = ["MIN", "CENTER", "MAX"], best = null, bestErr = Math.abs(cntOff);
      var baseX = ng.x - dp[g].dx, baseY = ng.y - dp[g].dy;
      for (var oi = 0; oi < opts.length; oi++) {
        try { ng.layoutAlign = opts[oi]; } catch (e) { continue; }
        var err = Math.abs(horiz ? (ng.y - baseY) : (ng.x - baseX));
        if (err < bestErr - 0.01) { bestErr = err; best = opts[oi]; }
      }
      if (best !== null && bestErr <= 0.5) { try { ng.layoutAlign = best; REPORT.flowAligned++; continue; } catch (e) {} }
      try { ng.layoutAlign = before; } catch (e) {}
    }
    // Last resort: out of the flow, on the stored matrix. Freeze the parent at its current size
    // first so losing a flow child cannot resize it, and put the size back if it moves anyway.
    //
    // Taking a child out of the flow also moves its SIBLINGS, and that is how this pass once
    // turned a 2 px error into a 223 px one: it lifted a slider out of a row to fix its vertical
    // centring, and the input beside it, now the only child left in the flow, collapsed to the
    // left edge. Remember where the siblings were and put everything back if any of them moved.
    var sibs = [], sibXY = [];
    try {
      var pk2 = png.children || [];
      for (var si = 0; si < pk2.length; si++) {
        if (pk2[si] === ng) continue;
        sibs.push(pk2[si]); sibXY.push([pk2[si].x, pk2[si].y]);
      }
    } catch (eS) {}
    var pw = png.width, ph = png.height;
    try {
      if (png.layoutMode && png.layoutMode !== "NONE") {
        tryset(png, "primaryAxisSizingMode", "FIXED", "#" + pi);
        tryset(png, "counterAxisSizingMode", "FIXED", "#" + pi);
      }
      ng.layoutPositioning = "ABSOLUTE";
      ng.relativeTransform = [[m[0], m[1], m[2]], [m[3], m[4], m[5]]];
      if (Math.abs(png.width - pw) > 0.01 || Math.abs(png.height - ph) > 0.01) {
        try { png.resize(Math.max(0.01, pw), Math.max(0.01, ph)); } catch (e) {}
      }
      var moved = 0, worstSib = 0;
      for (var sj = 0; sj < sibs.length; sj++) {
        var dxs = Math.abs(sibs[sj].x - sibXY[sj][0]), dys = Math.abs(sibs[sj].y - sibXY[sj][1]);
        var ds2 = Math.max(dxs, dys);
        if (ds2 > 0.5) { moved++; if (ds2 > worstSib) worstSib = ds2; }
      }
      var after = deltaOf(g, EXP[g], OX, OY);
      if (moved || after.d > now.d - 0.01) {
        // either it did not help, or it moved the siblings — put it back either way
        try { ng.layoutPositioning = "AUTO"; } catch (e7) {}
        if (moved) {
          REPORT.flowSiblingGuard = (REPORT.flowSiblingGuard || 0) + 1;
          if (worstSib > (REPORT.flowSiblingWorst || 0)) REPORT.flowSiblingWorst = Math.round(worstSib * 100) / 100;
        } else REPORT.flowReverted++;
      } else REPORT.flowAbsolute++;
    } catch (e6) { if (last) REPORT.flowStillOff++; }
  }
}
// Fixing one child at a time cannot work when the whole row is wrong. Pixso lays hidden
// children out and Figma does not, so every visible child of such a row sits somewhere else,
// and moving any single one of them moves the rest — which is why the per-child pass either
// broke the siblings or, once guarded, gave up entirely.
//
// Take the row as a unit: if the children of an auto-layout parent are collectively misplaced,
// lift them all out of the flow onto their stored matrices at once. Nobody shifts relative to
// anybody, because nobody is left in the flow. Kept only if the total error actually falls.
REPORT.flowGroups = 0; REPORT.flowGroupNodes = 0; REPORT.flowGroupsRejected = 0;
async function flowGroupPass() {
  await settle();
  var fd = await flowDeltas(), dp = fd.dp, EXP = fd.exp, OX = fd.ox, OY = fd.oy;
  // children of each auto-layout parent, in payload order
  var kids = {};
  for (var a = 1; a < F.length; a++) {
    var pa = F[a].p;
    if (pa < 0) continue;
    var pdA = F[pa].d;
    if (!pdA.y || pdA.y === "NONE") continue;
    (kids[pa] = kids[pa] || []).push(a);
  }
  var parents = Object.keys(kids);
  for (var pIdx = 0; pIdx < parents.length; pIdx++) {
    if (pIdx % 50 === 0 && pIdx > 0) await settle();
    var pi = Number(parents[pIdx]);
    if (dp[pi] && dp[pi].vis && dp[pi].d > 0.5) continue;   // the parent is the real problem
    var set = kids[pi], bad = 0, before = 0, movable = [];
    for (var q = 0; q < set.length; q++) {
      var gi = set[q], dgi = F[gi].d;
      if (!dp[gi].vis) continue;
      if (dgi.M === "ABSOLUTE" || !dgi["7"]) continue;
      movable.push(gi);
      before += dp[gi].d;
      if (dp[gi].d > 0.5) bad++;
    }
    if (bad < 2 || movable.length < 2) continue;   // one stray child is the per-child pass's job
    var png = built[pi], pw = png.width, ph = png.height;
    var undo = [];
    try {
      if (png.layoutMode && png.layoutMode !== "NONE") {
        tryset(png, "primaryAxisSizingMode", "FIXED", "#" + pi);
        tryset(png, "counterAxisSizingMode", "FIXED", "#" + pi);
      }
      for (var w = 0; w < movable.length; w++) {
        var gi2 = movable[w], ng2 = built[gi2], m2 = F[gi2].d["7"];
        undo.push([ng2, ng2.layoutPositioning]);
        ng2.layoutPositioning = "ABSOLUTE";
        ng2.relativeTransform = [[m2[0], m2[1], m2[2]], [m2[3], m2[4], m2[5]]];
      }
      if (Math.abs(png.width - pw) > 0.01 || Math.abs(png.height - ph) > 0.01) {
        try { png.resize(Math.max(0.01, pw), Math.max(0.01, ph)); } catch (e) {}
      }
      var after = 0;
      for (var v2 = 0; v2 < movable.length; v2++) after += deltaOf(movable[v2], EXP[movable[v2]], OX, OY).d;
      if (after < before - 0.5) {
        REPORT.flowGroups++; REPORT.flowGroupNodes += movable.length;
        for (var u2 = 0; u2 < movable.length; u2++) dp[movable[u2]] = { dx: 0, dy: 0, d: 0, vis: true };
      } else {
        for (var u = 0; u < undo.length; u++) { try { undo[u][0].layoutPositioning = undo[u][1] || "AUTO"; } catch (e) {} }
        REPORT.flowGroupsRejected++;
      }
    } catch (eG) {
      for (var u3 = 0; u3 < undo.length; u3++) { try { undo[u3][0].layoutPositioning = undo[u3][1] || "AUTO"; } catch (e) {} }
      REPORT.flowGroupsRejected++;
    }
  }
}
await flowGroupPass(); phase("flowGroup");
await flowFixPass(false); phase("flow1");
await flowFixPass(true); phase("flow2");
// The flow pass takes children out of the flow and freezes their parents, which can leave a size
// wrong that was right before it ran. One more repair, and one more placement after it, because
// resizing a parent moves constrained children.
await repairPass(true); phase("repair3");
await placePass(); phase("place3");

// Where a line height differs from the font's natural one, the two engines put the first line in
// different places: Pixso centres the glyphs inside the line box, Figma hangs them from the
// ascender. On a 140 px heading with the line height set to 140 that is 23 px — plainly visible,
// and completely invisible to a geometry check, because every box is exactly where it belongs.
// The gap is half the difference between the set line height and the natural one, so it is
// computed rather than guessed: measure the natural height with the same scratch node the width
// probe uses, and move the node by half the difference along its own vertical axis.
//
// The shift is stored on the node. The verifier reads it and corrects its expectation by the same
// amount, so this stays visible in the acceptance report instead of hiding inside it.
REPORT.textLineShift = 0; REPORT.textLineShiftSkipped = 0;
var lineCache = {};
for (var t2 = 0; t2 < F.length; t2++) {
  if (t2 % YIELD_EVERY === 0 && t2 > 0) await settle();
  var d3 = F[t2].d;
  if (d3.b !== "TEXT" || d3["1"] === undefined || d3.T === undefined) continue;
  var lh = dv(d3, "1");
  if (!lh || lh.unit === "AUTO" || typeof lh.value !== "number") continue;
  var setLH = lh.unit === "PIXELS" ? lh.value : (lh.value / 100) * d3.T;
  var lfn = dv(d3, "U");
  var luse = lfn && lfn.family && FONTSTATE[lfn.family + "|" + lfn.style] ? { family: lfn.family, style: lfn.style } : FB;
  var lkey = luse.family + "|" + luse.style + "|" + d3.T;
  var nat = lineCache[lkey];
  try {
    if (nat === undefined) {
      if (!probe) {
        probe = figma.createText();
        probe.name = "pix-to-fig measurement";
        figma.currentPage.appendChild(probe);
      }
      probe.fontName = luse;
      probe.textAutoResize = "WIDTH_AND_HEIGHT";
      probe.lineHeight = { unit: "AUTO" };
      probe.letterSpacing = { unit: "PIXELS", value: 0 };
      probe.textCase = "ORIGINAL";
      probe.characters = "A";
      probe.fontSize = d3.T;
      nat = probe.height;
      lineCache[lkey] = nat;
    }
    var shift = (setLH - nat) / 2;
    if (REPORT.lineProbe === undefined) REPORT.lineProbe = [];
    if (REPORT.lineProbe.length < 12) REPORT.lineProbe.push({ f: luse.family + " " + luse.style, size: d3.T,
      set: Math.round(setLH * 100) / 100, nat: Math.round(nat * 100) / 100, shift: Math.round(shift * 100) / 100 });
    if (Math.abs(shift) < 0.5) continue;
    var tn = built[t2], tp = F[t2].p >= 0 ? F[F[t2].p].d : null;
    // A child in the flow has no transform of its own to move, so it leaves the flow — the same
    // trade the rotated children make, and for the same reason: the flow cannot place it correctly.
    if (tp && tp.y && tp.y !== "NONE" && tn.layoutPositioning !== "ABSOLUTE") {
      try { tn.layoutPositioning = "ABSOLUTE"; PINNED[t2] = 1; }
      catch (eA) { REPORT.textLineShiftSkipped++; continue; }
    }
    var trt = tn.relativeTransform;
    tn.relativeTransform = [[trt[0][0], trt[0][1], trt[0][2] + trt[0][1] * shift],
                            [trt[1][0], trt[1][1], trt[1][2] + trt[1][1] * shift]];
    tn.setPluginData("pxLineShift", String(shift));
    REPORT.textLineShift++;
  } catch (eL) { REPORT.textLineShiftSkipped++; }
}
phase("textLine");
if (probe) { try { probe.remove(); } catch (eP) {} probe = null; }

const root = built[0];
// Migrating a whole page section by section only reproduces the page if each section lands where
// the source had it. PAY.XY carries the source's own absolute position for that; without it the
// root is parked to the right of whatever is already on the canvas.
if (PAY.XY) {
  root.x = PAY.XY[0]; root.y = PAY.XY[1];
  REPORT.placedAt = PAY.XY;
} else {
  var maxX = 0;
  var kids = figma.currentPage.children;
  for (var c = 0; c < kids.length; c++) if (kids[c] !== root) maxX = Math.max(maxX, kids[c].x + kids[c].width);
  root.x = maxX + 160; root.y = 80;
}
phase("placeRoot");
REPORT.msTotal = Date.now() - T0;
REPORT.rootId = root.id;
REPORT.rootSize = { w: Math.round(root.width), h: Math.round(root.height) };
RESULT = REPORT;
`;

// Verifier body. Shipped as PAY.V. Globals: figma, PAY. Set ROOT_NODE_ID before eval.
export const VERIFIER_SRC = `
const F = PAY.F;
function vsettle() { return new Promise(function (r) { if (typeof setTimeout === "function") setTimeout(r, 0); else r(); }); }
var VYIELD = 400;
const root = await figma.getNodeByIdAsync(ROOT_NODE_ID);
const flatN = [];
(function dfs(n, i) {
  flatN.push(n);
  const d = F[flatN.length - 1] && F[flatN.length - 1].d;
  if (d && d.b === "SVG") return;
  const kids = n.children || [];
  for (var k = 0; k < kids.length; k++) dfs(kids[k]);
})(root, 0);

const mul = function (m, n) { return [
  m[0]*n[0]+m[1]*n[3], m[0]*n[1]+m[1]*n[4], m[0]*n[2]+m[1]*n[5]+m[2],
  m[3]*n[0]+m[4]*n[3], m[3]*n[1]+m[4]*n[4], m[3]*n[2]+m[4]*n[5]+m[5]]; };

const exp = [];
exp[0] = [1, 0, 0, 0, 1, 0];
const R = { count: flatN.length, expected: F.length, pos: [], size: [], maxPos: 0, maxSize: 0, visibleNodes: 0, visibleOver05: 0, hiddenOver05: 0, maxPosVisible: 0 };
const dpArr = [], shown = [true];
if (flatN.length !== F.length) { R.MISMATCH = true; RESULT = R; }
else {
  const rt = root.absoluteTransform;
  const ox = rt[0][2], oy = rt[1][2];
  for (var i = 0; i < F.length; i++) {
    if (i % VYIELD === 0 && i > 0) await vsettle();
    const d = F[i].d, p = F[i].p;
    if (i > 0) { const m = d["7"] || [1,0,0,0,1,0]; exp[i] = mul(exp[p], m); shown[i] = shown[p] && d.c !== false; }
    // A text node the build moved to line its glyphs up with the source carries the amount it was
    // moved by. Correct the expectation by the same amount rather than reporting it as an error,
    // and count them, so a run that leans on this cannot look like a run that did not need it.
    if (d.b === "TEXT") {
      var ls = 0;
      try { ls = parseFloat(flatN[i].getPluginData("pxLineShift")) || 0; } catch (eS) { ls = 0; }
      if (ls) { exp[i] = mul(exp[i], [1, 0, 0, 0, 1, ls]); R.textShifted = (R.textShifted || 0) + 1; }
    }
    if (shown[i]) R.visibleNodes++;
    const n = flatN[i];
    const e = exp[i];
    const ew = d.j === undefined ? 0 : d.j, eh = d.k === undefined ? 0 : d.k;
    var minx = 1e9, miny = 1e9;
    for (var cq = 0; cq < 4; cq++) {
      const cx = (cq === 1 || cq === 2) ? ew : 0, cy = (cq >= 2) ? eh : 0;
      const px = e[0]*cx + e[1]*cy + e[2], py = e[3]*cx + e[4]*cy + e[5];
      if (px < minx) minx = px; if (py < miny) miny = py;
    }
    const bb = n.absoluteBoundingBox;
    const ax = bb ? bb.x - ox : (n.absoluteTransform[0][2] - ox);
    const ay = bb ? bb.y - oy : (n.absoluteTransform[1][2] - oy);
    const dx = ax - minx, dy = ay - miny;
    const dp = Math.sqrt(dx*dx + dy*dy);
    if (dp > R.maxPos) R.maxPos = dp;
    if (dp > 0.5) { if (shown[i]) { R.visibleOver05++; if (dp > R.maxPosVisible) R.maxPosVisible = dp; } else R.hiddenOver05++; }
    dpArr[i] = dp;
    if (dp > 0.5 && shown[i] && (i === 0 || dpArr[p] <= 0.5)) R.pos.push({ i: i, name: n.name, type: n.type, parent: i ? F[p].d.a : null, dx: Math.round(dx*100)/100, dy: Math.round(dy*100)/100, mag: Math.round(dp*100)/100 });
    if (d.j !== undefined && d.k !== undefined) {
      const ds = Math.max(Math.abs(n.width - d.j), Math.abs(n.height - d.k));
      if (ds > R.maxSize) R.maxSize = ds;
      if (ds > 0.5) R.sizeOver = (R.sizeOver || 0) + 1;
      if (ds > 0.5) R.size.push({ i: i, name: n.name, type: n.type, w: Math.round(n.width*100)/100, h: Math.round(n.height*100)/100, ew: d.j, eh: d.k, mag: Math.round(ds*100)/100 });
    }
  }
  R.pos.sort(function (a, b) { return b.mag - a.mag; }); R.posTotal = R.pos.length; R.pos = R.pos.slice(0, 30);
  R.size.sort(function (a, b) { return b.mag - a.mag; }); R.sizeTotal = R.size.length; R.size = R.size.slice(0, 20);
  R.maxPos = Math.round(R.maxPos * 100) / 100;
  R.maxPosVisible = Math.round(R.maxPosVisible * 100) / 100;
  R.maxSize = Math.round(R.maxSize * 100) / 100;
  RESULT = R;
}
`;

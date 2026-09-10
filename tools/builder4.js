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
    // Clearing the wrapper's fill is not enough. A group inside the SVG comes in as a nested
    // FRAME, and a frame in Figma is white by default — so every petal of a flower arrived
    // sitting on an opaque white rectangle the size of its own bounding box, while the payload
    // carried no white fill anywhere and the geometry check reported the object exact. Frames
    // that come out of an SVG import never paint: anything the drawing actually fills arrives as
    // a VECTOR or a RECTANGLE, which are left alone.
    (function clearFrames(x) {
      if (x.type === "FRAME") { try { x.fills = []; } catch (e) {} }
      var ch = x.children;
      if (ch) for (var ci = 0; ci < ch.length; ci++) clearFrames(ch[ci]);
    })(n);
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
// Two different things were being asked of one yield, and conflating them cost a run.
//
// settle() gives Figma a real turn so a pending relayout actually happens. Every pass that
// measures geometry depends on it: without it the measurements are of the layout as it was, the
// repairs act on stale numbers, and the build comes out with nodes missing and sizes hundreds of
// pixels wrong. It is never optional and never cheap.
//
// breathe() exists only so Figma does not kill the plugin for holding the thread, and that does
// not need a real turn every four hundred iterations. It matters because a timer in a window that
// is not in front is throttled to about one a second: three passes over an object of 490 nodes
// took exactly sixty seconds each — round numbers, because the time went on waiting, not working.
// So breathing is rationed by the clock and is a free microtask in between.
// Neither of them may use setTimeout. Chromium throttles timers in a window that has been in the
// background for a few minutes down to one wake-up a MINUTE, and Figma's plugin frame is such a
// window whenever the user is not looking at it. That is not a slowdown, it is a wall: a single
// settle cost sixty seconds, three passes over an object of 27 nodes took three minutes, and the
// watchdog then wrote the object off as hung. The clue was that the phases came out at exactly
// 60 s, and work does not produce round numbers.
//
// So a turn is taken through Figma's own scheduler instead. getNodeByIdAsync resolves on the
// plugin host's message loop, which is not a timer and is not throttled, and reading
// absoluteBoundingBox forces the pending layout before the turn is taken.
var ROOT_ID_FOR_SETTLE = null;
function settle() {
  try { if (built[0]) void built[0].absoluteBoundingBox; } catch (e) {}
  if (ROOT_ID_FOR_SETTLE === null && built[0]) { try { ROOT_ID_FOR_SETTLE = built[0].id; } catch (e) {} }
  if (ROOT_ID_FOR_SETTLE) return figma.getNodeByIdAsync(ROOT_ID_FOR_SETTLE).then(function () {});
  return Promise.resolve();
}
var BREATHE_MS = 1500;
var lastBreath = Date.now();
function breathe() {
  var now = Date.now();
  if (now - lastBreath < BREATHE_MS) return Promise.resolve();
  lastBreath = now;
  return settle();
}
var YIELD_EVERY = 400;
const T0 = Date.now(); var TMARK = T0;
REPORT.ms = {};
function phase(name) { var t = Date.now(); REPORT.ms[name] = t - TMARK; TMARK = t; }

const built = [];
for (var i = 0; i < F.length; i++) {
  if (i % YIELD_EVERY === 0 && i > 0) await breathe();
  var rec = F[i], d = rec.d, id = "#" + i;
  var parent = rec.p < 0 ? figma.currentPage : built[rec.p];
  var node = makeNode(d);
  parent.appendChild(node);
  built[i] = node;
  // The root's id, read the moment it exists. Compared against the same node's id at the end of the
  // build: if they differ, an id changes under a live node, and that is the whole mystery. If they
  // match, whatever happens to it happens after the build, between one job and the next.
  if (i === 0) REPORT.rootIdAtCreate = node.id;
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
  if (j % YIELD_EVERY === 0 && j > 0) await breathe();
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
    // The flow can express one thing: where a child sits. Anything else in the child's own
    // matrix — a turn, a mirror, or both — is simply dropped, and a design that stands a label
    // upright by flipping the parent and flipping the child back arrives with the child's flip
    // gone and the parent's still there. That is a label written backwards. 671 nodes in one file
    // carry a mirror, so the test is not "is it rotated" but "is its linear part the identity".
    var mm = d2["7"];
    var rotated = mm && (Math.abs(mm[0] - 1) > 1e-6 || Math.abs(mm[1]) > 1e-6 ||
                         Math.abs(mm[3]) > 1e-6 || Math.abs(mm[4] - 1) > 1e-6);
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
  // Constraints are NOT set here. See the pass at the end of the build: a constraint governs what
  // happens when the parent is resized, and this build resizes parents on purpose several times
  // after this point.
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
    if (s1 % YIELD_EVERY === 0 && s1 > 0) await breathe();
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
    // Figma will not let an auto-layout frame be smaller than the sum of its own padding on the flow
    // axis, and Pixso will. A 4x4 notification badge with 4 px of padding on each side therefore
    // arrives 8x4 — measured, in 17 objects of one file, one of them visible. Measured too: halving
    // the padding fixes it, zeroing it fixes it, setting the padding after the resize does not (it
    // re-expands), and clearing layoutMode fixes it while KEEPING the padding values.
    //
    // With no children there is nothing for the flow to lay out, so layoutMode is the only property
    // here that has no observable effect — and it is the one given up. Every number the source
    // carries survives; a frame that Figma cannot represent at the source's size gives up the enum
    // rather than the geometry. Restricted to childless frames: dropping the flow on a frame that has
    // children would move them.
    try {
      var kidsN = ns.children ? ns.children.length : 0;
      if (!kidsN && ns.layoutMode && ns.layoutMode !== "NONE") {
        var padSum = ns.layoutMode === "HORIZONTAL"
          ? (ns.paddingLeft || 0) + (ns.paddingRight || 0)
          : (ns.paddingTop || 0) + (ns.paddingBottom || 0);
        var wanted = ns.layoutMode === "HORIZONTAL" ? ds.j : ds.k;
        if (padSum > wanted + 0.5) {
          tryset(ns, "layoutMode", "NONE", "#" + s1);
          REPORT.layoutDroppedForSize = (REPORT.layoutDroppedForSize || 0) + 1;
        }
      }
    } catch (ePad) {}
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
  if (tx % YIELD_EVERY === 0 && tx > 0) await breathe();
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
    if (v % YIELD_EVERY === 0 && v > 0) await breathe();
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
    if (g % YIELD_EVERY === 0 && g > 0) await breathe();
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
// Where a line height differs from the font's natural one, the two engines put the first line
// in different places: Pixso sets the top of the capital at the top of the line box, Figma
// centres the leading. On a 140 px heading with the line height set to 140 that is 23 px.
//
// Figma has a field for exactly this — leadingTrim: CAP_HEIGHT — and it costs nothing else.
// Measured on the built heading: ink top 19.6 without it, -3.4 with it, against -3 in the
// source render, and the box height unchanged at 460. The previous attempt moved the node
// instead, which needed it out of the auto-layout flow, which collapsed its parent to the
// padding: 61 of 88 objects wrong in one run. Setting a property moves nothing.
//
// It is still reverted whenever it changes the box, because on a hugging box the trim would
// shrink the node and the layout around it.
REPORT.textTrimmed = 0; REPORT.textTrimReverted = 0; REPORT.textTrimSkipped = 0;
var lineCache = {};
var trimmed = [];
for (var t2 = 0; t2 < F.length; t2++) {
  if (t2 % YIELD_EVERY === 0 && t2 > 0) await breathe();
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
    // Only where the two engines actually disagree. A line height that matches the font's own
    // puts the first line in the same place on both sides, and trimming it would move it.
    if (Math.abs(setLH - nat) < 1) continue;
    // Remember where it is, then trim. Both the trimming and the checking happen in bulk: a
    // relayout after every single text meant 153 full relayouts of a section and a build that ran
    // for fifty minutes instead of three. Two relayouts are enough for any number of them.
    var tn = built[t2], at0 = tn.absoluteTransform;
    trimmed.push({ n: tn, x: at0[0][2], y: at0[1][2], w: tn.width, h: tn.height });
    tn.leadingTrim = "CAP_HEIGHT";
  } catch (eL) { REPORT.textTrimSkipped++; }
}
// Guard on where the node ends up, not on how big it is. The trim can leave the box exactly
// 22x48 and still move the node 12 px — measured, by taking the trim off again and watching it
// jump back — because a parent that aligns its children on the baseline reflows when the baseline
// moves. Size said nothing about that; position says everything, and position is what this is
// trying to preserve. The reads have to come after Figma has actually re-laid the page out.
await settle();
for (var tt = 0; tt < trimmed.length; tt++) {
  if (tt % YIELD_EVERY === 0 && tt > 0) await breathe();
  var rec2 = trimmed[tt], at1 = rec2.n.absoluteTransform;
  if (Math.abs(at1[0][2] - rec2.x) > 0.5 || Math.abs(at1[1][2] - rec2.y) > 0.5 ||
      Math.abs(rec2.n.width - rec2.w) > 0.5 || Math.abs(rec2.n.height - rec2.h) > 0.5) {
    try { rec2.n.leadingTrim = "NONE"; REPORT.textTrimReverted++; } catch (e) {}
  } else REPORT.textTrimmed++;
}
await settle();
phase("textLine");
if (probe) { try { probe.remove(); } catch (eP) {} probe = null; }

// Constraints last, and only once every resize is behind us.
//
// A constraint says what should happen to a node when its parent is resized — a rule for the
// designer's future, not for this build. Set during the place passes, as it used to be, it was in
// force for every resize that came after: the size repairs and the line-height pass both resize
// parents on purpose, and a child whose source says SCALE is dragged by half of any change. Nothing
// needs that to happen mid-build, and the same lesson is already applied inside an SVG import, where
// children are pinned to MIN/MIN before the frame is resized.
//
// Honest about what it did NOT fix: this was tried as the explanation for the half-pixel offsets,
// because every reported node carried SCALE/SCALE. It is not the cause — the offsets are identical
// with constraints applied last. Kept because it is the right order regardless, and it costs 0 ms.
// Which nodes get them is unchanged from when this lived in placePass — only when. A child inside an
// auto-layout flow is placed by the flow and Figma rejects constraints on it, so those are skipped
// here exactly as they were skipped there; only the timing moved.
phase("constraints");
for (var qi = 0; qi < F.length; qi++) {
  if (qi % YIELD_EVERY === 0 && qi > 0) await breathe();
  var rq = F[qi], dq = rq.d;
  if (dq.Q === undefined || !built[qi] || rq.p < 0) continue;
  var pdq = F[rq.p].d;
  if (pdq.y && pdq.y !== "NONE") {
    var mq = dq["7"];
    var rotq = mq && (Math.abs(mq[0] - 1) > 1e-6 || Math.abs(mq[1]) > 1e-6 ||
                      Math.abs(mq[3]) > 1e-6 || Math.abs(mq[4] - 1) > 1e-6);
    if (dq.M !== "ABSOLUTE" && !rotq) continue;
  }
  tryset(built[qi], "constraints", dv(dq, "Q"), "#" + qi);
  REPORT.constraintsSet = (REPORT.constraintsSet || 0) + 1;
}

const root = built[0];
// Stamp the root with the id of the Pixso node it came from. The check that follows this build is
// a separate job and can only be handed a Figma node id — and an id proved not to be enough: two
// objects out of 45 reported one that resolved to a node built long before them, so the check
// measured a stranger and said "3 nodes of 5722" about a tree that had in fact been built whole.
// Plugin data is carried by the node, so it cannot come to mean something else.
try { if (PAY.R) { root.setPluginData("pxSrc", String(PAY.R)); REPORT.rootSrc = String(PAY.R); } }
catch (eS) { REPORT.failures.push("stamp root: " + String(eS.message || eS).slice(0, 60)); }
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
if (REPORT.rootIdAtCreate && REPORT.rootIdAtCreate !== root.id) REPORT.rootIdChanged = REPORT.rootIdAtCreate;
REPORT.rootSize = { w: Math.round(root.width), h: Math.round(root.height) };
RESULT = REPORT;
`;

// Verifier body. Shipped as PAY.V. Globals: figma, PAY. Set ROOT_NODE_ID before eval.
export const VERIFIER_SRC = `
const F = PAY.F;
// The verifier only reads, so its yields are purely so Figma does not kill it: rationed by the
// clock, free microtasks in between. Reading absoluteBoundingBox forces the layout itself.
// Through Figma's scheduler, for the same reason as the builder: a timer here is throttled to one
// wake-up a minute whenever the plugin window is not in front.
function vsettle() { return figma.getNodeByIdAsync(ROOT_NODE_ID).then(function () {}); }
var vLastBreath = Date.now();
function vbreathe() {
  var now = Date.now();
  if (now - vLastBreath < 1500) return Promise.resolve();
  vLastBreath = now;
  return vsettle();
}
var VYIELD = 400;
// Figma loads pages lazily in a document of any size, and getNodeByIdAsync answers null for a
// node on a page it has not loaded — which reads exactly like a node that was never built. One
// object of 1912 nodes verified as "undefined/undefined nodes" for that reason while sitting
// correctly in the file. Load them, then look.
try { await figma.loadAllPagesAsync(); } catch (e) {}
// An id is a guess; the stamp is the answer. Ask by id first — it is right almost always and costs
// one call — then make the node prove it is the root this payload built. When it cannot, look for
// the node that can: every built root is a top-level child of some page, so this is a walk over
// pages and their children, not over the document.
var relocated = null, ambiguous = 0;
var want = PAY.R ? String(PAY.R) : null;
var root = await figma.getNodeByIdAsync(ROOT_NODE_ID);
var stampOf = function (n) { try { return n.getPluginData("pxSrc"); } catch (e) { return ""; } };
if (want && (!root || stampOf(root) !== want)) {
  var found = [];
  for (var pi = 0; pi < figma.root.children.length; pi++) {
    var kids = figma.root.children[pi].children;
    for (var ki = 0; ki < kids.length; ki++) if (stampOf(kids[ki]) === want) found.push(kids[ki]);
  }
  if (found.length) {
    ambiguous = found.length > 1 ? found.length : 0;
    // Newest last: a root is appended to its page, so a leftover duplicate sits ahead of it.
    var pick = found[found.length - 1];
    relocated = { asked: ROOT_NODE_ID, found: pick.id, was: root ? root.type + " " + String(root.name).slice(0, 24) : "nothing" };
    root = pick;
  }
}
if (!root) {
  RESULT = { error: "root " + ROOT_NODE_ID + " not found even after loading every page, and no node " +
    "carries the stamp " + (want || "(none sent)") + " — it was removed, or the id belongs to another file" };
} else {
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
const R = { count: flatN.length, expected: F.length, pos: [], size: [], maxPos: 0, maxSize: 0, visibleNodes: 0, visibleOver05: 0, visibleOver1: 0, hiddenOver05: 0, maxPosVisible: 0, rootUsed: root.id };
// Say it out loud when the id was wrong. A check that quietly corrects itself hides the very thing
// worth knowing, and this one went unexplained for a day because nothing reported it.
if (relocated) R.rootRelocated = relocated;
if (ambiguous) R.rootAmbiguous = ambiguous;
const dpArr = [], shown = [true];
if (flatN.length !== F.length) { R.MISMATCH = true; RESULT = R; }
else {
  const rt = root.absoluteTransform;
  const ox = rt[0][2], oy = rt[1][2];
  for (var i = 0; i < F.length; i++) {
    if (i % VYIELD === 0 && i > 0) await vbreathe();
    const d = F[i].d, p = F[i].p;
    if (i > 0) { const m = d["7"] || [1,0,0,0,1,0]; exp[i] = mul(exp[p], m); shown[i] = shown[p] && d.c !== false; }
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
    // Half a pixel and a pixel are different findings and were being added up as one. Measured over
    // three files: most objects carry nodes out by exactly 0.5 px, always vertically — while a real
    // defect, like the 115 nodes at 1.41 px in one object, sat in the same total. So a verdict of
    // "not clean" fired on almost everything and stopped meaning anything.
    //
    // What the half pixel is: a frame with an INSIDE border on one side only — top 1, bottom 0 — has
    // that border taken out of its auto-layout content box by Figma, and Pixso does not take it out.
    // A row 56 tall with a 1 px top border centres a 56 tall child at 1 + (55 - 56) / 2 = 0.5, and a
    // 16 tall one at 1 + (55 - 16) / 2 = 20.5. Both measured, to the digit. Every descendant inherits
    // it, which is why it shows up on whichever child first crosses the threshold rather than on the
    // frame that caused it. Counted apart, never dropped.
    if (dp > 1 && shown[i]) R.visibleOver1++;
    dpArr[i] = dp;
    if (dp > 0.5 && shown[i] && (i === 0 || dpArr[p] <= 0.5)) R.pos.push({ i: i, name: n.name, type: n.type, parent: i ? F[p].d.a : null, dx: Math.round(dx*100)/100, dy: Math.round(dy*100)/100, mag: Math.round(dp*100)/100 });
    if (d.j !== undefined && d.k !== undefined) {
      const ds = Math.max(Math.abs(n.width - d.j), Math.abs(n.height - d.k));
      if (ds > R.maxSize) R.maxSize = ds;
      if (ds > 0.5) R.sizeOver = (R.sizeOver || 0) + 1;
      // Split by visibility, the way position now is. Without it, 17 objects of 69 were declared
      // wrong over eleven hidden notification badges each, built 8x4 where the source has 4x4 — nodes
      // the source itself does not draw. Burying the visible findings under them is how a verdict
      // stops being read. Why 8 and not 4 is not measured yet; it is invisible, so it waits.
      if (ds > 0.5 && shown[i]) {
        R.sizeOverVisible = (R.sizeOverVisible || 0) + 1;
        if (ds > (R.maxSizeVisible || 0)) R.maxSizeVisible = ds;
      }
      if (ds > 0.5) R.size.push({ i: i, name: n.name, type: n.type, w: Math.round(n.width*100)/100, h: Math.round(n.height*100)/100, ew: d.j, eh: d.k, mag: Math.round(ds*100)/100 });
    }
  }
  R.pos.sort(function (a, b) { return b.mag - a.mag; }); R.posTotal = R.pos.length; R.pos = R.pos.slice(0, 30);
  R.size.sort(function (a, b) { return b.mag - a.mag; }); R.sizeTotal = R.size.length; R.size = R.size.slice(0, 20);
  R.maxPos = Math.round(R.maxPos * 100) / 100;
  R.maxPosVisible = Math.round(R.maxPosVisible * 100) / 100;
  R.maxSize = Math.round(R.maxSize * 100) / 100;
  R.maxSizeVisible = Math.round((R.maxSizeVisible || 0) * 100) / 100;
  RESULT = R;
}
}
`;

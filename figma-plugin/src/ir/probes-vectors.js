// Probe P19B: vector networks, geometry-built vectors, booleans and frame masks (docs/M1.md §6 E,
// D3, D4, D5, §11 "Vector origin" and "Booleans"). Part E. Bundled as (function (IR) { … })(PXF_IR).
// The contract of IR.probes is in probes-images.js.
//
// Everything is built inside one container frame at (1000, 1000) on the current page, removed at the
// end (p19b.keep leaves it, marked pxScratch privately so RENDER's scratch-sweep removes it later).
// Each case runs alone: a throw is that case's verdict, never the probe's. Bounds are read as Figma
// draws them: every fillGeometry path under the node's absoluteTransform, bounded exactly by
// PXF_PATHGEOM.pathBounds.
//
// Cases (tools/double/behaviour.mjs MODEL says what each value means):
//   autoClosedLoop   vectorPaths "M 0 0 L 20 0 L 20 20 L 0 20" (no Z) with a fill: ok if it is filled
//   offsetNetwork    a triangle network whose bounds start at (10, 20), on a vector placed at (50, 60):
//                    ok if the drawing stays at the network's place (1060..1080, 1080..1100); drop if it
//                    lands at the node's origin; measured: whether the origin moved, the node's size
//   regionlessFill   a closed square loop with no region, the node filled: ok if filled, empty if not
//   fillGeometryAgainstNetwork   a region with a cubic: ok if fillGeometry is one path with the
//                    region's exact bounds; empty if none
//   booleanUnion / Subtract / Intersect / Exclude   A = 20 x 20 at (0, 0) in the container, B = 20 x 30
//                    inside a frame at (10, -5) (so B's matrix composes): ok if the result's bounds are
//                    the operation's (UNION and EXCLUDE 1000..1030 x 995..1025, SUBTRACT 1000..1010 x
//                    1000..1020, INTERSECT 1010..1020 x 1000..1020) and A and B stay where they were
//   nestedBoolean    UNION of (A SUBTRACT B) and C = 10 x 10 at (25, 0): 1000..1035 x 1000..1020
//   singleOperandUnion   UNION of A alone: A's bounds
//   lineOperand      UNION of A and a 30 px LINE at (0, 25) with a 4 px stroke: ok if A's bounds
//                    (a line adds no area), differs if the line counts
//   strokedOperand   UNION of A and an unfilled 10 x 10 at (30, 0) with a 4 px stroke: ok if
//                    1000..1040 x 1000..1020 (strokes ignored), differs otherwise
//   frameMask        isMask = true on a frame: ok if it reads back true, drop if false
//   maskInGroupAsFrame   isMask = true on a rectangle inside a frame built as a group (no fill, no clip)
//   flattenedWithStroke  a vector from a closed vectorPaths with a 2 px stroke: ok if it has a fill
//                    path and a stroke geometry, empty if no stroke geometry
// and, as the recorded P19 asked them (so the double's conformance test reads them from here too):
//   p19.perVertexCornerRadius (a vertex radius reads back), p19.perRegionFills (a region's fills
//   read back), p19.openRegionlessNetworkFilled (an open chain with no region: empty when unfilled)

var P19B_CASES = ["autoClosedLoop", "offsetNetwork", "regionlessFill", "fillGeometryAgainstNetwork", "booleanUnion", "booleanSubtract",
  "booleanIntersect", "booleanExclude", "nestedBoolean", "singleOperandUnion", "lineOperand", "strokedOperand", "frameMask",
  "maskInGroupAsFrame", "flattenedWithStroke"];
var ORIGIN = 1000, TOL = 0.5;
var BLACK = { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: "NORMAL" };
var GREY = { type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 }, opacity: 1, visible: true, blendMode: "NORMAL" };

function msg19(e) { return String((e && e.message) || e).slice(0, 200); }
function r2(v) { return Math.round(v * 100) / 100; }
function boxOf(b) { return b ? [r2(b.x0), r2(b.y0), r2(b.x1), r2(b.y1)] : null; }
// Where Figma draws a node's fill: its paths under its absolute transform.
function drawn(node) {
  var g = node.fillGeometry || [], m = node.absoluteTransform, boxes = [];
  for (var i = 0; i < g.length; i++) boxes = boxes.concat(PXF_PATHGEOM.pathBounds(String(g[i].data), m));
  return { paths: g.length, box: PXF_PATHGEOM.unionBounds(boxes) };
}
function near(b, want) {
  return !!b && Math.abs(b.x0 - want[0]) <= TOL && Math.abs(b.y0 - want[1]) <= TOL && Math.abs(b.x1 - want[2]) <= TOL && Math.abs(b.y1 - want[3]) <= TOL;
}
function absBox(n) { var b = n.absoluteBoundingBox; return [b.x, b.y, b.x + b.width, b.y + b.height]; }
function sameBox(a, b) { for (var i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > 0.01) return false; return true; }

function rect(parent, x, y, w, h, fills) {
  var r = figma.createRectangle();
  parent.appendChild(r);
  r.resize(w, h);
  r.relativeTransform = [[1, 0, x], [0, 1, y]];
  r.fills = fills || [GREY];
  return r;
}
function frame(parent, x, y, w, h) {
  var f = figma.createFrame();
  parent.appendChild(f);
  f.resize(w, h);
  f.relativeTransform = [[1, 0, x], [0, 1, y]];
  f.fills = [];
  f.clipsContent = false;
  return f;
}
function vector(parent, x, y) {
  var v = figma.createVector();
  parent.appendChild(v);
  v.relativeTransform = [[1, 0, x], [0, 1, y]];
  v.fills = [GREY];
  return v;
}

// The two operands every boolean case starts from: A in the container, B in a frame at (10, -5).
function operands(box) {
  var a = rect(box, 0, 0, 20, 20);
  var holder = frame(box, 10, -5, 20, 30);
  var b = rect(holder, 0, 0, 20, 30);
  return { a: a, b: b, holder: holder };
}
function booleanCase(box, op, want) {
  var o = operands(box), beforeA = absBox(o.a), beforeB = absBox(o.b);
  var node = figma[op]([o.a, o.b], box);
  // winding: the rule of each result path, measured, not part of the verdict; the judge compares a
  // native boolean's winding with Pixso's stored result (docs/M1.md §8.3), so the live run records it.
  var g = node.fillGeometry || [], windings = [];
  for (var k = 0; k < g.length; k++) windings.push(g[k].windingRule);
  var d = drawn(node), out = { type: node.type, op: node.booleanOperation, paths: d.paths, box: boxOf(d.box), winding: windings, operandsKept: sameBox(absBox(o.a), beforeA) && sameBox(absBox(o.b), beforeB) };
  return { verdict: !d.paths ? "empty" : near(d.box, want) && out.operandsKept ? "ok" : "differs", m: out };
}

var CASES = {
  autoClosedLoop: async function (box) {
    var v = vector(box, 0, 0);
    v.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 20 0 L 20 20 L 0 20" }];
    var d = drawn(v);
    return { verdict: d.paths ? "ok" : "empty", m: { paths: d.paths, box: boxOf(d.box) } };
  },
  offsetNetwork: async function (box) {
    var v = vector(box, 50, 60);
    await v.setVectorNetworkAsync({ vertices: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }], regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }] });
    var d = drawn(v), rt = v.relativeTransform;
    var m = { box: boxOf(d.box), x: r2(rt[0][2]), y: r2(rt[1][2]), width: r2(v.width), height: r2(v.height), originMoved: Math.abs(rt[0][2] - 50) > 0.01 || Math.abs(rt[1][2] - 60) > 0.01 };
    var place = [ORIGIN + 60, ORIGIN + 80, ORIGIN + 80, ORIGIN + 100], origin = [ORIGIN + 50, ORIGIN + 60, ORIGIN + 70, ORIGIN + 80];
    return { verdict: !d.paths ? "empty" : near(d.box, place) ? "ok" : near(d.box, origin) ? "drop" : "differs", m: m };
  },
  regionlessFill: async function (box) {
    var v = vector(box, 0, 0);
    await v.setVectorNetworkAsync({ vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }], regions: [] });
    var d = drawn(v);
    return { verdict: d.paths ? "ok" : "empty", m: { paths: d.paths, box: boxOf(d.box) } };
  },
  fillGeometryAgainstNetwork: async function (box) {
    var v = vector(box, 0, 0);
    // Region (0,0) -> (20,0) -> cubic to (10,16) -> (0,0); the cubic's controls (20,8) and (14,16)
    // keep it inside x 0..20, y 0..16, so the exact bounds are the vertices' box.
    await v.setVectorNetworkAsync({ vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 16 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2, tangentStart: { x: 0, y: 8 }, tangentEnd: { x: 4, y: 0 } }, { start: 2, end: 0 }],
      regions: [{ windingRule: "EVENODD", loops: [[0, 1, 2]] }] });
    var d = drawn(v), g = v.fillGeometry || [];
    var want = PXF_PATHGEOM.unionBounds(PXF_PATHGEOM.pathBounds("M 0 0 L 20 0 C 20 8 14 16 10 16 L 0 0 Z", v.absoluteTransform));
    var m = { paths: d.paths, box: boxOf(d.box), winding: g.length ? g[0].windingRule : null };
    return { verdict: !d.paths ? "empty" : d.paths === 1 && want && near(d.box, [want.x0, want.y0, want.x1, want.y1]) && m.winding === "EVENODD" ? "ok" : "differs", m: m };
  },
  booleanUnion: async function (box) { return booleanCase(box, "union", [ORIGIN, ORIGIN - 5, ORIGIN + 30, ORIGIN + 25]); },
  booleanSubtract: async function (box) { return booleanCase(box, "subtract", [ORIGIN, ORIGIN, ORIGIN + 10, ORIGIN + 20]); },
  booleanIntersect: async function (box) { return booleanCase(box, "intersect", [ORIGIN + 10, ORIGIN, ORIGIN + 20, ORIGIN + 20]); },
  booleanExclude: async function (box) { return booleanCase(box, "exclude", [ORIGIN, ORIGIN - 5, ORIGIN + 30, ORIGIN + 25]); },
  nestedBoolean: async function (box) {
    var o = operands(box), inner = figma.subtract([o.a, o.b], box), c = rect(box, 25, 0, 10, 10);
    var node = figma.union([inner, c], box), d = drawn(node);
    return { verdict: !d.paths ? "empty" : near(d.box, [ORIGIN, ORIGIN, ORIGIN + 35, ORIGIN + 20]) ? "ok" : "differs", m: { paths: d.paths, box: boxOf(d.box) } };
  },
  singleOperandUnion: async function (box) {
    var a = rect(box, 0, 0, 20, 20), node = figma.union([a], box), d = drawn(node);
    return { verdict: !d.paths ? "empty" : near(d.box, [ORIGIN, ORIGIN, ORIGIN + 20, ORIGIN + 20]) ? "ok" : "differs", m: { paths: d.paths, box: boxOf(d.box) } };
  },
  lineOperand: async function (box) {
    var a = rect(box, 0, 0, 20, 20), l = figma.createLine();
    box.appendChild(l);
    l.resize(30, 0);
    l.relativeTransform = [[1, 0, 0], [0, 1, 25]];
    l.strokes = [BLACK]; l.strokeWeight = 4;
    var node = figma.union([a, l], box), d = drawn(node);
    return { verdict: !d.paths ? "empty" : near(d.box, [ORIGIN, ORIGIN, ORIGIN + 20, ORIGIN + 20]) ? "ok" : "differs", m: { paths: d.paths, box: boxOf(d.box) } };
  },
  strokedOperand: async function (box) {
    var a = rect(box, 0, 0, 20, 20), s = rect(box, 30, 0, 10, 10, []);
    s.strokes = [BLACK]; s.strokeWeight = 4; s.strokeAlign = "CENTER";
    var node = figma.union([a, s], box), d = drawn(node);
    return { verdict: !d.paths ? "empty" : near(d.box, [ORIGIN, ORIGIN, ORIGIN + 40, ORIGIN + 20]) ? "ok" : "differs", m: { paths: d.paths, box: boxOf(d.box) } };
  },
  frameMask: async function (box) {
    var f = frame(box, 0, 0, 20, 20);
    f.isMask = true;
    return { verdict: f.isMask === true ? "ok" : "drop", m: { isMask: f.isMask } };
  },
  maskInGroupAsFrame: async function (box) {
    var g = frame(box, 0, 0, 40, 40), r = rect(g, 0, 0, 20, 20);
    r.isMask = true;
    var e = figma.createEllipse();
    g.appendChild(e);
    e.resize(30, 30);
    return { verdict: r.isMask === true ? "ok" : "drop", m: { isMask: r.isMask } };
  },
  flattenedWithStroke: async function (box) {
    var v = vector(box, 0, 0);
    v.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 20 0 L 20 20 L 0 20 Z" }];
    v.strokes = [BLACK]; v.strokeWeight = 2;
    var d = drawn(v), sg = v.strokeGeometry || [];
    return { verdict: !d.paths ? "differs" : sg.length ? "ok" : "empty", m: { paths: d.paths, strokePaths: sg.length } };
  }
};

var P19 = {
  perVertexCornerRadius: async function (box) {
    var v = vector(box, 0, 0);
    await v.setVectorNetworkAsync({ vertices: [{ x: 0, y: 0, cornerRadius: 4 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }], regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }] });
    var back = v.vectorNetwork.vertices[0];
    return { verdict: back && back.cornerRadius === 4 ? "ok" : "drop", m: { cornerRadius: back ? back.cornerRadius : null } };
  },
  perRegionFills: async function (box) {
    var v = vector(box, 0, 0);
    await v.setVectorNetworkAsync({ vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }], regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]], fills: [BLACK] }] });
    var r = v.vectorNetwork.regions[0];
    return { verdict: r && Array.isArray(r.fills) && r.fills.length === 1 ? "ok" : "drop", m: { fills: r && r.fills ? r.fills.length : null } };
  },
  openRegionlessNetworkFilled: async function (box) {
    var v = vector(box, 0, 0);
    await v.setVectorNetworkAsync({ vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }], regions: [] });
    var d = drawn(v);
    return { verdict: d.paths ? "ok" : "empty", m: { paths: d.paths } };
  }
};
IR.probeVectors = { P19B_CASES: P19B_CASES, P19_CASES: Object.keys(P19) };

async function runCase(fn) {
  var page = figma.currentPage, box = figma.createFrame();
  page.appendChild(box);
  box.relativeTransform = [[1, 0, ORIGIN], [0, 1, ORIGIN]];
  box.resize(100, 100);
  box.fills = []; box.clipsContent = false;
  box.name = "pix2fig probe P19B";
  try { return Object.assign({ box: box }, await fn(box)); }
  catch (e) { return { box: box, verdict: "throw", m: { error: msg19(e) } }; }
}

IR.probes.P19B = {
  args: function (raw) {
    var p = raw && raw.p19b;
    if (p === undefined || p === null) return { p19bKeep: false, p19bCases: P19B_CASES.slice() };
    if (typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(function (k) { return k !== "keep" && k !== "cases"; })) throw new Error("p19b is { keep, cases }");
    if (p.keep !== undefined && typeof p.keep !== "boolean") throw new Error("p19b.keep is true or false");
    if (p.cases !== undefined && (!Array.isArray(p.cases) || !p.cases.length || p.cases.some(function (c) { return P19B_CASES.indexOf(c) < 0; }))) {
      throw new Error("p19b.cases lists some of " + P19B_CASES.join(", "));
    }
    return { p19bKeep: p.keep === true, p19bCases: (p.cases || P19B_CASES).slice() };
  },
  run: async function (A) {
    var res = { verdicts: {}, cases: {}, p19: { verdicts: {}, cases: {} }, timings: {} };
    var kept = [];
    var one = async function (fn, into, name) {
      var t0 = Date.now(), r = await runCase(fn);
      into.verdicts[name] = r.verdict; into.cases[name] = r.m;
      res.timings[name] = Date.now() - t0;
      if (A.p19bKeep) { try { r.box.setPluginData("pxScratch", "1"); kept.push(r.box.id); } catch (e) {} }
      else { try { r.box.remove(); } catch (e2) {} }
    };
    for (var i = 0; i < A.p19bCases.length; i++) await one(CASES[A.p19bCases[i]], res, A.p19bCases[i]);
    var p19 = Object.keys(P19);
    for (var k = 0; k < p19.length; k++) await one(P19[p19[k]], res.p19, p19[k]);
    if (kept.length) res.kept = kept;
    return res;
  }
};

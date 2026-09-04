// Builder body. Shipped INSIDE the PNG carrier as PAY.B and eval'd by the bootstrap.
// Globals available when it runs: figma, PAY (={D,S,F,B}).
export const BUILDER_SRC = `
const REPORT = { nodes: 0, svg: 0, failures: [], fontSubs: [], rtFail: 0, textPinned: 0, textOverrideLost: [] };
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
  ["f", "blendMode"], ["c", "visible"], ["d", "locked"], ["g", "isMask"]];
const SVG_PLAIN = [["e", "opacity"], ["f", "blendMode"], ["c", "visible"], ["g", "isMask"]];
const TXT = [["T", "fontSize"], ["V", "textAlignHorizontal"], ["W", "textAlignVertical"], ["Y", "textCase"],
  ["Z", "textDecoration"], ["0", "letterSpacing"], ["1", "lineHeight"], ["2", "paragraphIndent"], ["3", "paragraphSpacing"]];
const DICTKEY = { N: 1, O: 1, P: 1, Q: 1, U: 1, "0": 1, "1": 1, w: 1 };
function dv(d, k) { return d[k] === undefined ? undefined : (DICTKEY[k] ? D[d[k]] : d[k]); }

function makeNode(d) {
  var t = d.b;
  if (t === "SVG") { REPORT.svg++; var n = figma.createNodeFromSvg(S[d["6"]]); try { n.fills = []; } catch (e) {} return n; }
  if (t === "TEXT") return figma.createText();
  if (t === "RECTANGLE") return figma.createRectangle();
  if (t === "ELLIPSE") return figma.createEllipse();
  return figma.createFrame();
}

const built = [];
for (var i = 0; i < F.length; i++) {
  var rec = F[i], d = rec.d, id = "#" + i;
  var parent = rec.p < 0 ? figma.currentPage : built[rec.p];
  var node = makeNode(d);
  parent.appendChild(node);
  built[i] = node;
  REPORT.nodes++;
  if (d.a !== undefined) tryset(node, "name", d.a, id);

  if (d.b !== "SVG" && d.j !== undefined && d.k !== undefined && node.resize) {
    try { node.resize(Math.max(0.01, d.j), Math.max(0.01, d.k)); }
    catch (e) { REPORT.failures.push(id + ".resize: " + String(e.message || e).slice(0, 60)); }
  }

  if (d.b === "TEXT") {
    var fn = dv(d, "U");
    var use = fn && fn.family ? { family: fn.family, style: fn.style } : FB;
    try { await figma.loadFontAsync(use); }
    catch (e2) { REPORT.fontSubs.push(use.family + " " + use.style); use = FB; await figma.loadFontAsync(FB); }
    node.fontName = use;
    if (d.S !== undefined) tryset(node, "characters", d.S, id);
    for (var t1 = 0; t1 < TXT.length; t1++) if (d[TXT[t1][0]] !== undefined) tryset(node, TXT[t1][1], dv(d, TXT[t1][0]), id);
  }

  if (d.b !== "SVG") {
    for (var pk in PAINT) if (d[pk] !== undefined) tryset(node, PAINT[pk], dv(d, pk), id);
    for (var q = 0; q < PLAIN.length; q++) if (d[PLAIN[q][0]] !== undefined) tryset(node, PLAIN[q][1], dv(d, PLAIN[q][0]), id);
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

function placePass() {
for (var j = 0; j < F.length; j++) {
  var r2 = F[j], d2 = r2.d, n2 = built[j], id2 = "#" + j;
  if (r2.p < 0) continue;
  var pd = F[r2.p].d;
  if (pd.y && pd.y !== "NONE") {
    if (d2.M !== undefined) tryset(n2, "layoutPositioning", d2.M, id2);
    if (d2.M !== "ABSOLUTE") {
      if (d2.K !== undefined) tryset(n2, "layoutAlign", d2.K, id2);
      if (d2.L !== undefined) tryset(n2, "layoutGrow", d2.L, id2);
      continue;
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
function repairPass(countIt) {
{
  for (var s1 = 0; s1 < F.length; s1++) {
    var ds = F[s1].d, ns = built[s1];
    if (ds.j === undefined || ds.k === undefined) continue;
    if (Math.abs(ns.width - ds.j) <= 0.5 && Math.abs(ns.height - ds.k) <= 0.5) continue;
    if (ns.layoutMode && ns.layoutMode !== "NONE") {
      tryset(ns, "primaryAxisSizingMode", "FIXED", "#" + s1);
      tryset(ns, "counterAxisSizingMode", "FIXED", "#" + s1);
    }
    var ps = F[s1].p >= 0 ? F[F[s1].p].d : null;
    if (ps && ps.y && ps.y !== "NONE") {
      if (ns.layoutAlign === "STRETCH") tryset(ns, "layoutAlign", "INHERIT", "#" + s1);
      if (ns.layoutGrow) tryset(ns, "layoutGrow", 0, "#" + s1);
    }
    try { ns.resize(Math.max(0.01, ds.j), Math.max(0.01, ds.k)); if (countIt) REPORT.sizeRepaired++; } catch (e5) {}
  }
}
}
// d["8"] is what Pixso actually inked for this string. Measure the same string here, on a clone so
// the live node is untouched, and flag every node where Pixso drew materially wider than we can:
// those are instance text overrides Pixso never disclosed. Ink bounds exclude side bearings, so a
// faithful string always measures a little WIDER here, never narrower.
for (var tx = 0; tx < F.length; tx++) {
  var dt = F[tx].d;
  if (dt.b !== "TEXT" || dt["8"] === undefined || !dt.S) continue;
  var nt = built[tx], cl = null;
  try {
    cl = nt.clone();
    figma.currentPage.appendChild(cl);
    cl.textAutoResize = "WIDTH_AND_HEIGHT";
    var natural = cl.width;
    if (dt["8"] - natural > 2) REPORT.textOverrideLost.push({ i: tx, name: dt.a, chars: String(dt.S).slice(0, 28), inked: dt["8"], drew: Math.round(natural * 10) / 10 });
  } catch (e8) { REPORT.failures.push("#" + tx + ".measure: " + String(e8.message || e8).slice(0, 60)); }
  if (cl) { try { cl.remove(); } catch (e9) {} }
}

repairPass(false); placePass(); repairPass(true); placePass();

const root = built[0];
var maxX = 0;
var kids = figma.currentPage.children;
for (var c = 0; c < kids.length; c++) if (kids[c] !== root) maxX = Math.max(maxX, kids[c].x + kids[c].width);
root.x = maxX + 160; root.y = 80;
REPORT.rootId = root.id;
REPORT.rootSize = { w: Math.round(root.width), h: Math.round(root.height) };
RESULT = REPORT;
`;

// Verifier body. Shipped as PAY.V. Globals: figma, PAY. Set ROOT_NODE_ID before eval.
export const VERIFIER_SRC = `
const F = PAY.F;
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
    dpArr[i] = dp;
    if (dp > 0.5 && shown[i] && (i === 0 || dpArr[p] <= 0.5) && R.pos.length < 30) R.pos.push({ i: i, name: n.name, type: n.type, parent: i ? F[p].d.a : null, dx: Math.round(dx*100)/100, dy: Math.round(dy*100)/100 });
    if (d.j !== undefined && d.k !== undefined) {
      const ds = Math.max(Math.abs(n.width - d.j), Math.abs(n.height - d.k));
      if (ds > R.maxSize) R.maxSize = ds;
      if (ds > 0.5) R.sizeOver = (R.sizeOver || 0) + 1;
      if (ds > 0.5 && R.size.length < 20) R.size.push({ i: i, name: n.name, type: n.type, w: Math.round(n.width*100)/100, h: Math.round(n.height*100)/100, ew: d.j, eh: d.k });
    }
  }
  R.maxPos = Math.round(R.maxPos * 100) / 100;
  R.maxPosVisible = Math.round(R.maxPosVisible * 100) / 100;
  R.maxSize = Math.round(R.maxSize * 100) / 100;
  RESULT = R;
}
`;

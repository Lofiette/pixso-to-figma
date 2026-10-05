// The IR builder's passes after creation (docs/M1.md §6 B steps 9-11): MEASURE (the text box pin and
// decision 9), then builder4's repair, place, flowGroup, flow and textLine passes ported nearly
// verbatim (tools/builder4.js:234-671), reading the IR through ctx.prop instead of the payload's
// one-letter keys, and the constraints last. Part B. Bundled as (function (IR) { … })(PXF_IR).
//
// What differs from builder4, and why:
//   - one task may hold several roots; each is the origin of its own subtree's expectations, taken
//     from its built absolute transform (a split root's parent was built by an earlier task);
//   - every pass aims at st.want (build-create.js), so decision 9's widening and x shift, an S2
//     root's grid place and a vector's moved origin are not undone by a later pass;
//   - a vector and a native boolean are never resized (their size is their paths'), a native
//     boolean is never moved by matrix (its box is its operands'), and the operands of a native
//     boolean are left as the union made them;
//   - a child the flow passes lifted out of the flow (st.flowAbs) keeps ABSOLUTE in later place
//     passes, where builder4 relied on its payload leaving layoutPositioning out;
//   - the layout props of a node are read only on a node that has them (builder4 read layoutMode
//     and children on any node, which a TEXT does not have);
//   - a resize that throws is a failure entry, never a silent skip.
//
//   IR.B.measurePhase(st)   the pin (unless textRead is inLoop, where creation already pinned), then,
//                           under textFit "widen", every text whose stored baselines say one line
//                           (lines = 1) and whose ctx.measure count exceeds 1 is widened to its natural
//                           one-line width (then by 1 px steps, at most 3, while it still wraps), moved
//                           left by the widening for CENTER (half) and RIGHT (all) along its own x
//                           axis, counted TEXT_WIDENED_TO_SOURCE_LINES and recounted
//   IR.B.repairPass(st, countIt), placePass(st), flowGroupPass(st), flowFixPass(st, last),
//   textLinePass(st), constraintsPass(st)
var B = IR.B || (IR.B = {});
var CODE = IR.CODE, U = IR.util;

function msgOf(e) { return String((e && e.message) || e).slice(0, 300); }
function own(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
function r2(x) { return Math.round(x * 100) / 100; }
function mul6(m, n) {
  return [m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
    m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5]];
}
// The layout mode of the BUILT node (a pass may have dropped it), read only where Figma has one.
function readMode(st, k) {
  var t = st.builtType[k];
  if (t !== "FRAME" && t !== "COMPONENT") return "NONE";
  try { return st.node[k].layoutMode || "NONE"; } catch (e) { return "NONE"; }
}
function kidsOf(st, k) {
  if (B.CONTAINERS.indexOf(st.builtType[k]) < 0) return [];
  try { return st.node[k].children || []; } catch (e) { return []; }
}
function sizeFixed(st, k) { return st.recs[k].type === "VECTOR" || st.native[k] || st.fixed[k]; }
function onPage(st, k) { return st.parentK[k] < 0 && st.attachTo[k] === "page"; }
function sizeOk(st, k) {
  var n = st.node[k], w = st.want[k];
  return Math.abs(n.width - w.w) <= 0.5 && Math.abs(n.height - (st.builtType[k] === "LINE" ? 0 : w.h)) <= 0.5;
}
function firstRoot(st) { return st.node[st.rootKs[0]]; }

// ---------- MEASURE ----------
function measure(st, k) {
  try { return st.ctx.measure(st.node[k], st.recs[k]); }
  catch (e) { st.ctx.failure(st.recs[k].i, "lines", "countLines: " + msgOf(e)); return null; }
}

B.widenText = function (st, k, first) {
  var ctx = st.ctx, rec = st.recs[k], i = rec.i, n = st.node[k];
  var w0 = n.width, h0 = n.height, cur = n.textAutoResize, natural = w0;
  if (cur !== "WIDTH_AND_HEIGHT") {
    try { n.textAutoResize = "WIDTH_AND_HEIGHT"; natural = n.width; } catch (e) { natural = w0; }
  }
  var target = Math.max(w0, Math.ceil(natural * 100) / 100), lines = first.lines, tries = 0;
  for (;;) {
    try {
      B.resize(n, "TEXT", target, h0);
      if (cur !== "WIDTH_AND_HEIGHT") n.textAutoResize = cur;
    } catch (e2) { ctx.failure(i, "resize", msgOf(e2)); break; }
    var m = measure(st, k);
    if (!m) break;
    lines = m.lines;
    if (lines <= 1 || tries >= 3) break;
    target = r2(target + 1);
    tries++;
  }
  var dw = target - w0, align = ctx.prop(rec, "textAlignHorizontal");
  var s = align === "CENTER" ? dw / 2 : align === "RIGHT" ? dw : 0;
  var want = st.want[k];
  if (s) {
    want.rt[2] -= want.rt[0] * s;
    want.rt[5] -= want.rt[3] * s;
    B.set(st, n, i, "relativeTransform", U.matrix(want.rt));
  }
  want.w = target;
  st.textWidened.push(i);
  ctx.code(CODE.TEXT_WIDENED_TO_SOURCE_LINES, i, "widened by " + r2(dw) + " px, " + first.lines + " -> " + lines + " lines" + (s ? ", moved " + r2(s) + " px" : ""));
};

B.measurePhase = async function (st) {
  var ctx = st.ctx, widen = st.settings.textFit === "widen";
  for (var k = 0; k < st.n; k++) {
    var rec = st.recs[k];
    if (rec.type !== "TEXT" || st.builtType[k] !== "TEXT") continue;
    await B.tick(st, k);
    if (st.settings.textRead !== "inLoop") B.pinText(st, k);
    // A truncated text (ENDING) is drawn cut with an ellipsis in its box, as Pixso draws it: it is
    // never widened (part F, review figma F2).
    if (!widen || rec.props.lines !== 1 || ctx.prop(rec, "textTruncation") === "ENDING") continue;
    var m = measure(st, k);
    if (m && m.lines > 1) B.widenText(st, k, m);
  }
};

// ---------- repair (builder4.js:282-331) ----------
B.repairPass = async function (st, countIt) {
  var ctx = st.ctx, C = st.counters;
  await ctx.settle(firstRoot(st));
  for (var k = 0; k < st.n; k++) {
    await B.tick(st, k);
    if (sizeFixed(st, k)) continue;
    var ns = st.node[k], w = st.want[k], i = st.recs[k].i, bt = st.builtType[k];
    if (sizeOk(st, k)) continue;
    var mode = readMode(st, k);
    if (B.isAL(mode)) {
      B.set(st, ns, i, "primaryAxisSizingMode", "FIXED");
      B.set(st, ns, i, "counterAxisSizingMode", "FIXED");
    }
    if (B.isAL(B.parentMode(st, k))) {
      // Clearing the stretch is what makes the resize stick; the place passes then leave it alone.
      if (ns.layoutAlign === "STRETCH") { B.set(st, ns, i, "layoutAlign", "INHERIT"); st.pinned[k] = 1; }
      if (ns.layoutGrow) { B.set(st, ns, i, "layoutGrow", 0); st.pinned[k] = 1; }
    }
    // Figma will not make a flow frame smaller than its own padding on the flow axis, and Pixso
    // will. A childless frame gives up the flow (which lays nothing out) rather than its size.
    if (!kidsOf(st, k).length && B.isAL(mode)) {
      var padSum = mode === "HORIZONTAL" ? (ns.paddingLeft || 0) + (ns.paddingRight || 0) : (ns.paddingTop || 0) + (ns.paddingBottom || 0);
      var wanted = mode === "HORIZONTAL" ? w.w : w.h;
      if (padSum > wanted + 0.5) { B.set(st, ns, i, "layoutMode", "NONE"); C.layoutDroppedForSize++; }
    }
    // Re-read before acting: a stale size would pin an axis at the wrong value.
    if (sizeOk(st, k)) { C.sizeRejected++; continue; }
    try { B.resize(ns, bt, w.w, w.h); if (countIt) C.sizeRepaired++; }
    catch (e) { ctx.failure(i, "resize", msgOf(e)); }
  }
};

// ---------- place (builder4.js:234-275) ----------
B.placePass = async function (st) {
  var ctx = st.ctx;
  for (var k = 0; k < st.n; k++) {
    await B.tick(st, k);
    if (st.fixed[k] || onPage(st, k)) continue;
    var rec = st.recs[k], n = st.node[k], i = rec.i, want = st.want[k];
    if (B.isAL(B.parentMode(st, k))) {
      var lp = ctx.prop(rec, "layoutPositioning");
      var rotated = B.isRotated(want.rt);
      if (!st.flowAbs[k] && !st.rotPinned[k]) B.set(st, n, i, "layoutPositioning", lp);
      if (lp !== "ABSOLUTE" && !rotated && !st.flowAbs[k]) {
        if (!st.pinned[k]) {
          B.set(st, n, i, "layoutAlign", ctx.prop(rec, "layoutAlign"));
          B.set(st, n, i, "layoutGrow", ctx.prop(rec, "layoutGrow"));
        }
        continue;
      }
      // Figma drops a turn or a mirror of a child in a flow; the child leaves the flow instead.
      if (rotated && lp !== "ABSOLUTE" && !st.rotPinned[k]) {
        B.set(st, n, i, "layoutPositioning", "ABSOLUTE");
        st.pinned[k] = 1; st.rotPinned[k] = 1;
        st.counters.rotPinned++;
      }
    }
    if (st.native[k]) continue;
    B.set(st, n, i, "relativeTransform", U.matrix(want.rt));
  }
};

// ---------- flow (builder4.js:386-584) ----------
// Each node's expected absolute matrix, composed from its root's built one, and how far its built
// bounding box's min corner is from the expected box's. Hidden nodes, and a native boolean's
// operands, are never measured and never candidates.
function deltaOf(st, k, e) {
  var w = st.want[k], ew = w.w || 0, eh = w.h || 0, mnx = Infinity, mny = Infinity;
  for (var c = 0; c < 4; c++) {
    var cx = (c === 1 || c === 2) ? ew : 0, cy = c >= 2 ? eh : 0;
    var px = e[0] * cx + e[1] * cy + e[2], py = e[3] * cx + e[4] * cy + e[5];
    if (px < mnx) mnx = px; if (py < mny) mny = py;
  }
  var bb = st.node[k].absoluteBoundingBox;
  var ax = bb ? bb.x : mnx, ay = bb ? bb.y : mny;
  return { dx: ax - mnx, dy: ay - mny, d: Math.sqrt((ax - mnx) * (ax - mnx) + (ay - mny) * (ay - mny)) };
}
async function flowDeltas(st) {
  var ctx = st.ctx, exp = [], vis = [], dp = [];
  for (var k = 0; k < st.n; k++) {
    await B.tick(st, k);
    var rec = st.recs[k], pk = st.parentK[k], shown = ctx.prop(rec, "visible") !== false;
    if (pk < 0) {
      var at = st.node[k].absoluteTransform;
      exp[k] = [at[0][0], at[0][1], at[0][2], at[1][0], at[1][1], at[1][2]];
      vis[k] = shown;
    } else { exp[k] = mul6(exp[pk], st.want[k].rt); vis[k] = vis[pk] && shown; }
    if (!vis[k] || st.fixed[k]) { dp[k] = { dx: 0, dy: 0, d: 0, vis: false }; continue; }
    var d = deltaOf(st, k, exp[k]);
    d.vis = true;
    dp[k] = d;
  }
  return { dp: dp, exp: exp };
}

// A split root in an auto-layout parent an earlier task built: the flow places it among siblings this
// task does not hold, which the passes above never see (they start from each root's built matrix).
// Where it lands more than half a pixel from its IR place in that parent, it leaves the flow onto its
// wanted matrix, the parent frozen at its size; if any sibling moves, or it is not nearer, everything
// is put back, and the judge counts the offset (VERIFY's roots[].inParent).
async function splitRootsFix(st) {
  var ctx = st.ctx, C = st.counters, D = st.detail;
  if (!st.splitTried) st.splitTried = {};
  // Last first: a later flow child leaves without moving the earlier ones.
  for (var r = st.rootKs.length - 1; r >= 0; r--) {
    var k = st.rootKs[r], to = st.attachTo[k];
    if (!to || typeof to !== "object" || st.splitTried[k] || !B.isAL(st.attachMode[k])) continue;
    if (st.flowAbs[k] || st.rotPinned[k] || st.native[k]) continue;
    var rec = st.recs[k], n = st.node[k], par = st.attach[k];
    if (ctx.prop(rec, "layoutPositioning") === "ABSOLUTE" || ctx.prop(rec, "visible") === false) continue;
    await B.tick(st, k);
    st.splitTried[k] = 1;
    var pa = par.absoluteTransform;
    var e = mul6([pa[0][0], pa[0][1], pa[0][2], pa[1][0], pa[1][1], pa[1][2]], st.want[k].rt);
    var now = deltaOf(st, k, e);
    if (now.d <= 0.5) continue;
    var sibs = [], sibXY = [], kids = par.children || [];
    for (var s = 0; s < kids.length; s++) if (kids[s].id !== n.id) { sibs.push(kids[s]); sibXY.push([kids[s].x, kids[s].y]); }
    var pw = par.width, ph = par.height;
    try {
      B.set(st, par, to.i, "primaryAxisSizingMode", "FIXED");
      B.set(st, par, to.i, "counterAxisSizingMode", "FIXED");
      n.layoutPositioning = "ABSOLUTE";
      n.relativeTransform = U.matrix(st.want[k].rt);
      if (Math.abs(par.width - pw) > 0.01 || Math.abs(par.height - ph) > 0.01) {
        try { B.resize(par, par.type, pw, ph); } catch (e1) { ctx.failure(to.i, "resize", msgOf(e1)); }
      }
      var moved = 0, worstSib = 0;
      for (var q = 0; q < sibs.length; q++) {
        var ds = Math.max(Math.abs(sibs[q].x - sibXY[q][0]), Math.abs(sibs[q].y - sibXY[q][1]));
        if (ds > 0.5) { moved++; if (ds > worstSib) worstSib = ds; }
      }
      var after = deltaOf(st, k, e);
      if (moved || after.d > now.d - 0.01) {
        try { n.layoutPositioning = "AUTO"; } catch (e2) {}
        if (moved) { D.flowSiblingGuard++; if (worstSib > D.flowSiblingWorst) D.flowSiblingWorst = r2(worstSib); }
        else C.flowReverted++;
      } else { C.flowAbsolute++; st.flowAbs[k] = 1; }
    } catch (e3) { C.flowStillOff++; }
  }
}

B.flowFixPass = async function (st, last) {
  var ctx = st.ctx, C = st.counters, D = st.detail;
  await ctx.settle(firstRoot(st));
  await splitRootsFix(st);
  var fd = await flowDeltas(st), dp = fd.dp, EXP = fd.exp;
  for (var g = 0; g < st.n; g++) {
    await B.tick(st, g);
    var pi = st.parentK[g];
    if (pi < 0 || !dp[g].vis || dp[g].d <= 0.5) continue;
    if (dp[pi] && dp[pi].d > 0.5) continue;
    var pmode = B.modeOf(st, pi);
    if (!B.isAL(pmode)) continue;
    var rec = st.recs[g], ng = st.node[g], png = st.node[pi], i = rec.i;
    if (ctx.prop(rec, "layoutPositioning") === "ABSOLUTE" || st.native[g]) continue;
    var m = st.want[g].rt;
    // Never act on the batch reading alone: re-measure this node now.
    var now = deltaOf(st, g, EXP[g]);
    if (now.d <= 0.5) { C.flowRejected++; continue; }
    dp[g] = { dx: now.dx, dy: now.dy, d: now.d, vis: true };
    var horiz = pmode === "HORIZONTAL";
    var primOff = horiz ? now.dx : now.dy, cntOff = horiz ? now.dy : now.dx;
    if (Math.abs(primOff) <= 0.5) {
      var before = ng.layoutAlign, opts = ["MIN", "CENTER", "MAX"], best = null, bestErr = Math.abs(cntOff);
      var baseX = ng.x - now.dx, baseY = ng.y - now.dy;
      for (var oi = 0; oi < opts.length; oi++) {
        try { ng.layoutAlign = opts[oi]; } catch (e) { continue; }
        var err = Math.abs(horiz ? (ng.y - baseY) : (ng.x - baseX));
        if (err < bestErr - 0.01) { bestErr = err; best = opts[oi]; }
      }
      if (best !== null && bestErr <= 0.5) { try { ng.layoutAlign = best; C.flowAligned++; continue; } catch (e2) {} }
      try { ng.layoutAlign = before; } catch (e3) {}
    }
    // Last resort: out of the flow, on the wanted matrix. The parent is frozen first, and every
    // sibling's place is kept: if any moves, or the node is not nearer, everything is put back.
    var sibs = [], sibXY = [], kids = kidsOf(st, pi);
    for (var si = 0; si < kids.length; si++) {
      if (kids[si].id === ng.id) continue;
      sibs.push(kids[si]); sibXY.push([kids[si].x, kids[si].y]);
    }
    var pw = png.width, ph = png.height;
    try {
      if (B.isAL(readMode(st, pi))) {
        B.set(st, png, st.recs[pi].i, "primaryAxisSizingMode", "FIXED");
        B.set(st, png, st.recs[pi].i, "counterAxisSizingMode", "FIXED");
      }
      ng.layoutPositioning = "ABSOLUTE";
      ng.relativeTransform = U.matrix(m);
      if (Math.abs(png.width - pw) > 0.01 || Math.abs(png.height - ph) > 0.01) {
        try { B.resize(png, st.builtType[pi], pw, ph); } catch (e4) { ctx.failure(st.recs[pi].i, "resize", msgOf(e4)); }
      }
      var moved = 0, worstSib = 0;
      for (var sj = 0; sj < sibs.length; sj++) {
        var ds2 = Math.max(Math.abs(sibs[sj].x - sibXY[sj][0]), Math.abs(sibs[sj].y - sibXY[sj][1]));
        if (ds2 > 0.5) { moved++; if (ds2 > worstSib) worstSib = ds2; }
      }
      var after = deltaOf(st, g, EXP[g]);
      if (moved || after.d > now.d - 0.01) {
        try { ng.layoutPositioning = "AUTO"; } catch (e5) {}
        if (moved) { D.flowSiblingGuard++; if (worstSib > D.flowSiblingWorst) D.flowSiblingWorst = r2(worstSib); }
        else C.flowReverted++;
      } else { C.flowAbsolute++; st.flowAbs[g] = 1; }
    } catch (e6) { if (last) C.flowStillOff++; }
  }
};

B.flowGroupPass = async function (st) {
  var ctx = st.ctx, C = st.counters, D = st.detail;
  await ctx.settle(firstRoot(st));
  var fd = await flowDeltas(st), dp = fd.dp, EXP = fd.exp;
  var kids = {}, parents = [];
  for (var a = 0; a < st.n; a++) {
    var pa = st.parentK[a];
    if (pa < 0 || !B.isAL(B.modeOf(st, pa))) continue;
    if (!own(kids, pa)) { kids[pa] = []; parents.push(pa); }
    kids[pa].push(a);
  }
  for (var pIdx = 0; pIdx < parents.length; pIdx++) {
    if (pIdx % 50 === 0 && pIdx > 0) await ctx.settle(firstRoot(st));
    ctx.progress();
    var pi = parents[pIdx];
    if (dp[pi] && dp[pi].vis && dp[pi].d > 0.5) continue;   // the parent is the real problem
    var set = kids[pi], bad = 0, before = 0, movable = [];
    for (var q = 0; q < set.length; q++) {
      var gi = set[q];
      if (!dp[gi].vis || st.native[gi] || ctx.prop(st.recs[gi], "layoutPositioning") === "ABSOLUTE") continue;
      movable.push(gi);
      before += dp[gi].d;
      if (dp[gi].d > 0.5) bad++;
    }
    if (bad < 2 || movable.length < 2) continue;   // one stray child is the per-child pass's job
    var png = st.node[pi], pw = png.width, ph = png.height, undo = [];
    try {
      if (B.isAL(readMode(st, pi))) {
        B.set(st, png, st.recs[pi].i, "primaryAxisSizingMode", "FIXED");
        B.set(st, png, st.recs[pi].i, "counterAxisSizingMode", "FIXED");
      }
      for (var w = 0; w < movable.length; w++) {
        var ng2 = st.node[movable[w]];
        undo.push([ng2, ng2.layoutPositioning]);
        ng2.layoutPositioning = "ABSOLUTE";
        ng2.relativeTransform = U.matrix(st.want[movable[w]].rt);
      }
      if (Math.abs(png.width - pw) > 0.01 || Math.abs(png.height - ph) > 0.01) {
        try { B.resize(png, st.builtType[pi], pw, ph); } catch (e) { ctx.failure(st.recs[pi].i, "resize", msgOf(e)); }
      }
      var after = 0;
      for (var v2 = 0; v2 < movable.length; v2++) after += deltaOf(st, movable[v2], EXP[movable[v2]]).d;
      if (after < before - 0.5) {
        C.flowGroups++; D.flowGroupNodes += movable.length;
        for (var u2 = 0; u2 < movable.length; u2++) { dp[movable[u2]] = { dx: 0, dy: 0, d: 0, vis: true }; st.flowAbs[movable[u2]] = 1; }
      } else {
        for (var u = 0; u < undo.length; u++) { try { undo[u][0].layoutPositioning = undo[u][1] || "AUTO"; } catch (e2) {} }
        D.flowGroupsRejected++;
      }
    } catch (eG) {
      for (var u3 = 0; u3 < undo.length; u3++) { try { undo[u3][0].layoutPositioning = undo[u3][1] || "AUTO"; } catch (e3) {} }
      D.flowGroupsRejected++;
    }
  }
};

// ---------- textLine (builder4.js:591-671) ----------
// Where a line height differs from the font's natural one, Pixso and Figma put the first line in
// different places; leadingTrim CAP_HEIGHT closes it, and is taken back wherever it moves the node.
// The natural height is measured on one scratch text node, stamped pxScratch and removed after.
B.textLinePass = async function (st) {
  var ctx = st.ctx, C = st.counters, D = st.detail, F = ctx.figma, probe = null, cache = {}, trimmed = [];
  for (var k = 0; k < st.n; k++) {
    var rec = st.recs[k];
    if (rec.type !== "TEXT" || st.builtType[k] !== "TEXT") continue;
    await B.tick(st, k);
    var lh = ctx.prop(rec, "lineHeight"), fs = ctx.prop(rec, "fontSize");
    if (!lh || lh.unit === "AUTO" || typeof lh.value !== "number" || typeof fs !== "number") continue;
    if (ctx.prop(rec, "leadingTrim") !== "NONE") continue;   // already trimmed in the source
    var setLH = lh.unit === "PIXELS" ? lh.value : (lh.value / 100) * fs;
    var use = IR.textFont(ctx, ctx.prop(rec, "fontName")) || st.settings.fallbackFont;
    var key = use.family + "|" + use.style + "|" + fs;
    try {
      var nat = cache[key];
      if (nat === undefined) {
        if (!probe) {
          probe = F.createText();
          probe.name = "pix2fig scratch";
          ctx.stamp(probe, "pxScratch", "1");
        }
        probe.fontName = { family: use.family, style: use.style };
        probe.textAutoResize = "WIDTH_AND_HEIGHT";
        probe.lineHeight = { unit: "AUTO" };
        probe.letterSpacing = { unit: "PIXELS", value: 0 };
        probe.textCase = "ORIGINAL";
        probe.characters = "A";
        probe.fontSize = fs;
        nat = probe.height;
        cache[key] = nat;
      }
      if (Math.abs(setLH - nat) < 1) continue;
      var tn = st.node[k], at0 = tn.absoluteTransform;
      trimmed.push({ k: k, x: at0[0][2], y: at0[1][2], w: tn.width, h: tn.height });
      tn.leadingTrim = "CAP_HEIGHT";
    } catch (eL) { D.textTrimSkipped++; }
  }
  // Guard on where the node ends up, after Figma has laid the page out again.
  await ctx.settle(firstRoot(st));
  for (var t = 0; t < trimmed.length; t++) {
    await B.tick(st, t);
    var r = trimmed[t], n = st.node[r.k], at1 = n.absoluteTransform;
    if (Math.abs(at1[0][2] - r.x) > 0.5 || Math.abs(at1[1][2] - r.y) > 0.5 || Math.abs(n.width - r.w) > 0.5 || Math.abs(n.height - r.h) > 0.5) {
      try { n.leadingTrim = "NONE"; C.textTrimReverted++; } catch (e) { ctx.failure(st.recs[r.k].i, "leadingTrim", msgOf(e)); }
    } else C.textTrimmed++;
  }
  await ctx.settle(firstRoot(st));
  if (probe) { try { probe.remove(); } catch (eP) { ctx.failure(null, "scratch", msgOf(eP)); } }
};

// ---------- constraints, last (builder4.js:673-702) ----------
// A constraint says what happens when the parent is resized later, by the designer; set any earlier,
// it would act on the build's own resizes. A child the flow places takes none.
B.constraintsPass = async function (st) {
  var ctx = st.ctx;
  for (var k = 0; k < st.n; k++) {
    await B.tick(st, k);
    if (st.fixed[k] || onPage(st, k)) continue;
    var rec = st.recs[k];
    if (B.isAL(B.parentMode(st, k))) {
      var lp = ctx.prop(rec, "layoutPositioning");
      if (lp !== "ABSOLUTE" && !B.isRotated(st.want[k].rt) && !st.flowAbs[k]) continue;
    }
    var c = ctx.prop(rec, "constraints");
    if (c === undefined) continue;
    if (B.set(st, st.node[k], rec.i, "constraints", c)) st.counters.constraintsSet++;
  }
};

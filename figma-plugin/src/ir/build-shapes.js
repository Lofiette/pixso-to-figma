// Vectors and booleans for the IR builder (docs/M1.md §6 B steps 5 and 6, D3, D5). Part B. Bundled as
// (function (IR) { … })(PXF_IR) after common.js.
//
//   IR.B.vectorsPhase(st)
//     A VECTOR record carries exactly one build source (D3), and the builder takes it from the one
//     geometry prop the record has (build.js has already refused a geometry record without its
//     note). vectorNetwork: setVectorNetworkAsync, awaited one by one with progress before and after;
//     a throw is VECTOR_NETWORK_REFUSED and the vector keeps no paths, because a build task carries
//     no geometry for it (the oracle is stripped). fillGeometry: vectorPaths, the stroke drawn on
//     the fill path; strokeGeometry is never a source. No resize: a vector's size is its paths'.
//     Figma may move a vector's origin to its paths' bounds (docs/M1.md §11, P19B): the first point
//     written is compared with the first point read back, and where they differ the record's
//     wanted transform takes the difference, so the drawing stays where Pixso has it
//     (detail.vectorOriginShifted).
//
//   IR.B.booleansPhase(st)
//     Deepest first (D5). The operands were built into a holder frame that carries the boolean's
//     box; figma.union / subtract / intersect / exclude makes the boolean inside the holder, from
//     the operands as they stand there; the boolean then takes the holder's place in its parent with
//     the wanted matrix composed onto its own (want · boolean; never the holder's read back, which in
//     a flow is the flow's place with the turn dropped, and a layout read in a write-only phase), so
//     every operand keeps the absolute matrix the IR composes for it, and the holder is removed. In
//     a flow, an ABSOLUTE boolean leaves the flow before its matrix is written; the composed matrix
//     is kept (st.boolRt) for the place passes to write again where the boolean is ABSOLUTE or pinned. Then the boolean's own
//     paints and props. Its box is Figma's, from its operands: the passes never resize or move it by
//     matrix, and its operands are left as they are (st.native, st.fixed). A throw, or no operand,
//     is BOOLEAN_FALLBACK: the holder stays, a frame with the operands in it.
var B = IR.B || (IR.B = {});
var CODE = IR.CODE, U = IR.util;
var OPS = { UNION: "union", SUBTRACT: "subtract", INTERSECT: "intersect", EXCLUDE: "exclude" };

function msgOf(e) { return String((e && e.message) || e).slice(0, 300); }
function firstPoint(data) {
  // Figma reads paths back with the command glued to its first number ("M0 0L…", P19B 2026-10-05).
  var m = /^\s*M\s*([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)[\s,]+([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)/.exec(String(data));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}
function indexIn(parent, node) {
  var ch = parent.children;
  for (var j = 0; j < ch.length; j++) if (ch[j].id === node.id) return j;
  return ch.length;
}

// The node draws its point p at q instead: its wanted transform takes the difference, so that
// transform · q lands where the IR's transform puts p.
B.shiftOrigin = function (st, k, p, q) {
  if (!p || !q) return;
  var dx = p.x - q.x, dy = p.y - q.y;
  if (!(isFinite(dx) && isFinite(dy)) || (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)) return;
  var rt = st.want[k].rt;
  rt[2] += rt[0] * dx + rt[1] * dy;
  rt[5] += rt[3] * dx + rt[4] * dy;
  st.detail.vectorOriginShifted++;
};

B.vectorsPhase = async function (st) {
  var ctx = st.ctx;
  for (var k = 0; k < st.n; k++) {
    var rec = st.recs[k];
    if (rec.type !== "VECTOR") continue;
    await B.tick(st, k);
    var node = st.node[k], pr = rec.props;
    if (pr.vectorNetwork !== undefined) {
      var net = ctx.value(pr.vectorNetwork), ok = true;
      // A region's own fills are IR paints, written as Figma paints like a node's (review R4).
      if (net && Array.isArray(net.regions) && net.regions.some(function (g) { return g && g.fills; })) {
        net = { vertices: net.vertices, segments: net.segments, regions: net.regions.map(function (g) {
          return g.fills ? { windingRule: g.windingRule, loops: g.loops, fills: IR.mapPaints(ctx, g.fills, rec.i) } : g;
        }) };
      }
      ctx.progress();
      try { await node.setVectorNetworkAsync(net); }
      catch (e) { ok = false; ctx.code(CODE.VECTOR_NETWORK_REFUSED, rec.i, msgOf(e)); }
      ctx.progress();
      if (ok) {
        st.counters.vectorsNetwork++;
        var back = null;
        try { back = node.vectorNetwork; } catch (e2) { back = null; }
        var v0 = net && net.vertices && net.vertices[0], b0 = back && back.vertices && back.vertices[0];
        if (v0 && b0) B.shiftOrigin(st, k, { x: v0.x, y: v0.y }, { x: b0.x, y: b0.y });
      }
    } else if (pr.fillGeometry !== undefined) {
      var geo = ctx.value(pr.fillGeometry).map(function (g) { return { windingRule: g.windingRule, data: g.data }; });
      try {
        node.vectorPaths = geo;
        st.counters.vectorsGeometry++;
        var paths = null;
        try { paths = node.vectorPaths; } catch (e3) { paths = null; }
        if (geo.length && paths && paths.length) B.shiftOrigin(st, k, firstPoint(geo[0].data), firstPoint(paths[0].data));
      } catch (e4) { ctx.failure(rec.i, "vectorPaths", msgOf(e4)); }
    }
    B.set(st, node, rec.i, "relativeTransform", U.matrix(st.want[k].rt));
  }
};

function makeBoolean(st, k) {
  var ctx = st.ctx, F = ctx.figma, rec = st.recs[k], i = rec.i, holder = st.node[k];
  var op = ctx.prop(rec, "booleanOperation");
  var fname = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  var operands = holder.children, made = null, why = null;
  if (!fname) why = "no Figma operation for " + JSON.stringify(op);
  else if (!operands.length) why = "no operand";
  else { try { made = F[fname](operands, holder, 0); } catch (e) { why = msgOf(e); } }
  if (!made) { ctx.code(CODE.BOOLEAN_FALLBACK, i, String(op) + ": " + why); return; }
  var parent = holder.parent, at = indexIn(parent, holder);
  if (!st.boolRt) st.boolRt = {};
  try {
    var brt = made.relativeTransform;
    st.boolRt[k] = U.mul(U.matrix(st.want[k].rt), brt);
    parent.insertChild(at, made);
    if (B.isAL(B.parentMode(st, k)) && ctx.prop(rec, "layoutPositioning") === "ABSOLUTE") made.layoutPositioning = "ABSOLUTE";
    made.relativeTransform = st.boolRt[k];
    holder.remove();
  } catch (e2) {
    // The boolean exists but sits in its holder: still drawn right, one frame deeper. Counted.
    ctx.failure(i, "booleanOperation", "the boolean could not take its holder's place: " + msgOf(e2));
    return;
  }
  st.node[k] = made;
  st.builtType[k] = "BOOLEAN_OPERATION";
  st.native[k] = true;
  ctx.S.nodes[String(i)] = made.id;
  made.name = String(rec.name);
  B.writeProps(st, k, made);
  st.counters.booleansNative++;
  if (st.isRoot[k]) B.stampRoot(st, k, "partial");
}

B.booleansPhase = async function (st) {
  var order = [];
  for (var k = 0; k < st.n; k++) if (st.recs[k].type === "BOOLEAN_OPERATION") order.push(k);
  order.sort(function (a, b) { return st.depth[b] - st.depth[a] || b - a; });
  for (var j = 0; j < order.length; j++) {
    await B.tick(st, j);
    makeBoolean(st, order[j]);
  }
  // The operands of a native boolean, and everything under them, keep the matrices the union gave them.
  for (var k2 = 0; k2 < st.n; k2++) {
    var pk = st.parentK[k2];
    st.fixed[k2] = pk >= 0 && (st.native[pk] || st.fixed[pk]);
  }
};

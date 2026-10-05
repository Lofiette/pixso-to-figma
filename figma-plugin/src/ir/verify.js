// VERIFY (part C): what Figma built, measured for the judge (tools/ir/judge.mjs). docs/M1.md §6 C,
// §8.3. Bundled as (function (IR) { … })(PXF_IR) after common.js. It reads the built tree and writes
// nothing to it; the only node it makes is countLines' scratch text, removed before it returns.
//
// CONTRACT:
//
//   IR.ops.verify(ctx, task) -> Promise<{ op: "verify", taskNo, runId, roots: [{ i, id, found }], count,
//                                          rows, fontsMissing, ms, codes, coded, failures }>
//     (code.js adds `plugin`.) In order:
//     1. fonts: loadFontAsync for task.fonts and settings.fallbackFont; a font that will not load is
//        listed in fontsMissing, and ctx.S.fonts marks it "sub" unless the session already knows it
//        (so countLines writes what the build wrote).
//     2. roots: ctx.findRoot(i) for every task root; one not found is { i, id: null, found: false }
//        and is coded ROOT_NOT_FOUND (the judge counts it from `roots`).
//     3. settle: one ctx.settle on the first root found.
//     4. walk: from each root found, in task.roots order, depth first. A Figma child is paired with
//        the task's child record at the same position (task.nodes is parent-first, so task.nodes[k]
//        is the built DFS[k] when the build is right); a child that is another task's root (stamped
//        pxIdx with an index this task does not hold, under a parent stamped pxIdx: a split root) is
//        skipped and not counted. `count` is every Figma node walked, paired or not; a row is written
//        for every paired record:
//          [i, builtType, childCount, effVisible, absX, absY, w, h, sides|null, vec|null, lines|null]
//        builtType  node.type;  childCount  its children walked;  effVisible  node.visible and every
//        ancestor's up to the page;  absX, absY  the min corner of the node's box (0..width,
//        0..height) under its absolute transform relative to the root's (the root's own transform is
//        the origin, so a root's `place` never counts);  w, h  node.width, node.height;  sides
//        [top, right, bottom, left] when node.strokes is not empty (the four side weights, or
//        [w, w, w, w] for a type without sides), else null;  vec  for a record of a vector type
//        (schema VECTOR_TYPES), PXF_PATHGEOM.geometryBounds(node.fillGeometry, the same relative
//        transform): one [winding, x0, y0, x1, y1, subpaths] per Figma fill path, no path string
//        (the sixth element, subpaths, is part C's addition to docs/M1.md §6 C, for `regrouped`);
//        lines  ctx.measure(node, rec) for a TEXT record carrying `lines` (a throw is a failure entry
//        { i, prop: "lines", msg } and lines null). Numbers are rounded to 0.001.
//     5. IR.dropScratch(ctx), also when the walk throws.
//     ms is booked under the phases fonts, roots, settle and walk. Every node advances ctx.progress
//     and passes ctx.breathe; no timer is used.

function r3(n) { return Math.round(n * 1000) / 1000; }

function sidesOf(ctx, node) {
  if (!("strokes" in node)) return null;
  var strokes = node.strokes;
  if (!Array.isArray(strokes) || strokes.length === 0) return null;
  if ("strokeTopWeight" in node) return [r3(node.strokeTopWeight), r3(node.strokeRightWeight), r3(node.strokeBottomWeight), r3(node.strokeLeftWeight)];
  var w = node.strokeWeight;
  if (typeof w !== "number") w = 0;   // figma.mixed on a type without side weights: not expected
  return [r3(w), r3(w), r3(w), r3(w)];
}

function boxMin(m, w, h) {
  var x = Infinity, y = Infinity, c = [[0, 0], [w, 0], [0, h], [w, h]];
  for (var k = 0; k < 4; k++) {
    var p = IR.util.apply(m, c[k][0], c[k][1]);
    if (p[0] < x) x = p[0];
    if (p[1] < y) y = p[1];
  }
  return [x, y];
}

function shownToPage(node) {
  for (var n = node; n && n.type !== "PAGE" && n.type !== "DOCUMENT"; n = n.parent) if (n.visible === false) return false;
  return true;
}

IR.ops.verify = async function (ctx, task) {
  var report = ctx.report, F = ctx.figma, CODE = IR.CODE;
  var VT = PXF_SCHEMA.VECTOR_TYPES;
  var recs = Array.isArray(task.nodes) ? task.nodes : [];
  var byI = {}, kids = {}, measureAny = false;
  for (var a = 0; a < recs.length; a++) byI[recs[a].i] = recs[a];
  for (var b = 0; b < recs.length; b++) {
    var r = recs[b];
    if (IR.util.own(byI, r.parent)) (kids[r.parent] || (kids[r.parent] = [])).push(r);
    if (r.type === "TEXT" && r.props && typeof r.props.lines === "number") measureAny = true;
  }

  // 1. fonts
  ctx.phase("fonts");
  var fonts = (Array.isArray(task.fonts) ? task.fonts : []).slice();
  if (task.settings && task.settings.fallbackFont) fonts.push(task.settings.fallbackFont);
  var missing = [], seen = {};
  for (var f = 0; f < fonts.length; f++) {
    var key = fonts[f].family + "|" + fonts[f].style;
    if (seen[key]) continue;
    seen[key] = true;
    ctx.progress();
    try {
      await F.loadFontAsync({ family: fonts[f].family, style: fonts[f].style });
      if (!IR.util.own(ctx.S.fonts, key)) ctx.S.fonts[key] = "ok";
    } catch (e) {
      missing.push({ family: fonts[f].family, style: fonts[f].style });
      if (!IR.util.own(ctx.S.fonts, key)) ctx.S.fonts[key] = "sub";
    }
  }
  report.fontsMissing = missing;

  // 2. roots
  ctx.phase("roots");
  var roots = [], found = [];
  var taskRoots = Array.isArray(task.roots) ? task.roots : [];
  for (var t = 0; t < taskRoots.length; t++) {
    var ri = taskRoots[t].i;
    ctx.progress();
    var node = await ctx.findRoot(ri);
    roots.push({ i: ri, id: node ? node.id : null, found: !!node });
    if (node) found.push([node, byI[ri]]);
    else ctx.code(CODE.ROOT_NOT_FOUND, ri, null);
  }

  // 3. one settle
  ctx.phase("settle");
  if (found.length) await ctx.settle(found[0][0]);

  // 4. the walk
  ctx.phase("walk");
  var rows = [], count = 0, step = 0;
  var foreign = function (child) {
    var s = ctx.stampOf(child, "pxIdx");
    return s !== "" && !IR.util.own(byI, s);
  };
  async function walk(node, rec, parentShown, rootInv) {
    count++;
    ctx.progress();
    await ctx.breathe(++step);
    var shown = parentShown && node.visible !== false;
    var children = "children" in node ? node.children : [];
    if (children.length && ctx.stampOf(node, "pxIdx") !== "") children = children.filter(function (c) { return !foreign(c); });
    if (rec) {
      var rel = IR.util.mul(rootInv, node.absoluteTransform);
      var w = node.width, h = node.height;
      var mn = boxMin(rel, w, h);
      var vec = null;
      if (VT.indexOf(rec.type) >= 0) {
        vec = "fillGeometry" in node
          ? PXF_PATHGEOM.geometryBounds(node.fillGeometry, rel).map(function (p) { return [p[0], r3(p[1]), r3(p[2]), r3(p[3]), r3(p[4]), p[5]]; })
          : [];
      }
      var lines = null;
      if (rec.type === "TEXT" && rec.props && typeof rec.props.lines === "number" && node.type === "TEXT") {
        try {
          var m = ctx.measure(node, rec);
          lines = { lines: m.lines, approx: !!m.approx };
        } catch (e) { ctx.failure(rec.i, "lines", (e && e.message) || e); }
      }
      rows.push([rec.i, node.type, children.length, shown, r3(mn[0]), r3(mn[1]), r3(w), r3(h), sidesOf(ctx, node), vec, lines]);
    }
    var mine = rec && IR.util.own(kids, rec.i) ? kids[rec.i] : [];
    for (var c = 0; c < children.length; c++) await walk(children[c], c < mine.length ? mine[c] : null, shown, rootInv);
  }
  try {
    if (measureAny && found.length) await IR.prepareMeasure(ctx);
    for (var g = 0; g < found.length; g++) {
      var root = found[g][0];
      var parentShown = root.parent ? shownToPage(root.parent) : true;
      await walk(root, found[g][1], parentShown, IR.util.inv(root.absoluteTransform));
    }
  } finally {
    IR.dropScratch(ctx);
    ctx.phase(null);
  }
  report.roots = roots;
  report.count = count;
  report.rows = rows;
  return report;
};

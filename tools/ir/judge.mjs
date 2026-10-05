// The judge: what the IR said against what VERIFY measured in Figma, per task and per run
// (docs/M1.md §8.3). Part P0 froze the shapes below, which part D's verdict (m1Verdict, the gates
// of §8.1) and part F's end-to-end test read; part C implements judgeTask and judgeRun.
//
// CONTRACT (the shapes frozen by P0; the rules part C's):
//
//   judgeTask({ ir, task, build, verify, lostBorder? }) -> J
//     ir      the validated IR (tools/ir/validate.mjs), oracle props included
//     task    the build (or verify) task (tools/ir/task.mjs) that was built and verified; each of its
//             records must be the IR record of the same index (same guid and type)
//     build   the plugin's build report (docs/M1.md §6 B), or null when the build failed
//     verify  the plugin's verify report: { op: "verify", taskNo, roots: [{ i, id, found }], count, rows }
//             where each row is an array indexed by ROW below
//     lostBorder  optional: part A's stats.populations.lostBorder (IR indices). Only it names the
//             lost-border population (the .pix border fields are not in the IR); without it
//             sides.lostBorder stays { population: 0, ok: 0 }
//     returns J, of the shape J_SHAPE (every key present, nothing else), list items of J_ITEMS
//     throws  only on arguments that are not of these shapes (a programming error, not a finding)
//
//   judgeRun(Js) -> totals
//     returns TOTALS_SHAPE: J_SHAPE plus `tasks`, every number summed (geometry.maxSizeVisible, a
//     maximum, stays the maximum), every map merged by adding, every list concatenated
//     (geometry.worst re-sorted by its largest delta and cut to 30), and count.ok true only when
//     there is a task and every task's count.ok is. It throws on a J that is not of J_SHAPE.
//
//   emptyJ(), emptyTotals()   zeroed values of those shapes (no finding yet)
//   checkJShape(J, shape?)    -> [problem strings]; [] when J has exactly the shape (J_SHAPE by default)
//
// THE RULES (docs/M1.md §8.3), for the records of the task:
//
// Placement. The expected transform is the IR relativeTransform composed down from the record's task
//   root, whose own transform is the origin (a split root's and an S2 root's alike, so `place` never
//   counts); VERIFY measures the same way (the node's transform relative to its root's). Effective
//   visibility is the IR's: the record and every IR ancestor visible.
// count      expected = task.expect.count (or the record count); built = verify.count;
//   placeholders = rows at INSTANCE records; nonInstance = built - placeholders; ok when the three
//   equal the expectation (expect.nonInstance, expect.placeholders) and every root was found (G3).
// geometry   position: the min corner of the record's box under the expected transform against the
//   row's (builder4.js:804-852), dp = |(dx, dy)|; size: ds = max(|dw|, |dh|). A hidden record goes to
//   hiddenOver05 / sizeHiddenOver05 and classified.hidden, never to a visible count. A visible delta
//   is CLASSIFIED (counted in classified[class], in no visible count) when it is explained:
//     textWidened      decision 9: the record is a text the build widened (build.textWidened) or an
//                      ancestor of one, its width grew by at most the widening below it and its height
//                      moved at most 0.5 px; or it moved horizontally by at most the total widening of
//                      the widened texts under its task root, and vertically at most 0.5 px
//     insideHalfPixel  0.5 < dp <= 1 under an auto-layout ancestor whose INSIDE stroke has unequal
//                      sides and stays out of the layout (strokesIncludedInLayout false)
//   Every other visible delta counts: visibleOver05 (dp > 0.5), visibleOver1 (dp > 1, gate G6),
//   sizeVisibleOver05, sizeVisibleOver1 (gate G7), maxSizeVisible. worst lists the records with a
//   delta over 0.5 px, visible or not, largest first, at most 30.
// sides      every non-INSTANCE record with a row whose IR strokes or Figma strokes are not empty. The
//   IR's quadruple is strokeWeights, or strokeWeight four times, or zeros when its strokes are empty;
//   Figma's is the row's sides, or zeros. A side apart by more than 0.01 makes a mismatchIR entry.
//   Where the IR record has oracleSides: checkedAgainstOracle, and a Figma side > 0 where the oracle
//   draws none, or 0 where it draws one, makes a mismatchOracle entry (G8 gates both). unproven counts
//   the task's SIDE_RULE_UNPROVEN notes. lostBorder: the population in this task, and how many of
//   them Figma draws (some side > 0) with no mismatch.
// vectors    every record of a VECTOR_TYPES type under a root that was found. The oracle is the IR's
//   oracleFillGeometry, or its fillGeometry for a geometry-built record; no oracle means 0 paths. Both
//   sides are reduced by pathgeom's geometryBounds in root-relative coordinates. Outcome:
//     match       equal path counts, every path's bounds within 1 px, every winding equal
//     regrouped   path counts differ, the subpath counts and the union bounds (1 px) agree
//     otherwise a mismatch of kinds (VECTOR_DIFF_KINDS): missing (no row), count, bounds, winding.
//   A mismatch is EXCUSED only by a code set before VERIFY, counted once under the first that
//   applies: build-stage VECTOR_NETWORK_REFUSED, BOOLEAN_FALLBACK (build.coded), then read-stage
//   BOOLEAN_FLATTENED, VECTOR_FROM_GEOMETRY, GEOMETRY_INVALID, SOURCE_FEATURE_UNSUPPORTED (task notes
//   or IR notes), each excusing any kind but missing; then VECTOR_ORACLE_DIFFERS, which excuses only
//   its class: region-no-fill the count (and only while the Figma paths' union stays inside the
//   record's box + 1 px), network-bounds the bounds, winding the winding, and every kind found must
//   be covered. excused[code] counts every excused vector; excusedBuiltFromOracle[code] repeats the
//   ones under VECTOR_FROM_GEOMETRY and BOOLEAN_FLATTENED, which should match and which part F
//   reviews (a subset of excused, not added to it). Every other mismatch is a differs entry
//   { i, kind } (the first of missing, count, bounds, winding that no class covers) and a
//   VECTOR_GEOMETRY_DIFFERS code (gate G9). checked = match + regrouped + all excused + differs.
// text       every TEXT record. One without `lines` is unknown (TEXT_LINES_UNKNOWN). One with `lines`
//   and a measurement in its row is checked; a different count is a differ entry (its guid, both
//   counts, whether the build widened it, whether its font was substituted (FONT_SUBSTITUTED in
//   build.coded), whether the count is approximate) and a TEXT_LINES_DIFFER code. One with `lines`
//   and no measurement under a root that was found is unmeasured (gate G10).
// placeholders  expected = the task's INSTANCE records. Aligned: a row with builtType FRAME and 0
//   children, and, when the build report lists its coded entries, an INSTANCE_DEFERRED entry for
//   that index. misaligned lists the rest, and any index the build coded INSTANCE_DEFERRED that is
//   not an INSTANCE record of the task (gate G11).
// codes      the task's (read-stage) notes, the build report's codes, and the judge's own:
//   ROOT_NOT_FOUND per root not found, VECTOR_GEOMETRY_DIFFERS, TEXT_LINES_DIFFER.
import { CODE, VECTOR_TYPES, ORACLE_CLASSES } from "./schema.mjs";
import { geometryBounds, unionBounds, inBox } from "./pathgeom.mjs";

// A VERIFY row, by position (docs/M1.md §6 C):
//   [i, builtType, childCount, effVisible, absX, absY, w, h, sides|null, vec|null, lines|null]
//   sides  the four Figma side weights [top, right, bottom, left] (or [w, w, w, w] for a type without
//          sides) when the node's strokes are not empty
//   vec    [[winding, x0, y0, x1, y1], …] per Figma fill path, root-relative absolute coordinates
//   lines  { lines, approx } from countLines, TEXT only
export const ROW = Object.freeze({ i: 0, builtType: 1, childCount: 2, effVisible: 3, absX: 4, absY: 5, w: 6, h: 7,
  sides: 8, vec: 9, lines: 10, length: 11 });

// "n" a number, "b" a boolean, "[]" a list (items in J_ITEMS), "{n}" a map of string to number.
export const J_SHAPE = Object.freeze({
  count: { expected: "n", built: "n", nonInstance: "n", placeholders: "n", ok: "b" },
  geometry: { visible: "n", visibleOver05: "n", visibleOver1: "n", hiddenOver05: "n", sizeVisibleOver05: "n",
    sizeVisibleOver1: "n", maxSizeVisible: "n", sizeHiddenOver05: "n", classified: "{n}", worst: "[]" },
  sides: { checked: "n", checkedAgainstOracle: "n", mismatchIR: "[]", mismatchOracle: "[]", unproven: "n",
    lostBorder: { population: "n", ok: "n" } },
  vectors: { checked: "n", match: "n", regrouped: "n", excused: "{n}", excusedBuiltFromOracle: "{n}", differs: "[]" },
  text: { checked: "n", differ: "[]", unmeasured: "n", unknown: "n" },
  placeholders: { expected: "n", aligned: "n", misaligned: "[]" },
  codes: "{n}",
});
export const TOTALS_SHAPE = Object.freeze(Object.assign({ tasks: "n" }, J_SHAPE));

// The items of each list. "i" is an IR index; side quadruples are [top, right, bottom, left].
export const J_ITEMS = Object.freeze({
  "geometry.worst": { i: "n", dx: "n", dy: "n", dw: "n", dh: "n", visible: "b" },          // at most 30, largest first
  "sides.mismatchIR": { i: "n", ir: "[]", figma: "[]" },
  "sides.mismatchOracle": { i: "n", oracle: "[]", figma: "[]" },
  "vectors.differs": { i: "n", kind: "s" },                                                   // VECTOR_DIFF_KINDS
  "text.differ": { i: "n", guid: "s", irLines: "n", figmaLines: "n", widened: "b", fontHeld: "b", approx: "b" },
  "placeholders.misaligned": "n",
});
export const VECTOR_DIFF_KINDS = Object.freeze(["count", "bounds", "winding", "missing"]);

function zero(shape) {
  if (shape === "n") return 0;
  if (shape === "b") return false;
  if (shape === "[]") return [];
  if (shape === "{n}") return {};
  const o = {};
  for (const k of Object.keys(shape)) o[k] = zero(shape[k]);
  return o;
}
export function emptyJ() { return zero(J_SHAPE); }
export function emptyTotals() { return zero(TOTALS_SHAPE); }

export function checkJShape(J, shape) {
  const out = [];
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const item = (v, s, at) => {
    if (s === "n") { if (typeof v !== "number" || !isFinite(v)) out.push(at + " is not a number"); return; }
    if (s === "s") { if (typeof v !== "string") out.push(at + " is not a string"); return; }
    if (s === "b") { if (typeof v !== "boolean") out.push(at + " is not a boolean"); return; }
    if (s === "[]") { if (!Array.isArray(v)) out.push(at + " is not a list"); return; }
    if (!isObj(v)) { out.push(at + " is not an object"); return; }
    for (const k of Object.keys(s)) if (!(k in v)) out.push(at + "." + k + " is missing");
    for (const k of Object.keys(v)) if (!(k in s)) out.push(at + "." + k + " is not in the shape");
    for (const k of Object.keys(s)) if (k in v) item(v[k], s[k], at + "." + k);
  };
  (function walk(v, s, at) {
    if (s === "n" || s === "b") { item(v, s, at); return; }
    if (s === "{n}") {
      if (!isObj(v)) { out.push(at + " is not a map"); return; }
      for (const k of Object.keys(v)) if (typeof v[k] !== "number" || !isFinite(v[k])) out.push(at + "." + k + " is not a number");
      return;
    }
    if (s === "[]") {
      if (!Array.isArray(v)) { out.push(at + " is not a list"); return; }
      const it = J_ITEMS[at];
      if (it) v.forEach((x, j) => item(x, it, at + "[" + j + "]"));
      return;
    }
    if (!isObj(v)) { out.push((at || "J") + " is not an object"); return; }
    for (const k of Object.keys(s)) if (!(k in v)) out.push((at ? at + "." : "") + k + " is missing");
    for (const k of Object.keys(v)) if (!(k in s)) out.push((at ? at + "." : "") + k + " is not in the shape");
    for (const k of Object.keys(s)) if (k in v) walk(v[k], s[k], at ? at + "." + k : k);
  })(J, shape || J_SHAPE, "");
  return out;
}

export const JUDGE_IMPLEMENTED = true;

const POS = 1, HALF = 0.5, SIDE_TOL = 0.01, VEC_TOL = 1, EPS = 1e-6;
// The codes that excuse any vector mismatch but a missing node, in the order one is counted under.
const EXCUSE_ANY = [CODE.VECTOR_NETWORK_REFUSED, CODE.BOOLEAN_FALLBACK, CODE.BOOLEAN_FLATTENED, CODE.VECTOR_FROM_GEOMETRY,
  CODE.GEOMETRY_INVALID, CODE.SOURCE_FEATURE_UNSUPPORTED];
const BUILT_FROM_ORACLE = [CODE.VECTOR_FROM_GEOMETRY, CODE.BOOLEAN_FLATTENED];
// The one mismatch kind each VECTOR_ORACLE_DIFFERS class excuses (schema.ORACLE_CLASSES).
const CLASS_KIND = { "region-no-fill": "count", "network-bounds": "bounds", winding: "winding" };
// A differs entry names the first kind no class covers, in this order (each one of VECTOR_DIFF_KINDS).
const KIND_ORDER = ["missing", "count", "bounds", "winding"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const r2 = (n) => Math.round(n * 100) / 100;
const add = (map, k, n) => { map[k] = (map[k] || 0) + (n === undefined ? 1 : n); };
// IR [a, b, tx, c, d, ty] -> [[a, b, tx], [c, d, ty]]
const M = (rt) => [[rt[0], rt[1], rt[2]], [rt[3], rt[4], rt[5]]];
const I = () => [[1, 0, 0], [0, 1, 0]];
const mul = (m, n) => [
  [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
  [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]]];
function boxOf(m, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const x = m[0][0] * cx + m[0][1] * cy + m[0][2], y = m[1][0] * cx + m[1][1] * cy + m[1][2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}
const delta = (w) => Math.max(Math.hypot(w.dx, w.dy), Math.abs(w.dw), Math.abs(w.dh));
const subpaths = (e) => (e.length > 5 && typeof e[5] === "number" ? e[5] : 1);
const boxOfEntry = (e) => ({ x0: e[1], y0: e[2], x1: e[3], y1: e[4] });
const near = (a, b) => Math.abs(a.x0 - b.x0) <= VEC_TOL + EPS && Math.abs(a.y0 - b.y0) <= VEC_TOL + EPS &&
  Math.abs(a.x1 - b.x1) <= VEC_TOL + EPS && Math.abs(a.y1 - b.y1) <= VEC_TOL + EPS;
const unionOf = (entries) => unionBounds(entries.filter((e) => subpaths(e) > 0).map(boxOfEntry));

function argError(m) { return new TypeError("judgeTask: " + m); }

export function judgeTask(args) {
  if (!isObj(args)) throw argError("takes { ir, task, build, verify }");
  const { ir, task, build, verify } = args;
  if (!isObj(ir) || !Array.isArray(ir.nodes) || !Array.isArray(ir.values)) throw argError("ir is an IR ({ nodes, values, … })");
  if (!isObj(task) || !Array.isArray(task.nodes) || !Array.isArray(task.roots)) throw argError("task is a task ({ nodes, roots, … })");
  if (build !== null && build !== undefined && !isObj(build)) throw argError("build is a build report or null");
  if (!isObj(verify) || !Array.isArray(verify.rows) || !Array.isArray(verify.roots) || typeof verify.count !== "number") {
    throw argError("verify is a verify report ({ roots, count, rows })");
  }
  if (args.lostBorder !== undefined && args.lostBorder !== null && !Array.isArray(args.lostBorder)) throw argError("lostBorder is a list of IR indices");
  const B = build || null;
  const notesIR = Array.isArray(ir.notes) ? ir.notes : [];
  const taskNotes = Array.isArray(task.notes) ? task.notes.filter(isObj) : [];
  const value = (idx) => {
    if (!(Number.isInteger(idx) && idx >= 0 && idx < ir.values.length)) throw argError("values[" + idx + "] is not in the IR");
    return ir.values[idx];
  };

  // ---- the records: structure, expected placement, visibility
  const recs = task.nodes;
  const rec = new Map(), irRec = new Map();
  for (const t of recs) {
    if (!isObj(t) || !Number.isInteger(t.i)) throw argError("a task record has no index");
    const r = ir.nodes[t.i];
    if (!isObj(r) || r.guid !== t.guid || r.type !== t.type) throw argError("task record " + t.i + " is not the IR record of that index");
    rec.set(t.i, t);
    irRec.set(t.i, r);
  }
  const P = (i) => irRec.get(i).props || {};
  const exp = new Map(), rootOf = new Map();
  for (const t of recs) {
    if (rec.has(t.parent)) {
      if (!exp.has(t.parent)) throw argError("the task's records are not parent-first at " + t.i);
      exp.set(t.i, mul(exp.get(t.parent), M(P(t.i).relativeTransform)));
      rootOf.set(t.i, rootOf.get(t.parent));
    } else {
      exp.set(t.i, I());
      rootOf.set(t.i, t.i);
    }
  }
  const shownMemo = new Map();
  const shown = (i) => {
    if (shownMemo.has(i)) return shownMemo.get(i);
    const r = ir.nodes[i];
    const v = !!r && (r.props || {}).visible !== false && (!(r.parent >= 0) || shown(r.parent));
    shownMemo.set(i, v);
    return v;
  };

  // ---- rows and roots
  const row = new Map();
  for (const w of verify.rows) {
    if (!Array.isArray(w) || w.length !== ROW.length || !Number.isInteger(w[ROW.i])) throw argError("a verify row is " + ROW.length + " fields, the index first");
    if (!row.has(w[ROW.i])) row.set(w[ROW.i], w);
  }
  const found = new Map();
  for (const r of verify.roots) if (isObj(r)) found.set(r.i, r.found === true);
  const rootFound = (i) => found.get(rootOf.get(i)) === true;

  // ---- the codes each record carries: task notes, IR notes, the build's coded list
  const codesOf = new Map();
  const note = (i, code, detail) => {
    if (!codesOf.has(i)) codesOf.set(i, []);
    codesOf.get(i).push({ code, detail: detail === undefined ? null : detail });
  };
  for (const n of taskNotes) if (rec.has(n.i)) note(n.i, n.code, n.detail);
  for (const n of notesIR) if (isObj(n) && rec.has(n.node)) note(n.node, n.code, n.detail);
  const coded = B && Array.isArray(B.coded) ? B.coded.filter(isObj) : [];
  for (const c of coded) if (rec.has(c.i)) note(c.i, c.code, c.detail);
  const has = (i, code) => (codesOf.get(i) || []).some((c) => c.code === code);

  const J = emptyJ();
  for (const n of taskNotes) if (typeof n.code === "string") add(J.codes, n.code);
  if (B && isObj(B.codes)) for (const k of Object.keys(B.codes)) if (typeof B.codes[k] === "number" && isFinite(B.codes[k])) add(J.codes, k, B.codes[k]);
  const rootsAll = task.roots.map((r) => r.i);
  for (const i of rootsAll) if (found.get(i) !== true) add(J.codes, CODE.ROOT_NOT_FOUND);

  // ---- count
  const instances = recs.filter((t) => t.type === "INSTANCE").map((t) => t.i);
  const ex = task.expect || {};
  const exCount = typeof ex.count === "number" ? ex.count : recs.length;
  const exPh = typeof ex.placeholders === "number" ? ex.placeholders : instances.length;
  const exNon = typeof ex.nonInstance === "number" ? ex.nonInstance : recs.length - instances.length;
  J.count.expected = exCount;
  J.count.built = verify.count;
  J.count.placeholders = instances.filter((i) => row.has(i)).length;
  J.count.nonInstance = verify.count - J.count.placeholders;
  J.count.ok = verify.count === exCount && J.count.placeholders === exPh && J.count.nonInstance === exNon &&
    rootsAll.every((i) => found.get(i) === true);

  // ---- geometry
  const widened = new Set(B && Array.isArray(B.textWidened) ? B.textWidened : []);
  const widenBy = new Map();
  for (const i of widened) if (row.has(i) && irRec.has(i)) widenBy.set(i, Math.max(0, row.get(i)[ROW.w] - P(i).width));
  const widenUnderRoot = new Map();
  for (const [i, w] of widenBy) widenUnderRoot.set(rootOf.get(i), (widenUnderRoot.get(rootOf.get(i)) || 0) + w);
  const widenAtOrBelow = (i) => {
    let s = 0;
    for (const [t, w] of widenBy) for (let a = t; rec.has(a); a = rec.get(a).parent) if (a === i) { s += w; break; }
    return s;
  };
  const insideHalf = (i) => {
    for (let a = rec.get(i).parent; rec.has(a); a = rec.get(a).parent) {
      const p = P(a);
      if (!(p.layoutMode === "HORIZONTAL" || p.layoutMode === "VERTICAL") || p.strokeAlign !== "INSIDE" || p.strokesIncludedInLayout === true) continue;
      const strokes = p.strokes === undefined ? [] : value(p.strokes);
      const sw = p.strokeWeights;
      if (Array.isArray(strokes) && strokes.length && Array.isArray(sw) && sw.some((v) => v !== sw[0])) return true;
    }
    return false;
  };
  const G = J.geometry;
  const worst = [];
  for (const t of recs) {
    const w = row.get(t.i);
    if (!w) continue;
    const p = P(t.i);
    const box = boxOf(exp.get(t.i), p.width, p.height);
    const dx = w[ROW.absX] - box.x0, dy = w[ROW.absY] - box.y0, dw = w[ROW.w] - p.width, dh = w[ROW.h] - p.height;
    const dp = Math.hypot(dx, dy), ds = Math.max(Math.abs(dw), Math.abs(dh));
    const vis = shown(t.i);
    if (vis) G.visible++;
    if (dp <= HALF && ds <= HALF) {
      if (vis && ds > G.maxSizeVisible) G.maxSizeVisible = r2(ds);
      continue;
    }
    worst.push({ i: t.i, dx: r2(dx), dy: r2(dy), dw: r2(dw), dh: r2(dh), visible: vis });
    if (!vis) {
      if (dp > HALF) G.hiddenOver05++;
      if (ds > HALF) G.sizeHiddenOver05++;
      add(G.classified, "hidden");
      continue;
    }
    const classes = new Set();
    let posOk = dp <= HALF, sizeOk = ds <= HALF;
    if (!posOk) {
      const W = widenUnderRoot.get(rootOf.get(t.i)) || 0;
      if (W > 0 && Math.abs(dx) <= W + SIDE_TOL && Math.abs(dy) <= HALF) { posOk = true; classes.add("textWidened"); }
      else if (dp <= POS && insideHalf(t.i)) { posOk = true; classes.add("insideHalfPixel"); }
    }
    if (!sizeOk) {
      const W = widenAtOrBelow(t.i);
      if (W > 0 && dw >= -SIDE_TOL && dw <= W + SIDE_TOL && Math.abs(dh) <= HALF) { sizeOk = true; classes.add("textWidened"); }
    }
    for (const c of classes) add(G.classified, c);
    if (!posOk) {
      G.visibleOver05++;
      if (dp > POS) G.visibleOver1++;
    }
    if (ds > G.maxSizeVisible && !sizeOk) G.maxSizeVisible = r2(ds);
    if (!sizeOk) {
      G.sizeVisibleOver05++;
      if (ds > POS) G.sizeVisibleOver1++;
    }
  }
  worst.sort((a, b) => delta(b) - delta(a));
  G.worst = worst.slice(0, 30);

  // ---- sides
  const S = J.sides;
  const lost = new Set(Array.isArray(args.lostBorder) ? args.lostBorder : []);
  S.unproven = taskNotes.filter((n) => n.code === CODE.SIDE_RULE_UNPROVEN && rec.has(n.i)).length;
  for (const t of recs) {
    if (t.type === "INSTANCE") continue;
    const p = P(t.i);
    const inLost = lost.has(t.i);
    if (inLost) S.lostBorder.population++;
    const w = row.get(t.i);
    if (!w) continue;
    const strokes = p.strokes === undefined ? [] : value(p.strokes);
    const hasIR = Array.isArray(strokes) && strokes.length > 0, fig = w[ROW.sides];
    if (!hasIR && !fig) continue;
    S.checked++;
    const sw = typeof p.strokeWeight === "number" ? p.strokeWeight : 0;
    const irQ = hasIR ? (Array.isArray(p.strokeWeights) ? p.strokeWeights.slice() : [sw, sw, sw, sw]) : [0, 0, 0, 0];
    const figQ = fig ? fig.slice(0, 4) : [0, 0, 0, 0];
    let bad = false;
    if (irQ.some((v, k) => Math.abs(v - figQ[k]) > SIDE_TOL)) { S.mismatchIR.push({ i: t.i, ir: irQ, figma: figQ }); bad = true; }
    if (Array.isArray(p.oracleSides)) {
      S.checkedAgainstOracle++;
      if (p.oracleSides.some((d, k) => (figQ[k] > 0) !== (d === true))) { S.mismatchOracle.push({ i: t.i, oracle: p.oracleSides.slice(), figma: figQ }); bad = true; }
    }
    if (inLost && !bad && figQ.some((v) => v > 0)) S.lostBorder.ok++;
  }

  // ---- vectors
  const V = J.vectors;
  for (const t of recs) {
    if (VECTOR_TYPES.indexOf(t.type) < 0 || !rootFound(t.i)) continue;
    V.checked++;
    const p = P(t.i), w = row.get(t.i);
    const kinds = [];
    let regrouped = false, fig = [];
    if (!w) kinds.push("missing");
    else {
      const geo = p.oracleFillGeometry !== undefined ? value(p.oracleFillGeometry) : p.fillGeometry !== undefined ? value(p.fillGeometry) : [];
      const o = geometryBounds(geo, exp.get(t.i));
      fig = Array.isArray(w[ROW.vec]) ? w[ROW.vec] : [];
      if (o.length !== fig.length) {
        const so = o.reduce((s, e) => s + subpaths(e), 0), sf = fig.reduce((s, e) => s + subpaths(e), 0);
        const uo = unionOf(o), uf = unionOf(fig);
        if (so === sf && so > 0 && uo && uf && near(uo, uf)) regrouped = true;
        else kinds.push("count");
      } else {
        for (let k = 0; k < o.length; k++) {
          if (!near(boxOfEntry(o[k]), boxOfEntry(fig[k])) && kinds.indexOf("bounds") < 0) kinds.push("bounds");
          if (o[k][0] !== fig[k][0] && kinds.indexOf("winding") < 0) kinds.push("winding");
        }
      }
    }
    if (regrouped) { V.regrouped++; continue; }
    if (!kinds.length) { V.match++; continue; }
    // The kinds the record's VECTOR_ORACLE_DIFFERS classes cover.
    const covered = new Set();
    for (const n of codesOf.get(t.i) || []) {
      if (n.code !== CODE.VECTOR_ORACLE_DIFFERS || typeof n.detail !== "string") continue;
      const cls = n.detail.split(":")[0].trim();
      if (ORACLE_CLASSES.indexOf(cls) < 0) continue;
      if (cls === "region-no-fill") {
        const uf = unionOf(fig);
        if (uf && !inBox(uf, boxOf(exp.get(t.i), p.width, p.height), VEC_TOL + EPS)) continue;
      }
      covered.add(CLASS_KIND[cls]);
    }
    let excuse = null;
    if (kinds.indexOf("missing") < 0) {
      excuse = EXCUSE_ANY.find((c) => has(t.i, c)) || null;
      if (!excuse && kinds.every((k) => covered.has(k))) excuse = CODE.VECTOR_ORACLE_DIFFERS;
    }
    if (excuse) {
      add(V.excused, excuse);
      if (BUILT_FROM_ORACLE.indexOf(excuse) >= 0) add(V.excusedBuiltFromOracle, excuse);
    } else {
      V.differs.push({ i: t.i, kind: KIND_ORDER.find((k) => kinds.indexOf(k) >= 0 && !covered.has(k)) });
      add(J.codes, CODE.VECTOR_GEOMETRY_DIFFERS);
    }
  }

  // ---- text
  const T = J.text;
  for (const t of recs) {
    if (t.type !== "TEXT") continue;
    const p = P(t.i);
    if (typeof p.lines !== "number") { T.unknown++; continue; }
    const w = row.get(t.i);
    const m = w ? w[ROW.lines] : null;
    if (!isObj(m) || typeof m.lines !== "number") {
      if (rootFound(t.i)) T.unmeasured++;
      continue;
    }
    T.checked++;
    if (m.lines !== p.lines) {
      T.differ.push({ i: t.i, guid: String(t.guid), irLines: p.lines, figmaLines: m.lines, widened: widened.has(t.i),
        fontHeld: has(t.i, CODE.FONT_SUBSTITUTED), approx: m.approx === true });
      add(J.codes, CODE.TEXT_LINES_DIFFER);
    }
  }

  // ---- placeholders
  const PH = J.placeholders;
  const deferred = B && Array.isArray(B.coded) ? new Set(coded.filter((c) => c.code === CODE.INSTANCE_DEFERRED).map((c) => c.i)) : null;
  PH.expected = instances.length;
  for (const i of instances) {
    const w = row.get(i);
    if (w && w[ROW.builtType] === "FRAME" && w[ROW.childCount] === 0 && (deferred === null || deferred.has(i))) PH.aligned++;
    else PH.misaligned.push(i);
  }
  if (deferred) for (const i of deferred) if (!(rec.has(i) && rec.get(i).type === "INSTANCE") && Number.isInteger(i)) PH.misaligned.push(i);
  return J;
}

export function judgeRun(Js) {
  if (!Array.isArray(Js)) throw new TypeError("judgeRun: takes a list of J");
  Js.forEach((J, k) => {
    const probs = checkJShape(J);
    if (probs.length) throw new TypeError("judgeRun: J " + k + " is not of J_SHAPE: " + probs.slice(0, 3).join("; "));
  });
  const T = emptyTotals();
  T.tasks = Js.length;
  const merge = (to, from, shape, at) => {
    for (const k of Object.keys(shape)) {
      const s = shape[k], path = at ? at + "." + k : k;
      if (s === "n") to[k] = path === "geometry.maxSizeVisible" ? Math.max(to[k], from[k]) : to[k] + from[k];
      else if (s === "b") continue;
      else if (s === "[]") to[k] = to[k].concat(from[k]);
      else if (s === "{n}") { for (const c of Object.keys(from[k])) add(to[k], c, from[k][c]); }
      else merge(to[k], from[k], s, path);
    }
  };
  for (const J of Js) merge(T, J, J_SHAPE, "");
  T.count.ok = Js.length > 0 && Js.every((J) => J.count.ok === true);
  T.geometry.worst.sort((a, b) => delta(b) - delta(a));
  T.geometry.worst = T.geometry.worst.slice(0, 30);
  return T;
}

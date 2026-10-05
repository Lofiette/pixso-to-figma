// The judge: what the IR said against what VERIFY measured in Figma, per task and per run
// (docs/M1.md §8.3). Part C implements judgeTask and judgeRun; part P0 left them as stubs that
// throw, and froze the shapes below, which part D's verdict (m1Verdict, the gates of §8.1) and part
// F's end-to-end test read.
//
// CONTRACT (frozen by P0):
//
//   judgeTask({ ir, task, build, verify }) -> J
//     ir      the validated IR (tools/ir/validate.mjs), oracle props included
//     task    the build task (tools/ir/task.mjs) that was built and verified
//     build   the plugin's build report (docs/M1.md §6 B), or null when the build failed
//     verify  the plugin's verify report: { op: "verify", taskNo, roots: [{ i, id, found }], count, rows }
//             where each row is an array indexed by ROW below
//     returns J, of the shape J_SHAPE (every key present, nothing else), list items of J_ITEMS
//     throws  only on arguments that are not of these shapes (a programming error, not a finding)
//
//   judgeRun(Js) -> totals
//     returns TOTALS_SHAPE: J_SHAPE plus `tasks`, every number summed, every map merged by adding,
//     every list concatenated (geometry.worst re-sorted by its largest delta and cut to 30), and
//     count.ok true only when every task's count.ok is
//
//   emptyJ(), emptyTotals()   zeroed values of those shapes (no finding yet)
//   checkJShape(J, shape?)    -> [problem strings]; [] when J has exactly the shape (J_SHAPE by default)
//
// The vector outcome rules (which codes excuse what, `regrouped`, VECTOR_GEOMETRY_DIFFERS) are
// §8.3's; the excusing classes of VECTOR_ORACLE_DIFFERS are schema.ORACLE_CLASSES.

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

export const JUDGE_IMPLEMENTED = false;

export function judgeTask(args) {
  throw new Error("judgeTask: not in this build; part C implements tools/ir/judge.mjs (docs/M1.md §6 C, §8.3)");
}

export function judgeRun(Js) {
  throw new Error("judgeRun: not in this build; part C implements tools/ir/judge.mjs (docs/M1.md §6 C, §8.3)");
}

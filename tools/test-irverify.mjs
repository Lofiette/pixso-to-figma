// Part C's tests: pathgeom, the judge, VERIFY and countLines (docs/M1.md §6 C, §8.3).
//
//   node tools/test-irverify.mjs
//
// Offline and synthetic: hand-made IR records, hand-computed VERIFY rows, and scenes built in the
// headless double by direct figma.* calls (independent of part B's builder). Prints "ok   …" /
// "FAIL …" lines and exits 1 on any failure. countLines is checked twice: through part B's
// IR.writeTextProps on a toy text model defined here (its arithmetic and its scratch node), and
// through part B's writer on part E's text model (Figma's text as the double models it). Both printed
// "pending: B" / "pending: E" before those parts merged; part F made them plain checks.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./ir/schema.mjs";
import { validateTask } from "./ir/validate.mjs";
import { judgeTask, judgeRun, checkJShape, emptyJ, ROW, J_SHAPE, TOTALS_SHAPE, JUDGE_IMPLEMENTED } from "./ir/judge.mjs";
import { pathBounds, unionBounds, geometryBounds, inBox } from "./ir/pathgeom.mjs";
import { makeDouble } from "./double/index.mjs";
import { loadPluginBundle, defaultHost } from "./ir/plugin-vm.mjs";
import { IR_SRC_DIR } from "./build-plugin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why !== undefined ? " — " + String(why).slice(0, 400) : "")));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, e) => Math.abs(a - b) <= (e === undefined ? 1e-6 : e);
const boxIs = (b, x0, y0, x1, y1, e) => !!b && near(b.x0, x0, e) && near(b.y0, y0, e) && near(b.x1, x1, e) && near(b.y1, y1, e);
const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message || String(e); } };
const clone = (v) => JSON.parse(JSON.stringify(v));
const show = (v) => JSON.stringify(v);

// ============================================================================================
// 1. pathgeom: exact bounds of Figma path strings
// ============================================================================================
{
  // A circle of radius 10 drawn as four quarter cubics: the extrema sit on the end points.
  const k = 0.5522847498, c = 10, r = 10;
  const circle = ["M", c + r, c, "C", c + r, c + k * r, c + k * r, c + r, c, c + r, "C", c - k * r, c + r, c - r, c + k * r, c - r, c,
    "C", c - r, c - k * r, c - k * r, c - r, c, c - r, "C", c + k * r, c - r, c + r, c - k * r, c + r, c, "Z"].join(" ");
  check(boxIs(pathBounds(circle)[0], 0, 0, 20, 20, 1e-9), "a circle of four cubics is bounded by its radius", show(pathBounds(circle)));
  // An S cubic: y(t) = 30 t (1 - t)(2t - 1) peaks at +-30 sqrt(3) / 18 at t = (3 -+ sqrt(3)) / 6.
  const s = pathBounds("M 0 0 C 10 -10 20 10 30 0")[0], peak = 30 * Math.sqrt(3) / 18;
  check(boxIs(s, 0, -peak, 30, peak, 1e-9), "an S cubic's two interior extrema are found, not its control hull (y +-10)", show(s));
  check(boxIs(pathBounds("M 0 0 Q 10 10 0 20")[0], 0, 0, 5, 20, 1e-12), "a quadratic's interior x extremum (5, not the control point's 10)");
  check(boxIs(pathBounds("M 0 0 L 10 0 L 10 10 Z L 5 -5")[0], 0, -5, 10, 10), "after Z the pen is back at the subpath's start, and a following L grows the same box");
  check(boxIs(pathBounds("M -1e1 0 L 0 2.5e0 L +3 .5")[0], -10, 0, 3, 2.5), "signed, exponent and leading-dot numbers");
  const rot = pathBounds("M 0 0 C 0 10 10 10 10 0", [[0, -1, 0], [1, 0, 0]])[0];
  check(boxIs(rot, -7.5, 0, 0, 10, 1e-9), "a rotated cubic is bounded on the mapped curve (its bulge 7.5 lands on -x)", show(rot));
  const scaled = pathBounds("M 0 0 Q 5 10 10 0", [[2, 0, 1], [0, 3, -1]])[0];
  check(boxIs(scaled, 1, -1, 21, 14, 1e-9), "scale and translation", show(scaled));
  check(/^pathBounds: /.test(threw(() => pathBounds("M 0 0 H 10"))) && /^pathBounds: /.test(threw(() => pathBounds("M 0,0 L 1 1"))) &&
    /^pathBounds: /.test(threw(() => pathBounds("M 0 0 C 1 2 3"))) && /^pathBounds: /.test(threw(() => pathBounds(42))),
    "H, commas, a short C and a non-string are refused");
  const g = geometryBounds([{ windingRule: "EVENODD", data: "M 0 0 L 4 0 L 4 4 Z M 10 10 L 12 10 L 12 13 Z" }, { windingRule: "NONZERO", data: "" },
    { windingRule: "NONZERO", data: "M 1 1 Q 3 5 5 1 Z" }], [[1, 0, 100], [0, 1, 50]]);
  check(g.length === 3 && same(g[0], ["EVENODD", 100, 50, 112, 63, 2]) && same(g[1], ["NONZERO", 0, 0, 0, 0, 0]) &&
    g[2][0] === "NONZERO" && near(g[2][2], 51) && near(g[2][4], 53) && g[2][5] === 1,
    "geometryBounds gives one [winding, union box, subpaths] per path, keeps an empty path, applies the matrix", show(g));
  check(same(geometryBounds(null), []) && same(geometryBounds(undefined), []) && /^geometryBounds: /.test(threw(() => geometryBounds([{ data: 3 }]))) &&
    /^geometryBounds: /.test(threw(() => geometryBounds("M 0 0"))), "no geometry is no path; a malformed geometry throws");
  check(inBox({ x0: 0, y0: 0, x1: 10.9, y1: 5 }, { x0: 0, y0: 0, x1: 10, y1: 5 }, 1) && !inBox({ x0: -1.1, y0: 0, x1: 1, y1: 1 }, { x0: 0, y0: 0, x1: 10, y1: 5 }, 1),
    "inBox grows the outer box by the tolerance");
  const B = loadPluginBundle({ figma: makeDouble().figma });
  const bundled = B.PXF_PATHGEOM.geometryBounds([{ windingRule: "NONZERO", data: circle }, { windingRule: "EVENODD", data: "M 0 0 C 10 -10 20 10 30 0" }], [[0, 1, 3], [-1, 0, 7]]);
  check(same(bundled, geometryBounds([{ windingRule: "NONZERO", data: circle }, { windingRule: "EVENODD", data: "M 0 0 C 10 -10 20 10 30 0" }], [[0, 1, 3], [-1, 0, 7]])),
    "the plugin's bundled geometryBounds gives exactly the judge's numbers");
}

// ============================================================================================
// 2. the judge on synthetic rows
// ============================================================================================
check(JUDGE_IMPLEMENTED === true, "the judge says it is implemented (test-m1-contract.mjs then lets it run)");

const T6 = (x, y) => [1, 0, x, 0, 1, y];
const SOLID = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
const TRI = (x, y) => [{ windingRule: "NONZERO", data: "M " + x + " " + y + " L " + (x + 10) + " " + y + " L " + (x + 5) + " " + (y + 8) + " Z" }];
// values: 0 empty paints, 1 solid, 2 a triangle, 3 two squares, 4 Inter Regular, 5 a 30x20 rect
const VALUES = [[], SOLID, TRI(0, 0), [{ windingRule: "NONZERO", data: "M 0 0 L 4 0 L 4 4 L 0 4 Z" }, { windingRule: "NONZERO", data: "M 6 0 L 10 0 L 10 4 L 6 4 Z" }],
  { family: "Inter", style: "Regular" }, [{ windingRule: "NONZERO", data: "M 0 0 L 30 0 L 30 20 L 0 20 Z" }]];
const paint = (o) => Object.assign({ fills: 0, strokes: 0, strokeWeight: 1, strokeAlign: "INSIDE", blendMode: "PASS_THROUGH" }, o);
const frame = (o) => paint(Object.assign({ clipsContent: false, layoutMode: "NONE", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" }, o));
// The judge's scene: index, parent, type, props. The root sits at (100, 200) on its page, so every
// row below is root-relative: the root's own transform is the origin.
function irScene() {
  const n = [];
  const rec = (parent, type, props) => { n.push({ parent, guid: "5:" + (n.length + 1), type, name: type[0] + n.length, props }); return n.length - 1; };
  rec(-1, "FRAME", frame({ relativeTransform: T6(100, 200), width: 200, height: 120, strokes: 1, oracleSides: [true, true, true, true] }));       // 0
  rec(0, "RECTANGLE", paint({ relativeTransform: T6(10, 10), width: 20, height: 20, strokes: 1, strokeWeight: 2, strokeWeights: [2, 0, 2, 0],
    oracleSides: [true, false, true, false] }));                                                                                                  // 1
  rec(0, "VECTOR", paint({ relativeTransform: T6(40, 10), width: 10, height: 8, vectorNetwork: 5, oracleFillGeometry: 2 }));                     // 2 network-built
  rec(0, "VECTOR", paint({ relativeTransform: T6(40, 30), width: 10, height: 8, fillGeometry: 2 }));                                             // 3 geometry-built
  rec(0, "TEXT", paint({ relativeTransform: T6(60, 10), width: 50, height: 30, characters: "x", fontName: 4, fontSize: 12, textAutoResize: "NONE", lines: 2 })); // 4
  rec(0, "INSTANCE", { relativeTransform: T6(120, 10), width: 30, height: 30 });                                                                // 5
  rec(0, "FRAME", frame({ relativeTransform: T6(10, 50), width: 20, height: 20, visible: false }));                                              // 6 hidden
  rec(6, "RECTANGLE", paint({ relativeTransform: T6(2, 2), width: 5, height: 5 }));                                                            // 7 under the hidden one
  rec(0, "BOOLEAN_OPERATION", paint({ relativeTransform: T6(160, 10), width: 30, height: 20, booleanOperation: "UNION", oracleFillGeometry: 5 })); // 8
  rec(8, "RECTANGLE", paint({ relativeTransform: T6(0, 0), width: 30, height: 20 }));                                                         // 9 operand
  rec(0, "VECTOR", paint({ relativeTransform: T6(40, 50), width: 10, height: 8, vectorNetwork: 5, oracleFillGeometry: 2 }));                     // 10 network-bounds
  rec(0, "VECTOR", paint({ relativeTransform: T6(40, 70), width: 10, height: 8, vectorNetwork: 5 }));                                            // 11 region-no-fill (no oracle)
  rec(0, "VECTOR", paint({ relativeTransform: T6(40, 90), width: 10, height: 8, vectorNetwork: 5, oracleFillGeometry: 2 }));                     // 12 winding
  rec(0, "TEXT", paint({ relativeTransform: T6(60, 50), width: 50, height: 14, characters: "y", fontName: 4, fontSize: 12, textAutoResize: "NONE" })); // 13 no lines
  rec(0, "RECTANGLE", paint({ relativeTransform: [0, -1, 100, 1, 0, 60], width: 10, height: 4 }));                                              // 14 rotated 90°
  rec(0, "FRAME", frame({ relativeTransform: T6(130, 60), width: 60, height: 50, layoutMode: "VERTICAL", strokes: 1, strokeWeights: [1, 0, 0, 0] })); // 15 auto layout, one INSIDE side
  rec(15, "RECTANGLE", paint({ relativeTransform: T6(10, 1), width: 40, height: 20 }));                                                       // 16
  const notes = [{ code: schema.CODE.VECTOR_FROM_GEOMETRY, node: 3, detail: null }, { code: schema.CODE.VECTOR_ORACLE_DIFFERS, node: 10, detail: "network-bounds: synthetic" },
    { code: schema.CODE.VECTOR_ORACLE_DIFFERS, node: 11, detail: "region-no-fill" }, { code: schema.CODE.VECTOR_ORACLE_DIFFERS, node: 12, detail: "winding" },
    { code: schema.CODE.TEXT_LINES_UNKNOWN, node: 13, detail: null }];
  // vectorNetwork value 5 is a stand-in index: the judge reads a network only to place a VECTOR whose
  // box differs (vectorBox), and finds no network there, so it classifies nothing by it.
  return { nodes: n, values: clone(VALUES), notes };
}
function taskOf(ir) {
  return { op: "build", taskNo: 1, roots: [{ i: 0, attachTo: "page", place: null }],
    nodes: ir.nodes.map((r, i) => ({ i, parent: r.parent, guid: r.guid, type: r.type, name: r.name, props: r.props })),
    notes: ir.notes.map((n) => ({ code: n.code, i: n.node, detail: n.detail })),
    expect: { count: ir.nodes.length, nonInstance: ir.nodes.length - 1, placeholders: 1 } };
}
const V = (w, x0, y0, x1, y1, n) => [w, x0, y0, x1, y1, n === undefined ? 1 : n];
// What a faithful Figma build measures, worked out by hand (root-relative).
function rowsClean() {
  return [
    [0, "FRAME", 13, true, 0, 0, 200, 120, [1, 1, 1, 1], null, null],
    [1, "RECTANGLE", 0, true, 10, 10, 20, 20, [2, 0, 2, 0], null, null],
    [2, "VECTOR", 0, true, 40, 10, 10, 8, [1, 1, 1, 1], [V("NONZERO", 40, 10, 50, 18)], null],
    [3, "VECTOR", 0, true, 40, 30, 10, 8, [1, 1, 1, 1], [V("NONZERO", 40, 30, 50, 38)], null],
    [4, "TEXT", 0, true, 60, 10, 50, 30, [1, 1, 1, 1], null, { lines: 2, approx: false }],
    [5, "FRAME", 0, true, 120, 10, 30, 30, null, null, null],
    [6, "FRAME", 1, false, 10, 50, 20, 20, [1, 1, 1, 1], null, null],
    [7, "RECTANGLE", 0, false, 12, 52, 5, 5, [1, 1, 1, 1], null, null],
    [8, "BOOLEAN_OPERATION", 1, true, 160, 10, 30, 20, [1, 1, 1, 1], [V("NONZERO", 160, 10, 190, 30)], null],
    [9, "RECTANGLE", 0, true, 160, 10, 30, 20, [1, 1, 1, 1], null, null],
    [10, "VECTOR", 0, true, 40, 50, 10, 8, [1, 1, 1, 1], [V("NONZERO", 40, 50, 50, 58)], null],
    [11, "VECTOR", 0, true, 40, 70, 10, 8, [1, 1, 1, 1], [V("NONZERO", 40, 70, 50, 78)], null],
    [12, "VECTOR", 0, true, 40, 90, 10, 8, [1, 1, 1, 1], [V("NONZERO", 40, 90, 50, 98)], null],
    [13, "TEXT", 0, true, 60, 50, 50, 14, [1, 1, 1, 1], null, null],
    [14, "RECTANGLE", 0, true, 96, 60, 10, 4, [1, 1, 1, 1], null, null],
    [15, "FRAME", 1, true, 130, 60, 60, 50, [1, 0, 0, 0], null, null],
    [16, "RECTANGLE", 0, true, 140, 61, 40, 20, [1, 1, 1, 1], null, null],
  ];
}
// Strokes: every paint above has strokes 0 (empty) except 0, 1 and 15, so a faithful Figma has no
// sides on the others; rowsClean gives them sides to be set to null below.
function scene() {
  const ir = irScene();
  const rows = rowsClean().map((w) => { const p = ir.nodes[w[0]].props; if (p.strokes !== 1) w[ROW.sides] = null; return w; });
  const coded = [{ code: schema.CODE.INSTANCE_DEFERRED, i: 5, detail: null }];
  return { ir, task: taskOf(ir), build: { op: "build", codes: { INSTANCE_DEFERRED: 1 }, coded, failures: [], textWidened: [], textPinned: [] },
    verify: { op: "verify", taskNo: 1, roots: [{ i: 0, id: "9:1", found: true }], count: rows.length, rows } };
}
const rowOf = (s, i) => s.verify.rows.find((w) => w[0] === i);
const judge = (s) => {
  const J = judgeTask(s);
  const probs = checkJShape(J);
  if (probs.length) fail("J shape: " + probs.slice(0, 3).join("; "));
  const v = J.vectors, excused = Object.values(v.excused).reduce((a, b) => a + b, 0);
  if (v.checked !== v.match + v.regrouped + v.unfilled + excused + v.differs.length) fail("vectors.checked is not match + regrouped + unfilled + excused + differs: " + show(v));
  return J;
};
const sumMap = (m) => Object.values(m).reduce((a, b) => a + b, 0);

{
  const J = judge(scene());
  check(checkJShape(J).length === 0, "a judged J has exactly J_SHAPE");
  check(same(J.count, { expected: 17, built: 17, nonInstance: 16, placeholders: 1, ok: true }), "a faithful build: the count is right", show(J.count));
  check(J.geometry.visible === 15 && J.geometry.visibleOver05 === 0 && J.geometry.visibleOver1 === 0 && J.geometry.sizeVisibleOver05 === 0 &&
    J.geometry.hiddenOver05 === 0 && J.geometry.worst.length === 0 && sumMap(J.geometry.classified) === 0,
    "a faithful build: no geometry finding (the rotated child's min corner and the root's page offset included)", show(J.geometry));
  check(J.sides.checked === 3 && J.sides.checkedAgainstOracle === 2 && J.sides.mismatchIR.length === 0 && J.sides.mismatchOracle.length === 0,
    "a faithful build: sides equal the IR and the oracle", show(J.sides));
  check(J.vectors.checked === 6 && J.vectors.match === 5 && same(J.vectors.excused, { VECTOR_ORACLE_DIFFERS: 1 }) && J.vectors.differs.length === 0,
    "a faithful build: 5 vectors match; the region-no-fill one (oracle 0 paths, Figma 1 inside its box) is excused by its class", show(J.vectors));
  check(J.text.checked === 1 && J.text.unknown === 1 && J.text.differ.length === 0 && J.text.unmeasured === 0, "a faithful build: one text checked, one with no lines unknown");
  check(same(J.placeholders, { expected: 1, aligned: 1, misaligned: [] }), "a faithful build: the placeholder is aligned");
  check(J.codes.INSTANCE_DEFERRED === 1 && J.codes.VECTOR_FROM_GEOMETRY === 1 && J.codes.VECTOR_ORACLE_DIFFERS === 3 && J.codes.TEXT_LINES_UNKNOWN === 1 &&
    !J.codes.VECTOR_GEOMETRY_DIFFERS && !J.codes.ROOT_NOT_FOUND, "codes join the task's notes and the build's codes", show(J.codes));
}
{
  const s = scene(); rowOf(s, 1)[ROW.absX] += 1.2;
  const J = judge(s);
  check(J.geometry.visibleOver1 === 1 && J.geometry.visibleOver05 === 1 && J.geometry.worst[0].i === 1 && J.geometry.worst[0].dx === 1.2 && J.geometry.worst[0].visible === true,
    "a 1.2 px offset is a visible position finding over 1 px (G6), listed in worst", show(J.geometry));
}
{
  const s = scene(); rowOf(s, 1)[ROW.absY] -= 0.7;
  const J = judge(s);
  check(J.geometry.visibleOver05 === 1 && J.geometry.visibleOver1 === 0, "a 0.7 px offset is in the 0.5-1 px band only", show(J.geometry));
}
{
  const s = scene(); rowOf(s, 14)[ROW.absX] = 100;     // the rotated child measured at its unrotated corner
  const J = judge(s);
  check(J.geometry.visibleOver1 === 1 && J.geometry.worst[0].i === 14, "a rotated child is placed by its rotated box's min corner (4 px off when read unrotated)", show(J.geometry.worst));
}
{
  const s = scene(); rowOf(s, 1)[ROW.w] += 1.2;
  const J = judge(s);
  check(J.geometry.sizeVisibleOver1 === 1 && J.geometry.sizeVisibleOver05 === 1 && J.geometry.maxSizeVisible === 1.2 && J.geometry.visibleOver05 === 0,
    "a 1.2 px size error is a visible size finding over 1 px (G7)", show(J.geometry));
}
{
  const s = scene(); rowOf(s, 7)[ROW.absX] += 3; rowOf(s, 7)[ROW.h] += 2;
  const J = judge(s);
  check(J.geometry.hiddenOver05 === 1 && J.geometry.sizeHiddenOver05 === 1 && J.geometry.visibleOver1 === 0 && J.geometry.sizeVisibleOver1 === 0 &&
    J.geometry.classified.hidden === 1 && J.geometry.worst[0].visible === false,
    "an offset and a size error under a hidden IR ancestor are left out of the visible counts, by the IR's visibility", show(J.geometry));
}
{
  const s = scene(); rowOf(s, 16)[ROW.absY] += 0.7;
  let J = judge(s);
  check(J.geometry.visibleOver05 === 0 && J.geometry.classified.insideHalfPixel === 1,
    "a half-pixel shift under an auto-layout frame with one INSIDE side is classified, not counted", show(J.geometry));
  const s2 = scene(); rowOf(s2, 16)[ROW.absY] += 1.2;
  J = judge(s2);
  check(J.geometry.visibleOver1 === 1 && !J.geometry.classified.insideHalfPixel, "over 1 px the INSIDE band does not explain it");
  const s3 = scene(); rowOf(s3, 1)[ROW.absY] += 0.7;
  J = judge(s3);
  check(J.geometry.visibleOver05 === 1 && !J.geometry.classified.insideHalfPixel, "nor does it explain a half pixel outside such a frame");
}
// A widened text in a scene whose root is a horizontal flow (the widening as the build codes it).
const widenScene = (by) => {
  const s = scene();
  s.ir.nodes[0].props.layoutMode = "HORIZONTAL";
  s.build.textWidened = [4];
  s.build.coded.push({ code: schema.CODE.TEXT_WIDENED_TO_SOURCE_LINES, i: 4, detail: "widened by " + by + " px, 2 -> 1 lines, moved " + by + " px" });
  return s;
};
{
  const s = widenScene(6);
  rowOf(s, 4)[ROW.w] += 6; rowOf(s, 4)[ROW.absX] -= 6;      // a RIGHT-aligned text widened by 6 px
  rowOf(s, 5)[ROW.absX] += 6;                                 // a flow sibling pushed by it
  rowOf(s, 0)[ROW.w] += 6;                                    // its ancestor grew by it
  let J = judge(s);
  check(J.geometry.visibleOver05 === 0 && J.geometry.sizeVisibleOver05 === 0 && J.geometry.classified.textWidened === 3,
    "decision 9: the widened text, its pushed sibling and its grown ancestor are classified, not counted", show(J.geometry));
  rowOf(s, 5)[ROW.absX] += 2;                                 // 8 px: more than the widening
  J = judge(s);
  check(J.geometry.visibleOver1 === 1 && J.geometry.classified.textWidened === 2, "a shift larger than the widening is a finding again", show(J.geometry));
  const s2 = scene(); rowOf(s2, 5)[ROW.absX] += 6;
  J = judge(s2);
  check(J.geometry.visibleOver1 === 1 && !J.geometry.classified.textWidened, "without a widened text the same shift is a finding");
}
{
  // Review F1/S2: the excuse reaches only what a widening can push through a flow.
  const s = scene();     // the root is not a flow: nothing is pushed
  s.build.textWidened = [4];
  s.build.coded.push({ code: schema.CODE.TEXT_WIDENED_TO_SOURCE_LINES, i: 4, detail: "widened by 40 px, 2 -> 1 lines" });
  rowOf(s, 4)[ROW.w] += 40;
  rowOf(s, 1)[ROW.absX] += 30;                                // an unrelated rectangle 30 px off
  let J = judge(s);
  check(J.geometry.visibleOver1 === 1 && J.geometry.worst.some((w) => w.i === 1 && w.dx === 30) && J.geometry.classified.textWidened === 1,
    "a node no flow links to a widened text is not excused by the widening (a rectangle 30 px off beside a text widened 40 px)", show(J.geometry));
  const s2 = widenScene(200);
  s2.ir.nodes[15].props.layoutMode = "NONE";
  rowOf(s2, 4)[ROW.w] += 200;
  rowOf(s2, 16)[ROW.absX] -= 180;                             // in a sibling frame of no flow of its own, moved left
  J = judge(s2);
  check(J.geometry.visibleOver1 === 0 && J.geometry.classified.textWidened === 2,
    "inside a flow sibling's subtree a push is excused in either direction (CENTER alignment moves earlier siblings too)", show(J.geometry));
  const s3 = widenScene(6);
  rowOf(s3, 4)[ROW.w] += 9; rowOf(s3, 0)[ROW.w] += 9;         // Figma's text 3 px wider than the build's widening
  J = judge(s3);
  check(J.geometry.sizeVisibleOver1 === 2, "a text grown past the widening the build coded is a size finding, and so is its parent", show(J.geometry));
  const s4 = widenScene(6);
  s4.build.coded = s4.build.coded.filter((c) => c.code !== schema.CODE.TEXT_WIDENED_TO_SOURCE_LINES);
  rowOf(s4, 4)[ROW.w] += 6;
  check(judge(s4).geometry.sizeVisibleOver1 === 1, "a widening the build did not code excuses nothing");
}
{
  const s = scene(); rowOf(s, 1)[ROW.sides] = [2, 0, 2, 1];
  const J = judge(s);
  check(J.sides.mismatchIR.length === 1 && same(J.sides.mismatchIR[0], { i: 1, ir: [2, 0, 2, 0], figma: [2, 0, 2, 1] }) && J.sides.mismatchOracle.length === 1 &&
    same(J.sides.mismatchOracle[0].oracle, [true, false, true, false]), "a side Figma draws and neither the IR nor the oracle has: a mismatch against both (G8)", show(J.sides));
}
{
  const s = scene(); s.ir.nodes[1].props.oracleSides = [true, true, true, false];
  const J = judge(s);
  check(J.sides.mismatchIR.length === 0 && J.sides.mismatchOracle.length === 1 && same(J.sides.mismatchOracle[0], { i: 1, oracle: [true, true, true, false], figma: [2, 0, 2, 0] }),
    "Figma equal to the IR but not to the oracle: a mismatch against the oracle only", show(J.sides));
}
{
  const s = scene(); rowOf(s, 1)[ROW.sides] = [2, 0, 2.005, 0]; rowOf(s, 0)[ROW.sides] = null;
  const J = judge(s);
  check(J.sides.mismatchIR.length === 1 && J.sides.mismatchIR[0].i === 0 && same(J.sides.mismatchIR[0].figma, [0, 0, 0, 0]) && J.sides.mismatchOracle.length === 1,
    "a stroke Figma lost is a mismatch (zeros), and 0.005 px is within the 0.01 tolerance", show(J.sides));
  const s2 = scene(); rowOf(s2, 9)[ROW.sides] = [1, 1, 1, 1];
  check(judge(s2).sides.mismatchIR.length === 1, "a stroke Figma drew where the IR has none is a mismatch");
}
{
  const s = scene();
  let J = judgeTask(Object.assign({}, s, { lostBorder: [0, 1, 5] }));
  check(same(J.sides.lostBorder, { population: 2, ok: 2 }), "lostBorder: the population in the task (placeholders apart) and the ones Figma draws", show(J.sides.lostBorder));
  rowOf(s, 1)[ROW.sides] = null;
  J = judgeTask(Object.assign({}, s, { lostBorder: [0, 1] }));
  check(same(J.sides.lostBorder, { population: 2, ok: 1 }), "a lost border Figma did not draw is not ok");
  check(same(judgeTask(scene()).sides.lostBorder, { population: 0, ok: 0 }), "without part A's population there is none");
}
{
  const s = scene(); s.task.notes.push({ code: schema.CODE.SIDE_RULE_UNPROVEN, i: 1, detail: "rule 1111, path 1010" });
  check(judge(s).sides.unproven === 1, "SIDE_RULE_UNPROVEN notes are counted");
}
// vectors
{
  const s = scene(); rowOf(s, 2)[ROW.vec] = [V("NONZERO", 42, 10, 52, 18)];
  const J = judge(s);
  check(same(J.vectors.differs, [{ i: 2, kind: "bounds" }]) && J.codes.VECTOR_GEOMETRY_DIFFERS === 1 && J.vectors.match === 4,
    "an unexcused vector 2 px off is VECTOR_GEOMETRY_DIFFERS (G9)", show(J.vectors));
  const s2 = scene(); rowOf(s2, 2)[ROW.vec] = [V("EVENODD", 40, 10, 50, 18)];
  check(same(judge(s2).vectors.differs, [{ i: 2, kind: "winding" }]), "an unexcused winding difference");
  const sb = scene(); rowOf(sb, 8)[ROW.vec] = [V("EVENODD", 160, 10, 190, 30)];
  const Jb = judge(sb);
  check(Jb.vectors.differs.length === 0 && Jb.vectors.match === 5,
    "a native boolean's winding label is Figma's own (P19B: NONZERO for every operation), so only its count and bounds are judged", show(Jb.vectors));
  const sb2 = scene(); rowOf(sb2, 8)[ROW.vec] = [V("NONZERO", 162, 10, 190, 30)];
  check(same(judge(sb2).vectors.differs, [{ i: 8, kind: "bounds" }]), "a native boolean 2 px off still differs");
  const su = scene(); su.ir.nodes[2].props.fills = 0; su.ir.nodes[2].props.oracleFillGeometry = 0; rowOf(su, 2)[ROW.vec] = [V("NONZERO", 40, 10, 50, 18)];
  const Ju = judge(su);
  check(Ju.vectors.unfilled === 1 && Ju.vectors.differs.length === 0, "a vector with no visible fill, no oracle path and Figma fill geometry is unfilled, not a defect (P19B regionlessFill)", show(Ju.vectors));
  const su2 = scene(); su2.ir.nodes[2].props.fills = 1; su2.ir.nodes[2].props.oracleFillGeometry = 0; rowOf(su2, 2)[ROW.vec] = [V("NONZERO", 40, 10, 50, 18)];
  check(same(judge(su2).vectors.differs, [{ i: 2, kind: "count" }]), "the same with a visible fill is still a count difference");
  const sh = scene(); sh.ir.nodes[2].props.visible = false; rowOf(sh, 2)[ROW.effVisible] = false; rowOf(sh, 2)[ROW.vec] = [V("NONZERO", 50, 7, 60, 15)];
  const Jh = judge(sh);
  check(Jh.vectors.differs.length === 0 && Jh.vectors.match === 5,
    "a hidden vector whose drawing sits 10 px away keeps its shape: its placement is the geometry's hidden count, not a vector difference", show(Jh.vectors));
  const sh2 = scene(); sh2.ir.nodes[2].props.visible = false; rowOf(sh2, 2)[ROW.effVisible] = false; rowOf(sh2, 2)[ROW.vec] = [V("NONZERO", 50, 7, 62, 15)];
  check(same(judge(sh2).vectors.differs, [{ i: 2, kind: "bounds" }]), "a hidden vector 2 px wider still differs");
  const s3 = scene(); rowOf(s3, 2)[ROW.vec] = [];
  check(same(judge(s3).vectors.differs, [{ i: 2, kind: "count" }]), "a vector with no paths where the oracle has one");
  const s4 = scene(); rowOf(s4, 2)[ROW.vec] = [V("NONZERO", 40.9, 9.1, 50.9, 18.9)];
  check(judge(s4).vectors.differs.length === 0, "within 1 px per coordinate is a match");
}
{
  const s = scene(); s.ir.nodes[2].props.oracleFillGeometry = 3; rowOf(s, 2)[ROW.vec] = [V("NONZERO", 40, 10, 50, 14, 2)];
  let J = judge(s);
  check(J.vectors.regrouped === 1 && J.vectors.differs.length === 0, "two oracle paths drawn as one path of two subpaths with the same union: regrouped, not a defect", show(J.vectors));
  rowOf(s, 2)[ROW.vec] = [V("NONZERO", 40, 10, 52, 14, 2)];
  J = judge(s);
  check(J.vectors.regrouped === 0 && same(J.vectors.differs, [{ i: 2, kind: "count" }]), "the same with a union 2 px wider is not regrouped");
  rowOf(s, 2)[ROW.vec] = [V("NONZERO", 40, 10, 50, 14, 1)];
  check(same(judge(s).vectors.differs, [{ i: 2, kind: "count" }]), "nor with fewer subpaths");
}
{
  const s = scene(); rowOf(s, 10)[ROW.vec] = [V("NONZERO", 43, 50, 53, 58)];
  let J = judge(s);
  check(J.vectors.differs.length === 0 && J.vectors.excused.VECTOR_ORACLE_DIFFERS === 2, "network-bounds excuses the bounds", show(J.vectors));
  rowOf(s, 10)[ROW.vec] = [V("NONZERO", 43, 50, 53, 58), V("NONZERO", 43, 50, 53, 58)];
  J = judge(s);
  check(same(J.vectors.differs, [{ i: 10, kind: "count" }]), "network-bounds does not excuse the count");
  rowOf(s, 10)[ROW.vec] = [V("EVENODD", 43, 50, 53, 58)];
  check(same(judge(s).vectors.differs, [{ i: 10, kind: "winding" }]), "nor a winding difference next to the bounds one");
}
{
  const s = scene(); rowOf(s, 12)[ROW.vec] = [V("EVENODD", 40, 90, 50, 98)];
  let J = judge(s);
  check(J.vectors.differs.length === 0 && J.vectors.excused.VECTOR_ORACLE_DIFFERS === 2, "winding excuses the winding");
  rowOf(s, 12)[ROW.vec] = [V("NONZERO", 44, 90, 54, 98)];
  check(same(judge(s).vectors.differs, [{ i: 12, kind: "bounds" }]), "winding does not excuse the bounds");
}
{
  const s = scene(); rowOf(s, 11)[ROW.vec] = [V("NONZERO", 40, 70, 50, 78), V("NONZERO", 40.5, 70.5, 50.9, 78.9)];
  let J = judge(s);
  check(J.vectors.differs.length === 0 && J.vectors.excused.VECTOR_ORACLE_DIFFERS === 1, "region-no-fill excuses the count while the paths stay in the box + 1 px");
  rowOf(s, 11)[ROW.vec] = [V("NONZERO", 40, 70, 52, 78)];
  J = judge(s);
  check(same(J.vectors.differs, [{ i: 11, kind: "count" }]) && !J.vectors.excused.VECTOR_ORACLE_DIFFERS, "region-no-fill does not excuse paths drawn 2 px outside the box", show(J.vectors));
}
{
  const s = scene(); s.task.notes = s.task.notes.filter((n) => n.i !== 10); s.ir.notes = s.ir.notes.filter((n) => n.node !== 10);
  rowOf(s, 10)[ROW.vec] = [V("NONZERO", 43, 50, 53, 58)];
  check(same(judge(s).vectors.differs, [{ i: 10, kind: "bounds" }]), "the same vector without its note is a defect: only a code set before VERIFY excuses");
  const s2 = scene(); s2.task.notes.push({ code: schema.CODE.VECTOR_ORACLE_DIFFERS, i: 2, detail: "unregistered: synthetic" }); rowOf(s2, 2)[ROW.vec] = [V("NONZERO", 43, 10, 53, 18)];
  check(same(judge(s2).vectors.differs, [{ i: 2, kind: "bounds" }]), "a VECTOR_ORACLE_DIFFERS detail naming no registered class excuses nothing");
  const s3 = scene(); s3.task.notes.push({ code: schema.CODE.VECTOR_GEOMETRY_DIFFERS, i: 2, detail: null }); rowOf(s3, 2)[ROW.vec] = [V("NONZERO", 43, 10, 53, 18)];
  check(same(judge(s3).vectors.differs, [{ i: 2, kind: "bounds" }]), "VECTOR_GEOMETRY_DIFFERS itself excuses nothing");
}
{
  // Review F3: SOURCE_FEATURE_UNSUPPORTED excuses a vector only for a feature that changes its drawing.
  const s = scene(); s.task.notes.push({ code: schema.CODE.SOURCE_FEATURE_UNSUPPORTED, i: 2, detail: "dashCap" });
  rowOf(s, 2)[ROW.vec] = [V("EVENODD", 40, 10, 100, 70), V("EVENODD", 40, 10, 60, 30)];
  let J = judge(s);
  check(same(J.vectors.differs, [{ i: 2, kind: "count" }]) && !J.vectors.excused.SOURCE_FEATURE_UNSUPPORTED,
    "a dash-cap note does not excuse a vector drawn wrong (G9)", show(J.vectors));
  s.task.notes.push({ code: schema.CODE.SOURCE_FEATURE_UNSUPPORTED, i: 2, detail: "RIGHT_ANGLE: 2 vertices" });
  J = judge(s);
  check(J.vectors.differs.length === 0 && J.vectors.excused.SOURCE_FEATURE_UNSUPPORTED === 1, "a RIGHT_ANGLE note (a feature of the drawing) does", show(J.vectors));
  const s2 = scene(); s2.task.notes.push({ code: schema.CODE.SOURCE_FEATURE_UNSUPPORTED, i: 2, detail: "no stored geometry: a STAR built natively, its paths unchecked" });
  rowOf(s2, 2)[ROW.vec] = [V("NONZERO", 40, 10, 50, 18), V("NONZERO", 40, 10, 50, 18)];
  check(judge(s2).vectors.excused.SOURCE_FEATURE_UNSUPPORTED === 1, "so does a native shape with no stored geometry (review S3)");
}
{
  const s = scene(); rowOf(s, 3)[ROW.vec] = [V("NONZERO", 45, 30, 55, 38)];
  const J = judge(s);
  check(J.vectors.differs.length === 0 && J.vectors.excused.VECTOR_FROM_GEOMETRY === 1 && same(J.vectors.excusedBuiltFromOracle, { VECTOR_FROM_GEOMETRY: 1 }),
    "a geometry-built vector that does not match is excused under its code and listed for review in excusedBuiltFromOracle", show(J.vectors));
  const s2 = scene(); rowOf(s2, 2)[ROW.vec] = []; s2.build.coded.push({ code: schema.CODE.VECTOR_NETWORK_REFUSED, i: 2, detail: "synthetic" });
  const J2 = judge(s2);
  check(J2.vectors.excused.VECTOR_NETWORK_REFUSED === 1 && J2.vectors.differs.length === 0 && sumMap(J2.vectors.excusedBuiltFromOracle) === 0,
    "a refused network (build-stage, from the build report) is excused", show(J2.vectors));
  const s3 = scene(); rowOf(s3, 8)[ROW.vec] = [V("NONZERO", 160, 10, 175, 30)]; s3.build.coded.push({ code: schema.CODE.BOOLEAN_FALLBACK, i: 8, detail: null });
  check(judge(s3).vectors.excused.BOOLEAN_FALLBACK === 1, "a boolean fallback is excused");
  const s4 = scene(); rowOf(s4, 8)[ROW.vec] = [V("NONZERO", 160, 10, 175, 30)];
  check(same(judge(s4).vectors.differs, [{ i: 8, kind: "bounds" }]), "a native boolean is held to its stored result");
  const s5 = scene(); s5.task.notes.push({ code: schema.CODE.BOOLEAN_FLATTENED, i: 3, detail: "UNION, 2 folded" }); rowOf(s5, 3)[ROW.vec] = [];
  const J5 = judge(s5);
  check(J5.vectors.excused.BOOLEAN_FLATTENED === 1 && J5.vectors.excusedBuiltFromOracle.BOOLEAN_FLATTENED === 1 && !J5.vectors.excused.VECTOR_FROM_GEOMETRY,
    "one excuse per vector, the first that applies (BOOLEAN_FLATTENED before VECTOR_FROM_GEOMETRY)", show(J5.vectors));
}
{
  const s = scene(); s.verify.rows = s.verify.rows.filter((w) => w[0] !== 2); s.verify.count--;
  s.task.notes.push({ code: schema.CODE.SOURCE_FEATURE_UNSUPPORTED, i: 2, detail: "RIGHT_ANGLE" });
  const J = judge(s);
  check(same(J.vectors.differs, [{ i: 2, kind: "missing" }]) && J.count.ok === false, "a vector with no row under a found root is missing, which no code excuses", show(J.vectors));
}
// text
{
  const s = scene(); rowOf(s, 4)[ROW.lines] = { lines: 3, approx: false };
  let J = judge(s);
  check(same(J.text.differ, [{ i: 4, guid: "5:5", irLines: 2, figmaLines: 3, widened: false, fontHeld: false, approx: false }]) && J.codes.TEXT_LINES_DIFFER === 1,
    "a text difference is named by guid with both counts (G10)", show(J.text));
  s.build.coded.push({ code: schema.CODE.FONT_SUBSTITUTED, i: 4, detail: "Inter Regular" });
  J = judge(s);
  check(J.text.differ[0].fontHeld === true, "a font-held text is marked");
  rowOf(s, 4)[ROW.lines] = { lines: 1, approx: true };
  J = judge(s);
  check(J.text.differ[0].approx === true && J.text.differ[0].figmaLines === 1, "an approximate count is marked");
  rowOf(s, 4)[ROW.lines] = null;
  J = judge(s);
  check(J.text.unmeasured === 1 && J.text.checked === 0, "a text with lines and no measurement is unmeasured");
  const s2 = scene(); s2.build.textWidened = [4]; rowOf(s2, 4)[ROW.lines] = { lines: 1, approx: false };
  check(judge(s2).text.differ[0].widened === true, "a widened text is marked");
}
// placeholders, count, roots
{
  const s = scene(); rowOf(s, 5)[ROW.childCount] = 1; s.verify.count++;
  let J = judge(s);
  check(same(J.placeholders.misaligned, [5]) && J.placeholders.aligned === 0 && J.count.ok === false && J.count.nonInstance === 17,
    "a placeholder with a child is misaligned (G11), and the extra node breaks the count (G3)", show({ p: J.placeholders, c: J.count }));
  const s2 = scene(); s2.build.coded = [];
  check(same(judge(s2).placeholders.misaligned, [5]), "a placeholder the build did not code INSTANCE_DEFERRED is misaligned");
  const s3 = scene(); s3.build.coded.push({ code: schema.CODE.INSTANCE_DEFERRED, i: 6, detail: null });
  check(same(judge(s3).placeholders.misaligned, [6]), "an INSTANCE_DEFERRED on a record that is not an INSTANCE is listed");
  const s4 = scene(); rowOf(s4, 5)[ROW.builtType] = "RECTANGLE";
  check(same(judge(s4).placeholders.misaligned, [5]), "a placeholder built as anything but a FRAME is misaligned");
  const s5 = scene(); s5.build = null;
  check(judge(s5).placeholders.aligned === 1, "with no build report the alignment stands on the rows alone");
}
{
  // Review F2: totals that agree do not make the count right.
  const s = scene(); s.verify.rows = s.verify.rows.filter((w) => w[0] !== 1);   // record 1 has no row; the count still says 17
  let J = judge(s);
  check(J.count.ok === false && J.count.built === J.count.expected && J.sides.checked === 2,
    "a record with no row under a found root fails the count though the totals agree (and is not judged anywhere else)", show(J.count));
  const s2 = scene(); rowOf(s2, 6)[ROW.childCount] = 2;
  check(judge(s2).count.ok === false, "a row with more children than its record has fails the count");
  const s3 = scene(); rowOf(s3, 1)[ROW.builtType] = "FRAME";
  check(judge(s3).count.ok === false, "a row of another built type fails the count");
  s3.build.failures.push({ i: 1, prop: "type", msg: "built as a FRAME" });
  check(judge(s3).count.ok === true, "a FRAME where the build coded its type fallback is the record's row");
}
{
  const s = scene(); s.verify.roots = [{ i: 0, id: null, found: false }]; s.verify.rows = []; s.verify.count = 0;
  const J = judge(s);
  check(J.count.ok === false && J.count.built === 0 && J.codes.ROOT_NOT_FOUND === 1 && J.vectors.checked === 0 && J.text.unmeasured === 0 &&
    same(J.placeholders.misaligned, [5]), "a missing root: ROOT_NOT_FOUND, the count fails, and its vectors and texts are not counted twice", show(J));
  const s2 = scene(); s2.verify.roots = [];
  check(judge(s2).codes.ROOT_NOT_FOUND === 1 && judge(s2).count.ok === false, "a root VERIFY did not report is not found either");
}
{
  // A split root: the task's root is record 6's child 7 only; its parent was built by another task.
  const s = scene();
  s.task.nodes = s.task.nodes.filter((t) => t.i === 7);
  s.task.roots = [{ i: 7, attachTo: { i: 6, guid: "5:7" }, place: null }];
  s.task.notes = []; s.task.expect = { count: 1, nonInstance: 1, placeholders: 0 };
  s.verify = { op: "verify", taskNo: 2, roots: [{ i: 7, id: "9:7", found: true, inParent: [2, 2] }], count: 1, rows: [[7, "RECTANGLE", 0, false, 0, 0, 5, 5, null, null, null]] };
  s.build = { op: "build", codes: {}, coded: [], failures: [], textWidened: [] };
  const J = judge(s);
  check(J.count.ok && J.geometry.hiddenOver05 === 0 && J.geometry.visible === 0 && J.geometry.worst.length === 0,
    "a split root is its own origin, and it is hidden because an IR ancestor outside the task is", show(J.geometry));
  // Review S1: a split root's place in its parent is held to its IR relativeTransform.
  const v = scene();
  v.task.nodes = v.task.nodes.filter((t) => t.i === 16);
  v.task.roots = [{ i: 16, attachTo: { i: 15, guid: "5:16" }, place: null }];
  v.task.notes = []; v.task.expect = { count: 1, nonInstance: 1, placeholders: 0 };
  v.build = { op: "build", codes: {}, coded: [], failures: [], textWidened: [] };
  const row16 = [16, "RECTANGLE", 0, true, 0, 0, 40, 20, null, null, null];
  v.verify = { op: "verify", taskNo: 2, roots: [{ i: 16, id: "9:16", found: true, inParent: [10, 1] }], count: 1, rows: [row16] };
  let Jv = judge(v);
  check(Jv.geometry.visibleOver05 === 0 && Jv.geometry.worst.length === 0, "a split root where the IR puts it in its parent is no finding", show(Jv.geometry));
  v.verify.roots[0].inParent = [60, 1];
  Jv = judge(v);
  check(Jv.geometry.visibleOver1 === 1 && Jv.geometry.worst[0].i === 16 && Jv.geometry.worst[0].dx === 50 && Jv.geometry.sizeVisibleOver05 === 0,
    "a split root 50 px off in its parent is a visible position finding (G6), though it is its own origin", show(Jv.geometry));
  delete v.verify.roots[0].inParent;
  Jv = judge(v);
  check(Jv.geometry.visibleOver1 === 1, "a split root VERIFY found but did not place in its parent counts as off by more than 1 px", show(Jv.geometry));
}
{
  check(/judgeTask: /.test(threw(() => judgeTask({}))) && /judgeTask: /.test(threw(() => judgeTask(Object.assign(scene(), { verify: null })))) &&
    /judgeTask: /.test(threw(() => { const s = scene(); s.task.nodes[1].guid = "9:9"; judgeTask(s); })) &&
    /judgeTask: /.test(threw(() => { const s = scene(); s.verify.rows[0] = s.verify.rows[0].slice(0, 10); judgeTask(s); })),
    "judgeTask throws on arguments that are not of the shapes (no IR, no verify, a record of another IR, a short row)");
}
// judgeRun
{
  const a = scene(); rowOf(a, 1)[ROW.absX] += 1.2; rowOf(a, 2)[ROW.vec] = [V("NONZERO", 43, 10, 53, 18)]; rowOf(a, 1)[ROW.w] += 0.8;
  const b = scene(); rowOf(b, 16)[ROW.absX] += 5; rowOf(b, 4)[ROW.lines] = { lines: 5, approx: false }; rowOf(b, 1)[ROW.h] += 2;
  b.verify.roots[0].found = true; rowOf(b, 5)[ROW.childCount] = 1; b.verify.count++;
  const Ja = judge(a), Jb = judge(b);
  const T = judgeRun([Ja, Jb]);
  check(checkJShape(T, TOTALS_SHAPE).length === 0 && T.tasks === 2, "judgeRun gives exactly TOTALS_SHAPE", checkJShape(T, TOTALS_SHAPE).join("; "));
  check(T.geometry.visibleOver1 === 2 && T.geometry.visible === 30 && T.vectors.checked === 12 && T.vectors.differs.length === 1 &&
    T.text.differ.length === 1 && T.codes.INSTANCE_DEFERRED === 2 && T.vectors.excused.VECTOR_ORACLE_DIFFERS === 2 && T.count.expected === 34,
    "numbers are summed, maps added, lists concatenated", show({ g: T.geometry.visibleOver1, v: T.vectors, c: T.codes }));
  check(T.geometry.maxSizeVisible === 2 && T.count.ok === false && same(T.placeholders.misaligned, [5]),
    "maxSizeVisible stays a maximum; count.ok is false when one task's is", show(T.geometry.maxSizeVisible));
  check(T.geometry.worst.map((w) => w.i).join() === "16,1,1",
    "worst is re-sorted, largest first", show(T.geometry.worst));
  const many = [];
  for (let k = 0; k < 4; k++) { const s = scene(); for (const w of s.verify.rows) if (w[0] !== 0) w[ROW.absX] += 0.6 + k * 0.01 + w[0] * 0.001; many.push(judge(s)); }
  const T2 = judgeRun(many);
  check(T2.geometry.worst.length === 30 && T2.geometry.worst.every((w, j, l) => j === 0 || Math.hypot(l[j - 1].dx, l[j - 1].dy) >= Math.hypot(w.dx, w.dy)),
    "worst is cut to 30 after the merge, still sorted", T2.geometry.worst.length);
  check(judgeRun([judge(scene())]).count.ok === true && judgeRun([]).count.ok === false && judgeRun([]).tasks === 0, "count.ok needs a task and every task's ok");
  check(/judgeRun: /.test(threw(() => judgeRun([emptyJ(), { count: {} }]))) && /judgeRun: /.test(threw(() => judgeRun(null))), "judgeRun throws on a J that is not of J_SHAPE");
  check(same(Object.keys(T).slice(1), Object.keys(J_SHAPE)), "totals keep J's key order after tasks");
}
{
  // vectorBox (part F, docs/M1.md §8.3): a VECTOR or BOOLEAN_OPERATION takes its box from its drawing,
  // which may differ from Pixso's box; the delta is classified when the row's box is the IR drawing's.
  const withValue = (s, v) => { s.ir.values.push(v); return s.ir.values.length - 1; };
  const net = (segs, verts) => ({ vertices: verts.map(([x, y]) => ({ x, y })), segments: segs, regions: [] });
  const flatNet = net([{ start: 0, end: 1 }, { start: 1, end: 2 }], [[0, 0], [10, 0], [10, 4]]);   // drawing 10 x 4 in a 10 x 8 box
  {
    const s = scene(); s.ir.nodes[2].props.vectorNetwork = withValue(s, flatNet); s.task = taskOf(s.ir);
    rowOf(s, 2)[ROW.h] = 4;
    const J = judge(s);
    check(J.geometry.sizeVisibleOver1 === 0 && J.geometry.sizeVisibleOver05 === 0 && J.geometry.classified.vectorBox === 1 && J.geometry.worst[0].i === 2,
      "a network vector whose drawing is smaller than Pixso's box: Figma's box is the drawing's, classified vectorBox", show(J.geometry));
    rowOf(s, 2)[ROW.absX] += 2;
    const J2 = judge(s);
    check(J2.geometry.visibleOver1 === 1 && J2.geometry.sizeVisibleOver1 === 1 && !J2.geometry.classified.vectorBox,
      "the same vector drawn 2 px off its place is counted, position and size", show(J2.geometry));
  }
  {
    // A cubic bulging to y = 4.5 (controls at 6): the drawing's exact bounds, not its control hull.
    const curve = net([{ start: 0, end: 1, tangentStart: { x: 0, y: 6 }, tangentEnd: { x: 0, y: 6 } }], [[0, 0], [10, 0]]);
    const s = scene(); s.ir.nodes[10].props.vectorNetwork = withValue(s, curve); s.task = taskOf(s.ir);
    rowOf(s, 10)[ROW.h] = 4.5;
    check(judge(s).geometry.classified.vectorBox === 1, "a curved segment's box is its exact extremum (4.5 px), classified");
    rowOf(s, 10)[ROW.h] = 6;
    const J = judge(s);
    check(J.geometry.sizeVisibleOver1 === 1 && !J.geometry.classified.vectorBox, "a box at the control hull (6 px) is not the drawing's: counted", show(J.geometry));
  }
  {
    // A geometry-built vector whose path starts at (1, 1): Figma moves its origin there.
    const s = scene(); s.ir.nodes[3].props.fillGeometry = withValue(s, [{ windingRule: "NONZERO", data: "M 1 1 L 9 1 L 5 7 Z" }]); s.task = taskOf(s.ir);
    const w = rowOf(s, 3); w[ROW.absX] = 41; w[ROW.absY] = 31; w[ROW.w] = 8; w[ROW.h] = 6;
    const J = judge(s);
    check(J.geometry.visibleOver05 === 0 && J.geometry.sizeVisibleOver05 === 0 && J.geometry.classified.vectorBox === 1,
      "a geometry vector whose origin Figma moved to its path's corner keeps its drawing in place: classified", show(J.geometry));
  }
  {
    // Turned 90°: the drawing's box is placed by the record's own transform.
    const s = scene(); s.ir.nodes[2].props.vectorNetwork = withValue(s, flatNet); s.ir.nodes[2].props.relativeTransform = [0, -1, 50, 1, 0, 10]; s.task = taskOf(s.ir);
    const w = rowOf(s, 2); w[ROW.absX] = 46; w[ROW.absY] = 10; w[ROW.w] = 10; w[ROW.h] = 4;
    const J = judge(s);
    check(J.geometry.visibleOver05 === 0 && J.geometry.classified.vectorBox === 1 && J.geometry.worst.some((x) => x.i === 2 && x.dx === 4),
      "a turned vector's drawing is placed by its transform (4 px from Pixso's box corner, classified)", show(J.geometry));
  }
  {
    // A native boolean: its stored result is the drawing; a box that is not the result's is counted.
    const s = scene(); rowOf(s, 8)[ROW.w] = 28;
    const J = judge(s);
    check(J.geometry.sizeVisibleOver1 === 1 && !J.geometry.classified.vectorBox, "a boolean whose box is not its stored result's is counted", show(J.geometry));
    const s2 = scene(); s2.ir.nodes[8].props.oracleFillGeometry = withValue(s2, [{ windingRule: "NONZERO", data: "M 0 0 L 28 0 L 28 20 L 0 20 Z" }]); s2.task = taskOf(s2.ir);
    rowOf(s2, 8)[ROW.w] = 28;
    check(judge(s2).geometry.classified.vectorBox === 1, "a boolean whose stored result is narrower than Pixso's box: classified");
    const s3 = scene(); rowOf(s3, 1)[ROW.h] = 12;
    check(judge(s3).geometry.sizeVisibleOver1 === 1, "a RECTANGLE is never vectorBox: its size is written");
  }
}
{
  // The first live build of U (docs/M1.md §15.13): a union whose stored result (and size, 30 x 20) was
  // not computed again after a second operand (30..50) was added. Figma computes the union of both
  // operands: a 50 px box and path. Counted with no note; under the reader's boolean-operands note
  // held to the box its operands bound instead (G7 classified booleanOperands, G9 excused), and only
  // while Figma's paths cover the stored result and stay inside that box.
  const stale = (note, figX1) => {
    const s = scene();
    s.ir.nodes.push({ parent: 8, guid: "5:99", type: "RECTANGLE", name: "R17", props: paint({ relativeTransform: T6(30, 0), width: 20, height: 20 }) });   // 17
    if (note) s.ir.notes.push({ code: schema.CODE.VECTOR_ORACLE_DIFFERS, node: 8, detail: "boolean-operands: the stored result leaves out operand 17 by 20 px" });
    s.task = taskOf(s.ir);
    const w8 = rowOf(s, 8);
    w8[ROW.childCount] = 2; w8[ROW.w] = figX1 - 160; w8[ROW.vec] = [V("NONZERO", 160, 10, figX1, 30)];
    s.verify.rows.push([17, "RECTANGLE", 0, true, 190, 10, 20, 20, null, null, null]);
    s.verify.count = s.verify.rows.length;
    return judge(s);
  };
  let J = stale(false, 210);
  check(J.count.ok && J.geometry.sizeVisibleOver1 === 1 && same(J.vectors.differs, [{ i: 8, kind: "bounds" }]) && !J.geometry.classified.booleanOperands,
    "a boolean built from its operands, wider than its out-of-date stored result, is counted (G7, G9) with no note", show([J.geometry, J.vectors]));
  J = stale(true, 210);
  check(J.count.ok && J.geometry.sizeVisibleOver05 === 0 && J.geometry.visibleOver05 === 0 && J.geometry.classified.booleanOperands === 1 &&
    J.vectors.differs.length === 0 && J.vectors.excused.VECTOR_ORACLE_DIFFERS === 2,
    "boolean-operands: the box and the paths of its operands' union are classified and excused", show([J.geometry, J.vectors]));
  J = stale(true, 215);
  check(J.geometry.sizeVisibleOver1 === 1 && same(J.vectors.differs, [{ i: 8, kind: "bounds" }]) && !J.geometry.classified.booleanOperands,
    "boolean-operands: a result reaching past the box its operands bound is still counted", show([J.geometry, J.vectors]));
  J = stale(true, 185);
  check(J.geometry.sizeVisibleOver1 === 1 && same(J.vectors.differs, [{ i: 8, kind: "bounds" }]),
    "boolean-operands: a result that does not cover the stored one is still counted", show([J.geometry, J.vectors]));
  const s = scene(); s.ir.notes.push({ code: schema.CODE.VECTOR_ORACLE_DIFFERS, node: 2, detail: "boolean-operands" }); s.task = taskOf(s.ir);
  rowOf(s, 2)[ROW.vec] = [V("NONZERO", 43, 10, 53, 18)];
  check(same(judge(s).vectors.differs, [{ i: 2, kind: "bounds" }]), "boolean-operands excuses nothing on a VECTOR");
}

// ============================================================================================
// 3. VERIFY on a scene built in the double by direct figma.* calls (independent of part B)
// ============================================================================================
const SNAP = schema.snapshotId({ source: { kind: "pix", sha256: "0".repeat(62) + "a1" } });
const RUN = "00000000000000c3";
const SETTINGS = { textFit: "widen", layoutOrder: "creation", textRead: "measure", fallbackFont: { family: "Inter", style: "Regular" } };
const NS = "pix2fig";
const stampRoot = (n, i, guid) => { n.setSharedPluginData(NS, "pxIdx", String(i)); n.setSharedPluginData(NS, "pxSnap", SNAP); n.setSharedPluginData(NS, "pxIr", String(schema.VERSION));
  n.setSharedPluginData(NS, "pxSrc", guid); n.setSharedPluginData(NS, "pxRun", RUN); };
const solid = () => [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 0, g: 0, b: 0 } }];

// The task the scene answers: a valid verify task (checked below), and the IR its records come from.
function verifyTask() {
  const vals = { "0": [], "1": [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], "2": [{ windingRule: "EVENODD", data: "M 0 0 L 10 0 L 5 8 Z" }],
    "3": { family: "Inter", style: "Regular" } };
  const nodes = [
    { i: 0, parent: -1, guid: "7:1", type: "FRAME", name: "F", props: frame({ relativeTransform: T6(-50, 20), width: 200, height: 100 }) },
    { i: 1, parent: 0, guid: "7:2", type: "RECTANGLE", name: "R", props: paint({ relativeTransform: T6(10, 10), width: 20, height: 20, strokes: 1, strokeWeight: 2, strokeWeights: [2, 2, 2, 0] }) },
    { i: 2, parent: 0, guid: "7:3", type: "VECTOR", name: "V", props: paint({ relativeTransform: T6(40, 10), width: 10, height: 8, fillGeometry: 2, fills: 1 }) },
    { i: 3, parent: 0, guid: "7:4", type: "RECTANGLE", name: "Q", props: paint({ relativeTransform: [0, -1, 100, 1, 0, 60], width: 10, height: 4 }) },
    { i: 4, parent: 0, guid: "7:5", type: "GROUP", name: "G", props: { relativeTransform: T6(10, 50), width: 20, height: 20, visible: false, blendMode: "PASS_THROUGH" } },
    { i: 5, parent: 4, guid: "7:6", type: "ELLIPSE", name: "E", props: paint({ relativeTransform: T6(2, 2), width: 5, height: 5 }) },
    { i: 6, parent: 0, guid: "7:7", type: "INSTANCE", name: "I", props: { relativeTransform: T6(120, 10), width: 30, height: 30 } },
    { i: 7, parent: 0, guid: "7:8", type: "TEXT", name: "T", props: paint({ relativeTransform: T6(60, 10), width: 50, height: 30, characters: "Hi", fontName: 3, fontSize: 12, textAutoResize: "NONE", lines: 1 }) },
  ];
  const task = { format: "pix2fig.task", version: 1, op: "verify", runId: RUN, taskNo: 2, of: 2, snapshot: SNAP, irVersion: schema.VERSION, settings: clone(SETTINGS),
    page: { index: 0, guid: "0:1", name: "Page 1", service: false, background: null },
    roots: [{ i: 0, attachTo: "page", place: null }], nodes, notes: [{ code: schema.CODE.VECTOR_FROM_GEOMETRY, i: 2, detail: null }],
    values: vals, fonts: [{ family: "Inter", style: "Regular" }], images: [], expect: { count: 8, nonInstance: 7, placeholders: 1 } };
  const values = []; for (const k of Object.keys(vals)) values[Number(k)] = vals[k];
  const ir = { nodes: nodes.map((n) => ({ parent: n.parent, guid: n.guid, type: n.type, name: n.name, props: n.props })), values,
    notes: [{ code: schema.CODE.VECTOR_FROM_GEOMETRY, node: 2, detail: null }] };
  return { task, ir };
}
async function buildScene(D) {
  const f = D.figma;
  await f.loadFontAsync({ family: "Inter", style: "Regular" });
  const root = f.createFrame(); root.relativeTransform = [[1, 0, 300], [0, 1, 400]]; root.resize(200, 100); root.fills = []; root.clipsContent = false;
  stampRoot(root, 0, "7:1");
  const rect = f.createRectangle(); root.appendChild(rect); rect.relativeTransform = [[1, 0, 10], [0, 1, 10]]; rect.resize(20, 20);
  rect.fills = []; rect.strokes = solid(); rect.strokeWeight = 2; rect.strokeLeftWeight = 0;
  const vec = f.createVector(); root.appendChild(vec); vec.relativeTransform = [[1, 0, 40], [0, 1, 10]]; vec.resize(10, 8);
  vec.vectorPaths = [{ windingRule: "EVENODD", data: "M 0 0 L 10 0 L 5 8 Z" }]; vec.fills = solid();
  const rot = f.createRectangle(); root.appendChild(rot); rot.relativeTransform = [[0, -1, 100], [1, 0, 60]]; rot.resize(10, 4); rot.fills = [];
  const grp = f.createFrame(); root.appendChild(grp); grp.relativeTransform = [[1, 0, 10], [0, 1, 50]]; grp.resize(20, 20); grp.fills = []; grp.visible = false;
  const ell = f.createEllipse(); grp.appendChild(ell); ell.relativeTransform = [[1, 0, 2], [0, 1, 2]]; ell.resize(5, 5); ell.fills = [];
  const ph = f.createFrame(); root.appendChild(ph); ph.relativeTransform = [[1, 0, 120], [0, 1, 10]]; ph.resize(30, 30); ph.fills = [];
  const txt = f.createText(); root.appendChild(txt); txt.characters = "Hi"; txt.relativeTransform = [[1, 0, 60], [0, 1, 10]]; txt.resize(50, 30);
  // Another task's split root under this root: VERIFY must skip it.
  const other = f.createFrame(); root.appendChild(other); other.resize(5, 5); stampRoot(other, 99, "7:99");
  const otherKid = f.createRectangle(); other.appendChild(otherKid);
  return { root, rect, vec, rot, grp, ell, ph, txt, other };
}
function bundleWith(D, host, irFiles) {
  return loadPluginBundle({ figma: D.figma, host, sources: irFiles ? { irFiles } : undefined }).PXF_IR;
}
{
  const { task, ir } = verifyTask();
  const v = validateTask(task);
  check(v.ok, "the verify scene's task is a valid task", v.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join(" | "));
  const D = makeDouble();
  const sc = await buildScene(D);
  const host = defaultHost(); host.phase = D.setPhase;
  const measured = [];
  host.measure = (ctx, node, rec) => { measured.push(rec.i); return { lines: 1, approx: false }; };
  const IR = bundleWith(D, host);
  check(typeof IR.ops.verify === "function" && !IR.ops.verify.notInThisBuild && typeof IR.countLines === "function" && !IR.countLines.notInThisBuild,
    "the bundle carries part C's verify op and countLines, not the stubs");
  const pagesBefore = D.tree().children.length;
  const writesBefore = D.writes.length;
  const ctx = IR.makeCtx(D.figma, task, { id: "v1" });
  const rep = await IR.ops.verify(ctx, task);
  const byI = new Map(rep.rows.map((w) => [w[0], w]));
  check(rep.op === "verify" && rep.taskNo === 2 && same(rep.roots, [{ i: 0, id: sc.root.id, found: true }]) && rep.count === 8 && rep.rows.length === 8 &&
    same(rep.fontsMissing, []) && rep.failures.length === 0, "verify finds the root by its stamps, walks 8 nodes and skips another task's split root and its child", show({ roots: rep.roots, count: rep.count }));
  check(same(byI.get(0), [0, "FRAME", 6, true, 0, 0, 200, 100, null, null, null]), "the root's row: its own transform is the origin (it sits at 300, 400)", show(byI.get(0)));
  check(same(byI.get(1).slice(4, 9), [10, 10, 20, 20, [2, 2, 2, 0]]), "a rectangle's row carries its four side weights", show(byI.get(1)));
  check(same(byI.get(2)[ROW.vec], [["EVENODD", 40, 10, 50, 18, 1]]) && byI.get(2)[ROW.sides] === null,
    "a vector's row carries its fill paths as [winding, root-relative box, subpaths], no path string", show(byI.get(2)));
  check(byI.get(3)[ROW.absX] === 96 && byI.get(3)[ROW.absY] === 60 && byI.get(3)[ROW.w] === 10, "a rotated child's row: the min corner of its rotated box", show(byI.get(3)));
  check(byI.get(4)[ROW.effVisible] === false && byI.get(5)[ROW.effVisible] === false && byI.get(5)[ROW.absX] === 12 && byI.get(5)[ROW.builtType] === "ELLIPSE",
    "visibility is inherited down the built tree", show(byI.get(5)));
  check(byI.get(6)[ROW.builtType] === "FRAME" && byI.get(6)[ROW.childCount] === 0 && byI.get(6)[ROW.vec] === null, "the placeholder's row");
  check(same(byI.get(7)[ROW.lines], { lines: 1, approx: false }) && same(measured, [7]), "a text with lines is measured through ctx.measure, once");
  const during = D.writes.slice(writesBefore);
  const scratchIds = new Set(during.filter((w) => /^create(TEXT|Page)\(\)$/.test(w.prop)).map((w) => w.id));
  check(during.every((w) => scratchIds.has(w.id)), "verify writes nothing to the built tree (only to its own scratch and service page)",
    show(during.filter((w) => !scratchIds.has(w.id)).slice(0, 3)));
  const scratchLeft = JSON.stringify(D.tree()).indexOf("pxScratch") >= 0;
  check(!scratchLeft && D.tree().children.length === pagesBefore && ctx.S.scratchTextId === null, "the scratch node and the service page it made are gone after verify");
  check(["fonts", "roots", "settle", "walk"].every((p) => typeof rep.ms[p] === "number"), "verify books its time under fonts, roots, settle and walk", show(rep.ms));
  // The judge on what verify measured: a faithful scene is clean.
  const J = judge({ ir, task, build: null, verify: rep });
  check(J.count.ok && J.geometry.visibleOver05 === 0 && J.geometry.hiddenOver05 === 0 && J.sides.mismatchIR.length === 0 && J.vectors.match === 1 &&
    J.vectors.differs.length === 0 && J.text.checked === 1 && J.placeholders.aligned === 1, "verify, then the judge: the faithful scene has no finding", show(J));
  // Move a node 1.2 px and verify again: the judge sees it.
  sc.rect.x = 11.2;
  sc.vec.vectorPaths = [{ windingRule: "EVENODD", data: "M 0 0 L 13 0 L 5 8 Z" }];
  const rep2 = await IR.ops.verify(IR.makeCtx(D.figma, task, { id: "v2" }), task);
  const J2 = judge({ ir, task, build: null, verify: rep2 });
  // Part E's double gives a redrawn vector its drawing's size (P19B pending), so the vector may also
  // be a size entry in worst, ranked above the move: look the moved node up (merge of part E).
  check(J2.geometry.visibleOver1 === 1 && J2.geometry.worst.some((w) => w.i === 1 && near(w.dx, 1.2)) && same(J2.vectors.excused, { VECTOR_FROM_GEOMETRY: 1 }) &&
    same(J2.vectors.excusedBuiltFromOracle, { VECTOR_FROM_GEOMETRY: 1 }), "a node moved 1.2 px and a redrawn geometry vector are found end to end", show(J2.geometry));
  // A root that is not there.
  const t3 = clone(task); t3.nodes[0].guid = "7:100";
  const ctx3 = IR.makeCtx(D.figma, t3, { id: "v3" });
  const rep3 = await IR.ops.verify(ctx3, t3);
  check(same(rep3.roots, [{ i: 0, id: null, found: false }]) && rep3.count === 0 && rep3.rows.length === 0 && rep3.codes.ROOT_NOT_FOUND === 1,
    "a root no stamp matches is not found, and coded ROOT_NOT_FOUND", show(rep3.roots));
  // A measurement that throws is a failure entry, and the judge counts the text unmeasured.
  host.measure = () => { throw new Error("synthetic measuring failure"); };
  const rep4 = await IR.ops.verify(IR.makeCtx(D.figma, task, { id: "v4" }), task);
  check(rep4.failures.length === 1 && rep4.failures[0].i === 7 && rep4.failures[0].prop === "lines" && rep4.rows.find((w) => w[0] === 7)[ROW.lines] === null &&
    judge({ ir, task, build: null, verify: rep4 }).text.unmeasured === 1 && JSON.stringify(D.tree()).indexOf("pxScratch") < 0,
    "a measuring throw is a failure entry, the text is unmeasured, and the scratch is still removed", show(rep4.failures));
  // A missing font is listed, and marked substituted for countLines.
  const t5 = clone(task); t5.fonts.push({ family: "Synthetic Sans", style: "Bold" });
  const ctx5 = IR.makeCtx(D.figma, t5, { id: "v5" });
  host.measure = () => ({ lines: 1, approx: false });
  const rep5 = await IR.ops.verify(ctx5, t5);
  check(same(rep5.fontsMissing, [{ family: "Synthetic Sans", style: "Bold" }]) && ctx5.S.fonts["Synthetic Sans|Bold"] === "sub" && ctx5.S.fonts["Inter|Regular"] === "ok",
    "verify loads the task's fonts and the fallback first; a missing one is listed and marked substituted", show(rep5.fontsMissing));
  check(D.missingFontLoads === 0, "a font Figma does not list is never handed to loadFontAsync (real Figma may hang on it)", String(D.missingFontLoads));
  // The read-only walk keeps layout reads out of the write log, and no write lands on another task's root.
  check(!D.writes.slice(writesBefore).some((w) => w.id === sc.other.id), "another task's root is never touched");
}

// ============================================================================================
// 4. countLines: the scratch node, the arithmetic, and (later) Figma's text through B and E
// ============================================================================================
const realFiles = () => Object.fromEntries(readdirSync(IR_SRC_DIR).filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(join(IR_SRC_DIR, f), "utf8")]));
// A toy text model over the double: each character is 0.6 x fontSize wide, words do not matter, a
// paragraph takes ceil(chars x charWidth / width) lines, AUTO's line is FACTOR[family] x fontSize.
const FACTOR = { Inter: 1.2, Roboto: 2 };
function toyText(D) {
  const wrap = (n) => new Proxy(n, {
    get(target, prop) {
      if (prop !== "height" && prop !== "width") return target[prop];
      const mode = target.textAutoResize;
      if (mode !== "HEIGHT" && mode !== "WIDTH_AND_HEIGHT") return target[prop];
      // Part E's double reads figma.mixed at node level where ranges differ; the toy then takes the
      // last character's value, which no range here covers (merge of part E).
      const last = String(target.characters).length;
      const base = (v, get) => (typeof v === "symbol" ? target[get](last - 1, last) : v);
      const size = base(target.fontSize, "getRangeFontSize"), font = base(target.fontName, "getRangeFontName"),
        lh = base(target.lineHeight, "getRangeLineHeight") || { unit: "AUTO" };
      const L = lh.unit === "PIXELS" ? lh.value : lh.unit === "PERCENT" ? lh.value / 100 * size : FACTOR[font.family] * size;
      const paras = String(target.characters).split("\n");
      const cw = 0.6 * size;
      if (mode === "WIDTH_AND_HEIGHT") return prop === "width" ? Math.max(...paras.map((p) => p.length * cw)) : paras.length * L + (target.paragraphSpacing || 0) * (paras.length - 1);
      if (prop === "width") return target.width;
      const width = target.width;
      const lines = paras.reduce((s, p) => s + Math.max(1, Math.ceil(p.length * cw / width - 1e-9)), 0);
      return lines * L + (target.paragraphSpacing || 0) * (paras.length - 1);
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const figma = new Proxy(D.figma, { get(target, prop) { const v = target[prop]; return prop === "createText" ? () => wrap(target.createText()) : v; } });
  return figma;
}
function textTask(recs, fonts) {
  const vals = { "0": [], "1": { family: "Inter", style: "Regular" }, "2": { family: "Roboto", style: "Regular" }, "3": { unit: "PIXELS", value: 14 },
    "4": { unit: "PERCENT", value: 150 }, "5": { unit: "AUTO" } };
  return { format: "pix2fig.task", version: 1, op: "verify", runId: RUN, taskNo: 1, of: 1, snapshot: SNAP, irVersion: schema.VERSION, settings: clone(SETTINGS),
    page: { index: 0, guid: "0:1", name: "Page 1", service: false, background: null }, roots: [{ i: 0, attachTo: "page", place: null }],
    nodes: recs, notes: [], values: vals, fonts: fonts || [{ family: "Inter", style: "Regular" }, { family: "Roboto", style: "Regular" }], images: [],
    expect: { count: recs.length, nonInstance: recs.length, placeholders: 0 } };
}
const textRec = (i, props) => ({ i, parent: i === 0 ? -1 : 0, guid: "8:" + (i + 1), type: "TEXT", name: "T",
  props: paint(Object.assign({ relativeTransform: T6(0, 0), width: 100, height: 20, characters: "aaaaaaaaaa", fontName: 1, fontSize: 10, textAutoResize: "NONE", lines: 3 }, props)) });
{
  const probeIR = bundleWith(makeDouble(), defaultHost());
  check(typeof probeIR.writeTextProps === "function" && !probeIR.writeTextProps.notInThisBuild, "part B's IR.writeTextProps is in the bundle");
  const files = realFiles();
  const D = makeDouble();
  for (const f of [{ family: "Inter", style: "Regular" }, { family: "Roboto", style: "Regular" }]) await D.figma.loadFontAsync(f);
  const figma = toyText(D);
  const host = defaultHost(); host.phase = D.setPhase;
  const B = loadPluginBundle({ figma, host, sources: { irFiles: files } });
  const IR = B.PXF_IR;
  const label = "part B's writeTextProps";
  const recs = [
    textRec(0, { lineHeight: 3 }),                                                                   // 60 px of text in 25: 3 lines of 14
    textRec(1, { lineHeight: 4 }),                                                                   // 150 % of 10
    textRec(2, { lineHeight: 5 }),                                                                   // AUTO, Inter
    textRec(3, { lineHeight: 5, fontName: 2 }),                                                      // AUTO, Roboto (another line height)
    textRec(4, { lineHeight: 3, characters: "aaaa\nbbbb", paragraphSpacing: 10, lines: 2 }),         // two paragraphs, spacing 10
    textRec(5, { lineHeight: 3, textTruncation: "ENDING", maxLines: 2, lines: 2, textAutoResize: "HEIGHT" }), // capped at maxLines
    textRec(6, { lineHeight: 3, textRanges: [{ start: 0, end: 2, fields: { lineHeight: 4 } }] }),     // mixed line heights
    textRec(7, { lineHeight: 3, textRanges: [{ start: 0, end: 2, fields: { fontSize: 12 } }] }),      // a size range under PIXELS: exact
    textRec(8, { lineHeight: 5, textRanges: [{ start: 0, end: 2, fields: { fontSize: 12 } }] }),      // a size range under AUTO: approximate
    textRec(9, { lineHeight: 3, textTruncation: "ENDING", lines: 1 }),                               // a fixed box of 20 px holds one 14 px line (review figma F2)
  ];
  const task = textTask(recs);
  const ctx = IR.makeCtx(figma, task, { id: "c1" });
  const built = figma.createText(); built.textAutoResize = "NONE"; built.fontName = { family: "Inter", style: "Regular" }; built.characters = "x"; built.resize(25, 20);
  const pagesBefore = D.tree().children.length;
  const got = recs.map((r) => IR.countLines(ctx, built, r));
  const want = [[3, false], [3, false], [3, false], [3, false], [2, false], [2, false], [3, true], [3, false], [3, true], [1, false]];
  const bad = got.map((g, k) => (g.lines === want[k][0] && g.approx === want[k][1] ? "" : k + ": " + show(g) + " want " + show(want[k]))).filter(Boolean);
  check(!bad.length, "countLines through " + label + " on a toy text model: PIXELS, PERCENT, AUTO per font, paragraph spacing, ENDING cap (maxLines, or a fixed box's height), approximate ranges", bad.join("; "));
  const tree = D.tree();
  const service = tree.children.find((p) => p.sharedPluginData[NS] && p.sharedPluginData[NS].pxPage === "m1-service");
  const scratch = service && service.children.find((n) => n.sharedPluginData[NS] && n.sharedPluginData[NS].pxScratch === "1" && n.pluginData.pxScratch === "1");
  check(!!scratch && service.children.length === 1 && ctx.S.scratchTextId === scratch.id && tree.children.length === pagesBefore + 1,
    "one scratch text node, stamped pxScratch shared and private, on a service page stamped m1-service; its id in ctx.S.scratchTextId");
  check(D.writes.filter((w) => w.prop === "createTEXT()").length === 2, "the scratch node is reused across measurements (one createText besides the built node)");
  check(D.writes.filter((w) => w.prop === "characters" && w.value === "Hg").length === 2, "AUTO's one-line height is measured once per font and size (Inter 10, Roboto 10)");
  check(built.width === 25 && built.characters === "x", "the built node is measured at its width and never written");
  // The measurement is the built node's width, not the record's.
  const wide = figma.createText(); wide.textAutoResize = "NONE"; wide.fontName = { family: "Inter", style: "Regular" }; wide.resize(60, 20);
  check(IR.countLines(ctx, wide, recs[0]).lines === 1, "a node 60 px wide holds the same text on one line");
  // A substituted font: the AUTO line is the fallback's, as the writer writes it.
  ctx.S.fonts["Roboto|Regular"] = "sub";
  check(IR.countLines(ctx, built, recs[3]).lines === 3, "a substituted font is measured in the fallback the writer writes (Roboto's line would give 2)");
  IR.dropScratch(ctx);
  const after = D.tree();
  check(after.children.length === pagesBefore && JSON.stringify(after).indexOf("pxScratch") < 0 && ctx.S.scratchTextId === null,
    "dropScratch removes the scratch and the service page it made");
  // An existing service page is used and kept.
  const sp = D.figma.createPage(); sp.setSharedPluginData(NS, "pxPage", "m1-service");
  const keep = D.figma.createFrame(); sp.appendChild(keep);
  const ctx2 = IR.makeCtx(figma, Object.assign(textTask(recs), { runId: "00000000000000d4" }), { id: "c2" });
  await IR.prepareMeasure(ctx2);
  IR.countLines(ctx2, built, recs[0]);
  check(sp.children.length === 2 && D.node(ctx2.S.scratchTextId).parent.id === sp.id, "an existing service page holds the scratch");
  IR.dropScratch(ctx2);
  check(!sp.removed && sp.children.length === 1 && sp.children[0].id === keep.id, "and is kept, with what it held, when the scratch goes");
  check(/not a TEXT/.test(threw(() => IR.countLines(ctx2, built, { i: 9, type: "FRAME", props: {} }))), "countLines refuses a record that is not a TEXT");
  IR.dropScratch(ctx2);

  // Figma's own text, through part B's writer and part E's text model.
  const D2 = makeDouble();
  await D2.figma.loadFontAsync({ family: "Inter", style: "Regular" });
  const t = D2.figma.createText(); t.characters = "word ".repeat(40); t.textAutoResize = "NONE"; t.resize(20, 1); t.textAutoResize = "HEIGHT";
  check(t.height > 1, "part E's text model wraps a long text in a narrow HEIGHT box");
  {
    const IR2 = bundleWith(D2, defaultHost());
    const tk = textTask([textRec(0, { lineHeight: 3, characters: "word word word word word word word word", lines: 1 })], [{ family: "Inter", style: "Regular" }]);
    const c = IR2.makeCtx(D2.figma, tk, { id: "c3" });
    const n1 = D2.figma.createText(); n1.characters = "x"; n1.resize(4000, 20);
    const n2 = D2.figma.createText(); n2.characters = "x"; n2.resize(40, 20);
    const one = IR2.countLines(c, n1, tk.nodes[0]), many = IR2.countLines(c, n2, tk.nodes[0]);
    const para = IR2.countLines(c, n1, textRec(1, { lineHeight: 3, characters: "a\nb\nc", lines: 3 }));
    IR2.dropScratch(c);
    check(one.lines === 1 && many.lines > 1 && para.lines === 3 && JSON.stringify(D2.tree()).indexOf("pxScratch") < 0,
      "countLines on part E's text model through part B's writer: a wide box holds one line, a narrow one several, three paragraphs three", show({ one, many, para }));
  }
}

console.log("");
console.log(failed ? failed + " verify/judge check" + (failed === 1 ? "" : "s") + " FAILED" : "all verify/judge checks pass");
process.exit(failed ? 1 : 0);

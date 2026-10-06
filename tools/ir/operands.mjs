// A boolean's stored result against its own operands (docs/M1.md §15.13). Pure functions over an IR
// ({ nodes, values }); the reader uses them to pre-register a stale stored result, the judge to hold
// such a boolean to its operands instead.
//
// Pixso stores a boolean's result (its fillGeometry, the IR's oracleFillGeometry) and its size. Where
// the operands were changed and the result was not computed again, the stored result is out of date:
// in the first live build of U (2026-10-06) four unions store a result that leaves out a mirrored
// operand (the other 35 copies of the same group store it), and the booleans built over them store
// results made from the stale ones. Figma computes every boolean from its operands, so the judge cannot
// hold such a record to its stored result or its stored size.
//
//   drawnBox(ir, i, kidsOf) -> { x0, y0, x1, y1 } | null
//     the box record i draws in its own space, an upper bound for a boolean: a VECTOR's stored
//     geometry (oracleFillGeometry, else fillGeometry) or its network's segments; a boolean's
//     operands combined by its operation (UNION and EXCLUDE: the union of their boxes; INTERSECT:
//     their intersection; SUBTRACT: the first operand's), each operand under its relativeTransform,
//     hidden operands left out; anything else its width and height. kidsOf(i) lists i's child
//     records in order.
//   storedBox(ir, i) -> box | null      the stored result's box (oracleFillGeometry), own space
//   staleBooleans(ir) -> Map(i -> detail)
//     every BOOLEAN_OPERATION record with a stored result that is out of date: a UNION whose stored
//     result leaves out part of an operand by more than 1 px, and every boolean with such a boolean
//     among its operands (its own stored result was made from a stale one). The detail is the
//     VECTOR_ORACLE_DIFFERS note's, its class first: "boolean-operands: …".
//   kidsIndex(ir) -> (i) -> [child indices]
import { geometryBounds, pathBounds, unionBounds } from "./pathgeom.mjs";

export const STALE_TOL = 1;
const r2 = (n) => Math.round(n * 100) / 100;

export function kidsIndex(ir) {
  const kids = new Map();
  ir.nodes.forEach((r, i) => { if (r && r.parent >= 0) { if (!kids.has(r.parent)) kids.set(r.parent, []); kids.get(r.parent).push(i); } });
  return (i) => kids.get(i) || [];
}

const val = (ir, k) => (Number.isInteger(k) && k >= 0 && k < ir.values.length ? ir.values[k] : undefined);
function geoBox(g) {
  if (!Array.isArray(g)) return null;
  const boxes = geometryBounds(g).filter((e) => e[5] > 0).map((e) => ({ x0: e[1], y0: e[2], x1: e[3], y1: e[4] }));
  return unionBounds(boxes);
}
function netBox(net) {
  if (!net || !Array.isArray(net.vertices) || !Array.isArray(net.segments)) return null;
  const boxes = [];
  for (const s of net.segments) {
    const a = net.vertices[s.start], b = net.vertices[s.end];
    if (!a || !b) continue;
    const ts = s.tangentStart || { x: 0, y: 0 }, te = s.tangentEnd || { x: 0, y: 0 };
    for (const x of pathBounds("M " + a.x + " " + a.y + " C " + (a.x + ts.x) + " " + (a.y + ts.y) + " " + (b.x + te.x) + " " + (b.y + te.y) + " " + b.x + " " + b.y)) boxes.push(x);
  }
  return unionBounds(boxes);
}
export function mapBox(rt, b) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
    const px = rt[0] * x + rt[1] * y + rt[2], py = rt[3] * x + rt[4] * y + rt[5];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  return { x0, y0, x1, y1 };
}
const union2 = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const meet2 = (a, b) => {
  const o = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  if (o.x1 < o.x0) o.x1 = o.x0;
  if (o.y1 < o.y0) o.y1 = o.y0;
  return o;
};

export function storedBox(ir, i) {
  const p = (ir.nodes[i] && ir.nodes[i].props) || {};
  return p.oracleFillGeometry === undefined ? null : geoBox(val(ir, p.oracleFillGeometry));
}

export function drawnBox(ir, i, kidsOf, depth) {
  const r = ir.nodes[i];
  if (!r || (depth || 0) > 64) return null;
  const p = r.props || {};
  if (r.type === "BOOLEAN_OPERATION") {
    const op = p.booleanOperation;
    let box = null, first = true;
    for (const k of kidsOf(i)) {
      const kp = (ir.nodes[k] && ir.nodes[k].props) || {};
      if (kp.visible === false || !Array.isArray(kp.relativeTransform)) continue;
      const own = drawnBox(ir, k, kidsOf, (depth || 0) + 1);
      if (!own) continue;
      const b = mapBox(kp.relativeTransform, own);
      if (op === "SUBTRACT") { if (first) box = b; }
      else if (op === "INTERSECT") box = first ? b : meet2(box, b);
      else box = union2(box, b);
      first = false;
    }
    return box;
  }
  if (r.type === "VECTOR") {
    const g = p.oracleFillGeometry !== undefined ? p.oracleFillGeometry : p.fillGeometry;
    const b = g !== undefined ? geoBox(val(ir, g)) : p.vectorNetwork !== undefined ? netBox(val(ir, p.vectorNetwork)) : null;
    if (b) return b;
  }
  return typeof p.width === "number" && typeof p.height === "number" ? { x0: 0, y0: 0, x1: p.width, y1: p.height } : null;
}

const outside = (a, b) => Math.max(b.x0 - a.x0, b.y0 - a.y0, a.x1 - b.x1, a.y1 - b.y1, 0);

export function staleBooleans(ir) {
  const kidsOf = kidsIndex(ir), out = new Map();
  // Children come after their parent: the last index first sees every operand before its boolean.
  for (let i = ir.nodes.length - 1; i >= 0; i--) {
    const r = ir.nodes[i];
    if (!r || r.type !== "BOOLEAN_OPERATION" || (r.props || {}).oracleFillGeometry === undefined) continue;
    const stored = storedBox(ir, i);
    if (!stored) continue;
    const staleKid = kidsOf(i).find((k) => out.has(k) && (ir.nodes[k].props || {}).visible !== false);
    if (staleKid !== undefined) { out.set(i, "boolean-operands: made from the out-of-date stored result of operand " + staleKid); continue; }
    if (r.props.booleanOperation !== "UNION") continue;
    for (const k of kidsOf(i)) {
      const kp = ir.nodes[k].props || {};
      if (kp.visible === false || !Array.isArray(kp.relativeTransform)) continue;
      const own = drawnBox(ir, k, kidsOf);
      if (!own) continue;
      const d = outside(mapBox(kp.relativeTransform, own), stored);
      if (d > STALE_TOL) { out.set(i, "boolean-operands: the stored result leaves out operand " + k + " by " + r2(d) + " px"); break; }
    }
  }
  return out;
}

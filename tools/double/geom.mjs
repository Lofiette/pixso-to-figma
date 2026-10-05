// Geometry for the headless double (tools/double/index.mjs): Figma path strings, the fill geometry of
// the shapes Figma draws natively, vector-network bounds, and boolean operations. Part E owns it
// (docs/M1.md §6 E, §9).
//
//   parsePath(data)                    -> [{ closed, segs: [{ op: "L"|"Q"|"C", pts: [[x,y],…] }], start }]
//   formatPath(subpaths)               -> a Figma path string ("M x y L x y … Z", single spaces)
//   mapPath(data, m)                   -> the path with every point mapped by the 2x3 matrix m
//   pathBox(data, m?)                  -> { x0, y0, x1, y1 } | null, exact (tools/ir/pathgeom.mjs)
//   networkPathAll(net)                -> every segment of a network as its own subpath (for bounds)
//   networkBox(net)                    -> the exact bounds of a network's segments and vertices
//   polygonPath(n, w, h), starPath(n, inner, w, h), ellipsePath(w, h), rectPath(w, h)
//   booleanResult(op, operands)        -> { paths: [{ windingRule, data }], box } | null
//       operands: [{ paths: [{ windingRule, data }] }] already in the result's space. Operand strokes
//       are ignored, as Figma's boolean operations work on fill areas.
//
// Booleans are APPROXIMATE, by construction: the operands are rasterised on a grid (512 cells along
// the longer side of their union box, at least 0.05 px a cell), combined per cell (UNION any,
// SUBTRACT the first minus the rest, INTERSECT all, EXCLUDE odd parity), and the result's outline is
// traced back into polygons, one closed subpath per boundary loop (outer loops and holes wound
// opposite ways, so NONZERO fills them). Every traced coordinate within one cell of an operand's
// own coordinate (a vertex, or an edge of its exact box) is snapped to it, so a result made of
// straight edges that lie on the operands' edges comes out exact; curved edges stay within a cell.
// The result is labelled NONZERO, except an EXCLUDE result, labelled EVENODD as Pixso stores its XOR
// results (the traced loops draw the same under either rule). Which rule Figma gives a boolean's
// fillGeometry is an assumption (A) until P19B's boolean cases record it (their m.winding; part F,
// docs/M1.md §15).
import { pathBounds, unionBounds } from "../ir/pathgeom.mjs";

const r4 = (n) => { const v = Math.round(n * 10000) / 10000; return String(Object.is(v, -0) ? 0 : v); };
const ap = (m, x, y) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];

// ---------- path strings ----------
const ARGS = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };

export function parsePath(data) {
  const tok = String(data || "").trim().split(/[\s,]+/).filter(Boolean);
  const out = [];
  let cur = null, at = null, i = 0;
  const num = () => { const v = Number(tok[i++]); if (!isFinite(v)) throw new Error("double: a path number is not finite"); return v; };
  while (i < tok.length) {
    const c = tok[i++];
    if (!Object.prototype.hasOwnProperty.call(ARGS, c)) throw new Error("double: path command " + JSON.stringify(c) + " is not M, L, Q, C or Z");
    if (c === "M") { at = [num(), num()]; cur = { start: at, segs: [], closed: false }; out.push(cur); continue; }
    if (!cur) throw new Error("double: a path starts with M");
    if (c === "Z") { cur.closed = true; at = cur.start; cur = { start: at, segs: [], closed: false, implicit: true }; out.push(cur); continue; }
    const pts = [];
    for (let k = 0; k < ARGS[c] / 2; k++) pts.push([num(), num()]);
    cur.segs.push({ op: c, pts });
    at = pts[pts.length - 1];
  }
  // A subpath opened implicitly after Z with nothing drawn is no subpath.
  return out.filter((s) => !(s.implicit && !s.segs.length));
}

export function formatPath(subpaths) {
  const parts = [];
  for (const s of subpaths) {
    parts.push("M " + r4(s.start[0]) + " " + r4(s.start[1]));
    for (const g of s.segs) parts.push(g.op + " " + g.pts.map((p) => r4(p[0]) + " " + r4(p[1])).join(" "));
    if (s.closed) parts.push("Z");
  }
  return parts.join(" ");
}

export function mapPath(data, m) {
  const sp = parsePath(data).map((s) => ({ start: ap(m, s.start[0], s.start[1]), closed: s.closed,
    segs: s.segs.map((g) => ({ op: g.op, pts: g.pts.map((p) => ap(m, p[0], p[1])) })) }));
  return formatPath(sp);
}

export function pathBox(data, m) {
  if (!String(data || "").trim()) return null;
  return unionBounds(pathBounds(formatPath(parsePath(data)), m || undefined));
}
export function pathsBox(paths, m) {
  const boxes = [];
  for (const p of paths || []) { const b = pathBox(p.data, m); if (b) boxes.push(b); }
  return unionBounds(boxes);
}

// Points along a subpath, curves cut into straight pieces (for rasterising).
function flatten(sub) {
  const pts = [sub.start.slice()];
  let at = sub.start;
  for (const g of sub.segs) {
    if (g.op === "L") pts.push(g.pts[0].slice());
    else if (g.op === "Q") {
      const [c, e] = g.pts;
      for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t; pts.push([u * u * at[0] + 2 * u * t * c[0] + t * t * e[0], u * u * at[1] + 2 * u * t * c[1] + t * t * e[1]]); }
    } else {
      const [c1, c2, e] = g.pts;
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        pts.push([u * u * u * at[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0],
          u * u * u * at[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]]);
      }
    }
    at = g.pts[g.pts.length - 1];
  }
  return pts;
}

// ---------- shapes Figma draws natively ----------
export function rectPath(w, h) { return "M 0 0 L " + r4(w) + " 0 L " + r4(w) + " " + r4(h) + " L 0 " + r4(h) + " L 0 0 Z"; }
export function ellipsePath(w, h) {
  const rx = w / 2, ry = h / 2, k = 0.5522847498;
  const p = (x, y) => r4(x) + " " + r4(y);
  return ["M " + p(w, ry), "C " + p(w, ry + k * ry) + " " + p(rx + k * rx, h) + " " + p(rx, h),
    "C " + p(rx - k * rx, h) + " " + p(0, ry + k * ry) + " " + p(0, ry), "C " + p(0, ry - k * ry) + " " + p(rx - k * rx, 0) + " " + p(rx, 0),
    "C " + p(rx + k * rx, 0) + " " + p(w, ry - k * ry) + " " + p(w, ry), "Z"].join(" ");
}
// An arc (arcData whose sweep, in Figma's 32-bit storage, is short of a full turn): the pie, or the
// ring piece with an inner radius, from startingAngle to endingAngle, the curve as a polyline of
// 64 steps a turn (bounds within a fraction of a pixel). A full sweep is the ellipse (null here).
const f32 = (x) => Math.fround(x);
export function arcPath(w, h, arc) {
  if (!arc) return null;
  const a0 = Number(arc.startingAngle) || 0, a1 = Number(arc.endingAngle), inner = Number(arc.innerRadius) || 0;
  if (!(isFinite(a1)) || f32(a1 - a0) >= f32(2 * Math.PI)) return null;
  const rx = w / 2, ry = h / 2, steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (2 * Math.PI) * 64));
  const at = (a, r) => r4(rx + r * rx * Math.cos(a)) + " " + r4(ry + r * ry * Math.sin(a));
  const outer = [];
  for (let k = 0; k <= steps; k++) outer.push(at(a0 + (a1 - a0) * k / steps, 1));
  if (!(inner > 0)) return "M " + r4(rx) + " " + r4(ry) + " L " + outer.join(" L ") + " Z";
  const back = [];
  for (let k = steps; k >= 0; k--) back.push(at(a0 + (a1 - a0) * k / steps, inner));
  return "M " + outer.join(" L ") + " L " + back.join(" L ") + " Z";
}
// Figma stretches a polygon or a star to fill its box: the points of the regular shape, starting at
// the top, scaled so their own bounds are the node's box.
function fitted(points, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const sx = x1 > x0 ? w / (x1 - x0) : 0, sy = y1 > y0 ? h / (y1 - y0) : 0;
  const q = points.map(([x, y]) => [(x - x0) * sx, (y - y0) * sy]);
  return "M " + q.map((p) => r4(p[0]) + " " + r4(p[1])).join(" L ") + " Z";
}
export function polygonPath(n, w, h) {
  n = Math.max(3, Math.round(n || 3));
  const pts = [];
  for (let k = 0; k < n; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / n; pts.push([Math.cos(a), Math.sin(a)]); }
  return fitted(pts, w, h);
}
export function starPath(n, inner, w, h) {
  n = Math.max(3, Math.round(n || 5));
  const ir = typeof inner === "number" ? inner : 0.382, pts = [];
  for (let k = 0; k < 2 * n; k++) { const a = -Math.PI / 2 + k * Math.PI / n, r = k % 2 ? ir : 1; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
  return fitted(pts, w, h);
}

// ---------- vector networks ----------
export function networkPathAll(net) {
  const V = net.vertices || [], parts = [];
  for (const s of net.segments || []) {
    const a = V[s.start], b = V[s.end];
    if (!a || !b) continue;
    const t1 = s.tangentStart || { x: 0, y: 0 }, t2 = s.tangentEnd || { x: 0, y: 0 };
    if (!t1.x && !t1.y && !t2.x && !t2.y) parts.push("M " + r4(a.x) + " " + r4(a.y) + " L " + r4(b.x) + " " + r4(b.y));
    else parts.push("M " + r4(a.x) + " " + r4(a.y) + " C " + r4(a.x + t1.x) + " " + r4(a.y + t1.y) + " " + r4(b.x + t2.x) + " " + r4(b.y + t2.y) + " " + r4(b.x) + " " + r4(b.y));
  }
  for (const v of V) parts.push("M " + r4(v.x) + " " + r4(v.y) + " L " + r4(v.x) + " " + r4(v.y));
  return parts.join(" ");
}
export function networkBox(net) { return pathBox(networkPathAll(net)); }
// The network moved by (dx, dy): vertices move, tangents are relative and stay.
export function shiftNetwork(net, dx, dy) {
  return Object.assign({}, net, { vertices: (net.vertices || []).map((v) => Object.assign({}, v, { x: v.x + dx, y: v.y + dy })) });
}
export function scaleNetwork(net, sx, sy) {
  return Object.assign({}, net, {
    vertices: (net.vertices || []).map((v) => Object.assign({}, v, { x: v.x * sx, y: v.y * sy })),
    segments: (net.segments || []).map((s) => {
      const o = Object.assign({}, s);
      if (s.tangentStart) o.tangentStart = { x: s.tangentStart.x * sx, y: s.tangentStart.y * sy };
      if (s.tangentEnd) o.tangentEnd = { x: s.tangentEnd.x * sx, y: s.tangentEnd.y * sy };
      return o;
    }) });
}

// ---------- booleans ----------
const CELLS = 512, MIN_CELL = 0.05;

function rasterise(paths, box, cell, nx, ny) {
  const mask = new Uint8Array(nx * ny);
  for (const p of paths) {
    const edges = [];
    for (const sub of parsePath(p.data)) {
      const pts = flatten(sub);
      if (pts.length < 2) continue;
      // A fill closes every subpath, written Z or not.
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
      }
    }
    const evenodd = p.windingRule === "EVENODD";
    for (let j = 0; j < ny; j++) {
      const y = box.y0 + (j + 0.5) * cell, xs = [];
      for (const e of edges) if (y >= e[1] && y < e[3]) xs.push([e[0] + (y - e[1]) * (e[2] - e[0]) / (e[3] - e[1]), e[4]]);
      if (!xs.length) continue;
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let k = 0; k < xs.length - 1; k++) {
        wind += evenodd ? 1 : xs[k][1];
        const inside = evenodd ? wind % 2 === 1 : wind !== 0;
        if (!inside) continue;
        const i0 = Math.max(0, Math.ceil((xs[k][0] - box.x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1][0] - box.x0) / cell - 0.5));
        for (let i = i0; i <= i1; i++) mask[j * nx + i] = 1;
      }
    }
  }
  return mask;
}

// Outline loops of a cell mask, as grid-vertex polygons with the filled side on the right.
function trace(mask, nx, ny) {
  const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? mask[j * nx + i] : 0);
  const next = new Map(); // "x,y" -> [[x,y], …] edges starting there
  const add = (x0, y0, x1, y1) => { const k = x0 + "," + y0; (next.get(k) || next.set(k, []).get(k)).push([x1, y1]); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!mask[j * nx + i]) continue;
    if (!at(i, j - 1)) add(i, j, i + 1, j);
    if (!at(i + 1, j)) add(i + 1, j, i + 1, j + 1);
    if (!at(i, j + 1)) add(i + 1, j + 1, i, j + 1);
    if (!at(i - 1, j)) add(i, j + 1, i, j);
  }
  const loops = [];
  for (const [k0] of next) {
    while ((next.get(k0) || []).length) {
      const loop = [];
      let k = k0, prev = null;
      for (let guard = 0; guard < 4 * nx * ny + 8; guard++) {
        const outs = next.get(k);
        if (!outs || !outs.length) break;
        const [x, y] = k.split(",").map(Number);
        // At a vertex two loops touch (a checkerboard corner) take the right turn, so loops stay simple.
        let pick = 0;
        if (outs.length > 1 && prev) {
          const dx = x - prev[0], dy = y - prev[1];
          const rx = -dy, ry = dx;
          pick = Math.max(0, outs.findIndex((o) => o[0] - x === rx && o[1] - y === ry));
        }
        const o = outs.splice(pick, 1)[0];
        loop.push([x, y]);
        prev = [x, y];
        k = o[0] + "," + o[1];
        if (k === k0 && !(next.get(k0) || []).length) break;
        if (k === k0) break;
      }
      // Drop the points in the middle of a straight run.
      const simple = loop.filter((p, idx) => {
        const a = loop[(idx - 1 + loop.length) % loop.length], b = loop[(idx + 1) % loop.length];
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) !== 0;
      });
      if (simple.length >= 3) loops.push(simple);
    }
  }
  return loops;
}

function coords(paths) {
  const xs = [], ys = [];
  for (const p of paths) {
    const b = pathBox(p.data);
    if (b) { xs.push(b.x0, b.x1); ys.push(b.y0, b.y1); }
    for (const s of parsePath(p.data)) {
      xs.push(s.start[0]); ys.push(s.start[1]);
      for (const g of s.segs) { const e = g.pts[g.pts.length - 1]; xs.push(e[0]); ys.push(e[1]); }
    }
  }
  return { xs, ys };
}
function snapTo(v, list, tol) {
  let best = v, d = tol;
  for (const c of list) { const e = Math.abs(c - v); if (e <= d) { d = e; best = c; } }
  return best;
}

export function booleanResult(op, operands) {
  const all = [];
  for (const o of operands) for (const p of o.paths || []) all.push(p);
  const boxes = operands.map((o) => pathsBox(o.paths || []));
  const total = unionBounds(boxes.filter(Boolean));
  if (!total) return { paths: [], box: null };
  // A UNION's box is its operands' box, exactly (curves included).
  const w = total.x1 - total.x0, h = total.y1 - total.y0;
  const cell = Math.max(MIN_CELL, Math.max(w, h) / CELLS);
  const nx = Math.max(1, Math.ceil(w / cell)), ny = Math.max(1, Math.ceil(h / cell));
  const masks = operands.map((o) => rasterise(o.paths || [], total, cell, nx, ny));
  const res = new Uint8Array(nx * ny);
  for (let c = 0; c < res.length; c++) {
    if (op === "UNION") res[c] = masks.some((m) => m[c]) ? 1 : 0;
    else if (op === "INTERSECT") res[c] = masks.every((m) => m[c]) ? 1 : 0;
    else if (op === "EXCLUDE") res[c] = masks.reduce((n, m) => n + m[c], 0) % 2;
    else res[c] = masks[0][c] && !masks.slice(1).some((m) => m[c]) ? 1 : 0;
  }
  const loops = trace(res, nx, ny);
  if (!loops.length) return { paths: [], box: null };
  const { xs, ys } = coords(all);
  const subs = loops.map((loop) => {
    const pts = loop.map(([i, j]) => [snapTo(total.x0 + i * cell, xs, cell), snapTo(total.y0 + j * cell, ys, cell)]);
    return { start: pts[0], segs: pts.slice(1).concat([pts[0]]).map((p) => ({ op: "L", pts: [p] })), closed: true };
  });
  const data = formatPath(subs);
  const box = op === "UNION" ? total : pathBox(data);
  return { paths: [{ windingRule: op === "EXCLUDE" ? "EVENODD" : "NONZERO", data }], box };
}

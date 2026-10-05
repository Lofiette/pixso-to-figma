// Exact bounds of Figma path strings, used on every side of the vector check (docs/M1.md §6 A, §6 C):
// the reader classifies network-bounds disagreements with it, the plugin's VERIFY bounds every built
// fill path with it, and the judge bounds the IR's oracle with it, so no two sides can disagree by
// method. Part P0 wrote it, because part A needs it before part C lands; part C owns it from then on.
//
// Bundled into the plugin as PXF_PATHGEOM (tools/build-plugin.mjs): no import, no Node built-in,
// ES2015, `export const` / `export function` at the start of a line only.
//
// CONTRACT (frozen by P0):
//
//   pathBounds(data, matrix?) -> [{ x0, y0, x1, y1 }]
//     data    a Figma path string: M, L, Q, C and Z, every letter and number separated by white space
//             (schema.figmaPathError(data) === null)
//     matrix  optional 2x3 affine [[a, b, tx], [c, d, ty]], applied to every point before bounding;
//             absent means the identity
//     returns one box per subpath (each M starts one), in path order, from the exact extrema of every
//             segment: the end points, and for Q and C the curve's own extrema (the roots of its
//             derivative inside (0, 1)), never the control hull. An empty path gives [].
//     throws  an Error whose message starts "pathBounds:" on a string that is not a Figma path.
//
//   unionBounds(boxes) -> { x0, y0, x1, y1 } | null     the box around all of them; null for none
//
// Added by part C: the one per-path summary VERIFY (in the plugin) and the judge (in Node) both take,
// so the two sides of the vector check cannot differ by method (docs/M1.md §6 C, §8.3):
//
//   geometryBounds(geometry, matrix?) -> [[winding, x0, y0, x1, y1, subpaths]]
//     geometry  [{ windingRule, data }]: a Figma fillGeometry list, or the IR's oracleFillGeometry
//               or fillGeometry value; null or undefined gives []
//     returns   one entry per path, in order: its winding rule, the union of its subpath boxes under
//               the matrix, and its subpath count. A path with no subpath gives 0, 0, 0, 0 and 0
//               subpaths, so the path count is kept.
//     throws    "geometryBounds: …" on a list that is not of that shape, "pathBounds: …" on bad data
//
//   inBox(inner, outer, tol) -> boolean     inner { x0, y0, x1, y1 } lies inside outer grown by tol
//
// An affine map takes a Bézier curve to the Bézier curve of the mapped control points, so the
// matrix is applied to the control points and the extrema are found on the mapped curve: a rotated
// curve is bounded exactly, not by its rotated box.

export const PATHGEOM_IMPLEMENTED = true;

const ARGS = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

// The roots in (0, 1) of a t^2 + b t + c.
function unitRoots(a, b, c) {
  const out = [];
  const EPS = 1e-12;
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) >= EPS) out.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

export function pathBounds(data, matrix) {
  if (typeof data !== "string") throw new Error("pathBounds: a path is a string");
  const text = data.trim();
  if (!text) return [];
  const m = matrix === undefined || matrix === null ? null : matrix;
  if (m !== null && !(Array.isArray(m) && m.length === 2 && m.every((r) => Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === "number" && isFinite(x))))) {
    throw new Error("pathBounds: the matrix is [[a, b, tx], [c, d, ty]] of finite numbers");
  }
  const map = (x, y) => (m === null ? [x, y] : [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]]);
  const tok = text.split(/\s+/);
  const boxes = [];
  let box = null, cur = null, start = null;
  const grow = (p) => {
    if (p[0] < box.x0) box.x0 = p[0];
    if (p[0] > box.x1) box.x1 = p[0];
    if (p[1] < box.y0) box.y0 = p[1];
    if (p[1] > box.y1) box.y1 = p[1];
  };
  let i = 0;
  while (i < tok.length) {
    const c = tok[i];
    if (!Object.prototype.hasOwnProperty.call(ARGS, c)) throw new Error("pathBounds: token " + (i + 1) + " is " + JSON.stringify(c).slice(0, 40) + ", not one of M L Q C Z");
    if (box === null && c !== "M") throw new Error("pathBounds: a path starts with M");
    const n = ARGS[c], v = [];
    for (let k = 1; k <= n; k++) {
      const s = tok[i + k];
      if (s === undefined) throw new Error("pathBounds: " + c + " at token " + (i + 1) + " needs " + n + " numbers");
      if (!NUM.test(s) || !isFinite(Number(s))) throw new Error("pathBounds: token " + (i + k + 1) + " is " + JSON.stringify(s).slice(0, 40) + ", not a number");
      v.push(Number(s));
    }
    i += n + 1;
    if (c === "M") {
      const p = map(v[0], v[1]);
      box = { x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
      boxes.push(box);
      cur = p; start = p;
    } else if (c === "L") {
      const p = map(v[0], v[1]);
      grow(p); cur = p;
    } else if (c === "Z") {
      cur = start;
    } else if (c === "Q") {
      const p0 = cur, p1 = map(v[0], v[1]), p2 = map(v[2], v[3]);
      grow(p2);
      for (let ax = 0; ax < 2; ax++) {
        // B'(t) = 2[(1-t)(p1-p0) + t(p2-p1)]: zero at t = (p0-p1) / (p0 - 2p1 + p2).
        for (const t of unitRoots(0, p0[ax] - 2 * p1[ax] + p2[ax], p1[ax] - p0[ax])) {
          const u = 1 - t;
          grow([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
        }
      }
      cur = p2;
    } else {
      const p0 = cur, p1 = map(v[0], v[1]), p2 = map(v[2], v[3]), p3 = map(v[4], v[5]);
      grow(p3);
      for (let ax = 0; ax < 2; ax++) {
        // B'(t)/3 = a t^2 + b t + c with a = -p0 + 3p1 - 3p2 + p3, b = 2(p0 - 2p1 + p2), c = p1 - p0.
        const a = -p0[ax] + 3 * p1[ax] - 3 * p2[ax] + p3[ax], b = 2 * (p0[ax] - 2 * p1[ax] + p2[ax]), cc = p1[ax] - p0[ax];
        for (const t of unitRoots(a, b, cc)) {
          const u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
          grow([w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0], w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]]);
        }
      }
      cur = p3;
    }
  }
  return boxes;
}

export function unionBounds(boxes) {
  if (!Array.isArray(boxes)) throw new Error("unionBounds: a list of boxes");
  let u = null;
  for (const b of boxes) {
    if (!b || typeof b !== "object" || !["x0", "y0", "x1", "y1"].every((k) => typeof b[k] === "number" && isFinite(b[k]))) throw new Error("unionBounds: a box is { x0, y0, x1, y1 }");
    if (u === null) u = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    else { u.x0 = Math.min(u.x0, b.x0); u.y0 = Math.min(u.y0, b.y0); u.x1 = Math.max(u.x1, b.x1); u.y1 = Math.max(u.y1, b.y1); }
  }
  return u;
}

export function geometryBounds(geometry, matrix) {
  if (geometry === null || geometry === undefined) return [];
  if (!Array.isArray(geometry)) throw new Error("geometryBounds: a geometry is a list of { windingRule, data }");
  const out = [];
  for (let k = 0; k < geometry.length; k++) {
    const g = geometry[k];
    if (!g || typeof g !== "object" || typeof g.data !== "string") throw new Error("geometryBounds: path " + k + " is not { windingRule, data }");
    const boxes = pathBounds(g.data, matrix);
    const u = unionBounds(boxes);
    const w = typeof g.windingRule === "string" ? g.windingRule : "NONZERO";
    out.push(u === null ? [w, 0, 0, 0, 0, 0] : [w, u.x0, u.y0, u.x1, u.y1, boxes.length]);
  }
  return out;
}

export function inBox(inner, outer, tol) {
  const t = typeof tol === "number" && isFinite(tol) ? tol : 0;
  return inner.x0 >= outer.x0 - t && inner.y0 >= outer.y0 - t && inner.x1 <= outer.x1 + t && inner.y1 <= outer.y1 + t;
}

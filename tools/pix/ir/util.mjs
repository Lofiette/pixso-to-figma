// Small shared helpers of the .pix → IR reader: rounding (docs/IR.md §2), Figma path strings from
// Pixso path blobs, and the flattening the side oracle samples.
import { decodePath } from "../../kiwi.mjs";

const fin = (x) => typeof x === "number" && isFinite(x);
// Rounding on write (IR.md §2): four decimals for transforms, six for normalised quantities, two for
// pixels. -0 is written as 0, so two equal values never differ by their sign.
const round = (x, k) => { const v = Math.round(x * k) / k; return v === 0 ? 0 : v; };
export const r2 = (x) => (fin(x) ? round(x, 100) : x);
export const r4 = (x) => (fin(x) ? round(x, 10000) : x);
export const r6 = (x) => (fin(x) ? round(x, 1e6) : x);
export const isFin = fin;

// A path blob ([opcode][f32 x, y]*: 1 M, 2 L, 4 C, 0 Z) as a Figma path string, pixels at two
// decimals. Coordinates may be mapped (a network's scale). A blob whose first command is not a move
// starts at the origin, as a renderer would. Returns null for an empty blob.
export function blobToFigmaPath(blob, map) {
  const cmds = decodePath(blob);
  if (!cmds.length) return null;
  const out = [];
  const pt = (p) => { const q = map ? map(p) : p; return String(r2(q[0])) + " " + String(r2(q[1])); };
  if (cmds[0].op !== 1) out.push("M 0 0");
  for (const c of cmds) {
    if (c.op === 1) out.push("M " + pt(c.pts[0]));
    else if (c.op === 2) out.push("L " + pt(c.pts[0]));
    else if (c.op === 4) out.push("C " + pt(c.pts[0]) + " " + pt(c.pts[1]) + " " + pt(c.pts[2]));
    else if (c.op === 0) out.push("Z");
  }
  return out.join(" ");
}

// The polylines of a path blob (cubics cut into 16 segments), each subpath closed implicitly; the
// side oracle's point-in-shape test runs on these (docs/M1.md §1.2).
export function blobPolylines(blob) {
  const cmds = decodePath(blob);
  const subs = [];
  let cur = null, last = null, start = null;
  for (const c of cmds) {
    if (c.op === 1) { cur = [c.pts[0]]; subs.push(cur); last = start = c.pts[0]; }
    else if (c.op === 2) { if (!cur) { cur = [last || [0, 0]]; subs.push(cur); } cur.push(c.pts[0]); last = c.pts[0]; }
    else if (c.op === 4) {
      if (!cur) { cur = [last || [0, 0]]; subs.push(cur); }
      const p0 = last || [0, 0], [p1, p2, p3] = c.pts;
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        cur.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
      }
      last = p3;
    } else if (c.op === 0) { last = start; cur = null; }
  }
  return subs.filter((s) => s.length >= 2);
}

// Nonzero point-in-polygons.
export function insideAny(subs, x, y) {
  let w = 0;
  for (const p of subs) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) w += yi > yj ? 1 : -1;
  }
  return w !== 0;
}

// Plain bounds of the points of a path blob (end and control points), or null.
export function blobPointBounds(blob) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of decodePath(blob)) for (const [x, y] of c.pts) {
    if (!fin(x) || !fin(y)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

export const unionBox = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

// A Pixso Matrix as the IR's [a, b, tx, c, d, ty] (Figma's [[a, b, tx], [c, d, ty]]).
export const matrixOf = (m) => [m.m00, m.m01, m.m02, m.m10, m.m11, m.m12];
export const matrixFinite = (m) => !!m && [m.m00, m.m01, m.m02, m.m10, m.m11, m.m12].every(fin);
// A box mapped by a Pixso Matrix.
export function mapBox(m, b) {
  const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => [m.m00 * x + m.m01 * y + m.m02, m.m10 * x + m.m11 * y + m.m12]);
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}

// Code points of a string, and UTF-16 offsets of each code point (offsets[k] = start of code point
// k, offsets[count] = length).
export function codePointOffsets(s) {
  const offs = [];
  let i = 0;
  while (i < s.length) {
    offs.push(i);
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff ? 2 : 1;
  }
  offs.push(s.length);
  return offs;
}

export const hex = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex");
export const guidStr = (g) => (g ? g.sessionID + ":" + g.localID : null);
// The two "no reference" values Pixso writes: 0:0 and all ones.
export const guidSet = (g) => !!g && !(g.sessionID === 0 && g.localID === 0) && !(g.sessionID === 0xffffffff && g.localID === 0xffffffff);

// A toy rasteriser: a box per node, filled with its solid paints. It gives the headless double an
// exportAsync that returns a real PNG, and the render audit's tests (tools/test-iraudit.mjs) a Pixso
// side drawn from the IR, so the audit's own rules (opacity, a section's margin, placeholder masks,
// crops, a missing render) can be tested offline. It is not Figma's renderer, nor Pixso's: no text,
// no vector paths (a text, a vector, a boolean, a star, a polygon or a line draws nothing), no strokes,
// no effects, no images, no gradients, no anti-aliasing. A node's box is the axis-aligned bounding box
// of its corners under its transform.
//
//   import { rasterize, pngOf } from "./raster.mjs";
//   const img = rasterize(tree, { scale, ownOpacity, margin });   // { W, H, rgba } (non-premultiplied RGBA)
//   const bytes = pngOf(img);                                     // a PNG (tools/pngutil.mjs)
//
// tree   { abs: [[a, b, tx], [c, d, ty]] (absolute), type, w, h, opacity, visible, clips, fills, children }
//        fills: [{ type, color: { r, g, b }, opacity, visible }]; only visible SOLID paints draw
// scale  pixels per node unit
// ownOpacity  whether the root's own opacity is applied (Figma's export: yes; Pixso's: no, docs/M1.md
//        §15.11). It is applied as a group opacity: the subtree is drawn whole, then its alpha scaled.
//        A descendant's opacity scales each of its paints (the same rule on both sides).
// margin node units of empty space around the root's box on every side (a model of Figma's wider
//        margin around an exported SECTION, §15.11: that it is wider is measured, how much is not)
import { encodePNG } from "../pngutil.mjs";

// Types whose drawing is a path or a glyph run, which this rasteriser does not draw.
export const NOT_DRAWN = ["TEXT", "VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"];

function boxOf(abs, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const x = abs[0][0] * cx + abs[0][1] * cy + abs[0][2], y = abs[1][0] * cx + abs[1][1] * cy + abs[1][2];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

export function rasterize(tree, opts) {
  const o = opts || {};
  const s = o.scale > 0 ? o.scale : 1, m = o.margin || 0;
  const rb = boxOf(tree.abs, tree.w, tree.h);
  const ox = rb[0] - m, oy = rb[1] - m;
  const W = Math.max(1, Math.round((rb[2] - rb[0] + 2 * m) * s)), H = Math.max(1, Math.round((rb[3] - rb[1] + 2 * m) * s));
  const rgba = Buffer.alloc(W * H * 4);
  const put = (px, py, c, a) => {
    if (a <= 0) return;
    const k = (py * W + px) * 4;
    const da = rgba[k + 3] / 255, oa = a + da * (1 - a);
    for (let q = 0; q < 3; q++) {
      const sc = c[q] * 255, dc = rgba[k + q];
      rgba[k + q] = Math.round(oa > 0 ? (sc * a + dc * da * (1 - a)) / oa : 0);
    }
    rgba[k + 3] = Math.round(oa * 255);
  };
  const fill = (box, clip, c, a) => {
    const x0 = Math.max(box[0], clip[0]), y0 = Math.max(box[1], clip[1]), x1 = Math.min(box[2], clip[2]), y1 = Math.min(box[3], clip[3]);
    if (!(x1 > x0 && y1 > y0)) return;
    // A pixel is covered when its centre is inside: [x0, x1) in node units.
    const p0 = Math.max(0, Math.ceil((x0 - ox) * s - 0.5)), p1 = Math.min(W, Math.ceil((x1 - ox) * s - 0.5));
    const q0 = Math.max(0, Math.ceil((y0 - oy) * s - 0.5)), q1 = Math.min(H, Math.ceil((y1 - oy) * s - 0.5));
    for (let py = q0; py < q1; py++) for (let px = p0; px < p1; px++) put(px, py, c, a);
  };
  const paint = (n, alpha, clip, isRoot) => {
    if (!n || n.visible === false) return;
    const own = typeof n.opacity === "number" ? n.opacity : 1;
    const a = isRoot ? alpha : alpha * own;
    const box = boxOf(n.abs, n.w, n.h);
    for (const f of NOT_DRAWN.indexOf(n.type) >= 0 ? [] : n.fills || []) {
      if (!f || f.type !== "SOLID" || f.visible === false || !f.color) continue;
      fill(box, clip, [f.color.r, f.color.g, f.color.b], a * (typeof f.opacity === "number" ? f.opacity : 1));
    }
    const inner = n.clips ? [Math.max(clip[0], box[0]), Math.max(clip[1], box[1]), Math.min(clip[2], box[2]), Math.min(clip[3], box[3])] : clip;
    if (NOT_DRAWN.indexOf(n.type) >= 0) return;   // a boolean's operands draw only through it
    for (const c of n.children || []) paint(c, a, inner, false);
  };
  paint(tree, 1, [-Infinity, -Infinity, Infinity, Infinity], true);
  const rootOpacity = typeof tree.opacity === "number" ? tree.opacity : 1;
  if (o.ownOpacity && rootOpacity < 1 && tree.visible !== false) {
    for (let k = 3; k < rgba.length; k += 4) rgba[k] = Math.round(rgba[k] * rootOpacity);
  }
  return { W, H, rgba };
}

export function pngOf(img) { return encodePNG(img.W, img.H, img.rgba); }

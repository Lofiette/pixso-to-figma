// Paints, effects and export settings, Pixso → Figma (docs/M1.md §6 A: the sanitisers of
// tools/pack4.mjs:99-144, ported to the .pix fields).
//
// What reaches the IR is exactly a Figma Paint / Effect / ExportSettings object: only the keys
// Figma's validator takes (pack4's IMG_OK and EFFECT_OK, per paint and effect type), image filters
// limited to Figma's (FILTER_OK), and an image rotation of 360 degrees or more named the way Figma
// names it. Colours 0-255 become 0-1 and a colour's alpha becomes the paint's opacity (IR.md §1).
// What Figma cannot hold is dropped and counted with SOURCE_FEATURE_UNSUPPORTED naming it.
import * as E from "./enums.mjs";
import { r2, r6, isFin, hex } from "./util.mjs";

const ch = (v) => r6((isFin(v) ? v : 0) / 255);
const rgb = (c) => ({ r: ch(c.r), g: ch(c.g), b: ch(c.b) });
const rgba = (c) => ({ r: ch(c.r), g: ch(c.g), b: ch(c.b), a: ch(c.a === undefined ? 255 : c.a) });
const matrix2x3 = (m) => [[r6(m.m00), r6(m.m01), r6(m.m02)], [r6(m.m10), r6(m.m11), r6(m.m12)]];
const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

// One paint, or null when Figma has no such paint. `en` resolves enum names by field.
export function paintOf(cx, p) {
  const type = cx.en("Paint", "type")(p.type);
  const ft = E.PAINT_TYPE[type];
  if (!ft) { cx.feature("paint type " + (type || "unknown")); return null; }
  const o = { type: ft };
  const visible = p.visible !== false;
  const opacity = p.opacity !== undefined ? p.opacity : p.color && p.color.a !== undefined ? p.color.a / 255 : 1;
  let blend = cx.en("Paint", "blendMode")(p.blendMode) || "NORMAL";
  if (blend === "PASS_THROUGH") blend = "NORMAL";
  if (ft === "SOLID") {
    o.color = rgb(p.color || { r: 0, g: 0, b: 0 });
  } else if (ft.indexOf("GRADIENT_") === 0) {
    o.gradientTransform = matrix2x3(p.transform || IDENTITY);
    o.gradientStops = (p.stops || []).map((s) => ({ color: rgba(s.color || { r: 0, g: 0, b: 0, a: 255 }), position: r6(s.position || 0) }));
  } else {
    // An image paint names its image: one with no hash would be the empty fill a missing image must
    // never become (IR.md §11), so it is dropped and counted instead.
    const h = p.image && p.image.hash && p.image.hash.length ? hex(p.image.hash) : null;
    if (!h || !/^[0-9a-f]{40}$/.test(h)) { cx.feature("image paint without an image"); return null; }
    const mode = E.SCALE_MODE[cx.en("Paint", "imageScaleMode")(p.imageScaleMode)] || "FILL";
    o.scaleMode = mode;
    o.imageHash = h;
    cx.imageRef(h);
    if (mode === "CROP") o.imageTransform = matrix2x3(p.transform || IDENTITY);
    if (mode === "TILE") o.scalingFactor = r6(isFin(p.scale) && p.scale > 0 ? p.scale : 1);
    if (mode !== "CROP" && isFin(p.rotation) && p.rotation !== 0) {
      // Figma refuses 360 degrees or more ("image rotation must be less than 360 degrees").
      const rot = ((p.rotation % 360) + 360) % 360;
      if (rot !== 0) o.rotation = r6(rot);
    }
    if (p.paintFilter) {
      const f = {};
      for (const k of E.IMAGE_FILTERS) if (isFin(p.paintFilter[k]) && p.paintFilter[k] !== 0) f[k] = r6(p.paintFilter[k]);
      if (Object.keys(f).length) o.filters = f;
      if (isFin(p.paintFilter.vibrance) && p.paintFilter.vibrance !== 0) cx.feature("vibrance");
      if (isFin(p.paintFilter.hue) && p.paintFilter.hue !== 0) cx.feature("hue filter");
    }
  }
  if (r6(opacity) !== 1) o.opacity = r6(opacity);
  if (!visible) o.visible = false;
  if (blend !== "NORMAL") o.blendMode = blend;
  return o;
}

export function paintsOf(cx, list) {
  const out = [];
  for (const p of list || []) { const q = paintOf(cx, p); if (q) out.push(q); }
  return out;
}

// Effects: per type exactly the keys Figma's validator takes (pack4 EFFECT_OK, split by type, because
// a blur with a colour is refused and the whole list lost).
export function effectsOf(cx, list) {
  const out = [];
  for (const e of list || []) {
    const t = E.EFFECT_TYPE[cx.en("Effect", "type")(e.type)];
    if (!t) { cx.feature("effect " + (cx.en("Effect", "type")(e.type) || "unknown")); continue; }
    const visible = e.visible !== false;
    if (t === "LAYER_BLUR" || t === "BACKGROUND_BLUR") {
      out.push({ type: t, radius: r2(isFin(e.radius) ? e.radius : 0), visible });
      continue;
    }
    let blend = cx.en("Effect", "blendMode")(e.blendMode) || "NORMAL";
    if (blend === "PASS_THROUGH") blend = "NORMAL";
    const o = { type: t, color: rgba(e.color || { r: 0, g: 0, b: 0, a: 255 }),
      offset: { x: r2(e.offset ? e.offset.x : 0), y: r2(e.offset ? e.offset.y : 0) },
      radius: r2(isFin(e.radius) ? e.radius : 0), spread: r2(isFin(e.spread) ? e.spread : 0), visible, blendMode: blend };
    if (t === "DROP_SHADOW") o.showShadowBehindNode = !!e.showShadowBehindNode;
    out.push(o);
  }
  return out;
}

export function exportSettingsOf(cx, list) {
  const out = [];
  for (const s of list || []) {
    const t = cx.en("ExportSettings", "imageType")(s.imageType);
    const format = E.EXPORT_FORMAT[t];
    if (!format) { cx.feature("export format " + (t || "unknown")); continue; }
    const o = { format, suffix: s.suffix || "" };
    if (format === "PNG" || format === "JPG") {
      const c = s.constraint || {};
      o.constraint = { type: E.EXPORT_CONSTRAINT[cx.en("ExportConstraint", "type")(c.type)] || "SCALE", value: r2(isFin(c.value) && c.value > 0 ? c.value : 1) };
    }
    out.push(o);
  }
  return out;
}

// A page's own background, from the canvas: its paints, or its colour unless it is switched off.
export function backgroundOf(cx, canvas) {
  if ((canvas.backgroundPaints || []).length) return paintsOf(cx, canvas.backgroundPaints);
  if (canvas.backgroundColor && canvas.backgroundEnabled !== false) {
    const c = canvas.backgroundColor;
    const p = { type: "SOLID", color: rgb(c) };
    const a = r6((isFin(c.a) ? c.a : 255) / 255);
    if (a !== 1) p.opacity = a;
    return [p];
  }
  return null;
}


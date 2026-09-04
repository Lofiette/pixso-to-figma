// IR + SVG assets + absolute transforms -> PNG data carrier.
// usage: node pack4.mjs <ir.json> <rootId> <svg.json> <bounds.json> <abs.json> <out.png>
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { BUILDER_SRC, VERIFIER_SRC } from "./builder4.js";

const [, , IR_PATH, ROOT_ID, SVG_PATH, BOUNDS_PATH, ABS_PATH, OUT = "out/payload.png", TEXTINK_PATH, TEXTSVG_PATH] = process.argv;
const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));
const SVG = JSON.parse(readFileSync(SVG_PATH, "utf8"));
const BOUNDS = JSON.parse(readFileSync(BOUNDS_PATH, "utf8"));
const ABS = JSON.parse(readFileSync(ABS_PATH, "utf8"));
const TEXTINK = TEXTINK_PATH ? JSON.parse(readFileSync(TEXTINK_PATH, "utf8")) : {};
const TEXTSVG = TEXTSVG_PATH ? JSON.parse(readFileSync(TEXTSVG_PATH, "utf8")) : {};

let target = null;
(function w(n) { if (n.id === ROOT_ID) { target = n; return; } if (n.children) n.children.forEach(w); })(ir.tree);
if (!target) { console.error("not found: " + ROOT_ID); process.exit(1); }

const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);

// matrix helpers: [a,b,tx,c,d,ty] == [[a,b,tx],[c,d,ty]]
const inv = (m) => { const a = m[0], b = m[1], tx = m[2], c = m[3], d = m[4], ty = m[5], det = a * d - b * c;
  return [d / det, -b / det, (b * ty - d * tx) / det, -c / det, a / det, (c * tx - a * ty) / det]; };
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
  m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5]];

const A = { name: "a", type: "b", visible: "c", locked: "d", opacity: "e", blendMode: "f", isMask: "g",
  width: "j", height: "k", clipsContent: "m", cornerRadius: "n", topLeftRadius: "o",
  topRightRadius: "p", bottomLeftRadius: "q", bottomRightRadius: "r", cornerSmoothing: "s", strokeWeight: "t",
  strokeAlign: "u", strokeJoin: "v", dashPattern: "w", layoutMode: "y", layoutWrap: "z",
  primaryAxisSizingMode: "A", counterAxisSizingMode: "B", primaryAxisAlignItems: "C",
  counterAxisAlignItems: "D", paddingLeft: "E", paddingRight: "F", paddingTop: "G", paddingBottom: "H",
  itemSpacing: "I", counterAxisSpacing: "J", layoutAlign: "K", layoutGrow: "L", layoutPositioning: "M",
  fills: "N", strokes: "O", effects: "P", constraints: "Q", characters: "S", fontSize: "T",
  fontName: "U", textAlignHorizontal: "V", textAlignVertical: "W", textAutoResize: "X", textCase: "Y",
  textDecoration: "Z", letterSpacing: "0", lineHeight: "1", paragraphIndent: "2", paragraphSpacing: "3" };
const DROP = { visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", isMask: false,
  cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0,
  cornerSmoothing: 0, strokeWeight: 1, strokeAlign: "INSIDE", strokeJoin: "MITER", layoutMode: "NONE",
  layoutWrap: "NO_WRAP", layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO", paddingLeft: 0,
  paddingRight: 0, paddingTop: 0, paddingBottom: 0, itemSpacing: 0, counterAxisSpacing: 0, paragraphIndent: 0,
  paragraphSpacing: 0, textCase: "ORIGINAL", textDecoration: "NONE", textAlignVertical: "TOP" };
const STROKED = new Set(["ELLIPSE", "RECTANGLE"]);
const INTERN = new Set(["fills", "strokes", "effects", "constraints", "fontName", "letterSpacing", "lineHeight", "dashPattern"]);

const r2 = (x) => (typeof x === "number" && isFinite(x)) ? Math.round(x * 100) / 100 : x;
const r4 = (x) => (typeof x === "number" && isFinite(x)) ? Math.round(x * 10000) / 10000 : x;
function round(v) {
  if (typeof v === "number") return r2(v);
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = round(v[k]); return o; }
  return v;
}
const FILTER_OK = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
const IMG_OK = new Set(["type", "scaleMode", "imageHash", "imageTransform", "scalingFactor", "rotation", "filters", "visible", "opacity", "blendMode"]);
function sanitizePaints(v) {
  if (!Array.isArray(v)) return v;
  return v.map((p) => {
    if (!p || p.type !== "IMAGE") return p;
    const o = {}; for (const k of Object.keys(p)) if (IMG_OK.has(k)) o[k] = p[k];
    if (o.filters) { const f = {}; for (const k of FILTER_OK) if (o.filters[k] !== undefined) f[k] = o.filters[k]; o.filters = f; }
    return o;
  });
}

const svgList = [], svgIdx = new Map();
for (const h of Object.keys(SVG.assets)) { svgIdx.set(h, svgList.length); svgList.push(SVG.assets[h]); }
const textSvgIdx = new Map();
for (const k of Object.keys(TEXTSVG)) { textSvgIdx.set(k, svgList.length); svgList.push(TEXTSVG[k].s); }

const dict = [], dictIdx = new Map();
const intern = (v0) => { const v = round(v0); const k = JSON.stringify(v);
  if (dictIdx.has(k)) return dictIdx.get(k);
  const i = dict.length; dict.push(v); dictIdx.set(k, i); return i; };

const fonts = new Map(), flat = [];
let svgNodes = 0, missingSvg = 0, missingAbs = 0, arbFallback = 0, alRotSwap = 0, textAsSvg = 0, inkTagged = 0, inkOffset = 0;

// Pixso returns absoluteRenderBounds = null for many nodes, and absoluteBoundingBox excludes the
// stroke, while the exported SVG is always sized to the render bounds. Recover the render box from
// the SVG's own viewBox, outset symmetrically around the geometry box.
const vbCache = new Map();
function viewBox(svg) {
  if (vbCache.has(svg)) return vbCache.get(svg);
  const m = /viewBox="([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)"/.exec(svg);
  const v = m ? { w: parseFloat(m[3]), h: parseFloat(m[4]) } : null;
  vbCache.set(svg, v); return v;
}

function encode(n, path, parentIdx, parentAbs, parentNode) {
  const key = path.join(".");
  const absArr = ABS[key];
  const abs = absArr ? absArr.slice() : null;
  if (!abs) missingAbs++;
  const parentAL = !!(parentNode && parentNode.layoutMode && parentNode.layoutMode !== "NONE");

  const o = {};
  if (VEC.has(n.type)) {
    const ref = SVG.refs[key];
    const b = BOUNDS[key];
    let box = b && b.arb;
    if (!box && b && b.abb) {
      const vb = viewBox(SVG.assets[ref]);
      box = vb
        ? { x: b.abb.x - (vb.w - b.abb.width) / 2, y: b.abb.y - (vb.h - b.abb.height) / 2, width: vb.w, height: vb.h }
        : b.abb;
      arbFallback++;
    }
    if (ref !== undefined && box) {
      svgNodes++;
      // The wrapper frame must occupy the LAYOUT box the source node occupied, not its inked box.
      // A 1 px hairline is a zero-height LINE with a 1 px stroke: sizing the wrapper to the ink
      // adds a pixel per item inside an auto-layout, and the error accumulates down the stack.
      // So: wrapper = geometry box, and the ink is offset inside it by the difference.
      const lay = (b && b.abb) ? b.abb : box;
      o["6"] = svgIdx.get(ref);
      o["7"] = mul(inv(parentAbs), [1, 0, lay.x, 0, 1, lay.y]).map(r4);
      o.j = r2(lay.width); o.k = r2(lay.height);
      const ix = box.x - lay.x, iy = box.y - lay.y;
      if (Math.abs(ix) > 0.001 || Math.abs(iy) > 0.001 || Math.abs(box.width - lay.width) > 0.001 || Math.abs(box.height - lay.height) > 0.001) {
        o["9"] = [r4(ix), r4(iy)];
        inkOffset++;
      }
      o.a = n.name; o.b = "SVG";
      if (n.visible === false) o.c = false;
      if (n.opacity !== undefined && n.opacity !== 1) o.e = n.opacity;
      if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") o.f = n.blendMode;
      if (n.isMask) o.g = true;
      if (n.constraints && !(n.constraints.horizontal === "MIN" && n.constraints.vertical === "MIN")) o.Q = intern(n.constraints);
      if (n.layoutAlign && n.layoutAlign !== "INHERIT") o.K = n.layoutAlign;
      if (n.layoutGrow) o.L = n.layoutGrow;
      if (n.layoutPositioning && n.layoutPositioning !== "AUTO") o.M = n.layoutPositioning;
      if (n.effects && n.effects.length) o.P = intern(n.effects);
      const si = flat.length; flat.push({ p: parentIdx, d: o });
      return si;
    }
    missingSvg++;
  }

  // Pixso will not disclose some instance text overrides through any API (characters,
  // componentProperties, overrides, DSL, design_to_code all return the component default) while its
  // renderer draws the real string. For those nodes the render is the only faithful source.
  if (n.type === "TEXT" && textSvgIdx.has(key) && abs) {
    textAsSvg++;
    o["6"] = textSvgIdx.get(key);
    o["7"] = mul(inv(parentAbs), abs).map(r4);
    o.j = r2(n.width); o.k = r2(n.height);
    o.a = n.name; o.b = "SVG";
    if (n.visible === false) o.c = false;
    if (n.opacity !== undefined && n.opacity !== 1) o.e = n.opacity;
    if (n.constraints && !(n.constraints.horizontal === "MIN" && n.constraints.vertical === "MIN")) o.Q = intern(n.constraints);
    if (n.layoutAlign && n.layoutAlign !== "INHERIT") o.K = n.layoutAlign;
    if (n.layoutGrow) o.L = n.layoutGrow;
    if (n.layoutPositioning && n.layoutPositioning !== "AUTO") o.M = n.layoutPositioning;
    const ti = flat.length; flat.push({ p: parentIdx, d: o });
    return ti;
  }

  for (const k of Object.keys(n)) {
    if (k === "children") continue;
    const a = A[k]; if (!a) continue;
    const v = n[k];
    if (v === null || v === undefined || v === "unable") continue;
    if (v && typeof v === "object" && v.__mixed) continue;
    if (k in DROP && JSON.stringify(v) === JSON.stringify(DROP[k])) continue;
    if (k === "strokes" && Array.isArray(v) && v.length === 0 && !STROKED.has(n.type)) continue;
    if (k === "constraints" && v.horizontal === "MIN" && v.vertical === "MIN") continue;
    if (k === "fontName" && v.family) fonts.set(v.family + "|" + v.style, v.family + " " + v.style);
    const vv = (k === "fills" || k === "strokes") ? sanitizePaints(v) : v;
    o[a] = INTERN.has(k) && typeof vv === "object" ? intern(vv) : round(vv);
  }
  if (n.type === "TEXT") {
    const ti = TEXTINK[key];
    if (ti && ti.arb && typeof n.characters === "string" && n.characters.indexOf(String.fromCharCode(10)) < 0) { o["8"] = r2(ti.arb.width); inkTagged++; }
  }
  if (abs && parentAbs) {
    const rt = mul(inv(parentAbs), abs);
    // Figma ignores rotation on auto-layout flow children; Pixso does not. For the quarter-turn
    // cases that actually occur, bake the turn into the size instead of losing it.
    if (parentAL && o.M !== "ABSOLUTE" && Math.abs(Math.abs(rt[1]) - 1) < 1e-3 &&
        o.j !== undefined && o.k !== undefined) {
      // Bake the quarter turn into the size AND flatten the matrix, so stored size and stored
      // transform keep describing the same box.
      const w = o.j, h = o.k;
      let mx = Infinity, my = Infinity;
      for (const c of [[0, 0], [w, 0], [w, h], [0, h]]) {
        const px = rt[0] * c[0] + rt[1] * c[1] + rt[2], py = rt[3] * c[0] + rt[4] * c[1] + rt[5];
        if (px < mx) mx = px; if (py < my) my = py;
      }
      o.j = h; o.k = w; alRotSwap++;
      o["7"] = [1, 0, r4(mx), 0, 1, r4(my)];
    } else o["7"] = rt.map(r4);
  }

  const idx = flat.length;
  flat.push({ p: parentIdx, d: o });
  const nextAbs = abs || parentAbs;
  (n.children || []).forEach((c, i) => encode(c, path.concat(i), idx, nextAbs, n));
  return idx;
}

const rootAbs = ABS[""] || [1, 0, 0, 0, 1, 0];
encode(target, [], -1, rootAbs, null);

const json = Buffer.from(JSON.stringify({ D: dict, S: svgList, F: flat, B: BUILDER_SRC, V: VERIFIER_SRC }), "utf8");
const body = Buffer.alloc(4 + json.length);
body.writeUInt32BE(json.length, 0); json.copy(body, 4);

const W = Math.max(2048, Math.ceil(Math.sqrt(body.length)));
const H = Math.ceil(body.length / W);
if (H > 4000 || W > 4000) console.error("WARN carrier " + W + "x" + H + " — Figma may resample above 4096 px");
const raw = Buffer.alloc(H * (W + 1));
for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; body.copy(raw, y * (W + 1) + 1, y * W, Math.min(body.length, (y + 1) * W)); }
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function mk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mk("IHDR", ihdr),
  mk("IDAT", deflateSync(raw, { level: 0 })), mk("IEND", Buffer.alloc(0))]);
writeFileSync(OUT, png);

console.log("root:        " + target.type + " " + JSON.stringify(target.name));
console.log("nodes:       " + flat.length + "  (svg " + svgNodes + ", dict " + dict.length + ", svg assets " + svgList.length + ")");
console.log("missing:     svg " + missingSvg + ", abs " + missingAbs);
console.log("recovered:   " + arbFallback + " render boxes from viewBox, " + alRotSwap + " auto-layout quarter turns baked into size, " + inkOffset + " svg wrappers with ink outside the layout box");
console.log("text:        " + textAsSvg + " rendered as svg (undisclosed override), " + inkTagged + " tagged with inked width");
console.log("fonts:       " + [...fonts.values()].join(", "));
console.log("json:        " + json.length.toLocaleString() + " bytes");
console.log("png:         " + png.length.toLocaleString() + " bytes (" + W + "x" + H + ") -> " + OUT);

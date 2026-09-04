// Turn an IR subtree into a self-contained use_figma payload.
// usage: node tools/gen-import.mjs <ir.json> <rootId> [out.js]
import { readFileSync, writeFileSync } from "node:fs";

const [, , IR_PATH, ROOT_ID, OUT = "out/import-payload.js"] = process.argv;
const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));

let target = null;
(function w(n) { if (n.id === ROOT_ID) { target = n; return; } if (n.children) n.children.forEach(w); })(ir.tree);
if (!target) { console.error("node not found: " + ROOT_ID); process.exit(1); }

// Properties the builder actually applies, per category.
const GEOM = ["x", "y", "width", "height", "rotation"];
const VIS = ["visible", "locked", "opacity", "blendMode", "isMask", "clipsContent", "cornerSmoothing",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  "strokeWeight", "strokeAlign", "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern"];
const AL = ["layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode",
  "primaryAxisAlignItems", "counterAxisAlignItems", "paddingLeft", "paddingRight", "paddingTop",
  "paddingBottom", "itemSpacing", "counterAxisSpacing", "layoutAlign", "layoutGrow", "layoutPositioning"];
const TXT = ["characters", "fontSize", "fontName", "textAlignHorizontal", "textAlignVertical",
  "textAutoResize", "textCase", "textDecoration", "letterSpacing", "lineHeight",
  "paragraphIndent", "paragraphSpacing"];
const KEEP = new Set(["id", "name", "type", "children", "fills", "strokes", "effects", "constraints",
  "vectorPaths", "mainComponentKey", "componentProperties"].concat(GEOM, VIS, AL, TXT));

// Defaults worth dropping to stay under the 50k payload cap.
const DEFAULT = { visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", isMask: false,
  rotation: 0, cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0,
  bottomRightRadius: 0, cornerSmoothing: 0, strokeWeight: 1, strokeAlign: "INSIDE",
  strokeCap: "NONE", strokeJoin: "MITER", strokeMiterLimit: 4, layoutMode: "NONE",
  layoutWrap: "NO_WRAP", layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO",
  paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, itemSpacing: 0,
  counterAxisSpacing: 0, paragraphIndent: 0, paragraphSpacing: 0,
  textCase: "ORIGINAL", textDecoration: "NONE", textAlignVertical: "TOP" };

const fonts = new Map();
let kept = 0;

function prune(n) {
  const o = {};
  for (const k of Object.keys(n)) {
    if (!KEEP.has(k)) continue;
    const v = n[k];
    if (v === null || v === undefined) continue;
    if (v === "unable") continue;
    if (v && typeof v === "object" && v.__mixed) continue;
    if (k in DEFAULT && JSON.stringify(v) === JSON.stringify(DEFAULT[k])) continue;
    if (k === "dashPattern" && Array.isArray(v) && v.length === 0) continue;
    // empty fills/strokes/effects are meaningful and MUST be emitted explicitly
    if (k === "children") continue;
    o[k] = v;
  }
  if (o.fontName && o.fontName.family) fonts.set(o.fontName.family + "|" + o.fontName.style,
    { family: o.fontName.family, style: o.fontName.style });
  kept++;
  if (n.children && n.children.length) o.children = n.children.map(prune);
  return o;
}

const pruned = prune(target);

const BUILDER = `
const REPORT = { createdNodeIds: [], nodes: 0, failures: [], instancesAsFrames: [] };
const FONT_FALLBACK = { family: "Inter", style: "Regular" };

function tryset(node, key, value, id) {
  try { node[key] = value; } catch (e) { REPORT.failures.push(id + "." + key + ": " + String(e.message || e).slice(0, 90)); }
}

function makeNode(t) {
  if (t === "TEXT") return figma.createText();
  if (t === "RECTANGLE") return figma.createRectangle();
  if (t === "ELLIPSE") return figma.createEllipse();
  if (t === "LINE") return figma.createLine();
  if (t === "POLYGON") return figma.createPolygon();
  if (t === "STAR") return figma.createStar();
  if (t === "VECTOR" || t === "BOOLEAN_OPERATION") return figma.createVector();
  return figma.createFrame();
}

async function build(n, parent, parentIsAL) {
  const node = makeNode(n.type);
  parent.appendChild(node);
  REPORT.nodes++;
  if (n.name) tryset(node, "name", n.name, n.id);
  if (n.type === "INSTANCE") REPORT.instancesAsFrames.push({ id: n.id, name: n.name, key: n.mainComponentKey });

  if (n.vectorPaths && node.type === "VECTOR") tryset(node, "vectorPaths", n.vectorPaths, n.id);

  if (n.width !== undefined && n.height !== undefined && node.resize) {
    try { node.resize(Math.max(0.01, n.width), Math.max(0.01, n.height)); }
    catch (e) { REPORT.failures.push(n.id + ".resize: " + String(e.message || e).slice(0, 70)); }
  }

  if (n.type === "TEXT") {
    const f = n.fontName && n.fontName.family ? { family: n.fontName.family, style: n.fontName.style } : FONT_FALLBACK;
    let loaded = f;
    try { await figma.loadFontAsync(f); }
    catch (e) { loaded = FONT_FALLBACK; await figma.loadFontAsync(FONT_FALLBACK); REPORT.failures.push(n.id + ".font: substituted " + f.family + " " + f.style); }
    node.fontName = loaded;
    if (n.characters !== undefined) tryset(node, "characters", n.characters, n.id);
    for (const k of ["fontSize","textAlignHorizontal","textAlignVertical","textCase","textDecoration","letterSpacing","lineHeight","paragraphIndent","paragraphSpacing"]) {
      if (n[k] !== undefined) tryset(node, k, n[k], n.id);
    }
    if (n.textAutoResize !== undefined) tryset(node, "textAutoResize", n.textAutoResize, n.id);
  }

  for (const k of ["fills","strokes","effects","constraints","strokeWeight","strokeAlign","strokeCap","strokeJoin","strokeMiterLimit","dashPattern","cornerRadius","topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius","cornerSmoothing","clipsContent","opacity","blendMode","visible","locked","isMask","rotation"]) {
    if (n[k] !== undefined) tryset(node, k, n[k], n.id);
  }

  const isAL = n.layoutMode && n.layoutMode !== "NONE";
  if (isAL) {
    tryset(node, "layoutMode", n.layoutMode, n.id);
    for (const k of ["layoutWrap","primaryAxisSizingMode","counterAxisSizingMode","primaryAxisAlignItems","counterAxisAlignItems","paddingLeft","paddingRight","paddingTop","paddingBottom","itemSpacing","counterAxisSpacing"]) {
      if (n[k] !== undefined) tryset(node, k, n[k], n.id);
    }
  }

  for (const c of n.children || []) await build(c, node, isAL);

  if (parentIsAL) {
    for (const k of ["layoutAlign","layoutGrow","layoutPositioning"]) if (n[k] !== undefined) tryset(node, k, n[k], n.id);
  } else {
    if (n.x !== undefined) tryset(node, "x", n.x, n.id);
    if (n.y !== undefined) tryset(node, "y", n.y, n.id);
  }
  return node;
}

const page = figma.currentPage;
let maxX = 0;
for (const c of page.children) maxX = Math.max(maxX, c.x + c.width);
const root = await build(IR, page, false);
root.x = maxX + 120;
root.y = 80;
REPORT.createdNodeIds.push(root.id);
REPORT.rootId = root.id;
REPORT.rootSize = { w: Math.round(root.width), h: Math.round(root.height) };
REPORT.expectedSize = { w: Math.round(IR.width), h: Math.round(IR.height) };
return REPORT;
`;

const payload = "const IR = " + JSON.stringify(pruned) + ";\n" + BUILDER;
writeFileSync(OUT, payload, "utf8");
console.log("root:        " + target.type + ' "' + target.name + '" ' + Math.round(target.width) + "x" + Math.round(target.height));
console.log("nodes:       " + kept);
console.log("fonts:       " + [...fonts.values()].map((f) => f.family + " " + f.style).join(", "));
console.log("payload:     " + payload.length + " chars (limit 50000)");
console.log("written:     " + OUT);

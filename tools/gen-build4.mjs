// Emit the self-contained use_figma builder for a pack4 PNG carrier.
// usage: node gen-build4.mjs <payloadImageHash> [out.js]
import { readFileSync, writeFileSync } from "node:fs";
import { INFLATE_SRC } from "./inflate.js";

const [, , HASH, OUT = "../out/build4.js"] = process.argv;
if (!HASH) { console.error("usage: node gen-build4.mjs <imageHash> [out.js]"); process.exit(1); }

const SRC = `
${INFLATE_SRC}

const REPORT = { nodes: 0, svg: 0, failures: [], fontSubs: [], rtFail: 0 };
const FB = { family: "Inter", style: "Regular" };

function tryset(n, k, v, id) { try { n[k] = v; } catch (e) { REPORT.failures.push(id + "." + k + ": " + String(e.message || e).slice(0, 80)); } }

// ---- read the carrier ----
const img = figma.getImageByHash(${JSON.stringify(HASH)});
const png = await img.getBytesAsync();
let p = 8, W = 0, idat = [];
while (p < png.length) {
  const len = (png[p] << 24 | png[p + 1] << 16 | png[p + 2] << 8 | png[p + 3]) >>> 0;
  const t = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
  if (t === "IHDR") W = (png[p + 8] << 24 | png[p + 9] << 16 | png[p + 10] << 8 | png[p + 11]) >>> 0;
  if (t === "IDAT") idat.push(png.subarray(p + 8, p + 8 + len));
  if (t === "IEND") break;
  p += 12 + len;
}
let total = 0; for (const c of idat) total += c.length;
const z = new Uint8Array(total); let zo = 0; for (const c of idat) { z.set(c, zo); zo += c.length; }
const raw = inflateRaw(z.subarray(2));
const rows = Math.floor(raw.length / (W + 1));
const body = new Uint8Array(rows * W);
for (let y = 0; y < rows; y++) body.set(raw.subarray(y * (W + 1) + 1, y * (W + 1) + 1 + W), y * W);
const jlen = (body[0] << 24 | body[1] << 16 | body[2] << 8 | body[3]) >>> 0;
const PAY = JSON.parse(utf8(body.subarray(4, 4 + jlen)));
const D = PAY.D, S = PAY.S, F = PAY.F;

// ---- build ----
const AL_KEYS = ["layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems",
  "counterAxisAlignItems", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing"];
const AL_A = { layoutWrap: "z", primaryAxisSizingMode: "A", counterAxisSizingMode: "B", primaryAxisAlignItems: "C",
  counterAxisAlignItems: "D", paddingLeft: "E", paddingRight: "F", paddingTop: "G", paddingBottom: "H",
  itemSpacing: "I", counterAxisSpacing: "J" };
const PAINT_A = { fills: "N", strokes: "O", effects: "P", constraints: "Q" };
const PLAIN = [["t", "strokeWeight"], ["u", "strokeAlign"], ["v", "strokeJoin"], ["w", "dashPattern"],
  ["n", "cornerRadius"], ["o", "topLeftRadius"], ["p", "topRightRadius"], ["q", "bottomLeftRadius"],
  ["r", "bottomRightRadius"], ["s", "cornerSmoothing"], ["m", "clipsContent"], ["e", "opacity"],
  ["f", "blendMode"], ["c", "visible"], ["d", "locked"], ["g", "isMask"]];
const TXT = [["T", "fontSize"], ["V", "textAlignHorizontal"], ["W", "textAlignVertical"], ["Y", "textCase"],
  ["Z", "textDecoration"], ["0", "letterSpacing"], ["1", "lineHeight"], ["2", "paragraphIndent"], ["3", "paragraphSpacing"]];
const DICTKEY = { N: 1, O: 1, P: 1, Q: 1, U: 1, "0": 1, "1": 1, w: 1 };
const dv = (d, k) => (d[k] === undefined ? undefined : (DICTKEY[k] ? D[d[k]] : d[k]));

function makeNode(d) {
  const t = d.b;
  if (t === "SVG") { REPORT.svg++; const n = figma.createNodeFromSvg(S[d["6"]]); n.fills = []; return n; }
  if (t === "TEXT") return figma.createText();
  if (t === "RECTANGLE") return figma.createRectangle();
  if (t === "ELLIPSE") return figma.createEllipse();
  return figma.createFrame();
}

const built = [];
for (let i = 0; i < F.length; i++) {
  const rec = F[i], d = rec.d, id = "#" + i;
  const parent = rec.p < 0 ? figma.currentPage : built[rec.p];
  const node = makeNode(d);
  parent.appendChild(node);
  built[i] = node;
  REPORT.nodes++;
  if (d.a !== undefined) tryset(node, "name", d.a, id);

  if (d.b !== "SVG" && d.j !== undefined && d.k !== undefined && node.resize) {
    try { node.resize(Math.max(0.01, d.j), Math.max(0.01, d.k)); }
    catch (e) { REPORT.failures.push(id + ".resize: " + String(e.message || e).slice(0, 60)); }
  }

  if (d.b === "TEXT") {
    const fn = dv(d, "U");
    let use = fn && fn.family ? { family: fn.family, style: fn.style } : FB;
    try { await figma.loadFontAsync(use); }
    catch (e) { REPORT.fontSubs.push(use.family + " " + use.style); use = FB; await figma.loadFontAsync(FB); }
    node.fontName = use;
    if (d.S !== undefined) tryset(node, "characters", d.S, id);
    for (const kv of TXT) if (d[kv[0]] !== undefined) tryset(node, kv[1], dv(d, kv[0]), id);
  }

  if (d.b !== "SVG") {
    for (const k of ["N", "O", "P"]) if (d[k] !== undefined) tryset(node, PAINT_A_INV[k], dv(d, k), id);
    for (const kv of PLAIN) if (d[kv[0]] !== undefined) tryset(node, kv[1], dv(d, kv[0]), id);
  } else {
    if (d.P !== undefined) tryset(node, "effects", dv(d, "P"), id);
    for (const kv of [["e", "opacity"], ["f", "blendMode"], ["c", "visible"], ["g", "isMask"]]) if (d[kv[0]] !== undefined) tryset(node, kv[1], dv(d, kv[0]), id);
  }

  if (d.y && d.y !== "NONE") {
    tryset(node, "layoutMode", d.y, id);
    for (const k of AL_KEYS) { const a = AL_A[k]; if (d[a] !== undefined) tryset(node, k, d[a], id); }
  }
  if (d.b === "TEXT" && d.X !== undefined) tryset(node, "textAutoResize", d.X, id);
}

// placement pass: parents are fully configured, so child transforms stick
for (let i = 0; i < F.length; i++) {
  const rec = F[i], d = rec.d, node = built[i], id = "#" + i;
  if (rec.p < 0) continue;
  const pd = F[rec.p].d;
  if (pd.y && pd.y !== "NONE") {
    if (d.K !== undefined) tryset(node, "layoutAlign", d.K, id);
    if (d.L !== undefined) tryset(node, "layoutGrow", d.L, id);
    if (d.M !== undefined) tryset(node, "layoutPositioning", d.M, id);
    continue;
  }
  if (d.Q !== undefined) tryset(node, "constraints", dv(d, "Q"), id);
  const m = d["7"];
  if (m) { try { node.relativeTransform = [[m[0], m[1], m[2]], [m[3], m[4], m[5]]]; } catch (e) { REPORT.rtFail++; } }
}

const root = built[0];
let maxX = 0;
for (const c of figma.currentPage.children) if (c !== root) maxX = Math.max(maxX, c.x + c.width);
root.x = maxX + 160; root.y = 80;
REPORT.rootId = root.id;
REPORT.rootSize = { w: Math.round(root.width), h: Math.round(root.height) };
return REPORT;
`.replace(/PAINT_A_INV\[k\]/g, '({ N: "fills", O: "strokes", P: "effects" })[k]');

writeFileSync(OUT, SRC, "utf8");
console.log("written " + OUT + "  " + SRC.length + " chars (limit 50000)");

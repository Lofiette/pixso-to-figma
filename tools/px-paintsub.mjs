// Bake image-paint filters Figma cannot express into the pixels.
//
//   node px-paintsub.mjs <ir.json> <rootId> <imgDir> <out.json>
//
// Pixso's image paints carry a Hue filter. Figma's do not — its ImageFilters are exposure,
// contrast, saturation, temperature, tint, highlights and shadows, and that is the whole list.
// A cover whose ring is tinted pink by hue 0.65 therefore arrived in its original blue, and the
// geometry verifier had nothing to say about it because every box was in the right place.
//
// The filter cannot travel as a property, so it travels as pixels: Pixso renders the node with
// its own engine, filter and all, and that render becomes the image. Same principle as the text
// whose override Pixso will not disclose — where the API cannot answer, the renderer can.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { decodePNG, encodePNG, toLocalFrame, isAxisAligned } from "./pngutil.mjs";

const [, , IR, ABS_PATH, ROOT_ID, IMGDIR, OUT] = process.argv;
if (!IR || !ABS_PATH || !ROOT_ID || !IMGDIR || !OUT) {
  console.error("usage: node px-paintsub.mjs <ir.json> <abs.json> <rootId> <imgDir> <out.json>");
  process.exit(1);
}
const ir = JSON.parse(readFileSync(IR, "utf8"));
const ABS = JSON.parse(readFileSync(ABS_PATH, "utf8"));
const NL = String.fromCharCode(10);
const SCALE = Number(process.env.PX_PAINTSUB_SCALE || 2);

// Everything Figma's ImageFilters can hold. A non-zero value under any other key is a filter that
// cannot cross as data.
const FIGMA_FILTERS = new Set(["exposure", "contrast", "saturation", "temperature", "tint",
  "highlights", "shadows"]);

const jobs = [], unhandled = [];
(function walk(n, path) {
  const fills = Array.isArray(n.fills) ? n.fills : [];
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    if (!f || f.type !== "IMAGE" || !f.filters) continue;
    const lost = Object.keys(f.filters).filter((k) => !FIGMA_FILTERS.has(k) && Math.abs(f.filters[k]) > 1e-6);
    if (!lost.length) continue;
    // The render carries whatever else the node draws, so baking it is only faithful when the
    // image paint is all there is. Anything more is reported rather than quietly flattened.
    const visibleFills = fills.filter((p) => p && p.visible !== false).length;
    const strokes = (n.strokes || []).filter((p) => p && p.visible !== false).length;
    const effects = (n.effects || []).filter((e) => e && e.visible !== false).length;
    const entry = { path: path.join("."), i, id: n.id, name: n.name, lost, w: n.width, h: n.height };
    if (visibleFills > 1 || strokes || effects) { unhandled.push(Object.assign({ why: "node draws more than this paint" }, entry)); continue; }
    jobs.push(entry);
  }
  (n.children || []).forEach((c, k) => walk(c, path.concat(k)));
})(ir.tree, []);

console.log("paints with a filter Figma cannot express: " + jobs.length +
  (unhandled.length ? ", " + unhandled.length + " left alone" : ""));
for (const u of unhandled) console.log("  left alone: " + JSON.stringify(u.name) + " — " + u.why + " (" + u.lost.join(",") + ")");

const manFile = join(IMGDIR, "manifest.json");
const manifest = existsSync(manFile) ? JSON.parse(readFileSync(manFile, "utf8")) : [];
const sub = {};

for (const j of jobs) {
  const src = [
    "await pixso.loadAllPagesAsync();",
    "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
    "if (!root) return { e: 'root not found' };",
    "let n = root;",
    "for (const i of " + JSON.stringify(j.path === "" ? [] : j.path.split(".").map(Number)) + ") {",
    "  if (!n.children || !n.children[i]) return { e: 'path' };",
    "  n = n.children[i];",
    "}",
    "const by = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: " + SCALE + " } });",
    "return { bytes: by.length, d: pixso.base64Encode(by) };",
  ].join(NL);
  writeFileSync("_paintsub.js", src, "utf8");
  let r;
  try { r = JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_paintsub.js"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim()); }
  catch (e) { console.log("  FAIL " + JSON.stringify(j.name) + ": " + String(e.message).slice(0, 160)); continue; }
  if (r.e || !r.d) { console.log("  FAIL " + JSON.stringify(j.name) + ": " + JSON.stringify(r).slice(0, 160)); continue; }
  let buf = Buffer.from(r.d, "base64");

  // The render is in screen orientation. Used as a fill it would be turned a second time by the
  // node's own rotation, which on a node rotated a quarter turn and mirrored produced a picture
  // of a different part of the photo entirely. Put the pixels in the node's frame first.
  const m = ABS[j.path] || [1, 0, 0, 0, 1, 0];
  const lin = [m[0], m[1], m[3], m[4]];
  const turned = !(Math.abs(lin[0] - 1) < 1e-3 && Math.abs(lin[1]) < 1e-3 &&
                   Math.abs(lin[2]) < 1e-3 && Math.abs(lin[3] - 1) < 1e-3);
  if (turned) {
    if (!isAxisAligned(lin)) {
      unhandled.push(Object.assign({ why: "rotated by something other than a quarter turn — a resampled bitmap is not a faithful transfer" }, j));
      console.log("  left alone: " + JSON.stringify(j.name) + " — not a quarter turn");
      continue;
    }
    const img = decodePNG(buf);
    const lw = Math.max(1, Math.round(j.w * SCALE)), lh = Math.max(1, Math.round(j.h * SCALE));
    buf = encodePNG(lw, lh, toLocalFrame(img, lin, lw, lh).rgba);
    console.log("  " + JSON.stringify(j.name) + "  render " + img.W + "x" + img.H +
      " turned back into the node's frame, " + lw + "x" + lh);
  }
  const hash = createHash("sha1").update(buf).digest("hex");
  const file = join(IMGDIR, hash + ".png");
  writeFileSync(file, buf);
  if (!manifest.some((m) => m.hash === hash)) manifest.push({ hash, file, bytes: buf.length, ext: "png", source: "filtered" });
  sub[j.path] = { i: j.i, hash, bytes: buf.length, lost: j.lost };
  console.log("  " + JSON.stringify(j.name) + "  " + j.lost.join(",") + " baked into " +
    Math.round(buf.length / 1024) + " KB at " + SCALE + "x");
}

writeFileSync(manFile, JSON.stringify(manifest, null, 2), "utf8");
writeFileSync(OUT, JSON.stringify({ sub, unhandled }, null, 2), "utf8");
console.log("substitutions: " + Object.keys(sub).length + " -> " + OUT);

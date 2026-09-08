// Render every migrated object from both engines and rank them by how different they look.
//
//   node visual-all.mjs <dirs list file> <outDir> [maxSide]
//
// The geometry verifier compares the built tree against the payload. It therefore proves the build
// faithful to the payload and says nothing about how the two engines DRAW that payload — which is
// where the defects that a person notices actually live: a mirrored label, a fill Figma dropped, a
// filter it has no field for. Every one of those passed the verifier with zero nodes out of place.
//
// So: the same object, rendered by Pixso and by Figma at the same width, compared by the
// distribution of per-pixel difference. The number that matters is the share of pixels differing
// by more than 191 out of 255 — that is ink on one side and none on the other, which is the
// signature of something that did not migrate rather than something that migrated imprecisely.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { startJobServer } from "./jobserver.mjs";
import { decodePNG } from "./pngutil.mjs";

const [, , LIST, OUT = "../out/visual", MAXSIDE = "700"] = process.argv;
if (!LIST) { console.error("usage: node visual-all.mjs <dirs list file> <outDir> [maxSide]"); process.exit(1); }
const dirs = readFileSync(LIST, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
mkdirSync(OUT, { recursive: true });
const NL = String.fromCharCode(10);
const W_TARGET = Number(MAXSIDE);

function pixsoRender(id, width) {
  const src = [
    "await pixso.loadAllPagesAsync();",
    "const n = pixso.getNodeById(" + JSON.stringify(id) + ");",
    "if (!n) return { e: 'not found' };",
    "const w = Math.max(1, Math.min(" + width + ", Math.round(n.width)));",
    "const by = await n.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: w } });",
    "return { w: w, bytes: by.length, d: pixso.base64Encode(by) };",
  ].join(NL);
  writeFileSync("_visall.js", src, "utf8");
  try { return JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_visall.js"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim()); }
  catch (e) { return { e: String(e.message).slice(0, 120) }; }
}

const figSrc = (id, width) => [
  "const n = await figma.getNodeByIdAsync(" + JSON.stringify(id) + ");",
  "if (!n || n.removed) { RESULT = { e: 'not found' }; } else {",
  "  const w = " + width + ";",
  "  const by = await n.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: w } });",
  "  RESULT = { w: w, bytes: by.length, d: figma.base64Encode(by) };",
  "}",
].join(NL);

// Ink on one side only is what matters; a whole image shifted by a pixel is not the same defect.
function compare(a, b) {
  const W = Math.min(a.W, b.W), H = Math.min(a.H, b.H);
  let same = 0, gross = 0, sum = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const oa = (y * a.W + x) * 4, ob = (y * b.W + x) * 4;
      const d = Math.max(Math.abs(a.rgba[oa] - b.rgba[ob]), Math.abs(a.rgba[oa + 1] - b.rgba[ob + 1]),
                         Math.abs(a.rgba[oa + 2] - b.rgba[ob + 2]), Math.abs(a.rgba[oa + 3] - b.rgba[ob + 3]));
      sum += d; n++;
      if (d === 0) same++; else if (d > 191) gross++;
    }
  }
  return { same: same / n, gross: gross / n, mean: sum / n,
    sizeMismatch: (a.W !== b.W || a.H !== b.H) ? (a.W + "x" + a.H + " vs " + b.W + "x" + b.H) : null };
}

const srv = startJobServer(3778);
await srv.ready;
console.log("comparing " + dirs.length + " objects at " + W_TARGET + " px wide" + NL);

const rows = [];
const t0 = Date.now();
for (let i = 0; i < dirs.length; i++) {
  const dir = dirs[i], name = basename(dir);
  let meta, build;
  try { meta = JSON.parse(readFileSync(join(dir, "payload-meta.json"), "utf8")); } catch (e) { continue; }
  try { build = JSON.parse(readFileSync(join(dir, "build-report.json"), "utf8")); } catch (e) { continue; }
  if (!build.rootId) continue;

  const px = pixsoRender(meta.rootId, W_TARGET);
  if (px.e || !px.d) { rows.push({ name, error: "pixso: " + (px.e || "no data") }); continue; }
  let fg;
  try { fg = await srv.post({ kind: "render", rootNodeId: build.rootId }, JSON.stringify({ V: figSrc(build.rootId, px.w) }), new Map(), 120000); }
  catch (e) { rows.push({ name, error: "figma: " + e.message.slice(0, 60) }); continue; }
  if (!fg || fg.e || !fg.d) { rows.push({ name, error: "figma: " + JSON.stringify(fg).slice(0, 60) }); continue; }

  let a, b;
  try { a = decodePNG(Buffer.from(px.d, "base64")); b = decodePNG(Buffer.from(fg.d, "base64")); }
  catch (e) { rows.push({ name, error: "decode: " + e.message.slice(0, 60) }); continue; }
  const c = compare(a, b);
  rows.push({ name, ...c });
  // Keep the pictures for the ones worth looking at; 290 pairs would be a lot of disk otherwise.
  if (c.gross > 0.01 || c.sizeMismatch) {
    writeFileSync(join(OUT, name + ".pixso.png"), Buffer.from(px.d, "base64"));
    writeFileSync(join(OUT, name + ".figma.png"), Buffer.from(fg.d, "base64"));
  }
  if ((i + 1) % 25 === 0) console.log("  " + (i + 1) + "/" + dirs.length + "  (" + Math.round((Date.now() - t0) / 1000) + "s)");
}
srv.close();

const done = rows.filter((r) => !r.error);
done.sort((a, b) => b.gross - a.gross);
writeFileSync(join(OUT, "report.json"), JSON.stringify(rows, null, 2), "utf8");

console.log(NL + "================ how different they look ================");
console.log("object".padEnd(34) + "ink on one side".padStart(16) + "identical".padStart(11) + "mean".padStart(8));
for (const r of done.slice(0, 30)) {
  console.log(r.name.slice(0, 33).padEnd(34) + (r.gross * 100).toFixed(2).padStart(15) + "%" +
    (r.same * 100).toFixed(1).padStart(10) + "%" + r.mean.toFixed(1).padStart(8) +
    (r.sizeMismatch ? "   size " + r.sizeMismatch : ""));
}
const bad = done.filter((r) => r.gross > 0.01).length;
const errs = rows.filter((r) => r.error);
console.log(NL + done.length + " compared, " + bad + " with more than 1 % of pixels inked on one side only");
if (errs.length) {
  console.log(errs.length + " could not be compared:");
  for (const e of errs.slice(0, 8)) console.log("  " + e.name + ": " + e.error);
}
console.log("pictures for the worst are in " + OUT);

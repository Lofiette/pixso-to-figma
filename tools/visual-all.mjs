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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { startJobServer } from "./jobserver.mjs";
import { focusFigma } from "./focus-figma.mjs";
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

// Asked for by id, then made to prove it is the right node. A remembered id turned out to resolve
// to something else entirely on two objects out of 45 — so photographing whatever answers to a
// number would quietly compare the wrong pair of pictures, which is worse than failing.
const figSrc = (id, srcId, width) => [
  "await figma.loadAllPagesAsync();",
  "var want = " + JSON.stringify(srcId ? String(srcId) : "") + ";",
  "var stampOf = function (n) { try { return n.getPluginData('pxSrc'); } catch (e) { return ''; } };",
  "var n = await figma.getNodeByIdAsync(" + JSON.stringify(id) + ");",
  "var relocated = null;",
  "if (want && (!n || n.removed || stampOf(n) !== want)) {",
  "  var f = [];",
  "  for (var pi = 0; pi < figma.root.children.length; pi++) {",
  "    var k = figma.root.children[pi].children;",
  "    for (var ki = 0; ki < k.length; ki++) if (stampOf(k[ki]) === want) f.push(k[ki]);",
  "  }",
  "  if (f.length) { n = f[f.length - 1]; relocated = n.id; }",
  "}",
  "if (!n || n.removed) { RESULT = { e: 'not found' }; } else {",
  "  const w = " + width + ";",
  "  const by = await n.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: w } });",
  "  RESULT = { w: w, bytes: by.length, d: figma.base64Encode(by), relocated: relocated };",
  "}",
].join(NL);

// Ink on one side only is what matters; a whole image shifted by a pixel is not the same defect.
//
// Both sides are composited over the same white before anything is compared, because the raw
// channels disagree where nobody can see. Under a fully transparent pixel Pixso stores 0,0,0 and
// Figma stores 255,255,255: invisible in both, opposite in every channel. Compared raw, that put a
// dropdown menu at the top of the ranking with 10.32 % "ink on one side" while every pixel anyone
// could see was byte-identical. Compositing keeps the differences that matter — something opaque on
// one side and not the other still comes out as white against its colour — and drops the rest.
function compare(a, b) {
  const W = Math.min(a.W, b.W), H = Math.min(a.H, b.H);
  let same = 0, gross = 0, sum = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const oa = (y * a.W + x) * 4, ob = (y * b.W + x) * 4;
      const aA = a.rgba[oa + 3] / 255, bA = b.rgba[ob + 3] / 255;
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const av = a.rgba[oa + c] * aA + 255 * (1 - aA);
        const bv = b.rgba[ob + c] * bA + 255 * (1 - bA);
        const dc = Math.abs(av - bv);
        if (dc > d) d = dc;
      }
      sum += d; n++;
      if (d < 0.5) same++; else if (d > 191) gross++;
    }
  }
  return { same: same / n, gross: gross / n, mean: sum / n,
    sizeMismatch: (a.W !== b.W || a.H !== b.H) ? (a.W + "x" + a.H + " vs " + b.W + "x" + b.H) : null };
}

// Rasterisation only happens in the front window, and every render here depends on it.
console.log("figma window: " + focusFigma());
const srv = startJobServer(3778);
await srv.ready;
console.log("comparing " + dirs.length + " objects at " + W_TARGET + " px wide" + NL);

const DONE_FILE = join(OUT, "done.jsonl");
// Written one line per object as it is compared. A run that stops halfway — and one will, the
// far end is a plugin — must not cost the objects it already measured.
const already = new Map();
if (existsSync(DONE_FILE)) {
  for (const line of readFileSync(DONE_FILE, "utf8").split(NL)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (!r.error) already.set(r.name, r); } catch (e) {}
  }
  console.log(already.size + " already compared, skipping those" + String.fromCharCode(10));
}
function logErr(r) { console.log("      ! " + r.error); return r; }
const rows = [...already.values()];
const t0 = Date.now();
for (let i = 0; i < dirs.length; i++) {
  const dir = dirs[i], name = basename(dir);
  let meta, build;
  try { meta = JSON.parse(readFileSync(join(dir, "payload-meta.json"), "utf8")); } catch (e) { continue; }
  try { build = JSON.parse(readFileSync(join(dir, "build-report.json"), "utf8")); } catch (e) { continue; }
  if (!build.rootId) continue;

  if (already.has(name)) continue;
  // Named before the work starts: when the far end hangs, this line is the only record of
  // which object it hung on.
  process.stdout.write("  [" + (i + 1) + "/" + dirs.length + "] " + name + String.fromCharCode(10));
  const px = pixsoRender(meta.rootId, W_TARGET);
  if (px.e || !px.d) { rows.push(logErr({ name, error: "pixso: " + (px.e || "no data") })); continue; }
  // One retry, with the window raised again first. Figma rasterises only in the front window, so
  // the moment anything else takes focus every remaining render stops returning — and over a whole
  // file, something eventually does. Losing the run at object 40 of 290 because of one click is why
  // this audit has never reached the end of a file.
  const V = { V: figSrc(build.rootId, meta.rootId, px.w) };
  let fg = null, why = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) console.log("      retrying with the Figma window raised: " + focusFigma());
    try { fg = await srv.post({ kind: "render", rootNodeId: build.rootId }, JSON.stringify(V), new Map(), 120000); }
    catch (e) { fg = null; why = "figma: " + e.message.slice(0, 60); }
    if (fg && !fg.e && fg.d) break;
    if (fg) why = "figma: " + JSON.stringify(fg).slice(0, 60);
    fg = null;
  }
  if (!fg) { rows.push(logErr({ name, error: why })); continue; }
  if (fg.relocated) console.log("      the remembered id had gone stale; photographed " + fg.relocated + ", found by its stamp");

  let a, b;
  try { a = decodePNG(Buffer.from(px.d, "base64")); b = decodePNG(Buffer.from(fg.d, "base64")); }
  catch (e) { rows.push(logErr({ name, error: "decode: " + e.message.slice(0, 60) })); continue; }
  const c = compare(a, b);
  rows.push({ name, ...c });
  appendFileSync(DONE_FILE, JSON.stringify({ name, ...c }) + String.fromCharCode(10), "utf8");
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

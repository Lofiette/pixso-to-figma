// Render the same object from both sides at 1:1 and write the two PNGs.
//
//   node visual.mjs <pixsoNodeId> <figmaNodeId> <outDir> [scale]
//
// The verifier measures geometry, and geometry has been clean through defects that changed what
// the page looks like — per-side strokes, per-range text fills, a paint that silently failed.
// Only a render catches those. The Figma side goes through the runner plugin, which executes
// whatever the payload's V slot contains, so this needs no plugin change.
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startJobServer } from "./jobserver.mjs";

const [, , PX_ID, FIG_ID, OUT = "../out/visual", SCALE = "1"] = process.argv;
if (!PX_ID || !FIG_ID) { console.error("usage: node visual.mjs <pixsoNodeId> <figmaNodeId> <outDir> [scale]"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const NL = String.fromCharCode(10);

console.log("rendering Pixso " + PX_ID + " …");
const pxSrc = [
  "await pixso.loadAllPagesAsync();",
  "const n = pixso.getNodeById(" + JSON.stringify(PX_ID) + ");",
  "if (!n) return { e: 'not found' };",
  "const by = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: " + SCALE + " } });",
  "return { w: n.width, h: n.height, bytes: by.length, d: pixso.base64Encode(by) };",
].join(NL);
writeFileSync("_vis.js", pxSrc, "utf8");
const pxOut = JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_vis.js"],
  { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim());
if (pxOut.e || !pxOut.d) { console.error("pixso render failed: " + JSON.stringify(pxOut).slice(0, 200)); process.exit(1); }
const pxFile = join(OUT, "pixso.png");
writeFileSync(pxFile, Buffer.from(pxOut.d, "base64"));
console.log("  " + pxOut.w + " x " + pxOut.h + ", " + pxOut.bytes + " bytes -> " + pxFile);

const figSrc = [
  "const n = await figma.getNodeByIdAsync(" + JSON.stringify(FIG_ID) + ");",
  "if (!n || n.removed) { RESULT = { e: 'not found' }; } else {",
  "  const by = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: " + SCALE + " } });",
  "  RESULT = { w: n.width, h: n.height, bytes: by.length, d: figma.base64Encode(by) };",
  "}",
].join(NL);

const srv = startJobServer(3778);
await srv.ready;
console.log("rendering Figma " + FIG_ID + " — the runner plugin must be open…");
const r = await srv.post({ kind: "render", rootNodeId: FIG_ID }, JSON.stringify({ V: figSrc }), new Map(), 300000);
srv.close();
if (!r || r.e || !r.d) { console.error("figma render failed: " + JSON.stringify(r).slice(0, 300)); process.exit(1); }
const figFile = join(OUT, "figma.png");
writeFileSync(figFile, Buffer.from(r.d, "base64"));
console.log("  " + r.w + " x " + r.h + ", " + r.bytes + " bytes -> " + figFile);

if (Math.abs(pxOut.w - r.w) > 0.5 || Math.abs(pxOut.h - r.h) > 0.5) {
  console.log("");
  console.log("sizes differ: Pixso " + pxOut.w + "x" + pxOut.h + " vs Figma " + r.w + "x" + r.h);
}

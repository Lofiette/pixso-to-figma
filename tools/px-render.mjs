// Render each top-level child of a Pixso section to PNG at 1:1, for the pixel gate.
//
//   node px-render.mjs <ir.json> <rootId> <outDir>
//
// The verifier measures geometry, and geometry has been perfect through defects that changed what
// the page looks like — per-side stroke weights, per-range text fills. Those are only visible in a
// render, so the render is part of the pipeline.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , IR, ROOT_ID, OUTDIR] = process.argv;
if (!IR || !ROOT_ID || !OUTDIR) { console.error("usage: node px-render.mjs <ir.json> <rootId> <outDir>"); process.exit(1); }
const ir = JSON.parse(readFileSync(IR, "utf8"));
mkdirSync(OUTDIR, { recursive: true });

const kids = (ir.tree.children || []).map((c, i) => ({ i, id: c.id, name: c.name,
  w: Math.round(c.width), h: Math.round(c.height) }));
console.log("top-level children: " + kids.length);

function call(name, args) {
  const out = execFileSync("node", ["mcp.mjs", "call", name, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const line = out.trim().split(/\r?\n/)[0];
  return line.startsWith("http") ? line : null;
}

const index = [];
for (const k of kids) {
  // constraint type 2 is "width in pixels": ask for the node's own width, i.e. 1:1
  let url = null;
  try { url = call("get_export_image", { guid: k.id, exportSettings: { constraint: { type: 2, value: k.w }, imageType: 1 } }); }
  catch (e) { console.log("  FAIL " + k.name + ": " + String(e.message).slice(0, 100)); continue; }
  if (!url) { console.log("  FAIL " + k.name + ": no url"); continue; }
  const file = OUTDIR + "/" + String(k.i).padStart(2, "0") + ".png";
  try { execFileSync("curl", ["-s", "-o", file, url], { encoding: "utf8" }); }
  catch (e) { console.log("  FAIL " + k.name + " download: " + String(e.message).slice(0, 80)); continue; }
  index.push({ i: k.i, name: k.name, file, w: k.w, h: k.h });
  console.log("  " + String(k.i).padStart(2, "0") + "  " + k.name + "  " + k.w + "x" + k.h);
}
writeFileSync(OUTDIR + "/index.json", JSON.stringify(index, null, 2), "utf8");
console.log("rendered " + index.length + "/" + kids.length + " -> " + OUTDIR + "/index.json");

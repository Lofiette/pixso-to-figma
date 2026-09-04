// Collect absoluteRenderBounds for SVG roots + parent absoluteBoundingBox + ancestor rotation.
// usage: node px-bounds.mjs <ir.json> <rootId> <out.json>
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , IR, ROOT_ID, OUT] = process.argv;
const ir = JSON.parse(readFileSync(IR, "utf8"));
const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const jobs = [];
(function walk(n, path, rotAnc) {
  if (VEC.has(n.type)) { jobs.push({ path, rotAnc }); return; }
  (n.children || []).forEach((c, i) => walk(c, path.concat(i), rotAnc || !!n.rotation));
})(ir.tree, [], false);
console.log("bounds jobs: " + jobs.length + " (with rotated ancestor: " + jobs.filter(j => j.rotAnc).length + ")");

function run(src) {
  writeFileSync("_bounds.js", src, "utf8");
  try { return JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_bounds.js"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim()); }
  catch (e) { return { __err: String(e.message).slice(0, 200) }; }
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const out = {};
let done = 0;
for (const batch of chunk(jobs, 60)) {
  const r = run([
    "await pixso.loadAllPagesAsync();",
    "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
    "const paths = " + JSON.stringify(batch.map(j => j.path)) + ";",
    "const res = [];",
    "for (const p of paths) {",
    "  let n = root; for (const i of p) n = n.children[i];",
    "  const pa = n.parent;",
    "  res.push({ arb: n.absoluteRenderBounds, abb: n.absoluteBoundingBox, pab: pa.absoluteBoundingBox, prot: pa.rotation || 0 });",
    "}",
    "return res;"
  ].join("\n"));
  if (r.__err) { console.log("  FAIL " + r.__err); continue; }
  r.forEach((v, i) => { out[batch[i].path.join(".")] = v; done++; });
  process.stdout.write("\r  " + done + "/" + jobs.length + "   ");
}
console.log("");
writeFileSync(OUT, JSON.stringify(out), "utf8");
console.log("written " + OUT + " (" + Object.keys(out).length + ")");

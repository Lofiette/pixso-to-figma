// Where does the SVG phase spend its time: per call, or per node? Decides whether bigger batches
// are worth anything before a two-hour run.
//
//   node px-svgprobe.mjs <ir.json> <rootId>
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , IR, ROOT_ID] = process.argv;
const ir = JSON.parse(readFileSync(IR, "utf8"));
const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const jobs = [];
(function walk(n, path) {
  if (VEC.has(n.type)) { jobs.push(path); return; }
  (n.children || []).forEach((c, i) => walk(c, path.concat(i)));
})(ir.tree, []);

const script = (batch) => [
  "await pixso.loadAllPagesAsync();",
  "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
  "const paths = " + JSON.stringify(batch) + ";",
  "const out = []; const t0 = Date.now();",
  "for (let k = 0; k < paths.length; k++) {",
  "  let n = root, ok = true;",
  "  for (const i of paths[k]) { if (!n || !n.children || !n.children[i]) { ok = false; break; } n = n.children[i]; }",
  "  if (!ok) { out.push(0); continue; }",
  "  const b = await n.exportAsync({ format: 'SVG' });",
  "  out.push(b.length);",
  "}",
  "return { n: out.length, bytes: out.reduce(function (a, b) { return a + b; }, 0), inside: Date.now() - t0 };"
].join("\n");

for (const size of [8, 24, 60, 120]) {
  const batch = jobs.slice(0, size);
  writeFileSync("_probe.js", script(batch), "utf8");
  const t0 = Date.now();
  let r;
  try { r = JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_probe.js"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim()); }
  catch (e) { console.log("batch " + size + ": FAILED " + String(e.message).slice(0, 80)); continue; }
  const wall = Date.now() - t0;
  console.log("batch " + String(size).padStart(4) + "   wall " + String(wall).padStart(6) + " ms" +
    "   inside Pixso " + String(r.inside).padStart(6) + " ms" +
    "   overhead " + String(wall - r.inside).padStart(5) + " ms" +
    "   per node " + (wall / size).toFixed(1) + " ms" +
    "   " + (r.bytes / 1024).toFixed(0) + " KB");
}

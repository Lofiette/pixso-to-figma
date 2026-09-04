// Collect absoluteTransform for every node of a Pixso subtree, addressed by child-index path.
// usage: node px-abs.mjs <ir.json> <rootId> <out.json>
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , IR, ROOT_ID, OUT] = process.argv;
const ir = JSON.parse(readFileSync(IR, "utf8"));
const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const paths = [];
(function walk(n, path) {
  paths.push(path);
  if (VEC.has(n.type)) return;              // children of svg roots are not rebuilt
  (n.children || []).forEach((c, i) => walk(c, path.concat(i)));
})(ir.tree, []);
console.log("abs jobs: " + paths.length);

function run(src) {
  writeFileSync("_abs.js", src, "utf8");
  try { return JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_abs.js"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim()); }
  catch (e) { return { __err: String(e.message).slice(0, 200) }; }
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const out = {};
let done = 0, fails = 0;
const queue = chunk(paths, 150);
while (queue.length) {
  const batch = queue.shift();
  const r = run([
    "await pixso.loadAllPagesAsync();",
    "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
    "const P = " + JSON.stringify(batch) + ";",
    "const res = [];",
    "for (const p of P) {",
    "  let n = root; for (const i of p) n = n.children[i];",
    "  const t = n.absoluteTransform;",
    "  res.push([t[0][0], t[0][1], t[0][2], t[1][0], t[1][1], t[1][2]]);",
    "}",
    "return res;"
  ].join("\n"));
  if (r.__err) {
    if (batch.length > 1) { const h = Math.ceil(batch.length / 2); queue.unshift(batch.slice(h)); queue.unshift(batch.slice(0, h)); continue; }
    fails++; done++; console.log("  FAIL " + batch[0].join(".")); continue;
  }
  r.forEach((v, i) => { out[batch[i].join(".")] = v; done++; });
  process.stdout.write("\r  " + done + "/" + paths.length + "   ");
}
console.log("\nwritten " + OUT + " (" + Object.keys(out).length + ", fails " + fails + ")");
writeFileSync(OUT, JSON.stringify(out), "utf8");

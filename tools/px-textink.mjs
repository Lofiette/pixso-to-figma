// Pixso inked text extents, addressed by the same child-index paths as the IR walk.
// usage: node px-textink.mjs <ir.json> <rootId> <out.json>
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [, , IR, ROOT_ID, OUT] = process.argv;
const ir = JSON.parse(readFileSync(IR, "utf8"));
const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const paths = [];
(function walk(n, p) {
  if (VEC.has(n.type)) return;
  if (n.type === "TEXT") paths.push(p);
  (n.children || []).forEach((c, i) => walk(c, p.concat(i)));
})(ir.tree, []);
console.log("text nodes: " + paths.length);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const out = {};
for (const batch of chunk(paths, Number(process.env.PX_TEXTINK_BATCH || 60))) {
  writeFileSync("_ink.js", [
    "await pixso.loadAllPagesAsync();",
    "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
    "const P = " + JSON.stringify(batch) + ";",
    "const res = [];",
    "for (const p of P) { let n = root; for (const i of p) n = n.children[i];",
    "  res.push({ c: n.characters, w: n.width, h: n.height, arb: n.absoluteRenderBounds, abb: n.absoluteBoundingBox, ar: n.textAutoResize }); }",
    "return res;"
  ].join("\n"), "utf8");
  const r = JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_ink.js"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim());
  r.forEach((v, i) => { out[batch[i].join(".")] = v; });
  process.stdout.write("\r  " + Object.keys(out).length + "/" + paths.length + "  ");
}
console.log("");
writeFileSync(OUT, JSON.stringify(out), "utf8");
console.log("written " + OUT);

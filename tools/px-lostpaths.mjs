// Map the flat indices the build reports in textOverrideLost to the child-index paths
// px-textsvg.mjs expects. The build cannot know the paths; the packer's walk order defines them.
//   node px-lostpaths.mjs <ir.json> <out.json> <index> [<index> ...]
import { writeFileSync, readFileSync } from "node:fs";
const [, , IR, OUT, ...IDX] = process.argv;
if (!IR || !OUT || !IDX.length) { console.error("usage: node px-lostpaths.mjs <ir.json> <out.json> <index>..."); process.exit(1); }
const ir = JSON.parse(readFileSync(IR, "utf8"));
const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const nodes = [], paths = [];
(function walk(n, p) { nodes.push(n); paths.push(p);
  if (VEC.has(n.type)) return;
  (n.children || []).forEach((c, i) => walk(c, p.concat(i))); })(ir.tree, []);
const out = [];
for (const s of IDX) {
  const i = Number(s), n = nodes[i];
  if (!n) { console.log(i + ": OUT OF RANGE (" + nodes.length + " nodes)"); continue; }
  const path = paths[i].join(".");
  out.push(path);
  console.log(i + "  " + n.type + "  " + JSON.stringify(n.name) + "  " + JSON.stringify(String(n.characters || "").slice(0, 40)) + "  -> " + path);
}
writeFileSync(OUT, JSON.stringify(out), "utf8");
console.log("written " + OUT + " (" + out.length + " paths)");

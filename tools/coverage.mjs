// Source vs payload: what the packer collapsed, and what it dropped.
//
//   node coverage.mjs <objDir> [<objDir> ...]
//   node coverage.mjs --dirs <list file>
//
// The build verifier compares the payload against what Figma holds, so it can only catch a
// failure to build what was packed. It cannot see a node that never reached the payload.
// A vector subtree deliberately travels as one SVG node — geometry exact, operand structure
// gone — and on a vector-heavy file that difference is most of the node count. This measures
// it against ir.json, which is the source tree as Pixso reported it.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const di = argv.indexOf("--dirs");
let DIRS = argv;
if (di >= 0) {
  const lf = argv.splice(di, 2)[1];
  DIRS = readFileSync(lf, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const totals = { source: 0, packed: 0, collapsed: 0, wrappers: 0 };
const byType = {};          // what kind of node owned each collapsed subtree
const collapsedKids = {};   // what kinds of node were inside them
const rows = [];

for (const dir of DIRS) {
  const irF = join(dir, "ir.json"), metaF = join(dir, "payload-meta.json");
  if (!existsSync(irF) || !existsSync(metaF)) continue;
  const ir = JSON.parse(readFileSync(irF, "utf8"));
  const meta = JSON.parse(readFileSync(metaF, "utf8"));

  let source = 0, collapsed = 0, wrappers = 0;
  (function walk(n, insideVec) {
    source++;
    if (insideVec) {
      collapsed++;
      collapsedKids[n.type] = (collapsedKids[n.type] || 0) + 1;
    }
    const isVec = VEC.has(n.type);
    if (isVec && !insideVec) {
      wrappers++;
      byType[n.type] = (byType[n.type] || 0) + 1;
    }
    for (const c of n.children || []) walk(c, insideVec || isVec);
  })(ir.tree, false);

  totals.source += source; totals.packed += meta.nodes;
  totals.collapsed += collapsed; totals.wrappers += wrappers;
  // Anything not explained by a collapsed vector subtree is a node that went missing.
  const unexplained = source - collapsed - meta.nodes;
  rows.push({ dir, name: meta.rootName, source, packed: meta.nodes, collapsed, wrappers, unexplained });
}

rows.sort((a, b) => Math.abs(b.unexplained) - Math.abs(a.unexplained) || b.source - a.source);
const bad = rows.filter((r) => r.unexplained !== 0);

console.log("objects measured   " + rows.length);
console.log("source nodes       " + totals.source);
console.log("packed nodes       " + totals.packed);
console.log("collapsed          " + totals.collapsed + " nodes inside " + totals.wrappers + " vector subtrees");
console.log("  owners:  " + (Object.entries(byType).map((e) => e[0] + " " + e[1]).join(", ") || "-"));
console.log("  contents:" + (Object.entries(collapsedKids).sort((a, b) => b[1] - a[1])
  .map((e) => " " + e[0] + " " + e[1]).join(",") || " -"));
console.log("unexplained loss   " + rows.reduce((a, r) => a + r.unexplained, 0) +
  (bad.length ? "   in " + bad.length + " object(s)" : ""));
for (const r of bad.slice(0, 20)) {
  console.log("  " + String(r.unexplained).padStart(6) + "  " + JSON.stringify(r.name) +
    "  source " + r.source + ", packed " + r.packed + ", collapsed " + r.collapsed);
}
process.exit(bad.length ? 2 : 0);

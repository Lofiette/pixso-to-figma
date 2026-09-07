// Coverage audit: what the source has, and whether the pipeline carries and applies it.
// "No loss" has to be measured, not assumed.
//
//   node audit.mjs <ir.json>
//
// A property counts as CARRIED if pack4.mjs mentions it, and APPLIED if builder4.js mentions it.
// Both facts are read out of the sources, so the audit cannot drift away from the code the way a
// hand-kept list does. It is a coarse test — a mention is not proof of correct handling — but it
// catches the case that matters: a property nothing has ever heard of.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , IR] = process.argv;
if (!IR) { console.error("usage: node audit.mjs <ir.json>"); process.exit(1); }
const ir = JSON.parse(readFileSync(IR, "utf8"));
const pack = readFileSync(join(HERE, "pack4.mjs"), "utf8");
const build = readFileSync(join(HERE, "builder4.js"), "utf8");

const word = (src, name) => new RegExp("\\b" + name + "\\b").test(src);

const makeBlock = build.slice(build.indexOf("function makeNode"), build.indexOf("function makeNode") + 1600);
const CREATES = new Set();
for (const m of makeBlock.matchAll(/t === "(\w+)"/g)) CREATES.add(m[1]);
const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);

const typeCount = {}, propCount = {}, byType = {};
let total = 0;
(function walk(n) {
  total++;
  typeCount[n.type] = (typeCount[n.type] || 0) + 1;
  for (const k of Object.keys(n)) {
    if (k === "children") continue;
    const v = n[k];
    const empty = v === null || v === undefined || v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    if (empty) continue;
    propCount[k] = (propCount[k] || 0) + 1;
    (byType[k] = byType[k] || new Set()).add(n.type);
  }
  (n.children || []).forEach(walk);
})(ir.tree);

console.log("source: " + total + " nodes");
console.log("");
console.log("=== node types ===");
for (const [t, n] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) {
  const how = VEC.has(t) ? "SVG" : CREATES.has(t) ? "native" : "FRAME   ** no native match **";
  console.log("  " + String(n).padStart(6) + "  " + t.padEnd(20) + how);
}

console.log("");
console.log("=== properties that hold a value ===");
const gaps = [];
let ok = 0;
for (const [p, n] of Object.entries(propCount).sort((a, b) => b[1] - a[1])) {
  if (p === "id" || p === "type") continue;
  const carried = word(pack, p), applied = word(build, p);
  if (carried && applied) { ok++; continue; }
  gaps.push({ p, n, carried, applied, on: [...byType[p]].slice(0, 3).join(", ") });
}
console.log("  fully handled: " + ok + "    gaps: " + gaps.length);
if (gaps.length) {
  console.log("");
  console.log("  PROPERTY                       nodes  packer builder  on");
  for (const g of gaps) {
    console.log("  " + g.p.padEnd(30) + String(g.n).padStart(6) + "   " +
      (g.carried ? "yes" : "NO ") + "    " + (g.applied ? "yes" : "NO ") + "    " + g.on);
  }
}

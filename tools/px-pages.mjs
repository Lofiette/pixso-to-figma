// Enumerate the pages of the open Pixso file and what sits at the top of each.
//
//   node px-pages.mjs [out.json]
//
// A file is not one page. Migrating a file means creating the pages too, with their names and
// backgrounds, and putting each page's top-level children on the right one.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , OUT] = process.argv;

const script = [
  "await pixso.loadAllPagesAsync();",
  "function count(n){var c=1;var k=n.children;if(k)for(var i=0;i<k.length;i++)c+=count(k[i]);return c;}",
  "const pages = [];",
  "for (const pg of pixso.root.children) {",
  "  const kids = [];",
  "  for (let i = 0; i < pg.children.length; i++) {",
  "    const c = pg.children[i];",
  "    let bb = null; try { bb = c.absoluteBoundingBox; } catch (e) {}",
  "    kids.push({ i: i, id: c.id, name: c.name, type: c.type, nodes: count(c),",
  "      x: bb ? Math.round(bb.x) : null, y: bb ? Math.round(bb.y) : null,",
  "      w: bb ? Math.round(bb.width) : null, h: bb ? Math.round(bb.height) : null });",
  "  }",
  "  let bg = null; try { bg = pg.backgrounds; } catch (e) {}",
  "  pages.push({ id: pg.id, name: pg.name, nodes: count(pg) - 1, backgrounds: bg, children: kids });",
  "}",
  "return { file: pixso.root.name, fileKey: pixso.fileKey, currentPage: pixso.currentPage.name, pages: pages };",
].join("\n");

writeFileSync("_pages.js", script, "utf8");
let r;
try { r = JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_pages.js"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim()); }
catch (e) { console.error("failed: " + String(e.message).slice(0, 200)); process.exit(1); }

console.log("file: " + JSON.stringify(r.file) + "   pages: " + r.pages.length + "   open: " + JSON.stringify(r.currentPage));
let total = 0;
for (const p of r.pages) {
  total += p.nodes;
  console.log("");
  console.log("  " + JSON.stringify(p.name) + "  (" + p.id + ")  " + p.nodes + " nodes, " + p.children.length + " top-level");
  const bg = p.backgrounds && p.backgrounds[0];
  if (bg && bg.color) {
    const c = bg.color;
    console.log("    background " + [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)].join(",") +
      (bg.opacity !== undefined ? " @" + bg.opacity : ""));
  }
  for (const k of p.children) {
    console.log("    [" + String(k.i).padStart(2) + "] " + k.type.padEnd(10) + String(k.nodes).padStart(7) + "  " +
      JSON.stringify(k.name).padEnd(28) + " at " + k.x + "," + k.y);
  }
}
console.log("");
console.log("total: " + total + " nodes across " + r.pages.length + " pages");
if (OUT) { writeFileSync(OUT, JSON.stringify(r, null, 2), "utf8"); console.log("written " + OUT); }

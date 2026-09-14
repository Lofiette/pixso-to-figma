// Enumerate the pages of the open Pixso file and what sits at the top of each.
//
//   node px-pages.mjs [out.json] [--scope file|page|selection] [--page <name>]
//
// A file is not one page. Migrating a file means creating the pages too, with their names and
// backgrounds, and putting each page's top-level children on the right one.
//
// Read in pieces, because Pixso kills a script at about fifteen seconds and counting the nodes of a
// whole component library does not fit: one file here has 48 pages and 326 top-level objects on one
// of them, and asking for all of it at once simply returns "Script execution timed out" — at the
// very first step, before anything can be migrated at all. So the page list is fetched cheaply and
// the counting is done a slice at a time, with the slice halved and retried when it is still too
// much. And when the scope is one page or one selection, the rest of the file is never counted.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); if (i < 0) return null; return argv.splice(i, 2)[1]; }
const SCOPE = flag("--scope") || "file";
const WANT_PAGE = flag("--page");
const [OUT] = argv;
const NL = String.fromCharCode(10);

let calls = 0;
function run(src) {
  calls++;
  writeFileSync("_pages.js", src, "utf8");
  const out = execFileSync("node", ["mcp.mjs", "script", "_pages.js"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  const r = JSON.parse(out);
  if (r && r.error) throw new Error(String(r.error));
  return r;
}

const COUNT_FN = "function count(n){var c=1;var k=n.children;if(k)for(var i=0;i<k.length;i++)c+=count(k[i]);return c;}";

// ---------- the page list, without counting anything ----------
let head;
try {
  head = run([
    "await pixso.loadAllPagesAsync();",
    "const pages = [];",
    "for (const pg of pixso.root.children) {",
    "  let bg = null; try { bg = pg.backgrounds; } catch (e) {}",
    "  pages.push({ id: pg.id, name: pg.name, backgrounds: bg, childCount: pg.children.length });",
    "}",
    // The selection is cheap and always worth having: it is what "migrate what I have selected"
    // needs, and a selected node is usually not a top-level child, so its page travels with it.
    "const sel = [];",
    "try {",
    "  const cp = pixso.currentPage;",
    "  for (const n of cp.selection) {",
    "    let bb = null; try { bb = n.absoluteBoundingBox; } catch (e) {}",
    "    let top = false; try { top = n.parent && n.parent.id === cp.id; } catch (e) {}",
    "    sel.push({ id: n.id, name: n.name, type: n.type, page: cp.name, topLevel: top,",
    "      x: bb ? Math.round(bb.x) : null, y: bb ? Math.round(bb.y) : null,",
    "      w: bb ? Math.round(bb.width) : null, h: bb ? Math.round(bb.height) : null });",
    "  }",
    "} catch (e) {}",
    "return { file: pixso.root.name, fileKey: pixso.fileKey, currentPage: pixso.currentPage.name, pages: pages, selection: sel };",
  ].join(NL));
} catch (e) {
  console.error("failed to read the file: " + String(e.message).slice(0, 300));
  process.exit(1);
}

// ---------- how much of it to count ----------
const pageWanted = SCOPE === "file" ? null : (WANT_PAGE || head.currentPage);
const toCount = SCOPE === "selection" ? [] : head.pages.filter((p) => pageWanted === null || p.name === pageWanted);
if (SCOPE !== "selection" && !toCount.length) {
  console.error("page " + JSON.stringify(pageWanted) + " is not in this file");
  process.exit(1);
}

// One slice of one page's children, with their node counts. Halved and retried when Pixso gives up
// on it: a slice that is too big returns a timeout, not a partial answer, so there is nothing to
// salvage except a smaller question.
function childSlice(pageIndex, from, to) {
  return run([
    "await pixso.loadAllPagesAsync();",
    COUNT_FN,
    "const pg = pixso.root.children[" + pageIndex + "];",
    "const out = [];",
    "for (let i = " + from + "; i < Math.min(" + to + ", pg.children.length); i++) {",
    "  const c = pg.children[i];",
    "  let bb = null; try { bb = c.absoluteBoundingBox; } catch (e) {}",
    "  out.push({ i: i, id: c.id, name: c.name, type: c.type, nodes: count(c),",
    "    x: bb ? Math.round(bb.x) : null, y: bb ? Math.round(bb.y) : null,",
    "    w: bb ? Math.round(bb.width) : null, h: bb ? Math.round(bb.height) : null });",
    "}",
    "return { kids: out };",
  ].join(NL));
}

const byId = new Map(head.pages.map((p, i) => [p.id, i]));
for (const p of head.pages) { p.children = []; p.nodes = null; p.counted = false; }

for (const p of toCount) {
  const pi = byId.get(p.id);
  let from = 0, step = 48;
  while (from < p.childCount) {
    try {
      const r = childSlice(pi, from, from + step);
      p.children.push(...r.kids);
      from += step;
    } catch (e) {
      if (step > 1) { step = Math.max(1, Math.floor(step / 2)); continue; }
      // A single child that cannot be counted is recorded without a count rather than losing the
      // page: it can still be migrated, only the estimate is poorer for it.
      console.error("  could not count child " + from + " of page " + JSON.stringify(p.name) + " — recording it uncounted");
      p.children.push({ i: from, id: null, name: "?", type: "?", nodes: 0, x: null, y: null, w: null, h: null });
      from += 1;
      step = 48;
    }
  }
  p.nodes = p.children.reduce((a, c) => a + (c.nodes || 0), 0);
  p.counted = true;
}

// The selection's own node counts, one call, only when it is what was asked for.
if (SCOPE === "selection" && head.selection.length) {
  try {
    const r = run([
      "await pixso.loadAllPagesAsync();",
      COUNT_FN,
      "const ids = " + JSON.stringify(head.selection.map((s) => s.id)) + ";",
      "const out = {};",
      "for (const id of ids) { const n = pixso.getNodeById(id); out[id] = n ? count(n) : 0; }",
      "return { counts: out };",
    ].join(NL));
    for (const s of head.selection) s.nodes = r.counts[s.id] || 0;
  } catch (e) {
    console.error("  could not count the selection — continuing without an estimate");
    for (const s of head.selection) s.nodes = 0;
  }
}

const doc = { file: head.file, fileKey: head.fileKey, currentPage: head.currentPage,
  scope: SCOPE, pages: head.pages, selection: head.selection };

console.log("file: " + JSON.stringify(doc.file) + "   pages: " + doc.pages.length +
  "   open: " + JSON.stringify(doc.currentPage) + "   (" + calls + " calls to Pixso)");
let total = 0;
for (const p of doc.pages) {
  if (!p.counted) continue;
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
    console.log("    [" + String(k.i).padStart(2) + "] " + String(k.type).padEnd(10) + String(k.nodes).padStart(7) + "  " +
      JSON.stringify(k.name).padEnd(28) + " at " + k.x + "," + k.y);
  }
}
const skipped = doc.pages.filter((p) => !p.counted).length;
console.log("");
if (doc.selection.length) {
  console.log("selected in Pixso right now, on page " + JSON.stringify(doc.selection[0].page) + ":");
  for (const s of doc.selection) {
    console.log("    " + String(s.type).padEnd(10) + String(s.nodes === undefined ? "?" : s.nodes).padStart(7) + "  " +
      JSON.stringify(s.name).padEnd(28) + (s.topLevel ? "  (top level)" : "  (inside the tree)"));
  }
  console.log("");
}
console.log("counted: " + total + " nodes across " + (doc.pages.length - skipped) + " page(s)" +
  (skipped ? ", " + skipped + " page(s) not counted (out of scope)" : ""));
if (OUT) { writeFileSync(OUT, JSON.stringify(doc, null, 2), "utf8"); console.log("written " + OUT); }

// Recover per-range text fills that Pixso will not hand over as segments.
//
//   node px-textruns.mjs <ir.json> <rootId> <out.json>
//
// getStyledTextSegments() returns an EMPTY array in Pixso for every node and every field set, so a
// text node with two colours arrives with fills reported as `mixed` and nothing to reconstruct it
// from. getRangeFills(i, i+1) does work, so the runs are rebuilt character by character in the
// sandbox and coalesced there — only the runs cross the wire.
//
// Scope: nodes whose IR fills are mixed. fontName and fontSize are never mixed in the material seen
// so far; if that changes, the same shape extends to getRangeFontName / getRangeFontSize.
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , IR, ROOT_ID, OUT] = process.argv;
if (!IR || !ROOT_ID || !OUT) { console.error("usage: node px-textruns.mjs <ir.json> <rootId> <out.json>"); process.exit(1); }
const ir = JSON.parse(readFileSync(IR, "utf8"));
const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const mixed = (v) => v && typeof v === "object" && v.__mixed;

const jobs = [];
(function walk(n, p) {
  if (n.type === "TEXT" && mixed(n.fills) && typeof n.characters === "string" && n.characters.length) jobs.push(p);
  if (VEC.has(n.type)) return;
  (n.children || []).forEach((c, i) => walk(c, p.concat(i)));
})(ir.tree, []);
console.log("text nodes with mixed fills: " + jobs.length);
if (!jobs.length) { writeFileSync(OUT, "{}", "utf8"); console.log("written " + OUT + " (0)"); process.exit(0); }

function run(src) {
  writeFileSync("_runs.js", src, "utf8");
  try { return JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_runs.js"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim()); }
  catch (e) { return { __err: String(e.message).slice(0, 200) }; }
}

const script = (batch) => [
  "await pixso.loadAllPagesAsync();",
  "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
  "const P = " + JSON.stringify(batch) + ";",
  "const out = [];",
  "for (const path of P) {",
  "  let n = root, ok = true;",
  "  for (const i of path) { if (!n || !n.children || !n.children[i]) { ok = false; break; } n = n.children[i]; }",
  "  if (!ok) { out.push({ e: 'path' }); continue; }",
  "  try {",
  "    const len = n.characters.length;",
  "    const runs = [];",
  "    let prev = null, start = 0;",
  "    for (let i = 0; i < len; i++) {",
  "      let f = null;",
  "      try { f = n.getRangeFills(i, i + 1); } catch (e) { f = null; }",
  "      const key = JSON.stringify(f);",
  "      if (prev === null) { prev = key; start = 0; continue; }",
  "      if (key !== prev) { runs.push({ s: start, e: i, f: JSON.parse(prev) }); prev = key; start = i; }",
  "    }",
  "    if (prev !== null) runs.push({ s: start, e: len, f: JSON.parse(prev) });",
  "    out.push({ runs: runs });",
  "  } catch (e) { out.push({ e: String(e && e.message || e).slice(0, 120) }); }",
  "}",
  "return { out: out };"
].join("\n");

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const queue = chunk(jobs, Number(process.env.PX_RUNS_BATCH || 20));
const result = {};
let done = 0, splits = 0, fails = 0, multi = 0;
while (queue.length) {
  const batch = queue.shift();
  const r = run(script(batch));
  if (r.__err || !r.out) {
    if (batch.length > 1) { const h = Math.ceil(batch.length / 2); queue.unshift(batch.slice(h)); queue.unshift(batch.slice(0, h)); splits++; continue; }
    console.log("  FAIL " + batch[0].join("/") + ": " + String(r.__err || "no out").slice(0, 120)); fails++; done++; continue;
  }
  r.out.forEach((o, i) => {
    done++;
    if (o.e) { console.log("  err " + batch[i].join("/") + ": " + o.e); fails++; return; }
    result[batch[i].join(".")] = o.runs;
    if (o.runs.length > 1) multi++;
  });
  process.stdout.write(String.fromCharCode(13) + "  " + done + "/" + jobs.length + " (splits " + splits + ")  ");
}
console.log("");
writeFileSync(OUT, JSON.stringify(result), "utf8");
console.log("recovered " + Object.keys(result).length + " nodes, " + multi + " with more than one run (" + fails + " failed) -> " + OUT);

// Export outermost vector-ish subtrees of a Pixso root as SVG, addressed by child-index path.
// usage: node px-svg.mjs <irFile> <rootId> <out.json>
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const [, , IR, ROOT_ID, OUT = "svg.json"] = process.argv;
const ir = JSON.parse(readFileSync(IR, "utf8"));

const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const jobs = [];
(function walk(n, path) {
  if (VEC.has(n.type)) { jobs.push({ path, id: n.id, type: n.type, name: n.name, w: n.width, h: n.height }); return; }
  (n.children || []).forEach((c, i) => walk(c, path.concat(i)));
})(ir.tree, []);
console.log("svg jobs: " + jobs.length);

function run(src) {
  writeFileSync("_svg.js", src, "utf8");
  let raw;
  try { raw = execFileSync("node", ["mcp.mjs", "script", "_svg.js"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }); }
  catch (e) { return { __err: "transport: " + String(e.message).slice(0, 200) }; }
  try { return JSON.parse(raw.trim()); } catch { return { __err: "non-JSON: " + raw.trim().slice(0, 200) }; }
}

const script = (batch) => [
  "await pixso.loadAllPagesAsync();",
  "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
  "if (!root) return { error: 'root not found' };",
  "const paths = " + JSON.stringify(batch.map((j) => j.path)) + ";",
  "const out = []; const t0 = Date.now();",
  "for (let k = 0; k < paths.length; k++) {",
  "  let n = root, ok = true;",
  "  for (const i of paths[k]) { if (!n || !n.children || !n.children[i]) { ok = false; break; } n = n.children[i]; }",
  "  if (!ok) { out.push({ e: 'path' }); continue; }",
  "  try {",
  "    const b = await n.exportAsync({ format: 'SVG' });",
  "    let s = ''; const CH = 8192;",
  "    for (let p = 0; p < b.length; p += CH) s += String.fromCharCode.apply(null, b.subarray ? b.subarray(p, p + CH) : Array.prototype.slice.call(b, p, p + CH));",
  "    out.push({ t: n.type, n: n.name, s: s });",
  "  } catch (e) { out.push({ e: String(e && e.message || e).slice(0, 160) }); }",
  "}",
  "return { out: out, ms: Date.now() - t0 };"
].join("\n");

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const queue = chunk(jobs, Number(process.env.PX_SVG_BATCH || 100));
const results = new Map();
let splits = 0, done = 0, fails = 0;
while (queue.length) {
  const batch = queue.shift();
  const r = run(script(batch));
  if (r.__err || r.error) {
    if (batch.length > 1) { const h = Math.ceil(batch.length / 2); queue.unshift(batch.slice(h)); queue.unshift(batch.slice(0, h)); splits++; continue; }
    console.log("  FAIL " + batch[0].path.join("/") + ": " + (r.__err || r.error).slice(0, 120)); fails++; done++; continue;
  }
  r.out.forEach((o, i) => {
    done++;
    if (o.e) { fails++; console.log("  err " + batch[i].name + ": " + o.e); return; }
    results.set(batch[i].path.join("."), o.s);
  });
  process.stdout.write("\r  " + done + "/" + jobs.length + " (" + r.ms + " ms/batch, splits " + splits + ")   ");
}
console.log("");

// dedupe by content
const assets = {}, refs = {};
for (const [p, svg] of results) {
  const h = createHash("sha1").update(svg).digest("hex").slice(0, 12);
  if (!assets[h]) assets[h] = svg;
  refs[p] = h;
}
const bytes = Object.values(assets).reduce((a, s) => a + s.length, 0);
writeFileSync(OUT, JSON.stringify({ rootId: ROOT_ID, refs, assets }), "utf8");
console.log("exported " + results.size + "/" + jobs.length + " (fails " + fails + ")");
console.log("unique svg: " + Object.keys(assets).length + "  " + bytes.toLocaleString() + " bytes  -> " + OUT);

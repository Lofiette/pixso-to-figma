// Export specific nodes (given as child-index paths) as SVG. Used for text nodes whose instance
// override Pixso will not disclose through any API: the renderer is the only source left.
// usage: node px-textsvg.mjs <rootId> <paths.json> <out.json>
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [, , ROOT_ID, PATHS, OUT] = process.argv;
const paths = JSON.parse(readFileSync(PATHS, "utf8"));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const out = {};
for (const batch of chunk(paths, 12)) {
  writeFileSync("_tsvg.js", [
    "await pixso.loadAllPagesAsync();",
    "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
    "const P = " + JSON.stringify(batch.map((p) => p.split(".").map(Number))) + ";",
    "const res = [];",
    "for (const p of P) { let n = root; for (const i of p) n = n.children[i];",
    "  try { const b = await n.exportAsync({ format: 'SVG' });",
    "    let s = ''; const CH = 8192;",
    "    for (let q = 0; q < b.length; q += CH) s += String.fromCharCode.apply(null, b.subarray ? b.subarray(q, q + CH) : Array.prototype.slice.call(b, q, q + CH));",
    "    res.push({ s: s, arb: n.absoluteRenderBounds, abb: n.absoluteBoundingBox, name: n.name });",
    "  } catch (e) { res.push({ e: String(e && e.message || e).slice(0, 140) }); } }",
    "return res;"
  ].join("\n"), "utf8");
  const r = JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_tsvg.js"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).trim());
  r.forEach((v, i) => { if (v.e) console.log("  err " + batch[i] + ": " + v.e); else out[batch[i]] = v; });
}
writeFileSync(OUT, JSON.stringify(out), "utf8");
console.log("exported " + Object.keys(out).length + "/" + paths.length + " -> " + OUT);

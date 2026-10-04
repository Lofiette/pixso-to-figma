// Run the plugin's PROBE command: the measurements docs/REWRITE.md §9 needs from the real plugin.
//
//   node plugin-probe.mjs [P1,P2,P3] [--n 50] [--label front] [--out <file outside this repository>]
//
//   P1  the plugin window's real Origin as this runner sees it, and whether Access-Control-Allow-Origin
//       "null" passes in Figma desktop: if the window can talk to the runner at all, it does. If it
//       cannot, every refusal on this console names the Origin it saw; PX_ALLOW_ORIGIN=<that origin>
//       lets it through for one diagnostic run.
//   P2  the cost of one turn four ways (setTimeout(0), getNodeByIdAsync, a round trip to the window,
//       a resolved promise). Run it three times — Figma in front, covered by another window, and
//       minimised — and label each run, because the answer is expected to differ.
//   P3  the largest message that crosses the plugin boundary each way, 0.25 to 16 MB.
//
// Needs the runner plugin open in a scratch Figma file. Results are printed; --out also writes them as
// JSON, and refuses a path inside this repository, because probe results are machine- and file-specific
// and belong with the rest of the private artefacts (docs/REWRITE.md §8).
import { writeFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession } from "./session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const n = flag("--n");
const label = flag("--label");
const out = flag("--out");
const probes = (argv[0] || "P1,P2,P3").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

if (out) {
  const rel = relative(REPO, resolve(out));
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    console.error("refusing to write probe results inside the repository (" + rel + "); give a path outside it");
    process.exit(1);
  }
}

const srv = await openSession();
console.log("probing " + probes.join(", ") + (label ? " (" + label + ")" : "") + " — the runner plugin must be open in a scratch file");
const args = { probes, label: label || undefined };
if (n) args.n = Number(n);
let r;
try { r = await srv.post({ kind: "probe" }, JSON.stringify(args), new Map(), 60 * 60 * 1000); }
catch (e) { console.error("probe failed: " + e.message); srv.close(); process.exit(1); }
srv.close();
if (r.error) { console.error("probe refused: " + r.error); process.exit(1); }

console.log("");
console.log("plugin build " + r.plugin + (r.label ? ", " + r.label : ""));
const p = r.probes || {};
if (p.P1) {
  console.log("P1  status " + p.P1.status + (p.P1.error ? ", error " + p.P1.error : "") + ", window origin " + JSON.stringify(p.P1.uiOrigin));
  try { const e = JSON.parse(p.P1.echo); console.log("    the runner saw Origin " + JSON.stringify(e.headers.origin) + ", Host " + JSON.stringify(e.headers.host)); }
  catch (e) { if (p.P1.echo) console.log("    echo: " + String(p.P1.echo).slice(0, 200)); }
}
if (p.P2) {
  // mean is the whole series over its steps; batch is the step run back to back for 200 ms — the one
  // to read when the clock is Date.now and a step is shorter than its millisecond.
  console.log("P2  clock " + p.P2.clock + "   (ms: min / median / p95 / max, n; mean of the series; mean of a back-to-back batch)");
  for (const k of ["setTimeout0", "getNodeByIdAsync", "uiRoundTrip", "resolvedPromise"]) {
    const s = p.P2[k];
    if (!s) continue;
    console.log("    " + k.padEnd(18) + [s.min, s.median, s.p95, s.max].join(" / ") + "   n " + s.n + " of " + s.asked + (s.lost ? ", " + s.lost + " lost" : "") +
      "   mean " + s.mean + (s.batch ? "   batch " + s.batch.mean + " (" + s.batch.steps + " in " + s.batch.ms + " ms)" : ""));
  }
}
if (p.P3) {
  console.log("P3  largest delivered: plugin -> window " + p.P3.largestDownMB + " MB, window -> plugin " + p.P3.largestUpMB + " MB");
  for (const [dir, rows] of [["plugin -> window", p.P3.pluginToUi], ["window -> plugin", p.P3.uiToPlugin]]) {
    console.log("    " + dir + ": " + (rows || []).map((x) => x.mb + " MB " + (x.arrived === null ? "skipped" : x.arrived ? "ok " + x.ms + " ms" : "LOST")).join(", "));
  }
}
for (const k of Object.keys(p)) if (p[k] && p[k].error) console.log(k + "  error: " + p[k].error);
if (out) { writeFileSync(resolve(out), JSON.stringify(r, null, 2), "utf8"); console.log("written to " + resolve(out)); }

// Build every extracted section through the plugin in one session.
//
//   node build-all.mjs <dir> [<dir> ...]
//
// One server, one plugin connection, one report at the end. Running build-one.mjs per section
// meant the plugin had to survive a server restart between each, and it does not reliably.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { startJobServer } from "./jobserver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
// A file is not one page. --pages <px-pages output> tells the runner which page each
// directory belongs on, so the sections land where they came from instead of all together.
let PAGES = null;
const pi = argv.indexOf("--pages");
if (pi >= 0) { PAGES = JSON.parse(readFileSync(argv[pi + 1], "utf8")); argv.splice(pi, 2); }
// A file with 290 top-level objects will not fit on a command line, so the set can also arrive
// as a list file — one directory per line, which is what migrate-file.mjs writes.
const di = argv.indexOf("--dirs");
if (di >= 0) {
  const lf = argv.splice(di, 2)[1];
  for (const line of readFileSync(lf, "utf8").split(/\r?\n/)) {
    if (line.trim()) argv.push(line.trim());
  }
}
const cli = argv.indexOf("--clean");
const CLEAN = cli >= 0 || !!process.env.PX_CLEAN;
if (cli >= 0) argv.splice(cli, 1);
const DIRS = argv;

function pageFor(rootId) {
  if (!PAGES) return null;
  for (const p of PAGES.pages) for (const c of p.children) if (c.id === rootId) return p;
  return null;
}
if (!DIRS.length) { console.error("usage: node build-all.mjs <dir> [<dir> ...]"); process.exit(1); }
for (const d of DIRS) if (!existsSync(join(d, "payload.json"))) { console.error("no payload in " + d); process.exit(1); }

const srv = startJobServer(3778);
await srv.ready;
console.log("job server on http://localhost:3778");
console.log("open the pix-to-fig runner plugin in Figma — waiting for it…");

// Wait rather than fail: the plugin is opened by hand and the run is long.
const t0 = Date.now();
while (srv.lastPoll() === 0) {
  if (Date.now() - t0 > 10 * 60 * 1000) { console.error("no plugin after 10 minutes, giving up"); srv.close(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("plugin connected after " + Math.round((Date.now() - t0) / 1000) + "s\n");

// Clearing what a previous run built used to be a separate script, and every process boundary
// costs up to a minute: when the runner exits, the plugin's held request is cut and it retries
// on a timer, which a background window throttles to one wake-up a minute. So it happens here,
// on the connection that is already open.
if (CLEAN) {
  const ids = [];
  for (const d of DIRS) {
    try {
      const rr = JSON.parse(readFileSync(join(d, "build-report.json"), "utf8"));
      if (rr.rootId) ids.push(rr.rootId);
    } catch (e) {}
  }
  if (ids.length) {
    const V = [
      "const ids = " + JSON.stringify(ids) + ";",
      "let gone = 0;",
      "for (const id of ids) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed) { n.remove(); gone++; } }",
      "RESULT = { removed: gone, of: ids.length };",
    ].join(String.fromCharCode(10));
    try {
      const rc = await srv.post({ kind: "render", rootNodeId: ids[0] }, JSON.stringify({ V }), new Map(), 600000);
      console.log("cleared " + (rc.removed || 0) + " of " + ids.length + " roots this run will rebuild");
    } catch (e) { console.log("could not clear previous builds: " + e.message); }
  }
}

const results = [];
for (const dir of DIRS) {
  const name = basename(dir);
  const f = (n) => join(dir, n);
  console.log("================ " + name + " ================");
  if (existsSync(f("textruns.json"))) process.env.PX_TEXTRUNS = f("textruns.json");
  else delete process.env.PX_TEXTRUNS;

  const images = new Map();
  if (existsSync(f("img/manifest.json"))) {
    for (const m of JSON.parse(readFileSync(f("img/manifest.json"), "utf8"))) {
      images.set(m.hash, readFileSync(join(f("img"), basename(m.file))));
    }
  }

  let meta = null;
  try { meta = JSON.parse(readFileSync(f("payload-meta.json"), "utf8")); } catch (e) {}
  const pg = meta ? pageFor(meta.rootId) : null;
  if (pg) console.log("  page " + JSON.stringify(pg.name));
  else if (PAGES) console.log("  page: not found for root " + (meta ? meta.rootId : "?") + " — building on the current page");
  const jobPage = pg ? { page: pg.name, pageBg: pg.backgrounds || null } : {};

  let payload = readFileSync(f("payload.json"), "utf8");
  // A build is roughly linear in node count and the biggest sections were sitting right on the
  // old flat 20-minute limit, so the allowance scales with the payload instead.
  const budget = Math.max(10 * 60 * 1000, Math.round(payload.length / 1000) * 400);
  console.log("  payload " + Math.round(payload.length / 1024) + " KB, allowing " +
    Math.round(budget / 60000) + " min");
  let r;
  try { r = await srv.post(Object.assign({ kind: "build" }, jobPage), payload, images, budget); }
  catch (e) { console.error("  " + e.message); results.push({ name, error: e.message }); continue; }
  if (r.error) { console.error("  build failed: " + r.error); results.push({ name, error: r.error }); continue; }
  if (r.ms) console.log("  time: total " + Math.round((r.msTotal || 0) / 1000) + "s  " +
    Object.keys(r.ms).map((k) => k + " " + Math.round(r.ms[k] / 1000) + "s").join(", "));
  console.log("  nodes " + r.nodes + ", svg " + r.svg + ", sections " + (r.sections || 0) +
    ", failures " + (r.failures || []).length + ", rtFail " + r.rtFail +
    ", sizeRepaired " + r.sizeRepaired + ", flow " + ((r.flowAligned || 0) + (r.flowAbsolute || 0)));
  const subs = [...new Set(r.fontSubs || [])];
  if (subs.length) console.log("  fonts substituted: " + subs.join(", "));
  if ((r.failures || []).length) console.log("  first failures: " + JSON.stringify(r.failures.slice(0, 3)));

  // Second pass for text whose instance override Pixso will not disclose.
  const lost = r.textOverrideLost || [];
  if (lost.length) {
    console.log("  " + lost.length + " undisclosed text override(s) — rendering them from the canvas");
    const rootId = JSON.parse(readFileSync(f("ir.json"), "utf8")).meta.rootId;
    const sh = (s, a) => execFileSync("node", [join(HERE, s), ...a], { stdio: "inherit", cwd: HERE });
    try {
      sh("px-lostpaths.mjs", [f("ir.json"), f("textlost.json"), ...lost.map((t) => String(t.i))]);
      sh("px-textsvg.mjs", [rootId, f("textlost.json"), f("textsvg.json")]);
      sh("pack4.mjs", [f("ir.json"), rootId, f("svg.json"), f("bounds.json"), f("abs.json"),
        f("payload2.png"), f("textink.json"), f("textsvg.json")]);
      payload = readFileSync(f("payload2.json"), "utf8");
      const r2 = await srv.post(Object.assign({ kind: "build", cleanupRootId: r.rootId }, jobPage), payload, images, budget);
      if (r2.error) throw new Error(r2.error);
      r = r2;
      console.log("  rebuilt: nodes " + r.nodes + ", overrides left " + (r.textOverrideLost || []).length);
    } catch (e) { console.log("  second pass failed: " + e.message + " — keeping the first build"); }
  }
  writeFileSync(f("build-report.json"), JSON.stringify(r, null, 2), "utf8");

  let c;
  try { c = await srv.post(Object.assign({ kind: "verify", rootNodeId: r.rootId }, jobPage), payload, new Map(), budget); }
  catch (e) { console.error("  verify: " + e.message); results.push({ name, error: e.message }); continue; }
  writeFileSync(f("check-report.json"), JSON.stringify(c, null, 2), "utf8");
  console.log("  verify: " + c.count + "/" + c.expected + " nodes, " + c.visibleOver05 +
    " out of position (worst " + c.maxPosVisible + "), size delta max " + c.maxSize +
    " on " + (c.sizeOver || 0) + " nodes");
  results.push({ name, rootId: r.rootId, nodes: c.count, expected: c.expected,
    posOver: c.visibleOver05, worstPos: c.maxPosVisible, maxSize: c.maxSize, sizeOver: c.sizeOver || 0,
    failures: (r.failures || []).length, fontSubs: subs });
  console.log("");
}
srv.close();

console.log("================ result ================");
console.log("section".padEnd(20) + "nodes".padStart(12) + "misplaced".padStart(11) + "worst".padStart(8) +
  "sizes off".padStart(11) + "max size".padStart(10) + "  fonts");
// A font this machine does not have is not a defect in the migration and must not be presented as
// one — but it must not be hidden either. Text set in a substituted font measures and draws to
// different widths, so the layout around it cannot match, and no amount of correction in the
// builder would make it match honestly. Those objects are counted separately and named.
let exact = 0, heldByFonts = 0, wrong = 0, errored = 0;
const fontUse = new Map();
for (const r of results) {
  if (r.error) { console.log(r.name.padEnd(20) + "  ERROR: " + r.error.slice(0, 60)); errored++; continue; }
  const ok = r.nodes === r.expected && r.posOver === 0 && r.sizeOver === 0 && r.failures === 0;
  for (const f of r.fontSubs) fontUse.set(f, (fontUse.get(f) || 0) + 1);
  if (ok) exact++;
  else if (r.fontSubs.length) heldByFonts++;
  else wrong++;
  console.log(r.name.padEnd(20) + (r.nodes + "/" + r.expected).padStart(12) +
    String(r.posOver).padStart(11) + String(r.worstPos).padStart(8) +
    String(r.sizeOver).padStart(11) + String(r.maxSize).padStart(10) +
    "  " + (r.fontSubs.length ? r.fontSubs.join(", ") : "-"));
}

if (fontUse.size) {
  console.log("\n================ fonts this machine does not have ================");
  for (const [f, n] of [...fontUse.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("  " + f.replace("|", " ").padEnd(34) + n + " object" + (n === 1 ? "" : "s"));
  }
  console.log("  Text set in a substituted font measures to a different width, so the layout around");
  console.log("  it cannot match the source. Install them, restart Figma — it scans fonts only at");
  console.log("  startup — and rebuild those objects.");
}

console.log("\n================ verdict ================");
console.log("  exact                    " + exact + " of " + results.length);
if (heldByFonts) console.log("  held back by fonts       " + heldByFonts + "   (not a migration defect)");
if (wrong) console.log("  wrong, fonts all present " + wrong + "   <- these are the real ones");
if (errored) console.log("  failed to build          " + errored);
const clean = wrong === 0 && errored === 0;
console.log("\n" + (clean
  ? (heldByFonts ? "PASS apart from the missing fonts" : "PASS")
  : "NOT CLEAN"));
process.exit(clean ? 0 : 2);

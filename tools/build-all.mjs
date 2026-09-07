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
const DIRS = process.argv.slice(2);
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
      images.set(m.hash, readFileSync(isAbsolute(m.file) ? m.file : join(dir, m.file)));
    }
  }

  let payload = readFileSync(f("payload.json"), "utf8");
  let r;
  try { r = await srv.post({ kind: "build" }, payload, images); }
  catch (e) { console.error("  " + e.message); results.push({ name, error: e.message }); continue; }
  if (r.error) { console.error("  build failed: " + r.error); results.push({ name, error: r.error }); continue; }
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
      const r2 = await srv.post({ kind: "build", cleanupRootId: r.rootId }, payload, images);
      if (r2.error) throw new Error(r2.error);
      r = r2;
      console.log("  rebuilt: nodes " + r.nodes + ", overrides left " + (r.textOverrideLost || []).length);
    } catch (e) { console.log("  second pass failed: " + e.message + " — keeping the first build"); }
  }
  writeFileSync(f("build-report.json"), JSON.stringify(r, null, 2), "utf8");

  let c;
  try { c = await srv.post({ kind: "verify", rootNodeId: r.rootId }, payload); }
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
let allClean = true;
for (const r of results) {
  if (r.error) { console.log(r.name.padEnd(20) + "  ERROR: " + r.error.slice(0, 60)); allClean = false; continue; }
  const ok = r.nodes === r.expected && r.posOver === 0 && r.sizeOver === 0 && r.failures === 0;
  if (!ok) allClean = false;
  console.log(r.name.padEnd(20) + (r.nodes + "/" + r.expected).padStart(12) +
    String(r.posOver).padStart(11) + String(r.worstPos).padStart(8) +
    String(r.sizeOver).padStart(11) + String(r.maxSize).padStart(10) +
    "  " + (r.fontSubs.length ? r.fontSubs.join(", ") : "-"));
}
console.log("\n" + (allClean ? "PASS" : "NOT CLEAN"));
process.exit(allClean ? 0 : 2);

// The Figma half on its own: take an already-extracted payload directory and build it through the
// plugin, then verify. Separate from migrate.mjs because extraction and building are independent —
// extraction only needs Pixso, building only needs the plugin, and the plugin is the only channel
// that can see locally installed fonts.
//
//   node build-one.mjs <payloadDir> [rootNodeIdToVerifyOnly]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { startJobServer } from "./jobserver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const [, , DIR, VERIFY_ONLY] = process.argv;
if (!DIR) { console.error("usage: node build-one.mjs <payloadDir> [rootNodeId]"); process.exit(1); }
const f = (n) => join(DIR, n);
// Always start from the first-pass payload: a payload2.json left over from an earlier run belongs
// to a build that no longer exists, and verifying against it would compare the wrong tree.
const payloadFile = f("payload.json");
if (!existsSync(payloadFile)) { console.error("no payload in " + DIR); process.exit(1); }
let rootId2 = null;

// The second pass repacks, so it needs the same inputs the first pack had. Per-run flags such as
// PX_PLACE_ABS come from the caller's environment; the per-directory ones are found here.
if (existsSync(f("textruns.json"))) process.env.PX_TEXTRUNS = f("textruns.json");

const images = new Map();
if (existsSync(f("img/manifest.json"))) {
  for (const m of JSON.parse(readFileSync(f("img/manifest.json"), "utf8"))) {
    images.set(m.hash, readFileSync(join(f("img"), basename(m.file))));
  }
}

const srv = startJobServer(3778);
await srv.ready;
console.log("job server up — the pix-to-fig runner plugin can connect");
console.log("payload " + payloadFile + "   images " + images.size);

const payload = readFileSync(payloadFile, "utf8");
let rootId = VERIFY_ONLY;

if (!VERIFY_ONLY) {
  console.log("\nbuilding…");
  const r = await srv.post({ kind: "build" }, payload, images);
  if (r.error) { console.error("build failed: " + r.error + "\n" + (r.stack || "")); srv.close(); process.exit(1); }
  rootId = r.rootId;
  console.log("  nodes " + r.nodes + ", svg " + r.svg + ", sections " + (r.sections || 0) +
    ", failures " + (r.failures || []).length + ", rtFail " + r.rtFail +
    ", sizeRepaired " + r.sizeRepaired + " (rejected " + (r.sizeRejected || 0) + ")" +
    ", flow " + ((r.flowAligned || 0) + (r.flowAbsolute || 0)) +
    " (rejected " + (r.flowRejected || 0) + ", reverted " + (r.flowReverted || 0) + ")");
  console.log("  fonts substituted: " + ([...new Set(r.fontSubs || [])].join(", ") || "none"));
  if ((r.failures || []).length) console.log("  first failures: " + JSON.stringify(r.failures.slice(0, 5)));
  writeFileSync(f("build-report.json"), JSON.stringify(r, null, 2), "utf8");

  // Second pass. Pixso will not disclose some instance text overrides through any API, so the
  // build detects them by width and they have to be rendered from the canvas and packed again.
  // This needs Pixso, unlike the rest of this script.
  const lost = r.textOverrideLost || [];
  if (lost.length) {
    console.log("\n" + lost.length + " undisclosed text override(s), rendering them from the canvas:");
    for (const t of lost) console.log("  #" + t.i + "  " + JSON.stringify(t.name) + "  inked " + t.inked + " vs drawn " + t.drew);
    const rootId = JSON.parse(readFileSync(f("ir.json"), "utf8")).meta.rootId;
    const sh = (s, a) => execFileSync("node", [join(HERE, s), ...a], { stdio: "inherit", cwd: HERE });
    sh("px-lostpaths.mjs", [f("ir.json"), f("textlost.json"), ...lost.map((t) => String(t.i))]);
    sh("px-textsvg.mjs", [rootId, f("textlost.json"), f("textsvg.json")]);
    const packArgs = [f("ir.json"), rootId, f("svg.json"), f("bounds.json"), f("abs.json"),
      f("payload2.png"), f("textink.json"), f("textsvg.json")];
    execFileSync("node", [join(HERE, "pack4.mjs"), ...packArgs], { stdio: "inherit", cwd: HERE });
    console.log("\nrebuilding with the rendered text…");
    const r2 = await srv.post({ kind: "build", cleanupRootId: r.rootId }, readFileSync(f("payload2.json"), "utf8"), images);
    if (r2.error) { console.error("rebuild failed: " + r2.error); srv.close(); process.exit(1); }
    rootId2 = r2.rootId;
    console.log("  nodes " + r2.nodes + ", svg " + r2.svg + ", failures " + (r2.failures || []).length +
      ", text overrides left " + (r2.textOverrideLost || []).length);
    writeFileSync(f("build-report.json"), JSON.stringify(r2, null, 2), "utf8");
  }
}

// Verify against the payload that actually produced the tree standing in the file.
const finalRoot = rootId2 || rootId;
const finalPayload = rootId2 ? readFileSync(f("payload2.json"), "utf8") : payload;
console.log("\nverifying " + finalRoot + "…");
const c = await srv.post({ kind: "verify", rootNodeId: finalRoot }, finalPayload);
srv.close();
writeFileSync(f("check-report.json"), JSON.stringify(c, null, 2), "utf8");

console.log("  nodes            " + c.count + " / " + c.expected);
console.log("  visible nodes    " + c.visibleNodes);
console.log("  out of position  " + c.visibleOver05 + " over 0.5 px (worst " + c.maxPosVisible + ")");
console.log("  size delta       max " + c.maxSize + " px");
const clean = c.count === c.expected && c.visibleOver05 === 0;
console.log("\n" + (clean ? "PASS" : "NOT CLEAN"));
process.exit(clean ? 0 : 2);

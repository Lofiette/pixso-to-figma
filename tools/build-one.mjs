// The Figma half on its own: take an already-extracted payload directory and build it through the
// plugin, then verify. Separate from migrate.mjs because extraction and building are independent —
// extraction only needs Pixso, building only needs the plugin, and the plugin is the only channel
// that can see locally installed fonts.
//
//   node build-one.mjs <payloadDir> [rootNodeIdToVerifyOnly]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { startJobServer } from "./jobserver.mjs";

const [, , DIR, VERIFY_ONLY] = process.argv;
if (!DIR) { console.error("usage: node build-one.mjs <payloadDir> [rootNodeId]"); process.exit(1); }
const f = (n) => join(DIR, n);
const payloadFile = existsSync(f("payload2.json")) ? f("payload2.json") : f("payload.json");
if (!existsSync(payloadFile)) { console.error("no payload in " + DIR); process.exit(1); }

const images = new Map();
if (existsSync(f("img/manifest.json"))) {
  for (const m of JSON.parse(readFileSync(f("img/manifest.json"), "utf8"))) {
    images.set(m.hash, readFileSync(isAbsolute(m.file) ? m.file : join(DIR, m.file)));
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
  if ((r.textOverrideLost || []).length) console.log("  undisclosed text overrides: " + JSON.stringify(r.textOverrideLost));
  writeFileSync(f("build-report.json"), JSON.stringify(r, null, 2), "utf8");
}

console.log("\nverifying " + rootId + "…");
const c = await srv.post({ kind: "verify", rootNodeId: rootId }, payload);
srv.close();
writeFileSync(f("check-report.json"), JSON.stringify(c, null, 2), "utf8");

console.log("  nodes            " + c.count + " / " + c.expected);
console.log("  visible nodes    " + c.visibleNodes);
console.log("  out of position  " + c.visibleOver05 + " over 0.5 px (worst " + c.maxPosVisible + ")");
console.log("  size delta       max " + c.maxSize + " px");
const clean = c.count === c.expected && c.visibleOver05 === 0;
console.log("\n" + (clean ? "PASS" : "NOT CLEAN"));
process.exit(clean ? 0 : 2);

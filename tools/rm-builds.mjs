// Remove every root this run has already built, so a fresh full build does not duplicate them.
//   node rm-builds.mjs <dirs list file>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startJobServer } from "./jobserver.mjs";

const LIST = process.argv[2];
const dirs = readFileSync(LIST, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const ids = [];
for (const d of dirs) {
  const f = join(d, "build-report.json");
  if (!existsSync(f)) continue;
  try { const r = JSON.parse(readFileSync(f, "utf8")); if (r.rootId) ids.push(r.rootId); } catch (e) {}
}
console.log(ids.length + " roots recorded as built");
if (!ids.length) process.exit(0);

const srv = startJobServer(3778);
await srv.ready;
const V = [
  "const ids = " + JSON.stringify(ids) + ";",
  "let gone = 0, missing = 0;",
  "for (const id of ids) {",
  "  const n = await figma.getNodeByIdAsync(id);",
  "  if (n && !n.removed) { n.remove(); gone++; } else missing++;",
  "}",
  "RESULT = { removed: gone, alreadyGone: missing };",
].join(String.fromCharCode(10));
try { console.log(JSON.stringify(await srv.post({ kind: "render", rootNodeId: ids[0] }, JSON.stringify({ V }), new Map(), 300000))); }
catch (e) { console.log("FAILED: " + e.message); }
srv.close();

// Build a whole file from the command line. The work itself lives in build-lib.mjs, because the
// same loop is driven from the button in the plugin window (tools/run.mjs) and there must be one
// copy of it.
//
//   PX_PLACE_ABS=1 node build-all.mjs --clean --pages <pages.json> --dirs <dirs.txt>
import { readFileSync } from "node:fs";
import { startJobServer } from "./jobserver.mjs";
import { buildAll, verdict } from "./build-lib.mjs";

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); if (i < 0) return null; return argv.splice(i, 2)[1]; }
const CLEAN = (() => { const i = argv.indexOf("--clean"); if (i < 0) return false; argv.splice(i, 1); return true; })();
const pagesFile = flag("--pages");
const dirsFile = flag("--dirs");
const pages = pagesFile ? JSON.parse(readFileSync(pagesFile, "utf8")) : null;
const dirs = dirsFile
  ? readFileSync(dirsFile, "utf8").split(String.fromCharCode(10)).map((s) => s.trim().replace(String.fromCharCode(13), "")).filter(Boolean)
  : argv;
if (!dirs.length) { console.error("usage: node build-all.mjs [--clean] [--pages p.json] --dirs list.txt"); process.exit(1); }

const srv = startJobServer(3778);
await srv.ready;
console.log("job server on http://localhost:3778");
console.log("open the pix-to-fig runner plugin in Figma — waiting for it…");
const t0 = Date.now();
while (srv.lastPoll() === 0) {
  if (Date.now() - t0 > 10 * 60 * 1000) { console.error("no plugin after 10 minutes, giving up"); srv.close(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("plugin connected after " + Math.round((Date.now() - t0) / 1000) + "s");

const results = await buildAll({ srv, dirs, pages, clean: CLEAN });
srv.close();
const v = verdict(results);
process.exit(v.clean ? 0 : 2);

// Build a whole file from the command line. The work itself lives in build-lib.mjs, because the
// same loop is driven from the button in the plugin window (tools/run.mjs) and there must be one
// copy of it.
//
//   PX_PLACE_ABS=1 node build-all.mjs --clean --pages <pages.json> --dirs <dirs.txt> [--states <states.json>]
//
// dirs.txt names only what extraction produced. The objects it failed or never reached are in
// states.json next to it (or wherever --states says), and the verdict counts them as failed: a file
// whose extraction lost objects is NOT CLEAN however well the rest builds.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { openSession } from "./session.mjs";
import { buildAll, verdict } from "./build-lib.mjs";
import { readStates, unextracted } from "./extract-lib.mjs";

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); if (i < 0) return null; return argv.splice(i, 2)[1]; }
const CLEAN = (() => { const i = argv.indexOf("--clean"); if (i < 0) return false; argv.splice(i, 1); return true; })();
const pagesFile = flag("--pages");
const dirsFile = flag("--dirs");
const statesFlag = flag("--states");
const statesFile = statesFlag || (dirsFile && existsSync(join(dirname(dirsFile), "states.json")) ? join(dirname(dirsFile), "states.json") : null);
const pages = pagesFile ? JSON.parse(readFileSync(pagesFile, "utf8")) : null;
const dirs = dirsFile
  ? readFileSync(dirsFile, "utf8").split(String.fromCharCode(10)).map((s) => s.trim().replace(String.fromCharCode(13), "")).filter(Boolean)
  : argv;
let losses = [];
if (statesFile) {
  const states = readStates(statesFile);
  if (!states) { console.error("cannot read " + statesFile); process.exit(1); }
  losses = unextracted(states);
  if (losses.length) console.log(losses.length + " object(s) in " + statesFile + " were not extracted; the verdict counts them as failed");
}
if (!dirs.length && !losses.length) { console.error("usage: node build-all.mjs [--clean] [--pages p.json] --dirs list.txt [--states states.json]"); process.exit(1); }
if (!dirs.length) {
  // Nothing to build, but something to report: every object in scope failed to extract.
  verdict([], console.log, losses);
  process.exit(2);
}

const srv = await openSession();
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
const v = verdict(results, console.log, losses);
process.exit(v.clean ? 0 : 2);

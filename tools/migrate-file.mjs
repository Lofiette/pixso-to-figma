// Migrate a whole Pixso file: every page, every top-level object, one command.
//
//   node migrate-file.mjs <pages.json> <outDir> [--page <name|index>] [--only <n,n,n>] [--build]
//
// px-pages.mjs says what the file contains; this walks that list and runs the per-object
// pipeline over it. Extraction is one payload per top-level object, which is what the
// exporter, the packer and the verifier are all built around — a file with 290 top-level
// objects is the reason this exists, because that list cannot be typed by hand.
//
// The loop itself lives in extract-lib.mjs. What it leaves in <outDir>:
//   states.json   every object's end state — extracted, failed or skipped — and the run's status;
//                 rewritten after each object, so it is also the checkpoint
//   dirs.txt      the objects that can be built (what build-all, coverage and visual-all read)
//   <object>/extract-error.log   the complete output of a failed object, never shortened
// If Pixso stops answering, the loop stops issuing work, says so, waits up to 10 minutes for Pixso
// to come back with the same file open, and resumes. Run it again at any time: what is already
// extracted is skipped and what failed is tried again.
//
// Exit codes: 0 everything extracted; 2 some objects failed or were skipped; 3 stopped because
// Pixso did not come back; 4 stopped because a different file is open in Pixso (IDENTITY_CHANGED).
//
// Extraction needs Pixso open on the file. --build then hands the whole set to build-all.mjs,
// which needs the runner plugin open in the target Figma file.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planJobs, extractAll, EXIT } from "./extract-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); if (i < 0) return null; return argv.splice(i, 2)[1]; }
const DO_BUILD = (() => { const i = argv.indexOf("--build"); if (i < 0) return false; argv.splice(i, 1); return true; })();
const SELECTION = (() => { const i = argv.indexOf("--selection"); if (i < 0) return false; argv.splice(i, 1); return true; })();
const PAGE_SEL = flag("--page");
const ONLY = flag("--only");
const [PAGES_FILE, OUT_ARG] = argv;
if (!PAGES_FILE || !OUT_ARG) {
  console.error("usage: node migrate-file.mjs <pages.json> <outDir> [--page <name|index>] [--selection] [--only <n,n>] [--build]");
  process.exit(1);
}

// Absolute, because every object runs with tools/ as its working directory while this process may
// have been started anywhere: a relative folder meant two different places to the two of them.
const OUT_DIR = resolve(OUT_ARG);
const doc = JSON.parse(readFileSync(PAGES_FILE, "utf8"));
let jobs;
try { jobs = planJobs(doc, OUT_DIR, { selection: SELECTION, page: PAGE_SEL, only: ONLY }); }
catch (e) { console.error(e.message); process.exit(1); }

const totalNodes = jobs.reduce((a, j) => a + (j.nodes || 0), 0);
console.log("file " + JSON.stringify(doc.file));
console.log(jobs.length + " objects, " + totalNodes + " nodes\n");

const res = await extractAll({ doc, jobs, outDir: OUT_DIR });
if (res.exitCode === EXIT.PIXSO_GONE || res.exitCode === EXIT.IDENTITY_CHANGED) process.exit(res.exitCode);

if (!DO_BUILD) {
  console.log("\nto build them into the open Figma file (runner plugin must be open):");
  console.log("  PX_PLACE_ABS=1 node build-all.mjs --pages " + PAGES_FILE + " --dirs " + res.files.dirs + " --states " + res.files.states);
  process.exit(res.exitCode);
}

console.log("\n================ build ================");
try {
  execFileSync("node", [join(HERE, "build-all.mjs"), "--pages", PAGES_FILE, "--dirs", res.files.dirs, "--states", res.files.states], {
    cwd: HERE, stdio: "inherit",
    env: Object.assign({}, process.env, { PX_PLACE_ABS: "1" }),
  });
} catch (e) { process.exit(e.status || 2); }
// Built cleanly, but objects that never reached Figma still make the run unclean; build-all's
// verdict already said so from states.json.
process.exit(res.exitCode);

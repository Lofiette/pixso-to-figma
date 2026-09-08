// Migrate a whole Pixso file: every page, every top-level object, one command.
//
//   node migrate-file.mjs <pages.json> <outDir> [--page <name|index>] [--only <n,n,n>] [--build]
//
// px-pages.mjs says what the file contains; this walks that list and runs the per-object
// pipeline over it. Extraction is one payload per top-level object, which is what the
// exporter, the packer and the verifier are all built around — a file with 290 top-level
// objects is the reason this exists, because that list cannot be typed by hand.
//
// Extraction needs Pixso open on the file. --build then hands the whole set to build-all.mjs,
// which needs the runner plugin open in the target Figma file.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); if (i < 0) return null; return argv.splice(i, 2)[1]; }
const DO_BUILD = (() => { const i = argv.indexOf("--build"); if (i < 0) return false; argv.splice(i, 1); return true; })();
const PAGE_SEL = flag("--page");
const ONLY = flag("--only");
const [PAGES_FILE, OUT_DIR] = argv;
if (!PAGES_FILE || !OUT_DIR) {
  console.error("usage: node migrate-file.mjs <pages.json> <outDir> [--page <name|index>] [--only <n,n>] [--build]");
  process.exit(1);
}

const doc = JSON.parse(readFileSync(PAGES_FILE, "utf8"));
mkdirSync(OUT_DIR, { recursive: true });

// Directory names have to survive Windows, so the object's own name is only a hint; the index
// pair is what makes it unique and what maps back to pages.json.
const slug = (s) => (s || "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

const jobs = [];
doc.pages.forEach((pg, pi) => {
  if (PAGE_SEL !== null && String(pi) !== PAGE_SEL && pg.name !== PAGE_SEL) return;
  pg.children.forEach((c, ci) => {
    if (ONLY && !ONLY.split(",").map(Number).includes(ci)) return;
    jobs.push({ pi, ci, page: pg.name, id: c.id, name: c.name, type: c.type, nodes: c.nodes,
      dir: join(OUT_DIR, pi + "-" + String(ci).padStart(3, "0") + "-" + slug(c.name)) });
  });
});

const totalNodes = jobs.reduce((a, j) => a + j.nodes, 0);
console.log("file " + JSON.stringify(doc.file));
console.log(jobs.length + " objects, " + totalNodes + " nodes\n");

const done = (p) => { try { return statSync(p).size > 2; } catch { return false; } };
const t0 = Date.now();
const failed = [];
let extracted = 0, skipped = 0;

for (let k = 0; k < jobs.length; k++) {
  const j = jobs[k];
  const tag = "[" + (k + 1) + "/" + jobs.length + "] " + j.type + " " + j.nodes + "n  " + JSON.stringify(j.name);
  if (done(join(j.dir, "payload.json"))) { console.log(tag + "  — already extracted"); skipped++; continue; }
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(tag + "   (" + el + "s elapsed)");
  try {
    execFileSync("node", [join(HERE, "migrate.mjs"), j.id, j.dir], {
      cwd: HERE, stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { PX_EXTRACT_ONLY: "1", PX_PLACE_ABS: "1",
        PX_IMG_CACHE: join(OUT_DIR, "imgcache") }),
    });
    extracted++;
  } catch (e) {
    const out = ((e.stdout || "") + "" + (e.stderr || "")).split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
    console.log("      FAILED: " + out.slice(0, 300));
    failed.push({ ...j, error: out.slice(0, 500) });
  }
}

console.log("\n================ extraction ================");
console.log("extracted " + extracted + ", already present " + skipped + ", failed " + failed.length +
  "   in " + Math.round((Date.now() - t0) / 1000) + "s");
for (const f of failed) console.log("  FAIL  " + f.pi + "-" + f.ci + " " + JSON.stringify(f.name) + "  " + f.id);

const ok = jobs.filter((j) => done(join(j.dir, "payload.json")));
const listFile = join(OUT_DIR, "dirs.txt");
writeFileSync(listFile, ok.map((j) => j.dir).join("\n") + "\n", "utf8");
writeFileSync(join(OUT_DIR, "jobs.json"), JSON.stringify({ file: doc.file, jobs, failed }, null, 2), "utf8");
console.log("\n" + ok.length + " payloads ready, listed in " + listFile);

if (!DO_BUILD) {
  console.log("\nto build them into the open Figma file (runner plugin must be open):");
  console.log("  PX_PLACE_ABS=1 node build-all.mjs --pages " + PAGES_FILE + " --dirs " + listFile);
  process.exit(failed.length ? 2 : 0);
}

console.log("\n================ build ================");
try {
  execFileSync("node", [join(HERE, "build-all.mjs"), "--pages", PAGES_FILE, "--dirs", listFile], {
    cwd: HERE, stdio: "inherit",
    env: Object.assign({}, process.env, { PX_PLACE_ABS: "1" }),
  });
} catch (e) { process.exit(e.status || 2); }

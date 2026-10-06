// Read a .pix and write its IR (docs/M1.md §6 A, docs/IR.md).
//
//   node tools/pix-to-ir.mjs <file.pix> --out <ir.json> [--booleans auto|native|flatten]
//        [--space-evenly-single between|center] [--text-fit widen|source-box] [--scope file|pages:<guid>,…]
//        [--mode design|kit] [--stats-only]
//        [--variant-sets parse|frames] [--variant-grammar names|vocabulary] [--axis-order vocabulary|names]
//        [--swap-dangling skip|strict] [--swap-reset on|off] [--swap-fallback derived|off] [--swap-default layer|definition]
//        [--rejected-props copy|none] [--default-assignments keep|drop] [--override-merge last|first|outer]
//        [--echo drop|keep] [--instance-own overrides|own] [--derived-geometry changed|all|none]
//
// The last thirteen are the component reader's settings (docs/M2A.md §3), each defaulting to
// schema.SETTING_DEFAULTS and recorded in the IR header; the reader refuses a value outside its list.
//
// The IR names the file's real layers, so --out must be outside this repository (docs/M1.md D17:
// tools/ir/outside-repo.mjs refuses it otherwise, through junctions and in any drive-letter case).
// It writes <ir.json> and, beside it, <ir.json>.stats.json (the reader's counts and times, with the
// populations as IR indices). Two runs on one file write the same IR bytes; the stats hold times.
// --stats-only reads, validates and prints the counts, and writes nothing.
//
// What it prints is counts only (no names, no keys), so it can be pasted into a pull request.
// A damaged file exits 1 with one PIX_CORRUPT or PIX_UNSUPPORTED line on stderr; a usage error exits 2.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pixToIR } from "./pix/ir/index.mjs";
import { assertOutsideRepo } from "./ir/outside-repo.mjs";
import { M2A_SETTINGS, SETTINGS, SETTING_FLAGS } from "./ir/schema.mjs";

export const FLAGS = { "--booleans": "booleans", "--space-evenly-single": "spaceEvenlySingle", "--text-fit": "textFit", "--scope": "scope", "--mode": "mode" };
for (const k of M2A_SETTINGS) FLAGS[SETTING_FLAGS[k]] = k;

export function parseArgs(argv) {
  const a = { file: null, out: null, statsOnly: false, settings: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--out") a.out = argv[++i];
    else if (k === "--stats-only") a.statsOnly = true;
    else if (Object.prototype.hasOwnProperty.call(FLAGS, k)) {
      const v = argv[++i];
      if (v === undefined) throw usage(k + " needs a value");
      const key = FLAGS[k];
      if (M2A_SETTINGS.indexOf(key) >= 0 && SETTINGS[key].indexOf(v) < 0) throw usage(k + " is one of " + SETTINGS[key].join(", ") + "; got " + JSON.stringify(v));
      a.settings[key] = v;
    } else if (k.startsWith("--")) throw usage("unknown option " + k);
    else if (a.file === null) a.file = k;
    else throw usage("one .pix at a time; got " + k + " as well");
  }
  if (!a.file) throw usage("no .pix given");
  if (!a.out && !a.statsOnly) throw usage("--out <path outside the repository> is required (or --stats-only)");
  return a;
}
function usage(msg) {
  const e = new Error(msg + "\nusage: node tools/pix-to-ir.mjs <file.pix> --out <ir.json> [--booleans auto|native|flatten] " +
    "[--space-evenly-single between|center] [--text-fit widen|source-box] [--scope file|pages:<guid>,…] [--mode design|kit] [--stats-only] " +
    M2A_SETTINGS.map((k) => "[" + SETTING_FLAGS[k] + " " + SETTINGS[k].join("|") + "]").join(" "));
  e.usage = true;
  return e;
}

// The printable summary: counts only.
export function summary(stats) {
  const pop = {};
  for (const k of Object.keys(stats.populations)) pop[k] = stats.populations[k].length;
  return {
    stored: stats.stored, records: stats.records, nonInstance: stats.nonInstance, instances: stats.instances,
    notCarried: stats.notCarried, populations: pop, populationCounts: stats.populationCounts,
    booleans: stats.booleans, sides: stats.sides, images: stats.images, vectors: stats.vectors, notes: stats.notes,
    unsupported: stats.unsupported, spaceEvenly: stats.spaceEvenly, strokeAlignDecided: stats.strokeAlignDecided,
    cornerRadiusOnly: stats.cornerRadiusOnly, lostBorderSections: stats.lostBorderSections, text: stats.text, ms: stats.ms,
    m2a: stats.m2a,
  };
}

function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  let outReal = null;
  if (a.out) {
    try { outReal = assertOutsideRepo(a.out); }
    catch (e) { if (e.code === "INSIDE_REPO") { console.error(e.message); return 2; } throw e; }
  }
  let res;
  try { res = pixToIR(readFileSync(a.file), { settings: a.settings }); }
  catch (e) {
    if (/^PIX_(CORRUPT|UNSUPPORTED):/.test(e.message)) { console.error(e.message.split("\n")[0]); return 1; }
    if (/^pixToIR: (unknown setting|setting|scope)/.test(e.message)) { console.error(e.message + " (" + Object.values(SETTING_FLAGS).join(", ") + ")"); return 2; }
    throw e;
  }
  const t0 = Date.now();
  if (!a.statsOnly) {
    mkdirSync(dirname(outReal), { recursive: true });
    writeFileSync(outReal, JSON.stringify(res.ir), "utf8");
    res.stats.ms.write = Date.now() - t0;
    writeFileSync(outReal + ".stats.json", JSON.stringify(res.stats), "utf8");
  }
  console.log(JSON.stringify(summary(res.stats), null, 1));
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));

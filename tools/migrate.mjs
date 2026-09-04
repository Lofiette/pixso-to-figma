// One deterministic run: Pixso section -> Figma, no model in the loop.
//
//   node migrate.mjs <pixsoSectionId> [workDir]
//
// Needs the Pixso desktop app open on the file with its MCP on 127.0.0.1:3667, and the
// "pix-to-fig runner" plugin running in the target Figma file. Everything else is this script.
//
// The two feedback loops that used to be driven by hand are closed here:
//   - images Pixso will not hand over as bytes are rendered, carried to the plugin, and mapped
//     onto the hashes the payload already uses;
//   - text whose instance override Pixso will not disclose is detected by the build, rendered as
//     vector, repacked, and rebuilt once.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { startJobServer } from "./jobserver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , ROOT_ID, WORK = "../out/run"] = process.argv;
if (!ROOT_ID) { console.error("usage: node migrate.mjs <pixsoSectionId> [workDir]"); process.exit(1); }

const W = join(HERE, WORK);
mkdirSync(W, { recursive: true });
const f = (n) => join(W, n);
const t0 = Date.now();
// Up first, before the Pixso phase: the plugin polls for a job and should connect straight away
// rather than sitting on "connecting" for the length of an export.
const srv = startJobServer(3778);
await srv.ready;
console.log("job server on http://localhost:3778 — the pix-to-fig runner plugin can connect now");
const step = (n) => console.log("\n=== " + n + "  (" + Math.round((Date.now() - t0) / 1000) + "s) ===");

function sh(script, args) {
  execFileSync("node", [join(HERE, script), ...args], { stdio: "inherit", cwd: HERE });
}

// ---------- Pixso side ----------
step("export");
sh("px-export.mjs", [ROOT_ID, f("ir.json")]);
step("svg");
sh("px-svg.mjs", [f("ir.json"), ROOT_ID, f("svg.json")]);
step("bounds / transforms / text ink");
sh("px-bounds.mjs", [f("ir.json"), ROOT_ID, f("bounds.json")]);
sh("px-abs.mjs", [f("ir.json"), ROOT_ID, f("abs.json")]);
sh("px-textink.mjs", [f("ir.json"), ROOT_ID, f("textink.json")]);
sh("px-textruns.mjs", [f("ir.json"), ROOT_ID, f("textruns.json")]);
step("images");
sh("px-images.mjs", [f("ir.json"), ROOT_ID, f("img")]);

process.env.PX_TEXTRUNS = f("textruns.json");

function pack(out, textsvg) {
  const args = [f("ir.json"), ROOT_ID, f("svg.json"), f("bounds.json"), f("abs.json"), out, f("textink.json")];
  if (textsvg) args.push(textsvg);
  sh("pack4.mjs", args);
}

// pack4 writes a PNG carrier for the agent channel; the plugin wants the JSON, which pack4 also
// leaves next to it.
step("pack");
pack(f("payload.png"));
const payloadFile = f("payload.json");
if (!existsSync(payloadFile)) { console.error("pack4 did not write " + payloadFile); process.exit(1); }

// ---------- Figma side ----------
const manifest = JSON.parse(readFileSync(join(W, "img", "manifest.json"), "utf8"));
const images = new Map();
for (const m of manifest) images.set(m.hash, readFileSync(join(HERE, m.file.replace(/^\.\.\//, "../"))));


async function build(cleanupRootId) {
  return srv.post({ kind: "build", cleanupRootId }, readFileSync(payloadFile, "utf8"), images);
}

step("build");
let report = await build(null);
if (report.error) { console.error("build failed: " + report.error + "\n" + (report.stack || "")); srv.close(); process.exit(1); }
console.log(summarise(report));

// ---------- loop: text Pixso would not disclose ----------
if (Array.isArray(report.textOverrideLost) && report.textOverrideLost.length) {
  step("second pass: " + report.textOverrideLost.length + " undisclosed text overrides");
  const idx = report.textOverrideLost.map((r) => String(r.i));
  sh("px-lostpaths.mjs", [f("ir.json"), f("textlost.json"), ...idx]);
  sh("px-textsvg.mjs", [ROOT_ID, f("textlost.json"), f("textsvg.json")]);
  pack(f("payload2.png"), f("textsvg.json"));
  const p2 = f("payload2.json");
  const prev = report.rootId;
  report = await srv.post({ kind: "build", cleanupRootId: prev }, readFileSync(p2, "utf8"), images);
  if (report.error) { console.error("rebuild failed: " + report.error); srv.close(); process.exit(1); }
  console.log(summarise(report));
}

// ---------- acceptance ----------
step("verify");
const usedPayload = existsSync(f("payload2.json")) && report.rootId ? f("payload2.json") : payloadFile;
const check = await srv.post({ kind: "verify", rootNodeId: report.rootId }, readFileSync(usedPayload, "utf8"));
srv.close();

writeFileSync(f("report.json"), JSON.stringify({ build: report, check }, null, 2), "utf8");

console.log("\n================ result ================");
console.log("root                " + report.rootId + "   " + report.rootSize.w + " x " + report.rootSize.h);
console.log("nodes               " + check.count + " / " + check.expected);
console.log("visible nodes       " + check.visibleNodes);
console.log("out of position     " + check.visibleOver05 + " visible over 0.5 px (worst " + check.maxPosVisible + ")");
console.log("size delta          max " + check.maxSize + " px");
console.log("property failures   " + (report.failures || []).length + ", relativeTransform " + report.rtFail);
console.log("text overrides      " + ((report.textOverrideLost || []).length ? JSON.stringify(report.textOverrideLost) : "none left"));
console.log("font substitutions  " + ([...new Set(report.fontSubs || [])].join(", ") || "none"));
console.log("report              " + f("report.json"));
const clean = check.visibleOver05 === 0 && (report.failures || []).length === 0 && report.rtFail === 0 &&
              check.count === check.expected && !(report.textOverrideLost || []).length;
console.log("\n" + (clean ? "PASS" : "NOT CLEAN — see report.json"));
process.exit(clean ? 0 : 2);

function summarise(r) {
  return "  nodes " + r.nodes + ", svg " + r.svg + ", failures " + (r.failures || []).length +
    ", rtFail " + r.rtFail + ", images remapped " + (r.imageRemapped || 0) +
    ", side strokes " + (r.sideStrokes || 0) +
    ", flow fixed " + ((r.flowAligned || 0) + (r.flowAbsolute || 0)) +
    ", text overrides " + (r.textOverrideLost || []).length;
}

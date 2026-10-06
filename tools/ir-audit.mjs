// The render audit of an IR run (docs/M1.md §16): every root the run built, rendered in Figma and in
// Pixso, compared, and written as the audit report tools/m1-accept.mjs --audit reads.
//
//   node tools/ir-audit.mjs <runDir> [--max-side 800] [--max-scale 1] [--ink 191] [--gross-max 0.01]
//     [--mean-max 5] [--tile 32] [--tile-mean-max 0] [--size-tol 1] [--section crop|children|none]
//     [--placeholders mask|compare] [--mask-pad 2] [--image-placeholders compare|mask]
//     [--opacity undo|apply] [--undo-opacity-min 0.05]
//     [--pictures failed|all|none] [--render-timeout-s 120] [--accept-identity-mismatch "<why>"]
//     [--mcp-url <url>] [--fresh]
//
// Needs: Figma desktop with the file the run built and the runner plugin open in it (one window,
// docs/M1.md §15.10), and Pixso with the .pix the run read open in it. Every setting has the default
// above; tools/ir/render-audit.mjs says what each one does.
//
// <runDir> is the folder tools/pix-run.mjs printed. The audit reads states.json, ir.json and
// reports/*-verify.json and *-build.json there (the Figma id of each root its verify found, and the
// nodes each build drew an IMAGE_PLACEHOLDER on) and writes, beside them:
//   audit/audit.json      the report ({ format: "pix2fig.audit", version: 2, snapshot, runId, roots })
//   audit/roots.jsonl     one line per root as it is compared, so a pass that stops halfway keeps what
//                         it measured: a later pass reuses every root that was ok under the same
//                         settings, snapshot and runId, and compares the rest again (--fresh: none)
//   audit/pictures/       both pictures of every root that is not ok (--pictures)
// all of it outside the repository (assertOutsideRepo), like everything else in a run folder.
//
// Pixso is reached only through the read-only script library (tools/ir/mcp-readonly.mjs) and is
// checked first: the open file must be the run's .pix (tools/ir/identity.mjs). SOURCE_IDENTITY_MISMATCH
// stops the audit before anything is rendered; --accept-identity-mismatch "<why>" goes on for a known
// benign difference (renamed nodes, say) and writes the reason and the check's counts into the audit.
// Figma is reached through the plugin's fixed RENDER command (op "export", figma-plugin/src/code.js),
// by the id the run's verify found, proved by the root's stamp and the run's snapshot. Figma
// rasterises only in the front window: it is raised before every render, and a render that does not
// come back is tried once more with the window raised again (tools/focus-figma.mjs).
//
// Exit code: 0 every root ok; 3 a root differs or a render is missing; 2 nothing failed but some root
// was not compared; 4 the identity check stopped it; 1 the run folder, Pixso or the plugin could not
// be reached.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutsideRepo } from "./ir/outside-repo.mjs";
import { checkIdentity } from "./ir/identity.mjs";
import { SCRIPTS, makeMcpClient } from "./ir/mcp-readonly.mjs";
import { auditRun, parseAuditArgs, resultKey } from "./ir/render-audit.mjs";

const NL = String.fromCharCode(10);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// The run folder: states, IR, and the verify and build reports by task number.
export function readRun(runDir) {
  const states = readJson(join(runDir, "states.json"));
  const ir = readJson(join(runDir, "ir.json"));
  const reports = new Map(), builds = new Map();
  const rd = join(runDir, "reports");
  if (existsSync(rd)) for (const f of readdirSync(rd)) {
    const m = /^(\d+)-(verify|build)\.json$/.exec(f);
    if (m) { try { (m[2] === "verify" ? reports : builds).set(Number(m[1]), readJson(join(rd, f))); } catch (e) { /* a broken report finds nothing */ } }
  }
  return { states, ir, reports, builds };
}

// Roots kept from an earlier pass (audit/roots.jsonl): the last line per root.
export function previousRoots(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(NL)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (Number.isInteger(e.i)) out.set(e.i, e); } catch (e) { /* a torn last line */ }
  }
  return out;
}

// The pieces a pass needs from outside: tools/test-iraudit.mjs gives its own (the plugin on the double,
// the fake Pixso); main() gives the real ones.
//   io = { mcp, figmaExport(job), log, identity? (a check already made) }
export async function auditFolder(runDir, opts, io) {
  const log = io.log || console.log;
  const S = opts.settings;
  const { states, ir, reports, builds } = readRun(runDir);
  const outDir = assertOutsideRepo(join(runDir, "audit"));
  mkdirSync(join(outDir, "pictures"), { recursive: true });

  // Pixso first: the open file must be the run's .pix.
  const id = io.identity || await checkIdentity(null, ir, io.mcp);
  if (id.transport || (!id.code && !(id.same && id.q5))) {
    log("ir-audit: Pixso cannot be checked, nothing was rendered: " + id.detail);
    return { code: 1 };
  }
  const identity = { same: id.same, q5: id.q5, code: id.code, detail: id.detail, accepted: null };
  if (id.code) {
    if (!opts.acceptIdentity) {
      log("ir-audit: " + id.code + ": the file open in Pixso is not the run's .pix (" + id.detail + "). Nothing was rendered.");
      log("  Open the .pix the run read in Pixso, or, for a known benign difference such as renamed nodes, run again with");
      log("  --accept-identity-mismatch \"<the difference>\" (it is written into the audit).");
      return { code: 4, identity };
    }
    identity.accepted = opts.acceptIdentity;
    log("ir-audit: " + id.code + " accepted (" + opts.acceptIdentity + "): " + id.detail);
  } else log("pixso: the run's .pix is open (" + id.detail + ")");

  const jsonl = join(outDir, "roots.jsonl");
  const previous = opts.fresh ? new Map() : previousRoots(jsonl);
  const kept = [...previous.values()].filter((e) => e.ok === true && e.key === resultKey(states, S)).length;
  if (kept) log("resuming: " + kept + " roots already ok under these settings are kept");
  const pixsoRender = (guid, scale) => io.mcp.run(SCRIPTS.auditRender(guid, { scale }));
  const audit = await auditRun({ states, ir, reports, builds, settings: S, identity, previous, log,
    figmaExport: io.figmaExport, pixsoRender,
    onRoot: (entry, pics) => {
      appendFileSync(jsonl, JSON.stringify(entry) + NL, "utf8");
      for (const p of pics) {
        if (S.pictures === "none" || (S.pictures === "failed" && p.ok !== false)) continue;
        if (p.figma) writeFileSync(join(outDir, "pictures", p.name + ".figma.png"), Buffer.from(p.figma, "base64"));
        if (p.pixso) writeFileSync(join(outDir, "pictures", p.name + ".pixso.png"), Buffer.from(p.pixso, "base64"));
      }
    } });
  const file = join(outDir, "audit.json");
  writeFileSync(file, JSON.stringify(audit, null, 1), "utf8");
  const C = audit.counts;
  log("");
  log("RENDER AUDIT  " + String(states.snapshot).slice(0, 16) + "…  run " + states.runId);
  log("roots: " + C.roots + "; ok " + C.ok + ", not ok " + C.failed + " (render missing " + C.missing + "), not compared " + C.notCompared +
    "; placeholder roots left to G11: " + C.placeholderRoots);
  const placed = {};
  for (const e of audit.roots) for (const side of ["figma", "pixso"]) if (e[side] && e[side].place) placed[side + " " + e[side].place] = (placed[side + " " + e[side].place] || 0) + 1;
  log("pictures placed by: " + (Object.keys(placed).map((k) => k + " " + placed[k]).join(", ") || "none"));
  log("settings: " + JSON.stringify(S));
  log("audit: " + file);
  log("verdict: node tools/m1-accept.mjs " + JSON.stringify(runDir) + " --audit " + JSON.stringify(file));
  return { code: C.failed ? 3 : C.notCompared ? 2 : 0, audit, file };
}

export async function main(argv) {
  let o;
  try { o = parseAuditArgs(argv); } catch (e) { console.log("ir-audit: " + e.message); console.log("usage: node tools/ir-audit.mjs <runDir> [settings]  (see the head of tools/ir-audit.mjs)"); return 1; }
  const runDir = resolve(o.runDir);
  try { assertOutsideRepo(runDir); readRun(runDir); }
  catch (e) { console.log("ir-audit: the run folder cannot be read: " + ((e && e.message) || e)); return 1; }
  const mcp = makeMcpClient({ dir: join(runDir, "audit", "mcp"), url: o.mcpUrl || undefined, timeoutMs: o.settings.renderTimeoutS * 1000 });
  const { focusFigma } = await import("./focus-figma.mjs");
  const { openSession, waitForPlugin } = await import("./session.mjs");
  let srv = null;
  const io = { mcp, log: console.log,
    figmaExport: async (job) => {
      // Figma rasterises only in the front window: raised before every render, and once more on a retry.
      let r = null, why = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const f = focusFigma();
        if (attempt) console.log("      retrying with the Figma window raised: " + f);
        try { r = await srv.post({ kind: "render" }, JSON.stringify(job), new Map(), o.settings.renderTimeoutS * 1000); }
        catch (e) { r = null; why = String((e && e.message) || e).slice(0, 120); }
        if (r && !r.e && !r.error && r.d) return r;
        if (r && (r.e || r.error)) { if (/not found|another|no child/.test(String(r.e || r.error))) return r; why = String(r.e || r.error); }
      }
      return { e: why || "no picture" };
    } };
  // Pixso is checked before Figma is asked for anything.
  io.identity = await checkIdentity(null, readRun(runDir).ir, mcp);
  if (io.identity.transport) { console.log("ir-audit: Pixso is not reachable: " + io.identity.detail); return 1; }
  if (io.identity.code && !o.acceptIdentity) return (await auditFolder(runDir, o, io)).code;
  try { srv = await openSession(); console.log("figma window: " + focusFigma()); await waitForPlugin(srv); }
  catch (e) { console.log("ir-audit: no plugin: " + ((e && e.message) || e)); if (srv) srv.close(); return 1; }
  try { return (await auditFolder(runDir, o, io)).code; }
  finally { srv.close(); }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.log("ir-audit: " + ((e && e.stack) || e)); process.exitCode = 1; });

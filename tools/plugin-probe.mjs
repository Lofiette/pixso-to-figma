// Run the plugin's PROBE command: the measurements docs/REWRITE.md §9 needs from the real plugin.
//
//   node plugin-probe.mjs [P4,P8,P19B] [--n 50] [--repeat 3] [--keep] [--label front] [--out <file outside this repository>]
//
//   P4    image bytes as base64 against Uint8Array (docs/M1.md §6 E): this script makes two synthetic
//         PNGs (noise, about 1 MB and 4 MB, from a fixed seed), posts them with the job, and the probe
//         fetches each through the plugin window both ways, --repeat times, and creates a Figma image
//         from each; verdicts transport (base64 | binary) and sameHash (ok | differs)
//   P8    the images Figma may refuse (over 4 096 px, a long strip, JPEG and WebP bytes, an IMAGE
//         paint with an unknown hash), made inside the plugin: ok, throw, drop or empty per case
//   P19B  vector networks, geometry-built vectors, booleans and frame masks, in a container frame at
//         (1000, 1000) that is removed afterwards (--keep leaves it, marked for RENDER's scratch-sweep)
//   P1    the plugin window's real Origin as this runner sees it, and whether Access-Control-Allow-Origin
//         "null" passes in Figma desktop (if it cannot talk, every refusal on this console names the
//         Origin it saw; PX_ALLOW_ORIGIN=<that origin> lets it through for one diagnostic run)
//   P2    the cost of one turn four ways (setTimeout(0), getNodeByIdAsync, a round trip to the window,
//         a resolved promise); run it in front, covered and minimised, and label each run
//   P3    the largest message that crosses the plugin boundary each way, 0.25 to 16 MB
//
// With no list it runs P4, P8 and P19B, the probes M1 still waits for (docs/M1.md §10 step 1). It
// prints every verdict next to what tools/double/verdicts.json records and what the headless double
// assumes while a case is pending, so a difference is seen here before part F records it.
//
// Needs the runner plugin open in a scratch Figma file. Results are printed; --out also writes them as
// JSON, and refuses a path inside this repository, because probe results are machine- and file-specific
// and belong with the rest of the private artefacts (docs/REWRITE.md §8).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { openSession, waitForPlugin } from "./session.mjs";
import { assertOutsideRepo } from "./ir/outside-repo.mjs";
import { loadVerdicts, behaviour } from "./double/index.mjs";

// A w x h RGB PNG of noise from a fixed seed: incompressible, so its size is what crosses the window.
export function noisePng(w, h, seed = 1) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < raw.length; i++) {
    if (i % (w * 3 + 1) === 0) { raw[i] = 0; continue; }
    x = (x * 1103515245 + 12345) >>> 0; raw[i] = x >>> 24;
  }
  const crcTable = [];
  for (let k = 0; k < 256; k++) { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[k] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// P4's images, by hash: about 1 MB and 4 MB of noise.
export function p4Images(sides = [590, 1180]) {
  const m = new Map();
  sides.forEach((w, k) => {
    const b = noisePng(w, w, 7 + k);
    m.set(createHash("sha1").update(b).digest("hex"), b);
  });
  return m;
}

// What one verdict says against verdicts.json and the double: "as recorded", "RECORDED x" (the live
// probe disagrees with what is recorded), "as the double assumes", "THE DOUBLE ASSUMES x".
export function compareLine(probe, kase, got, verdicts) {
  const pv = verdicts && verdicts.probes && verdicts.probes[probe] && verdicts.probes[probe].verdicts;
  const rec = pv ? pv[kase] : undefined;
  if (rec !== undefined && rec !== "pending") return got === rec ? "as recorded" : "RECORDED " + rec;
  let assumed = null;
  try { assumed = behaviour({ probes: {} }).of(probe, kase); } catch (e) {}
  return assumed === null || assumed === undefined ? "" : got === assumed ? "as the double assumes" : "THE DOUBLE ASSUMES " + assumed;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const bool = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
  const n = flag("--n");
  const repeat = flag("--repeat");
  const label = flag("--label");
  const out = flag("--out");
  const keep = bool("--keep");
  const probes = (argv[0] || "P4,P8,P19B").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  // On real paths, case-folded where the file system is (docs/M1.md D17): a junction or a drive letter
  // in another case no longer gets a write into the repository.
  if (out) {
    try { assertOutsideRepo(out); }
    catch (e) { console.error("refusing to write probe results: " + e.message); process.exit(1); }
  }

  const images = probes.indexOf("P4") >= 0 ? p4Images() : new Map();
  const args = { probes, label: label || undefined };
  if (n) args.n = Number(n);
  if (images.size) args.p4 = { hashes: [...images.keys()], repeat: repeat ? Number(repeat) : 3 };
  if (keep) args.p19b = { keep: true };

  const srv = await openSession();
  try { await waitForPlugin(srv); }
  catch (e) { console.error(e.message + " — nothing probed"); srv.close(); process.exit(1); }
  console.log("probing " + probes.join(", ") + (label ? " (" + label + ")" : "") + " — the runner plugin must be open in a scratch file");
  let r;
  try { r = await srv.post({ kind: "probe" }, JSON.stringify(args), images, 60 * 60 * 1000); }
  catch (e) { console.error("probe failed: " + e.message); srv.close(); process.exit(1); }
  srv.close();
  if (r.error) { console.error("probe refused: " + r.error); process.exit(1); }

  const verdicts = loadVerdicts();
  console.log("");
  console.log("plugin build " + r.plugin + (r.label ? ", " + r.label : ""));
  const p = r.probes || {};
  if (p.P1) {
    console.log("P1  status " + p.P1.status + (p.P1.error ? ", error " + p.P1.error : "") + ", window origin " + JSON.stringify(p.P1.uiOrigin));
    try { const e = JSON.parse(p.P1.echo); console.log("    the runner saw Origin " + JSON.stringify(e.headers.origin) + ", Host " + JSON.stringify(e.headers.host)); }
    catch (e) { if (p.P1.echo) console.log("    echo: " + String(p.P1.echo).slice(0, 200)); }
  }
  if (p.P2) {
    // mean is the whole series over its steps; batch is the step run back to back for 200 ms — the one
    // to read when the clock is Date.now and a step is shorter than its millisecond.
    console.log("P2  clock " + p.P2.clock + "   (ms: min / median / p95 / max, n; mean of the series; mean of a back-to-back batch)");
    for (const k of ["setTimeout0", "getNodeByIdAsync", "uiRoundTrip", "resolvedPromise"]) {
      const s = p.P2[k];
      if (!s) continue;
      console.log("    " + k.padEnd(18) + [s.min, s.median, s.p95, s.max].join(" / ") + "   n " + s.n + " of " + s.asked + (s.lost ? ", " + s.lost + " lost" : "") +
        "   mean " + s.mean + (s.batch ? "   batch " + s.batch.mean + " (" + s.batch.steps + " in " + s.batch.ms + " ms)" : ""));
    }
  }
  if (p.P3) {
    console.log("P3  largest delivered: plugin -> window " + p.P3.largestDownMB + " MB, window -> plugin " + p.P3.largestUpMB + " MB");
    for (const [dir, rows] of [["plugin -> window", p.P3.pluginToUi], ["window -> plugin", p.P3.uiToPlugin]]) {
      console.log("    " + dir + ": " + (rows || []).map((x) => x.mb + " MB " + (x.arrived === null ? "skipped" : x.arrived ? "ok " + x.ms + " ms" : "LOST")).join(", "));
    }
  }
  // The verdict probes, case by case, next to verdicts.json and the double's assumption.
  for (const name of ["P4", "P8", "P19B"]) {
    const q = p[name];
    if (!q || !q.verdicts) continue;
    console.log(name + (name === "P4" && q.timings && q.timings.medianMs ? "  median ms: base64 " + q.timings.medianMs.base64 + ", binary " + q.timings.medianMs.binary : ""));
    for (const k of Object.keys(q.verdicts)) {
      const m = q.cases && q.cases[k];
      console.log("    " + k.padEnd(28) + String(q.verdicts[k]).padEnd(8) + compareLine(name, k, q.verdicts[k], verdicts) +
        (m && m.error ? "   (" + m.error + ")" : ""));
    }
    if (name === "P19B" && q.p19) {
      console.log("  P19, asked again:");
      for (const k of Object.keys(q.p19.verdicts)) console.log("    " + k.padEnd(28) + String(q.p19.verdicts[k]).padEnd(8) + compareLine("P19", k, q.p19.verdicts[k], verdicts));
    }
  }
  for (const k of Object.keys(p)) if (p[k] && p[k].error) console.log(k + "  error: " + p[k].error);
  console.log("");
  console.log("Part F records these in tools/double/verdicts.json (docs/M1.md §10 step 1). A case in capitals differs from what the double does now: the double changes first (docs/REWRITE.md §8).");
  if (out) { writeFileSync(resolve(out), JSON.stringify(r, null, 2), "utf8"); console.log("written to " + resolve(out)); }
}

// Run as a command; a test imports the helpers above without probing anything.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main();

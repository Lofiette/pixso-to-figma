// The Pixso channel, offline: what happens when Pixso goes away in the middle of a run.
//
//   node test-mcp.mjs
//
// A fake Pixso MCP server runs inside this process and answers eval_script the way Pixso does — for
// a few objects, then it drops every connection for a while, or hangs, or comes back with another
// file open. Against it run the real mcp.mjs and the real extraction loop (extract-lib.mjs); the
// only stand-in is the per-object program, which is this file started with --fake-extract. It reads
// its object through mcp.mjs as the px-*.mjs scripts do, a child process per call, in one of two
// manners:
//   - like px-export: a failed call is retried (FAKE_TRIES), and when it keeps failing the object
//     gives up with the error shortened to 160 characters, the way px-export shortens it;
//   - like px-svg, px-images, px-paintsub and px-textruns (FAKE_SWALLOW=<steps>): one call per step,
//     a failed one logged as FAIL and left out, the step's file written anyway, exit 0. A step whose
//     file is already there is skipped, as migrate.mjs skips it.
// Everything is synthetic and nothing leaves 127.0.0.1.
//
// What it proves (docs/REWRITE.md §6, M0): every object ends in a recorded state; a failure keeps
// its full error text; the breaker trips on three transport failures in a row and on silence, never
// on a script error or on time spent working between calls; the run resumes when Pixso comes back
// with the same file and stops with IDENTITY_CHANGED when it comes back with another; an object
// that lost a call is never kept, even when it ends with exit 0 and a payload; and a run that lost
// objects can never read PASS.
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakePixso } from "./test/fake-pixso.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const MCP = join(HERE, "mcp.mjs");
const NL = String.fromCharCode(10);

// ---------- never the real Pixso ----------
// A live Pixso listens on 127.0.0.1:3667 on a designer's machine — and on the one this was written
// on — and mcp.mjs falls back to that address when MCP_URL is unset. Every call here names its fake
// Pixso; main() also points the fallback at a port nobody listens on before anything is started, so
// a call site that forgets fails safe, and anything aimed at 3667 is refused outright.
function guardEnv(env) {
  const url = (env && env.MCP_URL) || process.env.MCP_URL;
  let port = null;
  try { const u = new URL(url); port = u.port || (u.protocol === "https:" ? "443" : "80"); } catch (e) {}
  if (!url || port === null || port === "3667") {
    throw new Error("test-mcp refuses to run against MCP_URL=" + JSON.stringify(url || null) + ": that could be the real Pixso");
  }
}

// ---------- the stand-in for migrate.mjs ----------
// node test-mcp.mjs --fake-extract <id> <dir>; FAKE_TRIES sets the tries per step (default 4);
// FAKE_SWALLOW=<steps> switches to the carry-on manner, FAKE_LOCAL_MS adds that long a stretch
// without calls after an attempt's calls if one of them was lost (the pack, which makes none).
function fakeExtract(id, dir) {
  try { guardEnv(process.env); } catch (e) { process.stderr.write(e.message + NL); process.exitCode = 1; return; }
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "_read.js");
  writeFileSync(script, "// px:fake-object " + id + NL + "return { id: " + JSON.stringify(id) + " };" + NL, "utf8");
  if (process.env.FAKE_SWALLOW) return fakeSwallow(id, dir, script, Number(process.env.FAKE_SWALLOW));
  const tries = Number(process.env.FAKE_TRIES) || 4;
  // One read per object (the real px-*.mjs make many; one is enough to fail, and every process
  // costs a fifth of a second on Windows).
  let r = null, last = "";
  for (let a = 0; a < tries && !r; a++) {
    try { r = JSON.parse(execFileSync(process.execPath, [MCP, "script", script], { encoding: "utf8", cwd: HERE }).trim()); }
    catch (e) { last = String(e.message).slice(0, 160); }
  }
  if (!r) { process.stderr.write("phase tree failed: transport: " + last + NL); process.exitCode = 1; return; }
  if (r.error) { process.stderr.write("phase tree failed: " + r.error + NL); process.exitCode = 1; return; }
  writeFileSync(join(dir, "tree.json"), JSON.stringify(r), "utf8");
  writeFileSync(join(dir, "payload.json"), JSON.stringify({ id, synthetic: true }), "utf8");
  console.log("extract-only: payload is at " + join(dir, "payload.json"));
}

// The carry-on manner. The payload counts the holes its steps left, including those of a step file
// kept from an earlier attempt — which is exactly what a hole the loop failed to discard looks like.
function fakeSwallow(id, dir, script, steps) {
  let lostHere = 0;
  for (let i = 0; i < steps; i++) {
    const out = join(dir, "step-" + i + ".json");
    if (existsSync(out)) { console.log("  step " + i + ": already in " + out + ", skipping"); continue; }
    let r = null;
    try { r = JSON.parse(execFileSync(process.execPath, [MCP, "script", script], { encoding: "utf8", cwd: HERE, stdio: ["ignore", "pipe", "pipe"] }).trim()); }
    catch (e) { lostHere++; console.log("  FAIL step " + i + ": " + String(e.message).slice(0, 120)); }
    writeFileSync(out, JSON.stringify(r ? { id, step: i } : { id, step: i, hole: true }), "utf8");
  }
  // The pack: a stretch with no calls. Only after a lost call, which is the case that matters, and
  // asleep rather than spinning, so that it does not slow the calls of the groups running alongside.
  const local = lostHere ? Number(process.env.FAKE_LOCAL_MS) || 0 : 0;
  if (local) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, local);
  let holes = 0;
  for (let i = 0; i < steps; i++) if (JSON.parse(readFileSync(join(dir, "step-" + i + ".json"), "utf8")).hole) holes++;
  writeFileSync(join(dir, "payload.json"), JSON.stringify({ id, holes }), "utf8");
  console.log("extract-only: payload is at " + join(dir, "payload.json") + " (" + holes + " holes)");
}

// ---------- the fake Pixso: tools/test/fake-pixso.mjs ----------

// ---------- helpers ----------
function runNode(args, env) {
  guardEnv(env);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const e = Object.assign({}, process.env, env || {});
    for (const k of ["PX_MCP_HEALTH", "PX_MCP_GATE"]) if (!(env && k in env)) delete e[k];
    const p = spawn(process.execPath, args, { cwd: HERE, env: e, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, stdout: out, stderr: err, ms: Date.now() - t0 }));
  });
}

function freePort() {
  return new Promise((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// A synthetic px-pages document: pages of FRAME objects named «Объект N», numbered across the file.
function synthDoc(file, counts) {
  let k = 0;
  return {
    file, fileKey: "synthetic-key-a", currentPage: "Страница 1", scope: "file", selection: [],
    pages: counts.map((n, pi) => ({
      id: "0:" + (pi + 1), name: "Страница " + (pi + 1), backgrounds: null, childCount: n, counted: true, nodes: 10 * n,
      children: Array.from({ length: n }, (_, ci) => ({ i: ci, id: (pi + 1) + ":" + (ci + 1), name: "Объект " + (++k), type: "FRAME", nodes: 10,
        x: 0, y: 0, w: 10, h: 10 })),
    })),
  };
}

const exactResult = (name) => ({ name, rootId: "9:9", relocated: false, nodes: 3, expected: 3, posOver: 0, subPixel: 0, worstPos: 0,
  maxSize: 0, sizeOver: 0, sizeHidden: 0, failures: 0, fontSubs: [] });


// Short timings for the loop. silenceMs is long here so that only the transport rule can trip; the
// hung-Pixso group sets its own. The deadlines (here, and MCP_TIMEOUT_MS in each group) are generous
// on purpose: an outage here is a dropped connection, which fails at once, so a long deadline costs
// nothing — while a short one turns a call slowed by a busy machine into a transport failure the
// test did not ask for.
const T = { pollMs: 50, silenceMs: 8000, probeEveryMs: 200, probeForMs: 15000, probeTimeoutMs: 5000, identityTimeoutMs: 10000, graceMs: 500 };
const EXTRACTOR = { script: SELF, args: ["--fake-extract"] };
const FILE_A = { file: "Synthetic file A", fileKey: "synthetic-key-a", pageIds: ["0:1", "0:2"] };
const FILE_B = { file: "Synthetic file B", fileKey: "synthetic-key-b", pageIds: ["7:1", "7:2"] };
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const listDirs = (outDir) => readIf(join(outDir, "dirs.txt")).split(/\r?\n/).filter(Boolean);
const shape = (st) => st.objects.map((o) => o.state + ":" + (o.reason || "")).join(",");

// ---------- 1. mcp.mjs, the breaker, and the small pieces ----------
async function groupPieces({ px, check, tmp, lib }) {
  const { Breaker, HealthReader, TIMING, headline, runnerLine, identityDiff, unextracted } = lib;
  const plain = join(tmp, "plain.js"), scriptErr = join(tmp, "script-error.js");
  writeFileSync(plain, "return 1;", "utf8");
  writeFileSync(scriptErr, "// px:script-error" + NL + "throw new Error('x');", "utf8");
  const unitHealth = join(tmp, "unit-health.log");
  writeFileSync(unitHealth, "", "utf8");
  const hr = new HealthReader(unitHealth);
  const H = { PX_MCP_HEALTH: unitHealth, MCP_URL: px.url };
  const lastEnd = () => { const ev = hr.read().filter((e) => e.ev !== "start"); return ev[ev.length - 1] || {}; };
  const first = (s) => String(s).split(/\r?\n/)[0];

  let r = await runNode([MCP, "script", plain], H);
  check(r.code === 0 && r.stdout.trim() === "1", "mcp.mjs: an answered call exits 0 with Pixso's text", r.code + " " + r.stderr);
  check(lastEnd().ev === "ok", "mcp.mjs: an answered call is logged ok");

  r = await runNode([MCP, "script", scriptErr], H);
  check(r.code === 0 && r.stdout.indexOf("!! isError: true") >= 0, "mcp.mjs: a script error is Pixso answering (exit 0, isError shown)", r.code);
  const se = lastEnd();
  check(se.ev === "ok" && se.isError === true, "mcp.mjs: a script error is logged as an answer, not a transport failure", JSON.stringify(se));

  const dead = await freePort();
  r = await runNode([MCP, "script", plain], Object.assign({}, H, { MCP_URL: "http://127.0.0.1:" + dead + "/mcp" }));
  check(r.code === 75 && /^mcp transport failure: .*ECONNREFUSED/.test(first(r.stderr)),
    "mcp.mjs: connection refused is a transport failure (exit 75, cause named)", r.code + " " + first(r.stderr));
  check(lastEnd().ev === "transport", "mcp.mjs: connection refused is logged as transport");

  px.mode = "reset";
  r = await runNode([MCP, "script", plain], H);
  check(r.code === 75 && first(r.stderr).startsWith("mcp transport failure"), "mcp.mjs: a dropped connection is a transport failure", r.code + " " + first(r.stderr));
  hr.read();

  px.mode = "hang";
  r = await runNode([MCP, "script", plain], Object.assign({}, H, { MCP_TIMEOUT_MS: "600" }));
  // The bound is the whole process, start-up included, on a machine that may be busy: far above
  // 600 ms, far below the 45 s the call would wait if the deadline were not applied.
  check(r.code === 75 && /timed out/.test(first(r.stderr)) && r.ms < 20000,
    "mcp.mjs: no reply within MCP_TIMEOUT_MS is a transport failure", r.code + " " + r.ms + " ms " + first(r.stderr));
  hr.read();

  px.mode = "http500";
  px.body500 = "b".repeat(5000) + "BODY-END-MARKER";
  r = await runNode([MCP, "script", plain], H);
  check(r.code === 1 && first(r.stderr).startsWith("mcp http failure") && r.stderr.indexOf("status: 500") >= 0 && r.stderr.indexOf("BODY-END-MARKER") >= 0,
    "mcp.mjs: HTTP 500 is Pixso answering (exit 1), and its whole 5 000-character body is kept", r.code + " " + first(r.stderr));
  const e500 = lastEnd();
  check(e500.ev === "error" && String(e500.text).indexOf("BODY-END-MARKER") >= 0, "mcp.mjs: the health log keeps the full text too");

  px.mode = "http503";
  r = await runNode([MCP, "script", plain], H);
  check(r.code === 75, "mcp.mjs: HTTP 503 is a transport failure (the service is unavailable)", r.code + " " + first(r.stderr));
  hr.read();

  px.mode = "rpcerror";
  r = await runNode([MCP, "script", plain], H);
  check(r.code === 1 && first(r.stderr).startsWith("mcp rpc failure") && r.stderr.indexOf("RPC-END-MARKER") >= 0,
    "mcp.mjs: a JSON-RPC error is not a transport failure, and its data is kept whole", r.code + " " + first(r.stderr));
  hr.read();
  px.mode = "up";

  const gate = join(tmp, "gate.open");
  writeFileSync(gate, "x", "utf8");
  const before = px.calls;
  r = await runNode([MCP, "script", plain], Object.assign({}, H, { PX_MCP_GATE: gate }));
  check(r.code === 75 && px.calls === before && /circuit breaker is open/.test(r.stderr),
    "mcp.mjs: with the breaker open a call is refused without reaching Pixso", r.code + " calls " + (px.calls - before));
  check(lastEnd().ev === "refused", "mcp.mjs: a refused call is logged as refused, not as a failure of Pixso");

  // The breaker by itself, on hand-made events.
  check(TIMING.transportTrip === 3 && TIMING.silenceMs === 60000 && TIMING.probeEveryMs === 5000 && TIMING.probeForMs === 600000,
    "breaker defaults: 3 transport failures, 60 s, probe every 5 s for 10 min");
  let b = new Breaker({ transportTrip: 3, silenceMs: 60000 });
  const tr = (t) => ({ t, ev: "transport", msg: "m" + t });
  [tr(1), tr(2), { t: 3, ev: "ok" }, tr(4), tr(5)].forEach((e) => b.observe(e));
  check(b.check(6) === null, "breaker: an answer in between restarts the count");
  b.observe(tr(6));
  const c1 = b.check(7);
  check(c1 && c1.reason === "transport" && /3 transport failures in a row, the last: m6/.test(c1.detail), "breaker: trips on the third in a row", JSON.stringify(c1));
  b = new Breaker({ transportTrip: 3, silenceMs: 60000 });
  [tr(1), tr(2), { t: 3, ev: "error" }, tr(4), tr(5), { t: 6, ev: "refused" }].forEach((e) => b.observe(e));
  check(b.check(7) === null, "breaker: a script error counts as Pixso answering; refusals count for nothing");
  b = new Breaker({ transportTrip: 3, silenceMs: 60000 });
  b.observe({ t: 1000, ev: "start" });
  check(b.check(60999) === null, "breaker: a call waiting 59.9 s is still allowed");
  const c2 = b.check(61000);
  check(c2 && c2.reason === "silence", "breaker: 60 s of trying with nothing through trips it", JSON.stringify(c2));
  b.observe({ t: 61500, ev: "ok" });
  check(b.check(200000) === null, "breaker: an answer clears the silence");
  // Silence is time spent trying, not time passing: an object that loses one call and then packs for
  // a while has not seen Pixso fall silent.
  b = new Breaker({ transportTrip: 3, silenceMs: 1500 });
  b.observe({ t: 0, pid: 1, ev: "start" });
  b.observe({ t: 100, pid: 1, ev: "transport", msg: "dropped" });
  check(b.check(5000) === null, "breaker: one failed call and then 5 s of work without calls is not silence", JSON.stringify(b.check(5000)));
  b.observe({ t: 5000, pid: 2, ev: "start" });
  check(b.check(6300) === null, "breaker: ...the next call's wait adds to the failed one's (1.4 s of 1.5 s)");
  const c3 = b.check(6400);
  check(c3 && c3.reason === "silence" && /in 2 s of trying, the last failure: dropped/.test(c3.detail),
    "breaker: trying time adds up across the calls that do not get through", JSON.stringify(c3));
  b.settle();
  check(b.check(100000) === null, "breaker: a call cut off with its process is not Pixso's silence");

  // Reading a failure, and what reaches the plugin window.
  const crash = ["file:///C:/x/tools/px-export.mjs:42", "  throw new Error(\"boom \" + x);", "  ^", "", "Error: boom 7",
    "    at main (file:///x.mjs:42:9)", "", "Node.js v24.19.0"].join(NL);
  check(headline(crash, "", 1) === "Error: boom 7", "headline: Node's crash report gives its error line, not the source line", headline(crash, "", 1));
  check(headline("phase 1 failed: transport: x" + NL + crash, "", 1) === "phase 1 failed: transport: x", "headline: the first error line wins");
  // mcp.mjs is a script and runs from whatever path starts it. Behind an "is this the main module?"
  // guard it did nothing and exited 0 when started through a junction or a symlink. A copy, so the
  // link never points into the repository.
  const real = join(tmp, "real-tools"), link = join(tmp, "linked-tools");
  mkdirSync(real, { recursive: true });
  for (const f of ["mcp.mjs", "mcp-codes.mjs"]) copyFileSync(join(HERE, f), join(real, f));
  let linked = null;
  try { symlinkSync(real, link, "junction"); linked = link; } catch (e) { linked = null; check(true, "mcp.mjs through a junction — skipped, no link here: " + e.message); }
  if (linked) {
    r = await runNode([join(linked, "mcp.mjs"), "script", plain], { MCP_URL: px.url });
    check(r.code === 0 && r.stdout.trim() === "1", "mcp.mjs started through a junction still makes its call", r.code + " " + JSON.stringify(r.stdout));
    r = await runNode([join(linked, "mcp.mjs")], { MCP_URL: px.url });
    check(r.code === 1 && /^commands:/.test(r.stdout), "mcp.mjs with no command prints its usage and does not claim success", r.code + " " + JSON.stringify(r.stdout));
    try { rmSync(linked, { recursive: false, force: true }); } catch (e) {}
  }

  check(runnerLine(">> Pixso перестал отвечать") === "Pixso перестал отвечать", "runner relays the designer's lines");
  check(runnerLine("[3/8] FRAME 10n  \"Объект 3\"   (4s elapsed)") === "  3 из 8   Объект 3", "runner shortens progress lines");
  check(runnerLine("phase 1: tree (budget 1200/call)") === null, "runner keeps technical lines in the console");
  check(identityDiff({ file: "A", pageIds: ["1", "2"] }, { file: "A", pageIds: ["2", "1"] }) === null, "identity: page order is not identity");
  check(!!identityDiff({ file: "A", pageIds: ["1", "2"] }, { file: "A", pageIds: ["1", "3"] }), "identity: other page ids are another file");
  const lost = unextracted({ objects: [{ dir: "/x/0-000-a", state: "extracted" }, { dir: "/x/0-001-b", state: "pending" }] });
  check(lost.length === 1 && lost[0].state === "skipped" && /interrupted/.test(lost[0].error),
    "an object a dead run left pending counts as not extracted");
}

// ---------- 2. Pixso drops connections mid-run and comes back; then the run is repeated ----------
async function groupOutage({ px, check, tmp, lib, verdict }) {
  const { EXIT, extractAll, planJobs, readStates, unextracted } = lib;
  // FAKE_TRIES=3: the object gives up on its own after the third failure, so how quickly the loop
  // notices cannot change what happens.
  const ENV = { MCP_URL: px.url, MCP_TIMEOUT_MS: "10000", FAKE_TRIES: "3" };
  const doc = synthDoc("Synthetic file A", [4, 2]);
  const outDir = join(tmp, "obj");
  const jobs = planJobs(doc, outDir);
  px.fails = { "1:2": "synthetic script failure: " + "s".repeat(3000) + " SCRIPT-END-MARKER" };
  px.outageAfter("1:3", "reset", { after: 3, ms: 400 });
  const told = [];
  let checkpoint = null;
  const res = await extractAll({
    doc, jobs, outDir, extractor: EXTRACTOR, env: ENV, timing: T, log: () => {},
    tell: (s) => {
      told.push(s);
      if (s.startsWith("Pixso перестал отвечать")) checkpoint = readStates(join(outDir, "states.json"));
    },
  });
  const st = readStates(join(outDir, "states.json"));
  const trip = told.find((s) => s.startsWith("Pixso перестал отвечать"));
  // Left: objects 4 (interrupted), 5 and 6. Object 2 failed on its own script error: this run does not
  // try it again, so it is not "left" — it is counted apart.
  check(trip === "Pixso перестал отвечать на объекте «Объект 4» (4 из 6): готово 2, осталось 3, с ошибкой 1 (его повторит следующий запуск)",
    "outage: the runner says where it stopped, how much is done, how much this run has left, and what failed on its own", trip);
  check(told.indexOf("3 обращения подряд не дошли до Pixso.") >= 0, "outage: the trip names its reason (3 transport failures in a row)", told.join(" | "));
  check(checkpoint && checkpoint.status === "waiting-for-pixso" && checkpoint.counts.extracted === 2,
    "outage: the checkpoint is on disk before the line is said", checkpoint && checkpoint.status);
  check(told.indexOf("Pixso снова отвечает, файл тот же — продолжаю: осталось 3") >= 0, "outage: the same file → resumes", told.join(" | "));
  check(px.served.join(",") === "1:1,1:3,1:4,2:1,2:2",
    "outage: nothing issued while Pixso was away; the interrupted object went first on resume", px.served.join(","));
  check(res.exitCode === EXIT.SOME_FAILED && st.status === "complete", "outage: the run completes, exit 2 for the one failed object",
    res.exitCode + " " + st.status);
  check(st.objects.map((o) => o.state).join(",") === "extracted,failed,extracted,extracted,extracted,extracted",
    "every object ends in a recorded state", st.objects.map((o) => o.state).join(","));
  const o4 = st.objects[3];
  check(o4.attempts === 2 && o4.history && o4.history[0].transport === true && !existsSync(join(o4.dir, "extract-error.log")),
    "the interrupted object: attempt 2 succeeded, the transport failure kept in its history", JSON.stringify(o4));
  check(st.trips.length === 1 && st.trips[0].reason === "transport" && st.trips[0].outcome === "resumed",
    "the trip is recorded in states.json", JSON.stringify(st.trips));
  const o2 = st.objects[1];
  const log2 = readIf(join(o2.dir, "extract-error.log"));
  check(o2.transport === false && o2.reason === "EXTRACT_FAILED" && o2.attempts === 1,
    "a script error fails its object without counting against Pixso, and is not retried in the run", JSON.stringify(o2));
  check(o2.error.startsWith("phase tree failed: synthetic script failure: sss") && log2.indexOf("SCRIPT-END-MARKER") >= 0,
    "full error text: the first line recorded, the whole 3 000-character message in extract-error.log", o2.error.slice(0, 60));
  const dirs = listDirs(outDir);
  check(dirs.length === 5 && dirs.indexOf(o2.dir) < 0, "dirs.txt lists the 5 that can be built, not the failed one", dirs.length);
  const said = [];
  const v = verdict(dirs.map((d) => exactResult(basename(d))), (s) => said.push(s), unextracted(st));
  check(!v.clean && said[said.length - 1] === "NOT CLEAN" && !said.some((s) => /^PASS/.test(s)),
    "verdict: 5 exact builds and 1 failed extraction is NOT CLEAN, never PASS", said[said.length - 1]);
  check(said.some((s) => s.startsWith("   0-001-Объект-2: phase tree failed: synthetic script failure")) &&
    said.some((s) => s.startsWith("failed to extract        1")),
    "verdict: the failed object is named with the first line of its error", said.join(" | ").slice(0, 300));

  // Run again: extracted objects are skipped, the failed one is retried.
  px.fails = {};
  px.served = [];
  const res2 = await extractAll({ doc, jobs, outDir, extractor: EXTRACTOR, env: ENV, timing: T, log: () => {}, tell: () => {} });
  const st2 = readStates(join(outDir, "states.json"));
  check(res2.exitCode === EXIT.OK && px.served.join(",") === "1:2" && st2.objects.every((o) => o.state === "extracted") &&
    st2.objects.filter((o) => o.reused).length === 5,
    "a second run skips the 5 extracted objects and retries the failed one", res2.exitCode + " " + px.served.join(","));
  const said2 = [];
  verdict(listDirs(outDir).map((d) => exactResult(basename(d))), (s) => said2.push(s), unextracted(st2));
  check(said2[said2.length - 1] === "PASS", "verdict: with every object extracted and exact, PASS is possible again", said2[said2.length - 1]);
}

// ---------- 3. Pixso comes back with another file open ----------
async function groupIdentity({ px, check, tmp, lib, verdict }) {
  const { EXIT, extractAll, planJobs, readStates, unextracted } = lib;
  const ENV = { MCP_URL: px.url, MCP_TIMEOUT_MS: "10000", FAKE_TRIES: "3" };
  const doc = synthDoc("Synthetic file A", [4, 0]);
  const outB = join(tmp, "b", "obj");
  px.outageAfter("1:2", "reset", { after: 3, ms: 400, file: FILE_B });
  const told = [];
  const res = await extractAll({ doc, jobs: planJobs(doc, outB), outDir: outB, extractor: EXTRACTOR, env: ENV, timing: T,
    log: () => {}, tell: (s) => told.push(s) });
  const st = readStates(join(outB, "states.json"));
  check(res.exitCode === EXIT.IDENTITY_CHANGED && st.status === "identity-changed" && st.stopReason === "IDENTITY_CHANGED",
    "another file after the outage stops the run with IDENTITY_CHANGED (exit 4)", res.exitCode + " " + st.status);
  check(px.served.join(",") === "1:1,1:2", "nothing was read from the other file", px.served.join(","));
  check(shape(st) === "extracted:,extracted:,failed:PIXSO_UNAVAILABLE,skipped:IDENTITY_CHANGED",
    "IDENTITY_CHANGED: every object still ends in a recorded state", shape(st));
  check(told.some((s) => s.indexOf("«Synthetic file B» вместо «Synthetic file A»") >= 0 && s.indexOf("IDENTITY_CHANGED") >= 0),
    "IDENTITY_CHANGED: the runner says which file is open instead", told.join(" | "));
  const said = [];
  verdict([], (s) => said.push(s), unextracted(st));
  check(said[said.length - 1] === "NOT CLEAN — nothing was built" && said.some((s) => s.startsWith("   0-002-Объект-3: Pixso stopped answering")) &&
    said.some((s) => s.startsWith("   0-003-Объект-4: not extracted: a different file is open in Pixso")),
    "verdict of a stopped run: NOT CLEAN, naming the failed and the skipped object", said.join(" | ").slice(0, 400));

  // The same check before the first object: yesterday's pages.json, today's other file.
  const outB2 = join(tmp, "b2", "obj");
  px.served = [];
  const res2 = await extractAll({ doc, jobs: planJobs(doc, outB2), outDir: outB2, extractor: EXTRACTOR, env: ENV, timing: T,
    log: () => {}, tell: () => {} });
  const st2 = readStates(join(outB2, "states.json"));
  check(res2.exitCode === EXIT.IDENTITY_CHANGED && px.served.length === 0 && st2.objects.every((o) => o.state === "skipped"),
    "another file open at the start: nothing is read, everything recorded as skipped", res2.exitCode + " " + px.served.length);

  // A restart too quick to trip the breaker — one dropped connection — and another file after it.
  const switchAfterFirst = () => {
    px.identity = FILE_A;
    px.served = [];
    px.onServe = (id) => { if (id === "1:1") { px.onServe = null; px.resetNext = 1; px.identity = FILE_B; } };
  };
  const doc3 = synthDoc("Synthetic file A", [3, 0]);
  // FAKE_TRIES=1: the object that meets the drop fails; the identity check before the next one stops.
  switchAfterFirst();
  const outB3 = join(tmp, "b3", "obj");
  const res3 = await extractAll({ doc: doc3, jobs: planJobs(doc3, outB3), outDir: outB3, extractor: EXTRACTOR,
    env: Object.assign({}, ENV, { FAKE_TRIES: "1" }), timing: T, log: () => {}, tell: () => {} });
  const st3 = readStates(join(outB3, "states.json"));
  check(res3.exitCode === EXIT.IDENTITY_CHANGED && st3.trips.length === 0 && px.served.join(",") === "1:1" &&
    shape(st3) === "extracted:,failed:PIXSO_UNAVAILABLE,skipped:IDENTITY_CHANGED",
    "a drop too short to trip, then another file: the check after the drop stops the run before the next object",
    res3.exitCode + " " + px.served.join(",") + " " + shape(st3));
  // FAKE_TRIES=2: the object retries past the drop and is answered by the other file. It must not be
  // kept: everything it wrote is discarded and it is recorded as failed with IDENTITY_CHANGED.
  switchAfterFirst();
  const outB4 = join(tmp, "b4", "obj");
  const res4 = await extractAll({ doc: doc3, jobs: planJobs(doc3, outB4), outDir: outB4, extractor: EXTRACTOR,
    env: Object.assign({}, ENV, { FAKE_TRIES: "2" }), timing: T, log: () => {}, tell: () => {} });
  const st4 = readStates(join(outB4, "states.json"));
  const o2 = st4.objects[1];
  check(res4.exitCode === EXIT.IDENTITY_CHANGED && o2.state === "failed" && o2.reason === "IDENTITY_CHANGED" &&
    !existsSync(join(o2.dir, "payload.json")) && !existsSync(join(o2.dir, "tree.json")) && listDirs(outB4).indexOf(o2.dir) < 0,
    "an object read across the change of file is discarded, not kept", res4.exitCode + " " + JSON.stringify(o2));

  // The same object, but Pixso is gone again when it is asked which file is open: the breaker trips,
  // and when Pixso comes back on the other file the object is discarded all the same.
  px.identity = FILE_A;
  px.served = [];
  px.onServe = (id) => {
    if (id !== "1:1") return;
    px.resetNext = 1;
    px.onServe = (id2) => { if (id2 === "1:2") { px.onServe = null; px.mode = "reset"; px.refused = 0; px.comeBack = { after: 1, ms: 300, file: FILE_B }; } };
  };
  const outB5 = join(tmp, "b5", "obj");
  const res5 = await extractAll({ doc: doc3, jobs: planJobs(doc3, outB5), outDir: outB5, extractor: EXTRACTOR,
    env: Object.assign({}, ENV, { FAKE_TRIES: "2" }), timing: T, log: () => {}, tell: () => {} });
  const st5 = readStates(join(outB5, "states.json"));
  check(res5.exitCode === EXIT.IDENTITY_CHANGED && st5.trips.length === 1 && st5.trips[0].reason === "identity-check" &&
    shape(st5) === "extracted:,failed:IDENTITY_CHANGED,skipped:IDENTITY_CHANGED" && !existsSync(join(st5.objects[1].dir, "payload.json")),
    "the identity check itself lost, Pixso back on another file: the object before it is discarded too",
    res5.exitCode + " " + shape(st5) + " " + JSON.stringify(st5.trips));
}

// ---------- 4. Pixso hangs: the silence rule trips, the hung call is killed, the run gives up ----------
async function groupHung({ px, check, tmp, lib, verdict }) {
  const { EXIT, extractAll, planJobs, readStates, unextracted } = lib;
  const doc = synthDoc("Synthetic file A", [3, 0]);
  const outDir = join(tmp, "obj");
  px.outageAfter("1:1", "hang", null);
  const told = [];
  const TC = Object.assign({}, T, { silenceMs: 4000, probeEveryMs: 200, probeForMs: 1500, probeTimeoutMs: 300 });
  // The objects' own calls would wait 30 s: only the silence rule can stop them sooner.
  const res = await extractAll({ doc, jobs: planJobs(doc, outDir), outDir, extractor: EXTRACTOR,
    env: { MCP_URL: px.url, MCP_TIMEOUT_MS: "30000" }, timing: TC, log: () => {}, tell: (s) => told.push(s) });
  const st = readStates(join(outDir, "states.json"));
  check(res.exitCode === EXIT.PIXSO_GONE && st.status === "gave-up" && st.trips[0] && st.trips[0].reason === "silence" &&
    st.trips[0].outcome === "gave-up", "hung Pixso: the silence rule trips, the run gives up after the probe window (exit 3)",
    res.exitCode + " " + st.status + " " + JSON.stringify(st.trips));
  // The first hung request is the second object's own call; only killing its process tree closes it
  // before its 30 s deadline.
  const tripAt = st.trips[0] ? Date.parse(st.trips[0].at) : 0;
  const hung0 = px.hung[0];
  check(hung0 && hung0.closedAt && hung0.closedAt - tripAt < 2500,
    "hung Pixso: the object's processes are killed, and its hanging call with them",
    hung0 && hung0.closedAt ? hung0.closedAt - tripAt + " ms after the trip" : "never closed");
  check(shape(st) === "extracted:,failed:PIXSO_UNAVAILABLE,skipped:PIXSO_UNAVAILABLE", "hung Pixso: every object ends in a recorded state", shape(st));
  const o2 = st.objects[1];
  check(/^Pixso stopped answering while this object was read: no MCP call got through/.test(o2.error) &&
    readIf(join(o2.dir, "extract-error.log")).indexOf("stopped by the circuit breaker") >= 0,
    "hung Pixso: the failure says why, and its log says the breaker stopped it", o2.error);
  check(told[0] === "Pixso перестал отвечать на объекте «Объект 2» (2 из 3): готово 1, осталось 2" &&
    told.indexOf("Ни одно обращение к Pixso не прошло за 4 с.") >= 0 &&
    told.some((s) => s.startsWith("Pixso так и не ответил за 1.5 с. Останавливаю извлечение: готово 1, осталось 2")),
    "hung Pixso: the runner's lines", told.join(" | "));
  check(!existsSync(join(outDir, "mcp-breaker.open")), "the breaker's gate is not left shut after the run");
  const said = [];
  verdict([exactResult("0-000-Объект-1")], (s) => said.push(s), unextracted(st));
  check(said[said.length - 1] === "NOT CLEAN" && said.some((s) => s.startsWith("not extracted            1")),
    "verdict: a run Pixso walked out of is NOT CLEAN", said[said.length - 1]);
}

// ---------- 5. one dropped connection: the object is retried once at the end ----------
async function groupBlip({ px, check, tmp, lib }) {
  const { EXIT, extractAll, planJobs, readStates } = lib;
  const doc = synthDoc("Synthetic file A", [3, 0]);
  const outDir = join(tmp, "obj");
  px.onServe = (id) => { if (id === "1:1") { px.onServe = null; px.resetNext = 1; } };
  const res = await extractAll({ doc, jobs: planJobs(doc, outDir), outDir, extractor: EXTRACTOR,
    env: { MCP_URL: px.url, MCP_TIMEOUT_MS: "10000", FAKE_TRIES: "1" }, timing: T, log: () => {}, tell: () => {} });
  const st = readStates(join(outDir, "states.json"));
  check(res.exitCode === EXIT.OK && st.trips.length === 0 && st.objects[1].attempts === 2 && st.objects[1].blipRetried === true &&
    px.served.join(",") === "1:1,1:3,1:2",
    "a single dropped connection fails one object without tripping; it is retried at the end and extracted",
    res.exitCode + " " + px.served.join(",") + " " + JSON.stringify(st.objects[1]));
}

// ---------- 6. steps that carry on past a failed call: the object is never kept with the hole ----------
const holesOf = (o) => { try { return JSON.parse(readFileSync(join(o.dir, "payload.json"), "utf8")).holes; } catch (e) { return "no payload"; } };
const stepFiles = (o) => { try { return readdirSync(o.dir).filter((n) => /^step-\d+\.json$/.test(n)); } catch (e) { return []; } };

async function groupSwallow({ px, check, tmp, lib, verdict }) {
  const { EXIT, extractAll, planJobs, readStates, unextracted } = lib;
  const ENV = { MCP_URL: px.url, MCP_TIMEOUT_MS: "10000" };

  // Three calls in a row lost by an object that then finishes — exit 0, a payload with three holes —
  // before the loop's next look at the health log (1 s in production, 3 s here). The trip is found
  // after it exits. It is that object's trip: it is not kept, it is named, and it goes first on resume.
  const doc = synthDoc("Synthetic file A", [2, 0]);
  px.onServe = (id) => { if (id === "1:1") { px.onServe = null; px.resetNext = 3; } };
  const outA = join(tmp, "a", "obj");
  const told = [];
  const ra = await extractAll({ doc, jobs: planJobs(doc, outA), outDir: outA, extractor: EXTRACTOR,
    env: Object.assign({}, ENV, { FAKE_SWALLOW: "4" }), timing: Object.assign({}, T, { pollMs: 3000 }),
    log: () => {}, tell: (s) => told.push(s) });
  const sa = readStates(join(outA, "states.json"));
  const a1 = sa.objects[0];
  check(sa.trips.length === 1 && sa.trips[0].object === a1.key && sa.trips[0].reason === "transport" &&
    told[0] === "Pixso перестал отвечать на объекте «Объект 1» (1 из 2): готово 0, осталось 2",
    "a trip completed by an object quicker than one poll is that object's, not the next one's",
    told[0] + " " + JSON.stringify(sa.trips.map((t) => t.object + ":" + t.reason)));
  check(a1.state === "extracted" && a1.attempts === 2 && a1.history && a1.history[0].transport === true &&
    /^Pixso stopped answering while this object was read: 3 transport failures in a row/.test(a1.history[0].error) && holesOf(a1) === 0,
    "...it is not kept with its three holes: it fails, and is read again, whole, when Pixso answers", holesOf(a1) + " " + JSON.stringify(a1));
  const saidA = [];
  verdict(listDirs(outA).map((d) => exactResult(basename(d))), (s) => saidA.push(s), unextracted(sa));
  check(ra.exitCode === EXIT.OK && sa.objects[1].state === "extracted" && sa.objects[1].attempts === 1 && saidA[saidA.length - 1] === "PASS",
    "...and the run ends clean only because both objects were read in full", ra.exitCode + " " + saidA[saidA.length - 1]);

  // One object, a call lost on every attempt: it never gets to be kept, and the run cannot read PASS.
  const one = synthDoc("Synthetic file A", [1, 0]);
  px.onServe = (id) => { if (id === "1:1") px.resetNext = 1; };
  const outC = join(tmp, "c", "obj");
  const rc = await extractAll({ doc: one, jobs: planJobs(one, outC), outDir: outC, extractor: EXTRACTOR,
    env: Object.assign({}, ENV, { FAKE_SWALLOW: "2" }), timing: T, log: () => {}, tell: () => {} });
  px.onServe = null;
  const sc = readStates(join(outC, "states.json"));
  const c1 = sc.objects[0];
  check(rc.exitCode === EXIT.SOME_FAILED && c1.state === "failed" && c1.reason === "PIXSO_UNAVAILABLE" && c1.transport === true &&
    c1.attempts === 2 && sc.trips.length === 0 && /^1 MCP call failed in transport while this object was read, and it finished without it/.test(c1.error),
    "an object that finishes with exit 0 past a lost call is recorded as failed, not extracted", rc.exitCode + " " + JSON.stringify(c1));
  check(!existsSync(join(c1.dir, "payload.json")) && stepFiles(c1).length === 0 && listDirs(outC).length === 0 &&
    readIf(join(c1.dir, "extract-error.log")).indexOf("discarded  written by this attempt and not to be trusted: ") >= 0,
    "...everything its attempt wrote is discarded, step files included, and the log says so", stepFiles(c1).join(",") + " " + listDirs(outC).length);
  const saidC = [];
  verdict([], (s) => saidC.push(s), unextracted(sc));
  check(saidC[saidC.length - 1] === "NOT CLEAN — nothing was built" && saidC.some((s) => s.startsWith("   0-000-Объект-1: 1 MCP call failed in transport")),
    "...and the verdict names it as failed, never PASS", saidC.join(" | ").slice(0, 300));
}

// ---------- 7. what counts toward the breaker, and what does not ----------
async function groupQuiet({ px, check, tmp, lib }) {
  const { EXIT, extractAll, planJobs, readStates } = lib;
  const ENV = { MCP_URL: px.url, MCP_TIMEOUT_MS: "10000" };

  // One dropped call, then local work with no calls for longer than the silence limit set here.
  // Pixso is fine; the breaker must not trip. The object is still not kept from that attempt: its
  // step file with the hole is discarded, and the retry at the end reads it whole. The limit is
  // seconds, not a fraction of one, so that an ordinary call on a busy machine cannot reach it.
  const one = synthDoc("Synthetic file A", [1, 0]);
  px.onServe = (id) => { if (id === "1:1") { px.onServe = null; px.resetNext = 1; } };
  const outB = join(tmp, "b", "obj");
  const rb = await extractAll({ doc: one, jobs: planJobs(one, outB), outDir: outB, extractor: EXTRACTOR,
    env: Object.assign({}, ENV, { FAKE_SWALLOW: "2", FAKE_LOCAL_MS: "6000" }), timing: Object.assign({}, T, { silenceMs: 5000 }),
    log: () => {}, tell: () => {} });
  const sb = readStates(join(outB, "states.json"));
  const b1 = sb.objects[0];
  check(sb.trips.length === 0, "one dropped call, then work without calls longer than the silence limit: the breaker stays shut",
    JSON.stringify(sb.trips.map((t) => t.detail)));
  check(rb.exitCode === EXIT.OK && b1.state === "extracted" && b1.attempts === 2 && b1.blipRetried === true && holesOf(b1) === 0 &&
    b1.history && /^1 MCP call failed in transport/.test(b1.history[0].error),
    "an object that finished past one dropped call is read again, and its hole does not survive into the payload",
    rb.exitCode + " holes " + holesOf(b1) + " " + JSON.stringify(b1));
}

async function groupCount({ px, check, tmp, lib }) {
  const { EXIT, extractAll, planJobs, readStates } = lib;
  const ENV = { MCP_URL: px.url, MCP_TIMEOUT_MS: "10000" };

  // Two calls lost at the end of object 1, an answered identity check, one lost at the start of
  // object 2: never three in a row, because Pixso answered in between. No trip.
  const two = synthDoc("Synthetic file A", [2, 0]);
  px.onServe = (id) => {
    if (id !== "1:1") return;
    px.onServe = null;
    px.resetNext = 2;
    px.onIdentity = () => { px.onIdentity = null; px.resetNext = 1; };
  };
  const outD = join(tmp, "d", "obj");
  const rd = await extractAll({ doc: two, jobs: planJobs(two, outD), outDir: outD, extractor: EXTRACTOR,
    env: Object.assign({}, ENV, { FAKE_SWALLOW: "3" }), timing: T, log: () => {}, tell: () => {} });
  const sd = readStates(join(outD, "states.json"));
  check(px.onIdentity === null && sd.trips.length === 0 && rd.exitCode === EXIT.OK &&
    sd.objects.every((o) => o.state === "extracted" && o.attempts === 2 && holesOf(o) === 0),
    "two lost calls, an answered identity check, one more lost: not three in a row, no trip; both objects read again whole",
    rd.exitCode + " " + JSON.stringify(sd.trips.map((t) => t.detail)) + " " + shape(sd) + " " +
    sd.objects.map((o) => o.attempts + "/" + holesOf(o)).join(","));
}

async function main() {
  // Before anything is imported or started: see guardEnv.
  process.env.MCP_URL = "http://127.0.0.1:" + (await freePort()) + "/mcp";
  const raw = await import("./extract-lib.mjs");
  const lib = Object.assign({}, raw, { extractAll: (o) => { guardEnv(o.env); return raw.extractAll(o); } });
  const { verdict } = await import("./build-lib.mjs");
  const TMP = mkdtempSync(join(tmpdir(), "pxf-mcp-"));
  // Independent groups, each with its own fake Pixso and folder, run side by side: every object is a
  // few node processes, and one after another this took twenty seconds. Each group's lines are
  // printed together, in this order, once all are done.
  const groups = [["pieces", groupPieces], ["outage", groupOutage], ["identity", groupIdentity], ["hung", groupHung], ["blip", groupBlip],
    ["swallow", groupSwallow], ["quiet", groupQuiet], ["count", groupCount]];
  const results = await Promise.all(groups.map(async ([name, fn]) => {
    const lines = [];
    let failed = 0, passed = 0;
    const check = (cond, m, why) => {
      if (cond) { passed++; lines.push("ok   " + m); }
      else { failed++; lines.push("FAIL " + m + (why !== undefined ? " — " + why : "")); }
    };
    const px = fakePixso();
    await px.listen();
    const tmp = join(TMP, name);
    mkdirSync(tmp, { recursive: true });
    try { await fn({ px, check, tmp, lib, verdict }); }
    catch (e) { check(false, name + " threw", (e && e.stack) || e); }
    finally { await px.close(); }
    return { lines, failed, passed };
  }));
  let failed = 0, passed = 0;
  for (const r of results) { for (const l of r.lines) console.log(l); failed += r.failed; passed += r.passed; }
  if (failed) console.log("test-mcp: scratch kept for inspection in " + TMP);
  else { try { rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }
  console.log("");
  console.log(failed ? "test-mcp: " + failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "test-mcp: all " + passed + " checks pass");
  process.exitCode = failed ? 1 : 0;
}

// Last, so that every declaration above is initialised before either path runs.
if (process.argv[2] === "--fake-extract") fakeExtract(process.argv[3], process.argv[4]);
else await main();

// The extraction loop, as a library: every top-level object ends in a recorded state, and a Pixso
// that stops answering stops the work instead of failing it.
//
// What it replaces, and why (docs/REWRITE.md §2, §6). The one library run so far lost its last 249
// of 577 objects in 193 s, 0.78 s each: Pixso had gone away and the loop carried on, failing every
// remaining object in turn. The error it kept was the last three lines of output, which named
// nothing. The list it handed to the build named only the successes, so the verdict never heard of
// the 249 and PASS was still possible. Now:
//
//   - every object in scope ends as extracted, failed or skipped, in <outDir>/states.json, which is
//     rewritten after every object and therefore is also the checkpoint;
//   - a failure keeps the object's complete stdout and stderr, and the full text of every MCP call
//     that failed while it ran, in <object dir>/extract-error.log;
//   - dirs.txt still lists only what can be built, but the verdict reads states.json as well, so a
//     failed or skipped object is a failed object (build-lib.mjs verdict);
//   - a circuit breaker watches the Pixso channel: three transport failures in a row, or 60 s of
//     trying without one call getting through, stops the work. The object that was running is
//     stopped, the checkpoint written, and the runner says so; then Pixso is asked every 5 s for up
//     to 10 min. When it answers, the open file must be the one recorded at the start (name, key,
//     page ids, from px-pages) — a different file stops the run with IDENTITY_CHANGED, the same one
//     resumes with what is left, the interrupted object first;
//   - the same identity check runs before the first object, and after any object during which a
//     call failed in transport however briefly: a Pixso that restarts between two calls trips
//     nothing, and may come back on another file.
//
// The loop never sees the MCP calls directly: they are made by px-*.mjs scripts two processes down.
// mcp.mjs appends one line per call start and end to a health log named by PX_MCP_HEALTH, and the
// loop reads that log while the object runs. Only transport failures count (mcp.mjs tells them apart
// from Pixso answering with an error), so an object whose script fails can never trip the breaker.
//
// This is runner code (Node), not plugin code: setTimeout is fine here. The never-setTimeout rule is
// for the plugin's main thread, where a background window wakes timers once a minute.
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_TRANSPORT } from "./mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = join(HERE, "mcp.mjs");
const NL = String.fromCharCode(10);
const WIN = process.platform === "win32";
export const ERROR_LOG = "extract-error.log";

// The numbers docs/REWRITE.md §6 sets, plus the loop's own. Tests pass smaller ones.
export const TIMING = Object.freeze({
  transportTrip: 3,          // transport failures in a row that open the breaker
  silenceMs: 60000,          // ...or this long trying without a single call getting through
  probeEveryMs: 5000,        // then ask Pixso this often
  probeForMs: 600000,        // for at most this long
  probeTimeoutMs: 10000,     // deadline of one liveness probe
  identityTimeoutMs: 45000,  // deadline of the identity read (it loads all pages, like px-pages does)
  pollMs: 1000,              // how often the health log is read while an object runs
  maxAttempts: 3,            // attempts per object within one run; a later run starts again
  graceMs: 2000,             // after an object's process exits, how long its output may still drain
});

// migrate-file.mjs exit codes. 3 and 4 mean the run stopped before the end of the list; run.mjs
// does not build after them.
export const EXIT = Object.freeze({ OK: 0, SOME_FAILED: 2, PIXSO_GONE: 3, IDENTITY_CHANGED: 4 });

// Directory names have to survive Windows, so the object's own name is only a hint; the index pair
// is what makes it unique and what maps back to pages.json.
export const slug = (s) => (s || "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

// What to extract, from px-pages output. Throws when a selection was asked for and nothing was
// selected; the message is meant for the person who pressed the button.
export function planJobs(doc, outDir, { selection = false, page = null, only = null } = {}) {
  const jobs = [];
  if (selection) {
    // Whatever the designer had selected when the file was read. A selected node is usually not a
    // top-level child, so its page travels with it — the build has no other way to know where it goes.
    const sel = doc.selection || [];
    if (!sel.length) throw new Error("nothing was selected in Pixso when the file was read." + NL + "select what you want in Pixso and run again.");
    sel.forEach((s, si) => {
      jobs.push({ pi: "sel", ci: si, page: s.page, id: s.id, name: s.name, type: s.type, nodes: s.nodes,
        dir: join(outDir, "sel-" + String(si).padStart(3, "0") + "-" + slug(s.name)) });
    });
    return jobs;
  }
  const want = only ? String(only).split(",").map(Number) : null;
  doc.pages.forEach((pg, pi) => {
    if (page !== null && page !== undefined && String(pi) !== String(page) && pg.name !== page) return;
    (pg.children || []).forEach((c, ci) => {
      if (want && !want.includes(ci)) return;
      jobs.push({ pi, ci, page: pg.name, id: c.id, name: c.name, type: c.type, nodes: c.nodes,
        dir: join(outDir, pi + "-" + String(ci).padStart(3, "0") + "-" + slug(c.name)) });
    });
  });
  return jobs;
}

// ---------- which file is open ----------

// Read-only, and from the repository like every other script sent to Pixso: the name of the open
// file, its key and its page ids — the same fields px-pages records at the start, read the same way.
export const IDENTITY_SCRIPT = [
  "// px:identity (read-only): which file is open, by name, key and page ids",
  "await pixso.loadAllPagesAsync();",
  "const ids = [];",
  "for (const pg of pixso.root.children) ids.push(pg.id);",
  "return { file: pixso.root.name, fileKey: pixso.fileKey, pageIds: ids };",
].join(NL);

export function identityOf(doc) {
  return { file: doc.file, fileKey: doc.fileKey || null, pageIds: (doc.pages || []).map((p) => String(p.id)) };
}

// null when it is the same file. Strict on purpose: a false "different" costs a re-run that skips
// everything already extracted; a false "same" would mix two files' objects in one folder silently.
// Page order is not identity (a page can be dragged), the set of page ids is.
export function identityDiff(was, now) {
  const parts = [];
  if (String(was.file) !== String(now.file)) parts.push("file " + JSON.stringify(was.file) + " is now " + JSON.stringify(now.file));
  if (was.fileKey && now.fileKey && String(was.fileKey) !== String(now.fileKey)) parts.push("the file key differs");
  const a = new Set((was.pageIds || []).map(String)), b = new Set((now.pageIds || []).map(String));
  let common = 0;
  for (const id of a) if (b.has(id)) common++;
  if (common !== a.size || common !== b.size) {
    parts.push("page ids differ: " + a.size + " recorded, " + b.size + " open now, " + common + " in common");
  }
  return parts.length ? { text: parts.join("; "), fileWas: was.file, fileNow: now.file } : null;
}

// ---------- the breaker ----------

// Fed with mcp.mjs health events: { t, ev: "start" | "ok" | "error" | "transport" | "refused" }.
// "ok" and "error" both mean Pixso answered — the channel works — and close the account. Only
// "transport" counts toward the trip. "start" marks when the trying began, so a call that hangs
// is measured from its start, not from whenever its timeout finally fires.
export class Breaker {
  constructor(t = {}) {
    this.tripAfter = t.transportTrip || TIMING.transportTrip;
    this.silenceMs = t.silenceMs || TIMING.silenceMs;
    this.reset();
  }
  reset() { this.consecutive = 0; this.troubleSince = null; this.last = null; }
  observe(ev) {
    if (!ev || typeof ev.t !== "number") return;
    if (ev.ev === "ok" || ev.ev === "error") { this.consecutive = 0; this.troubleSince = null; this.last = null; return; }
    if (ev.ev === "start") { if (this.troubleSince === null) this.troubleSince = ev.t; return; }
    if (ev.ev === "transport") {
      this.consecutive++;
      this.last = ev;
      if (this.troubleSince === null) this.troubleSince = ev.t;
    }
    // "refused" is a call the open breaker turned away; it says nothing about Pixso.
  }
  check(now) {
    const lastMsg = this.last ? this.last.msg || "?" : null;
    const text = this.last ? this.last.text || null : null;
    if (this.consecutive >= this.tripAfter) {
      return { reason: "transport", detail: this.consecutive + " transport failures in a row, the last: " + lastMsg, text };
    }
    if (this.troubleSince !== null && now - this.troubleSince >= this.silenceMs) {
      return { reason: "silence", detail: "no MCP call got through for " + Math.round((now - this.troubleSince) / 1000) + " s" +
        (lastMsg ? ", the last failure: " + lastMsg : " (a call was still waiting for its answer)"), text };
    }
    return null;
  }
}

// Reads the lines appended since the last read. Bytes, not characters, are carried over between
// reads, so a line cut in the middle of a Cyrillic letter is not mangled.
export class HealthReader {
  constructor(file) { this.file = file; this.pos = 0; this.rest = Buffer.alloc(0); }
  skipToEnd() {
    try { this.pos = statSync(this.file).size; } catch (e) { this.pos = 0; }
    this.rest = Buffer.alloc(0);
  }
  read() {
    let fd;
    try { fd = openSync(this.file, "r"); } catch (e) { return []; }
    let chunk;
    try {
      const size = fstatSync(fd).size;
      if (size < this.pos) { this.pos = 0; this.rest = Buffer.alloc(0); }
      if (size === this.pos) return [];
      chunk = Buffer.alloc(size - this.pos);
      const n = readSync(fd, chunk, 0, chunk.length, this.pos);
      chunk = chunk.subarray(0, n);
      this.pos += n;
    } finally { closeSync(fd); }
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const cut = buf.lastIndexOf(10);
    if (cut < 0) { this.rest = Buffer.from(buf); return []; }
    this.rest = Buffer.from(buf.subarray(cut + 1));
    const out = [];
    for (const line of buf.subarray(0, cut).toString("utf8").split(NL)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) {}
    }
    return out;
  }
}

// ---------- reading a failure ----------

// The first line that says what went wrong. Node's own crash report starts with the file position
// and the offending source line ("throw new Error(...)"), which reads like an error and is not
// one, so those two lines and the caret are dropped before looking.
const ERRORISH = /error|fail|cannot|could not|timed out|exception|refused|denied|not found|no such/i;
export function headline(stderr, stdout, code) {
  const lines = (t) => String(t || "").split(/\r?\n/).map((s) => s.trim());
  const err = lines(stderr);
  const kept = [];
  for (let i = 0; i < err.length; i++) {
    const l = err[i];
    if (/^(file:\/\/\/?|[A-Za-z]:\\|\/).*:\d+$/.test(l)) { i += 2; continue; }
    if (!l || l === "^" || /^at\s/.test(l) || /^Node\.js v\d/.test(l)) continue;
    kept.push(l);
  }
  const pick = kept.find((l) => ERRORISH.test(l)) || kept[0];
  if (pick) return pick;
  const out = lines(stdout).filter(Boolean);
  if (out.length) return out[out.length - 1];
  return "exit code " + code + " with no output";
}

const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// ---------- processes ----------

// A whole tree, because the object's process is node migrate.mjs, which runs px-*.mjs, which runs
// mcp.mjs: killing only the first leaves the others holding the pipes and the connection to Pixso.
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch (e) {
    try { child.kill("SIGKILL"); } catch (e2) {}
  }
  return true;
}

function runChild(args, { cwd, env, group, graceMs = TIMING.graceMs }) {
  const t0 = Date.now();
  // On POSIX the child leads its own process group so the whole tree can be killed at once. On
  // Windows taskkill /T walks the tree, and a detached child would get a console window of its own.
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !!group && !WIN });
  const out = [], err = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => err.push(d));
  const done = new Promise((resolve) => {
    let settled = false, code = null, signal = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout: out.join(""), stderr: err.join(""), ms: Date.now() - t0 });
    };
    child.on("error", (e) => { err.push(String((e && e.stack) || e)); code = -1; finish(); });
    // "close" waits for the pipes, and a grandchild that escaped the kill would hold them open for
    // ever. "exit" plus a grace period cannot hang.
    child.on("exit", (c, s) => { code = c; signal = s; setTimeout(finish, graceMs).unref(); });
    child.on("close", (c, s) => { if (code === null) { code = c; signal = s; } finish(); });
  });
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmQuiet = (p) => { try { rmSync(p, { force: true }); } catch (e) {} };
const hasPayload = (dir) => { try { return statSync(join(dir, "payload.json")).size > 2; } catch (e) { return false; } };

function writeJsonAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  const tmp = file + ".tmp";
  writeFileSync(tmp, text, "utf8");
  // Rename, so a reader never sees half a file. Windows refuses it now and then while something else
  // has the target open; then write in place rather than lose the checkpoint.
  for (let i = 0; i < 5; i++) { try { renameSync(tmp, file); return; } catch (e) {} }
  writeFileSync(file, text, "utf8");
  rmQuiet(tmp);
}

export function readStates(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return null; }
}

// What the verdict needs to know about the objects that never reached Figma.
export function unextracted(states) {
  if (!states || !Array.isArray(states.objects)) return [];
  return states.objects.filter((o) => o.state !== "extracted").map((o) => ({
    name: basename(o.dir), state: o.state === "failed" ? "failed" : "skipped", reason: o.reason || null,
    error: o.error || (o.state === "pending"
      ? "not extracted: the extraction run ended before this object (interrupted?) — see states.json"
      : "no error recorded"),
  }));
}

// A line of migrate-file.mjs output → what the plugin window shows, or null. Lines for the designer
// come prefixed with ">> " and in Russian; progress lines are shortened; everything else stays in
// the console.
export function runnerLine(line) {
  line = String(line).replace(String.fromCharCode(13), "");
  if (line.startsWith(">> ")) return line.slice(3);
  // Parsed by hand rather than by pattern: the line shape is fixed and known, and a regular
  // expression written through three layers of shell quoting has eaten its own backslashes more
  // than once.
  //   [12/34] FRAME 2161n  "Ресурсы/ Меню закрыто"   (382s elapsed)
  if (line.charAt(0) === "[") {
    const close = line.indexOf("]");
    const q1 = line.indexOf(String.fromCharCode(34));
    const q2 = line.lastIndexOf(String.fromCharCode(34));
    const counter = close > 0 ? line.slice(1, close) : "";
    const name = q2 > q1 ? line.slice(q1 + 1, q2) : "";
    return "  " + counter.replace("/", " из ") + "   " + name;
  }
  if (line.indexOf("FAILED") >= 0 || line.indexOf("extracted ") >= 0) return "  " + line.trim().slice(0, 120);
  return null;
}

// Russian, for the designer's lines.
function ru(ms) {
  if (ms >= 60000) return (ms % 60000 ? (ms / 60000).toFixed(1) : ms / 60000) + " мин";
  if (ms >= 1000) return (ms % 1000 ? (ms / 1000).toFixed(1) : ms / 1000) + " с";
  return ms + " мс";
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

// ---------- the loop ----------

// o: { doc, jobs, outDir, log, tell, extractor: { script, args, cwd }, env, timing }
//   log  — English technical lines (console)
//   tell — Russian lines for the designer (migrate-file prints them with ">> ", run.mjs relays them)
//   extractor — the per-object program; migrate.mjs in extract-only mode unless a test says otherwise
//   env  — added to the environment of every child (tests set MCP_URL and MCP_TIMEOUT_MS here)
// Returns { exitCode, states, files }.
export async function extractAll(o) {
  const doc = o.doc, jobs = o.jobs, outDir = o.outDir;
  const log = o.log || console.log;
  const tell = o.tell || ((s) => console.log(">> " + s));
  const T = Object.assign({}, TIMING, o.timing || {});
  const extractor = o.extractor || { script: join(HERE, "migrate.mjs"), args: [] };
  const baseEnv = o.env || {};
  mkdirSync(outDir, { recursive: true });
  const files = {
    states: join(outDir, "states.json"),
    health: join(outDir, "mcp-health.log"),
    gate: join(outDir, "mcp-breaker.open"),
    identity: join(outDir, "_identity.js"),
    dirs: join(outDir, "dirs.txt"),
    jobs: join(outDir, "jobs.json"),
  };
  rmQuiet(files.gate);
  writeFileSync(files.health, "", "utf8");
  writeFileSync(files.identity, IDENTITY_SCRIPT, "utf8");

  const baseline = identityOf(doc);
  const t0 = Date.now();
  const st = {
    version: 1,
    file: doc.file, fileKey: doc.fileKey || null, identity: baseline,
    status: "running", stopReason: null, stopDetail: null,
    started: new Date(t0).toISOString(), updated: null, current: null,
    counts: null,
    trips: [],
    objects: jobs.map((j, k) => ({ n: k + 1, key: j.pi + "-" + j.ci, page: j.page, id: j.id, name: j.name, type: j.type,
      nodes: j.nodes, dir: j.dir, state: "pending", attempts: 0 })),
  };
  const count = () => {
    const c = { extracted: 0, failed: 0, skipped: 0, pending: 0 };
    for (const ob of st.objects) c[ob.state] = (c[ob.state] || 0) + 1;
    return c;
  };
  const save = () => { st.updated = new Date().toISOString(); st.counts = count(); writeJsonAtomic(files.states, st); };
  const openGate = () => { try { writeFileSync(files.gate, new Date().toISOString(), "utf8"); } catch (e) {} };

  // A re-run skips what is already on disk and tries again what is not — failed objects included.
  for (const ob of st.objects) {
    if (hasPayload(ob.dir)) { ob.state = "extracted"; ob.reused = true; }
    else if (!ob.id) {
      ob.state = "skipped"; ob.reason = "NO_ID";
      ob.error = "not extracted: Pixso gave no id for this object when the file was read (px-pages could not count it)";
    }
  }
  save();

  const breaker = new Breaker(T);
  const reader = new HealthReader(files.health);
  let queue = st.objects.filter((ob) => ob.state === "pending").map((ob) => ob.n - 1);
  let trip = null;
  let current = null;
  // The object's processes must not outlive the loop. On POSIX they run in a process group of their
  // own (so the breaker can kill the whole tree), which also means Ctrl+C in the terminal no longer
  // reaches them by itself: pass it on. Without a handler, a signal ends Node without "exit".
  const onExit = () => { if (current) killTree(current); };
  const SIGNALS = WIN ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (sig) => { onExit(); process.exit(sig === "SIGINT" ? 130 : 143); };
  process.on("exit", onExit);
  for (const s of SIGNALS) process.on(s, onSignal);

  const mcpEnv = (timeoutMs) => {
    const env = Object.assign({}, process.env, baseEnv, { MCP_TIMEOUT_MS: String(timeoutMs) });
    // The loop's own calls are not the objects' calls: they neither feed the health log nor stop at
    // the gate (the probes have to get through while it is shut).
    delete env.PX_MCP_HEALTH;
    delete env.PX_MCP_GATE;
    return env;
  };
  async function callMcp(args, timeoutMs) {
    const run = runChild([MCP, ...args], { cwd: HERE, env: mcpEnv(timeoutMs) });
    // mcp.mjs keeps its own deadline; this is the backstop if it ever does not.
    const backstop = setTimeout(() => killTree(run.child), timeoutMs + 5000);
    const r = await run.done;
    clearTimeout(backstop);
    return r;
  }
  async function readIdentity() {
    const r = await callMcp(["script", files.identity], T.identityTimeoutMs);
    if (r.code !== 0) {
      return { transport: r.code === EXIT_TRANSPORT, error: headline(r.stderr, r.stdout, r.code), text: r.stderr };
    }
    const body = r.stdout.split(/\r?\n/).filter((l) => l.trim() && l.trim() !== "!! isError: true").join(NL).trim();
    if (r.stdout.indexOf("!! isError: true") >= 0) return { error: "Pixso refused the identity script: " + clip(body, 300), text: r.stdout };
    let j = null;
    try { j = JSON.parse(body); } catch (e) {}
    if (!j || typeof j !== "object" || j.error || typeof j.file !== "string" || !Array.isArray(j.pageIds)) {
      return { error: "the identity script did not answer with a file and its pages: " + clip(body, 300), text: r.stdout };
    }
    return { identity: { file: j.file, fileKey: j.fileKey || null, pageIds: j.pageIds.map(String) } };
  }

  async function extractOne(ob) {
    if (ob.state === "failed") {
      (ob.history = ob.history || []).push({ attempt: ob.attempts, error: ob.error, transport: !!ob.transport });
    }
    for (const k of ["error", "reason", "transport", "errorLog"]) delete ob[k];
    ob.state = "pending";
    ob.attempts++;
    const at = Date.now();
    mkdirSync(ob.dir, { recursive: true });
    log("[" + ob.n + "/" + st.objects.length + "] " + ob.type + " " + ob.nodes + "n  " + JSON.stringify(ob.name) +
      "   (" + Math.round((at - t0) / 1000) + "s elapsed" + (ob.attempts > 1 ? ", attempt " + ob.attempts : "") + ")");
    st.current = ob.key;
    save();

    const env = Object.assign({}, process.env, baseEnv, {
      PX_EXTRACT_ONLY: "1", PX_PLACE_ABS: "1", PX_IMG_CACHE: join(outDir, "imgcache"),
      PX_MCP_HEALTH: files.health, PX_MCP_GATE: files.gate,
    });
    const run = runChild([extractor.script, ...(extractor.args || []), String(ob.id), ob.dir],
      { cwd: extractor.cwd || HERE, env, group: true, graceMs: T.graceMs });
    current = run.child;
    const events = [];
    let tripped = null, killed = false;
    const drain = () => { for (const ev of reader.read()) { events.push(ev); breaker.observe(ev); } };
    const timer = setInterval(() => {
      drain();
      if (tripped) return;
      const c = breaker.check(Date.now());
      if (c) {
        tripped = c;
        // Shut the gate first, so nothing the kill misses can reach Pixso again, then stop the tree.
        openGate();
        killed = killTree(run.child);
        log("      circuit breaker: " + c.detail + (killed ? " — stopped the object's processes" : ""));
      }
    }, T.pollMs);
    const res = await run.done;
    clearInterval(timer);
    current = null;
    drain();
    st.current = null;
    // The object may have ended on the very failure that completes the count, between two polls:
    // it is the same trip, and its object failed for the same reason.
    if (!tripped) tripped = breaker.check(Date.now());

    const attempt = { at, res, events, killed, sawTransport: events.some((e) => e.ev === "transport") };
    if (!killed && res.code === 0 && hasPayload(ob.dir)) {
      ob.state = "extracted";
      ob.reused = false;
      ob.ms = res.ms;
      rmQuiet(join(ob.dir, ERROR_LOG));
      save();
      return { trip: tripped, attempt };
    }

    let lastEnd = null;
    for (const ev of events) if (ev.ev === "ok" || ev.ev === "error" || ev.ev === "transport") lastEnd = ev;
    const transport = !!tripped || (!!lastEnd && lastEnd.ev === "transport");
    let error;
    if (tripped) error = "Pixso stopped answering while this object was read: " + tripped.detail;
    else if (transport) error = lastEnd.msg || "transport failure";
    else if (res.code === 0) error = "the extractor finished without writing payload.json";
    else error = headline(res.stderr, res.stdout, res.code);

    // A failed attempt must not leave a payload.json a later run would take for a success. A killed
    // one may also have been half-way through writing any of its step files, which the next attempt
    // would otherwise skip as done; they are all redone.
    const discarded = discardAttempt(ob.dir, at, killed);
    fail(ob, attempt, transport ? "PIXSO_UNAVAILABLE" : "EXTRACT_FAILED", transport, error, discarded, killed
      ? "stopped by the circuit breaker"
      : null);
    return { trip: tripped, attempt };
  }

  // Files the attempt that started at `at` wrote: only payload.json, or everything it touched.
  function discardAttempt(dir, at, everything) {
    const gone = [];
    const discard = (p, label) => {
      try { const s = statSync(p); if (s.isFile() && s.mtimeMs >= at) { rmSync(p, { force: true }); gone.push(label); } } catch (e) {}
    };
    if (everything) {
      let names = [];
      try { names = readdirSync(dir); } catch (e) {}
      for (const n of names) if (n !== ERROR_LOG) discard(join(dir, n), n);
      discard(join(dir, "img", "manifest.json"), "img/manifest.json");
    } else discard(join(dir, "payload.json"), "payload.json");
    return gone;
  }

  // Records a failed attempt in the object's state and writes its extract-error.log, whole.
  function fail(ob, attempt, reason, transport, error, discarded, how) {
    const { at, res, events } = attempt;
    ob.state = "failed";
    ob.reused = false;
    ob.transport = transport;
    ob.reason = reason;
    ob.error = error;
    ob.errorLog = ERROR_LOG;
    ob.ms = res.ms;
    const fails = events.filter((e) => e.ev === "transport" || e.ev === "error");
    const L = [];
    L.push("object     " + ob.key + "  " + JSON.stringify(ob.name) + "  id " + ob.id + "  " + ob.type + ", " + ob.nodes + " nodes, page " + JSON.stringify(ob.page));
    L.push("attempt    " + ob.attempts + ", started " + new Date(at).toISOString() + ", took " + res.ms + " ms");
    L.push("exit       " + (res.signal ? "signal " + res.signal : "code " + res.code) + (how ? ", " + how : ""));
    L.push("error      " + error);
    L.push("kind       " + (reason === "IDENTITY_CHANGED"
      ? "the open file changed while this object was read; what it read is discarded"
      : transport
        ? "transport: the channel to Pixso failed; retried when Pixso answers again, and by any later run"
        : "Pixso answered, the object still failed; a later run tries it again"));
    if (discarded.length) L.push("discarded  written by this attempt and not to be trusted: " + discarded.join(", "));
    L.push("");
    L.push("-------- MCP calls that failed during this attempt: " + fails.length + " --------");
    for (const e of fails) {
      L.push("[" + new Date(e.t).toISOString() + "] " + e.ev + " (" + (e.kind || "?") + ", " + (e.ms === undefined ? "?" : e.ms) + " ms)");
      L.push(e.text || e.msg || "");
      L.push("");
    }
    L.push("-------- stderr, complete: " + res.stderr.length + " chars --------");
    L.push(res.stderr);
    L.push("-------- stdout, complete: " + res.stdout.length + " chars --------");
    L.push(res.stdout);
    try { writeFileSync(join(ob.dir, ERROR_LOG), L.join(NL), "utf8"); } catch (e) { log("      could not write " + ERROR_LOG + ": " + e.message); }
    log("      FAILED: " + clip(error, 300));
    save();
  }

  async function waitForPixso(tr) {
    openGate();
    const ob = st.objects[tr.at];
    const done = count().extracted, left = st.objects.length - done;
    const rec = { at: new Date().toISOString(), object: ob.key, name: ob.name, reason: tr.reason, detail: tr.detail,
      done, left, outcome: "waiting" };
    if (tr.text) rec.text = tr.text;
    st.trips.push(rec);
    st.status = "waiting-for-pixso";
    // The checkpoint is on disk before anyone is told, so whatever happens next it is there.
    save();
    tell("Pixso перестал отвечать на объекте «" + ob.name + "» (" + ob.n + " из " + st.objects.length + "): готово " + done + ", осталось " + left);
    // reason: "transport" and "silence" come from the breaker; "identity-check" is the loop's own
    // question about which file is open, which a Pixso that is not there cannot answer either.
    tell(tr.reason === "silence"
      ? "Ни одно обращение к Pixso не прошло за " + ru(T.silenceMs) + "."
      : tr.reason === "identity-check"
        ? "Pixso не ответил на вопрос, какой файл в нём открыт."
        : T.transportTrip + " " + plural(T.transportTrip, "обращение", "обращения", "обращений") + " подряд не дошли до Pixso.");
    tell("Извлечённое сохранено. Проверяю Pixso каждые " + ru(T.probeEveryMs) + ", жду до " + ru(T.probeForMs) + ".");
    log("circuit breaker open at " + ob.key + " " + JSON.stringify(ob.name) + ": " + tr.detail + "; " + done + " done, " + left + " left");
    const since = Date.now(), until = since + T.probeForMs;
    let last = tr.detail, lastText = tr.text || null, probes = 0;
    while (Date.now() < until) {
      await sleep(Math.max(0, Math.min(T.probeEveryMs, until - Date.now())));
      probes++;
      const p = await callMcp(["info"], T.probeTimeoutMs);
      if (p.code !== 0) { last = headline(p.stderr, p.stdout, p.code); lastText = p.stderr; continue; }
      // Pixso answers. Before anything else is read from it: is it still the same file?
      const id = await readIdentity();
      if (!id.identity) { last = id.error; lastText = id.text || null; continue; }
      rec.waitedMs = Date.now() - since;
      rec.probes = probes;
      const d = identityDiff(baseline, id.identity);
      if (d) {
        rec.outcome = "identity-changed";
        return { code: "IDENTITY_CHANGED", detail: d.text, diff: d };
      }
      rec.outcome = "resumed";
      rmQuiet(files.gate);
      breaker.reset();
      // Whatever the killed processes and the shut gate wrote meanwhile belongs to the outage.
      reader.skipToEnd();
      st.status = "running";
      save();
      tell("Pixso снова отвечает, файл тот же — продолжаю: осталось " + left);
      log("Pixso answers again after " + Math.round(rec.waitedMs / 1000) + " s (" + probes + " probes), same file: resuming");
      return { code: "RESUMED" };
    }
    rec.outcome = "gave-up";
    rec.waitedMs = Date.now() - since;
    rec.probes = probes;
    rec.lastError = last;
    return { code: "PIXSO_UNAVAILABLE", detail: last, text: lastText };
  }

  function stop(code, detail, text, diff) {
    for (const ob of st.objects) {
      if (ob.state !== "pending") continue;
      ob.state = "skipped";
      ob.reason = code;
      ob.error = code === "IDENTITY_CHANGED"
        ? "not extracted: a different file is open in Pixso (IDENTITY_CHANGED: " + detail + ")"
        : "not extracted: Pixso stopped answering and did not come back within " + Math.round(T.probeForMs / 1000) + " s";
    }
    st.status = code === "IDENTITY_CHANGED" ? "identity-changed" : "gave-up";
    st.stopReason = code;
    st.stopDetail = detail;
    if (text) st.stopText = text;
    const c = count();
    if (code === "IDENTITY_CHANGED") {
      const was = diff && diff.fileWas, now = diff && diff.fileNow;
      tell("В Pixso открыт другой файл" + (was !== now ? ": «" + now + "» вместо «" + was + "»" : " (страницы не те, что были)") +
        ". Останавливаю извлечение: IDENTITY_CHANGED.");
      tell("Готово " + c.extracted + ", осталось " + (st.objects.length - c.extracted) + ". Откройте в Pixso «" + was +
        "» и запустите перенос снова — извлечённое пропустится.");
    } else {
      tell("Pixso так и не ответил за " + ru(T.probeForMs) + ". Останавливаю извлечение: готово " + c.extracted +
        ", осталось " + (st.objects.length - c.extracted) + ".");
      tell("Запустите перенос снова, когда Pixso вернётся, — извлечённое пропустится.");
    }
    log("stopped: " + code + " — " + detail);
    return code === "IDENTITY_CHANGED" ? EXIT.IDENTITY_CHANGED : EXIT.PIXSO_GONE;
  }

  function finish(stoppedWith) {
    process.off("exit", onExit);
    for (const s of SIGNALS) process.off(s, onSignal);
    rmQuiet(files.gate);
    if (stoppedWith === undefined) st.status = "complete";
    st.current = null;
    save();
    const c = count();
    const reused = st.objects.filter((ob) => ob.state === "extracted" && ob.reused).length;
    log("");
    log("================ extraction ================");
    log("extracted " + (c.extracted - reused) + ", already present " + reused + ", failed " + c.failed +
      ", skipped " + c.skipped + "   in " + Math.round((Date.now() - t0) / 1000) + "s");
    for (const ob of st.objects) {
      if (ob.state === "failed") log("  FAIL  " + ob.key + " " + JSON.stringify(ob.name) + "  " + ob.id + "  " + clip(ob.error, 200));
      else if (ob.state !== "extracted") log("  SKIP  " + ob.key + " " + JSON.stringify(ob.name) + "  " + ob.id + "  " + clip(ob.error, 200));
    }
    // dirs.txt is what can be built; states.json is what happened to everything.
    const ok = st.objects.filter((ob) => ob.state === "extracted");
    writeFileSync(files.dirs, ok.map((ob) => ob.dir).join(NL) + NL, "utf8");
    writeFileSync(files.jobs, JSON.stringify({ file: doc.file, jobs,
      failed: st.objects.filter((ob) => ob.state === "failed").map((ob) => Object.assign({}, jobs[ob.n - 1], { error: ob.error })),
    }, null, 2), "utf8");
    log("");
    log(ok.length + " payloads ready, listed in " + files.dirs);
    log("every object's state: " + files.states);
    const exitCode = stoppedWith !== undefined ? stoppedWith : (c.failed || c.skipped ? EXIT.SOME_FAILED : EXIT.OK);
    return { exitCode, states: st, files };
  }

  if (queue.length) {
    // Before the first object, as at every resume: is the file open in Pixso the one pages.json
    // describes? A pages.json kept from yesterday and another file open today would otherwise be
    // read object by object, by ids that may well exist in both.
    const first = await readIdentity();
    if (first.transport) trip = { reason: "identity-check", detail: first.error, text: first.text, at: queue[0] };
    else if (first.identity) {
      const d = identityDiff(baseline, first.identity);
      if (d) return finish(stop("IDENTITY_CHANGED", d.text, null, d));
    } else {
      log("warning: could not confirm which file is open in Pixso: " + first.error);
      tell("Не удалось проверить, какой файл открыт в Pixso (" + clip(first.error, 160) + "). Продолжаю по списку из pages.json.");
    }
  }

  // An extracted object whose reading straddled a change of file: everything its attempt wrote goes,
  // and it is recorded as failed.
  function disown({ ob, attempt }, detail) {
    fail(ob, attempt, "IDENTITY_CHANGED", false,
      "discarded: the file open in Pixso changed while this object was read (IDENTITY_CHANGED: " + detail + ")",
      discardAttempt(ob.dir, attempt.at, true), "read across a change of file");
  }

  // An object that finished after a transport failure, right before the breaker tripped: if Pixso
  // then comes back on another file, it may have been read across the change.
  let suspect = null;
  for (;;) {
    if (trip) {
      const r = await waitForPixso(trip);
      if (r.code !== "RESUMED") {
        if (r.code === "IDENTITY_CHANGED" && suspect) disown(suspect, r.detail);
        return finish(stop(r.code, r.detail, r.text, r.diff));
      }
      trip = null;
      suspect = null;
      // The interrupted object and anything else the channel failed go first, in file order.
      const again = st.objects.filter((ob) => ob.state === "failed" && ob.transport && ob.attempts < T.maxAttempts).map((ob) => ob.n - 1);
      queue = again.concat(queue.filter((k) => again.indexOf(k) < 0));
      continue;
    }
    if (!queue.length) {
      // One more go for objects a passing blip failed without tripping the breaker: the channel
      // failed them, not their content.
      const blip = st.objects.filter((ob) => ob.state === "failed" && ob.transport && !ob.blipRetried && ob.attempts < T.maxAttempts);
      if (!blip.length) break;
      for (const ob of blip) ob.blipRetried = true;
      queue = blip.map((ob) => ob.n - 1);
      continue;
    }
    const k = queue.shift();
    const ob = st.objects[k];
    const r = await extractOne(ob);
    // Where the run stopped: at this object if it failed, else at the next one.
    const where = ob.state === "failed" || !queue.length ? k : queue[0];
    const mixed = ob.state === "extracted" && r.attempt.sawTransport ? { ob, attempt: r.attempt } : null;
    if (r.trip) { trip = Object.assign({ at: where }, r.trip); suspect = mixed; continue; }
    if (r.attempt.sawTransport) {
      // The channel failed at least once during this object, too briefly to trip the breaker, and
      // answered again. Pixso may have restarted in between, and not necessarily on the same file:
      // ask before reading anything else, and do not keep an object read across the switch.
      const id = await readIdentity();
      if (id.transport) { trip = { reason: "identity-check", detail: id.error, text: id.text, at: where }; suspect = mixed; continue; }
      if (id.identity) {
        const d = identityDiff(baseline, id.identity);
        if (d) {
          if (mixed) disown(mixed, d.text);
          return finish(stop("IDENTITY_CHANGED", d.text, null, d));
        }
      } else log("warning: after a transport failure, could not confirm which file is open in Pixso: " + id.error);
    }
  }
  return finish();
}

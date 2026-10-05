// Local job server. The Figma plugin polls it, pulls one job at a time, and posts the report back.
// Localhost only, and it exists only for the duration of a run.
//
// It used to answer anyone: CORS "*", no key, and read routes that handed the payload and the
// images to whoever asked. Any web page open in a browser on this machine could read a designer's
// file out of it, or post work into Figma. Now every request has to pass four checks, in this order:
//
//   Host     localhost:PORT, 127.0.0.1:PORT or [::1]:PORT, or 421. A page served from a name that
//            resolves to 127.0.0.1 (DNS rebinding) still sends its own name here.
//   Origin   exactly "null" — the plugin window's origin — or 403. PX_ALLOW_ORIGIN may name one more,
//            for diagnostics only; every refusal logs the Origin it saw, which is how probe P1 reads
//            the window's real origin off the console if it turns out not to be "null".
//   key      `Authorization: Bearer <this run's key>`, compared in constant time, or 401 — on every
//            route, read routes included. "null" alone proves nothing: any page can send it from a
//            sandboxed iframe. The key is the proof. It is 32 random bytes made fresh for each run
//            and written into the plugin's own files (tools/session.mjs), which no page can read.
//   ...except two things that cannot carry a key: the CORS preflight, which a browser sends
//            without one, and /pair, the one-time trade of a six-digit code printed on this console
//            for the key, for a plugin window opened before the runner started. Five tries per run.
//
// And one check that is not about who is asking but about what they would run. A runner started by
// tools/session.mjs knows the plugin build it has just written (opts.pluginVersion), and the plugin
// window names its own build in X-PXF-Plugin on every request, /pair included. A window opened before
// the runner was restarted from changed sources runs the builder it was opened with; given the code,
// it would pair and build with that, silently. So a different build gets 409 — before the key and
// before /pair, and without spending a pairing try — and the window asks to be closed and reopened.
// The build id is a hash of the plugin's public sources: not a secret, and 409 reveals nothing else.
//
// Liveness (docs/REWRITE.md §6, docs/M1.md §6 E). A job posted with opts.liveness and opts.ceilingMs
// (the IR path's tasks) is watched by its progress counter, not by the heartbeat: the plugin posts
// { t: "progress", id, done } whenever its main thread completes a chunk or a pass, the window
// forwards it as POST /alive?id=<job>&done=<n>, and only a larger n for the pending job counts as an
// advance (so does the window fetching the job's payload or one of its images: that is the job moving
// too). After warnMs without an advance the runner says so, once per stall; after failMs without one,
// or once ceilingMs has passed since the job was posted, post() rejects with code PLUGIN_STALLED
// (e.resumable: the task is failed, and a re-run resumes it). A heartbeat (/alive with no count) keeps
// the old "is the window there" signal and never extends a task.
//
// The image transport. A job's images cross the window as base64 text by default; "binary" sends them
// as Uint8Array slices of at most 4 MB. tools/double/verdicts.json P4 decides the default once the live
// probe has run (transport "binary"); a job may name its own (job.imageTransport).
import { createServer } from "node:http";
import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE } from "./ir/schema.mjs";

// The only kinds of job the plugin runs (figma-plugin/src/code.js); anything else is refused here
// before it is queued, and refused again there.
export const JOB_KINDS = Object.freeze(["build", "verify", "clean", "render", "probe", "ir"]);
const MAX_PAIR_TRIES = 5;

// The shape of post()'s opts, or what is wrong with it (null when it is fine or absent).
export function checkPostOpts(opts) {
  if (opts === undefined || opts === null) return null;
  if (typeof opts !== "object" || Array.isArray(opts)) return "opts must be an object";
  for (const k of Object.keys(opts)) if (["liveness", "ceilingMs", "onProgress"].indexOf(k) < 0) return "unknown option " + JSON.stringify(k);
  const pos = (v) => typeof v === "number" && isFinite(v) && v > 0;
  if (opts.liveness !== undefined) {
    const l = opts.liveness;
    if (!l || typeof l !== "object" || !pos(l.warnMs) || !pos(l.failMs) || Object.keys(l).some((k) => k !== "warnMs" && k !== "failMs")) return "liveness is { warnMs, failMs }, both positive";
    if (l.warnMs >= l.failMs) return "liveness.warnMs must be below failMs";
  }
  if (opts.ceilingMs !== undefined && !pos(opts.ceilingMs)) return "ceilingMs must be a positive number";
  if (opts.onProgress !== undefined && typeof opts.onProgress !== "function") return "onProgress must be a function";
  return null;
}

export const IMAGE_TRANSPORTS = Object.freeze(["base64", "binary"]);
// The transport P4 chose, from tools/double/verdicts.json; base64 while P4 is pending.
export function defaultImageTransport() {
  try {
    const v = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "double", "verdicts.json"), "utf8"));
    return v.probes.P4.verdicts.transport === "binary" ? "binary" : "base64";
  } catch (e) { return "base64"; }
}

export function newSecrets() {
  return { token: randomBytes(32).toString("hex"), pairCode: String(randomInt(0, 1000000)).padStart(6, "0") };
}

// Constant time whatever the lengths: both sides are hashed first, so the comparison is always of 32
// bytes and says nothing about how much of a guess was right.
function sameSecret(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Read a request body whole, as bytes, and decode once. Decoding chunk by chunk splits a Cyrillic
// character that straddles two chunks into two replacement characters.
function readBody(req, limit, done) {
  const chunks = [];
  let size = 0, over = false;
  req.on("data", (c) => { size += c.length; if (size > limit) over = true; else chunks.push(c); });
  req.on("end", () => done(over ? null : Buffer.concat(chunks).toString("utf8")));
}

export function startJobServer(port = 3778, opts = {}) {
  const fresh = newSecrets();
  const token = opts.token || fresh.token;
  const pairCode = opts.pairCode || fresh.pairCode;
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("jobserver: the token must be 64 lowercase hex characters");
  if (!/^[0-9]{6}$/.test(pairCode)) throw new Error("jobserver: the pairing code must be six digits");
  const warn = opts.log || ((m) => console.log(m));
  const pluginVersion = opts.pluginVersion ? String(opts.pluginVersion) : "";
  const extraOrigin = process.env.PX_ALLOW_ORIGIN || "";
  const transport = IMAGE_TRANSPORTS.indexOf(opts.imageTransport) >= 0 ? opts.imageTransport : defaultImageTransport();
  // The liveness state of the job being watched: { id, at (last advance), done, warned, onProgress }.
  let live = null;
  const advance = (id, done) => {
    if (!live || !pending || live.id !== id || pending.id !== id) return;
    if (done === undefined) { live.at = Date.now(); live.warned = false; return; }
    if (!(done > live.done)) return;
    live.done = done; live.at = Date.now(); live.warned = false;
    if (live.onProgress) { try { live.onProgress(done, id); } catch (e) {} }
  };
  let hosts = null;                // filled in once the real port is known
  let boundPort = port;
  let pairTries = 0, paired = false;

  let pending = null;              // { id, kind, rootNodeId, cleanupRootId, images:[hash] }
  const parts = new Map();         // job id -> report slices still being assembled
  // A run can be started from the plugin window. The plugin may only reach this address, so if
  // there is to be a button then the whole run — extraction included — has to be driven by
  // whoever owns this port, and progress has to come back the same way.
  let startWanted = null, startResolve = null;
  const progress = [];
  let phase = "idle";
  // Progress is long-polled, not asked for on a timer, so the plugin window keeps up with a run it
  // is not in front of. rev counts changes; a client says what it has seen and the request is held
  // until there is more.
  // Starts at 1, not 0: a client that has seen nothing asks with rev=0 and must be answered at
  // once. At 0 the first request would have been held for its full 25 seconds, and the window would
  // have sat on "checking…" — the very thing this replaced.
  let rev = 1;
  const ctlWaiters = [];
  function bump() { rev++; while (ctlWaiters.length) ctlWaiters.shift()(); }
  const waiters = [];              // held /job requests, answered the moment a job is posted
  let payload = "";                // payload text for the pending job
  let blobs = new Map();           // hash -> Buffer
  const waiting = new Map();       // id -> { resolve, reject }
  let seq = 0;
  let lastPoll = 0;            // when the plugin last asked for work
  let staleSeen = 0;           // when a plugin window of another build last asked (409)

  // Every refusal is said, with the Origin that came with it. Said once per kind every ten seconds,
  // so a page hammering the port cannot bury the run's own output. `detail` is said but is not part
  // of the kind, because it can carry what the caller sent, and a caller varying it must not be able
  // to make every request a new kind.
  const said = new Map();
  function refused(code, req, path, why, detail) {
    const origin = req.headers.origin === undefined ? "(none)" : JSON.stringify(String(req.headers.origin).slice(0, 80));
    const key = code + "|" + why + "|" + origin;
    const now = Date.now(), prev = said.get(key);
    if (prev && now - prev.at < 10000) { prev.n++; return; }
    said.set(key, { at: now, n: 0 });
    warn("  refused " + code + " " + req.method + " " + path + ": " + why + (detail ? " " + detail : "") + "; Origin " + origin +
      (prev && prev.n ? " (and " + prev.n + " more like it)" : ""));
  }

  const handler = (req, res) => {
    // A request target that is not a URL (`GET http://[ HTTP/1.1`) used to throw here, before any
    // check and outside any catch: one request from any local process, key or no key, ended the run.
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); }
    catch (e) { res.writeHead(400, { "Content-Type": "text/plain" }); return res.end("bad request"); }
    if (process.env.PX_LOG_HTTP) console.log("    [http] " + req.method + " " + url.pathname + (url.search || ""));

    const host = String(req.headers.host || "").toLowerCase();
    if (!hosts || !hosts.has(host)) {
      refused(421, req, url.pathname, "Host " + JSON.stringify(req.headers.host || ""));
      res.writeHead(421, { "Content-Type": "text/plain" });
      return res.end("misdirected request");
    }
    const origin = req.headers.origin;
    if (!(origin === "null" || (extraOrigin && origin === extraOrigin))) {
      refused(403, req, url.pathname, "Origin not allowed");
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("origin not allowed");
    }
    const cors = (type) => {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (type) res.setHeader("Content-Type", type);
    };
    if (req.method === "OPTIONS") {
      cors();
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-PXF-Plugin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
      // Every request now carries a key, so every request is preflighted. A Chromium that enforces
      // Private Network Access asks here whether a page may reach a loopback address; the answer
      // grants nothing by itself — the key is still required on the request that follows.
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204);
      return res.end();
    }

    if (pluginVersion) {
      const theirs = String(req.headers["x-pxf-plugin"] || "");
      if (theirs !== pluginVersion) {
        // The window parks after its first 409, so this line is said once; the wait below repeats it.
        if (origin === "null") staleSeen = Date.now();
        refused(409, req, url.pathname, "the plugin window runs another build than this runner wrote —" +
          " close the plugin in Figma and open it again", "(window " + (theirs ? JSON.stringify(theirs.slice(0, 24)) : "names none") +
          ", runner " + pluginVersion + ")");
        // Readable by the window, which then asks to be reopened rather than for the code.
        cors("application/json");
        res.writeHead(409);
        return res.end(JSON.stringify({ ok: false, reopen: true, error: "this plugin window runs another build than the runner wrote; close it and open it again" }));
      }
    }

    if (url.pathname === "/pair" && req.method === "POST") {
      return readBody(req, 1024, (text) => {
        cors("application/json");
        if (paired) {
          refused(410, req, url.pathname, "the pairing code has already been used");
          res.writeHead(410);
          return res.end(JSON.stringify({ ok: false, error: "the code has already been used" }));
        }
        if (pairTries >= MAX_PAIR_TRIES) {
          refused(429, req, url.pathname, "no pairing tries left this run");
          res.writeHead(429);
          return res.end(JSON.stringify({ ok: false, error: "too many attempts" }));
        }
        pairTries++;
        let code = "";
        try { code = String(JSON.parse(text || "{}").code || ""); } catch (e) {}
        if (sameSecret(code, pairCode)) {
          paired = true;
          warn("  paired: a plugin window traded the code for this run's key");
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, token }));
        }
        refused(403, req, url.pathname, "wrong pairing code, " + (MAX_PAIR_TRIES - pairTries) + " tries left");
        res.writeHead(403);
        return res.end(JSON.stringify({ ok: false, left: MAX_PAIR_TRIES - pairTries }));
      });
    }

    const auth = String(req.headers.authorization || "");
    if (!(auth.startsWith("Bearer ") && sameSecret(auth.slice(7), token))) {
      refused(401, req, url.pathname, (auth ? "wrong key" : "no key") +
        (origin === "null" ? " (a plugin window opened before this runner started asks for the code)" : ""));
      // With the CORS header, so the window can read the status: a 401 it cannot see looks exactly
      // like a runner that is not there, and it would wait for one instead of asking for the code.
      cors("text/plain");
      res.writeHead(401);
      return res.end("unauthorized");
    }

    // What the runner sees of the plugin window — probe P1. The key itself is not echoed.
    if (url.pathname === "/echo" && req.method === "GET") {
      const h = Object.assign({}, req.headers);
      if (h.authorization) h.authorization = "Bearer <redacted>";
      warn("  echo: the plugin window's Origin is " + JSON.stringify(origin));
      cors("application/json");
      return res.end(JSON.stringify({ method: req.method, path: url.pathname, headers: h }));
    }

    if (url.pathname === "/control" && req.method === "GET") {
      cors("application/json");
      const body = () => JSON.stringify({ rev: rev, phase: phase, lines: progress.slice(-14) });
      const seen = Number(url.searchParams.get("rev") || 0);
      if (!(seen >= rev)) return res.end(body());
      // Nothing new. Hold the request rather than answering "same as before" and letting the plugin
      // come back on a timer — a timer in a background window fires about once a minute, so that is
      // how long a line took to appear in the window watching the run.
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        const at = ctlWaiters.indexOf(done);
        if (at >= 0) ctlWaiters.splice(at, 1);
        try { res.end(body()); } catch (e) {}
      };
      const t = setTimeout(done, 25000);
      ctlWaiters.push(done);
      req.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        const at = ctlWaiters.indexOf(done);
        if (at >= 0) ctlWaiters.splice(at, 1);
      });
      return;
    }

    if (url.pathname === "/start" && req.method === "POST") {
      // The button carries what the designer chose to migrate — the whole file, the page they have
      // open, or what they have selected. Read the body rather than discarding it.
      return readBody(req, 64 * 1024, (sbody) => {
        cors("application/json");
        res.end(JSON.stringify({ ok: true }));
        let opts2 = {};
        try { opts2 = JSON.parse(sbody || "{}") || {}; } catch (e) {}
        if (startResolve) { const r = startResolve; startResolve = null; r(opts2); }
      });
    }

    if (url.pathname === "/job" && req.method === "GET") {
      const fromPlugin = url.searchParams.get("client") === "plugin";
      if (fromPlugin) lastPoll = Date.now();
      cors("application/json");
      if (pending || !fromPlugin) return res.end(JSON.stringify(pending || { kind: "noop" }));
      // Nothing to give it yet, so hold the request instead of answering "noop" and letting the
      // plugin come back later on a timer. Chromium throttles timers in a background window to one
      // wake-up a minute, so "later" meant a minute, and a runner that gives up after 45 s of
      // silence gave up on a plugin that was sitting there perfectly healthy. Held here, the
      // answer arrives the instant a job is posted and the plugin never has to schedule anything.
      let settled = false;
      const answer = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const at = waiters.indexOf(answer);
        if (at >= 0) waiters.splice(at, 1);
        lastPoll = Date.now();
        try { res.end(JSON.stringify(pending || { kind: "noop" })); } catch (e) {}
      };
      const timer = setTimeout(answer, 25000);
      waiters.push(answer);
      req.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const at = waiters.indexOf(answer);
        if (at >= 0) waiters.splice(at, 1);
      });
      return;
    }

    const pm = url.pathname.match(/^\/job\/([^/]+)\/payload$/);
    if (pm && req.method === "GET") {
      if (!pending || pending.id !== pm[1]) { cors(); res.writeHead(404); return res.end("no such job"); }
      advance(pm[1]);
      cors("text/plain; charset=utf-8");
      return res.end(payload);
    }

    const im = url.pathname.match(/^\/image\/([0-9a-f]+)$/);
    if (im && req.method === "GET") {
      const b = blobs.get(im[1]);
      if (!b) { cors(); res.writeHead(404); return res.end("no such image"); }
      if (pending) advance(pending.id);
      // Bytes used to cross into the plugin as a JS array of numbers, one element per byte. An
      // object carrying 102 MB of photographs turned that into an array of a hundred million
      // numbers and the sandbox never came back — the build sat there until the watchdog freed
      // it half an hour later. Text is cheap to move and the sandbox decodes it natively, so the
      // frame asks for base64 and forwards it in the same slices the payload uses.
      if (process.env.PX_LOG_IMG) console.log("  -> image " + im[1].slice(0, 8) + " " + b.length + " bytes" + (url.searchParams.get("b64") === "1" ? " as base64" : ""));
      if (url.searchParams.get("b64") === "1") {
        cors("text/plain");
        return res.end(b.toString("base64"));
      }
      cors("application/octet-stream");
      return res.end(b);
    }

    // Heartbeat from the plugin UI while the main thread builds: without it a long build and a
    // closed window look identical from here.
    if (url.pathname === "/alive" && req.method === "POST") {
      lastPoll = Date.now();
      // The progress counter, when the window forwards one; a bare heartbeat carries none.
      const doneQ = url.searchParams.get("done"), idQ = url.searchParams.get("id");
      if (doneQ !== null && idQ !== null && /^\d{1,12}$/.test(doneQ)) advance(idQ, Number(doneQ));
      req.resume();
      cors("application/json");
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/report" && req.method === "POST") {
      // A slice is 400 000 characters; escaped and in UTF-8 it stays well under this.
      return readBody(req, 16 * 1024 * 1024, (body) => {
        cors("application/json");
        if (body === null) { res.writeHead(413); return res.end(JSON.stringify({ ok: false, error: "report slice too large" })); }
        res.end(JSON.stringify({ ok: true }));
        let msg; try { msg = JSON.parse(body); } catch { return; }
        if (!msg || typeof msg !== "object") return;   // `null` parses, and msg.id would throw outside any catch
        const w = waiting.get(msg.id);
        if (!w) return;
        // A report carrying a render is megabytes, and one message that size never arrived at all:
        // the plugin latched on "busy" and kept heartbeating, so the runner saw a healthy plugin
        // that would never take another job. Reports now arrive in slices and are joined here.
        // The unsliced shape stays accepted so an older plugin build still reports.
        let report;
        if (typeof msg.d === "string") {
          const acc = parts.get(msg.id) || [];
          acc[msg.i || 0] = msg.d;
          parts.set(msg.id, acc);
          const n = msg.n || 1;
          let have = 0;
          for (let k = 0; k < n; k++) if (typeof acc[k] === "string") have++;
          if (have < n) return;
          parts.delete(msg.id);
          try { report = JSON.parse(acc.join("")); }
          catch (e) { report = { error: "report did not parse: " + e.message }; }
        } else report = msg.report;
        waiting.delete(msg.id);
        if (pending && pending.id === msg.id) { pending = null; payload = ""; blobs = new Map(); }
        w.resolve(report);
      });
    }

    cors(); res.writeHead(404); res.end("not found");
  };

  // The plugin fetches http://localhost:3778 because Figma's manifest validator rejects a raw
  // IP in allowedDomains -- and on Windows localhost often resolves to ::1 first, so binding only
  // 127.0.0.1 would refuse the connection. Bind both loopbacks with the same handler.
  //
  // Nothing a request carries may end the process: whatever the handler throws is answered 500.
  const guarded = (req, res) => {
    try { handler(req, res); }
    catch (e) {
      refused(500, req, "(any)", "the handler threw", String(e && e.message || e).slice(0, 120));
      try { if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" }); res.end("internal error"); } catch (e2) {}
    }
  };
  const server = createServer(guarded);
  const server6 = createServer(guarded);
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      // Port 0 asks for any free port (the tests do); the Host check needs the one actually given.
      boundPort = server.address().port;
      hosts = new Set(["localhost:" + boundPort, "127.0.0.1:" + boundPort, "[::1]:" + boundPort]);
      // A machine with no IPv6 loopback (EADDRNOTAVAIL, EAFNOSUPPORT) is fine: v4 is enough. Another
      // process on [::1] is not. The plugin's localhost usually resolves to ::1 first, so every request
      // it sent — the key with it — would go to that process while this runner waited for nobody.
      server6.once("error", (e) => {
        if (e && e.code === "EADDRINUSE") { try { server.close(); } catch (x) {} return reject(e); }
        resolve();
      });
      server6.listen(boundPort, "::1", () => resolve());
    });
  });

  return {
    ready,
    token,
    pairCode,
    // The plugin build this runner wrote and accepts; "" when it was started without one (the tests).
    pluginVersion,
    get port() { return boundPort; },
    get paired() { return paired; },
    // Wait until somebody presses the button in the plugin window.
    waitForStart() { if (!startWanted) startWanted = new Promise((r) => { startResolve = r; }); return startWanted; },
    // Say something the plugin window can show while a long step runs.
    say(line) { progress.push(String(line)); if (progress.length > 400) progress.shift(); bump(); },
    phase(p) { phase = String(p); bump(); },
    lastPoll: () => lastPoll,
    // Queue one job and resolve when the plugin reports back. One job at a time by construction:
    // the plugin only ever sees the job that is pending right now.
    //
    // opts (docs/M1.md §5.3, the IR path) = { liveness: { warnMs, failMs }, ceilingMs, onProgress(done, id) }:
    // warn after warnMs without an advancing progress counter, fail with PLUGIN_STALLED after failMs
    // without one or once ceilingMs has passed (the header says what an advance is); onProgress hears
    // every advance of the counter.
    post(job, payloadText, images = new Map(), timeoutMs = 20 * 60 * 1000, opts = undefined) {
      if (!job || !JOB_KINDS.includes(job.kind)) {
        return Promise.reject(new Error("refused: unknown job kind " + JSON.stringify(job && job.kind) +
          " — the plugin runs only " + JOB_KINDS.join(", ")));
      }
      if (typeof payloadText !== "string") return Promise.reject(new Error("a job's payload is JSON text"));
      const badOpts = checkPostOpts(opts);
      if (badOpts) return Promise.reject(new Error("post: " + badOpts));
      const id = "j" + (++seq);
      if (job.imageTransport !== undefined && IMAGE_TRANSPORTS.indexOf(job.imageTransport) < 0) {
        return Promise.reject(new Error("post: imageTransport is " + IMAGE_TRANSPORTS.join(" or ")));
      }
      pending = { id, kind: job.kind, rootNodeId: job.rootNodeId || null,
                  cleanupRootId: job.cleanupRootId || null, page: job.page || null,
                  pageBg: job.pageBg || null, images: [...images.keys()], imageTransport: job.imageTransport || transport,
                  // The plugin window sets its own watchdog above this, so the runner's PLUGIN_STALLED
                  // (resumable) always fires before the window gives the job up as a failed build.
                  ceilingMs: opts && opts.ceilingMs > 0 ? opts.ceilingMs : null };
      payload = payloadText;
      blobs = images;
      // Wake anything that is holding a /job request rather than making it wait out its own timeout.
      while (waiters.length) waiters.shift()();
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        watchLiveness(id, opts, reject);
        // Say something long before the timeout: a silent twenty-minute wait tells nobody whether
        // the plugin is working, closed, or wedged.
        let warned = 0, everSeen = lastPoll > 0;
        const t0w = Date.now();
        const watch = setInterval(() => {
          if (!waiting.has(id)) { clearInterval(watch); return; }
          const quiet = Date.now() - lastPoll;
          if (lastPoll > 0) everSeen = true;
          // Nothing has ever asked for work: the plugin is not open. Say so in seconds rather than
          // holding the run for the full timeout on a job nobody will ever take.
          // Two minutes, not 45 seconds. When the plugin cannot reach the runner it retries on
          // a timer, and a timer in a background window fires about once a minute, so a plugin
          // that is open and healthy can take that long to notice a runner that has just
          // started. Giving up sooner than that accuses the innocent.
          if (!everSeen && Date.now() - t0w > 300000) {
            waiting.delete(id);
            clearInterval(watch);
            reject(new Error("the pix-to-fig runner plugin has not contacted the server since it " +
              "started — open it in Figma (Plugins -> Development -> pix-to-fig runner) and run again"));
            return;
          }
          if (quiet > 15000) {
            warned++;
            // lastPoll is 0 until something asks for work, and "has not polled for 1789026005s" is
            // what subtracting from zero looks like — printed, of course, exactly when the person
            // reading it is already worried.
            console.log("  waiting: " + (lastPoll === 0
              ? (staleSeen ? "the plugin window that is open was opened before this runner was started from changed" +
                " sources — close it in Figma and open it again" : "nothing has asked this runner for work yet")
              : "the plugin has not polled for " + Math.round(quiet / 1000) + "s") +
              (warned === 1 ? " — is the pix-to-fig runner still open in Figma?" : ""));
          } else if (warned || Date.now() - t0w > 60000) {
            console.log("  waiting: plugin alive, job " + id + " in progress (" + Math.round((Date.now() - t0w) / 1000) + "s)");
          }
        }, 15000);
        // deliberately NOT unref'd: this is the only thing that reports what the run is waiting on,
        // and an unref'd interval was silently skipped in a process that had nothing else pending
        setTimeout(() => {
          if (waiting.has(id)) {
            waiting.delete(id);
            clearInterval(watch);
            reject(new Error("no report for job " + id + " within " + Math.round(timeoutMs / 1000) + "s — is the plugin running?"));
          }
        }, timeoutMs).unref?.();
      });
    },
    close() { try { server.close(); } catch {} try { server6.close(); } catch {} },
    // The image transport a job gets unless it names one.
    imageTransport: transport,
  };

  // Liveness for one job (see the header): warn once per stall, fail on failMs without an advance or
  // once the ceiling passes. Checked often enough to keep a short limit honest, at most once a second.
  function watchLiveness(id, o, reject) {
    if (!o || (!o.liveness && o.ceilingMs === undefined)) { if (live && live.id !== id) live = null; return; }
    const t0 = Date.now();
    live = { id, at: t0, done: -1, warned: false, onProgress: o.onProgress || null };
    const limits = [o.liveness && o.liveness.warnMs, o.liveness && o.liveness.failMs, o.ceilingMs].filter((v) => v > 0);
    const tick = Math.max(5, Math.min(1000, Math.floor(Math.min.apply(null, limits) / 4)));
    const fail = (why, kind) => {
      clearInterval(timer);
      if (!waiting.has(id)) return;
      waiting.delete(id);
      if (pending && pending.id === id) { pending = null; payload = ""; blobs = new Map(); }
      if (live && live.id === id) live = null;
      const e = new Error(CODE.PLUGIN_STALLED + ": job " + id + " " + why + "; the task is failed and a re-run resumes it");
      e.code = CODE.PLUGIN_STALLED; e.resumable = true; e.stall = kind;
      warn("  " + e.message);
      reject(e);
    };
    const timer = setInterval(() => {
      if (!waiting.has(id) || !live || live.id !== id) { clearInterval(timer); return; }
      const now = Date.now(), quiet = now - live.at;
      if (o.ceilingMs !== undefined && now - t0 > o.ceilingMs) return fail("passed its ceiling of " + Math.round(o.ceilingMs / 1000) + " s", "ceiling");
      if (!o.liveness) return;
      if (quiet > o.liveness.failMs) return fail("made no progress for " + Math.round(quiet / 1000) + " s (the limit is " + Math.round(o.liveness.failMs / 1000) + " s)", "stalled");
      if (quiet > o.liveness.warnMs && !live.warned) {
        live.warned = true;
        warn("  waiting: job " + id + " has made no progress for " + Math.round(quiet / 1000) + " s; it fails at " + Math.round(o.liveness.failMs / 1000) + " s without any");
      }
    }, tick);
  }
}

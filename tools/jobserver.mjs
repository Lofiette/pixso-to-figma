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
import { createServer } from "node:http";
import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";

// The only kinds of job the plugin runs (figma-plugin/src/code.js); anything else is refused here
// before it is queued, and refused again there.
export const JOB_KINDS = Object.freeze(["build", "verify", "clean", "render", "probe"]);
const MAX_PAIR_TRIES = 5;

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
  const extraOrigin = process.env.PX_ALLOW_ORIGIN || "";
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

  // Every refusal is said, with the Origin that came with it. Said once per kind every ten seconds,
  // so a page hammering the port cannot bury the run's own output.
  const said = new Map();
  function refused(code, req, path, why) {
    const origin = req.headers.origin === undefined ? "(none)" : JSON.stringify(req.headers.origin);
    const key = code + "|" + why + "|" + origin;
    const now = Date.now(), prev = said.get(key);
    if (prev && now - prev.at < 10000) { prev.n++; return; }
    said.set(key, { at: now, n: 0 });
    warn("  refused " + code + " " + req.method + " " + path + ": " + why + "; Origin " + origin +
      (prev && prev.n ? " (and " + prev.n + " more like it)" : ""));
  }

  const handler = (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
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
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
      // Every request now carries a key, so every request is preflighted. A Chromium that enforces
      // Private Network Access asks here whether a page may reach a loopback address; the answer
      // grants nothing by itself — the key is still required on the request that follows.
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204);
      return res.end();
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
      cors("text/plain; charset=utf-8");
      return res.end(payload);
    }

    const im = url.pathname.match(/^\/image\/([0-9a-f]+)$/);
    if (im && req.method === "GET") {
      const b = blobs.get(im[1]);
      if (!b) { cors(); res.writeHead(404); return res.end("no such image"); }
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
  const server = createServer(handler);
  const server6 = createServer(handler);
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      // Port 0 asks for any free port (the tests do); the Host check needs the one actually given.
      boundPort = server.address().port;
      hosts = new Set(["localhost:" + boundPort, "127.0.0.1:" + boundPort, "[::1]:" + boundPort]);
      server6.once("error", () => resolve());   // no IPv6 loopback here, v4 is enough
      server6.listen(boundPort, "::1", () => resolve());
    });
  });

  return {
    ready,
    token,
    pairCode,
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
    post(job, payloadText, images = new Map(), timeoutMs = 20 * 60 * 1000) {
      if (!job || !JOB_KINDS.includes(job.kind)) {
        return Promise.reject(new Error("refused: unknown job kind " + JSON.stringify(job && job.kind) +
          " — the plugin runs only " + JOB_KINDS.join(", ")));
      }
      if (typeof payloadText !== "string") return Promise.reject(new Error("a job's payload is JSON text"));
      const id = "j" + (++seq);
      pending = { id, kind: job.kind, rootNodeId: job.rootNodeId || null,
                  cleanupRootId: job.cleanupRootId || null, page: job.page || null,
                  pageBg: job.pageBg || null, images: [...images.keys()] };
      payload = payloadText;
      blobs = images;
      // Wake anything that is holding a /job request rather than making it wait out its own timeout.
      while (waiters.length) waiters.shift()();
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
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
              ? "nothing has asked this runner for work yet"
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
  };
}

// Local job server. The Figma plugin polls it, pulls one job at a time, and posts the report back.
// Localhost only, and it exists only for the duration of a run.
import { createServer } from "node:http";

export function startJobServer(port = 3778) {
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

  const cors = (res, type) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (type) res.setHeader("Content-Type", type);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (process.env.PX_LOG_HTTP) console.log("    [http] " + req.method + " " + url.pathname + (url.search || ""));
    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

    if (url.pathname === "/control" && req.method === "GET") {
      cors(res, "application/json");
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
      req.resume();
      cors(res, "application/json");
      res.end(JSON.stringify({ ok: true }));
      if (startResolve) { const r = startResolve; startResolve = null; r(); }
      return;
    }

    if (url.pathname === "/job" && req.method === "GET") {
      const fromPlugin = url.searchParams.get("client") === "plugin";
      if (fromPlugin) lastPoll = Date.now();
      cors(res, "application/json");
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
      if (!pending || pending.id !== pm[1]) { cors(res); res.writeHead(404); return res.end("no such job"); }
      cors(res, "text/plain; charset=utf-8");
      return res.end(payload);
    }

    const im = url.pathname.match(/^\/image\/([0-9a-f]+)$/);
    if (im && req.method === "GET") {
      const b = blobs.get(im[1]);
      if (!b) { cors(res); res.writeHead(404); return res.end("no such image"); }
      // Bytes used to cross into the plugin as a JS array of numbers, one element per byte. An
      // object carrying 102 MB of photographs turned that into an array of a hundred million
      // numbers and the sandbox never came back — the build sat there until the watchdog freed
      // it half an hour later. Text is cheap to move and the sandbox decodes it natively, so the
      // frame asks for base64 and forwards it in the same slices the payload uses.
      if (process.env.PX_LOG_IMG) console.log("  -> image " + im[1].slice(0, 8) + " " + b.length + " bytes" + (url.searchParams.get("b64") === "1" ? " as base64" : ""));
      if (url.searchParams.get("b64") === "1") {
        cors(res, "text/plain");
        return res.end(b.toString("base64"));
      }
      cors(res, "application/octet-stream");
      return res.end(b);
    }

    // Heartbeat from the plugin UI while the main thread builds: without it a long build and a
    // closed window look identical from here.
    if (url.pathname === "/alive" && req.method === "POST") {
      lastPoll = Date.now();
      req.resume();
      cors(res, "application/json");
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/report" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        cors(res, "application/json");
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
      return;
    }

    cors(res); res.writeHead(404); res.end("not found");
  });

  // The plugin fetches http://localhost:3778 because Figma's manifest validator rejects a raw
  // IP in allowedDomains -- and on Windows localhost often resolves to ::1 first, so binding only
  // 127.0.0.1 would refuse the connection. Bind both loopbacks with the same handler.
  const server6 = createServer(server.listeners("request")[0]);
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server6.once("error", () => resolve());   // no IPv6 loopback here, v4 is enough
      server6.listen(port, "::1", () => resolve());
    });
  });

  return {
    ready,
    // Wait until somebody presses the button in the plugin window.
    waitForStart() { if (!startWanted) startWanted = new Promise((r) => { startResolve = r; }); return startWanted; },
    // Say something the plugin window can show while a long step runs.
    say(line) { progress.push(String(line)); if (progress.length > 400) progress.shift(); bump(); },
    phase(p) { phase = String(p); bump(); },
    lastPoll: () => lastPoll,
    // Queue one job and resolve when the plugin reports back. One job at a time by construction:
    // the plugin only ever sees the job that is pending right now.
    post(job, payloadText, images = new Map(), timeoutMs = 20 * 60 * 1000) {
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
            console.log("  waiting: the plugin has not polled for " + Math.round(quiet / 1000) + "s" +
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

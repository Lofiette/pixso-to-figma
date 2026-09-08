// Local job server. The Figma plugin polls it, pulls one job at a time, and posts the report back.
// Localhost only, and it exists only for the duration of a run.
import { createServer } from "node:http";

export function startJobServer(port = 3778) {
  let pending = null;              // { id, kind, rootNodeId, cleanupRootId, images:[hash] }
  const parts = new Map();         // job id -> report slices still being assembled
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
    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

    if (url.pathname === "/job" && req.method === "GET") {
      if (url.searchParams.get("client") === "plugin") lastPoll = Date.now();
      cors(res, "application/json");
      return res.end(JSON.stringify(pending || { kind: "noop" }));
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
          if (!everSeen && Date.now() - t0w > 45000) {
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

// Local job server. The Figma plugin polls it, pulls one job at a time, and posts the report back.
// Localhost only, and it exists only for the duration of a run.
import { createServer } from "node:http";

export function startJobServer(port = 3778) {
  let pending = null;              // { id, kind, rootNodeId, cleanupRootId, images:[hash] }
  let payload = "";                // payload text for the pending job
  let blobs = new Map();           // hash -> Buffer
  const waiting = new Map();       // id -> { resolve, reject }
  let seq = 0;

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

    if (url.pathname === "/report" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        cors(res, "application/json");
        res.end(JSON.stringify({ ok: true }));
        let msg; try { msg = JSON.parse(body); } catch { return; }
        const w = waiting.get(msg.id);
        if (!w) return;
        waiting.delete(msg.id);
        if (pending && pending.id === msg.id) { pending = null; payload = ""; blobs = new Map(); }
        w.resolve(msg.report);
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
    // Queue one job and resolve when the plugin reports back. One job at a time by construction:
    // the plugin only ever sees the job that is pending right now.
    post(job, payloadText, images = new Map(), timeoutMs = 20 * 60 * 1000) {
      const id = "j" + (++seq);
      pending = { id, kind: job.kind, rootNodeId: job.rootNodeId || null,
                  cleanupRootId: job.cleanupRootId || null, images: [...images.keys()] };
      payload = payloadText;
      blobs = images;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        setTimeout(() => {
          if (waiting.has(id)) {
            waiting.delete(id);
            reject(new Error("no report for job " + id + " within " + Math.round(timeoutMs / 1000) + "s — is the plugin running?"));
          }
        }, timeoutMs).unref?.();
      });
    },
    close() { try { server.close(); } catch {} try { server6.close(); } catch {} },
  };
}

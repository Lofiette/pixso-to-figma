// A fake Pixso MCP server, for the offline tests of the Pixso channel (tools/test-mcp.mjs, extracted
// from it unchanged) and of the M1 image chain and identity check (tools/test-pixrun.mjs).
//
//   import { fakePixso } from "./test/fake-pixso.mjs";
//   const px = fakePixso(); await px.listen();   // px.url is http://127.0.0.1:<port>/mcp
//   ...; await px.close();
//
// It answers MCP's initialize and eval_script the way Pixso does, and can go away (mode "reset"),
// hang, answer 500/503 or a JSON-RPC error, or come back with another file open (outageAfter). Besides
// M0's synthetic scripts (px:identity, px:fake-object, px:script-error) it answers the read-only
// script library of tools/ir/mcp-readonly.mjs from its own synthetic state: px:sample from S.nodes,
// px:image-bytes and px:image-range from S.images, px:render from S.nodes[guid].png, px:audit-render
// from S.nodes[guid].audit(scale) (the render audit's picture and where it sits). Every script it
// receives is kept in S.scripts. Everything is synthetic and nothing leaves 127.0.0.1.
import http from "node:http";

const NL = String.fromCharCode(10);

// The arguments line every library script carries: const ARGS = {...};
function argsOf(src) {
  const m = /^const ARGS = (.*);$/m.exec(src);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// Pixso refuses to parse a script in which a top-level function declaration comes before a statement
// that starts with await, and answers { error: "SyntaxError: expecting ';'" } as an ordinary result
// (measured live 2026-10-06: "function x(){…}" then "await 0;" is refused; the await line first, a
// "const x = function…" expression, or "const y = await …" are not).
function refusedParse(src) {
  const lines = String(src).split(NL);
  const fn = lines.findIndex((l) => /^(async\s+)?function[\s*]/.test(l));
  return fn >= 0 && lines.slice(fn + 1).some((l) => /^await\s/.test(l));
}

// An answer for a script of the M1 library, or null for anything else. served names what was served,
// so outageAfter can take Pixso away after a given image or render.
function libraryAnswer(S, src) {
  const a = argsOf(src);
  if (!a) return null;
  if (src.indexOf("// px:sample") === 0) {
    return { value: a.guids.map((g) => { const n = S.nodes.get(g); return n ? { id: g, type: n.type, name: n.name } : { id: g, missing: true }; }) };
  }
  if (src.indexOf("// px:image-bytes") === 0) {
    const b = S.images.get(a.hash);
    if (!b) return { value: { missing: true }, served: a.hash };
    return { value: b.length <= a.whole ? { n: b.length, d: b.toString("base64") } : { n: b.length }, served: a.hash };
  }
  if (src.indexOf("// px:image-range") === 0) {
    const b = S.images.get(a.hash);
    if (!b) return { value: { missing: true } };
    return { value: { d: b.subarray(a.off, a.off + a.len).toString("base64") }, served: a.hash + "@" + a.off };
  }
  if (src.indexOf("// px:render") === 0) {
    const n = S.nodes.get(a.guid);
    if (!n || !n.png) return { value: { e: "no node" }, served: a.guid };
    return { value: { n: n.png.length, d: n.png.toString("base64"), w: n.width, h: n.height }, served: a.guid };
  }
  if (src.indexOf("// px:audit-render") === 0) {
    const n = S.nodes.get(a.guid);
    if (!n || typeof n.audit !== "function") return { value: { e: "no node" }, served: a.guid };
    return { value: n.audit(a.scale), served: a.guid };
  }
  return null;
}

export function fakePixso() {
  const S = {
    mode: "up",                // up | reset | hang | http500 | http503 | rpcerror
    identity: { file: "Synthetic file A", fileKey: "synthetic-key-a", pageIds: ["0:1", "0:2"] },
    fails: {},                 // object id -> the error its script answers with
    images: new Map(),         // image hash -> the bytes Pixso gives for it (any bytes: a test may plant a bad SHA-1)
    nodes: new Map(),          // guid -> { type, name, width, height, png, audit } for the guid sample and renders
    scripts: [],               // every eval_script source received, in order (the tests check each is read-only)
    served: [],                // object ids answered, one entry per call, in order
    calls: 0,                  // requests received
    resetNext: 0,              // reset this many requests, then answer again
    hung: [],                  // { res, at, closedAt } held open in hang mode
    onServe: null,
    onIdentity: null,          // called after the identity script is answered
    body500: "",
    sockets: new Set(),
  };
  const send = (res, id, result, sse, extra) => {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (sse) {
      res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream" }, extra || {}));
      res.end("event: message" + NL + "data: " + msg + NL + NL);
    } else {
      res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, extra || {}));
      res.end(msg);
    }
  };
  const text = (s) => ({ content: [{ type: "text", text: s }] });
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      S.calls++;
      if (S.resetNext > 0) { S.resetNext--; req.socket.destroy(); return; }
      if (S.mode === "reset") {
        // Back only after enough refusals and enough time since: the outage ends on events, not on a
        // clock that a slow machine could outrun before the breaker has seen anything.
        const cb = S.comeBack;
        if (cb && S.refused >= cb.after && Date.now() - S.refusedEnoughAt >= cb.ms) {
          S.mode = "up";
          if (cb.file) S.identity = cb.file;
          S.comeBack = null;
        } else {
          S.refused++;
          if (cb && S.refused === cb.after) S.refusedEnoughAt = Date.now();
          req.socket.destroy();
          return;
        }
      }
      if (S.mode === "hang") {
        const h = { res, at: Date.now(), closedAt: null };
        req.socket.on("close", () => { h.closedAt = Date.now(); });
        S.hung.push(h);
        return;
      }
      if (S.mode === "http500") { res.writeHead(500, { "Content-Type": "text/plain" }); res.end(S.body500); return; }
      if (S.mode === "http503") { res.writeHead(503, { "Content-Type": "text/plain" }); res.end("synthetic: busy"); return; }
      let msg;
      try { msg = JSON.parse(body); } catch (e) { res.writeHead(400); res.end("not json"); return; }
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      if (msg.method === "initialize") {
        send(res, msg.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-pixso", version: "0" } }, false,
          { "Mcp-Session-Id": "fake-session" });
        return;
      }
      if (S.mode === "rpcerror") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "synthetic failure", data: "d".repeat(3000) + "RPC-END-MARKER" } }));
        return;
      }
      if (msg.method === "tools/call" && msg.params && msg.params.name === "eval_script") {
        const src = String((msg.params.arguments && msg.params.arguments.script) || "");
        S.scripts.push(src);
        if (refusedParse(src)) { send(res, msg.id, text(JSON.stringify({ error: "SyntaxError: expecting ';'" })), true); return; }
        const lib = libraryAnswer(S, src);
        if (lib) {
          send(res, msg.id, text(JSON.stringify(lib.value)), true);
          if (lib.served && S.onServe) S.onServe(lib.served);
          return;
        }
        if (src.indexOf("px:identity") >= 0) {
          send(res, msg.id, text(JSON.stringify(S.identity)), true);
          if (S.onIdentity) S.onIdentity();
          return;
        }
        if (src.indexOf("px:script-error") >= 0) { send(res, msg.id, { content: [{ type: "text", text: "Error: synthetic" }], isError: true }, true); return; }
        const m = /px:fake-object (\S+)/.exec(src);
        if (m) {
          const id = m[1];
          if (S.fails[id]) { send(res, msg.id, text(JSON.stringify({ error: S.fails[id] })), true); return; }
          S.served.push(id);
          send(res, msg.id, text(JSON.stringify({ id, ok: true })), true);
          if (S.onServe) S.onServe(id);
          return;
        }
        send(res, msg.id, text("1"), true);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
    });
  });
  server.on("connection", (s) => { S.sockets.add(s); s.on("close", () => S.sockets.delete(s)); });
  S.listen = () => new Promise((r) => server.listen(0, "127.0.0.1", () => { S.url = "http://127.0.0.1:" + server.address().port + "/mcp"; r(); }));
  S.close = () => new Promise((r) => {
    for (const h of S.hung) { try { h.res.destroy(); } catch (e) {} }
    for (const s of S.sockets) s.destroy();
    server.close(() => r());
  });
  // Once `objectId` has been answered, Pixso goes away (mode "reset" or "hang"). With comeBack
  // { after, ms, file } a reset outage ends on the first request that arrives at least `ms` after
  // the `after`-th refused one — maybe with another file open; without it, it never ends.
  S.outageAfter = (objectId, mode, comeBack) => {
    S.onServe = (id) => {
      if (id !== objectId) return;
      S.onServe = null;
      S.mode = mode;
      S.refused = 0;
      S.refusedEnoughAt = 0;
      S.comeBack = comeBack || null;
    };
  };
  return S;
}


// Minimal MCP Streamable-HTTP client. Usage:
//   node mcp.mjs info
//   node mcp.mjs tools
//   node mcp.mjs call <toolName> '<jsonArgs>'
//   node mcp.mjs script <file.js>
//
// One process per call; the persistent session is the M4 rewrite (docs/REWRITE.md §4). What this
// file promises to everything that calls it:
//
//   - A failed call prints its FULL error text to stderr: the message, the chain of causes, the HTTP
//     status and the whole body. The library run that lost 249 objects kept the last three lines of
//     its output ("stderr: null | } | Node.js v24.19.0") and the real cause was gone for good.
//   - A TRANSPORT failure exits with 75 (EX_TEMPFAIL, named in mcp-codes.mjs), anything else that
//     fails exits with 1. A transport failure means the channel did not carry the call: the
//     connection was refused or reset, the reply did not arrive within MCP_TIMEOUT_MS, or the server
//     said 502/503/504. Pixso answering with an error — a script that threw, a JSON-RPC error, a 4xx
//     or a 500 — is not one: the channel worked. The extraction loop's circuit breaker counts only
//     the first kind, so a script that fails on one object can never make the runner believe Pixso
//     has gone away.
//   - With PX_MCP_HEALTH set, every call appends one JSON line when it starts and one when it ends
//     (ok / transport / error). That is how the extraction loop sees calls made by its grandchildren
//     — px-*.mjs scripts it does not control — without parsing their output.
//   - With PX_MCP_GATE set and that file present, the call is refused at once without touching the
//     network: the breaker is open and the loop is killing the object that was running.
//
// MCP_URL picks the endpoint (default Pixso's 127.0.0.1:3667), MCP_TIMEOUT_MS the deadline of each
// request including its body (default 45 s, the per-request deadline docs/REWRITE.md §4 sets; Pixso
// kills a script at about 15 s, so a call still silent at 45 s is not coming back).
//
// A script, not a module: it runs the moment it is started, from whatever path it is started by
// (through a symlink or a junction too). The exit code the callers need is in mcp-codes.mjs.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { EXIT_TRANSPORT } from "./mcp-codes.mjs";

const ENDPOINT = process.env.MCP_URL || "http://127.0.0.1:3667/mcp";
const TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS) || 45000;
const NL = String.fromCharCode(10);
let sessionId = null;
let nextId = 1;

// kind: "transport" | "http" | "rpc" | "protocol". Only "transport" is the channel's fault.
class McpError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra || {});
  }
}

// fetch() says "fetch failed" and hides the useful part in .cause, sometimes two levels down and
// sometimes as an AggregateError (one attempt per address of "localhost"). Keep every level.
function causeChain(e) {
  const out = [];
  const walk = (c, depth) => {
    if (!c || depth > 6) return;
    const name = c.name && c.name !== "Error" ? c.name + ": " : "";
    const code = c.code ? "[" + c.code + "] " : "";
    out.push(name + code + (c.message || String(c)));
    if (Array.isArray(c.errors)) for (const x of c.errors) walk(x, depth + 1);
    walk(c.cause, depth + 1);
  };
  walk(e, 0);
  return out;
}

function transportError(e, where) {
  const chain = causeChain(e);
  const timedOut = !!e && (e.name === "TimeoutError" || e.name === "AbortError");
  // The deepest cause is the specific one ("connect ECONNREFUSED 127.0.0.1:3667"); the top is not.
  const specific = timedOut ? "no reply within " + TIMEOUT_MS + " ms (timed out)" : chain[chain.length - 1] || "unknown";
  return new McpError("transport", where + ": " + specific, { chain });
}

function parseBody(text, contentType) {
  if ((contentType || "").includes("text/event-stream")) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d && d !== "[DONE]") { try { out.push(JSON.parse(d)); } catch {} }
      }
    }
    return out;
  }
  try { return [JSON.parse(text)]; } catch { return [{ raw: text }]; }
}

async function rpc(method, params, isNotification = false) {
  const body = isNotification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: nextId++, method, params };
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const where = method + (params && params.name ? " " + params.name : "");
  // One deadline for the request and its body: a server that accepts the connection and then sends
  // nothing is exactly what a hung Pixso looks like, and without a deadline the call waits forever.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res, text;
  try { res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal }); }
  catch (e) { throw transportError(e, where); }
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  try { text = await res.text(); }
  catch (e) { throw transportError(e, where + " (reading the reply)"); }
  const gateway = res.status === 502 || res.status === 503 || res.status === 504;
  if (isNotification) {
    if (gateway) throw new McpError("transport", where + ": HTTP " + res.status + " " + res.statusText, { status: res.status, body: text });
    return null;
  }
  const msgs = parseBody(text, res.headers.get("content-type"));
  const reply = msgs.find((m) => m && m.id !== undefined) || null;
  if (!res.ok && !reply) {
    throw new McpError(gateway ? "transport" : "http", where + ": HTTP " + res.status + " " + res.statusText,
      { status: res.status, body: text });
  }
  if (reply && reply.error) {
    const e = reply.error;
    throw new McpError("rpc", where + ": JSON-RPC error " + e.code + ": " + e.message, { status: res.status, rpcError: e, body: text });
  }
  // Used to return undefined here, and the caller then died on "cannot read properties of undefined"
  // with the reply itself thrown away.
  if (!reply || !("result" in reply)) {
    throw new McpError("protocol", where + ": the reply carries no JSON-RPC result", { status: res.status, body: text });
  }
  return reply.result;
}

async function connect() {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: {}, sampling: {} },
    clientInfo: { name: "claude-code-probe", version: "1.0.0" },
  });
  await rpc("notifications/initialized", {}, true);
  return init;
}

// The whole text, nothing shortened: the first line is the headline the loop records as the error,
// the rest is what someone needs to find the cause afterwards.
function describeFailure(e) {
  const kind = (e && e.kind) || "internal";
  const lines = ["mcp " + kind + " failure: " + ((e && e.message) || String(e))];
  lines.push("  endpoint: " + ENDPOINT);
  if (e && e.chain && e.chain.length) lines.push("  cause: " + e.chain.join(" <- "));
  if (e && e.status !== undefined) lines.push("  status: " + e.status);
  if (e && e.rpcError) lines.push("  error: " + JSON.stringify(e.rpcError));
  if (e && e.body !== undefined) lines.push("  body (" + String(e.body).length + " chars):", String(e.body));
  if (kind === "internal" && e && e.stack) lines.push(String(e.stack));
  return lines.join(NL);
}

function health(ev) {
  const file = process.env.PX_MCP_HEALTH;
  if (!file) return;
  try { appendFileSync(file, JSON.stringify(Object.assign({ t: Date.now(), pid: process.pid }, ev)) + NL, "utf8"); }
  catch (e) {}
}

// What the command needs from disk and from its arguments, read before anything touches the network:
// a missing script file or a malformed argument is our mistake, not Pixso's, and must not be counted
// for or against the channel.
function prepare(cmd, rest) {
  if (cmd === "script") return { src: readFileSync(rest[0], "utf8") };
  if (cmd === "call") return { name: rest[0], args: rest[1] ? JSON.parse(rest[1]) : {} };
  return {};
}

async function main(cmd, prep) {
  const init = await connect();
  if (cmd === "info") {
    console.log(JSON.stringify(init, null, 2));
    return init;
  }
  if (cmd === "tools") {
    const r = await rpc("tools/list", {});
    for (const t of r.tools || []) {
      console.log("### " + t.name);
      if (t.description) console.log(t.description.trim().split(NL).slice(0, 6).join(NL));
      console.log("input: " + JSON.stringify(t.inputSchema));
      console.log();
    }
    console.log("TOTAL TOOLS: " + (r.tools || []).length);
    return r;
  }
  if (cmd === "resources") {
    const r = await rpc("resources/list", {});
    console.log(JSON.stringify(r, null, 2));
    return r;
  }
  if (cmd === "call") {
    const r = await rpc("tools/call", { name: prep.name, arguments: prep.args });
    const parts = r.content || [];
    for (const p of parts) {
      if (p.type === "text") console.log(p.text);
      else console.log(`[${p.type}]` + (p.mimeType ? ` ${p.mimeType}` : "") + (p.data ? ` ${p.data.length} b64 chars` : ""));
    }
    if (r.structuredContent) console.log("\n--- structuredContent ---\n" + JSON.stringify(r.structuredContent, null, 2));
    if (r.isError) console.log("\n!! isError: true");
    return r;
  }
  const r = await rpc("tools/call", { name: "eval_script", arguments: { script: prep.src } });
  for (const p of r.content || []) { if (p.type === "text") console.log(p.text); else console.log("[" + p.type + "]"); }
  if (r.isError) console.log("!! isError: true");
  return r;
}

const [, , cmd, ...rest] = process.argv;
const gate = process.env.PX_MCP_GATE;
let prep = null;
if (!["info", "tools", "resources", "call", "script"].includes(cmd)) {
  // Not a call, and not a success either: whoever ran this expected one.
  console.log("commands: info | tools | resources | call <name> [jsonArgs] | script <file.js>");
  process.exitCode = 1;
} else {
  try { prep = prepare(cmd, rest); }
  catch (e) { process.stderr.write("mcp: cannot start the call: " + ((e && e.stack) || e) + NL); process.exitCode = 1; }
}
if (!prep) {
  // usage printed, or a local mistake reported above: no call was made, nothing to record
} else if (gate && existsSync(gate)) {
  health({ ev: "refused", cmd });
  process.stderr.write("mcp transport failure: refused without trying: the circuit breaker is open (" + gate + ")" + NL);
  process.exitCode = EXIT_TRANSPORT;
} else {
  const t0 = Date.now();
  health({ ev: "start", cmd });
  try {
    const r = await main(cmd, prep);
    // isError is Pixso answering that the script failed: the channel worked, the caller decides.
    health({ ev: "ok", cmd, ms: Date.now() - t0, isError: r && r.isError ? true : undefined });
  } catch (e) {
    const transport = !!e && e.kind === "transport";
    const text = describeFailure(e);
    health({ ev: transport ? "transport" : "error", cmd, kind: (e && e.kind) || "internal", ms: Date.now() - t0,
      msg: text.split(NL)[0], text });
    process.stderr.write(text + NL);
    process.exitCode = transport ? EXIT_TRANSPORT : 1;
  }
}

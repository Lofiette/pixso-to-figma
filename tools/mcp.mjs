// Minimal MCP Streamable-HTTP client. Usage:
//   node mcp.mjs tools
//   node mcp.mjs call <toolName> '<jsonArgs>'
const ENDPOINT = process.env.MCP_URL || "http://127.0.0.1:3667/mcp";
let sessionId = null;
let nextId = 1;

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
  const res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (isNotification) return null;
  const text = await res.text();
  const msgs = parseBody(text, res.headers.get("content-type"));
  if (!res.ok && msgs.length === 0) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  const reply = msgs.find((m) => m.id !== undefined) || msgs[0];
  if (reply && reply.error) throw new Error(`${method} -> ${JSON.stringify(reply.error)}`);
  return reply ? reply.result : null;
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

const [, , cmd, ...rest] = process.argv;
const init = await connect();

if (cmd === "info") {
  console.log(JSON.stringify(init, null, 2));
} else if (cmd === "tools") {
  const r = await rpc("tools/list", {});
  for (const t of r.tools || []) {
    console.log("### " + t.name);
    if (t.description) console.log(t.description.trim().split("\n").slice(0, 6).join("\n"));
    console.log("input: " + JSON.stringify(t.inputSchema));
    console.log();
  }
  console.log("TOTAL TOOLS: " + (r.tools || []).length);
} else if (cmd === "resources") {
  console.log(JSON.stringify(await rpc("resources/list", {}), null, 2));
} else if (cmd === "call") {
  const [name, argsJson] = rest;
  const r = await rpc("tools/call", { name, arguments: argsJson ? JSON.parse(argsJson) : {} });
  const parts = r.content || [];
  for (const p of parts) {
    if (p.type === "text") console.log(p.text);
    else console.log(`[${p.type}]` + (p.mimeType ? ` ${p.mimeType}` : "") + (p.data ? ` ${p.data.length} b64 chars` : ""));
  }
  if (r.structuredContent) console.log("\n--- structuredContent ---\n" + JSON.stringify(r.structuredContent, null, 2));
  if (r.isError) console.log("\n!! isError: true");
} else if (cmd === "script") {
  const src = await (await import("node:fs/promises")).readFile(rest[0], "utf8");
  const r = await rpc("tools/call", { name: "eval_script", arguments: { script: src } });
  for (const p of r.content || []) { if (p.type === "text") console.log(p.text); else console.log("["+p.type+"]"); }
  if (r.isError) console.log("!! isError: true");
} else {
  console.log("commands: info | tools | resources | call <name> [jsonArgs] | script <file.js>");
}

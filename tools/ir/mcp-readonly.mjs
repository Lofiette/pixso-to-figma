// Scripts sent to Pixso are read-only by construction (docs/REWRITE.md §6, docs/M1.md §6 D).
//
//   import { SCRIPTS, assertReadOnlyScript, makeMcpClient } from "./ir/mcp-readonly.mjs";
//   const src = SCRIPTS.imageBytes(hash, { whole });        // generated from the fixed library below
//   assertReadOnlyScript(src);                               // throws (code SCRIPT_NOT_READ_ONLY) or returns true
//   const mcp = makeMcpClient({ url, dir, timing, timeoutMs });
//   const r = await mcp.run(src);  // { ok, value, transport, refused, error }; never throws on Pixso's side
//
// Two guarantees:
// 1. Every script comes from SCRIPTS, a fixed library in this file. Its arguments are validated
//    (a hash is 40 lowercase hex, a guid is "a:b", a number is finite) and enter the script only as one
//    JSON line `const ARGS = {...};`. Nothing that arrives over the network becomes script text.
// 2. A static check runs on every script before it is sent, and makeMcpClient refuses to send one that
//    fails it. It is deliberately stricter than JavaScript needs, because the library is ours and can
//    be written to pass it:
//    - comments are whole lines (`//` after code is refused, `/*` is refused, so a regular expression
//      cannot hide code from the lexer), template literals are refused, and a string literal stays on
//      one line and holds none of = ; ( ) { } — so no string can swallow code either;
//    - no assignment to a member (`a.b = …`, `a[b] = …`, compound forms, `++`/`--` on a member), no
//      `delete`, no assignment to a global (pixso, figma, globalThis, window, self);
//    - every method call `.name(` is on the read-only allow-list (MUTATORS are named in the refusal),
//      no computed call `x[y](`, and a bare call is a keyword, a function the script declares, or one
//      of a few pure built-ins; eval, Function, require, import, timers and fetch are refused.
//
// The MCP channel runs under extract-lib's circuit breaker (Breaker, HealthReader): every call is a
// tools/mcp.mjs child process that logs its start and end to a health file; three transport failures
// in a row, or the silence limit, open the breaker and every later run() is refused without a call.
// This is runner code (Node): it never runs in the plugin.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Breaker, HealthReader, IDENTITY_SCRIPT } from "../extract-lib.mjs";
import { EXIT_TRANSPORT } from "../mcp-codes.mjs";
import { assertOutsideRepo } from "./outside-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MCP_SCRIPT = join(HERE, "..", "mcp.mjs");
const NL = String.fromCharCode(10);

// ---------- the static check ----------
export const MUTATORS = ["setPluginData", "setSharedPluginData", "setRelaunchData", "remove", "appendChild", "insertChild",
  "resize", "resizeWithoutConstraints", "rescale", "setRangeFills", "setRangeFontName", "setRangeFontSize",
  "setRangeTextStyleId", "setRangeLineHeight", "setRangeLetterSpacing", "setRangeTextCase", "setRangeTextDecoration",
  "setRangeHyperlink", "setRangeListOptions", "insertCharacters", "deleteCharacters", "detachInstance",
  "swapComponent", "setProperties", "resetOverrides", "createInstance", "clone", "flatten", "group", "ungroup",
  "union", "subtract", "intersect", "exclude", "combineAsVariants", "setVectorNetworkAsync", "setReactionsAsync",
  "setBoundVariable", "setBoundVariableForPaint", "setExplicitVariableModeForCollection", "setCurrentPageAsync",
  "setFillStyleIdAsync", "setStrokeStyleIdAsync", "setTextStyleIdAsync", "setEffectStyleIdAsync", "setGridStyleIdAsync",
  "loadFontAsync", "importComponentByKeyAsync", "importComponentSetByKeyAsync", "importStyleByKeyAsync",
  "createImage", "createRectangle", "createFrame", "createText", "createComponent", "createVector", "createPage",
  "closePlugin", "commitUndo", "triggerUndo", "saveVersionHistoryAsync", "notify", "showUI", "assign", "defineProperty",
  "setPrototypeOf"];
// Every method the library calls, and only read-only ones.
export const READ_METHODS = ["loadAllPagesAsync", "getNodeById", "getNodeByIdAsync", "getImageByHash", "getBytesAsync",
  "getSizeAsync", "exportAsync", "base64Encode", "push", "join", "slice", "subarray", "apply", "fromCharCode",
  "charCodeAt", "indexOf", "min", "max", "floor", "round", "ceil", "abs", "stringify", "toString", "concat", "keys",
  "isArray", "map", "filter", "some", "every", "forEach"];
const KEYWORDS = ["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "new", "of", "in", "do", "else"];
const PURE_CALLS = ["String", "Number", "Boolean", "Array", "Uint8Array", "isFinite", "parseInt"];
const GLOBALS = ["pixso", "figma", "globalThis", "window", "self"];
const REFUSED_CALLS = ["eval", "Function", "require", "import", "setTimeout", "setInterval", "fetch", "XMLHttpRequest"];
const STRING_FORBIDDEN = /[=;(){}]/;

// The script with string contents blanked and comment lines removed, or the problems that stop the
// lexer from being sure what is code.
function lex(src) {
  const problems = [];
  const lines = String(src).split(/\r?\n/);
  const out = [];
  lines.forEach((line, li) => {
    const at = "line " + (li + 1);
    if (/^\s*\/\//.test(line)) { out.push(""); return; }
    let s = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "`") { problems.push(at + ": a template literal (the library uses plain strings)"); return; }
      if (c === "/" && line[i + 1] === "*") { problems.push(at + ": a block comment (comments are whole lines)"); return; }
      if (c === "/" && line[i + 1] === "/") { problems.push(at + ": a comment after code (comments are whole lines)"); return; }
      if (c === "'" || c === "\"") {
        let j = i + 1, body = "";
        while (j < line.length && line[j] !== c) { if (line[j] === "\\") { body += line[j]; j++; } body += line[j]; j++; }
        if (j >= line.length) { problems.push(at + ": a string that does not end on its line"); return; }
        if (STRING_FORBIDDEN.test(body)) { problems.push(at + ": a string holding one of = ; ( ) { }"); return; }
        s += c + "s".repeat(body.length) + c;
        i = j;
        continue;
      }
      s += c;
    }
    out.push(s);
  });
  return { code: out.join(NL), problems };
}

// [] when the script passes, else what is wrong with it (one entry per finding).
export function readOnlyProblems(src) {
  if (typeof src !== "string" || !src.trim()) return ["a script is a non-empty string"];
  const { code, problems } = lex(src);
  if (problems.length) return problems;
  const found = [];
  const declared = new Set([...code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  // Raw text, strings and comments included: a mutating name has no business anywhere in a read script.
  for (const m of String(src).matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (MUTATORS.indexOf(m[1]) >= 0) found.push("calls ." + m[1] + "(), which changes the document");
  }
  for (const m of code.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (REFUSED_CALLS.indexOf(name) >= 0) found.push("calls " + name + "()");
    else if (KEYWORDS.indexOf(name) < 0 && PURE_CALLS.indexOf(name) < 0 && !declared.has(name)) found.push("calls " + name + "(), which is not declared in the script");
  }
  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (READ_METHODS.indexOf(m[1]) < 0 && MUTATORS.indexOf(m[1]) < 0) found.push("calls ." + m[1] + "(), which is not on the read-only list");
  }
  if (/\]\s*\(/.test(code)) found.push("a computed call x[y](…)");
  if (/\bdelete\b/.test(code)) found.push("delete");
  // Assignments: the operator, and what stands to its left.
  const OPS = /(>>>=|<<=|>>=|\*\*=|&&=|\|\|=|\?\?=|[+\-*/%&|^]=|(?<![=!<>])=(?![=>]))/g;
  for (const m of code.matchAll(OPS)) {
    const left = code.slice(0, m.index).replace(/\s+$/, "");
    if (/[\])]$/.test(left) || /\.\s*[A-Za-z_$][\w$]*$/.test(left)) found.push("assigns a member (" + m[1] + ")");
    else {
      const id = /([A-Za-z_$][\w$]*)$/.exec(left);
      if (id && GLOBALS.indexOf(id[1]) >= 0) found.push("assigns the global " + id[1]);
    }
  }
  for (const m of code.matchAll(/(\+\+|--)/g)) {
    const left = code.slice(0, m.index).replace(/\s+$/, "");
    const right = code.slice(m.index + 2);
    if (/[\])]$/.test(left) || /\.\s*[A-Za-z_$][\w$]*$/.test(left) || /^\s*[A-Za-z_$][\w$]*\s*[.[]/.test(right)) found.push("increments or decrements a member (" + m[1] + ")");
  }
  return found;
}

export function assertReadOnlyScript(src) {
  const p = readOnlyProblems(src);
  if (p.length) {
    const e = new Error("refused: the script is not read-only: " + p.slice(0, 6).join("; ") + (p.length > 6 ? " (and " + (p.length - 6) + " more)" : ""));
    e.code = "SCRIPT_NOT_READ_ONLY";
    e.problems = p;
    throw e;
  }
  return true;
}

// ---------- the fixed library ----------
const HASH = /^[0-9a-f]{40}$/;
const GUID = /^\d+:\d+$/;
const need = (ok, what) => { if (!ok) throw new TypeError("script argument: " + what); };
const args = (o) => "const ARGS = " + JSON.stringify(o) + ";";

// Base64 inside Pixso's sandbox: its native base64Encode when it has one (px-images.mjs measured it
// byte-identical), else a hand-rolled encoder written to pass the check (no member assignment).
const B64 = [
  "function b64(u) {",
  "  if (typeof pixso.base64Encode === 'function') return pixso.base64Encode(u);",
  "  const A64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';",
  "  const CODES = [];",
  "  for (let i = 0; i < 64; i += 1) CODES.push(A64.charCodeAt(i));",
  "  const out = [];",
  "  let block = [];",
  "  const n = u.length;",
  "  for (let i = 0; i < n; i += 3) {",
  "    const a = u[i], b = i + 1 < n ? u[i + 1] : -1, c = i + 2 < n ? u[i + 2] : -1;",
  "    block.push(CODES[a >> 2]);",
  "    block.push(CODES[((a & 3) << 4) | ((b < 0 ? 0 : b) >> 4)]);",
  "    block.push(b < 0 ? 61 : CODES[((b & 15) << 2) | ((c < 0 ? 0 : c) >> 6)]);",
  "    block.push(c < 0 ? 61 : CODES[c & 63]);",
  "    if (block.length >= 8192) { out.push(String.fromCharCode.apply(null, block)); block = []; }",
  "  }",
  "  if (block.length) out.push(String.fromCharCode.apply(null, block));",
  "  return out.join('');",
  "}",
].join(NL);

export const SCRIPTS = Object.freeze({
  // Which file is open: extract-lib's identity script, as M0 sends it.
  identity() { return IDENTITY_SCRIPT; },
  // Type and name of each sampled guid (the Q5 check: API ids are the .pix guids).
  sample(guids) {
    need(Array.isArray(guids) && guids.length > 0 && guids.length <= 100 && guids.every((g) => GUID.test(g)), "a list of 1 to 100 guids");
    return ["// px:sample (read-only): type and name of each sampled guid", args({ guids }),
      "await pixso.loadAllPagesAsync();",
      "const out = [];",
      "for (const g of ARGS.guids) {",
      "  const n = pixso.getNodeById(g);",
      "  out.push(n ? { id: g, type: n.type, name: n.name } : { id: g, missing: true });",
      "}",
      "return out;"].join(NL);
  },
  // An image's bytes by hash: whole when at most `whole` bytes, else only its length (then imageRange).
  imageBytes(hash, opts) {
    const whole = (opts && opts.whole) || 11 * 1024 * 1024;
    need(HASH.test(hash), "an image hash is 40 lowercase hex");
    need(Number.isInteger(whole) && whole > 0, "whole is a positive integer");
    return ["// px:image-bytes (read-only): an image's bytes by its hash", args({ hash, whole }), B64,
      "await pixso.loadAllPagesAsync();",
      "const im = pixso.getImageByHash(ARGS.hash);",
      "if (!im) return { missing: true };",
      "const by = await im.getBytesAsync();",
      "if (by.length <= ARGS.whole) return { n: by.length, d: b64(by) };",
      "return { n: by.length };"].join(NL);
  },
  imageRange(hash, off, len) {
    need(HASH.test(hash), "an image hash is 40 lowercase hex");
    need(Number.isInteger(off) && off >= 0 && Number.isInteger(len) && len > 0, "a byte range");
    return ["// px:image-range (read-only): a slice of an image's bytes", args({ hash, off, len }), B64,
      "await pixso.loadAllPagesAsync();",
      "const im = pixso.getImageByHash(ARGS.hash);",
      "if (!im) return { missing: true };",
      "const by = await im.getBytesAsync();",
      "return { d: b64(by.subarray(ARGS.off, ARGS.off + ARGS.len)) };"].join(NL);
  },
  // A PNG render of one node, its longest side at most maxSide (Figma keeps 4 096 at most).
  render(guid, opts) {
    const maxSide = (opts && opts.maxSide) || 4096;
    need(GUID.test(guid), "a guid");
    need(Number.isFinite(maxSide) && maxSide >= 1, "maxSide is a positive number");
    return ["// px:render (read-only): a PNG of the smallest node carrying an image", args({ guid, maxSide }), B64,
      "await pixso.loadAllPagesAsync();",
      "const node = pixso.getNodeById(ARGS.guid);",
      "if (!node) return { e: 'no node' };",
      "const big = Math.max(1, node.width, node.height);",
      "const sc = Math.min(4, ARGS.maxSide / big);",
      "const by = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: sc } });",
      "return { n: by.length, d: b64(by), w: node.width, h: node.height };"].join(NL);
  },
  // The render audit's picture of one node (tools/ir-audit.mjs, docs/M1.md §16): a PNG at the scale
  // the audit gives both engines, with the node's size, type and opacity (Pixso's export leaves its
  // own opacity out, §15.11), its box and, when Pixso has them, the bounds of what it draws.
  auditRender(guid, opts) {
    const scale = opts && opts.scale;
    need(GUID.test(guid), "a guid");
    need(Number.isFinite(scale) && scale >= 0.01 && scale <= 16, "scale is 0.01 to 16");
    return ["// px:audit-render (read-only): a PNG of one node at a scale, with where it sits", args({ guid, scale }), B64,
      "function rect(r) {",
      "  if (!r || typeof r.x !== 'number') return null;",
      "  return { x: r.x, y: r.y, width: r.width, height: r.height };",
      "}",
      "await pixso.loadAllPagesAsync();",
      "const node = pixso.getNodeById(ARGS.guid);",
      "if (!node) return { e: 'no node' };",
      "let box = null;",
      "let drawn = null;",
      "try { box = rect(node.absoluteBoundingBox); } catch (e1) { box = null; }",
      "try { drawn = rect(node.absoluteRenderBounds); } catch (e2) { drawn = null; }",
      "const by = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: ARGS.scale } });",
      "return { w: node.width, h: node.height, type: node.type, opacity: typeof node.opacity === 'number' ? node.opacity : null, box: box, render: drawn, n: by.length, d: b64(by) };"].join(NL);
  },
});

// ---------- the channel ----------
// makeMcpClient({ url, dir, timing, timeoutMs, env }) -> { run(src), tripped(), breaker, calls }
//   url        the MCP endpoint (MCP_URL for mcp.mjs; mcp.mjs's own default when absent)
//   dir        a scratch folder outside the repository for the script files and the health log
//   timing     Breaker timing (transportTrip, silenceMs), extract-lib's TIMING by default
//   timeoutMs  the deadline of one call (MCP_TIMEOUT_MS), 45 s by default
// run(src) -> Promise<{ ok, value, transport, refused, error }>
//   ok         Pixso answered and the answer parsed as JSON (value)
//   transport  the channel did not carry the call (mcp.mjs exit 75)
//   refused    not sent: the breaker is open, or the script failed the static check
export function makeMcpClient(opts) {
  const o = opts || {};
  if (!o.dir) throw new TypeError("makeMcpClient: dir (a scratch folder outside the repository) is required");
  const dir = assertOutsideRepo(o.dir);
  mkdirSync(dir, { recursive: true });
  const healthFile = join(dir, "mcp-health.log");
  writeFileSync(healthFile, "", "utf8");
  const health = new HealthReader(healthFile);
  health.skipToEnd();
  const breaker = new Breaker(o.timing || {});
  let trip = null, seq = 0;
  const client = {
    breaker,
    calls: 0,
    tripped: () => trip,
    async run(src) {
      if (trip) return { ok: false, refused: true, transport: false, error: "not sent: the Pixso circuit breaker is open (" + trip.detail + ")" };
      try { assertReadOnlyScript(src); }
      catch (e) { return { ok: false, refused: true, transport: false, error: e.message }; }
      const file = join(dir, "script-" + String(++seq).padStart(4, "0") + ".js");
      writeFileSync(file, src, "utf8");
      client.calls++;
      const env = Object.assign({}, process.env, o.env || {}, { PX_MCP_HEALTH: healthFile });
      delete env.PX_MCP_GATE;
      if (o.url) env.MCP_URL = o.url;
      if (o.timeoutMs) env.MCP_TIMEOUT_MS = String(o.timeoutMs);
      const r = await new Promise((resolve) => {
        const p = spawn(process.execPath, [MCP_SCRIPT, "script", file], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const out = [], err = [];
        p.stdout.on("data", (d) => out.push(d));
        p.stderr.on("data", (d) => err.push(d));
        p.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
        p.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String((e && e.message) || e) }));
      });
      for (const ev of health.read()) breaker.observe(ev);
      breaker.settle();
      const t = breaker.check(Date.now());
      if (t) trip = t;
      if (r.code === EXIT_TRANSPORT) return { ok: false, transport: true, refused: false, error: r.stderr.trim().split(NL)[0] || "transport failure" };
      if (r.code !== 0) return { ok: false, transport: false, refused: false, error: (r.stderr.trim() || "exit " + r.code).split(NL)[0] };
      const text = r.stdout.trim();
      if (/!! isError: true\s*$/.test(text)) return { ok: false, transport: false, refused: false, error: "the script failed in Pixso: " + text.split(NL)[0].slice(0, 300) };
      try { return { ok: true, value: JSON.parse(text), transport: false, refused: false, error: null }; }
      catch (e) {
        try { return { ok: true, value: JSON.parse(text.split(NL)[0]), transport: false, refused: false, error: null }; }
        catch (e2) { return { ok: false, transport: false, refused: false, error: "Pixso's answer is not JSON: " + text.slice(0, 200) }; }
      }
    },
  };
  return client;
}

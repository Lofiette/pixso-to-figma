// Write the Figma plugin Figma actually runs: figma-plugin/dist/code.js and figma-plugin/dist/ui.html.
//
//   node build-plugin.mjs --out <dir> [--token <64 hex>]
//   node build-plugin.mjs --out figma-plugin/dist --force      (only with no runner alive; see below)
//
// No dependencies and no bundler: the plugin is three sources pasted together in a fixed order.
//
//   dist/code.js  = the builder (tools/builder4.js BUILDER_SRC) as an ordinary async function, PXF_BUILD
//                 + the verifier (VERIFIER_SRC) the same way, PXF_VERIFY
//                 + figma-plugin/src/code.js, the host, inside its own function scope
//   dist/ui.html  = figma-plugin/src/ui.html with this run's key written in, or none, and the build id
//
// The builder and the verifier used to travel inside every job payload as text and be compiled in
// Figma from that text. Now they are part of the plugin, compiled once when Figma loads it, and a
// payload is data only. That is also why this runs on every start of the runner (tools/session.mjs):
// a change to builder4.js reaches Figma the next time the plugin is opened, not through a repack.
//
// "The next time the plugin is opened" is the catch. A window that was already open keeps the code it
// was opened with, whatever is written here afterwards. So both files carry the same build id, a hash
// of all four sources: the window sends it with every request, and the runner refuses a window whose
// id is not the one it just wrote (409, tools/jobserver.mjs) — such a window is told to close and
// reopen, rather than being paired and quietly building with yesterday's builder.
//
// The key goes into ui.html because a web page cannot read a file on this disk, so a request that
// carries it can only have come from this plugin's window (tools/jobserver.mjs). dist/ is generated
// and must never be committed: it holds the key of the last run. For the same reason the command line
// will not write figma-plugin/dist unasked: a live runner's key is in there, and replacing it would
// make that runner's next plugin window ask for the code.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILDER_SRC, VERIFIER_SRC } from "./builder4.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = join(HERE, "..", "figma-plugin");
export const DIST_DIR = join(PLUGIN_DIR, "dist");
const TOKEN_SLOT = '"__PXF_TOKEN__"';
const VERSION_SLOT = '"__PXF_VERSION__"';
const NL = String.fromCharCode(10);

// What may never appear in dist/, checked here so that a generated plugin that breaks the rule is
// never written, and again by tools/test-plugin.mjs over what was written. Coarse on purpose: a
// harmless identifier that happens to end in "Function(" fails it too, and is renamed.
export const FORBIDDEN = [
  [/\beval\s*\(/, "eval("],
  [/Function\s*\(/, "Function("],
  [/AsyncFunction/, "the async-function constructor"],
  [/getPrototypeOf\s*\(\s*async\b/, "the async-function constructor"],
  [/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, "a timer given a string to compile"],
];
export function forbiddenIn(text) {
  const hits = [];
  for (const [re, what] of FORBIDDEN) if (re.test(text)) hits.push(what);
  return hits;
}

const lineCount = (s) => s.split(NL).length - 1;
// The line of builder4.js on which a template-literal source begins, so a compile error can name the
// line a person would open; 1 (the string's own first line) when the source was given in `sources`.
function fileLine(given, marker) {
  if (given !== undefined) return 1;
  try {
    const t = readFileSync(join(HERE, "builder4.js"), "utf8");
    const at = t.indexOf(marker);
    return at < 0 ? 1 : lineCount(t.slice(0, at)) + 1;
  } catch (e) { return 1; }
}

// Compile, never run, in Node. A syntax error in the builder used to be caught by pack4 before it went
// anywhere; now the builder is part of the plugin, and Figma's only answer to a plugin that does not
// compile is a plugin that does not start. So the generator compiles what it is about to write and
// says where the mistake is, in the source a person edits — before the old dist/ is touched.
// `parts` maps the generated text back: [first line in the generated text, source name, its first line].
function compileOrThrow(text, name, parts) {
  try { new Script(text, { filename: name }); return; }
  catch (e) {
    // V8 puts "<filename>:<line>" on the first line of a syntax error's stack.
    const first = String((e && e.stack) || "").split(NL)[0];
    const m = /:(\d+)\s*$/.exec(first);
    const at = m ? Number(m[1]) : 0;
    let where = name + (at ? " line " + at : "");
    for (const [from, src, srcLine] of parts) if (at && at >= from) where = src + " line " + (at - from + srcLine);
    throw new Error("build-plugin: " + name + " does not compile — " + ((e && e.message) || e) + " (" + where + ")");
  }
}

// `sources` replaces any of the four inputs; the tests use it to make a plugin from other sources (a
// window opened before an edit) and a builder with a mistake in it. Nothing else should need it.
export function generatePlugin({ token = "", sources = {} } = {}) {
  if (token && !/^[0-9a-f]{64}$/.test(token)) throw new Error("build-plugin: the token must be 64 lowercase hex characters");
  const builder = sources.builder !== undefined ? sources.builder : BUILDER_SRC;
  const verifier = sources.verifier !== undefined ? sources.verifier : VERIFIER_SRC;
  const host = sources.host !== undefined ? sources.host : readFileSync(join(PLUGIN_DIR, "src", "code.js"), "utf8");
  const uiSrc = sources.ui !== undefined ? sources.ui : readFileSync(join(PLUGIN_DIR, "src", "ui.html"), "utf8");

  // Names the plugin build in its own log, in every report, and in every request the window makes, so
  // the runner can tell a window that runs what it wrote from one that runs something older. A hash
  // of the inputs, not a time: the same sources give the same build.
  const version = createHash("sha256").update(builder).update(NL).update(verifier).update(NL)
    .update(host).update(NL).update(uiSrc).digest("hex").slice(0, 12);

  const head = [
    "// GENERATED by tools/build-plugin.mjs from tools/builder4.js and figma-plugin/src/code.js. Do not edit:",
    "// it is rewritten every time the runner starts. Edit the sources.",
    "var PXF_VERSION = " + JSON.stringify(version) + ";",
    "",
    "// ---- tools/builder4.js BUILDER_SRC ----",
    "async function PXF_BUILD(figma, PAY) {",
    "let RESULT = null;",
    "",
  ].join(NL);
  const mid1 = [
    "", "return RESULT;", "}", "",
    "// ---- tools/builder4.js VERIFIER_SRC ----",
    "async function PXF_VERIFY(figma, PAY, ROOT_NODE_ID) {",
    "let RESULT = null;",
    "",
  ].join(NL);
  const mid2 = ["", "return RESULT;", "}", "", "// ---- figma-plugin/src/code.js ----", "(function () {", ""].join(NL);
  const tail = ["", "})();", ""].join(NL);
  const code = head + builder + mid1 + verifier + mid2 + host + tail;
  // Where each source starts in the generated file, for the compile error's line number.
  const bAt = lineCount(head) + 1, vAt = bAt + lineCount(builder + mid1), hAt = vAt + lineCount(verifier + mid2);

  for (const [slot, what] of [[TOKEN_SLOT, "key"], [VERSION_SLOT, "build id"]]) {
    const n = uiSrc.split(slot).length - 1;
    if (n !== 1) throw new Error("build-plugin: src/ui.html must hold exactly one " + slot + " (the " + what + "), found " + n);
  }
  const UI_HEAD = "<!-- GENERATED by tools/build-plugin.mjs from figma-plugin/src/ui.html. Do not edit, do not commit. -->" + NL;
  const ui = UI_HEAD + uiSrc.replace(TOKEN_SLOT, JSON.stringify(token)).replace(VERSION_SLOT, JSON.stringify(version));

  for (const [name, text] of [["dist/code.js", code], ["dist/ui.html", ui]]) {
    const hits = forbiddenIn(text);
    if (hits.length) throw new Error("build-plugin: " + name + " would contain " + hits.join(", ") + " — no code may be compiled from strings");
  }
  compileOrThrow(code, "dist/code.js", [
    [bAt, "tools/builder4.js (BUILDER_SRC)", fileLine(sources.builder, "export const BUILDER_SRC = ")],
    [vAt, "tools/builder4.js (VERIFIER_SRC)", fileLine(sources.verifier, "export const VERIFIER_SRC = ")],
    [hAt, "figma-plugin/src/code.js", 1]]);
  const a = ui.indexOf("<script>"), b = ui.lastIndexOf("</script>");
  if (a < 0 || b < a) throw new Error("build-plugin: src/ui.html has no <script> block");
  // The script's first line is the <script> line itself; the generated header is one line more.
  compileOrThrow(ui.slice(a + 8, b), "dist/ui.html <script>",
    [[1, "figma-plugin/src/ui.html", lineCount(ui.slice(0, a)) + 1 - lineCount(UI_HEAD)]]);
  return { code, ui, version };
}

// Writes both files and returns what it wrote, so a caller that has to undo it (another runner already
// holds the port) can put the previous files back. Nothing is written unless both generate and compile.
export function buildPlugin({ outDir = DIST_DIR, token = "", sources } = {}) {
  const g = generatePlugin({ token, sources });
  mkdirSync(outDir, { recursive: true });
  const codePath = join(outDir, "code.js"), uiPath = join(outDir, "ui.html");
  writeFileSync(codePath, g.code, "utf8");
  writeFileSync(uiPath, g.ui, "utf8");
  return { codePath, uiPath, version: g.version, tokenWritten: !!token };
}

// Compared by real path: through a symlink or a directory junction argv[1] and import.meta.url differ,
// and a plain comparison wrote nothing and exited 0 (the trap tools/mcp-codes.mjs records).
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const out = flag("--out") ? resolve(flag("--out")) : null;
  if (!out) {
    console.error("usage: node build-plugin.mjs --out <dir> [--token <64 hex>]" + NL +
      "The runner writes figma-plugin/dist itself every time it starts; this is for looking at what it writes.");
    process.exit(2);
  }
  if (out === resolve(DIST_DIR) && argv.indexOf("--force") < 0) {
    console.error("refused: figma-plugin/dist holds the key of the runner that last started, and replacing it would" + NL +
      "make that runner's next plugin window ask for the code. The runner rewrites it on every start anyway." + NL +
      "If no runner is running and you mean it, add --force.");
    process.exit(2);
  }
  const token = flag("--token") || "";
  const b = buildPlugin({ outDir: out, token });
  console.log("plugin build " + b.version + " -> " + out + (token ? " (with a key)" : " (no key: the window will ask for the runner's code)"));
}

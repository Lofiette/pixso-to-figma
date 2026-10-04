// Nothing real enters this public repository (docs/REWRITE.md §8), and this is the check that says so.
//
//   node tools/test-hygiene.mjs
//
// It fails when a tracked file
//   - is a private artefact: the generated plugin (it carries a per-run token) or a kit map (it names
//     real components and keys);
//   - is larger than 2 MB, which no source file here is and every real design file is;
//   - sits under tools/ or docs/ and contains something shaped like a real key: a 22-character
//     Pixso or Figma file key, or 40 or 64 hex digits (a componentKey, an image's SHA-1, a file's
//     SHA-256).
// Synthetic values used by the docs and tests are allowed by exact value below. Anything else is
// reported with its file and line, masked, so the report does not repeat the key it found.
//
// It reads the working tree, so it catches a key before it is committed rather than after.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };

const MAX_BYTES = 2 * 1024 * 1024;
const SCANNED = ["tools/", "docs/"];
const PRIVATE = [
  { test: (p) => p.startsWith("figma-plugin/dist/"), what: "the generated plugin, which carries a per-run token" },
  { test: (p) => p.toLowerCase().endsWith(".kitmap.json"), what: "a kit map, which names real components and keys" },
];
// Paths .gitignore must ignore, one per private pattern, so the guard cannot quietly disappear.
const MUST_IGNORE = ["figma-plugin/dist/ui.html", "figma-plugin/dist/code.js", "lib.kitmap.json", "maps/kit.kitmap.json"];

// The synthetic values docs/IR.md and the tests use. Exact values only: a pattern here would let a
// real key through the moment it happened to match.
const SYNTHETIC = new Set([
  "SyntheticFileKey000001",
  "SyntheticLibKey0000002",
  "0".repeat(62) + "a1",
  "c0ffee" + "0".repeat(33) + "1",
  "c0ffee" + "0".repeat(33) + "2",
  "c0ffee" + "0".repeat(33) + "3",
  "da7a" + "0".repeat(35) + "1",
]);

// A 22-character run of letters and digits, not part of a longer identifier. Ordinary camelCase
// identifiers are 22 characters often enough (createBooleanOperation), so a run counts as a key
// only if it mixes cases and has a digit or at least six capitals; a random base-62 key fails that
// about once in five thousand.
const KEY22 = /(?<![A-Za-z0-9_$])[A-Za-z0-9]{22}(?![A-Za-z0-9_$])/g;
const HEX = /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9A-Za-z])/g;
const looksLikeKey = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && (/[0-9]/.test(s) || (s.match(/[A-Z]/g) || []).length >= 6);
const mask = (s) => s.slice(0, 4) + "... (" + s.length + " chars)";

function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(KEY22)) if (looksLikeKey(m[0]) && !SYNTHETIC.has(m[0])) hits.push({ line: i + 1, kind: "a 22-character file key", value: m[0] });
    for (const m of line.matchAll(HEX)) if (!SYNTHETIC.has(m[0].toLowerCase())) hits.push({ line: i + 1, kind: m[0].length + " hex digits", value: m[0] });
  });
  return hits;
}

// ---------- the detector itself, on planted values that appear nowhere in this file ----------
{
  const key = "aB3".repeat(7) + "Q";
  const hex = "0123456789abcdef".repeat(3).slice(0, 40);
  const text = ["const k = \"" + key + "\";", "hash: " + hex, "figma.createBooleanOperation(", "SyntheticLibKey0000002", "x".repeat(40)].join("\n");
  const hits = scanText(text);
  if (hits.length === 2 && hits[0].line === 1 && hits[1].line === 2) ok("the detector finds a planted key and a planted hash, and passes an identifier and an allowed value");
  else fail("the detector is wrong on planted values: " + JSON.stringify(hits.map((h) => [h.line, h.kind])));
}

// ---------- the repository ----------
const git = (args, input) => execFileSync("git", ["-C", ROOT].concat(args), { input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
let tracked = null;
try {
  if (String(git(["rev-parse", "--is-inside-work-tree"])).trim() === "true") {
    tracked = String(git(["ls-files", "-s", "-z"])).split("\0").filter(Boolean).map((row) => {
      const tab = row.indexOf("\t");
      const [mode, blob] = row.slice(0, tab).split(" ");
      return { mode, blob, path: row.slice(tab + 1) };
    });
  }
} catch (e) { /* not a git checkout */ }

if (!tracked) {
  console.log("skip the repository checks: not a git work tree (a downloaded copy has nothing tracked to leak)");
} else {
  // 1. private artefacts, and the .gitignore lines that keep them out
  const priv = [];
  for (const t of tracked) for (const p of PRIVATE) if (p.test(t.path)) priv.push(t.path + ": " + p.what);
  if (priv.length) priv.forEach((m) => fail("tracked private artefact " + m));
  else ok("no tracked file is a generated plugin or a kit map (" + tracked.length + " files)");
  const notIgnored = MUST_IGNORE.filter((p) => {
    try { git(["check-ignore", "--no-index", "-q", p]); return false; } catch (e) { return true; }
  });
  if (notIgnored.length) fail(".gitignore does not ignore " + notIgnored.join(", "));
  else ok(".gitignore keeps out the generated plugin and kit maps");

  // 2. size: the committed blob and the working copy, whichever is larger
  const blobs = tracked.filter((t) => t.mode !== "160000");
  const sizes = String(git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], blobs.map((t) => t.blob).join("\n") + "\n"))
    .trim().split("\n").map((l) => Number(l.split(" ")[1]));
  const big = [];
  blobs.forEach((t, i) => {
    let size = sizes[i] || 0;
    try { const st = statSync(join(ROOT, t.path)); if (st.isFile()) size = Math.max(size, st.size); } catch (e) { /* deleted in the working tree */ }
    if (size > MAX_BYTES) big.push(t.path + " (" + (size / 1048576).toFixed(1) + " MB)");
  });
  if (big.length) big.forEach((m) => fail("tracked file over 2 MB: " + m));
  else ok("no tracked file is over 2 MB");

  // 3. key-shaped strings under tools/ and docs/
  let scanned = 0;
  const found = [];
  for (const t of tracked) {
    if (!SCANNED.some((d) => t.path.startsWith(d)) || t.mode === "120000" || t.mode === "160000") continue;
    const file = join(ROOT, t.path);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    scanned++;
    for (const h of scanText(buf.toString("utf8"))) found.push(t.path + ":" + h.line + ": " + h.kind + " " + mask(h.value));
  }
  if (found.length) found.forEach((m) => fail("key-shaped value in " + m + " (synthetic values go in SYNTHETIC in tools/test-hygiene.mjs)"));
  else ok("no key-shaped value in the " + scanned + " text files under " + SCANNED.join(" and "));
}

console.log("");
console.log(failed ? failed + " hygiene check" + (failed === 1 ? "" : "s") + " FAILED" : "all hygiene checks pass");
process.exit(failed ? 1 : 0);

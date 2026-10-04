// Nothing real enters this public repository (docs/REWRITE.md §8), and this is the check that says so.
//
//   node tools/test-hygiene.mjs
//
// It fails when a tracked file
//   - is a private artefact: the generated plugin (it carries a per-run token), a kit map (it names
//     real components and keys) or a .pix design file;
//   - is larger than 2 MB, which no source file here is;
//   - has a path, or text, holding something shaped like a real key: a 22-character Pixso or Figma
//     file key, or 40 or 64 hex digits (a componentKey, an image's SHA-1, a file's SHA-256). Every
//     tracked path is checked, binary files and links included, and the text of every tracked text
//     file wherever it sits: the README and the project log are as public as tools/ and docs/.
// Names cannot be told by their shape, so a real file's or a product's name is not caught here.
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
const PRIVATE = [
  { test: (p) => p.startsWith("figma-plugin/dist/"), what: "the generated plugin, which carries a per-run token" },
  { test: (p) => p.toLowerCase().endsWith(".kitmap.json"), what: "a kit map, which names real components and keys" },
  // The size limit is no guard here: a vector-only file of a few thousand nodes compresses to well
  // under 2 MB.
  { test: (p) => p.toLowerCase().endsWith(".pix"), what: "a .pix design file (the synthetic fixture is made in memory and never committed)" },
];
// Paths .gitignore must ignore, one per private pattern, so the guard cannot quietly disappear.
const MUST_IGNORE = ["figma-plugin/dist/ui.html", "figma-plugin/dist/code.js", "lib.kitmap.json", "maps/kit.kitmap.json", "x.pix"];

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
  // The componentKey of the synthetic .pix fixture in tools/pix/fixture.mjs (branch claude/m0-pix),
  // listed ahead of that merge so the merged tree passes without a change here.
  "0f1e2d3c4b5a6978" + "8796a5b4c3d2e1f0" + "0f1e2d3c",
]);

// A 22-character file key. Figma's keys are base 62. Pixso's are most likely base64 of 16 bytes:
// the one real Pixso key on record has that encoding's length and its last-character signature
// (16 bytes leave the 22nd character only A, Q, g or w). Base64url keys hold - and _, plain base64
// keys + and /, so about half of all keys are not runs of letters and digits.
//
// A candidate is any 22 characters of [A-Za-z0-9_+/-] with no letter, digit or $ on either side.
// - _ + / may touch it, so file_<key>, key-<key>-v2, .../design/<key>?page=1 and <key>== are all
// seen; candidates overlap (a lookahead), so a key is found even when it is glued to its
// neighbours with the characters it is made of.
//
// Ordinary identifiers are 22 characters often enough (createBooleanOperation), so a candidate
// counts as a key only if it mixes cases and has a digit or at least six capitals. One that holds
// + or / must also end in A, Q, g or w, because paths are full of slashes.
//
// Measured on 200,000 random 16-byte keys per encoding, each in five contexts (quoted, glued with
// _, in a URL path, glued with -, followed by ==): a base-62 key is missed about once in 7,000,
// a base64 or base64url key about once in 2,500. The misses are the keys with no digit and fewer
// than six capitals. Widening the alphabet added no hit on the tracked files.
const KEY22 = /(?<![A-Za-z0-9$])(?=([A-Za-z0-9_+/-]{22})(?![A-Za-z0-9$]))/g;
const HEX = /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9A-Za-z])/g;
const looksLikeKey = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && (/[0-9]/.test(s) || (s.match(/[A-Z]/g) || []).length >= 6) &&
  (!/[+/]/.test(s) || /[AQgw]$/.test(s));
const mask = (s) => s.slice(0, 4) + "... (" + s.length + " chars)";

function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    let end = -1; // overlapping candidates: report a key once, not once per window inside it
    for (const m of line.matchAll(KEY22)) {
      const s = m[1];
      if (m.index < end || !looksLikeKey(s) || SYNTHETIC.has(s)) continue;
      hits.push({ line: i + 1, kind: "a 22-character file key", value: s });
      end = m.index + s.length;
    }
    for (const m of line.matchAll(HEX)) if (!SYNTHETIC.has(m[0].toLowerCase())) hits.push({ line: i + 1, kind: m[0].length + " hex digits", value: m[0] });
  });
  return hits;
}

// ---------- the detector itself, on planted values that appear nowhere in this file ----------
{
  const alnum = "aB3".repeat(7) + "Q";
  const planted = [
    ["const k = \"" + alnum + "\";", true],                                       // base 62, quoted
    ["hash: " + "0123456789abcdef".repeat(3).slice(0, 40), true],                // 40 hex
    ["figma.createBooleanOperation(", false],                                    // an identifier
    ["SyntheticLibKey0000002", false],                                           // an allowed value
    ["x".repeat(40), false],
    ["Source file: `" + "aB3-".repeat(5) + "xQ`", true],                         // base64url, holds -
    ["export_" + alnum + ".pix", true],                                          // glued with _
    ["file_" + "aB_3".repeat(5) + "Zw", true],                                   // base64url glued with _
    ["https://example.invalid/app/design/" + "aB3/".repeat(5) + "xQ?page=1", true], // base64, holds /
    ["Lib2/Button/Primary/Sm", false],                                           // a path: + or / and no A Q g w end
    ["figma-plugin/dist/code.js", false],                                        // a path with no capital
  ];
  const hits = scanText(planted.map((p) => p[0]).join("\n"));
  const want = planted.map((p, i) => (p[1] ? i + 1 : 0)).filter(Boolean);
  const got = hits.map((h) => h.line);
  if (JSON.stringify(got) === JSON.stringify(want)) ok("the detector finds " + want.length + " planted keys and hashes (base 62, base64url, base64, glued with _ and -) and passes identifiers, paths and an allowed value");
  else fail("the detector is wrong on planted values: wanted lines " + want.join(",") + ", got " + JSON.stringify(hits.map((h) => [h.line, h.kind])));
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
  else ok("no tracked file is a generated plugin, a kit map or a .pix (" + tracked.length + " files)");
  const notIgnored = MUST_IGNORE.filter((p) => {
    try { git(["check-ignore", "--no-index", "-q", p]); return false; } catch (e) { return true; }
  });
  if (notIgnored.length) fail(".gitignore does not ignore " + notIgnored.join(", "));
  else ok(".gitignore keeps out the generated plugin, kit maps and .pix files");

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

  // 3. key-shaped strings in every tracked path and every tracked text file. It looked only inside
  //    tools/ and docs/, so a key pasted into the README or the project log passed, and so did an
  //    image named by its SHA-1. The path is checked first, before anything is skipped, and is
  //    reported with the key masked, like the text.
  let scanned = 0;
  const found = [];
  for (const t of tracked) {
    for (const h of scanText(t.path)) found.push(t.path.split(h.value).join(mask(h.value)) + " (its path): " + h.kind + " " + mask(h.value));
    if (t.mode === "120000" || t.mode === "160000") continue;
    const file = join(ROOT, t.path);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    scanned++;
    for (const h of scanText(buf.toString("utf8"))) found.push(t.path + ":" + h.line + ": " + h.kind + " " + mask(h.value));
  }
  if (found.length) found.forEach((m) => fail("key-shaped value in " + m + " (synthetic values go in SYNTHETIC in tools/test-hygiene.mjs)"));
  else ok("no key-shaped value in the " + tracked.length + " tracked paths or the " + scanned + " tracked text files");
}

console.log("");
console.log(failed ? failed + " hygiene check" + (failed === 1 ? "" : "s") + " FAILED" : "all hygiene checks pass");
process.exit(failed ? 1 : 0);

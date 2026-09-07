// Pull the bytes behind every image fill out of Pixso and write them to disk, ready to upload to
// Figma. Image hashes are content-addressed in both tools (the hash IS the SHA-1 of the bytes,
// verified), so once the same bytes are uploaded the hash the IR already carries resolves in Figma
// with no rewriting.
//
//   node px-images.mjs <ir.json> <rootId> <outDir>
//
// Two things this has to handle:
//  - Binary cannot come back through the MCP as a raw string (it gets mangled), so the sandbox
//    base64-encodes it with a hand-rolled encoder -- btoa and Buffer do not exist there -- and a
//    large image is fetched in byte ranges, because one big response comes back empty.
//  - Some hashes do not resolve at all: getImageByHash returns null for images that belong to a
//    remote library, so Pixso never materialised the bytes locally. For those the renderer is the
//    only source: the smallest node carrying the fill is exported as PNG and recorded as a
//    substitute, to be uploaded and remapped onto the hash after the fact.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , IR, ROOT_ID, OUTDIR = "../out/img"] = process.argv;
if (!IR || !ROOT_ID) { console.error("usage: node px-images.mjs <ir.json> <rootId> <outDir>"); process.exit(1); }
const ir = JSON.parse(readFileSync(IR, "utf8"));
const hashes = ir.imageHashes || [];
console.log("image hashes: " + hashes.length);
mkdirSync(OUTDIR, { recursive: true });

// Encoding, not transport, is what made this slow. Building the string three bytes at a time
// cost 34 microseconds per byte in Pixso's sandbox — five minutes for a 9 MB image. Pushing
// character codes into an array and handing blocks to String.fromCharCode.apply is 2.4x faster,
// and an 800 000-character response arrives intact, so the chunks can be far larger too.
const B64 = [
  "const A64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';",
  "const CODES = []; for (let i = 0; i < 64; i++) CODES.push(A64.charCodeAt(i));",
  "function b64(u) {",
  "  const out = [], block = []; const n = u.length;",
  "  for (let i = 0; i < n; i += 3) {",
  "    const a = u[i], b = i + 1 < n ? u[i+1] : undefined, c = i + 2 < n ? u[i+2] : undefined;",
  "    block.push(CODES[a >> 2]);",
  "    block.push(CODES[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)]);",
  "    block.push(b === undefined ? 61 : CODES[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)]);",
  "    block.push(c === undefined ? 61 : CODES[c & 63]);",
  "    if (block.length >= 8192) { out.push(String.fromCharCode.apply(null, block)); block.length = 0; }",
  "  }",
  "  if (block.length) out.push(String.fromCharCode.apply(null, block));",
  "  return out.join('');",
  "}"].join("\n");

function run(src) {
  writeFileSync("_img.js", src, "utf8");
  try { return JSON.parse(execFileSync("node", ["mcp.mjs", "script", "_img.js"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim()); }
  catch (e) { return { __err: String(e.message).slice(0, 200) }; }
}

function extOf(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "webp";
  return "bin";
}

const CHUNK = Number(process.env.PX_IMG_CHUNK || 600000);
const manifest = [];
const unresolved = [];
let ok = 0;

for (const h of hashes) {
  const probe = run([
    "await pixso.loadAllPagesAsync();",
    "const im = pixso.getImageByHash(" + JSON.stringify(h) + ");",
    "if (!im) return { missing: true };",
    "const by = await im.getBytesAsync();",
    "return { n: by.length };"
  ].join("\n"));
  if (probe.__err) { console.log("  FAIL " + h.slice(0, 8) + ": " + probe.__err); unresolved.push(h); continue; }
  if (probe.missing) { console.log("  unresolved " + h.slice(0, 8) + " (remote library, no local bytes)"); unresolved.push(h); continue; }

  const total = probe.n;
  const parts = [];
  let bad = false;
  for (let off = 0; off < total; off += CHUNK) {
    const len = Math.min(CHUNK, total - off);
    const r = run([
      "await pixso.loadAllPagesAsync();", B64,
      "const im = pixso.getImageByHash(" + JSON.stringify(h) + ");",
      "const by = await im.getBytesAsync();",
      "return { d: b64(by.subarray(" + off + ", " + (off + len) + ")) };"
    ].join("\n"));
    if (r.__err || !r.d) { console.log("  FAIL " + h.slice(0, 8) + " at byte " + off + ": " + (r.__err || "no data")); bad = true; break; }
    parts.push(Buffer.from(r.d, "base64"));
  }
  if (bad) { unresolved.push(h); continue; }
  const buf = Buffer.concat(parts);
  if (buf.length !== total) { console.log("  FAIL " + h.slice(0, 8) + ": got " + buf.length + " of " + total); unresolved.push(h); continue; }
  const ext = extOf(buf);
  const file = OUTDIR + "/" + h + "." + ext;
  writeFileSync(file, buf);
  manifest.push({ hash: h, file: file, bytes: buf.length, ext: ext, source: "bytes" });
  ok++;
  process.stdout.write("\r  " + ok + " fetched  ");
}
console.log("");

// Render fallback for hashes with no local bytes.
for (const h of unresolved) {
  const r = run([
    "await pixso.loadAllPagesAsync();", B64,
    "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
    "let best = null;",
    "(function scan(n) {",
    "  let v; try { v = n.fills; } catch (e) { v = null; }",
    "  if (Array.isArray(v)) for (const p of v) if (p && p.type === 'IMAGE' && p.imageHash === " + JSON.stringify(h) + ") {",
    "    const area = (n.width || 0) * (n.height || 0);",
    "    if (area > 0 && (!best || area < best.area)) best = { node: n, area: area };",
    "  }",
    "  let ch; try { ch = n.children; } catch (e) { return; }",
    "  if (ch) for (const c of ch) scan(c);",
    "})(root);",
    "if (!best) return { e: 'no carrier node' };",
    "const by = await best.node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 4 } });",
    "return { d: b64(by), n: by.length, nm: best.node.name, w: best.node.width, h: best.node.height };"
  ].join("\n"));
  if (r.__err || r.e || !r.d) { console.log("  RENDER FAIL " + h.slice(0, 8) + ": " + (r.__err || r.e || "no data")); continue; }
  const buf = Buffer.from(r.d, "base64");
  const file = OUTDIR + "/render-" + h + ".png";
  writeFileSync(file, buf);
  manifest.push({ hash: h, file: file, bytes: buf.length, ext: "png", source: "render",
    carrier: r.nm, carrierSize: [r.w, r.h] });
  console.log("  rendered " + h.slice(0, 8) + " from " + JSON.stringify(r.nm) + " " + r.w + "x" + r.h + " -> " + buf.length + " bytes");
}

writeFileSync(OUTDIR + "/manifest.json", JSON.stringify(manifest, null, 2), "utf8");
const byBytes = manifest.filter((m) => m.source === "bytes").length;
const byRender = manifest.filter((m) => m.source === "render").length;
console.log("manifest: " + manifest.length + " of " + hashes.length + " images (" + byBytes + " original bytes, " + byRender + " rendered) -> " + OUTDIR + "/manifest.json");

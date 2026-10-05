// The image chain (docs/M1.md D9, §6 D): where the bytes of each IMAGE paint come from.
//
//   import { resolveImages } from "./ir/images.mjs";
//   const { bytes, table } = await resolveImages(ir, pix, { pixso, links, verdicts, cacheDir, only });
//
//   pix       readPix's result (its `images` map: hash -> archive entry with data()), or null
//   pixso     null (no Pixso), or { client: makeMcpClient(...), identity: checkIdentity(...) }
//   links     the ordered subset of LINKS from --images (archive,mcp,render by default); the placeholder
//             is always last
//   verdicts  tools/double/verdicts.json, as data (P8's cases)
//   cacheDir  a folder outside the repository for MCP bytes, keyed by hash (content-addressed)
//   only      optional Set of the hashes the chosen scope needs (all of ir.images otherwise)
//   bytes     Map hash -> Buffer, for every hash whose source is not "none"
//   table     [{ hash, source: "archive"|"mcp"|"render"|"none", format, w, h, reason }] in ir.images order
//
// Links, each tried only when the earlier ones gave nothing usable:
//   1 archive  the archive entry named by the hash, its SHA-1 checked (a mismatch is treated as missing)
//   2 mcp      Pixso's bytes by hash, whole or in ranges, SHA-1 checked, cached by hash
//   3 render   a PNG render of the smallest visible carrier node, by guid (needs Q5)
//   4 none     IMAGE_PLACEHOLDER, drawn by the builder; `reason` says why each link gave nothing
// Links 2 and 3 run only when the identity check passed (same file and Q5); otherwise they are
// skipped with SOURCE_IDENTITY_MISMATCH in the reason. They run under the extract-lib breaker: once it
// is open, every later hash skips them ("Pixso unavailable").
// P8's verdicts are data: the bytes are classified into P8's cases (p8Cases) and a case whose verdict
// is throw, drop or empty moves on to the next link (empty too: a missing image is never an empty
// fill). A pending or ok verdict lets the bytes through. No transcoding anywhere.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE } from "./schema.mjs";
import { SCRIPTS } from "./mcp-readonly.mjs";
import { assertOutsideRepo } from "./outside-repo.mjs";

export const LINKS = ["archive", "mcp", "render"];
export const MAX_SIDE = 4096;
// A strip: longer than MAX_SIDE and at least this many times longer than it is wide (P8 "longStrip").
export const STRIP_RATIO = 8;
export const MOVE_ON = ["throw", "drop", "empty"];
export const sha1hex = (b) => createHash("sha1").update(b).digest("hex");

// --images archive,mcp,render -> the list; refuses an unknown or repeated link.
export function parseLinks(s) {
  const v = String(s == null ? "" : s).split(",").map((x) => x.trim()).filter(Boolean);
  for (const l of v) if (LINKS.indexOf(l) < 0) throw new RangeError("--images: " + JSON.stringify(l) + " is not one of " + LINKS.join(", ") + " (the placeholder is always last)");
  if (new Set(v).size !== v.length) throw new RangeError("--images: a link is named twice");
  return v;
}

// { format, w, h } from the bytes' own header; w and h are null when the header does not say.
export function imageInfo(b) {
  const u = b instanceof Uint8Array ? b : new Uint8Array(0);
  const be16 = (o) => (u[o] << 8) | u[o + 1];
  const be32 = (o) => ((u[o] << 24) >>> 0) + (u[o + 1] << 16) + (u[o + 2] << 8) + u[o + 3];
  const le16 = (o) => u[o] | (u[o + 1] << 8);
  const le24 = (o) => u[o] | (u[o + 1] << 8) | (u[o + 2] << 16);
  if (u.length >= 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return { format: "png", w: be32(16), h: be32(20) };
  if (u.length >= 4 && u[0] === 0xff && u[1] === 0xd8) {
    let p = 2;
    while (p + 9 < u.length) {
      if (u[p] !== 0xff) { p++; continue; }
      const m = u[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { format: "jpeg", w: be16(p + 7), h: be16(p + 5) };
      p += 2 + be16(p + 2);
    }
    return { format: "jpeg", w: null, h: null };
  }
  if (u.length >= 10 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) return { format: "gif", w: le16(6), h: le16(8) };
  if (u.length >= 16 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) {
    const kind = String.fromCharCode(u[12], u[13], u[14], u[15]);
    if (kind === "VP8 " && u.length >= 30) return { format: "webp", w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L" && u.length >= 25) { const v = u[21] | (u[22] << 8) | (u[23] << 16) | (u[24] << 24); return { format: "webp", w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8X" && u.length >= 30) return { format: "webp", w: le24(24) + 1, h: le24(27) + 1 };
    return { format: "webp", w: null, h: null };
  }
  return { format: "unknown", w: null, h: null };
}

// P8's cases these bytes fall in (docs/M1.md §6 E): one for the format, one for the size.
export function p8Cases(info) {
  const out = [];
  if (info.format === "jpeg") out.push("jpegAsPng");
  if (info.format === "webp") out.push("webpAsPng");
  const big = Math.max(info.w || 0, info.h || 0), small = Math.min(info.w || 0, info.h || 0);
  if (big > MAX_SIDE) out.push(small * STRIP_RATIO <= big ? "longStrip" : "png4097");
  else if (info.format === "png") out.push("png4096");
  return out;
}

// null when the bytes may go to Figma, else why not (a P8 verdict, or a format Figma is not given).
export function refusedBy(info, verdicts) {
  if (info.format === "unknown") return "the bytes are of no known image format";
  const v = (verdicts && verdicts.probes && verdicts.probes.P8 && verdicts.probes.P8.verdicts) || {};
  for (const c of p8Cases(info)) if (MOVE_ON.indexOf(v[c]) >= 0) return "P8 " + c + ": " + v[c];
  return null;
}

// Every hash an IMAGE paint in a fills list of record i names (fill paints only, docs/M1.md §0.3).
function imageHashesOf(ir, i) {
  const r = ir.nodes[i];
  const out = [];
  const fills = r && r.props && Number.isInteger(r.props.fills) ? ir.values[r.props.fills] : null;
  if (Array.isArray(fills)) for (const p of fills) if (p && p.type === "IMAGE" && typeof p.imageHash === "string") out.push(p.imageHash);
  return out;
}

// hash -> the guid of its smallest carrier: the visible record (visible itself and every ancestor)
// with the least area among those whose fills name it; an invisible one only when no visible one is.
export function carriers(ir) {
  const best = new Map();
  const vis = [];
  (ir.nodes || []).forEach((r, i) => {
    const own = !(r.props && r.props.visible === false);
    vis[i] = own && (r.parent < 0 || vis[r.parent]);
    for (const h of imageHashesOf(ir, i)) {
      const area = Math.max(0, r.props.width || 0) * Math.max(0, r.props.height || 0);
      const key = [vis[i] ? 0 : 1, area, i];
      const was = best.get(h);
      if (!was || key[0] < was.key[0] || (key[0] === was.key[0] && key[1] < was.key[1])) best.set(h, { key, guid: r.guid, i });
    }
  });
  const out = new Map();
  for (const [h, b] of best) out.set(h, { guid: b.guid, i: b.i });
  return out;
}

async function fetchMcp(client, hash, opts) {
  const whole = opts.wholeBytes || 11 * 1024 * 1024, chunk = opts.chunkBytes || 8 * 1024 * 1024;
  const r = await client.run(SCRIPTS.imageBytes(hash, { whole }));
  if (!r.ok) return { why: r.refused ? "not sent (" + r.error + ")" : r.transport ? "transport failure" : "Pixso: " + r.error };
  const v = r.value || {};
  if (v.missing) return { why: "Pixso has no bytes for it" };
  if (!Number.isInteger(v.n) || v.n < 0) return { why: "Pixso's answer has no length" };
  if (typeof v.d === "string") return { buf: Buffer.from(v.d, "base64"), n: v.n };
  const parts = [];
  for (let off = 0; off < v.n; off += chunk) {
    const len = Math.min(chunk, v.n - off);
    const p = await client.run(SCRIPTS.imageRange(hash, off, len));
    if (!p.ok || !p.value || typeof p.value.d !== "string") return { why: "the range at byte " + off + " failed" + (p.transport ? " (transport)" : "") };
    parts.push(Buffer.from(p.value.d, "base64"));
  }
  return { buf: Buffer.concat(parts), n: v.n };
}

export async function resolveImages(ir, pix, opts) {
  const o = opts || {};
  const links = o.links || LINKS;
  const verdicts = o.verdicts || null;
  const client = o.pixso && o.pixso.client ? o.pixso.client : null;
  const identity = o.pixso && o.pixso.identity ? o.pixso.identity : null;
  const pixsoOk = !!client && !!identity && identity.same && identity.q5;
  let cacheDir = null;
  if (o.cacheDir) { cacheDir = assertOutsideRepo(o.cacheDir); mkdirSync(cacheDir, { recursive: true }); }
  const carry = carriers(ir);
  const bytes = new Map();
  const table = [];
  for (const im of ir.images || []) {
    const hash = im.hash;
    if (o.only && !o.only.has(hash)) continue;
    const why = [];
    let got = null;
    const take = (buf, source, link) => {
      const info = imageInfo(buf);
      const no = refusedBy(info, verdicts);
      if (no) { why.push(link + ": " + no); return false; }
      got = { buf, source, info };
      return true;
    };
    for (const link of links) {
      if (got) break;
      if (link === "archive") {
        const e = pix && pix.images && typeof pix.images.get === "function" ? pix.images.get(hash) : null;
        if (!e) { why.push("archive: not in the archive"); continue; }
        let buf;
        try { buf = Buffer.from(e.data()); } catch (err) { why.push("archive: the entry does not read (" + ((err && err.message) || err) + ")"); continue; }
        if (sha1hex(buf) !== hash) { why.push("archive: " + CODE.IMAGE_HASH_MISMATCH); continue; }
        take(buf, "archive", "archive");
        continue;
      }
      if (!client) { why.push(link + ": no Pixso"); continue; }
      if (!pixsoOk) { why.push(link + ": skipped, " + (identity && identity.code ? identity.code : "Pixso not checked or not answering")); continue; }
      if (client.tripped()) { why.push(link + ": Pixso unavailable (" + client.tripped().detail + ")"); continue; }
      if (link === "mcp") {
        const cached = cacheDir ? join(cacheDir, hash + ".bin") : null;
        if (cached && existsSync(cached)) {
          const buf = readFileSync(cached);
          if (sha1hex(buf) === hash) { take(buf, "mcp", "mcp"); continue; }
        }
        const f = await fetchMcp(client, hash, o);
        if (!f.buf) { why.push("mcp: " + f.why); continue; }
        if (f.buf.length !== f.n || sha1hex(f.buf) !== hash) { why.push("mcp: the bytes' SHA-1 is not the hash"); continue; }
        if (cached) { try { writeFileSync(cached, f.buf); } catch (e) { /* a cache that cannot be written only costs a refetch */ } }
        take(f.buf, "mcp", "mcp");
        continue;
      }
      if (link === "render") {
        const c = carry.get(hash);
        if (!c) { why.push("render: no carrier node"); continue; }
        const r = await client.run(SCRIPTS.render(c.guid, { maxSide: MAX_SIDE }));
        if (!r.ok || !r.value || typeof r.value.d !== "string") { why.push("render: " + (r.ok ? (r.value && r.value.e) || "no image" : r.transport ? "transport failure" : r.error)); continue; }
        take(Buffer.from(r.value.d, "base64"), "render", "render");
      }
    }
    if (got) {
      bytes.set(hash, got.buf);
      table.push({ hash, source: got.source, format: got.info.format, w: got.info.w, h: got.info.h, reason: why.length ? why.join("; ") : null });
    } else {
      table.push({ hash, source: "none", format: im.format || "unknown", w: null, h: null, reason: why.join("; ") || "no link was tried" });
    }
  }
  return { bytes, table };
}

// The table an unresolved run starts from: archive where the IR says the bytes are present, else none.
export function tableFromIR(ir) {
  return (ir.images || []).map((im) => ({ hash: im.hash, source: im.present ? "archive" : "none", format: im.format || "unknown",
    w: null, h: null, reason: im.present ? null : "not resolved" }));
}

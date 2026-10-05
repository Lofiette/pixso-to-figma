// Probes P4 and P8 (docs/M1.md §6 E, D9; docs/REWRITE.md §9). Part E. Bundled as
// (function (IR) { … })(PXF_IR) after common.js, like every figma-plugin/src/ir/*.js.
//
// CONTRACT (the host's probe command, figma-plugin/src/code.js cmdProbe):
//
//   IR.probes[NAME] = { args(raw) -> args, run(args, io) -> Promise<result> }
//     args(raw) sees the whole probe payload and throws on a bad argument of its own, which refuses
//     the job before any probe runs. run gets those arguments merged with the common ones (n,
//     maxMsPerSeries, deadlineMs, sizesMB), and io = { ask(message, deadlineMs) -> Promise<answer|null> },
//     a round trip to the plugin window (null when the deadline passes). The IR layer never owns a
//     timer: the deadline is the host's.
//   A result keeps behavioural verdicts apart from timings:
//     { verdicts: { case: value }, cases: { case: { …what was measured } }, timings: { … } }
//   with the case names and values of tools/double/verdicts.json (tools/double/behaviour.mjs MODEL
//   says what each value means). Nothing is left in the file: every node made is removed.
//
// P4  image bytes as base64 against Uint8Array, for the same bytes. The probe moves the bytes itself,
//     never through the job image pipeline (which creates the job's images before any probe runs): it
//     asks the window for /image/<hash>?b64=1 (answered as text, then figma.base64Decode) and for
//     /image/<hash> (answered as a Uint8Array), and creates an image from each. The runner
//     (tools/plugin-probe.mjs) posts the synthetic images with the job and names their hashes in
//     p4.hashes; the window serves them and does not hand them to the plugin itself.
//       args: p4 = { hashes: [40 lowercase hex, 1..8], repeat: 1..20 (3) }
//       verdicts: sameHash "ok" when every image Figma made from either transport has the hash the
//                 runner computed (the SHA-1 of the bytes) and the bytes arrived whole (their SHA-1,
//                 computed here, equal), else "differs"; transport "binary" when the Uint8Array path
//                 is faster at the median and kept the hash, else "base64"
//       timings:  per transport, per image, the window round trip, the decode and createImage, in ms
//                 (Date.now: the plugin has no performance.now, P2)
// P8  images Figma may refuse, made here from synthetic bytes: PNGs of 4 096 x 4 096 and 4 097 x 4 097
//     and an 8 192 x 16 strip (1-bit grey, stored deflate), an 8 x 8 baseline JPEG and a 1 x 1 lossless
//     WebP (the archive keeps such files under .png; createImage sees only the bytes), and an IMAGE
//     paint whose hash no image has.
//       args: p8 = { cases: [names] } to run a subset (all six by default)
//       verdicts per image case: "throw" (createImage threw), "drop" (an IMAGE paint naming it does not
//                 stay in a rectangle's fills), "empty" (it stays, but the image has no bytes or no
//                 size), "ok"; unknownHash: "throw" (the fills write threw), "drop" (the paint did not
//                 stay), "ok" (it stayed)
//       cases:    format, the size read back, whether Figma's hash is the SHA-1 of the bytes

var P8_CASES = ["png4096", "png4097", "longStrip", "jpegAsPng", "webpAsPng", "unknownHash"];
var HEX40 = /^[0-9a-f]{40}$/;

// ---------- SHA-1, CRC-32 and Adler-32, small and plain ----------
function sha1(bytes) {
  var n = bytes.length, words = ((n + 8) >> 6) + 1, w = new Array(words * 16), i;
  for (i = 0; i < w.length; i++) w[i] = 0;
  for (i = 0; i < n; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  w[n >> 2] |= 0x80 << (24 - (n % 4) * 8);
  w[words * 16 - 1] = n * 8;
  var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0, x = new Array(80);
  var rol = function (v, s) { return (v << s) | (v >>> (32 - s)); };
  for (var b = 0; b < w.length; b += 16) {
    var a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (var t = 0; t < 80; t++) {
      x[t] = t < 16 ? w[b + t] : rol(x[t - 3] ^ x[t - 8] ^ x[t - 14] ^ x[t - 16], 1);
      var f = t < 20 ? ((bb & c) | (~bb & d)) + 0x5a827999 : t < 40 ? (bb ^ c ^ d) + 0x6ed9eba1 : t < 60 ? ((bb & c) | (bb & d) | (c & d)) + 0x8f1bbcdc : (bb ^ c ^ d) + 0xca62c1d6;
      var tmp = (rol(a, 5) + f + e + x[t]) | 0;
      e = d; d = c; c = rol(bb, 30); bb = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(function (v) { return ("00000000" + (v >>> 0).toString(16)).slice(-8); }).join("");
}
var CRC_TABLE = null;
function crc32(bytes, from, to) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (var k = 0; k < 256; k++) { var c = k; for (var j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[k] = c >>> 0; }
  }
  var crc = 0xffffffff;
  for (var i = from; i < to; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function adler32(bytes) {
  var a = 1, b = 0;
  for (var i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

// ---------- synthetic images ----------
function Bytes() { this.parts = []; this.n = 0; }
Bytes.prototype.push = function (arr) { var u = arr instanceof Uint8Array ? arr : new Uint8Array(arr); this.parts.push(u); this.n += u.length; return this; };
Bytes.prototype.u32 = function (v) { return this.push([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); };
Bytes.prototype.ascii = function (s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); return this.push(a); };
Bytes.prototype.done = function () { var out = new Uint8Array(this.n), o = 0; for (var i = 0; i < this.parts.length; i++) { out.set(this.parts[i], o); o += this.parts[i].length; } return out; };

function pngChunk(out, type, data) {
  var body = new Bytes().ascii(type).push(data).done();
  out.u32(data.length).push(body).u32(crc32(body, 0, body.length));
}
// A w x h grey PNG at one bit a pixel, all black, its IDAT stored (deflate without compression).
function pngGray1(w, h) {
  var row = 1 + Math.ceil(w / 8), raw = new Uint8Array(row * h);   // filter byte 0 and zero bits
  var z = new Bytes().push([0x78, 0x01]);
  for (var o = 0; o < raw.length || o === 0; o += 65535) {
    var len = Math.min(65535, raw.length - o), last = o + len >= raw.length;
    z.push([last ? 1 : 0, len & 255, len >>> 8, (~len) & 255, ((~len) >>> 8) & 255]).push(raw.subarray(o, o + len));
    if (last) break;
  }
  z.u32(adler32(raw));
  var ihdr = new Bytes().u32(w).u32(h).push([1, 0, 0, 0, 0]).done();
  var out = new Bytes().push([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  pngChunk(out, "IHDR", ihdr);
  pngChunk(out, "IDAT", z.done());
  pngChunk(out, "IEND", new Uint8Array(0));
  return out.done();
}
// An 8 x 8 grey baseline JPEG: one quantisation table of ones, Huffman tables of one code each
// (DC category 0, AC end-of-block), one block whose bits are 0 0 padded with ones: mid grey.
function jpegGray8() {
  var b = new Bytes().push([0xff, 0xd8]);
  var q = [0xff, 0xdb, 0x00, 0x43, 0x00];
  for (var i = 0; i < 64; i++) q.push(1);
  b.push(q);
  b.push([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00]);
  var dht = function (cls) { var t = [0xff, 0xc4, 0x00, 0x14, cls, 1]; for (var k = 1; k < 16; k++) t.push(0); t.push(0x00); return t; };
  b.push(dht(0x00)).push(dht(0x10));
  b.push([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  b.push([0x3f, 0xff, 0xd9]);
  return b.done();
}
// A 1 x 1 lossless WebP (VP8L): no transform, no colour cache, five one-symbol prefix codes
// (green 0x80, red 0x80, blue 0x80, alpha 0xff, distance 0), so the pixel takes no bits.
function webp1x1() {
  var bits = [], put = function (v, n) { for (var i = 0; i < n; i++) bits.push((v >>> i) & 1); };
  put(0, 14); put(0, 14); put(0, 1); put(0, 3);   // width-1, height-1, alpha unused, version 0
  put(0, 1); put(0, 1); put(0, 1);                // no transform, no colour cache, no meta codes
  var lit = function (s) { put(1, 1); put(0, 1); put(1, 1); put(s, 8); };
  lit(0x80); lit(0x80); lit(0x80); lit(0xff);
  put(1, 1); put(0, 1); put(0, 1); put(0, 1);    // distance: one symbol, 0
  var data = [0x2f];
  for (var o = 0; o < bits.length; o += 8) { var v = 0; for (var k = 0; k < 8 && o + k < bits.length; k++) v |= bits[o + k] << k; data.push(v); }
  var le = function (v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; };
  var chunkLen = data.length;
  return new Bytes().ascii("RIFF").push(le(4 + 8 + chunkLen)).ascii("WEBP").ascii("VP8L").push(le(chunkLen)).push(data).done();
}
IR.probeImages = { sha1: sha1, pngGray1: pngGray1, jpegGray8: jpegGray8, webp1x1: webp1x1, P8_CASES: P8_CASES };

function synth(name) {
  if (name === "png4096") return { bytes: pngGray1(4096, 4096), format: "png", width: 4096, height: 4096 };
  if (name === "png4097") return { bytes: pngGray1(4097, 4097), format: "png", width: 4097, height: 4097 };
  if (name === "longStrip") return { bytes: pngGray1(8192, 16), format: "png", width: 8192, height: 16 };
  if (name === "jpegAsPng") return { bytes: jpegGray8(), format: "jpeg", width: 8, height: 8 };
  if (name === "webpAsPng") return { bytes: webp1x1(), format: "webp", width: 1, height: 1 };
  return null;
}
function msg(e) { return String((e && e.message) || e).slice(0, 200); }
function hasPaint(node, hash) {
  var f = node.fills;
  if (!Array.isArray(f)) return false;
  for (var i = 0; i < f.length; i++) if (f[i] && f[i].type === "IMAGE" && f[i].imageHash === hash) return true;
  return false;
}

async function imageCase(name) {
  var s = synth(name), out = { format: s.format, width: s.width, height: s.height, bytes: s.bytes.length };
  var t0 = Date.now(), img;
  try { img = figma.createImage(s.bytes); }
  catch (e) { out.error = msg(e); return { verdict: "throw", c: out, ms: Date.now() - t0 }; }
  out.hashIsSha1 = img.hash === sha1(s.bytes);
  var size = null, back = null;
  try { size = await img.getSizeAsync(); } catch (e2) { out.sizeError = msg(e2); }
  try { back = await img.getBytesAsync(); } catch (e3) { out.bytesError = msg(e3); }
  out.sizeRead = size ? [size.width, size.height] : null;
  out.bytesRead = back ? back.length : null;
  var rect = figma.createRectangle(), kept = false;
  try {
    rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL", visible: true, opacity: 1 }];
    kept = hasPaint(rect, img.hash);
  } catch (e4) { out.paintError = msg(e4); }
  try { rect.remove(); } catch (e5) {}
  var verdict = !kept ? "drop" : (!size || !size.width || !size.height || !back || !back.length) ? "empty" : "ok";
  return { verdict: verdict, c: out, ms: Date.now() - t0 };
}

async function unknownHashCase() {
  var enc = [], s = "pix2fig probe P8: an image no file has";
  for (var i = 0; i < s.length; i++) enc.push(s.charCodeAt(i));
  var hash = sha1(new Uint8Array(enc)), rect = figma.createRectangle(), out = {}, verdict;
  var t0 = Date.now();
  try {
    rect.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: "FILL", visible: true, opacity: 1 }];
    verdict = hasPaint(rect, hash) ? "ok" : "drop";
  } catch (e) { out.error = msg(e); verdict = "throw"; }
  try { rect.remove(); } catch (e2) {}
  return { verdict: verdict, c: out, ms: Date.now() - t0 };
}

IR.probes.P8 = {
  args: function (raw) {
    var p = raw && raw.p8;
    if (p === undefined || p === null) return { p8Cases: P8_CASES.slice() };
    if (typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(function (k) { return k !== "cases"; })) throw new Error("p8 is { cases: [names] }");
    if (!Array.isArray(p.cases) || !p.cases.length || p.cases.some(function (c) { return P8_CASES.indexOf(c) < 0; })) {
      throw new Error("p8.cases lists some of " + P8_CASES.join(", "));
    }
    return { p8Cases: p.cases.slice() };
  },
  run: async function (A) {
    var res = { verdicts: {}, cases: {}, timings: {} };
    for (var i = 0; i < A.p8Cases.length; i++) {
      var name = A.p8Cases[i];
      var r = name === "unknownHash" ? await unknownHashCase() : await imageCase(name);
      res.verdicts[name] = r.verdict; res.cases[name] = r.c; res.timings[name] = r.ms;
    }
    return res;
  }
};

function median(xs) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s.length ? s[Math.floor(s.length / 2)] : null; }

IR.probes.P4 = {
  args: function (raw) {
    var p = raw && raw.p4;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("P4 needs p4 = { hashes: [the images posted with the job], repeat? } (tools/plugin-probe.mjs makes them)");
    if (Object.keys(p).some(function (k) { return k !== "hashes" && k !== "repeat"; })) throw new Error("p4 is { hashes, repeat }");
    if (!Array.isArray(p.hashes) || !p.hashes.length || p.hashes.length > 8 || p.hashes.some(function (h) { return typeof h !== "string" || !HEX40.test(h); })) {
      throw new Error("p4.hashes lists 1..8 image hashes (40 lowercase hex)");
    }
    var rep = p.repeat === undefined ? 3 : p.repeat;
    if (typeof rep !== "number" || rep !== Math.floor(rep) || rep < 1 || rep > 20) throw new Error("p4.repeat is 1..20");
    return { p4Hashes: p.hashes.slice(), p4Repeat: rep };
  },
  run: async function (A, io) {
    if (!io || typeof io.ask !== "function") throw new Error("P4 moves bytes through the plugin window, and this host gave it none");
    var res = { verdicts: {}, cases: {}, timings: { base64: {}, binary: {} } };
    var sameHash = true, binaryHashOk = true, tot = { base64: [], binary: [] };
    for (var h = 0; h < A.p4Hashes.length; h++) {
      var hash = A.p4Hashes[h], c = { base64: [], binary: [] };
      for (var r = 0; r < A.p4Repeat; r++) {
        var ways = ["base64", "binary"];
        for (var w = 0; w < ways.length; w++) {
          var way = ways[w], t0 = Date.now(), row = { ok: false };
          var ans = await io.ask({ t: "probe-fetch", hash: hash, as: way === "base64" ? "b64" : "raw" }, A.deadlineMs);
          var t1 = Date.now();
          row.transferMs = t1 - t0;
          if (!ans || ans.error || ans.d === undefined) { row.error = ans ? String(ans.error || "no data") : "the window did not answer"; c[way].push(row); sameHash = false; if (way === "binary") binaryHashOk = false; continue; }
          var bytes;
          try { bytes = way === "base64" ? figma.base64Decode(String(ans.d)) : ans.d; }
          catch (e) { row.error = "decode: " + msg(e); c[way].push(row); sameHash = false; continue; }
          var t2 = Date.now();
          row.decodeMs = t2 - t1;
          row.bytes = bytes.length;
          var img;
          try { img = figma.createImage(bytes); } catch (e2) { row.error = "createImage: " + msg(e2); c[way].push(row); sameHash = false; if (way === "binary") binaryHashOk = false; continue; }
          var t3 = Date.now();
          row.createMs = t3 - t2;
          row.totalMs = t3 - t0;
          row.hashOk = img.hash === hash;
          row.bytesWhole = sha1(bytes) === hash;
          row.ok = row.hashOk && row.bytesWhole;
          if (!row.ok) { sameHash = false; if (way === "binary") binaryHashOk = false; }
          tot[way].push(row.totalMs);
          c[way].push(row);
        }
      }
      res.cases[hash.slice(0, 8)] = { base64: c.base64.map(function (x) { return { ok: x.ok, bytes: x.bytes, error: x.error }; }),
        binary: c.binary.map(function (x) { return { ok: x.ok, bytes: x.bytes, error: x.error }; }) };
      res.timings.base64[hash.slice(0, 8)] = c.base64.map(function (x) { return [x.transferMs, x.decodeMs, x.createMs]; });
      res.timings.binary[hash.slice(0, 8)] = c.binary.map(function (x) { return [x.transferMs, x.decodeMs, x.createMs]; });
    }
    var mb = median(tot.base64), mr = median(tot.binary);
    res.timings.medianMs = { base64: mb, binary: mr };
    res.verdicts.sameHash = sameHash ? "ok" : "differs";
    res.verdicts.transport = binaryHashOk && mr !== null && mb !== null && mr < mb ? "binary" : "base64";
    return res;
  }
};

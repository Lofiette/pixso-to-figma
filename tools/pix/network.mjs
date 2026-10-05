// A Pixso vector network blob, decoded with every read bounds-checked (docs/M1.md §6 A).
//
//   import { decodeVectorNetwork } from "./pix/network.mjs";
//   const net = decodeVectorNetwork(pix.blobs[node.vectorData.vectorNetworkBlob]);
//   // { vertices: [{ styleID, x, y }],
//   //   segments: [{ styleID, start, tangentStart: { x, y }, end, tangentEnd: { x, y } }],
//   //   regions:  [{ styleID, windingRule: "NONZERO" | "EVENODD", loops: [[segment index, …], …] }] }
//
// The layout, measured on every network of the three local files (1 397 / 8 935 / 2 204 blobs, each
// ending exactly on its last byte), all little-endian:
//
//   u32 vertexCount, u32 segmentCount, u32 regionCount
//   vertex   u32 styleID, f32 x, f32 y
//   segment  u32 styleID, u32 start, f32 tangentStart.x, f32 tangentStart.y,
//            u32 end, f32 tangentEnd.x, f32 tangentEnd.y
//   region   u32 word (styleID << 1 | bit 0, which is set for NONZERO and clear for EVENODD),
//            u32 loopCount, then per loop u32 n and n u32 segment indices
//
// Coordinates are in the network's own frame (vectorData.normalizedSize); the reader scales them to
// the node's size. A styleID names an entry of vectorData.styleOverrideTable (0: none).
//
// A blob that runs past its end, leaves bytes over, claims more elements than its bytes could hold,
// or names a vertex or segment it does not have is not understood, and nothing half-read is
// returned: it throws PIX_CORRUPT through kiwi.corrupt, so the reader stops before anything is built.
import { corrupt } from "../kiwi.mjs";

export function decodeVectorNetwork(bytes) {
  if (!bytes || !bytes.length) throw corrupt("an empty vector network blob");
  const b = bytes, n = b.length;
  const dv = new DataView(b.buffer, b.byteOffset, n);
  let i = 0;
  const u32 = (what) => {
    if (i + 4 > n) throw corrupt("the vector network runs past its end at byte " + i + " of " + n + " (" + what + ")");
    const v = dv.getUint32(i, true); i += 4; return v;
  };
  const f32 = (what) => {
    if (i + 4 > n) throw corrupt("the vector network runs past its end at byte " + i + " of " + n + " (" + what + ")");
    const v = dv.getFloat32(i, true); i += 4; return v;
  };
  // Each element takes at least this many bytes, so a count that cannot fit is refused before any
  // array of that length is made.
  const room = (count, each, what) => {
    if (count * each > n - i) throw corrupt("the vector network claims " + count + " " + what + " at byte " + i + "; only " + (n - i) + " bytes are left");
  };
  const nv = u32("vertex count"), ns = u32("segment count"), nr = u32("region count");
  room(nv, 12, "vertices");
  const vertices = new Array(nv);
  for (let k = 0; k < nv; k++) vertices[k] = { styleID: u32("vertex"), x: f32("vertex"), y: f32("vertex") };
  room(ns, 28, "segments");
  const segments = new Array(ns);
  for (let k = 0; k < ns; k++) {
    const styleID = u32("segment"), start = u32("segment"), tsx = f32("segment"), tsy = f32("segment");
    const end = u32("segment"), tex = f32("segment"), tey = f32("segment");
    if (start >= nv || end >= nv) throw corrupt("vector network segment " + k + " joins vertices " + start + " and " + end + "; there are " + nv);
    segments[k] = { styleID, start, tangentStart: { x: tsx, y: tsy }, end, tangentEnd: { x: tex, y: tey } };
  }
  room(nr, 8, "regions");
  const regions = new Array(nr);
  for (let k = 0; k < nr; k++) {
    const word = u32("region");
    const nl = u32("region loop count");
    room(nl, 4, "loops");
    const loops = new Array(nl);
    for (let l = 0; l < nl; l++) {
      const m = u32("loop length");
      room(m, 4, "loop segments");
      const loop = new Array(m);
      for (let q = 0; q < m; q++) {
        const s = u32("loop segment");
        if (s >= ns) throw corrupt("vector network region " + k + " names segment " + s + "; there are " + ns);
        loop[q] = s;
      }
      loops[l] = loop;
    }
    regions[k] = { styleID: word >>> 1, windingRule: word & 1 ? "NONZERO" : "EVENODD", loops };
  }
  if (i !== n) throw corrupt("the vector network ends at byte " + i + " but the blob runs to " + n + " (" + (n - i) + " bytes left over)");
  return { vertices, segments, regions };
}

// The inverse, for the synthetic fixture and the tests: the same layout, byte for byte.
export function encodeVectorNetwork({ vertices, segments, regions }) {
  const parts = [];
  const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); parts.push(x); };
  const f32 = (v) => { const x = Buffer.alloc(4); x.writeFloatLE(v); parts.push(x); };
  u32(vertices.length); u32(segments.length); u32(regions.length);
  for (const v of vertices) { u32(v.styleID || 0); f32(v.x); f32(v.y); }
  for (const s of segments) {
    const ts = s.tangentStart || { x: 0, y: 0 }, te = s.tangentEnd || { x: 0, y: 0 };
    u32(s.styleID || 0); u32(s.start); f32(ts.x); f32(ts.y); u32(s.end); f32(te.x); f32(te.y);
  }
  for (const r of regions) {
    u32(((r.styleID || 0) << 1) | (r.windingRule === "NONZERO" ? 1 : 0));
    u32(r.loops.length);
    for (const loop of r.loops) { u32(loop.length); for (const k of loop) u32(k); }
  }
  return Buffer.concat(parts);
}

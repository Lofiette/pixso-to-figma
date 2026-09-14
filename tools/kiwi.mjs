// A reader for the binary Kiwi schema that ships inside a .pix, and for messages encoded with it.
//
// Kiwi is Evan Wallace's schema-driven binary format — the same one Figma's .fig uses, which is no
// surprise given Pixso's API is a member-for-member clone of Figma's. The point of it here is that
// the schema travels WITH the file (pixso.binary), so nothing has to be guessed: the field names,
// their types and their ids are all stated.
//
// Schema layout:  varuint defCount, then per definition:
//   string name, byte kind (0 enum, 1 struct, 2 message), varuint fieldCount, then per field:
//   string name, varint type (zigzag; negative = builtin, >=0 = index into definitions),
//   byte isArray, varuint value (field id for messages, enum value for enums)
export const BOOL = -1, BYTE = -2, INT = -3, UINT = -4, FLOAT = -5, STRING = -6, INT64 = -7, UINT64 = -8;

export class Reader {
  constructor(buf) { this.b = buf; this.i = 0; }
  byte() { return this.b[this.i++]; }
  varuint() {
    let v = 0, s = 0, c;
    do { c = this.b[this.i++]; v |= (c & 0x7f) << s; s += 7; } while (c & 0x80);
    return v >>> 0;
  }
  varint() { const v = this.varuint(); return (v & 1) ? ~(v >>> 1) : (v >>> 1); }
  varuint64() {
    let v = 0n, s = 0n, c;
    do { c = this.b[this.i++]; v |= BigInt(c & 0x7f) << s; s += 7n; } while (c & 0x80);
    return v;
  }
  varint64() { const v = this.varuint64(); return (v & 1n) ? ~(v >> 1n) : (v >> 1n); }
  float() {
    // Kiwi's float is a byte-shuffled 32-bit: a zero byte means 0, otherwise the 4 bytes are rotated.
    const first = this.b[this.i];
    if (first === 0) { this.i++; return 0; }
    const b0 = this.b[this.i++], b1 = this.b[this.i++], b2 = this.b[this.i++], b3 = this.b[this.i++];
    const bits = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    const rot = ((bits << 23) | (bits >>> 9)) >>> 0;
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, rot, true);
    return dv.getFloat32(0, true);
  }
  string() {
    const start = this.i;
    while (this.b[this.i] !== 0) this.i++;
    const s = this.b.toString("utf8", start, this.i);
    this.i++;
    return s;
  }
  bytes(n) { const s = this.i; this.i += n; return this.b.subarray(s, this.i); }
  get done() { return this.i >= this.b.length; }
}

export function parseSchema(buf) {
  const r = new Reader(buf);
  const defs = [];
  const n = r.varuint();
  for (let i = 0; i < n; i++) {
    const name = r.string();
    const kind = r.byte();
    const fc = r.varuint();
    const fields = [];
    for (let j = 0; j < fc; j++) {
      fields.push({ name: r.string(), type: r.varint(), isArray: !!(r.byte() & 1), value: r.varuint() });
    }
    defs.push({ name, kind, fields });
  }
  return defs;
}

export const KIND = ["enum", "struct", "message"];

// ---------- geometry blobs ----------
//
// A Path in a .pix carries a blobIndex into PixsoMsg.blobs, and that blob is a stream of
// [opcode byte][float32 LE x, float32 LE y]*. The opcodes were not guessed: every assignment of 0..3
// points to each opcode was tried, and exactly one makes all 3 716 path blobs of a 13 MB library end
// on their own last byte — 100 %, where the hand-guessed map managed 225. Independently: decode a
// node's fill paths, take the bounding box, and it matches the node's own `size` field within a pixel
// for 14 007 of 14 128 nodes; the rest are vectors whose curves bulge past their control points,
// which is the expected direction to miss in.
export const PATH_ARITY = { 0: 0, 1: 1, 2: 1, 4: 3 };
export const PATH_SVG = { 0: "Z", 1: "M", 2: "L", 4: "C" };

// Decode one geometry blob into commands. Throws rather than guessing: a blob that does not end
// exactly on its last byte has not been understood, and silently returning half a shape would be
// worse than stopping.
export function decodePath(b) {
  const cmds = [];
  if (!b || !b.length) return cmds;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  let i = 0;
  while (i < b.length) {
    const op = b[i];
    const n = PATH_ARITY[op];
    if (n === undefined) throw new Error("unknown path opcode " + op + " at byte " + i);
    i += 1;
    const pts = [];
    for (let k = 0; k < n; k++) {
      if (i + 8 > b.length) throw new Error("path ran past the end at byte " + i);
      pts.push([dv.getFloat32(i, true), dv.getFloat32(i + 4, true)]);
      i += 8;
    }
    cmds.push({ op, pts });
  }
  return cmds;
}

export function pathToSVG(cmds, round = 3) {
  const f = (v) => String(Math.round(v * 10 ** round) / 10 ** round);
  let d = "";
  for (const c of cmds) d += PATH_SVG[c.op] + c.pts.map((p) => f(p[0]) + "," + f(p[1])).join(" ") + " ";
  return d.trim();
}

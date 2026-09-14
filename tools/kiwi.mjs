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

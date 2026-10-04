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
//
// Every read is bounds-checked. A .pix is input from outside — a truncated download, a damaged disk,
// or a file made to hurt — so reading past the end, meeting a field id the file's own schema does not
// define, or a document that does not end exactly on its last byte throws an Error whose message
// starts with "PIX_CORRUPT:". The caller can tell a damaged file from a bug in the reader by that
// prefix alone, and stop before anything is built from it. On a valid file the checks change
// nothing: the same values come out, in the same order.
export const BOOL = -1, BYTE = -2, INT = -3, UINT = -4, FLOAT = -5, STRING = -6, INT64 = -7, UINT64 = -8;

export function corrupt(msg) {
  const e = new Error("PIX_CORRUPT: " + msg);
  e.code = "PIX_CORRUPT";
  return e;
}

// A file that is well formed but uses something this reader does not handle (zip64, a document
// past the size limit). Kept apart from PIX_CORRUPT so nobody is told their file is damaged when it
// is not.
export function unsupported(msg) {
  const e = new Error("PIX_UNSUPPORTED: " + msg);
  e.code = "PIX_UNSUPPORTED";
  return e;
}

// Kiwi's float is the IEEE bits rotated so the exponent comes first; one shared scratch word turns
// them back without allocating per value.
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);

export class Reader {
  constructor(buf) {
    this.b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    this.i = 0;
    this.n = this.b.length;
    // Only arrays of field-less structs can hold more elements than there are bytes left (each
    // element is zero bytes long). They are charged here, so a hostile count cannot make the decoder
    // loop for longer than the data could justify.
    this.budget = this.n;
  }
  past(what, at) {
    return corrupt(what + " at byte " + (at === undefined ? this.i : at) + " runs past the end of " + this.n + " bytes");
  }
  byte() {
    if (this.i >= this.n) throw this.past("a byte");
    return this.b[this.i++];
  }
  // Kiwi writes a 32-bit varuint in at most five bytes. Up to ten are still consumed, exactly as this
  // reader always did, so a writer that put a wider value in a uint field keeps the reader in step;
  // no writer of any kind makes an eleventh, so meeting one means the reader is lost.
  varuint() {
    const b = this.b, n = this.n, at = this.i;
    let i = at, v = 0, s = 0, c;
    do {
      if (i >= n) throw this.past("a varint", at);
      if (s > 63) throw corrupt("a varint at byte " + at + " is longer than ten bytes");
      c = b[i++]; v |= (c & 0x7f) << s; s += 7;
    } while (c & 0x80);
    this.i = i;
    return v >>> 0;
  }
  varint() { const v = this.varuint(); return (v & 1) ? ~(v >>> 1) : (v >>> 1); }
  // Kiwi's 64-bit varuint: up to eight 7-bit groups, then a ninth byte that carries all 8 of its bits.
  varuint64() {
    const at = this.i;
    let v = 0n, s = 0n, c;
    for (;;) {
      if (this.i >= this.n) throw this.past("a 64-bit varint", at);
      c = this.b[this.i++];
      if (s === 56n) return v | (BigInt(c) << s);
      v |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) return v;
      s += 7n;
    }
  }
  varint64() { const v = this.varuint64(); return (v & 1n) ? ~(v >> 1n) : (v >> 1n); }
  float() {
    // Kiwi's float is a byte-shuffled 32-bit: a zero byte means 0, otherwise the 4 bytes are rotated.
    const b = this.b, i = this.i;
    if (i >= this.n) throw this.past("a float");
    const first = b[i];
    if (first === 0) { this.i = i + 1; return 0; }
    if (i + 4 > this.n) throw this.past("a float");
    const bits = (first | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
    this.i = i + 4;
    U32[0] = (bits << 23) | (bits >>> 9);
    return F32[0];
  }
  string() {
    const end = this.i < this.n ? this.b.indexOf(0, this.i) : -1;
    if (end < 0) throw this.past("a string");
    const s = this.b.toString("utf8", this.i, end);
    this.i = end + 1;
    return s;
  }
  bytes(n) {
    if (n > this.n - this.i) throw this.past(n + " bytes");
    const s = this.i; this.i += n; return this.b.subarray(s, this.i);
  }
  get done() { return this.i >= this.n; }
  get remaining() { return this.n - this.i; }
  // A message that decodes but leaves bytes behind was not understood: the schema and the data
  // disagree somewhere, and whatever was read before that point cannot be trusted either.
  expectEnd(what) {
    if (this.i !== this.n) {
      throw corrupt(what + " ends at byte " + this.i + " but the data runs to " + this.n +
        " (" + (this.n - this.i) + " bytes left over)");
    }
  }
}

// Deeper than any real document nests (a node's overrides hold nodes, whose paths hold guids); a
// hostile file could otherwise nest messages until the stack runs out.
export const MAX_DEPTH = 256;

export function parseSchema(buf) {
  const r = new Reader(buf);
  const defs = [];
  const n = r.varuint();
  for (let i = 0; i < n; i++) {
    const name = r.string();
    const kind = r.byte();
    if (kind > 2) throw corrupt("schema definition " + JSON.stringify(name) + " has kind " + kind + ", not enum, struct or message");
    const fc = r.varuint();
    const fields = [];
    for (let j = 0; j < fc; j++) {
      fields.push({ name: r.string(), type: r.varint(), isArray: !!(r.byte() & 1), value: r.varuint() });
    }
    defs.push({ name, kind, fields });
  }
  validateSchema(defs);
  return defs;
}

// The checks a decoder relies on, made once on the schema instead of on every value. A schema that
// fails them would make the decoder index nothing, recurse forever, or write onto an object's
// prototype. Kiwi's own compiler refuses all of these, so a schema it wrote passes untouched.
export function validateSchema(defs) {
  const seen = new Set();
  for (const d of defs) {
    if (seen.has(d.name)) throw corrupt("schema defines " + JSON.stringify(d.name) + " twice");
    seen.add(d.name);
    if (d.kind === 0) continue;                         // an enum field's type is unused (Kiwi writes 0)
    const ids = new Set();
    for (const f of d.fields) {
      if (f.name === "__proto__") throw corrupt("schema field name __proto__ in " + JSON.stringify(d.name));
      if (f.type < UINT64 || f.type >= defs.length) {
        throw corrupt("field " + JSON.stringify(d.name + "." + f.name) + " has type " + f.type + ", which is no type");
      }
      if (d.kind === 2) {
        if (ids.has(f.value)) throw corrupt("message " + JSON.stringify(d.name) + " uses field id " + f.value + " twice");
        ids.add(f.value);
      }
    }
  }
  // A struct has no terminator and no optional fields, so one that contains itself (other than
  // through an array, which can be empty) has no finite encoding. Nor can a struct whose fields hold
  // structs that hold structs more than MAX_DEPTH levels down ever be decoded: the decoder stops at
  // that depth. Refusing it here also bounds this walk, and zeroWidthStructs() after it, to
  // MAX_DEPTH frames, so a schema made of one long chain cannot run the stack out instead.
  // height[t]: 0 not yet seen, -1 on the current path, otherwise the levels of struct t's longest
  // chain (1 for a struct that holds no struct). Kept per struct, so the answer does not depend on
  // the order the definitions come in.
  const height = new Array(defs.length).fill(0);
  const tooDeep = (d) => corrupt("struct " + JSON.stringify(d.name) + " nests structs more than " + MAX_DEPTH +
    " levels deep, which nothing could decode");
  const visit = (t, depth) => {
    const d = defs[t];
    if (d.kind !== 1) return 0;
    if (height[t] > 0) return height[t];
    if (height[t] < 0) throw corrupt("struct " + JSON.stringify(d.name) + " contains itself");
    if (depth > MAX_DEPTH) throw tooDeep(d);
    height[t] = -1;
    let h = 1;
    for (const f of d.fields) if (!f.isArray && f.type >= 0) h = Math.max(h, 1 + visit(f.type, depth + 1));
    if (h > MAX_DEPTH) throw tooDeep(d);
    return (height[t] = h);
  };
  for (let t = 0; t < defs.length; t++) visit(t, 1);
}

export const KIND = ["enum", "struct", "message"];

// A decoder compiled from a schema: one closure per definition, so a message finds a field by
// indexing an array with its id instead of searching the field list. No code is generated or
// evaluated — the schema comes from the file, and the file is not trusted.
//
//   const dec = createDecoder(defs, { keep: { PixsoNode: ["guid", "name"] } });
//   const msg = dec.decode(bytes, "PixsoMsg");    // throws PIX_CORRUPT unless every byte is consumed
//
// `keep` names, per message, the fields to return; the others are still read and checked, then
// dropped. Values: enums come back as their number, int64/uint64 as BigInt, and byte[] as a Buffer
// view into the input rather than an array of numbers.
export function createDecoder(defs, opts = {}) {
  // Callers normally pass what parseSchema() returned, already checked; checking again is cheap
  // next to decoding, and the closures below rely on it.
  validateSchema(defs);
  const keep = opts.keep || {};
  const readers = new Array(defs.length);
  const zeroWidth = zeroWidthStructs(defs);

  const builtin = (type) => {
    switch (type) {
      case BOOL: return (r) => r.byte() !== 0;
      case BYTE: return (r) => r.byte();
      case INT: return (r) => r.varint();
      case UINT: return (r) => r.varuint();
      case FLOAT: return (r) => r.float();
      case STRING: return (r) => r.string();
      case INT64: return (r) => r.varint64();
      case UINT64: return (r) => r.varuint64();
    }
    throw corrupt("unknown builtin type " + type);
  };
  // Late-bound, because definitions refer to each other (a node's overrides are nodes).
  const single = (type) => (type < 0 ? builtin(type) : (r, k, d) => readers[type](r, k, d));
  const field = (type, isArray) => {
    if (!isArray) return single(type);
    if (type === BYTE) return (r) => r.bytes(r.varuint());
    const one = single(type);
    const empty = type >= 0 && zeroWidth[type];
    return (r, k, d) => {
      const at = r.i;
      const n = r.varuint();
      // Every element takes at least one byte, so a count larger than what is left is a lie.
      if (empty) {
        if ((r.budget -= n) < 0) throw corrupt("an array of " + n + " empty structs at byte " + at + " is longer than the whole message could justify");
      } else if (n > r.n - r.i) {
        throw corrupt("an array of " + n + " at byte " + at + " is longer than the " + (r.n - r.i) + " bytes left");
      }
      if (!k) { for (let i = 0; i < n; i++) one(r, false, d); return null; }
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = one(r, true, d);
      return out;
    };
  };
  const tooDeep = (r, name) => corrupt(name + " at byte " + r.i + " is nested deeper than " + MAX_DEPTH + " levels");

  defs.forEach((def, t) => {
    const name = def.name;
    if (def.kind === 0) { readers[t] = (r) => r.varuint(); return; }
    if (def.kind === 1) {
      const names = def.fields.map((f) => f.name);
      const fns = def.fields.map((f) => field(f.type, f.isArray));
      readers[t] = (r, k, d) => {
        if (d > MAX_DEPTH) throw tooDeep(r, name);
        if (!k) { for (let j = 0; j < fns.length; j++) fns[j](r, false, d + 1); return null; }
        const o = {};
        for (let j = 0; j < fns.length; j++) o[names[j]] = fns[j](r, true, d + 1);
        return o;
      };
      return;
    }
    // The name comes from the file: a message called "constructor" or "__proto__" must not find
    // what every plain object inherits, so only `keep`'s own keys count.
    const wanted = Object.hasOwn(keep, name) ? new Set(keep[name]) : null;
    const names = [], fns = [], kept = [];
    for (const f of def.fields) {
      names[f.value] = f.name;
      fns[f.value] = field(f.type, f.isArray);
      kept[f.value] = !wanted || wanted.has(f.name);
    }
    readers[t] = (r, k, d) => {
      if (d > MAX_DEPTH) throw tooDeep(r, name);
      const o = k ? {} : null;
      for (;;) {
        const at = r.i;
        const id = r.varuint();
        if (id === 0) return o;
        const fn = fns[id];
        if (fn === undefined) throw corrupt("field id " + id + " at byte " + at + " is not defined for " + name);
        const want = k && kept[id];
        const v = fn(r, want, d + 1);
        if (want) o[names[id]] = v;
      }
    };
  });

  const byName = new Map(defs.map((d, i) => [d.name, i]));
  return {
    // Decode one whole buffer as one message, and insist that it ends exactly on its last byte.
    decode(buf, rootName) {
      const t = byName.get(rootName);
      if (t === undefined || defs[t].kind !== 2) throw corrupt("the schema has no message " + rootName);
      const r = new Reader(buf);
      const v = readers[t](r, true, 0);
      r.expectEnd("the " + rootName + " message");
      return v;
    },
  };
}

// Structs whose encoding can be zero bytes long: no fields, or only fields that are such structs.
// Recursive, one frame per struct in a chain; validateSchema() has already refused chains longer
// than MAX_DEPTH, so it stays shallow.
function zeroWidthStructs(defs) {
  const memo = new Array(defs.length);
  const zw = (t, stack) => {
    if (memo[t] !== undefined) return memo[t];
    const d = defs[t];
    if (d.kind !== 1 || stack.has(t)) return false;
    stack.add(t);
    const v = d.fields.every((f) => !f.isArray && f.type >= 0 && zw(f.type, stack));
    stack.delete(t);
    return (memo[t] = v);
  };
  return defs.map((_, t) => zw(t, new Set()));
}

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
    if (n === undefined) throw corrupt("unknown path opcode " + op + " at byte " + i);
    i += 1;
    const pts = [];
    for (let k = 0; k < n; k++) {
      if (i + 8 > b.length) throw corrupt("path ran past the end at byte " + i);
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

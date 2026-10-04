// The other direction of tools/kiwi.mjs and tools/pix/read.mjs: write a Kiwi schema, a message, a
// Pixso document and a .pix archive. It exists so the reader can be tested on files made here, in
// memory, from definitions written in this repository — no real file is ever needed (§8 of
// docs/REWRITE.md).
//
// Everything mirrors Kiwi's reference encoder, byte for byte, so whatever this writes is what a
// Kiwi writer would have written for the same schema and values.
import * as zlib from "node:zlib";
import { BOOL, BYTE, INT, UINT, FLOAT, STRING, INT64, UINT64, validateSchema } from "../kiwi.mjs";
import { DOC_MAGIC } from "./read.mjs";
import { zip } from "./zip.mjs";

const BUILTIN = { bool: BOOL, byte: BYTE, int: INT, uint: UINT, float: FLOAT, string: STRING, int64: INT64, uint64: UINT64 };

// ---------- the schema, as text ----------
//
// Kiwi's own text syntax, the subset a schema needs:
//
//   enum Name { A = 0; B = 1; }
//   struct Name { uint x; GUID[] path; }          fields in order, no ids
//   message Name { GUID guid = 1; string name = 2; }
//
// It returns definitions in exactly the shape parseSchema() returns for the binary form, so the two
// can be compared field by field.
export function parseKiwiText(src) {
  const toks = src.replace(/\/\/[^\n]*/g, " ").match(/[A-Za-z_][A-Za-z0-9_]*|\d+|\[\]|[{};=]/g) || [];
  let i = 0;
  const next = () => { if (i >= toks.length) throw new Error("schema text ends early"); return toks[i++]; };
  const expect = (t) => { const g = next(); if (g !== t) throw new Error("schema text: expected " + t + ", got " + g); };
  const raw = [];
  while (i < toks.length) {
    const kindName = next();
    const kind = ["enum", "struct", "message"].indexOf(kindName);
    if (kind < 0) throw new Error("schema text: expected enum, struct or message, got " + kindName);
    const name = next();
    expect("{");
    const fields = [];
    while (toks[i] !== "}") {
      if (kind === 0) {
        const fname = next(); expect("="); const value = Number(next()); expect(";");
        fields.push({ name: fname, typeName: null, isArray: false, value });
      } else {
        const typeName = next();
        const isArray = toks[i] === "[]" ? (i++, true) : false;
        const fname = next();
        let value = fields.length + 1;                  // a struct field's value is its position, as in Kiwi
        if (kind === 2) { expect("="); value = Number(next()); }
        expect(";");
        fields.push({ name: fname, typeName, isArray, value });
      }
    }
    expect("}");
    raw.push({ name, kind, fields });
  }
  const index = new Map(raw.map((d, k) => [d.name, k]));
  const defs = raw.map((d) => ({
    name: d.name, kind: d.kind,
    fields: d.fields.map((f) => {
      let type = 0;                                     // Kiwi writes 0 for an enum's members
      if (f.typeName !== null) {
        type = f.typeName in BUILTIN ? BUILTIN[f.typeName] : index.get(f.typeName);
        if (type === undefined) throw new Error("schema text: unknown type " + f.typeName + " in " + d.name);
      }
      return { name: f.name, type, isArray: f.isArray, value: f.value };
    }),
  }));
  validateSchema(defs);
  return defs;
}

// ---------- bytes ----------

const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);

export class Writer {
  constructor() { this.b = Buffer.alloc(256); this.n = 0; }
  room(k) {
    if (this.n + k <= this.b.length) return;
    const nb = Buffer.alloc(Math.max(this.b.length * 2, this.n + k));
    this.b.copy(nb, 0, 0, this.n);
    this.b = nb;
  }
  byte(v) { this.room(1); this.b[this.n++] = v & 255; }
  raw(bytes) { this.room(bytes.length); this.b.set(bytes, this.n); this.n += bytes.length; }
  varuint(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error("not a uint: " + v);
    do { const c = v & 127; v = Math.floor(v / 128); this.byte(v ? c | 128 : c); } while (v);
  }
  varint(v) {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new Error("not an int: " + v);
    this.varuint(((v << 1) ^ (v >> 31)) >>> 0);
  }
  varuint64(v) {
    v = BigInt(v);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error("not a uint64: " + v);
    for (let i = 0; v > 127n && i < 8; i++) { this.byte(Number(v & 127n) | 128); v >>= 7n; }
    this.byte(Number(v));
  }
  varint64(v) {
    v = BigInt(v);
    if (v < -0x8000000000000000n || v > 0x7fffffffffffffffn) throw new Error("not an int64: " + v);
    this.varuint64(v < 0n ? ((-v - 1n) << 1n) | 1n : v << 1n);
  }
  float(v) {
    if (typeof v !== "number") throw new Error("not a float: " + v);
    F32[0] = v;
    const bits = ((U32[0] >>> 23) | (U32[0] << 9)) >>> 0;
    // Zero and denormals (exponent 0) are one zero byte; everything else is 4 bytes, exponent first.
    if ((bits & 255) === 0) { this.byte(0); return; }
    this.byte(bits); this.byte(bits >>> 8); this.byte(bits >>> 16); this.byte(bits >>> 24);
  }
  string(s) {
    const enc = Buffer.from(String(s), "utf8");
    if (enc.includes(0)) throw new Error("a Kiwi string cannot hold a NUL byte");
    this.raw(enc); this.byte(0);
  }
  toBuffer() { return Buffer.from(this.b.subarray(0, this.n)); }
}

// The binary schema, exactly as pixso.binary carries one and parseSchema() reads it.
export function encodeSchema(defs) {
  const w = new Writer();
  w.varuint(defs.length);
  for (const d of defs) {
    w.string(d.name);
    w.byte(d.kind);
    w.varuint(d.fields.length);
    for (const f of d.fields) {
      w.string(f.name);
      w.varint(f.type);
      w.byte(f.isArray ? 1 : 0);
      w.varuint(f.value);
    }
  }
  return w.toBuffer();
}

// Encode a value as one message of the schema. Strict on purpose, because a typo in a fixture
// should fail where it was made: a message key the schema does not define, a struct field left
// out, or an enum name the enum does not have, all throw. Enums take a name or a number; byte[]
// takes any byte array; int64/uint64 take a BigInt or an integer.
export function encodeMessage(defs, rootName, value) {
  const byName = new Map(defs.map((d, k) => [d.name, k]));
  const w = new Writer();
  const one = (type, v, where) => {
    switch (type) {
      case BOOL: return w.byte(v ? 1 : 0);
      case BYTE: return w.byte(v);
      case INT: return w.varint(v);
      case UINT: return w.varuint(v);
      case FLOAT: return w.float(v);
      case STRING: return w.string(v);
      case INT64: return w.varint64(v);
      case UINT64: return w.varuint64(v);
    }
    const d = defs[type];
    if (d.kind === 0) {
      const f = typeof v === "number" ? { value: v } : d.fields.find((x) => x.name === v);
      if (!f) throw new Error(where + ": " + JSON.stringify(v) + " is not in enum " + d.name);
      return w.varuint(f.value);
    }
    if (!v || typeof v !== "object") throw new Error(where + ": expected a " + d.name + " object");
    if (d.kind === 1) {
      for (const f of d.fields) {
        if (v[f.name] === undefined) throw new Error(where + ": struct " + d.name + " needs " + f.name);
        put(f, v[f.name], where + "." + f.name);
      }
      return;
    }
    for (const k of Object.keys(v)) {
      if (!d.fields.some((f) => f.name === k)) throw new Error(where + ": " + d.name + " has no field " + k);
    }
    for (const f of d.fields) {
      if (v[f.name] === undefined || v[f.name] === null) continue;
      w.varuint(f.value);
      put(f, v[f.name], where + "." + f.name);
    }
    w.varuint(0);
  };
  const put = (f, v, where) => {
    if (!f.isArray) return one(f.type, v, where);
    if (f.type === BYTE) { w.varuint(v.length); return w.raw(v); }
    if (!Array.isArray(v)) throw new Error(where + ": expected an array");
    w.varuint(v.length);
    v.forEach((x, k) => one(f.type, x, where + "[" + k + "]"));
  };
  const t = byName.get(rootName);
  if (t === undefined || defs[t].kind !== 2) throw new Error("the schema has no message " + rootName);
  one(t, value, rootName);
  return w.toBuffer();
}

// ---------- the document and the archive ----------

// "pixso-kw", the version byte, the tag, then the message as one zstd frame.
export function writeDocument(message, { version = 1, tag = "compress:zstd", level = 3 } = {}) {
  const frame = zlib.zstdCompressSync(message, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
  return Buffer.concat([Buffer.from(DOC_MAGIC, "latin1"), Buffer.from([version]), Buffer.from(tag, "latin1"), frame]);
}

// One .pix: the schema, a VERSION entry, the document, and images named "<sha1>.png".
export function writePix({ schema, document, docName = "Document.pix", version = "1", images = [], deflateSchema = true }) {
  return zip([
    { name: "pixso.binary", data: schema, deflate: deflateSchema },
    { name: "VERSION", data: Buffer.from(version, "utf8") },
    { name: docName, data: document },
    ...images.map((im) => ({ name: im.name, data: im.data })),
  ]);
}

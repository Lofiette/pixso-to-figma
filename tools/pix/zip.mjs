// The ZIP layer of a .pix, both ways, with no dependency.
//
// None is needed: a zip's central directory is a fixed layout, and the entries in a .pix are stored
// or deflated, both of which node's zlib already does. Reading is bounds-checked like the Kiwi layer
// (tools/kiwi.mjs): an archive that points outside itself, an entry whose bytes do not inflate to the
// size it declares, or whose CRC does not match, throws PIX_CORRUPT instead of handing back garbage.
// Writing exists for the synthetic fixture (tools/pix/fixture.mjs), so it writes the plain subset
// the reader reads and nothing more.
import * as zlib from "node:zlib";
import { corrupt, unsupported } from "../kiwi.mjs";

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

function crc32(b) {
  if (typeof zlib.crc32 !== "function") {
    throw unsupported("this Node has no zlib.crc32 (needs Node 22.15+); node " + process.version);
  }
  return zlib.crc32(b) >>> 0;
}

// Entries come back with their bytes unread: `data()` inflates and checks one entry when it is
// asked for, so a file with thousands of images costs nothing until an image is wanted.
export function unzip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 22) throw corrupt("the file is " + buf.length + " bytes, too short to be a zip archive");
  // The end record sits at the very end, unless the archive carries a comment (at most 64 KB).
  let end = buf.length - 22;
  const stop = Math.max(0, end - 0xffff);
  while (end >= stop && buf.readUInt32LE(end) !== EOCD) end--;
  if (end < stop) throw corrupt("not a zip archive: no end-of-directory record");
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOff = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw unsupported("zip64 archives are not read");
  if (cdOff + cdSize > end) throw corrupt("the zip directory points past its own end record");

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOff + cdSize) throw corrupt("zip directory entry " + i + " runs past the directory");
    if (buf.readUInt32LE(p) !== CENTRAL) throw corrupt("zip directory entry " + i + " is malformed");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cdOff + cdSize) throw corrupt("zip directory entry " + i + " runs past the directory");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const label = "zip entry " + JSON.stringify(name);
    if (flags & 1) throw unsupported(label + " is encrypted");
    if (method !== 0 && method !== 8) throw unsupported(label + " uses compression method " + method);
    if (compSize === 0xffffffff || size === 0xffffffff || localOff === 0xffffffff) throw unsupported("zip64 archives are not read");
    if (method === 0 && compSize !== size) throw corrupt(label + " is stored but declares " + compSize + " and " + size + " bytes");
    // The local header repeats the name and extra field, with lengths of its own.
    if (localOff + 30 > cdOff) throw corrupt(label + " has its header outside the archive");
    if (buf.readUInt32LE(localOff) !== LOCAL) throw corrupt(label + " has no local header where the directory says");
    const lnLen = buf.readUInt16LE(localOff + 26), leLen = buf.readUInt16LE(localOff + 28);
    const dataAt = localOff + 30 + lnLen + leLen;
    if (dataAt + compSize > cdOff) throw corrupt(label + " runs past the end of the archive data");
    const raw = buf.subarray(dataAt, dataAt + compSize);
    entries.push({
      name, size, compressedSize: compSize, method, crc,
      data() {
        let out;
        if (method === 0) out = raw;
        else {
          try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }); }
          catch (e) { throw corrupt(label + " does not inflate to its declared " + size + " bytes: " + e.message); }
        }
        if (out.length !== size) throw corrupt(label + " gives " + out.length + " bytes, not the " + size + " it declares");
        if (crc32(out) !== crc) throw corrupt(label + " fails its CRC check");
        return out;
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// files: [{ name, data, deflate? }] → one archive. Times are fixed (1980-01-01 00:00) so the same
// input gives the same bytes.
export function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data);
    const body = f.deflate ? zlib.deflateRawSync(data) : data;
    const method = f.deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);              // version needed: 2.0
    local.writeUInt16LE(0x0800, 6);          // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);              // time
    local.writeUInt16LE(0x21, 12);           // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(off, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const endRec = Buffer.alloc(22);
  endRec.writeUInt32LE(EOCD, 0);
  endRec.writeUInt16LE(files.length, 8);
  endRec.writeUInt16LE(files.length, 10);
  endRec.writeUInt32LE(cd.length, 12);
  endRec.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, endRec]);
}

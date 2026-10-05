// Component definitions and instance master references, as M1 needs them (docs/M1.md D6, D7).
//
// Every COMPONENT record (a Pixso SYMBOL) gets a standalone `components` entry: `set: null`, no
// properties (variant sets are M2a, so a state group stays a FRAME whose masters are standalone
// components, without VARIANT_SET_REJECTED). A library copy keeps its identity (publishFile with
// publishID and the componentKey, measured 40 lowercase hex on every copy); a master of this file's
// own on the internal canvas is soft-deleted and keeps the names of its old path where they resolve.
//
// An INSTANCE record carries `instance: { master }` only: the guid of the master's COMPONENT record,
// or, when the master has no record in this IR, its library identity. M1 builds a placeholder (D6),
// so overrides, property assignments and derived boxes are not written.
import { guidStr, guidSet } from "./util.mjs";

const FILE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const GUID = /^\d+:\d+$/;

export function libraryOf(n) {
  if (!n || !(typeof n.publishFile === "string" && FILE_KEY.test(n.publishFile))) return null;
  const o = { publishFile: n.publishFile };
  if (guidSet(n.publishID) && GUID.test(guidStr(n.publishID))) o.publishID = guidStr(n.publishID);
  if (typeof n.componentKey === "string" && HEX40.test(n.componentKey)) o.componentKey = n.componentKey;
  if (typeof n.sharedSymbolVersion === "string" && o.publishID) o.sharedSymbolVersion = n.sharedSymbolVersion;
  if (!o.publishID && !o.componentKey) return null;
  return o;
}

// The `components` entry of the COMPONENT record at index i, for the stored node n.
export function componentEntry(cx, i, n, internal) {
  const c = { node: i, set: null };
  const lib = libraryOf(n);
  if (lib) c.library = lib;
  else if (internal) {
    c.deleted = true;
    const names = (n.ancestorPathBeforeDeletion || []).map((g) => cx.byGuid.get(guidStr(g))).filter((x) => x && typeof x.name === "string").map((x) => x.name);
    if (names.length) c.ancestorPath = names;
  }
  return c;
}

// The master reference of an instance: { guid } when the master has a COMPONENT record, else its
// library identity, else null (the master cannot be named).
export function masterRef(cx, n) {
  const sid = n.symbolData && guidSet(n.symbolData.symbolID) ? guidStr(n.symbolData.symbolID) : null;
  if (!sid) return null;
  if (cx.componentGuids.has(sid)) return { guid: sid };
  const lib = libraryOf(cx.byGuid.get(sid));
  return lib ? { library: lib } : null;
}

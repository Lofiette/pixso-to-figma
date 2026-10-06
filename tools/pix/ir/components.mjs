// Component definitions, variant sets and instance master references (docs/M1.md D6, D7; docs/M2A.md
// D2, D3, §5.3). Part A owns this file in M2a (docs/M2A.md §9); part P0 wired it to the seam.
//
// Every COMPONENT record (a Pixso SYMBOL) gets a `components` entry, every COMPONENT_SET record a
// `sets` entry. The family index (cx.families, families.mjs, part A) says which state groups are sets:
// a member of an accepted set names its set and its coordinate; any other component is standalone
// (`set: null`) and declares its family's roots (part B's propertiesOf, written only when there are
// any). A set declares its roots on its entry. A library copy keeps its identity (publishFile with
// publishID and the componentKey, measured 40 lowercase hex on every copy), and so does a set copied
// from a library; a master of this file's own on the internal canvas is soft-deleted and keeps the
// names of its old path where they resolve.
//
// An INSTANCE record's master reference is the guid of the master's COMPONENT record, or, when the
// master has no record in this IR, its library identity (masterRef). The rest of an instance's data
// is part C's (overrides.mjs).
import { guidStr, guidSet } from "./util.mjs";
import { propertiesOf } from "./properties.mjs";

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

// The `sets` entry of the COMPONENT_SET record at index i, for the stored state group n. The seam
// calls it only for a group cx.families accepted.
export function setEntry(cx, i, n) {
  const g = guidStr(n.guid);
  const a = cx.families.accepted.get(g);
  if (!a) throw new Error("components: " + g + " is a COMPONENT_SET record but not an accepted set");
  const s = { node: i, axes: a.axes.map((x) => ({ name: x.name, values: x.values.slice() })), properties: propertiesOf(cx, g) };
  const lib = libraryOf(n);
  if (lib) s.library = lib;
  return s;
}

// The `components` entry of the COMPONENT record at index i, for the stored node n.
export function componentEntry(cx, i, n, internal) {
  const g = guidStr(n.guid);
  const setGuid = cx.families ? cx.families.setOf(g) : null;
  const c = { node: i, set: null };
  if (setGuid !== null && setGuid !== undefined) {
    const si = cx.setIndex ? cx.setIndex.get(setGuid) : undefined;
    if (si === undefined) throw new Error("components: " + g + " is a member of " + setGuid + ", which has no COMPONENT_SET record");
    c.set = si;
    c.variant = Object.assign({}, cx.families.accepted.get(setGuid).variant.get(g));
  } else {
    const props = propertiesOf(cx, cx.families ? cx.families.familyOf(g) : g);
    if (props.length) c.properties = props;
  }
  const lib = libraryOf(n);
  if (lib) c.library = lib;
  else if (internal) {
    c.deleted = true;
    const names = (n.ancestorPathBeforeDeletion || []).map((x) => cx.byGuid.get(guidStr(x))).filter((x) => x && typeof x.name === "string").map((x) => x.name);
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

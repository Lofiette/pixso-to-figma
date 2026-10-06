// .pix → IR version 3 (docs/M1.md §6 A, docs/M2A.md §5.3, docs/IR.md).
//
//   import { pixToIR } from "./pix/ir/index.mjs";
//   const { ir, stats } = pixToIR(readFileSync(file), { settings: { booleans: "auto" } });
//
// settings (docs/M1.md §3; each defaults to schema.SETTING_DEFAULTS):
//   booleans            auto | native | flatten       (D5)
//   spaceEvenlySingle   between | center              (D14)
//   textFit             widen | source-box            (decision 9; recorded in the header for the builder)
//   scope               "file" | "pages:<guid>,<guid>…" (the chosen pages or top-level objects; every master
//                       an instance in scope names is carried with its top-level object)
//   mode                design | kit                  (recorded only; M1 reads both alike)
//   the thirteen M2a settings (docs/M2A.md §3; schema.M2A_SETTINGS, each defaulting to SETTING_DEFAULTS):
//   variantSets parse | frames, variantGrammar names | vocabulary, axisOrder vocabulary | names,
//   swapDangling skip | strict, swapReset on | off, swapFallback derived | off, swapDefault layer | definition,
//   rejectedProps copy | none, defaultAssignments keep | drop, overrideMerge last | first | outer,
//   echo drop | keep, instanceOwn overrides | own, derivedGeometry changed | all | none
//
// THE M2a SEAM (docs/M2A.md §4, §5.3), each hook a module of its own with its contract in its header:
//   plan (M1) -> familyIndex (families.mjs, part A) -> propIndex (propindex.mjs, P0, then part B)
//   -> makeResolver (resolve.mjs, part C) -> emit (nodes.mjs: recordType, bindingsOf, sets and
//   components through components.mjs) -> the instance pass: instanceData (overrides.mjs, part C) for
//   every INSTANCE record, once every record has its index (cx.indexOf). The hooks are on cx as
//   cx.families, cx.props and cx.resolver, and fill their counters on cx.m2a (= stats.m2a). With the
//   stubs P0 wrote, the IR equals M1's apart from the header's version and settings.
// Under a pages scope the closure that pulls in each instance's master also pulls in every symbol an
// override entry swaps to and every symbol an assignment or a definition default names (D12).
//
// The IR holds no wall-clock time and is written in a fixed order, so two runs on one file give the
// same bytes. It is checked with tools/ir/validate.mjs before it is returned; a reader bug fails
// here, not in Figma. A damaged file throws PIX_CORRUPT (or PIX_UNSUPPORTED) from tools/pix/read.mjs,
// tools/pix/network.mjs or the text checks, and nothing is returned.
//
// stats (never written into the IR):
//   { ms: { unzip, zstd, kiwi, ir }, stored, byType, notes: { code: n }, unsupported: { feature: n },
//     images: { referenced, present, missing, hashMismatch, formats },
//     sides: { population, checked, agree, unproven, noOracle: { noPath, dashed, small } },
//     booleans: { native, flattened, foldedNodes, degenerate },
//     notCarried: { pages, directories, documents, styleDefinitions, variables, unsupported, foldedOperands,
//                   degenerate, outOfScope },
//     populations: { userTop, userMasters, mastersNoInstance, mastersWithInstanceInternal, internalLoose,
//                    stateGroupsInternal, lostBorder }   (IR indices; tools/pix/ir/populations.mjs)
//     populationCounts, records, nonInstance, instances, vectors, text, spaceEvenly, strokeAlignDecided,
//     cornerRadiusOnly, lostBorderSections, counterFillKeptFixed,
//     styles: { fill | stroke | effect: { same, styleWins, missing, noValue } } (tools/pix/ir/styles.mjs),
//     m2a: newM2aStats() below, filled by parts A-C (docs/M2A.md §6) }
//   ms also holds m2a: { families, props, resolve, instances }, the M2a phases inside ms.ir.
// The balance of docs/M1.md §8.2: stored = records + notCarried (every term), checked here.
import { createHash } from "node:crypto";
import { readPix, childrenByParent } from "../read.mjs";
import { corrupt } from "../../kiwi.mjs";
import { CODE, FORMAT, VERSION, SETTINGS, SETTING_DEFAULTS, SETTING_KEYS, M2A_SETTINGS, NOTE_CLASSES, REASON_CODES, INTERNED_PROPS, canonicalJSON } from "../../ir/schema.mjs";
import { validate } from "../../ir/validate.mjs";
import { enumReader, STRUCTURE_TYPES } from "./enums.mjs";
import { backgroundOf } from "./paints.mjs";
import { guidStr, guidSet } from "./util.mjs";
import { plan, resolveInstances, dropUnresolved, emit } from "./nodes.mjs";
import { imageTable } from "./images.mjs";
import { populations, populationCounts } from "./populations.mjs";
import { familyIndex } from "./families.mjs";
import { propIndex } from "./propindex.mjs";
import { makeResolver } from "./resolve.mjs";
import { instanceData } from "./overrides.mjs";

export const READER_SETTINGS = ["booleans", "spaceEvenlySingle", "textFit", "scope", "mode"].concat(M2A_SETTINGS);

export function readerSettings(given) {
  const m2a = {};
  for (const k of M2A_SETTINGS) m2a[k] = SETTING_DEFAULTS[k];
  const s = Object.assign({ booleans: SETTING_DEFAULTS.booleans, spaceEvenlySingle: SETTING_DEFAULTS.spaceEvenlySingle,
    textFit: SETTING_DEFAULTS.textFit, scope: "file", mode: "design" }, m2a, given || {});
  for (const k of Object.keys(s)) {
    if (READER_SETTINGS.indexOf(k) < 0) throw new Error("pixToIR: unknown setting " + JSON.stringify(k) + "; one of " + READER_SETTINGS.join(", "));
    if (k === "scope") {
      if (!(s.scope === "file" || /^pages:\d+:\d+(,\d+:\d+)*$/.test(s.scope))) throw new Error("pixToIR: scope is file or pages:<guid>,<guid>… ; got " + JSON.stringify(s.scope));
    } else if (SETTINGS[k].indexOf(s[k]) < 0) throw new Error("pixToIR: setting " + k + " is one of " + SETTINGS[k].join(", ") + "; got " + JSON.stringify(s[k]));
  }
  return s;
}

const style0 = () => ({ same: 0, styleWins: 0, missing: 0, noValue: 0 });
const zeros = (list) => list.reduce((o, k) => { o[k] = 0; return o; }, {});

// stats.m2a: the counters parts A, B and C fill on cx.m2a (docs/M2A.md §6 A-C), frozen in shape here by
// part P0. Every key starts at 0 (or {} for counts by field); a class map holds every class of its
// note code (schema NOTE_CLASSES). m2a-accept (part D) reads them (docs/M2A.md §8).
export function newM2aStats() {
  const fieldsByClass = () => NOTE_CLASSES.OVERRIDE_FIELD_DROPPED.reduce((o, k) => { o[k] = {}; return o; }, {});
  return {
    families: { groups: 0, accepted: 0, rejected: zeros(NOTE_CLASSES.VARIANT_SET_REJECTED), rejectedMembers: 0, valuesAppended: 0,
      vocabularyOrder: 0, namesOrder: 0 },
    properties: { roots: 0, liftedMemberRoots: 0, copiedRoots: 0, aliases: 0, viaAlias: 0, unnamedRoots: 0, declaredNotRoot: 0,
      bindings: { total: 0, kept: 0, dropped: zeros(NOTE_CLASSES.PROPERTY_REF_DROPPED) }, swapDefaultFromLayer: 0,
      swapDefaultLayersDisagree: { roots: 0, layers: 0 }, boundLayerDiffers: { text: 0, visible: 0 },
      swapDangling: zeros(NOTE_CLASSES.SWAP_VALUE_DANGLING), preferred: { inFile: 0, byKeyOnly: 0, stringValuesDropped: 0 },
      assignments: { total: 0, kept: 0, droppedWithEntry: 0, merged: 0, dangling: 0, defaultDropped: 0, richTextFlattened: 0,
        stale: zeros(NOTE_CLASSES.STALE_ASSIGNMENT) } },
    instances: { instances: 0, notCarried: 0, noDerived: 0, exposed: 0, exposedOutside: 0, scaled: 0, ownDiffers: 0 },
    overrides: { entries: 0, root: 0, emptyPath: 0, nonRoot: 0, live: 0, stale: zeros(NOTE_CLASSES.OVERRIDE_STALE), resolvedNotDerived: 0,
      inDerivedUnresolved: 0, distinctLivePaths: 0, mergedAway: 0, written: 0, emptyAfterTranslation: 0, pinned: 0, merged: { paths: 0, conflicts: 0 },
      rootBox: { echo: 0, differs: 0 }, boundConflicts: 0,
      pixsoFields: { total: 0, translated: 0, consumed: 0, dropped: fieldsByClass() },
      fields: { produced: 0, carried: 0, echo: {}, byClass: { applies: 0, unprobed: 0, refused: 0 } },
      swaps: { override: 0, property: 0, sameSet: 0, noOp: 0, unresolved: 0, dropped: 0, pinned: 0 } },
    derived: { entries: 0, resolved: 0, viaFallback: 0, unresolved: 0, written: 0, empty: 0, noAt: 0, noTransform: 0, noSize: 0,
      withLines: 0, withOracleSides: 0, geometry: 0 },
  };
}

function newStats() {
  return {
    ms: { unzip: 0, zstd: 0, kiwi: 0, ir: 0, m2a: { families: 0, props: 0, resolve: 0, instances: 0 } }, stored: 0, byType: {}, notes: {}, unsupported: {},
    images: null,
    sides: { population: 0, checked: 0, agree: 0, unproven: 0, noOracle: { noPath: 0, dashed: 0, small: 0 } },
    booleans: { native: 0, flattened: 0, foldedNodes: 0, degenerate: 0 },
    notCarried: { pages: 0, directories: 0, documents: 0, styleDefinitions: 0, variables: 0, unsupported: 0, foldedOperands: 0, degenerate: 0, outOfScope: 0 },
    populations: null, populationCounts: null, records: 0, nonInstance: 0, instances: 0,
    vectors: { networks: 0, fromNetwork: 0, fromGeometry: 0, loopsClosed: 0, loopsDropped: 0, regionFills: 0, classes: { "region-no-fill": 0, "network-bounds": 0, winding: 0 } },
    text: { fontFromStyle: 0, rawLineHeight: 0, percentOneAuto: 0, styleValueOverridden: 0, trailingBaseStyleIds: 0 },
    spaceEvenly: { between: 0, single: 0 }, strokeAlignDecided: {}, cornerRadiusOnly: {}, lostBorderSections: 0, counterFillKeptFixed: 0,
    styles: { fill: style0(), stroke: style0(), effect: style0() },
    m2a: newM2aStats(),
  };
}

export function pixToIR(buffer, opts) {
  const settings = readerSettings(opts && opts.settings);
  const pix = opts && opts.pix ? opts.pix : readPix(buffer);
  const stats = newStats();
  stats.ms.unzip = pix.stats.unzipMs || 0;
  stats.ms.zstd = pix.stats.zstdMs || 0;
  stats.ms.kiwi = pix.stats.decodeMs || 0;
  const t0 = Date.now();
  const en = enumReader(pix.schema);
  const typeOf = en("PixsoNode", "type");
  const typeName = (n) => typeOf(n.type);
  stats.stored = pix.nodes.length;
  for (const n of pix.nodes) { const t = typeName(n) || "unknown"; stats.byType[t] = (stats.byType[t] || 0) + 1; }

  const byGuid = new Map(pix.nodes.map((n) => [guidStr(n.guid), n]));
  const kids = childrenByParent(pix.nodes);
  const childrenOf = (n) => kids.get(guidStr(n.guid)) || [];

  // ---------- the reader's context ----------
  const values = [], valueIndex = new Map();
  const fonts = [], fontSeen = new Set();
  const hashes = [], hashSeen = new Set();
  const notes = [];
  const cx = {
    pix, en, settings, stats, byGuid, childrenOf, typeName, at: undefined, featured: null, componentGuids: new Set(),
    // The M2a seam (docs/M2A.md §5.3): set below, before emit; indexOf before the instance pass.
    m2a: stats.m2a, planned: null, families: null, props: null, resolver: null, setIndex: new Map(), indexOf: null,
    glyphChecked: new Set(), styles: [], styleIds: new Map(), styleGuids: new Map(),
    blob(i) {
      if (i === undefined || i === null) return null;
      if (!(Number.isInteger(i) && i >= 0 && i < pix.blobs.length)) throw corrupt("a path names blob " + i + "; there are " + pix.blobs.length);
      return pix.blobs[i];
    },
    value(v) {
      const k = canonicalJSON(v);
      let i = valueIndex.get(k);
      if (i === undefined) { i = values.length; values.push(v); valueIndex.set(k, i); }
      return i;
    },
    rangeValue(k, v) { return INTERNED_PROPS.indexOf(k) >= 0 ? cx.value(v) : v; },
    font(f) { const k = f.family + "\u0000" + f.style; if (!fontSeen.has(k)) { fontSeen.add(k); fonts.push({ family: f.family, style: f.style }); } },
    imageRef(h) { if (!hashSeen.has(h)) { hashSeen.add(h); hashes.push(h); } },
    note(code, detail) { push(code, { node: cx.at, detail }); },
    noteGuid(code, guid, detail) { push(code, { guid, detail }); },
    noteFile(code, detail) { push(code, { detail }); },
    // A note with an explicit record and, optionally, a guidPath inside that instance (the instance
    // pass runs with no current record; docs/M2A.md §5.3).
    noteAt(code, where) { push(code, { node: where.node, guid: where.guid, path: where.path, detail: where.detail }); },
    // A Pixso feature Figma lacks, on the current record: counted, and noted once per record.
    feature(name, detail) {
      cx.featureCount(name);
      if (cx.at === undefined) return;
      if (cx.featured.has(name)) return;
      cx.featured.add(name);
      cx.note(CODE_SFU, detail ? name + ": " + detail : name);
    },
    featureCount(name) { stats.unsupported[name] = (stats.unsupported[name] || 0) + 1; },
  };
  // The one way the reader records a code (docs/M1.md §5.1): an unknown code throws.
  function push(code, where) {
    if (!Object.prototype.hasOwnProperty.call(REASON_CODES, code)) throw new Error("note(): unknown reason code " + JSON.stringify(code));
    const nt = { code };
    if (where.node !== undefined) nt.node = where.node;
    if (where.guid !== undefined) nt.guid = where.guid;
    if (where.path !== undefined) nt.path = where.path.slice();
    if (where.detail !== undefined && where.detail !== null) nt.detail = String(where.detail);
    notes.push(nt);
    stats.notes[code] = (stats.notes[code] || 0) + 1;
  }

  // ---------- pages ----------
  // Roots are the nodes whose parent is not stored (the document itself is not, in any measured
  // file). A DIRECTORY is a folder of pages and a DOCUMENT a root: both are transparent.
  const roots = pix.nodes.filter((n) => !n.parentIndex || !byGuid.has(guidStr(n.parentIndex.guid)));
  const pos = (n) => (n.parentIndex ? n.parentIndex.position : "");
  roots.sort((a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0));
  const pageNodes = [];
  const NC = stats.notCarried;
  const visitRoot = (n) => {
    const t = typeName(n);
    if (t === "CANVAS") { NC.pages++; pageNodes.push({ canvas: n, guid: guidStr(n.guid), internal: !!n.internalOnly }); return; }
    if (t === "DIRECTORY" || t === "DOCUMENT") { NC[t === "DIRECTORY" ? "directories" : "documents"]++; for (const k of childrenOf(n)) visitRoot(k); return; }
    // A node outside every page cannot be placed.
    cx.noteGuid(CODE_NTU, guidStr(n.guid), "a " + (t || "unknown") + " node outside every page, and its subtree");
    const count = (x) => { let c = 1; for (const k of childrenOf(x)) c += count(k); return c; };
    NC.unsupported += count(n);
  };
  for (const r of roots) visitRoot(r);

  // ---------- scope ----------
  let selected = null;               // null: the whole file
  if (settings.scope !== "file") {
    const ids = settings.scope.slice(6).split(",");
    selected = new Set(ids);
    for (const id of ids) if (!byGuid.has(id)) throw new Error("pixToIR: scope names " + id + ", which is not in the file");
  }
  const topOf = (n) => { let x = n; while (x.parentIndex) { const p = byGuid.get(guidStr(x.parentIndex.guid)); if (!p || STRUCTURE_TYPES.indexOf(typeName(p)) >= 0) break; x = p; } return x; };
  const inScope = (pg, top) => !selected || selected.has(pg.guid) || selected.has(guidStr(top.guid));

  // Under a pages scope, the top-level object of every master an instance in scope names joins it,
  // until nothing more is needed, so every instance's master can be named. Since IR version 3 the
  // closure follows every symbol a node can make the IR name (docs/M2A.md D12): the master, the
  // targets of its override entries' swaps, and the symbols its assignments (its own and its entries')
  // and its property definitions' defaults name. It follows every entry, live or stale: a superset of
  // D12's "along live paths", which only the resolver can tell apart, and harmless (one more top-level
  // object at worst).
  if (selected) {
    const queue = [...selected].map((g) => byGuid.get(g));
    const pull = (sid) => {
      if (!sid || !byGuid.has(sid) || typeName(byGuid.get(sid)) !== "SYMBOL") return;
      const top = topOf(byGuid.get(sid));
      const g = guidStr(top.guid);
      if (STRUCTURE_TYPES.indexOf(typeName(top)) < 0 && !selected.has(g)) { selected.add(g); queue.push(top); }
    };
    const guidOf = (x) => (x && guidSet(x) ? guidStr(x) : null);
    const valueOf = (a) => (a && a.value ? guidOf(a.value.guidValue) : null);
    while (queue.length) {
      const n = queue.pop();
      const sd = n.symbolData;
      if (sd && sd.symbolID) pull(guidStr(sd.symbolID));
      for (const e of (sd && sd.symbolOverrides) || []) {
        pull(guidOf(e.overriddenSymbolID));
        for (const a of e.componentPropAssignment || []) pull(valueOf(a));
      }
      for (const a of n.componentPropAssignment || []) pull(valueOf(a));
      for (const d of n.componentPropDef || []) pull(d && d.initialValue ? guidOf(d.initialValue.guidValue) : null);
      for (const k of childrenOf(n)) queue.push(k);
    }
  }
  const planned = plan(cx, pageNodes, inScope);
  resolveInstances(cx, planned);
  dropUnresolved(cx, planned);
  // Pages with nothing in scope are left out under a pages scope.
  const keptPages = selected ? planned.filter((pg) => pg.tops.length || selected.has(pg.page.guid)) : planned;

  // ---------- the M2a hooks (docs/M2A.md §5.3), timed per phase ----------
  const phase = (name, fn) => { const t = Date.now(); const r = fn(); stats.ms.m2a[name] += Date.now() - t; return r; };
  cx.planned = keptPages;
  cx.families = phase("families", () => familyIndex(cx));
  cx.props = phase("props", () => propIndex(cx));
  cx.resolver = phase("resolve", () => makeResolver(cx));

  // ---------- records ----------
  const out = { records: [], meta: [], components: [], sets: [] };
  emit(cx, keptPages, out);
  const pages = keptPages.map((pg) => {
    const o = { guid: pg.page.guid, name: typeof pg.page.canvas.name === "string" ? pg.page.canvas.name : "", internal: pg.page.internal };
    const bg = backgroundOf(cx, pg.page.canvas);
    if (bg) o.background = cx.value(bg);
    return o;
  });

  // ---------- the instance pass (docs/M2A.md §4, §5.3) ----------
  // Once every record has its index: `at` and the echo baseline read master records, which usually sit
  // on the internal canvas and are emitted after the user pages. Notes carry an explicit node and path.
  const indexOfGuid = new Map(out.records.map((r, i) => [r.guid, i]));
  cx.indexOf = (g) => indexOfGuid.get(g);
  phase("instances", () => {
    out.records.forEach((r, i) => {
      if (r.type !== "INSTANCE") return;
      r.instance = instanceData(cx, byGuid.get(r.guid), i, r.instance.master, cx.indexOf);
    });
  });
  const { images, stats: imageStats } = imageTable(cx, hashes);
  stats.images = imageStats;

  const ir = {
    header: {
      format: FORMAT,
      version: VERSION,
      source: { kind: "pix", sha256: createHash("sha256").update(buffer).digest("hex"), fileKey: null, documentName: pix.document.name.replace(/\.pix$/i, "") },
      scope: selected ? { kind: "pages", ids: settings.scope.slice(6).split(",") } : { kind: "file" },
      // What a .pix provides (IR.md §4), whether or not M1 writes it.
      capabilities: { authoredOverrides: true, resolvedOverrides: false, overrideKeys: true, publishIds: true,
        symbolVersions: true, derivedBoxes: true, inkBounds: false, renders: false },
      settings: headerSettings(settings),
    },
    pages,
    values,
    nodes: out.records,
    sets: out.sets,
    components: out.components,
    styles: cx.styles,
    images,
    fonts,
    notes,
  };

  stats.populations = populations(out.records, out.meta, pages);
  stats.populationCounts = populationCounts(out.records, stats.populations);
  stats.records = out.records.length;
  stats.instances = out.records.filter((r) => r.type === "INSTANCE").length;
  stats.nonInstance = stats.records - stats.instances;
  stats.ms.ir = Date.now() - t0;

  const notCarried = Object.values(NC).reduce((a, b) => a + b, 0);
  if (stats.records + notCarried !== stats.stored) {
    throw new Error("pixToIR: the balance does not add up: " + stats.stored + " stored, " + stats.records + " records + " + notCarried + " not carried (" + JSON.stringify(NC) + ")");
  }
  if (!(opts && opts.skipValidate)) {
    const v = validate(ir);
    if (!v.ok) {
      const e = new Error("pixToIR: the IR does not validate (" + v.errors.length + " errors): " + v.errors.slice(0, 5).map((x) => x.path + ": " + x.message).join("; "));
      e.errors = v.errors;
      throw e;
    }
  }
  return { ir, stats };
}

// The header's settings, every key of schema.SETTING_KEYS in that order: the reader's own, and the
// owner's defaults for the policies the reader does not apply (overrides, drift, deleted, resync, kitmaps).
function headerSettings(settings) {
  const o = {};
  for (const k of SETTING_KEYS) o[k] = Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : SETTING_DEFAULTS[k];
  return o;
}

const CODE_SFU = CODE.SOURCE_FEATURE_UNSUPPORTED;
const CODE_NTU = CODE.NODE_TYPE_UNSUPPORTED;

export { decodeVectorNetwork } from "../network.mjs";

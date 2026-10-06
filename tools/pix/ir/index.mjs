// .pix → IR version 2 (docs/M1.md §6 A, docs/IR.md).
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
//     cornerRadiusOnly, lostBorderSections, counterFillKeptFixed, thinStrokes, staleBooleans,
//     styles: { fill | stroke | effect: { same, styleWins, missing, noValue } } (tools/pix/ir/styles.mjs) }
// The balance of docs/M1.md §8.2: stored = records + notCarried (every term), checked here.
import { createHash } from "node:crypto";
import { readPix, childrenByParent } from "../read.mjs";
import { corrupt } from "../../kiwi.mjs";
import { CODE, FORMAT, VERSION, SETTINGS, SETTING_DEFAULTS, REASON_CODES, INTERNED_PROPS, canonicalJSON } from "../../ir/schema.mjs";
import { validate } from "../../ir/validate.mjs";
import { enumReader, STRUCTURE_TYPES } from "./enums.mjs";
import { backgroundOf } from "./paints.mjs";
import { guidStr } from "./util.mjs";
import { plan, resolveInstances, dropUnresolved, emit } from "./nodes.mjs";
import { imageTable } from "./images.mjs";
import { populations, populationCounts } from "./populations.mjs";
import { staleBooleans } from "../../ir/operands.mjs";

export const READER_SETTINGS = ["booleans", "spaceEvenlySingle", "textFit", "scope", "mode"];

export function readerSettings(given) {
  const s = Object.assign({ booleans: SETTING_DEFAULTS.booleans, spaceEvenlySingle: SETTING_DEFAULTS.spaceEvenlySingle,
    textFit: SETTING_DEFAULTS.textFit, scope: "file", mode: "design" }, given || {});
  for (const k of Object.keys(s)) {
    if (READER_SETTINGS.indexOf(k) < 0) throw new Error("pixToIR: unknown setting " + JSON.stringify(k) + "; one of " + READER_SETTINGS.join(", "));
    if (k === "scope") {
      if (!(s.scope === "file" || /^pages:\d+:\d+(,\d+:\d+)*$/.test(s.scope))) throw new Error("pixToIR: scope is file or pages:<guid>,<guid>… ; got " + JSON.stringify(s.scope));
    } else if (SETTINGS[k].indexOf(s[k]) < 0) throw new Error("pixToIR: setting " + k + " is one of " + SETTINGS[k].join(", ") + "; got " + JSON.stringify(s[k]));
  }
  return s;
}

const style0 = () => ({ same: 0, styleWins: 0, missing: 0, noValue: 0 });

function newStats() {
  return {
    ms: { unzip: 0, zstd: 0, kiwi: 0, ir: 0 }, stored: 0, byType: {}, notes: {}, unsupported: {},
    images: null,
    sides: { population: 0, checked: 0, agree: 0, unproven: 0, noOracle: { noPath: 0, dashed: 0, small: 0 } },
    booleans: { native: 0, flattened: 0, foldedNodes: 0, degenerate: 0 },
    notCarried: { pages: 0, directories: 0, documents: 0, styleDefinitions: 0, variables: 0, unsupported: 0, foldedOperands: 0, degenerate: 0, outOfScope: 0 },
    populations: null, populationCounts: null, records: 0, nonInstance: 0, instances: 0,
    vectors: { networks: 0, fromNetwork: 0, fromGeometry: 0, loopsClosed: 0, loopsDropped: 0, regionFills: 0, vertexRadiusZero: 0, classes: { "region-no-fill": 0, "network-bounds": 0, winding: 0 } },
    text: { fontFromStyle: 0, rawLineHeight: 0, percentOneAuto: 0, styleValueOverridden: 0, trailingBaseStyleIds: 0 },
    spaceEvenly: { between: 0, single: 0 }, strokeAlignDecided: {}, cornerRadiusOnly: {}, lostBorderSections: 0, counterFillKeptFixed: 0, thinStrokes: 0, staleBooleans: 0,
    styles: { fill: style0(), stroke: style0(), effect: style0() },
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
  // until nothing more is needed, so every instance's master can be named.
  if (selected) {
    const queue = [...selected].map((g) => byGuid.get(g));
    while (queue.length) {
      const n = queue.pop();
      const sid = n.symbolData && n.symbolData.symbolID ? guidStr(n.symbolData.symbolID) : null;
      if (sid && byGuid.has(sid)) {
        const top = topOf(byGuid.get(sid));
        const g = guidStr(top.guid);
        if (STRUCTURE_TYPES.indexOf(typeName(top)) < 0 && !selected.has(g)) { selected.add(g); queue.push(top); }
      }
      for (const k of childrenOf(n)) queue.push(k);
    }
  }
  const planned = plan(cx, pageNodes, inScope);
  resolveInstances(cx, planned);
  dropUnresolved(cx, planned);
  // Pages with nothing in scope are left out under a pages scope.
  const keptPages = selected ? planned.filter((pg) => pg.tops.length || selected.has(pg.page.guid)) : planned;

  // ---------- records ----------
  const out = { records: [], meta: [], components: [] };
  emit(cx, keptPages, out);
  // A native boolean whose stored result is out of date against its own operands (a union that leaves
  // one out, and the booleans made from it): VECTOR_ORACLE_DIFFERS boolean-operands, so the judge
  // holds it to its operands (tools/ir/operands.mjs, docs/M1.md §15.13).
  const stale = staleBooleans({ nodes: out.records, values });
  for (const i of [...stale.keys()].sort((a, b) => a - b)) { push(CODE.VECTOR_ORACLE_DIFFERS, { node: i, detail: stale.get(i) }); stats.staleBooleans++; }
  const pages = keptPages.map((pg) => {
    const o = { guid: pg.page.guid, name: typeof pg.page.canvas.name === "string" ? pg.page.canvas.name : "", internal: pg.page.internal };
    const bg = backgroundOf(cx, pg.page.canvas);
    if (bg) o.background = cx.value(bg);
    return o;
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
      settings: { mode: settings.mode, overrides: SETTING_DEFAULTS.overrides, drift: SETTING_DEFAULTS.drift,
        deleted: SETTING_DEFAULTS.deleted, resync: SETTING_DEFAULTS.resync, textFit: settings.textFit,
        booleans: settings.booleans, spaceEvenlySingle: settings.spaceEvenlySingle, kitmaps: SETTING_DEFAULTS.kitmaps },
    },
    pages,
    values,
    nodes: out.records,
    sets: [],
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

const CODE_SFU = CODE.SOURCE_FEATURE_UNSUPPORTED;
const CODE_NTU = CODE.NODE_TYPE_UNSUPPORTED;

export { decodeVectorNetwork } from "../network.mjs";

// The M1 planner: which IR records are built, in which tasks, and whether the counts add up
// (docs/M1.md D1, §5.2, §6 D, §8.2).
//
//   import { planM1 } from "./ir/plan.mjs";
//   const plan = planM1(ir, stats, { m1Scope, settings, images, runId });
//   plan = { tasks, ledger, scope: { built, outOfScope: { population: [i] } }, balance, preflight, populations }
//
//   ir        a validated IR (tools/ir/validate.mjs)
//   stats     part A's pixToIR stats (populations, notCarried, stored), or null: then the populations
//             are derived from the IR alone (derivePopulations) and the stored-node equation cannot
//             be checked, so it does not add up (G4 fails, by design)
//   m1Scope   "default" | "all-masters" | "all" (M1_SCOPES)
//   settings  { textFit, layoutOrder, textRead, fallbackFont, maxTaskMb, ceilingMsPerNode, scope }, each
//             defaulting to docs/M1.md §3 (PLAN_DEFAULTS); scope is "file" or "pages:<guid,…>" (page
//             guids or top-level record guids)
//   images    the image table of resolveImages (tools/ir/images.mjs); without one, tableFromIR
//   runId     16 lowercase hex; random when absent (pass one for byte-identical task text)
//
// tasks are task objects (tools/ir/task.mjs): a fonts task first, then per page group a build task
// followed by its verify task, the service page (S2) before the user pages (S1); where a root is split
// across tasks, the chain's build tasks come first and their verify tasks after them, in the same
// order. ledger[k] describes tasks[k] for states.json: { taskNo, op, roots: [IR index], nodes,
// ceilingMs }, and a verify's entry names its build task (build: taskNo).
//
// Which records are built. Every record is claimed by exactly one population (POPULATIONS):
//   user                         every record on a user page (S1: built, always)
//   mastersNoInstance            internal masters with no instance in their subtree (S2: built by default)
//   mastersWithInstanceInternal  internal masters with an instance (built under all-masters and all)
//   internalLoose                other internal top-level nodes (built under all)
//   stateGroupsInternal          internal state-group frames, the frame itself (built under all)
//   internalUnclassified         an internal record no population names (built under all)
//   notInScope                   a user page or object --scope leaves out (never built)
//   notBuildable                 a type M1 does not build (not in BUILT_TYPE) and its subtree (never)
// An internal record belongs to the nearest ancestor-or-self that a population lists, so a state
// group's frame is one population and each master in it another. Population lists come from
// stats.populations (part A; internal ones taken on internal pages only), or derivePopulations.
// Built records whose parent is not built are roots: on a user page they are top-level records; on
// the service page they attach to the page at a grid place. A root whose subtree is over the size
// cap is split at child boundaries: the later pieces attach to their built parent ({ i, guid }).
import { randomBytes } from "node:crypto";
import { CODE, INTERNED_PROPS, ORACLE_PROPS, snapshotId } from "./schema.mjs";
import { BUILT_TYPE, SERVICE_PAGE_GUID, TASK_FORMAT, TASK_IR_VERSION, TASK_SETTING_DEFAULTS,
  TASK_VERSION, maxTaskChars, taskChars } from "./task.mjs";
import { tableFromIR } from "./images.mjs";
import { count } from "./runstate.mjs";

export const M1_SCOPES = ["default", "all-masters", "all"];
export const POPULATIONS = ["user", "mastersNoInstance", "mastersWithInstanceInternal", "internalLoose", "stateGroupsInternal",
  "internalUnclassified", "notInScope", "notBuildable"];
const INTERNAL_POPS = ["mastersNoInstance", "mastersWithInstanceInternal", "stateGroupsInternal", "internalLoose"];
export const BUILT_BY_SCOPE = {
  default: ["user", "mastersNoInstance"],
  "all-masters": ["user", "mastersNoInstance", "mastersWithInstanceInternal"],
  all: ["user", "mastersNoInstance", "mastersWithInstanceInternal", "internalLoose", "stateGroupsInternal", "internalUnclassified"],
};
export const PLAN_DEFAULTS = Object.freeze({ textFit: TASK_SETTING_DEFAULTS.textFit, layoutOrder: TASK_SETTING_DEFAULTS.layoutOrder,
  textRead: TASK_SETTING_DEFAULTS.textRead, fallbackFont: TASK_SETTING_DEFAULTS.fallbackFont, maxTaskMb: 4, ceilingMsPerNode: 20,
  scope: "file" });
export const CEILING_BASE_MS = 120000;
export const SERVICE_PAGE_NAME = "pix2fig service: S2 masters";
export const GRID = Object.freeze({ gap: 200, rowWidth: 20000 });
// An upper bound of one roots[] entry ({ i, attachTo: { i, guid }, place: [x, y] }) in characters.
const ROOT_ENTRY = 128;

const own = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

// The populations from the IR alone, where part A's stats are not at hand: on an internal page, a
// top-level COMPONENT is a master, a top-level FRAME whose children are all COMPONENTs is a state
// group (its children masters), anything else top-level is loose; a master is "with instance" when
// its subtree holds an INSTANCE. Returns { name: [IR index of each population root] }.
export function derivePopulations(ir) {
  const N = ir.nodes || [];
  const kids = childrenOf(N);
  const pops = { userTop: [], userMasters: [], mastersNoInstance: [], mastersWithInstanceInternal: [], internalLoose: [], stateGroupsInternal: [] };
  const hasInstance = (i) => { const st = [i]; while (st.length) { const j = st.pop(); if (N[j].type === "INSTANCE") return true; st.push(...kids[j]); } return false; };
  const master = (i) => pops[hasInstance(i) ? "mastersWithInstanceInternal" : "mastersNoInstance"].push(i);
  N.forEach((r, i) => {
    if (r.parent !== -1) return;
    const pg = ir.pages[r.page];
    if (!pg || !pg.internal) { pops.userTop.push(i); return; }
    if (r.type === "COMPONENT") master(i);
    else if (r.type === "FRAME" && kids[i].length && kids[i].every((c) => N[c].type === "COMPONENT")) { pops.stateGroupsInternal.push(i); kids[i].forEach(master); }
    else pops.internalLoose.push(i);
  });
  N.forEach((r, i) => { if (r.type === "COMPONENT" && !internalPage(ir, i)) pops.userMasters.push(i); });
  for (const k of Object.keys(pops)) pops[k].sort((a, b) => a - b);
  return pops;
}

function childrenOf(N) {
  const kids = N.map(() => []);
  N.forEach((r, i) => { if (r.parent >= 0) kids[r.parent].push(i); });
  return kids;
}
function topOf(N, i) { let j = i; while (N[j].parent >= 0) j = N[j].parent; return j; }
function internalPage(ir, i) { const pg = ir.pages[ir.nodes[topOf(ir.nodes, i)].page]; return !!(pg && pg.internal); }

// "pages:<a,b>" -> Set of guids; "file" -> null.
export function parseScope(s) {
  if (s === undefined || s === null || s === "file") return null;
  const m = /^pages:(.+)$/.exec(String(s));
  if (!m) throw new RangeError("--scope is file or pages:<guid,…>; got " + JSON.stringify(s));
  const g = m[1].split(",").map((x) => x.trim()).filter(Boolean);
  if (!g.length || !g.every((x) => /^\d+:\d+$/.test(x))) throw new RangeError("--scope pages: takes page or top-level guids, a:b, comma-separated");
  return new Set(g);
}

// population name per record, and the lists' source.
export function claimRecords(ir, stats, scopeSet) {
  const N = ir.nodes || [];
  const derived = !(stats && stats.populations);
  const P = derived ? derivePopulations(ir) : stats.populations;
  const member = new Map();
  for (const name of INTERNAL_POPS) for (const i of P[name] || []) if (Number.isInteger(i) && N[i] && !member.has(i) && internalPage(ir, i)) member.set(i, name);
  const claim = new Array(N.length);
  N.forEach((r, i) => {
    const parentClaim = r.parent >= 0 ? claim[r.parent] : null;
    if (!own(BUILT_TYPE, r.type) || parentClaim === "notBuildable") { claim[i] = "notBuildable"; return; }
    if (parentClaim === "notInScope") { claim[i] = "notInScope"; return; }
    if (r.parent < 0) {
      const pg = ir.pages[r.page];
      if (!pg || !pg.internal) {
        claim[i] = scopeSet && !scopeSet.has(r.guid) && !(pg && scopeSet.has(pg.guid)) ? "notInScope" : "user";
        return;
      }
    } else if (parentClaim === "user") { claim[i] = "user"; return; }
    claim[i] = member.get(i) || parentClaim || "internalUnclassified";
  });
  return { claim, source: derived ? "derived" : "stats", lists: P };
}

// The value indices a record references (oracle props never travel).
function refsOf(rec) {
  const out = [];
  const add = (f) => { for (const k of INTERNED_PROPS) if (ORACLE_PROPS.indexOf(k) < 0 && Number.isInteger(f[k])) out.push(f[k]); };
  add(rec.props || {});
  if (Array.isArray(rec.props && rec.props.textRanges)) for (const r of rec.props.textRanges) if (r && r.fields) add(r.fields);
  return out;
}
function taskNode(rec, i) {
  const props = {};
  for (const k of Object.keys(rec.props || {})) if (ORACLE_PROPS.indexOf(k) < 0) props[k] = rec.props[k];
  return { i, parent: rec.parent, guid: rec.guid, type: rec.type, name: rec.name, props };
}
function walkImages(v, out) {
  if (Array.isArray(v)) { for (const x of v) walkImages(x, out); return; }
  if (!v || typeof v !== "object") return;
  if (v.type === "IMAGE" && typeof v.imageHash === "string") out.add(v.imageHash);
  for (const k of Object.keys(v)) walkImages(v[k], out);
}
const isFont = (v) => v && typeof v.family === "string" && typeof v.style === "string";

export function planM1(ir, stats, opts) {
  const o = opts || {};
  const m1Scope = o.m1Scope || "default";
  if (M1_SCOPES.indexOf(m1Scope) < 0) throw new RangeError("--m1-scope is one of " + M1_SCOPES.join(", ") + "; got " + JSON.stringify(m1Scope));
  const st = Object.assign({}, PLAN_DEFAULTS, { textFit: (ir.header && ir.header.settings && ir.header.settings.textFit) || PLAN_DEFAULTS.textFit }, o.settings || {});
  const cap = o.maxChars || maxTaskChars(Number(st.maxTaskMb));
  const runId = o.runId || randomBytes(8).toString("hex");
  if (!/^[0-9a-f]{16}$/.test(runId)) throw new RangeError("runId is 16 lowercase hex");
  const snapshot = snapshotId(ir.header);
  const N = ir.nodes || [];
  const V = ir.values || [];
  const kids = childrenOf(N);
  const { claim, source, lists } = claimRecords(ir, stats, parseScope(st.scope));
  const builtPops = BUILT_BY_SCOPE[m1Scope];
  const B = claim.map((c) => builtPops.indexOf(c) >= 0);
  const settings = { textFit: st.textFit, layoutOrder: st.layoutOrder, textRead: st.textRead,
    fallbackFont: { family: st.fallbackFont.family, style: st.fallbackFont.style } };
  const imgTable = new Map((o.images || tableFromIR(ir)).map((t) => [t.hash, t]));

  const notesOf = new Map();
  for (const n of ir.notes || []) if (Number.isInteger(n.node)) {
    if (!notesOf.has(n.node)) notesOf.set(n.node, []);
    notesOf.get(n.node).push({ code: n.code, i: n.node, detail: typeof n.detail === "string" ? n.detail : null });
  }

  // ---------- sizes (characters of JSON) ----------
  const nodeSize = N.map((r, i) => JSON.stringify(taskNode(r, i)).length + 1 + (notesOf.get(i) || []).reduce((s, x) => s + JSON.stringify(x).length + 1, 0));
  const valSize = V.map((v, k) => JSON.stringify(String(k)).length + 2 + JSON.stringify(v).length);
  const refs = N.map((r) => refsOf(r));
  const allFonts = [];
  { const seen = new Set(); V.forEach((v) => { if (isFont(v) && !seen.has(v.family + "|" + v.style)) { seen.add(v.family + "|" + v.style); allFonts.push(v); } }); }
  const skeleton = (op) => ({ format: TASK_FORMAT, version: TASK_VERSION, op, runId, taskNo: 99999, of: 99999, snapshot, irVersion: TASK_IR_VERSION, settings,
    page: { index: 99999, guid: SERVICE_PAGE_GUID, name: SERVICE_PAGE_NAME + (ir.pages || []).reduce((m, p) => (String(p.name).length > m.length ? String(p.name) : m), ""), service: false, background: 99999 },
    roots: [], nodes: [], notes: [], values: {}, fonts: allFonts.map((f) => ({ family: f.family, style: f.style })),
    images: [...imgTable.values()].map((t) => ({ hash: t.hash, source: "archive", format: t.format, reason: t.reason })), expect: { count: 9999999, nonInstance: 9999999, placeholders: 9999999 } });
  const overhead = taskChars(skeleton("verify")) + 64;
  const budget = cap - overhead;
  if (budget <= 0) throw new RangeError("the task size cap (" + cap + " characters) leaves no room for records");

  // ---------- page groups and roots ----------
  const groups = new Map();  // key -> { key, page, roots: [i] }
  N.forEach((r, i) => {
    if (!B[i] || (r.parent >= 0 && B[r.parent])) return;
    const internal = internalPage(ir, i);
    const key = internal ? "service" : "page:" + N[topOf(N, i)].page;
    if (!groups.has(key)) {
      const pi = N[topOf(N, i)].page, pg = ir.pages[pi];
      groups.set(key, { key, service: internal, pageIndex: internal ? null : pi,
        page: internal ? { index: null, guid: SERVICE_PAGE_GUID, name: SERVICE_PAGE_NAME, service: true, background: null }
          : { index: pi, guid: pg.guid, name: pg.name, service: false, background: Number.isInteger(pg.background) ? pg.background : null },
        roots: [] });
    }
    groups.get(key).roots.push(i);
  });
  const ordered = [...groups.values()].sort((a, b) => (a.service !== b.service ? (a.service ? -1 : 1) : a.pageIndex - b.pageIndex));

  // The S2 grid on the service page, in IR order.
  const place = new Map();
  for (const g of ordered) if (g.service) {
    let x = 0, y = 0, rowH = 0;
    for (const i of g.roots) {
      const w = Math.max(0, N[i].props.width || 0), h = Math.max(0, N[i].props.height || 0);
      if (x > 0 && x + w > GRID.rowWidth) { x = 0; y += rowH + GRID.gap; rowH = 0; }
      place.set(i, [x, y]);
      x += w + GRID.gap;
      rowH = Math.max(rowH, h);
    }
  }

  // ---------- packing ----------
  const buckets = [];
  for (const g of ordered) {
    let cur = null;
    const fresh = () => ({ group: g, recs: [], inSet: new Set(), vals: new Set(), size: 0 });
    const flush = () => { if (cur && cur.recs.length) buckets.push(cur); cur = fresh(); };
    cur = fresh();
    const bgCost = g.page.background !== null ? valSize[g.page.background] || 0 : 0;
    const costOf = (b, list) => {
      let c = b.recs.length ? 0 : bgCost;
      const seen = new Set();
      for (const i of list) {
        c += nodeSize[i];
        for (const v of refs[i]) if (!b.vals.has(v) && !seen.has(v)) { seen.add(v); c += valSize[v] || 0; }
      }
      if (!b.inSet.has(N[list[0]].parent)) c += ROOT_ENTRY;
      return c;
    };
    const add = (b, list, c) => {
      for (const i of list) { b.recs.push(i); b.inSet.add(i); for (const v of refs[i]) b.vals.add(v); }
      b.size += c;
    };
    const subtree = (i) => { const out = []; const st = [i]; while (st.length) { const j = st.pop(); out.push(j); for (let k = kids[j].length - 1; k >= 0; k--) if (B[kids[j][k]]) st.push(kids[j][k]); } return out; };
    const process = (i) => {
      const sub = subtree(i);
      let c = costOf(cur, sub);
      if (cur.size + c <= budget) { add(cur, sub, c); return; }
      if (cur.recs.length) { flush(); c = costOf(cur, sub); if (c <= budget) { add(cur, sub, c); return; } }
      // Over the cap alone: the record here, its children after it, each where it fits.
      const one = costOf(cur, [i]);
      if (cur.size + one > budget) { flush(); if (costOf(cur, [i]) > budget) throw new RangeError("IR record " + i + " alone is over the task size cap (" + cap + " characters)"); }
      add(cur, [i], costOf(cur, [i]));
      for (const c2 of kids[i]) if (B[c2]) process(c2);
    };
    for (const r of g.roots) process(r);
    flush();
  }

  // ---------- tasks ----------
  const assemble = (op, b, taskNo) => {
    const recs = b.recs.slice().sort((x, y) => x - y);
    const inT = new Set(recs);
    const vals = new Set();
    const nodes = [], notes = [], roots = [];
    let placeholders = 0;
    for (const i of recs) {
      nodes.push(taskNode(N[i], i));
      if (N[i].type === "INSTANCE") placeholders++;
      for (const v of refs[i]) vals.add(v);
      for (const n of notesOf.get(i) || []) notes.push(n);
      const p = N[i].parent;
      if (!inT.has(p)) {
        const toPage = p < 0 || !B[p];
        roots.push({ i, attachTo: toPage ? "page" : { i: p, guid: N[p].guid }, place: toPage && b.group.service ? place.get(i) || [0, 0] : null });
      }
    }
    if (b.group.page.background !== null) vals.add(b.group.page.background);
    const values = {};
    [...vals].sort((x, y) => x - y).forEach((k) => { values[String(k)] = V[k]; });
    const fonts = [], fseen = new Set(), hashes = new Set();
    for (const k of Object.keys(values)) {
      const v = values[k];
      if (isFont(v) && !fseen.has(v.family + "|" + v.style)) { fseen.add(v.family + "|" + v.style); fonts.push({ family: v.family, style: v.style }); }
      walkImages(v, hashes);
    }
    const images = [...hashes].sort().map((h) => {
      const t = imgTable.get(h);
      return t ? { hash: h, source: t.source, format: t.format, reason: t.reason } : { hash: h, source: "none", format: "unknown", reason: "not in the image table" };
    });
    return { format: TASK_FORMAT, version: TASK_VERSION, op, runId, taskNo, of: 0, snapshot, irVersion: TASK_IR_VERSION, settings,
      page: b.group.page, roots, nodes, notes, values, fonts, images,
      expect: { count: nodes.length, nonInstance: nodes.length - placeholders, placeholders } };
  };

  const builtIdx = []; N.forEach((r, i) => { if (B[i]) builtIdx.push(i); });
  const fontsTask = assemble("fonts", { recs: builtIdx, group: { page: { background: null }, service: false } }, 1);
  Object.assign(fontsTask, { page: null, roots: [], nodes: [], notes: [], values: {}, images: [], expect: null });
  const tasks = [fontsTask];
  // A root split across buckets makes a chain (a bucket whose root attaches to a record of an earlier
  // one joins that one's chain). A chain's builds go first and its verifies after them, so every
  // verify sees the tree with all its pieces attached: the parent's size and flow after the later
  // appends, as well as each piece in place (docs/M1.md §15, review S1).
  const holder = new Map(), up = buckets.map((_, k) => k);
  const find = (a) => { while (up[a] !== a) a = up[a]; return a; };
  buckets.forEach((b, k) => { for (const i of b.recs) holder.set(i, k); });
  buckets.forEach((b, k) => {
    for (const i of b.recs) {
      const p = N[i].parent;
      if (p >= 0 && B[p] && !b.inSet.has(p) && holder.has(p)) { const x = find(k), y = find(holder.get(p)); if (x !== y) up[Math.max(x, y)] = Math.min(x, y); }
    }
  });
  const buildOf = new Map();
  const emitted = new Set();
  buckets.forEach((b, k) => {
    const c = find(k);
    if (emitted.has(c)) return;
    emitted.add(c);
    const chain = buckets.map((_, j) => j).filter((j) => find(j) === c);
    const nos = chain.map((j) => { const t = assemble("build", buckets[j], tasks.length + 1); tasks.push(t); return t.taskNo; });
    chain.forEach((j, q) => { const t = assemble("verify", buckets[j], tasks.length + 1); tasks.push(t); buildOf.set(t.taskNo, nos[q]); });
  });
  for (const t of tasks) t.of = tasks.length;
  const perNode = Number(st.ceilingMsPerNode);
  const ledger = tasks.map((t) => Object.assign({ taskNo: t.taskNo, op: t.op, roots: t.roots.map((r) => r.i), nodes: t.nodes.length,
    ceilingMs: CEILING_BASE_MS + perNode * t.nodes.length }, t.op === "verify" ? { build: buildOf.get(t.taskNo) } : {}));
  let largest = 0;
  for (const t of tasks) {
    const n = taskChars(t);
    if (n > cap) throw new Error("planner: task " + t.taskNo + " is " + n + " characters, over the cap " + cap + " (an estimate was wrong)");
    largest = Math.max(largest, n);
  }

  // ---------- scope, populations, balance ----------
  const outOfScope = {};
  const popStats = {};
  for (const p of POPULATIONS) popStats[p] = { records: 0, nonInstance: 0, instances: 0, built: builtPops.indexOf(p) >= 0 };
  N.forEach((r, i) => {
    const s = popStats[claim[i]];
    s.records++;
    if (r.type === "INSTANCE") s.instances++; else s.nonInstance++;
    if (!B[i]) { if (!outOfScope[claim[i]]) outOfScope[claim[i]] = []; outOfScope[claim[i]].push(i); }
  });
  const planCodes = {};
  const oos = Object.values(outOfScope).reduce((s, l) => s + l.length, 0);
  if (oos) count(planCodes, CODE.OUT_OF_SCOPE, oos);
  const balance = balanceOf(ir, stats, { claim, B, popStats, planCodes });
  const imagesBySource = { archive: 0, mcp: 0, render: 0, none: 0 };
  const neededImages = new Set();
  for (const t of tasks) for (const im of t.images) if (!neededImages.has(im.hash)) { neededImages.add(im.hash); imagesBySource[im.source]++; }
  const lostBorder = (lists && lists.lostBorder) || [];
  const preflight = {
    fonts: fontsTask.fonts,
    images: { referenced: neededImages.size, bySource: imagesBySource },
    populations: popStats, populationSource: source,
    lostBorder: { population: lostBorder.length, inScope: lostBorder.filter((i) => B[i]).length,
      userPages: lostBorder.filter((i) => N[i] && !internalPage(ir, i)).length },
    tasks: { total: tasks.length, build: buckets.length, verify: buckets.length, cap, largest },
    settings: Object.assign({ m1Scope }, st),
  };
  return { tasks, ledger, scope: { built: builtIdx, outOfScope }, balance, preflight, populations: lists };
}

// The reader's not-carried terms (tools/pix/ir/index.mjs notCarried), in the order they are printed.
// A key the reader writes that is not here makes the stored equation fail loudly rather than drift.
export const STORED_TERMS = ["pages", "directories", "documents", "styleDefinitions", "variables", "unsupported", "degenerate",
  "foldedOperands", "outOfScope"];

// The two equations of docs/M1.md §8.2, every term printed, `ok` only when both (and the instance
// split) add up. Without part A's stats the stored-node side is unknown, and that is not ok. The
// stored equation repeats the reader's own check (pixToIR throws when it fails); both are planned
// counts, and gate G4 also holds the built side against the judge's (tools/ir/verdict.mjs).
export function balanceOf(ir, stats, ctx) {
  const N = ir.nodes || [];
  const nc = (stats && stats.notCarried) || null;
  const t = (k) => (nc && Number.isFinite(nc[k]) ? nc[k] : 0);
  const stored = { stored: stats && Number.isFinite(stats.stored) ? stats.stored : null, terms: { records: N.length } };
  for (const k of STORED_TERMS) stored.terms[k] = t(k);
  stored.sum = Object.values(stored.terms).reduce((s, x) => s + x, 0);
  const unknown = nc ? Object.keys(nc).filter((k) => STORED_TERMS.indexOf(k) < 0) : [];
  stored.ok = stored.stored !== null && !!nc && stored.sum === stored.stored && !unknown.length;
  if (!nc || stored.stored === null) stored.why = "part A's stats (stored, notCarried) are not at hand";
  else if (unknown.length) stored.why = "reader term " + unknown.join(", ") + " unknown to the planner";
  const P = ctx.popStats;
  const nonInstance = { ir: N.filter((r) => r.type !== "INSTANCE").length, builtS1: 0, builtS2: 0, outOfScope: {} };
  const instances = { ir: N.filter((r) => r.type === "INSTANCE").length, placeholders: 0, outOfScope: {} };
  N.forEach((r, i) => {
    const inst = r.type === "INSTANCE";
    if (ctx.B[i]) {
      if (inst) instances.placeholders++;
      else if (ctx.claim[i] === "user") nonInstance.builtS1++;
      else nonInstance.builtS2++;
    } else {
      const m = inst ? instances.outOfScope : nonInstance.outOfScope;
      m[ctx.claim[i]] = (m[ctx.claim[i]] || 0) + 1;
    }
  });
  const sumOf = (m) => Object.values(m).reduce((s, x) => s + x, 0);
  nonInstance.sum = nonInstance.builtS1 + nonInstance.builtS2 + sumOf(nonInstance.outOfScope);
  nonInstance.ok = nonInstance.sum === nonInstance.ir;
  instances.sum = instances.placeholders + sumOf(instances.outOfScope);
  instances.ok = instances.sum === instances.ir;
  const notes = {};
  // An image filter Figma has no value for (the reader's "hue filter", "vibrance"), dropped from the
  // paint: counted as FILTER_UNRENDERED on the verdict line (docs/M1.md D10).
  let filtersUnrendered = 0;
  for (const n of ir.notes || []) if (!Number.isInteger(n.node) || ctx.B[n.node]) {
    notes[n.code] = (notes[n.code] || 0) + 1;
    if (n.code === CODE.SOURCE_FEATURE_UNSUPPORTED && typeof n.detail === "string" && /^(hue filter|vibrance)(:|$)/.test(n.detail)) filtersUnrendered++;
  }
  return { ok: stored.ok && nonInstance.ok && instances.ok, stored, nonInstance, instances, notes, filtersUnrendered, planCodes: ctx.planCodes,
    populations: Object.keys(P).reduce((o, k) => { o[k] = P[k].records; return o; }, {}) };
}

// The clean task the runner sends before a build task: its roots' records only, on its page, so that
// roots an earlier run left (another pxRun) are removed before they are built again (part B's clean).
// The roots' notes go with them: a root VECTOR built from geometry is a valid record only next to its
// note (docs/M1.md §5.2), and the plugin validates a clean task like any other (part F: without
// them the plugin refused the clean, and the runner failed the build behind it).
export function cleanTaskFor(build, ir) {
  const N = ir.nodes, V = ir.values || [];
  const rootSet = new Set(build.roots.map((r) => r.i));
  const nodes = build.nodes.filter((n) => rootSet.has(n.i));
  const vals = new Set();
  for (const n of nodes) for (const v of refsOf(N[n.i])) vals.add(v);
  if (build.page && build.page.background !== null) vals.add(build.page.background);
  const values = {};
  [...vals].sort((a, b) => a - b).forEach((k) => { values[String(k)] = V[k]; });
  const fonts = [], seen = new Set(), hashes = new Set();
  for (const k of Object.keys(values)) {
    const v = values[k];
    if (isFont(v) && !seen.has(v.family + "|" + v.style)) { seen.add(v.family + "|" + v.style); fonts.push({ family: v.family, style: v.style }); }
    walkImages(v, hashes);
  }
  const imgs = new Map(build.images.map((m) => [m.hash, m]));
  const notes = (build.notes || []).filter((n) => rootSet.has(n.i)).map((n) => ({ code: n.code, i: n.i, detail: n.detail }));
  return Object.assign({}, build, { op: "clean", nodes, notes, values, fonts, roots: build.roots.map((r) => ({ i: r.i, attachTo: r.attachTo, place: r.place })),
    images: [...hashes].sort().map((h) => imgs.get(h)), expect: null });
}

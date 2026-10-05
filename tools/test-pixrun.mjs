// Part D's tests: the planner, the image chain, the identity check, the read-only script check, the
// run state, the verdict, m1-accept and pix-run (docs/M1.md §6 D).
//
//   node tools/test-pixrun.mjs
//
// Offline: a synthetic IR (below; part A's fixture IR replaces it once part A merges, and part F's
// end-to-end test runs the fixture through every part), the fake Pixso of tools/test/fake-pixso.mjs
// for the MCP links, and a played plugin for the run loop. Nothing reaches Figma or the real Pixso.
// Every hash is computed at run time (docs/REWRITE.md §8).
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE, ORACLE_PROPS } from "./ir/schema.mjs";
import { SERVICE_PAGE_GUID, taskChars } from "./ir/task.mjs";
import { validate, validateTask } from "./ir/validate.mjs";
import { cleanTaskFor, derivePopulations, planM1, PLAN_DEFAULTS, CEILING_BASE_MS } from "./ir/plan.mjs";
import { imageInfo, p8Cases, refusedBy, resolveImages, tableFromIR, carriers, parseLinks } from "./ir/images.mjs";
import { SCRIPTS, assertReadOnlyScript, makeMcpClient, readOnlyProblems } from "./ir/mcp-readonly.mjs";
import { checkIdentity, compareIdentity, sampleGuids } from "./ir/identity.mjs";
import { count, newStates, probeStatus, resumeStates, runTasks, saveStates, splitChains, transition, defaultDataDir } from "./ir/runstate.mjs";
import { GATES, m1Gates, m1Verdict, sumJs, BUILT_NOT_AUDITED } from "./ir/verdict.mjs";
import { emptyJ, checkJShape, TOTALS_SHAPE } from "./ir/judge.mjs";
import { REPO_ROOT } from "./ir/outside-repo.mjs";
import { fakePixso } from "./test/fake-pixso.mjs";
import { parseArgs, SETTINGS as RUN_SETTINGS } from "./pix-run.mjs";
import { accept, legacyLostBorders } from "./m1-accept.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const check = (cond, m, why) => {
  if (cond) { passed++; console.log("ok   " + m); }
  else { failed++; console.log("FAIL " + m + (why !== undefined ? " — " + String(why).slice(0, 400) : "")); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message || String(e); } };
const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const RUN = "0123456789abcdef";
const TMP = mkdtempSync(join(tmpdir(), "pxf-pixrun-"));
const VERDICTS = JSON.parse(readFileSync(join(HERE, "double", "verdicts.json"), "utf8"));

// ============================================================================================
// the synthetic IR
// ============================================================================================
const T6 = (x, y) => [1, 0, x, 0, 1, y];

// A real, minimal PNG of w x h (one grey row repeated), so headers read as they do in Figma.
function syntheticPng(w, h, seed) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable.push(c >>> 0); }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const row = Buffer.alloc(1 + w, (seed || 7) & 255); row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: Math.min(h, 4) }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// The header of a JPEG (SOI, an APP0, SOF0 with its size) and a little padding: enough to sniff.
function syntheticJpeg(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(32, 0), Buffer.from([0xff, 0xd9])]);
}

function syntheticIR(opts) {
  const o = opts || {};
  const png = syntheticPng(8, 6, 11), jpeg = syntheticJpeg(9, 5), missingBytes = syntheticPng(4, 4, 23), renderBytes = syntheticPng(16, 12, 31);
  const hashes = { png: sha1(png), jpeg: sha1(jpeg), missing: sha1(missingBytes) };
  const values = [
    [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],                                         // 0 page bg / fill
    [],                                                                                        // 1 empty
    [{ type: "IMAGE", scaleMode: "FILL", imageHash: hashes.png }],                              // 2
    { family: "Inter", style: "Regular" },                                                     // 3
    [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }],                                    // 4
    { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
      regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }] },                              // 5 network
    [{ windingRule: "NONZERO", data: "M 0 0 L 10 0 L 5 8 Z" }],                                // 6 geometry
    [{ type: "IMAGE", scaleMode: "FILL", imageHash: hashes.missing }],                          // 7
    [{ type: "IMAGE", scaleMode: "FILL", imageHash: hashes.jpeg }],                             // 8
    { family: "Synthetic Sans", style: "Bold" },                                               // 9
  ];
  const paint = (fills) => ({ fills, strokes: 1, strokeWeight: 1, strokeAlign: "INSIDE", blendMode: "PASS_THROUGH" });
  const frame = (x, y, w, h, extra) => Object.assign({ relativeTransform: T6(x, y), width: w, height: h, clipsContent: true, layoutMode: "NONE",
    primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" }, paint(0), extra || {});
  const nodes = [];
  const add = (parent, guid, type, name, props, more) => { nodes.push(Object.assign({ parent, guid, type, name, props }, more || {})); return nodes.length - 1; };
  let g = 100;
  const gid = () => "1:" + (g++);
  // user page
  const top = add(-1, gid(), "FRAME", "Screen", frame(0, 0, 400, 300), { page: 0 });
  add(top, gid(), "RECTANGLE", "Photo", Object.assign({ relativeTransform: T6(10, 10), width: 80, height: 60 }, paint(2)));
  add(top, gid(), "TEXT", "Title", Object.assign({ relativeTransform: T6(100, 10), width: 120, height: 20, characters: "Hello", fontName: 3, fontSize: 14,
    textAutoResize: "NONE", lines: 1, textRanges: [{ start: 0, end: 2, fields: { fontName: 9 } }] }, paint(4)));
  const masterGuid = "2:900";
  add(top, gid(), "INSTANCE", "Button", { relativeTransform: T6(10, 100), width: 120, height: 40 }, { instance: { master: { guid: masterGuid } } });
  add(top, gid(), "VECTOR", "Net", Object.assign({ relativeTransform: T6(200, 100), width: 10, height: 8, vectorNetwork: 5, oracleFillGeometry: 6 }, paint(4)));
  const geo = add(top, gid(), "VECTOR", "Geo", Object.assign({ relativeTransform: T6(220, 100), width: 10, height: 8, fillGeometry: 6 }, paint(4)));
  const um = add(top, gid(), "COMPONENT", "User master", frame(250, 100, 60, 60));
  add(um, gid(), "ELLIPSE", "Dot", Object.assign({ relativeTransform: T6(4, 4), width: 8, height: 8 }, paint(8)));
  const side = add(-1, gid(), "RECTANGLE", "Divider", Object.assign({ relativeTransform: T6(0, 400), width: 300, height: 2, strokeWeights: [0, 0, 1, 0],
    oracleSides: [false, false, true, false] }, paint(0)), { page: 0 });
  if (o.bigChildren) {
    const big = add(-1, gid(), "FRAME", "Big", frame(0, 600, 2000, 2000), { page: 0 });
    for (let k = 0; k < o.bigChildren; k++) {
      const c = add(big, gid(), "FRAME", "Row " + k, frame(0, k * 10, 2000, 10));
      add(c, gid(), "RECTANGLE", "Cell " + k, Object.assign({ relativeTransform: T6(0, 0), width: 10, height: 10 }, paint(7)));
    }
  }
  // internal canvas
  g = 900;
  const m1 = add(-1, masterGuid, "COMPONENT", "Master A", frame(0, 0, 120, 40), { page: 1 });
  g = 901;
  add(m1, gid(), "RECTANGLE", "Bg", Object.assign({ relativeTransform: T6(0, 0), width: 120, height: 40 }, paint(7)));
  const sg = add(-1, gid(), "FRAME", "State group", frame(0, 100, 300, 60, { clipsContent: false }), { page: 1 });
  const m2 = add(sg, gid(), "COMPONENT", "State=On", frame(0, 0, 100, 60));
  add(m2, gid(), "TEXT", "Label", Object.assign({ relativeTransform: T6(4, 4), width: 40, height: 16, characters: "On", fontName: 3, fontSize: 12,
    textAutoResize: "NONE", lines: 1 }, paint(4)));
  const m3 = add(sg, gid(), "COMPONENT", "State=Off", frame(150, 0, 100, 60));
  add(m3, gid(), "INSTANCE", "Nested", { relativeTransform: T6(4, 4), width: 20, height: 20 }, { instance: { master: { guid: masterGuid } } });
  const loose = add(-1, gid(), "FRAME", "Loose", frame(0, 300, 50, 50), { page: 1 });
  add(loose, gid(), "RECTANGLE", "Leftover", Object.assign({ relativeTransform: T6(0, 0), width: 10, height: 10 }, paint(0)));
  const m4 = add(-1, gid(), "COMPONENT", "Master B", frame(0, 500, 80, 80), { page: 1 });
  add(m4, gid(), "INSTANCE", "Inner", { relativeTransform: T6(0, 0), width: 20, height: 20 }, { instance: { master: { guid: masterGuid } } });

  const comps = [];
  nodes.forEach((n, i) => { if (n.type === "COMPONENT") comps.push({ node: i, set: null }); });
  const ir = {
    header: { format: "pix2fig.ir", version: 2, source: { kind: "pix", sha256: "0".repeat(62) + "a1", fileKey: null, documentName: "Synthetic file A" },
      scope: { kind: "file" },
      capabilities: { authoredOverrides: true, resolvedOverrides: false, overrideKeys: true, publishIds: true, symbolVersions: true, derivedBoxes: true, inkBounds: false, renders: false },
      settings: { mode: "design", overrides: "fidelity", drift: "link", deleted: "publish", resync: "pixso-unless-edited", textFit: "widen", booleans: "auto",
        spaceEvenlySingle: "between", kitmaps: "default" } },
    pages: [{ guid: "0:1", name: "Page 1", internal: false, background: 0 }, { guid: "0:2", name: "Internal canvas", internal: true }],
    values, nodes, sets: [], components: comps, styles: [],
    images: [{ hash: hashes.png, present: true, format: "png" }, { hash: hashes.missing, present: false, format: "png" }, { hash: hashes.jpeg, present: true, format: "jpeg" }],
    fonts: [{ family: "Inter", style: "Regular" }, { family: "Synthetic Sans", style: "Bold" }],
    notes: [{ code: CODE.VECTOR_FROM_GEOMETRY, node: geo, detail: "a network with no region" }],
  };
  // Part A's stats, of the shape docs/M1.md §6 A gives, consistent with the IR above.
  const pops = { userTop: [top, side], userMasters: [um], mastersNoInstance: [m1, m2], mastersWithInstanceInternal: [m3, m4], internalLoose: [loose],
    stateGroupsInternal: [sg], lostBorder: [side] };
  if (o.bigChildren) pops.userTop.push(nodes.findIndex((n) => n.name === "Big"));
  pops.userTop.sort((a, b) => a - b);
  const stats = { stored: nodes.length + 2 + 1 + 3, notCarried: { pages: 2, directories: 0, styleDefinitions: 1, variables: 0, unsupported: 0, foldedOperands: 3, degenerate: 0 },
    populations: pops, ms: { unzip: 1, zstd: 2, kiwi: 3, ir: 4 } };
  return { ir, stats, png, jpeg, missingBytes, renderBytes, hashes, index: { top, geo, um, side, m1, m2, m3, m4, sg, loose } };
}

// ============================================================================================
// 1. the planner
// ============================================================================================
{
  const S = syntheticIR({});
  const irBefore = JSON.stringify(S.ir);
  check(validate(S.ir).ok, "the synthetic IR is a valid IR v2", JSON.stringify(validate(S.ir).errors.slice(0, 3)));
  const plans = {};
  for (const sc of ["default", "all-masters", "all"]) plans[sc] = planM1(S.ir, S.stats, { m1Scope: sc, runId: RUN });
  const P = plans.default;
  const bad = [];
  for (const sc of Object.keys(plans)) for (const t of plans[sc].tasks) { const r = validateTask(t); if (!r.ok) bad.push(sc + "#" + t.taskNo + " " + JSON.stringify(r.errors.slice(0, 2))); }
  check(!bad.length, "every task of every scope passes validateTask (closed records, props of their kinds, the 4 MB cap)", bad.join(" | "));
  check(JSON.stringify(S.ir) === irBefore, "planning leaves the IR untouched");
  check(P.tasks[0].op === "fonts" && P.tasks[0].page === null && same(P.tasks[0].fonts, [{ family: "Inter", style: "Regular" }, { family: "Synthetic Sans", style: "Bold" }]),
    "a fonts task comes first, with every font the built records use (text ranges included)");
  const ops = P.tasks.slice(1).map((t) => t.op).join();
  check(ops === "build,verify,build,verify" && P.tasks.every((t, k) => t.taskNo === k + 1 && t.of === P.tasks.length),
    "each build task is followed by its verify task, numbered 1..of", ops);
  check(P.tasks.slice(1).every((t, k) => k % 2 === 1 || (same(t.nodes, P.tasks[k + 2].nodes) && same(t.roots, P.tasks[k + 2].roots))),
    "a verify task carries exactly its build task's records and roots");
  check(P.tasks[1].page.service === true && P.tasks[1].page.guid === SERVICE_PAGE_GUID && P.tasks[3].page.service === false && P.tasks[3].page.index === 0,
    "S2 (the service page) is planned before S1 (the user page)");
  const s2 = P.tasks[1].roots;
  check(s2.length === 2 && s2.every((r) => r.attachTo === "page" && Array.isArray(r.place)) && same(s2.map((r) => r.i), [S.index.m1, S.index.m2]),
    "S2 masters (one top-level, one inside a state group) are roots attached to the service page with grid places", JSON.stringify(s2));
  const boxes = s2.map((r) => ({ x: r.place[0], y: r.place[1], w: S.ir.nodes[r.i].props.width, h: S.ir.nodes[r.i].props.height }));
  check(!boxes.some((a, k) => boxes.some((b, q) => q > k && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)), "S2 grid places do not overlap");
  check(P.tasks[3].roots.every((r) => r.attachTo === "page" && r.place === null && S.ir.nodes[r.i].parent === -1), "S1 roots are top-level records attached to their page, no place");
  const allNodes = P.tasks.flatMap((t) => t.nodes);
  check(allNodes.every((n) => ORACLE_PROPS.every((k) => !(k in n.props))) && S.ir.nodes.some((n) => n.props.oracleFillGeometry !== undefined) && S.ir.nodes.some((n) => n.props.oracleSides),
    "oracle props (oracleFillGeometry, oracleSides) are stripped from every task and kept in the IR");
  const geoTask = P.tasks.find((t) => t.op === "build" && t.nodes.some((n) => n.i === S.index.geo));
  check(geoTask && geoTask.notes.some((n) => n.code === CODE.VECTOR_FROM_GEOMETRY && n.i === S.index.geo && typeof n.detail === "string"),
    "the IR's notes travel with their records (VECTOR_FROM_GEOMETRY on the geometry vector)");
  check(P.tasks.every((t) => !t.nodes.some((n) => "instance" in n)), "INSTANCE records travel as placeholders, without the IR's instance data");
  check(P.ledger.every((l, k) => l.taskNo === P.tasks[k].taskNo && l.nodes === P.tasks[k].nodes.length && l.ceilingMs === CEILING_BASE_MS + PLAN_DEFAULTS.ceilingMsPerNode * l.nodes),
    "every task's ceiling is 120 000 ms + 20 ms per record");
  const p2 = planM1(S.ir, S.stats, { runId: RUN });
  check(JSON.stringify(p2.tasks) === JSON.stringify(P.tasks), "the same IR, settings and runId give byte-identical task text");
  // The balance under each scope.
  const B = (sc) => plans[sc].balance;
  check(B("default").ok && B("default").nonInstance.builtS1 === 8 && B("default").nonInstance.builtS2 === 4 &&
    same(B("default").nonInstance.outOfScope, { stateGroupsInternal: 1, mastersWithInstanceInternal: 2, internalLoose: 2 }) &&
    B("default").instances.placeholders === 1 && B("default").planCodes[CODE.OUT_OF_SCOPE] === 7,
    "default scope: S1 8 + S2 4 + out of scope (state group 1, masters with an instance 2, loose 2) = 17, placeholders 1, OUT_OF_SCOPE 7", JSON.stringify(B("default").nonInstance));
  check(B("all-masters").ok && B("all-masters").nonInstance.builtS2 === 6 && B("all-masters").instances.placeholders === 3, "all-masters adds the internal masters with an instance, their placeholders included");
  check(B("all").ok && Object.keys(B("all").nonInstance.outOfScope).length === 0 && Object.keys(B("all").instances.outOfScope).length === 0 && !B("all").planCodes[CODE.OUT_OF_SCOPE],
    "under all every OUT_OF_SCOPE term is 0");
  check(B("default").stored.ok && B("default").stored.sum === S.stats.stored, "the stored-node equation adds up with part A's stats");
  const wrong = planM1(S.ir, Object.assign({}, S.stats, { stored: S.stats.stored + 1 }), { runId: RUN }).balance;
  const none = planM1(S.ir, null, { runId: RUN }).balance;
  check(!wrong.ok && !wrong.stored.ok && !none.ok && /stats/.test(none.stored.why), "a stored count that differs, or no stats at all, does not add up");
  check(same(none.nonInstance, B("default").nonInstance), "without stats the populations derived from the IR give the same split");
  const d = derivePopulations(S.ir);
  check(["mastersNoInstance", "mastersWithInstanceInternal", "internalLoose", "stateGroupsInternal", "userMasters"].every((k) => same(d[k], S.stats.populations[k])),
    "derivePopulations finds part A's internal populations on the synthetic IR", JSON.stringify(d));
  // --scope pages: and an unbuildable type.
  const sp = planM1(S.ir, S.stats, { runId: RUN, settings: { scope: "pages:" + S.ir.nodes[S.index.side].guid } });
  check(sp.balance.ok && sp.balance.nonInstance.outOfScope.notInScope === 7 && sp.tasks.filter((t) => t.op === "build").every((t) => t.nodes.every((n) => n.i !== S.index.top)),
    "--scope pages:<guid> builds the named top-level object and counts the rest of the page as notInScope", JSON.stringify(sp.balance.nonInstance));
  const sl = syntheticIR({});
  sl.ir.nodes.push({ parent: -1, page: 0, guid: "1:999", type: "SLICE", name: "Slice", props: { relativeTransform: T6(0, 0), width: 5, height: 5 } });
  sl.stats.stored++;
  const slp = planM1(sl.ir, sl.stats, { runId: RUN });
  check(validate(sl.ir).ok && slp.balance.ok && slp.balance.nonInstance.outOfScope.notBuildable === 1 && slp.tasks.every((t) => validateTask(t).ok),
    "a type M1 does not build (SLICE) is counted as notBuildable, and no task carries it");
  // Splits under a small cap.
  const big = syntheticIR({ bigChildren: 120 });
  const cap = 20000;
  const bp = planM1(big.ir, big.stats, { runId: RUN, maxChars: cap });
  const over = bp.tasks.filter((t) => taskChars(t) > cap || !validateTask(t, { maxChars: cap }).ok);
  check(!over.length && bp.tasks.length > 9, "under a 20 000-character cap every task is valid and under the cap (" + bp.tasks.length + " tasks)", over.map((t) => t.taskNo).join());
  const bigI = big.ir.nodes.findIndex((n) => n.name === "Big");
  const split = bp.tasks.filter((t) => t.op === "build" && t.roots.some((r) => r.attachTo !== "page" && r.attachTo.i === bigI));
  const firstWithBig = bp.tasks.find((t) => t.op === "build" && t.nodes.some((n) => n.i === bigI));
  check(split.length >= 2 && split.every((t) => t.taskNo > firstWithBig.taskNo),
    "a root over the cap is split at child boundaries: later tasks attach their pieces to it ({ i }), after the task that builds it", split.map((t) => t.taskNo).join());
  const built = new Set(bp.tasks.filter((t) => t.op === "build").flatMap((t) => t.nodes.map((n) => n.i)));
  const scope = new Set(bp.scope.built);
  check(built.size === scope.size && [...scope].every((i) => built.has(i)) && bp.tasks.filter((t) => t.op === "build").reduce((s, t) => s + t.nodes.length, 0) === scope.size,
    "every record in scope is built exactly once across the split tasks");
  {
    // Part F: a resume keeps a split root only whole (B's request: after a plugin restart the split
    // pieces' parent carries no stamp, so its task runs again with them).
    const chain = splitChains(bp.tasks).find((g) => g.indexOf(firstWithBig.taskNo) >= 0) || [];
    const mk = () => newStates({ snapshot: bp.tasks[0].snapshot, irVersion: 2, runId: RUN, settings: { m1Scope: "default" }, probes: probeStatus(VERDICTS),
      pixso: null, balance: JSON.parse(JSON.stringify(bp.balance)), ledger: bp.ledger });
    const old = mk();
    for (const t of old.tasks) t.state = "built";
    const lastPiece = split[split.length - 1].taskNo;
    old.tasks.find((t) => t.taskNo === lastPiece).state = "failed";
    old.tasks.find((t) => t.taskNo === lastPiece + 1).state = "skipped";
    const r = resumeStates(old, mk(), bp.tasks);
    const st = (no) => r.states.tasks.find((t) => t.taskNo === no).state;
    const outside = bp.tasks.filter((t) => t.op === "build" && chain.indexOf(t.taskNo) < 0);
    check(chain.length === split.length + 1 && chain.every((no) => st(no) === "pending" && st(no + 1) === "pending") && outside.length > 0 && outside.every((t) => st(t.taskNo) === "built"),
      "a resume runs a split root's whole chain again (the task that builds it and every piece) when one piece did not build; other tasks stay built",
      JSON.stringify({ chain, states: r.states.tasks.map((t) => t.taskNo + ":" + t.state) }));
    check(resumeStates(old, mk()).states.tasks.filter((t) => t.state === "built").length === old.tasks.filter((t) => t.op !== "fonts").length - 2, "without the plan's tasks, a resume keeps pairs as before");
  }
  const long = syntheticIR({});
  long.ir.nodes.find((n) => n.type === "TEXT").props.characters = "x".repeat(30000);
  check(/IR record [0-9]+ alone is over the task size cap/.test(threw(() => planM1(long.ir, long.stats, { runId: RUN, maxChars: cap }))) &&
    /leaves no room/.test(threw(() => planM1(S.ir, S.stats, { runId: RUN, maxChars: 500 }))),
    "a single record over the cap, or a cap with no room for records, is refused, never silently dropped");
  const ct = cleanTaskFor(P.tasks[3], S.ir);
  check(validateTask(ct).ok && ct.op === "clean" && ct.nodes.length === P.tasks[3].roots.length, "the clean task before a build carries its root records only and is valid", JSON.stringify(validateTask(ct).errors.slice(0, 2)));
  const tbl = tableFromIR(S.ir);
  const withTable = planM1(S.ir, S.stats, { runId: RUN, images: tbl.map((t) => (t.hash === S.hashes.missing ? Object.assign({}, t, { source: "mcp", reason: null }) : t)) });
  const imgs = withTable.tasks.flatMap((t) => t.images);
  check(imgs.some((m) => m.hash === S.hashes.missing && m.source === "mcp") && imgs.some((m) => m.hash === S.hashes.png && m.source === "archive"),
    "each task lists the images its values name, with the source the image chain found");
}

// ============================================================================================
// 2. the read-only script check
// ============================================================================================
{
  const H = sha1("pxf synthetic image for scripts");
  const lib = [SCRIPTS.identity(), SCRIPTS.sample(["1:2", "3:4"]), SCRIPTS.imageBytes(H), SCRIPTS.imageRange(H, 0, 10), SCRIPTS.render("1:2")];
  const libBad = lib.map((s) => readOnlyProblems(s)).filter((p) => p.length);
  check(!libBad.length, "every script of the fixed library passes the read-only check", JSON.stringify(libBad));
  const base = "await pixso.loadAllPagesAsync();\nconst n = pixso.getNodeById(\"1:2\");\n";
  const cases = [
    ["setPluginData", base + "n.setPluginData(\"k\", \"v\");\nreturn 1;"],
    ["remove", base + "n.remove();\nreturn 1;"],
    ["resize", base + "n.resize(10, 10);\nreturn 1;"],
    ["appendChild", base + "pixso.currentPage.appendChild(n);\nreturn 1;"],
    ["setRange", base + "n.setRangeFontSize(0, 1, 12);\nreturn 1;"],
    ["a member assignment", base + "n.name = \"x\";\nreturn 1;"],
    ["a computed member assignment", base + "n[\"name\"] = 1;\nreturn 1;"],
    ["a compound member assignment", base + "n.opacity += 1;\nreturn 1;"],
    ["an increment of a member", base + "n.x++;\nreturn 1;"],
    ["a global assignment", base + "pixso = null;\nreturn 1;"],
    ["a computed call", base + "n[\"remo\" + \"ve\"]();\nreturn 1;"],
    ["Object.assign", base + "Object.assign(n, {});\nreturn 1;"],
    ["eval", base + "eval(\"1\");\nreturn 1;"],
    ["a method off the read list", base + "n.setCurrentPageAsync();\nreturn 1;"],
    ["a template literal", base + "const s = `x`;\nreturn s;"],
    ["a comment after code", base + "const r = 1; // hidden\nreturn r;"],
    ["a regex hiding code", base + "const r = /[//]/;\nreturn r;"],
    ["a string holding code", base + "const s = \"a; n.name = 1\";\nreturn s;"],
    ["delete", base + "delete n.name;\nreturn 1;"],
  ];
  for (const [what, src] of cases) {
    const e = threw(() => assertReadOnlyScript(src));
    check(/not read-only/.test(e), "the read-only check refuses " + what, e || "accepted");
  }
  check(readOnlyProblems(base + "let k = 0;\nk += 1;\nconst out = [];\nout.push(k);\nreturn out;").length === 0, "local variables, compound assignment to a local and push are allowed");
  check(/40 lowercase hex/.test(threw(() => SCRIPTS.imageBytes("not a hash"))) && /guid/.test(threw(() => SCRIPTS.render("x\";remove();\""))),
    "library arguments are validated before they enter a script");
}

// ============================================================================================
// 3. images, offline
// ============================================================================================
{
  const png = syntheticPng(5000, 1000, 3), strip = syntheticPng(9000, 20, 5), small = syntheticPng(7, 9, 1);
  const webpX = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(8), Buffer.from([99, 0, 0, 49, 0, 0])]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([10, 0, 20, 0]), Buffer.alloc(8)]);
  check(same(imageInfo(small), { format: "png", w: 7, h: 9 }) && same(imageInfo(syntheticJpeg(321, 123)), { format: "jpeg", w: 321, h: 123 }) &&
    same(imageInfo(webpX), { format: "webp", w: 100, h: 50 }) && same(imageInfo(gif), { format: "gif", w: 10, h: 20 }) && imageInfo(Buffer.from("nope")).format === "unknown",
    "imageInfo reads PNG, JPEG, WebP and GIF sizes from their headers");
  const edge = syntheticPng(4096, 300, 2);
  check(same(p8Cases(imageInfo(small)), []) && same(p8Cases(imageInfo(edge)), ["png4096"]) && same(p8Cases(imageInfo(png)), ["png4097"]) &&
    same(p8Cases(imageInfo(strip)), ["longStrip"]) &&
    same(p8Cases(imageInfo(syntheticJpeg(10, 10))), ["jpegAsPng"]) && same(p8Cases(imageInfo(webpX)), ["webpAsPng"]),
    "the bytes fall into P8's cases (png4096 at exactly 4 096 px, png4097, longStrip, jpegAsPng, webpAsPng); an ordinary PNG falls in none");
  const v = (k, val) => ({ probes: { P8: { verdicts: Object.assign({ png4096: "ok", png4097: "pending", longStrip: "pending", jpegAsPng: "pending", webpAsPng: "pending" }, { [k]: val }) } } });
  check(refusedBy(imageInfo(png), v("png4097", "drop")) && refusedBy(imageInfo(syntheticJpeg(4, 4)), v("jpegAsPng", "throw")) && refusedBy(imageInfo(edge), v("png4096", "empty")) && !refusedBy(imageInfo(small), v("png4096", "throw")) &&
    !refusedBy(imageInfo(png), v("png4097", "ok")) && !refusedBy(imageInfo(png), VERDICTS) && refusedBy(imageInfo(Buffer.from("nope")), VERDICTS),
    "P8 verdicts are data: throw, drop and empty move on, ok and pending let the bytes through, unknown bytes never go");
  check(same(parseLinks("archive,render"), ["archive", "render"]) && /not one of/.test(threw(() => parseLinks("archive,disk"))) && /twice/.test(threw(() => parseLinks("mcp,mcp"))),
    "--images takes an ordered subset of archive, mcp, render");
}

// The image chain and the identity check against a fake Pixso.
async function imageGroup() {
  const S = syntheticIR({});
  const extra = [syntheticPng(3, 3, 41), syntheticPng(3, 4, 42), syntheticPng(3, 5, 43), syntheticPng(3, 6, 44), syntheticPng(3, 7, 45)];
  const pix = { images: new Map([[S.hashes.png, { data: () => S.png }], [S.hashes.jpeg, { data: () => S.jpeg }]]) };
  const px = fakePixso();
  await px.listen();
  const libScripts = () => px.scripts.filter((s) => /^\/\/ px:(image|render|sample)/.test(s));
  try {
    px.identity = { file: "Synthetic file A.pix", fileKey: "synthetic-key-a", pageIds: ["0:1", "0:2"] };
    S.ir.nodes.forEach((n) => px.nodes.set(n.guid, { type: n.name === "State group" ? "COMPONENT_SET" : n.type, name: n.name, width: n.props.width, height: n.props.height }));
    const carrier = carriers(S.ir).get(S.hashes.missing);
    const mk = (n) => makeMcpClient({ url: px.url, dir: join(TMP, "mcp-" + n), timeoutMs: 20000, timing: { transportTrip: 3, silenceMs: 60000 } });
    const c = mk("a");
    const id = await checkIdentity(pix, S.ir, c);
    check(id.same && id.q5 && id.code === null && id.sample.asked === 20,
      "the identity check passes: the root name (a '.pix' suffix aside), the pages and 20 sampled guids (FRAME read as COMPONENT_SET allowed)", JSON.stringify(id));
    // MCP bytes, in ranges.
    px.images.set(S.hashes.missing, S.missingBytes);
    let r = await resolveImages(S.ir, pix, { pixso: { client: c, identity: id }, links: ["archive", "mcp", "render"], verdicts: VERDICTS, cacheDir: join(TMP, "cache-a"), wholeBytes: 20, chunkBytes: 16 });
    const row = (h) => r.table.find((t) => t.hash === h);
    check(row(S.hashes.png).source === "archive" && row(S.hashes.missing).source === "mcp" && sha1(r.bytes.get(S.hashes.missing)) === S.hashes.missing &&
      px.scripts.some((s) => s.indexOf("// px:image-range") === 0),
      "archive bytes first (SHA-1 checked), a missing hash from Pixso's bytes in ranges, SHA-1 checked", JSON.stringify(r.table.map((t) => [t.source, t.reason])));
    const n0 = libScripts().length;
    r = await resolveImages(S.ir, pix, { pixso: { client: c, identity: id }, links: ["archive", "mcp", "render"], verdicts: VERDICTS, cacheDir: join(TMP, "cache-a") });
    check(r.table.find((t) => t.hash === S.hashes.missing).source === "mcp" && libScripts().length === n0, "Pixso's bytes are cached by hash outside the repository: a second run fetches nothing");
    // Bad SHA-1 from Pixso moves on to the render of the smallest carrier.
    px.images.set(S.hashes.missing, Buffer.from("these are not the bytes of the hash"));
    px.nodes.get(carrier.guid).png = S.renderBytes;
    r = await resolveImages(S.ir, pix, { pixso: { client: c, identity: id }, links: ["mcp", "render"], verdicts: VERDICTS });
    const m = r.table.find((t) => t.hash === S.hashes.missing);
    check(m.source === "render" && /mcp: the bytes' SHA-1 is not the hash/.test(m.reason) && same([m.w, m.h], [16, 12]) && px.scripts.some((s) => s.indexOf("// px:render") === 0 && s.indexOf(carrier.guid) > 0),
      "MCP bytes with a bad SHA-1 move on to a render of the smallest carrier node, by guid", JSON.stringify(m));
    // A P8 drop verdict moves on.
    const drop = JSON.parse(JSON.stringify(VERDICTS)); drop.probes.P8.verdicts.jpegAsPng = "drop";
    r = await resolveImages(S.ir, pix, { pixso: { client: c, identity: id }, links: ["archive"], verdicts: drop });
    const j = r.table.find((t) => t.hash === S.hashes.jpeg);
    check(j.source === "none" && /P8 jpegAsPng: drop/.test(j.reason) && !r.bytes.has(S.hashes.jpeg), "a P8 drop verdict for JPEG-in-PNG moves the archive bytes on (here to the placeholder)", JSON.stringify(j));
    // A SHA-1-mismatched archive entry is missing.
    const pixBad = { images: new Map([[S.hashes.png, { data: () => Buffer.from("tampered") }]]) };
    r = await resolveImages(S.ir, pixBad, { links: ["archive"], verdicts: VERDICTS });
    check(r.table.find((t) => t.hash === S.hashes.png).source === "none" && r.table.find((t) => t.hash === S.hashes.png).reason.indexOf(CODE.IMAGE_HASH_MISMATCH) >= 0,
      "an archive entry whose SHA-1 is not its name is treated as missing");
    // Identity fails: links 2 and 3 are skipped, with no image script sent.
    const other = fakePixso(); await other.listen();
    try {
      other.identity = { file: "Synthetic file B", fileKey: "synthetic-key-b", pageIds: ["7:1"] };
      const c2 = makeMcpClient({ url: other.url, dir: join(TMP, "mcp-b"), timeoutMs: 20000 });
      const id2 = await checkIdentity(pix, S.ir, c2);
      r = await resolveImages(S.ir, null, { pixso: { client: c2, identity: id2 }, links: ["archive", "mcp", "render"], verdicts: VERDICTS });
      check(!id2.same && id2.code === CODE.SOURCE_IDENTITY_MISMATCH && r.table.every((t) => t.source === "none" && t.reason.indexOf("mcp: skipped, " + CODE.SOURCE_IDENTITY_MISMATCH) >= 0) &&
        !other.scripts.some((s) => /^\/\/ px:(image|render)/.test(s)),
        "another file open in Pixso: SOURCE_IDENTITY_MISMATCH, and links 2 and 3 are skipped without a call", JSON.stringify(id2.detail));
    } finally { await other.close(); }
    const sampled = sampleGuids(S.ir);
    const renamed = S.ir.nodes.map((n, i) => ({ id: n.guid, type: n.name === "State group" ? "COMPONENT_SET" : n.type, name: i === sampled[3] ? "Renamed" : n.name }));
    const q = compareIdentity(S.ir, "Synthetic file A", { file: "Synthetic file A", pageIds: ["0:1"] }, sampled, renamed);
    check(q.same && !q.q5 && q.sample.nameDiffers === 1 && q.sample.agree === sampled.length - 1,
      "one sampled guid with another name breaks Q5 while the file is the same (the internal canvas may be unlisted)", JSON.stringify(q));
    const pagesOff = compareIdentity(S.ir, "Synthetic file A", { file: "Synthetic file A", pageIds: ["0:1", "0:9"] }, [], []);
    check(!pagesOff.same && /1 open pages not in the .pix/.test(pagesOff.detail), "a page Pixso lists that the .pix lacks is a mismatch");
    // The breaker trips in the middle of the fetches; later hashes skip Pixso without a call.
    const Bt = syntheticIR({});
    for (const b of extra) { Bt.ir.images.push({ hash: sha1(b), present: false, format: "png" }); px.images.set(sha1(b), b); }
    const c3 = mk("trip");
    const id3 = await checkIdentity(null, Bt.ir, c3);
    px.outageAfter(sha1(extra[0]), "reset");
    const before = c3.calls;
    r = await resolveImages(Bt.ir, null, { pixso: { client: c3, identity: id3 }, links: ["mcp"], verdicts: VERDICTS, only: new Set(extra.map(sha1)) });
    const reasons = r.table.map((t) => t.source + ":" + (t.reason || ""));
    check(id3.q5 && r.table[0].source === "mcp" && !!c3.tripped() && c3.calls - before === 4 && /unavailable/.test(reasons[4]) && /transport/.test(reasons[1]),
      "the breaker trips after three transport failures mid-fetch; the rest skip Pixso without a call", JSON.stringify({ calls: c3.calls - before, reasons }));
    const notRO = px.scripts.filter((s) => readOnlyProblems(s).length);
    check(px.scripts.length > 10 && !notRO.length, "every script the fake Pixso received (" + px.scripts.length + ") passes the read-only check");
    // No Pixso: the placeholder, with the reason per link.
    r = await resolveImages(S.ir, null, { pixso: null, links: ["archive", "mcp", "render"], verdicts: VERDICTS });
    check(r.table.every((t) => t.source === "none" && /archive: not in the archive; mcp: no Pixso; render: no Pixso/.test(t.reason)) && r.bytes.size === 0,
      "without the archive and Pixso every image is a placeholder, and the reason names each link");
    const down = await checkIdentity(null, S.ir, makeMcpClient({ url: "http://127.0.0.1:9/mcp", dir: join(TMP, "mcp-down"), timeoutMs: 3000 }));
    check(down.transport && !down.same && down.code === null, "a Pixso that does not answer is not a mismatch: the MCP links are skipped as unavailable");
  } finally { await px.close(); }
}

// ============================================================================================
// 4. the run state and the run loop
// ============================================================================================
function playedPlugin(opts) {
  const o = opts || {};
  const posted = [];
  const post = async (task) => {
    posted.push(task.op + ":" + task.taskNo);
    const boom = o.throwAt ? o.throwAt(task) : null;
    if (boom) throw boom;
    if (task.op === "fonts") return { op: "fonts", available: 10, missing: o.missing || [] };
    if (task.op === "clean") return { op: "clean", removed: 0, kept: 0 };
    if (task.op === "build") {
      const codes = {};
      if (task.expect.placeholders) codes[CODE.INSTANCE_DEFERRED] = task.expect.placeholders;
      if (o.fallbackAt === task.taskNo) codes[CODE.BOOLEAN_FALLBACK] = 1;
      return { op: "build", taskNo: task.taskNo, codes, coded: [], failures: o.failAt === task.taskNo ? [{ i: 0, prop: "x", msg: "m" }] : [], ms: { fonts: 1, create: 5, stamp: 1 } };
    }
    return { op: "verify", taskNo: task.taskNo, roots: task.roots.map((r) => ({ i: r.i, id: "9:" + r.i, found: o.lostRoot !== task.taskNo })), count: task.nodes.length, rows: [] };
  };
  return { post, posted };
}
async function runGroup() {
  const S = syntheticIR({});
  const plan = planM1(S.ir, S.stats, { runId: RUN });
  const fresh = () => newStates({ snapshot: plan.tasks[0].snapshot, irVersion: 2, runId: RUN, settings: { m1Scope: "default" }, probes: probeStatus(VERDICTS),
    pixso: null, balance: JSON.parse(JSON.stringify(plan.balance)), ledger: plan.ledger });
  check(/not a reason code/.test(threw(() => count({}, "NOT_A_CODE"))) && count({}, CODE.BUILD_FAILED, 2)[CODE.BUILD_FAILED] === 2, "count() records codes and throws on one outside the vocabulary");
  check(/cannot become/.test(threw(() => { const s = fresh(); transition(s, 2, "built"); transition(s, 2, "failed"); })) && /cannot become/.test(threw(() => transition(fresh(), 2, "pending"))),
    "a built task cannot fail afterwards, and a pending one is not reset");
  let st = fresh(), P = playedPlugin();
  let r = await runTasks({ states: st, tasks: plan.tasks, post: P.post, clean: (t) => cleanTaskFor(t, S.ir), judge: () => emptyJ() });
  check(r.stopped === null && st.tasks.every((t) => t.state === "built") && r.Js.length === 2 && P.posted.join() === "fonts:1,clean:2,build:2,verify:3,clean:4,build:4,verify:5",
    "every task built in order, a clean before each build, and one J per verify task", P.posted.join());
  st = fresh(); P = playedPlugin({ fallbackAt: 4, lostRoot: 3, failAt: 2 });
  await runTasks({ states: st, tasks: plan.tasks, post: P.post });
  check(st.tasks[3].state === "built-with-fallbacks" && st.tasks[3].codes[CODE.BOOLEAN_FALLBACK] === 1 && st.tasks[2].codes[CODE.ROOT_NOT_FOUND] === 2 && st.tasks[1].failures === 1,
    "a counted fallback makes built-with-fallbacks; a root VERIFY cannot find is ROOT_NOT_FOUND; build failures are counted");
  st = fresh(); P = playedPlugin({ throwAt: (t) => (t.taskNo === 2 && t.op === "build" ? new Error("synthetic: the plugin threw") : null) });
  await runTasks({ states: st, tasks: plan.tasks, post: P.post });
  check(st.tasks[1].state === "failed" && st.tasks[1].codes[CODE.BUILD_FAILED] === 1 && /synthetic: the plugin threw/.test(st.tasks[1].error) && st.tasks[2].state === "skipped" && st.tasks[3].state === "built",
    "a build that throws is BUILD_FAILED with its full error, its verify is skipped, and the run goes on");
  st = fresh();
  const stall = Object.assign(new Error("synthetic: no progress for 300 s"), { code: CODE.PLUGIN_STALLED });
  P = playedPlugin({ throwAt: (t) => (t.taskNo === 2 && t.op === "build" ? stall : null) });
  r = await runTasks({ states: st, tasks: plan.tasks, post: P.post });
  check(r.stopped === "stalled" && st.tasks[1].state === "failed" && st.tasks[1].codes[CODE.PLUGIN_STALLED] === 1 && st.tasks.slice(2).every((t) => t.state === "skipped"),
    "PLUGIN_STALLED fails the task and stops the run: the rest are skipped");
  const again = fresh(); again.runId = "fedcba9876543210";
  const res = resumeStates(st, again);
  check(res.resumed === 0 && res.states.tasks.every((t) => t.state === "pending") && res.states.runId === "fedcba9876543210", "resume: failed and skipped tasks are pending again, under a new runId");
  P = playedPlugin();
  await runTasks({ states: res.states, tasks: plan.tasks, post: P.post });
  const half = fresh(); half.tasks[1].state = "built"; half.tasks[2].state = "built"; half.tasks[3].state = "failed";
  const res2 = resumeStates(half, fresh());
  check(res.states.tasks.every((t) => t.state === "built") && res2.resumed === 2 && res2.states.tasks[1].state === "built" && res2.states.tasks[3].state === "pending",
    "a stalled run resumes to built; a resume keeps built build-and-verify pairs and runs the rest");
  const other = fresh(); other.settings = { m1Scope: "all" };
  check(resumeStates(half, other).resumed === 0, "a resume under other settings starts fresh");
  st = fresh(); P = playedPlugin({ missing: [{ family: "Synthetic Sans", style: "Bold" }] });
  r = await runTasks({ states: st, tasks: plan.tasks, post: P.post });
  check(r.stopped === "fonts" && P.posted.join() === "fonts:1" && st.fonts.missing.length === 1 && st.balance.planCodes[CODE.FONT_MISSING] === 1 && st.tasks.slice(1).every((t) => t.state === "pending"),
    "a missing font stops the run at the preflight (FONT_MISSING), nothing is built");
  st = fresh(); P = playedPlugin({ missing: [{ family: "Synthetic Sans", style: "Bold" }] });
  r = await runTasks({ states: st, tasks: plan.tasks, post: P.post, missingFonts: "substitute" });
  check(r.stopped === null && st.tasks.every((t) => t.state === "built"), "--missing-fonts substitute continues past the preflight");
  st = fresh(); P = playedPlugin();
  await runTasks({ states: st, tasks: plan.tasks, post: P.post, only: 4 });
  check(P.posted.join() === "fonts:1,build:4,verify:5" && st.tasks[1].state === "pending", "--only <taskNo> runs the fonts task, that build and its verify");
  const statesFile = join(REPO_ROOT, "tmp-states.json");
  check(/inside the repository/.test(threw(() => saveStates(statesFile, st))) && !existsSync(statesFile), "states.json is never written inside the repository");
  saveStates(join(TMP, "s", "states.json"), st);
  check(JSON.parse(readFileSync(join(TMP, "s", "states.json"), "utf8")).version === 2, "states.json v2 is written outside the repository");
  check(/pix2fig$/.test(defaultDataDir({ LOCALAPPDATA: join(TMP, "la") }, "win32")) && defaultDataDir({}, "linux").indexOf("pix2fig") > 0, "the per-user data folder");
}

// ============================================================================================
// 5. the verdict
// ============================================================================================
function goodRun() {
  const S = syntheticIR({});
  const plan = planM1(S.ir, S.stats, { runId: RUN });
  const ran = { probes: Object.fromEntries(["P4", "P5", "P6", "P8", "P18", "P19B"].map((p) => [p, { status: "run 2026-10-06" }])) };
  const states = newStates({ snapshot: plan.tasks[0].snapshot, irVersion: 2, runId: RUN, settings: {}, probes: probeStatus(ran), pixso: null, balance: plan.balance, ledger: plan.ledger });
  for (const t of states.tasks) {
    t.state = "built";
    if (t.op === "build") { t.ms = { create: 10, stamp: 2 }; const task = plan.tasks[t.taskNo - 1]; if (task.expect.placeholders) t.codes = { [CODE.INSTANCE_DEFERRED]: task.expect.placeholders }; }
  }
  const Js = plan.tasks.filter((t) => t.op === "verify").map((t) => {
    const J = emptyJ();
    Object.assign(J.count, { expected: t.nodes.length, built: t.nodes.length, nonInstance: t.expect.nonInstance, placeholders: t.expect.placeholders, ok: true });
    Object.assign(J.placeholders, { expected: t.expect.placeholders, aligned: t.expect.placeholders });
    J.vectors.checked = 2; J.vectors.match = 1; J.vectors.excused[CODE.VECTOR_FROM_GEOMETRY] = 1;
    J.geometry.visible = t.nodes.length;
    return J;
  });
  return { S, plan, states, Js };
}
{
  const G = goodRun();
  const T = sumJs(G.Js);
  check(checkJShape(T, TOTALS_SHAPE).length === 0 && T.tasks === 2 && T.count.ok && T.vectors.excused[CODE.VECTOR_FROM_GEOMETRY] === 2 &&
    T.count.expected === G.plan.tasks.filter((t) => t.op === "verify").reduce((s, t) => s + t.nodes.length, 0),
    "the run totals sum the task Js by the frozen shape (TOTALS_SHAPE: counts, maps, count.ok)", JSON.stringify(checkJShape(T, TOTALS_SHAPE)));
  const worst = Array.from({ length: 40 }, (_, k) => ({ i: k, dx: k, dy: 0, dw: 0, dh: 0, visible: true }));
  const w2 = sumJs([Object.assign(emptyJ(), { geometry: Object.assign(emptyJ().geometry, { worst }) })]);
  const notOk = emptyJ(); notOk.count.ok = false;
  check(w2.geometry.worst.length === 30 && w2.geometry.worst[0].dx === 39 && sumJs([emptyJ(), notOk]).count.ok === false,
    "geometry.worst is re-sorted by its largest delta and cut to 30; count.ok holds only when every task's does");
  const g = m1Gates(T, G.states, {});
  check(!g.failed.length && g.verdict.indexOf(BUILT_NOT_AUDITED) === 0 && /placeholders 1, IMAGE_PLACEHOLDER 0/.test(g.verdict) && /excused vectors 2/.test(g.verdict),
    "a clean run without an audit reads BUILT, NOT VISUALLY AUDITED with its counts", g.verdict + " " + JSON.stringify(g.gates.filter((x) => x.fail)));
  const breakers = {
    G1: (s) => { s.tasks[3].state = "skipped"; },
    G2: (s) => { s.tasks[2].codes = { [CODE.ROOT_NOT_FOUND]: 1 }; },
    G3: (s, t) => { t.count.built -= 1; },
    G4: (s) => { s.balance.ok = false; s.balance.stored.ok = false; },
    G5: (s) => { s.tasks[1].failures = 1; },
    G6: (s, t) => { t.geometry.visibleOver1 = 1; },
    G7: (s, t) => { t.geometry.sizeVisibleOver1 = 1; },
    G8: (s, t) => { t.sides.mismatchOracle.push({ i: 1, oracle: [false, false, true, false], figma: [1, 1, 1, 1] }); },
    G9: (s, t) => { t.vectors.differs.push({ i: 4, kind: "bounds" }); },
    G10: (s, t) => { t.text.unmeasured = 1; },
    G11: (s, t) => { t.placeholders.misaligned.push(3); },
    G12: (s) => { s.tasks[3].ms = {}; },
  };
  for (const [id, name] of GATES) {
    const s = JSON.parse(JSON.stringify(G.states)), t = JSON.parse(JSON.stringify(T));
    breakers[id](s, t);
    const r = m1Gates(t, s, {});
    check(r.failed.length === 1 && r.failed[0] === id + " " + name && /^FAIL \(/.test(r.verdict), id + " " + name + " turns the verdict to FAIL on its own", r.verdict);
  }
  {
    const s = JSON.parse(JSON.stringify(G.states)), t = JSON.parse(JSON.stringify(T));
    t.text.differ.push({ i: 2, guid: "", irLines: 1, figmaLines: 2, widened: false, fontHeld: false, approx: false });
    const s2 = JSON.parse(JSON.stringify(G.states)); s2.tasks[3].codes = {};
    check(m1Gates(t, s, {}).failed.join() === "G10 text lines" && m1Gates(T, s2, {}).failed.join() === "G11 placeholders" &&
      m1Gates(null, G.states, {}).failed.join() === "G3 count,G6 position,G7 size,G8 side strokes,G9 vectors,G10 text lines,G11 placeholders",
      "an unnamed differing text fails G10, INSTANCE_DEFERRED unequal to the placeholders fails G11, and with nothing judged every judge gate fails");
  }
  const roots = G.states.tasks.filter((t) => t.op === "build").flatMap((t) => t.roots);
  const audit = (ok, n) => ({ format: "pix2fig.audit", version: 1, roots: roots.slice(0, n === undefined ? roots.length : n).map((i) => ({ i, ok })) });
  check(m1Gates(T, G.states, { audit: audit(true) }).verdict === "PASS" && m1Gates(T, G.states, { audit: audit(true, 1) }).verdict.indexOf(BUILT_NOT_AUDITED) === 0 &&
    /FAIL \(audit\)/.test(m1Gates(T, G.states, { audit: audit(false) }).verdict) && m1Gates(T, G.states, { audit: { roots: audit(true).roots } }).verdict.indexOf(BUILT_NOT_AUDITED) === 0,
    "PASS only with an audit covering every built root; a partial or malformed audit is not one, a failed root is FAIL");
  const failG = JSON.parse(JSON.stringify(T)); failG.geometry.visibleOver1 = 3;
  check(!/PASS/.test(m1Gates(failG, G.states, { audit: audit(true) }).verdict) && !/PASS/.test(m1Verdict(T, G.states, {}).join("\n")),
    "no PASS with a failing gate, and none without an audit");
  const pend = JSON.parse(JSON.stringify(G.states)); pend.probes = probeStatus(VERDICTS);
  const lines = m1Verdict(T, pend, {});
  check(lines.some((l) => /^probes: P4 pending, P5 pending, P6 pending, P8 pending, P18 pending, P19B pending$/.test(l)) && /creation order not frozen/.test(lines[lines.length - 1]) &&
    !/creation order/.test(m1Verdict(T, G.states, {}).slice(-1)[0]),
    "the probe status line names each gating probe; while one is pending the verdict says the creation order is not frozen");
  check(probeStatus(VERDICTS).P2 === undefined && probeStatus({ probes: { P8: { status: "run 2026-10-07" }, P4: { status: "pending" } } }).P8 === "run 2026-10-07",
    "probe status comes from verdicts.json: run <date> or pending");
}

// ============================================================================================
// 6. m1-accept and pix-run
// ============================================================================================
function acceptGroup() {
  const G = goodRun();
  const dir = join(TMP, "run-ok");
  mkdirSync(join(dir, "judge"), { recursive: true });
  writeFileSync(join(dir, "states.json"), JSON.stringify(G.states));
  writeFileSync(join(dir, "ir.json"), JSON.stringify(G.S.ir));
  writeFileSync(join(dir, "stats.json"), JSON.stringify(G.S.stats));
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ balance: G.plan.balance, preflight: G.plan.preflight, ledger: G.plan.ledger,
    records: G.plan.tasks.filter((t) => t.op === "build").reduce((m, t) => { m[t.taskNo] = t.nodes.map((n) => n.i); return m; }, {}) }));
  const Js = G.Js.map((J) => JSON.parse(JSON.stringify(J)));
  Js[1].text.differ.push({ i: 2, guid: G.S.ir.nodes[2].guid, irLines: 1, figmaLines: 2, widened: true, fontHeld: false, approx: false });
  Js.forEach((J, k) => writeFileSync(join(dir, "judge", (2 * k + 3) + ".json"), JSON.stringify(J)));
  const legacy = join(TMP, "legacy", "obj-1");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "ir.json"), JSON.stringify({ tree: { id: "0:1", type: "PAGE", children: [
    { id: G.S.ir.nodes[G.S.index.side].guid, type: "RECTANGLE", name: "Divider", strokes: [{ type: "SOLID", visible: true }], strokeWeight: 1, strokeTopWeight: 0, strokeRightWeight: 0, strokeBottomWeight: 0, strokeLeftWeight: 0 },
    { id: "5:5", type: "INSTANCE", name: "Inst", children: [{ id: "5:6", type: "FRAME", strokes: [{ type: "SOLID" }], strokeWeight: 1, strokeTopWeight: 0, strokeRightWeight: 0, strokeBottomWeight: 0, strokeLeftWeight: 0 }] }] } }));
  check(same(legacyLostBorders(join(TMP, "legacy")).map((x) => x.guid), [G.S.ir.nodes[G.S.index.side].guid]), "--legacy-out finds the old tool's lost borders outside instances, by guid");
  const r = accept(dir, { legacyOut: join(TMP, "legacy") });
  const text = r.lines.join("\n");
  const want = ["G1 tasks", "G12 time", "BALANCE (adds up)", "stored 26 =", "count: expected", "geometry: visible", "sides: checked", "vectors: checked", "text: checked 0, differ 1 (widened 1",
    "placeholders: expected", "build time:", "per 1 000", "reader: unzip 1 ms", "legacy lost borders (--legacy-out): 1 named, 1 in the IR, 1 built, 1 with sides", "populations:", "VERDICT: " + BUILT_NOT_AUDITED];
  const missing = want.filter((w) => text.indexOf(w) < 0);
  check(!missing.length, "m1-accept prints the gates, the balance, every number of §8.3, the populations and time per phase per 1 000", missing.join(" | "));
  check(text.indexOf(G.S.ir.nodes[2].name) < 0 && text.indexOf(G.S.ir.nodes[2].guid) < 0 && r.privateLines.some((l) => l.indexOf(G.S.ir.nodes[2].guid) >= 0 && l.indexOf("text lines differ") === 0),
    "names and guids stay out of the printed report and go to the private lines");
  const out = execFileSync(process.execPath, [join(HERE, "m1-accept.mjs"), dir], { encoding: "utf8" });
  check(/VERDICT: BUILT, NOT VISUALLY AUDITED/.test(out) && existsSync(join(dir, "names.private.txt")), "m1-accept writes the names file in the run folder only");
  let code = 0;
  try { execFileSync(process.execPath, [join(HERE, "m1-accept.mjs"), join(REPO_ROOT, "tools")], { encoding: "utf8", stdio: "pipe" }); } catch (e) { code = e.status; }
  check(code === 1, "m1-accept refuses a run folder inside the repository");
  const failDir = join(TMP, "run-fail");
  mkdirSync(failDir, { recursive: true });
  const fs2 = JSON.parse(JSON.stringify(G.states)); fs2.tasks[1].state = "failed";
  writeFileSync(join(failDir, "states.json"), JSON.stringify(fs2));
  code = 0;
  try { execFileSync(process.execPath, [join(HERE, "m1-accept.mjs"), failDir], { encoding: "utf8", stdio: "pipe" }); } catch (e) { code = e.status; }
  check(code === 3, "m1-accept exits 3 on a FAIL verdict");
}

function pixRunGroup() {
  const o = parseArgs(["x.pix"]);
  check(o.scope === "file" && o.m1Scope === "default" && o.booleans === "auto" && o.spaceEvenlySingle === "between" && o.textFit === "widen" && o.layoutOrder === "creation" &&
    o.textRead === "measure" && o.images === "archive,mcp,render" && o.missingFonts === "ask" && o.fallbackFont === "Inter/Regular" && o.maxTaskMb === 4 &&
    o.livenessWarnS === 60 && o.livenessFailS === 300 && o.ceilingMsPerNode === 20 && !o.noPixso && !o.yes && !o.dry,
    "pix-run's defaults are docs/M1.md §3's");
  check(parseArgs(["x.pix", "--no-pixso"]).images === "archive" && /one of/.test(threw(() => parseArgs(["x.pix", "--booleans", "maybe"]))) && /1 to 16/.test(threw(() => parseArgs(["x.pix", "--max-task-mb", "17"]))) &&
    /unknown option/.test(threw(() => parseArgs(["x.pix", "--frobnicate"]))) && /below/.test(threw(() => parseArgs(["x.pix", "--liveness-warn-s", "400"]))) &&
    /mcp is M4/.test(threw(() => parseArgs(["x.pix", "--source", "mcp"]))),
    "pix-run refuses values outside each setting's range; --no-pixso is --images archive");
  const S = syntheticIR({});
  const src = join(TMP, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "ir.json"), JSON.stringify(S.ir));
  writeFileSync(join(src, "stats.json"), JSON.stringify(S.stats));
  const run = (data) => {
    try { return { code: 0, out: execFileSync(process.execPath, [join(HERE, "pix-run.mjs"), "--from-ir", join(src, "ir.json"), "--stats", join(src, "stats.json"), "--dry", "--no-pixso", "--data", data], { encoding: "utf8", stdio: "pipe" }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
  };
  const r = run(join(TMP, "data"));
  check(r.code === 0 && /PREFLIGHT/.test(r.out) && /BALANCE \(adds up\)/.test(r.out) && /fonts the build uses \(2\)/.test(r.out) && /--dry: nothing was sent to Figma/.test(r.out),
    "pix-run --dry --no-pixso prints the preflight and a balance that adds up", r.out.slice(-600));
  const inRepo = run(join(REPO_ROOT, "tmp-data"));
  check(inRepo.code === 1 && /inside the repository/.test(inRepo.out) && !existsSync(join(REPO_ROOT, "tmp-data")), "pix-run refuses a data folder inside the repository");
  let junction = "";
  try { symlinkSync(REPO_ROOT, join(TMP, "link"), process.platform === "win32" ? "junction" : "dir"); }
  catch (e) { junction = "skip: " + e.message; }
  if (junction) console.log("skip the junction case: " + junction);
  else { const j = run(join(TMP, "link", "tmp-data")); check(j.code === 1 && /inside the repository/.test(j.out), "pix-run refuses a data folder reached through a junction into the repository"); }
  if (process.platform === "win32" && /^[A-Za-z]:/.test(REPO_ROOT)) {
    const flipped = (REPO_ROOT[0] === REPO_ROOT[0].toUpperCase() ? REPO_ROOT[0].toLowerCase() : REPO_ROOT[0].toUpperCase()) + REPO_ROOT.slice(1);
    const c = run(join(flipped, "tmp-data"));
    check(c.code === 1 && /inside the repository/.test(c.out), "pix-run refuses the repository named with its drive letter in the other case");
  } else console.log("skip the drive-letter case: not Windows");
  check(Object.keys(RUN_SETTINGS).length === 19, "every setting of §3 is a pix-run flag (with --data, --only, --from-ir and --stats)");
}

// ============================================================================================
try {
  await imageGroup();
  await runGroup();
  acceptGroup();
  pixRunGroup();
} catch (e) { check(false, "a test group threw", (e && e.stack) || e); }
if (failed) console.log("test-pixrun: scratch kept in " + TMP);
else { try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* a scratch folder left behind is harmless */ } }
console.log("");
console.log(failed ? "test-pixrun: " + failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "test-pixrun: all " + passed + " checks pass");
process.exitCode = failed ? 1 : 0;

// Pixso -> IR exporter, chunked + adaptive. READ-ONLY against Pixso.
// usage: node px-export.mjs <rootId> [out.json]
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , ROOT_ID, OUT = "ir.json"] = process.argv;
if (!ROOT_ID) { console.error("usage: node px-export.mjs <rootId> [out.json]"); process.exit(1); }

function run(src) {
  writeFileSync("_phase.js", src, "utf8");
  let raw;
  try {
    raw = execFileSync("node", ["mcp.mjs", "script", "_phase.js"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  } catch (e) { return { __err: "transport: " + String(e.message).slice(0, 160) }; }
  const txt = raw.trim();
  let j;
  try { j = JSON.parse(txt); } catch { return { __err: "non-JSON: " + txt.slice(0, 160) }; }
  if (j && typeof j === "object" && j.error && !j.out && !j.tree) return { __err: String(j.error) };
  return j;
}

const SER = readFileSync("ser-lib.js", "utf8");
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// ---------- phase 1: tree ----------
console.log("phase 1: tree");
const p1 = run([
  "await pixso.loadAllPagesAsync();", SER,
  "const root = pixso.getNodeById(" + JSON.stringify(ROOT_ID) + ");",
  "if (!root) return { error: 'root not found' };",
  "const t0 = Date.now();",
  "const tree = ser(root, 0);",
  "return { meta: { fileKey: pixso.fileKey, fileName: pixso.root.name, rootId: root.id, rootName: root.name, ms: Date.now() - t0 },",
  "  tree: tree, styleIds: [...styleIds],",
  "  compRefs: [...compRefs.entries()].map(function (e) { return { key: e[0], id: e[1].id, setId: e[1].setId }; }),",
  "  fonts: [...fonts.values()], imageHashes: [...imageHashes], warnings: warn };"
].join("\n"));
if (p1.__err || p1.error) { console.error("phase 1 failed:", p1.__err || p1.error); process.exit(1); }
let nodes = 0; (function w(x) { nodes++; if (x.children) x.children.forEach(w); })(p1.tree);
console.log("  " + nodes + " nodes | " + p1.styleIds.length + " style refs | " + p1.compRefs.length +
  " component refs | " + p1.fonts.length + " fonts | " + p1.imageHashes.length + " images | " + p1.meta.ms + " ms");

// ---------- phase 2: styles ----------
console.log("phase 2: styles");
const styles = {};
for (const batch of chunk(p1.styleIds, 40)) {
  const r = run([
    SER, "const out = {};",
    "for (const sid of " + JSON.stringify(batch) + ") {",
    "  try {",
    "    const st = await pixso.getStyleByIdAsync(sid);",
    "    if (!st) { out[sid] = { missing: true }; continue; }",
    "    const s = { name: st.name, type: st.type, key: st.key, remote: st.remote };",
    "    try { if (st.paints) s.paints = val(st.paints); } catch (e) {}",
    "    try { if (st.effects) s.effects = val(st.effects); } catch (e) {}",
    "    try { if (st.layoutGrids) s.layoutGrids = val(st.layoutGrids); } catch (e) {}",
    "    for (const k of ['fontName','fontSize','letterSpacing','lineHeight','paragraphIndent','paragraphSpacing','textCase','textDecoration']) {",
    "      try { if (st[k] !== undefined) s[k] = val(st[k]); } catch (e) {}",
    "    }",
    "    out[sid] = s;",
    "  } catch (e) { out[sid] = { error: String(e) }; }",
    "}",
    "return { out: out };"
  ].join("\n"));
  if (r.__err) { console.log("  batch failed: " + r.__err); continue; }
  Object.assign(styles, r.out);
  process.stdout.write(".");
}
console.log(" " + Object.keys(styles).length + " styles");

// ---------- phase 3: component definitions (adaptive) ----------
console.log("phase 3: component definitions");
const components = {};
function compScript(batch) {
  return [
    "await pixso.loadAllPagesAsync();", SER, "const out = {};",
    "for (const ref of " + JSON.stringify(batch) + ") {",
    "  try {",
    "    const c = pixso.getNodeById(ref.id);",
    "    if (!c) { out[ref.key] = { missing: true, id: ref.id }; continue; }",
    "    const rec = { name: c.name, key: ref.key, nodeId: c.id, remote: c.remote };",
    "    try { if (c.description) rec.description = c.description; } catch (e) {}",
    "    try { if (c.parent && c.parent.type === 'COMPONENT_SET') { rec.setKey = c.parent.key; rec.setName = c.parent.name; rec.variantProperties = val(c.variantProperties); rec.setPropertyDefinitions = val(c.parent.componentPropertyDefinitions); } } catch (e) {}",
    "    try { rec.componentPropertyDefinitions = val(c.componentPropertyDefinitions); } catch (e) {}",
    "    rec.node = ser(c, 0);",
    "    out[ref.key] = rec;",
    "  } catch (e) { out[ref.key] = { error: String(e) }; }",
    "}",
    "return { out: out, styleIds: [...styleIds], fonts: [...fonts.values()], imageHashes: [...imageHashes] };"
  ].join("\n");
}
function absorb(r) {
  Object.assign(components, r.out);
  for (const s of r.styleIds || []) if (!p1.styleIds.includes(s)) p1.styleIds.push(s);
  for (const f of r.fonts || []) if (!p1.fonts.some((x) => x.family === f.family && x.style === f.style)) p1.fonts.push(f);
  for (const h of r.imageHashes || []) if (!p1.imageHashes.includes(h)) p1.imageHashes.push(h);
}
const queue = chunk(p1.compRefs, 8);
let splits = 0, hardFail = 0;
while (queue.length) {
  const batch = queue.shift();
  const r = run(compScript(batch));
  if (r.__err) {
    if (batch.length > 1) { const h = Math.ceil(batch.length / 2); queue.unshift(batch.slice(h)); queue.unshift(batch.slice(0, h)); splits++; continue; }
    components[batch[0].key] = { error: r.__err, id: batch[0].id }; hardFail++;
    process.stdout.write("x"); continue;
  }
  absorb(r);
  process.stdout.write(".");
}
console.log(" " + Object.keys(components).length + " defs (" + splits + " splits, " + hardFail + " hard failures)");

// ---------- phase 4: styles discovered inside component definitions ----------
const missingStyles = p1.styleIds.filter((s) => !styles[s]);
if (missingStyles.length) {
  console.log("phase 4: +" + missingStyles.length + " styles from component defs");
  for (const batch of chunk(missingStyles, 40)) {
    const r = run([
      SER, "const out = {};",
      "for (const sid of " + JSON.stringify(batch) + ") {",
      "  try { const st = await pixso.getStyleByIdAsync(sid);",
      "    if (!st) { out[sid] = { missing: true }; continue; }",
      "    const s = { name: st.name, type: st.type, key: st.key, remote: st.remote };",
      "    try { if (st.paints) s.paints = val(st.paints); } catch (e) {}",
      "    try { if (st.effects) s.effects = val(st.effects); } catch (e) {}",
      "    for (const k of ['fontName','fontSize','letterSpacing','lineHeight','textCase','textDecoration']) { try { if (st[k] !== undefined) s[k] = val(st[k]); } catch (e) {} }",
      "    out[sid] = s;",
      "  } catch (e) { out[sid] = { error: String(e) }; }",
      "}",
      "return { out: out };"
    ].join("\n"));
    if (!r.__err) Object.assign(styles, r.out);
    process.stdout.write(".");
  }
  console.log("");
}

// ---------- write ----------
const ir = {
  meta: Object.assign({}, p1.meta, { irVersion: "0.2", source: "pixso", exportedAt: new Date().toISOString() }),
  fonts: p1.fonts, imageHashes: p1.imageHashes, styles, components, tree: p1.tree, warnings: p1.warnings
};
writeFileSync(OUT, JSON.stringify(ir, null, 1), "utf8");

const styleErr = Object.values(styles).filter((s) => s.error || s.missing).length;
const compErr = Object.values(components).filter((c) => c.error || c.missing).length;
let compNodes = 0;
for (const c of Object.values(components)) if (c.node) (function w(x) { compNodes++; if (x.children) x.children.forEach(w); })(c.node);
const failedKeys = new Set(Object.entries(components).filter(([, v]) => v.error || v.missing).map(([k]) => k));
let orphanInstances = 0;
(function w(n) { if (n.mainComponentKey && failedKeys.has(n.mainComponentKey)) orphanInstances++; if (n.children) n.children.forEach(w); })(ir.tree);

console.log("\nIR: " + OUT + "  " + (readFileSync(OUT).length / 1024 / 1024).toFixed(2) + " MB");
console.log("  tree nodes:        " + nodes);
console.log("  component defs:    " + Object.keys(components).length + "  (" + compNodes + " nodes inside)  unresolved: " + compErr);
console.log("  styles:            " + Object.keys(styles).length + "  unresolved: " + styleErr);
console.log("  fonts:             " + p1.fonts.map((f) => f.family + " " + f.style).join(", "));
console.log("  images:            " + p1.imageHashes.length);
console.log("  orphan instances:  " + orphanInstances);
console.log("  warnings:          " + p1.warnings.length);

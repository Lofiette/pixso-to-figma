// Building a whole file, as a function rather than a script.
//
// It was a script, and a script owns its own runner. That is fine from a terminal and useless
// behind a button: the plugin may only talk to one address, so if the migration is to be started
// from the plugin then one process has to hold that address for the whole run — extraction
// included, which is the long part and the part worth watching. So the loop lives here and both
// the command line and the button call it with a server they already own.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function buildAll({ srv, dirs, pages, clean, say = console.log }) {
  const pageFor = (rootId) => {
    if (!pages) return null;
    for (const p of pages.pages) for (const c of p.children) if (c.id === rootId) return p;
    return null;
  };

  if (clean) {
    // What to remove is asked twice, because an id alone is not safe to delete by. A rootId
    // recorded by an earlier run can resolve to an unrelated node — measured: two objects in a run
    // of 45 reported ids belonging to nodes built long before them. Deleting whatever answers to a
    // number would then take a stranger out of the designer's file. So: a node found by id is
    // removed only if it is unstamped (an older build, where the id is all there is) or stamped
    // with the source this run is about to rebuild; and every node carrying that stamp is removed,
    // which also clears duplicates a previous run may have left.
    const want = [];
    for (const d of dirs) {
      let src = null, id = null;
      try { src = JSON.parse(readFileSync(join(d, "payload-meta.json"), "utf8")).rootId; } catch (e) {}
      try { id = JSON.parse(readFileSync(join(d, "build-report.json"), "utf8")).rootId; } catch (e) {}
      if (src || id) want.push({ src: src ? String(src) : null, id: id || null });
    }
    if (want.length) {
      const V = [
        "const want = " + JSON.stringify(want) + ";",
        "const srcs = {}; for (const w of want) if (w.src) srcs[w.src] = 1;",
        "const stamp = function (n) { try { return n.getPluginData('pxSrc'); } catch (e) { return ''; } };",
        "let gone = 0, spared = 0;",
        "const doomed = [];",
        "for (const p of figma.root.children) for (const k of p.children) if (stamp(k) && srcs[stamp(k)]) doomed.push(k);",
        "for (const w of want) {",
        "  if (!w.id) continue;",
        "  const n = await figma.getNodeByIdAsync(w.id);",
        "  if (!n || n.removed || doomed.indexOf(n) >= 0) continue;",
        "  const s = stamp(n);",
        "  if (!s || (w.src && s === String(w.src))) doomed.push(n); else spared++;",
        "}",
        "for (const n of doomed) { try { if (!n.removed) { n.remove(); gone++; } } catch (e) {} }",
        "RESULT = { removed: gone, of: want.length, spared: spared };",
      ].join(String.fromCharCode(10));
      try {
        const rc = await srv.post({ kind: "render", rootNodeId: "0:0" }, JSON.stringify({ V }), new Map(), 600000);
        say("cleared " + (rc.removed || 0) + " of " + want.length + " roots this run will rebuild" +
          (rc.spared ? " (" + rc.spared + " id" + (rc.spared === 1 ? "" : "s") + " now belonged to something else and was left alone)" : ""));
      } catch (e) { say("could not clear previous builds: " + e.message); }
    }
  }

  const results = [];
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i], name = basename(dir);
    const f = (n) => join(dir, n);
    say("[" + (i + 1) + "/" + dirs.length + "] " + name);
    if (existsSync(f("textruns.json"))) process.env.PX_TEXTRUNS = f("textruns.json");
    else delete process.env.PX_TEXTRUNS;
    if (existsSync(f("paintsub.json"))) process.env.PX_PAINTSUB = f("paintsub.json");
    else delete process.env.PX_PAINTSUB;

    const images = new Map();
    if (existsSync(f("img/manifest.json"))) {
      for (const m of JSON.parse(readFileSync(f("img/manifest.json"), "utf8"))) {
        images.set(m.hash, readFileSync(join(f("img"), basename(m.file))));
      }
    }

    let meta = null;
    try { meta = JSON.parse(readFileSync(f("payload-meta.json"), "utf8")); } catch (e) {}
    const pg = meta ? pageFor(meta.rootId) : null;
    const jobPage = pg ? { page: pg.name, pageBg: pg.backgrounds || null } : {};

    let payload = readFileSync(f("payload.json"), "utf8");
    // Roughly linear in node count, so the allowance follows the payload rather than a flat limit.
    const budget = Math.max(10 * 60 * 1000, Math.round(payload.length / 1000) * 400);
    let r;
    try { r = await srv.post(Object.assign({ kind: "build" }, jobPage), payload, images, budget); }
    catch (e) { say("    " + e.message); results.push({ name, error: e.message }); continue; }
    if (r.error) { say("    build failed: " + r.error); results.push({ name, error: r.error }); continue; }
    const subs = [...new Set(r.fontSubs || [])];
    if (subs.length) say("    fonts substituted: " + subs.join(", "));

    // Second pass for text whose instance override Pixso will not disclose.
    const lost = r.textOverrideLost || [];
    if (lost.length) {
      say("    " + lost.length + " undisclosed text override(s) — rendering them from the canvas");
      try {
        const rootId = JSON.parse(readFileSync(f("ir.json"), "utf8")).meta.rootId;
        const sh = (s, a) => execFileSync("node", [join(HERE, s), ...a], { stdio: "ignore", cwd: HERE });
        sh("px-lostpaths.mjs", [f("ir.json"), f("textlost.json"), ...lost.map((t) => String(t.i))]);
        sh("px-textsvg.mjs", [rootId, f("textlost.json"), f("textsvg.json")]);
        sh("pack4.mjs", [f("ir.json"), rootId, f("svg.json"), f("bounds.json"), f("abs.json"),
          f("payload2.png"), f("textink.json"), f("textsvg.json")]);
        payload = readFileSync(f("payload2.json"), "utf8");
        const r2 = await srv.post(Object.assign({ kind: "build", cleanupRootId: r.rootId }, jobPage), payload, images, budget);
        if (r2.error) throw new Error(r2.error);
        r = r2;
      } catch (e) { say("    second pass failed: " + e.message + " — keeping the first build"); }
    }
    writeFileSync(f("build-report.json"), JSON.stringify(r, null, 2), "utf8");

    let c;
    try { c = await srv.post(Object.assign({ kind: "verify", rootNodeId: r.rootId }, jobPage), payload, new Map(), budget); }
    catch (e) { say("    verify: " + e.message); results.push({ name, error: e.message }); continue; }
    writeFileSync(f("check-report.json"), JSON.stringify(c, null, 2), "utf8");
    // The id the build reported is not always the node the check finds. Say so when it happens
    // rather than letting a silently corrected lookup pass for a clean one.
    if (c.rootRelocated) {
      say("    note: the build reported root " + c.rootRelocated.asked + ", which is now " +
        c.rootRelocated.was + " — checked " + c.rootRelocated.found + " instead, found by its stamp");
    }
    if (c.rootAmbiguous) say("    note: " + c.rootAmbiguous + " nodes carry this source stamp — checked the newest");
    say("    " + c.count + "/" + c.expected + " nodes, " + c.visibleOver05 + " out of position" +
      (c.visibleOver05 ? " (worst " + c.maxPosVisible + " px)" : ""));
    results.push({ name, rootId: c.rootUsed || r.rootId, relocated: !!c.rootRelocated, nodes: c.count, expected: c.expected,
      posOver: c.visibleOver05, worstPos: c.maxPosVisible, maxSize: c.maxSize, sizeOver: c.sizeOver || 0,
      failures: (r.failures || []).length, fontSubs: subs });
  }
  return results;
}

// A font this machine does not have is not a defect in the migration and must not be presented as
// one — but it must not be hidden either, or a run reads as broken when the algorithm did its job.
export function verdict(results, say = console.log) {
  let exact = 0, heldByFonts = 0, wrong = 0, errored = 0, relocated = 0;
  const fontUse = new Map();
  const bad = [];
  for (const r of results) {
    if (r.error) { errored++; bad.push(r.name + ": " + String(r.error).slice(0, 60)); continue; }
    if (r.relocated) relocated++;
    for (const f of r.fontSubs) fontUse.set(f, (fontUse.get(f) || 0) + 1);
    const ok = r.nodes === r.expected && r.posOver === 0 && r.sizeOver === 0 && r.failures === 0;
    if (ok) exact++;
    else if (r.fontSubs.length) heldByFonts++;
    else { wrong++; bad.push(r.name + ": " + r.posOver + " out of position, worst " + r.worstPos + " px"); }
  }
  if (fontUse.size) {
    say("");
    say("fonts this machine does not have:");
    for (const [f, n] of [...fontUse.entries()].sort((a, b) => b[1] - a[1])) {
      say("  " + f.replace("|", " ") + " — " + n + " object" + (n === 1 ? "" : "s"));
    }
    say("  Install them, restart Figma (it scans fonts only at startup), and run again.");
  }
  say("");
  say("exact                    " + exact + " of " + results.length);
  if (heldByFonts) say("held back by fonts       " + heldByFonts + "   (not a migration defect)");
  if (wrong) say("wrong, fonts all present " + wrong + "   <- these are the real ones");
  if (errored) say("failed to build          " + errored);
  // Not a defect in the result — the object was built and checked. It is a defect in the handle,
  // and it stays visible until it is understood.
  if (relocated) say("root found by stamp      " + relocated + "   (the id the build reported had gone stale)");
  for (const b of bad.slice(0, 10)) say("   " + b);
  const clean = wrong === 0 && errored === 0;
  say("");
  say(clean ? (heldByFonts ? "PASS apart from the missing fonts" : "PASS") : "NOT CLEAN");
  return { exact, heldByFonts, wrong, errored, clean };
}

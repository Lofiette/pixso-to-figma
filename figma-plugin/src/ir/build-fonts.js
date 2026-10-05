// Fonts for the IR path (docs/M1.md D16, §6 B step 1). Part B. Bundled as
// (function (IR) { … })(PXF_IR) after common.js, before build.js.
//
//   IR.ops.fonts(ctx, task) -> Promise<{ op: "fonts", taskNo, runId, plugin, available: [{family, style}],
//                                        missing: [{family, style}], ms, codes, coded, failures }>
//     The preflight (D16). listAvailableFontsAsync once; a task font Figma does not list is missing
//     without a load; every listed one is loaded (all at once), and one that will not load is missing
//     too. available is the task fonts that loaded, in task order; missing likewise. The runner prints
//     the missing ones as FONT_MISSING and stops unless --missing-fonts substitute. Records
//     ctx.S.fonts["family|style"] = "ok" for every font that loaded. ms.fonts is its time.
//
//   IR.B.fontsPhase(st)  the build's fonts phase: every task font loaded at once
//     (Promise.all(loadFontAsync)); one that fails is marked ctx.S.fonts[key] = "sub" and the text
//     that uses it is written with task.settings.fallbackFont (IR.textFont), which is then loaded;
//     a fallback that will not load refuses the task, since no text could be written.
var B = IR.B || (IR.B = {});

function fontOf(f) { return { family: String(f.family), style: String(f.style) }; }
B.fontKey = function (f) { return String(f.family) + "|" + String(f.style); };
function msgOf(e) { return String((e && e.message) || e); }

// Loads the fonts at once: { ok: [font], missing: [{ font, msg }] }, in the order given.
B.loadFonts = function (ctx, fonts) {
  var list = Array.isArray(fonts) ? fonts : [];
  ctx.progress();
  return Promise.all(list.map(function (f) {
    var font = fontOf(f);
    return ctx.figma.loadFontAsync(font).then(function () { return { font: font, ok: true }; },
      function (e) { return { font: font, ok: false, msg: msgOf(e) }; });
  })).then(function (rs) {
    ctx.progress();
    var out = { ok: [], missing: [] };
    for (var j = 0; j < rs.length; j++) { if (rs[j].ok) out.ok.push(rs[j].font); else out.missing.push({ font: rs[j].font, msg: rs[j].msg }); }
    return out;
  });
};

IR.ops.fonts = async function (ctx, task) {
  if (!task || task.op !== "fonts") IR.util.refuse("the fonts op runs a fonts task; this one is " + JSON.stringify(task && task.op));
  ctx.phase("fonts");
  var listed = {};
  ctx.progress();
  var all = await ctx.figma.listAvailableFontsAsync();
  ctx.progress();
  for (var j = 0; j < (all || []).length; j++) { var fn = all[j] && all[j].fontName; if (fn) listed[B.fontKey(fn)] = 1; }
  var want = Array.isArray(task.fonts) ? task.fonts.map(fontOf) : [];
  var toLoad = want.filter(function (f) { return listed[B.fontKey(f)] === 1; });
  var loaded = await B.loadFonts(ctx, toLoad);
  var okSet = {};
  for (var k = 0; k < loaded.ok.length; k++) { okSet[B.fontKey(loaded.ok[k])] = 1; ctx.S.fonts[B.fontKey(loaded.ok[k])] = "ok"; }
  ctx.phase(null);
  var R = ctx.report;
  R.plugin = typeof PXF_VERSION !== "undefined" ? PXF_VERSION : null;
  R.available = want.filter(function (f) { return okSet[B.fontKey(f)] === 1; });
  R.missing = want.filter(function (f) { return okSet[B.fontKey(f)] !== 1; });
  return R;
};

B.fontsPhase = async function (st) {
  var ctx = st.ctx, task = st.task;
  var res = await B.loadFonts(ctx, task.fonts);
  for (var j = 0; j < res.ok.length; j++) ctx.S.fonts[B.fontKey(res.ok[j])] = "ok";
  for (var k = 0; k < res.missing.length; k++) {
    ctx.S.fonts[B.fontKey(res.missing[k].font)] = "sub";
    ctx.log("font " + res.missing[k].font.family + " " + res.missing[k].font.style + " is missing: " + res.missing[k].msg);
  }
  if (res.missing.length) {
    var fb = fontOf(task.settings.fallbackFont);
    if (ctx.S.fonts[B.fontKey(fb)] === "sub") IR.util.refuse("the fallback font " + fb.family + " " + fb.style + " is itself missing; no text can be written");
    try { ctx.progress(); await ctx.figma.loadFontAsync(fb); ctx.progress(); }
    catch (e) { IR.util.refuse("the fallback font " + fb.family + " " + fb.style + " does not load (" + msgOf(e) + "); no text can be written"); }
  }
  st.fontsMissing = res.missing.length;
};

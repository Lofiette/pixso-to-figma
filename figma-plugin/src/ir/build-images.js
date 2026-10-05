// Images for the IR builder (docs/M1.md §6 B step 2, D9). Part B. Bundled as
// (function (IR) { … })(PXF_IR) after common.js.
//
//   IR.B.imagesPhase(st)          the build's images phase: one table per build ctx, from task.images
//                                 and what the host created this session (ctx.S.images(),
//                                 ctx.S.imageErrors()). Reads no layout.
//   IR.mapPaints(ctx, list, i)    -> a new paint list: every IMAGE paint either names the Figma hash of
//                                 its bytes, or becomes IMAGE_PLACEHOLDER, a fixed grey SOLID paint.
//                                 The builder never writes an IMAGE paint whose hash has no Figma image.
//
// How a task image resolves (one entry per hash):
//   source "none"                         placeholder ("none: <reason>")
//   Figma refused the bytes (imageErrors)  placeholder ("refused: <message>")
//   the host never created it              placeholder ("unknown")
//   created, Figma hash = source hash      the IMAGE paint is written (imagesPlaced)
//   created, hash differs, archive or mcp  an error (a failure entry, never a silent remap) and a
//                                          placeholder: the bytes are not the ones the IR names
//   created, hash differs, render          the Figma hash is used and the remap counted
//                                          (detail.imagesRemapped): a render is new bytes by design
// IMAGE_PLACEHOLDER is coded once per node and hash, with the reason as its detail. A ctx without a
// table (part C's verify, writing ranges onto its scratch node) gets the placeholder and no code.
var B = IR.B || (IR.B = {});
var CODE = IR.CODE;
var TABLES = typeof WeakMap === "function" ? new WeakMap() : null;
var PLACEHOLDER_RGB = { r: 0.8, g: 0.8, b: 0.8 };
B.PLACEHOLDER_RGB = PLACEHOLDER_RGB;

function own(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }

B.imagesPhase = function (st) {
  var ctx = st.ctx, task = st.task;
  var made = ctx.S.images() || {}, refused = ctx.S.imageErrors() || {};
  var table = { byHash: {}, coded: {}, placed: 0, remapped: 0 };
  var list = Array.isArray(task.images) ? task.images : [];
  for (var j = 0; j < list.length; j++) {
    var m = list[j], h = String(m.hash), e;
    if (m.source === "none") e = { hash: null, why: "none: " + (m.reason === null || m.reason === undefined ? "no bytes" : m.reason) };
    else if (own(refused, h)) e = { hash: null, why: "refused: " + String(refused[h]).slice(0, 120) };
    else if (!own(made, h)) e = { hash: null, why: "unknown: the host created no image for it" };
    else if (made[h] === h) e = { hash: h, why: null };
    else if (m.source === "render") { e = { hash: String(made[h]), why: null }; table.remapped++; }
    else {
      ctx.failure(null, "images", "image " + h.slice(0, 8) + " (" + m.source + "): Figma gave the bytes another hash; an " + m.source + " image is never remapped");
      e = { hash: null, why: "hash differs (" + m.source + ")" };
    }
    table.byHash[h] = e;
    ctx.progress();
  }
  if (TABLES) TABLES.set(ctx, table);
  st.images = table;
  return table;
};

IR.mapPaints = function (ctx, list, i) {
  if (!Array.isArray(list)) return list;
  var table = TABLES ? TABLES.get(ctx) : null;
  var out = [];
  for (var j = 0; j < list.length; j++) {
    var p = list[j];
    if (!p || typeof p !== "object" || p.type !== "IMAGE") { out.push(p); continue; }
    var h = String(p.imageHash), e = table && own(table.byHash, h) ? table.byHash[h] : null;
    if (e && e.hash) {
      var q = JSON.parse(JSON.stringify(p));
      q.imageHash = e.hash;
      out.push(q);
      table.placed++;
      continue;
    }
    var ph = { type: "SOLID", color: { r: PLACEHOLDER_RGB.r, g: PLACEHOLDER_RGB.g, b: PLACEHOLDER_RGB.b },
      opacity: typeof p.opacity === "number" ? p.opacity : 1, visible: p.visible !== false };
    if (typeof p.blendMode === "string") ph.blendMode = p.blendMode;
    out.push(ph);
    if (table) {
      var key = String(i) + "|" + h;
      if (!own(table.coded, key)) {
        table.coded[key] = 1;
        ctx.code(CODE.IMAGE_PLACEHOLDER, i === undefined ? null : i, e ? e.why : "unlisted: the task's images do not name it");
      }
    }
  }
  return out;
};

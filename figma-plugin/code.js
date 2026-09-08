// pix-to-fig runner — the Figma half of the migration.
//
// This file deliberately holds NO migration logic. The builder and the verifier arrive inside the
// job as PAY.B and PAY.V and are run with the AsyncFunction constructor, so the algorithm lives in
// exactly one place (tools/builder4.js) and is edited there. This is a transport and a host.
figma.showUI(__html__, { width: 380, height: 260 });

var buf = [], job = null, images = {};

function log(m) { figma.ui.postMessage({ t: "log", m: String(m) }); }

figma.ui.onmessage = async function (msg) {
  if (msg.t === "payload-begin") {
    job = { id: msg.id, kind: msg.kind, total: msg.total,
            rootNodeId: msg.rootNodeId, cleanupRootId: msg.cleanupRootId,
            page: msg.page || null, pageBg: msg.pageBg || null };
    buf = []; images = {};
    return;
  }
  if (msg.t === "payload-chunk") { buf.push(msg.d); return; }

  if (msg.t === "image") {
    // Content-addressed on both sides: identical bytes give an identical hash, so this map is
    // usually the identity. It is not for images whose bytes Pixso never held locally, which the
    // runner substitutes with a render.
    try {
      var im = figma.createImage(new Uint8Array(msg.bytes));
      images[msg.hash] = im.hash;
    } catch (e) { log("image " + String(msg.hash).slice(0, 8) + " failed: " + (e.message || e)); }
    return;
  }

  if (msg.t !== "payload-end" || !job) return;

  var report;
  try {
    var PAY = JSON.parse(buf.join(""));
    buf = [];
    PAY.IMG = images;
    var AF = Object.getPrototypeOf(async function () {}).constructor;
    var NL = String.fromCharCode(10);

    // A file is not one page. The builder always appends to figma.currentPage, so the page is
    // chosen here: an existing one by name, or a new one created and named to match the source.
    if (job.page) {
      var target = figma.root.children.filter(function (p) { return p.name === job.page; })[0];
      if (!target) { target = figma.createPage(); target.name = job.page; log("created page " + JSON.stringify(job.page)); }
      if (job.pageBg) { try { target.backgrounds = job.pageBg; } catch (eb) { log("page background: " + (eb.message || eb)); } }
      if (figma.currentPage !== target) await figma.setCurrentPageAsync(target);
    }

    if (job.kind === "build") {
      report = await new AF("figma", "PAY", "let RESULT=null;" + NL + PAY.B + NL + "return RESULT;")(figma, PAY);
      // Only ever removes a root this same run created moments ago, when a second pass is needed
      // because undisclosed text overrides had to be rendered and repacked.
      if (job.cleanupRootId) {
        try {
          var old = await figma.getNodeByIdAsync(job.cleanupRootId);
          if (old && !old.removed) { old.remove(); log("removed provisional build " + job.cleanupRootId); }
        } catch (e2) { log("cleanup failed: " + (e2.message || e2)); }
      }
    } else {
      report = await new AF("figma", "PAY", "ROOT_NODE_ID", "let RESULT=null;" + NL + PAY.V + NL + "return RESULT;")(figma, PAY, job.rootNodeId);
    }
  } catch (e3) {
    report = { error: String((e3 && e3.message) || e3), stack: String((e3 && e3.stack) || "").slice(0, 900) };
  }

  // The payload comes in slices because a multi-megabyte string does not survive one message.
  // The report goes back the same way, for the same reason: a report carrying a rendered image
  // silently never arrived, the UI frame stayed latched on "busy" and went on heartbeating, so the
  // runner saw a live plugin that would never take another job. Slice it.
  var text = "";
  try { text = JSON.stringify(report); }
  catch (e4) { text = JSON.stringify({ error: "report not serialisable: " + String((e4 && e4.message) || e4) }); }
  var OUT = 400000;
  figma.ui.postMessage({ t: "report-begin", id: job.id, total: text.length });
  for (var o2 = 0; o2 < text.length; o2 += OUT) {
    figma.ui.postMessage({ t: "report-chunk", id: job.id, d: text.substr(o2, OUT) });
  }
  figma.ui.postMessage({ t: "report-end", id: job.id });
  job = null;
};

import { startJobServer } from "./jobserver.mjs";
const srv = startJobServer(3778);
await srv.ready;
const V = [
  "await figma.loadFontAsync({ family: 'Manrope', style: 'SemiBold' });",
  "const p = figma.createText();",
  "figma.currentPage.appendChild(p);",
  "p.fontName = { family: 'Manrope', style: 'SemiBold' };",
  "p.textAutoResize = 'WIDTH_AND_HEIGHT';",
  "p.fontSize = 140;",
  "p.characters = 'Ay';",
  "const out = [];",
  "for (const lh of [{ unit: 'AUTO' }, { unit: 'PIXELS', value: 140 }, { unit: 'PIXELS', value: 240 }]) {",
  "  p.lineHeight = lh;",
  "  const bb = p.absoluteBoundingBox, rb = p.absoluteRenderBounds;",
  "  out.push({ lh: lh.unit === 'AUTO' ? 'AUTO' : lh.value, h: p.height,",
  "    inkTop: rb && bb ? Math.round((rb.y - bb.y) * 100) / 100 : null,",
  "    inkH: rb ? Math.round(rb.height * 100) / 100 : null });",
  "}",
  "p.remove();",
  "RESULT = { out: out };",
].join(String.fromCharCode(10));
try { console.log(JSON.stringify((await srv.post({ kind: "render", rootNodeId: "0:0" }, JSON.stringify({ V }), new Map(), 60000)).out)); }
catch (e) { console.log("FAILED: " + e.message); }
srv.close();

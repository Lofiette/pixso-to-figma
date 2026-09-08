import { startJobServer } from "./jobserver.mjs";
const srv = startJobServer(3778);
await srv.ready;
const V = [
  "await figma.loadFontAsync({ family: 'Manrope', style: 'SemiBold' });",
  "const p = figma.createText();",
  "figma.currentPage.appendChild(p);",
  "p.fontName = { family: 'Manrope', style: 'SemiBold' };",
  "p.textAutoResize = 'WIDTH_AND_HEIGHT';",
  "p.lineHeight = { unit: 'AUTO' };",
  "p.fontSize = 140;",
  "p.characters = 'A';",
  "const h1 = p.height;",
  "p.characters = 'A' + String.fromCharCode(10) + 'A';",
  "const h2 = p.height;",
  "p.characters = 'A' + String.fromCharCode(10) + 'A' + String.fromCharCode(10) + 'A';",
  "const h3 = p.height;",
  "p.remove();",
  "RESULT = { h1: h1, h2: h2, h3: h3, pitch2: h2 - h1, pitch3: h3 - h2 };",
].join(String.fromCharCode(10));
try { console.log(JSON.stringify(await srv.post({ kind: "render", rootNodeId: "0:0" }, JSON.stringify({ V }), new Map(), 60000))); }
catch (e) { console.log("FAILED: " + e.message); }
srv.close();

// Test what --clean is allowed to delete, against nodes made here for the purpose.
//
// This code removes nodes from the designer's file. The old version deleted whatever answered to a
// remembered id, and ids have been measured going stale — so the new rule needs proving before it
// runs over anything real, not after.
//
//   node test-clean.mjs
//
// Needs the runner plugin open in a Figma file. It makes four rectangles far off-canvas, checks
// what the rule deletes and what it spares, and sweeps them up again.
import { startJobServer } from "./jobserver.mjs";
import { cleanScript } from "./build-lib.mjs";

const NL = String.fromCharCode(10);
const srv = startJobServer(3778);
await srv.ready;
const run = (V) => srv.post({ kind: "render", rootNodeId: "0:0" }, JSON.stringify({ V }), new Map(), 120000);

let bad = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { bad++; console.log("FAIL " + m); };

// Four scratch rectangles: two sharing a source stamp, one with a different stamp, one unstamped.
const make = [
  "const page = figma.currentPage;",
  "const mk = function (name, stampVal) {",
  "  const r = figma.createRectangle();",
  "  r.name = name; r.resize(40, 40); r.x = -4000; r.y = -4000;",
  "  page.appendChild(r);",
  "  if (stampVal) r.setPluginData('pxSrc', stampVal);",
  "  return r.id;",
  "};",
  "RESULT = { A: mk('pxf-test-A', 'px-A'), B: mk('pxf-test-B', 'px-B'), C: mk('pxf-test-C', ''), D: mk('pxf-test-D', 'px-A') };",
].join(NL);
const ids = await run(make);
console.log("made " + JSON.stringify(ids));

// A stamped node whose stamp is not being rebuilt must survive being named by a stale id.
const r1 = await run(cleanScript([{ src: "px-Z", id: ids.B }]));
console.log("  asked to clear source px-Z, naming B's id: " + JSON.stringify(r1));
if (r1.removed === 0 && r1.spared === 1) ok("a stale id pointing at another object's root is spared");
else fail("expected removed 0 / spared 1, got " + JSON.stringify(r1));

// The source being rebuilt: both nodes carrying it go, and an unstamped node named by id goes too.
const r2 = await run(cleanScript([{ src: "px-A", id: ids.C }]));
console.log("  asked to clear source px-A, naming C's id: " + JSON.stringify(r2));
if (r2.removed === 3) ok("both copies of the rebuilt source and the unstamped node were removed");
else fail("expected 3 removed (A, D by stamp; C by id), got " + JSON.stringify(r2));

// And what is actually left.
const left = await run([
  "await figma.loadAllPagesAsync();",
  "const out = [];",
  "for (const p of figma.root.children) for (const k of p.children) if (String(k.name).indexOf('pxf-test-') === 0) out.push(k.name);",
  "RESULT = { left: out.sort() };",
].join(NL));
console.log("  still in the file: " + JSON.stringify(left.left));
if (left.left.length === 1 && left.left[0] === "pxf-test-B") ok("exactly the node that should have survived did");
else fail("expected only pxf-test-B to remain, found " + JSON.stringify(left.left));

// Leave the file as it was found.
const swept = await run([
  "await figma.loadAllPagesAsync();",
  "let n = 0;",
  "for (const p of figma.root.children) for (const k of p.children.slice()) if (String(k.name).indexOf('pxf-test-') === 0) { k.remove(); n++; }",
  "RESULT = { swept: n };",
].join(NL));
console.log("  swept up " + swept.swept + " scratch node(s)");

srv.close();
console.log(bad ? bad + " FAILED" : "the delete rule behaves as intended");
process.exit(bad ? 1 : 0);

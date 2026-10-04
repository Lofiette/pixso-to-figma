// Test what --clean is allowed to delete, against nodes made here for the purpose.
//
// This code removes nodes from the designer's file. The old version deleted whatever answered to a
// remembered id, and ids have been measured going stale — so the new rule needs proving before it
// runs over anything real, not after.
//
//   node test-clean.mjs
//
// Needs the runner plugin open in a Figma file. It makes four rectangles far off-canvas, checks
// what the rule deletes and what it spares, and sweeps them up again. Everything goes through the
// plugin's fixed commands — the rule itself is CLEAN, the rectangles are RENDER scratch operations —
// so what is proved here is exactly what --clean runs. tools/test-plugin.mjs runs the same scenario
// offline, against a stand-in for Figma.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanJob } from "./build-lib.mjs";

// `post(job, payloadText)` resolves with the plugin's report. Returns the number of failures.
export async function cleanScenario(post, out = console.log) {
  let bad = 0;
  const ok = (m) => out("ok   " + m);
  const fail = (m) => { bad++; out("FAIL " + m); };
  const render = async (args) => {
    const r = await post({ kind: "render" }, JSON.stringify(args));
    if (r && r.error) throw new Error("render " + args.op + ": " + r.error);
    return r;
  };
  const clean = async (want) => {
    const c = cleanJob(want);
    const r = await post(c.job, c.payload);
    if (r && r.error) throw new Error("clean: " + r.error);
    return r;
  };

  // Four scratch rectangles: two sharing a source stamp, one with a different stamp, one unstamped.
  const made = await render({ op: "scratch-make", nodes: [
    { name: "pxf-test-A", stamp: "px-A" }, { name: "pxf-test-B", stamp: "px-B" },
    { name: "pxf-test-C", stamp: "" }, { name: "pxf-test-D", stamp: "px-A" },
  ] });
  const ids = { A: made.ids[0], B: made.ids[1], C: made.ids[2], D: made.ids[3] };
  out("made " + JSON.stringify(ids));

  // A stamped node whose stamp is not being rebuilt must survive being named by a stale id.
  const r1 = await clean([{ src: "px-Z", id: ids.B }]);
  out("  asked to clear source px-Z, naming B's id: " + JSON.stringify(r1));
  if (r1.removed === 0 && r1.spared === 1) ok("a stale id pointing at another object's root is spared");
  else fail("expected removed 0 / spared 1, got " + JSON.stringify(r1));

  // The source being rebuilt: both nodes carrying it go, and an unstamped node named by id goes too.
  const r2 = await clean([{ src: "px-A", id: ids.C }]);
  out("  asked to clear source px-A, naming C's id: " + JSON.stringify(r2));
  if (r2.removed === 3) ok("both copies of the rebuilt source and the unstamped node were removed");
  else fail("expected 3 removed (A, D by stamp; C by id), got " + JSON.stringify(r2));

  // And what is actually left.
  const left = await render({ op: "scratch-list" });
  out("  still in the file: " + JSON.stringify(left.left));
  if (left.left.length === 1 && left.left[0] === "pxf-test-B") ok("exactly the node that should have survived did");
  else fail("expected only pxf-test-B to remain, found " + JSON.stringify(left.left));

  // Leave the file as it was found.
  const swept = await render({ op: "scratch-sweep" });
  out("  swept up " + swept.swept + " scratch node(s)");
  return bad;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { openSession } = await import("./session.mjs");
  const srv = await openSession();
  let bad = 0;
  try { bad = await cleanScenario((job, payload) => srv.post(job, payload, new Map(), 120000)); }
  catch (e) { bad++; console.log("FAIL " + e.message); }
  srv.close();
  console.log(bad ? bad + " FAILED" : "the delete rule behaves as intended");
  process.exit(bad ? 1 : 0);
}

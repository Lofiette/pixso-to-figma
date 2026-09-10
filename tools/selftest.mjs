// Everything that can be checked without Pixso and without Figma.
//
//   node selftest.mjs
//
// Worth having because the two most expensive classes of mistake here are invisible until a run is
// well under way: the builder and the verifier travel to Figma as text and are compiled there, so a
// typo in them surfaces as a job that fails minutes later; and the plugin window's state line is
// the only thing telling a designer what is happening, so a wrong sentence there is a support
// conversation. Both are testable on this machine in under a second.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { BUILDER_SRC, VERIFIER_SRC } from "./builder4.js";
import { startJobServer } from "./jobserver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };

// ---------- 1. the code that travels inside the payload ----------
const AF = Object.getPrototypeOf(async function () {}).constructor;
for (const [name, src] of [["builder", BUILDER_SRC], ["verifier", VERIFIER_SRC]]) {
  try {
    new AF("figma", "PAY", "ROOT_NODE_ID", "let RESULT=null;\n" + src + "\nreturn RESULT;");
    ok(name + " compiles (" + src.length + " chars)");
  } catch (e) { fail(name + " does not compile: " + e.message); }
}

// ---------- 2. the plugin frame ----------
const html = readFileSync(join(HERE, "..", "figma-plugin", "ui.html"), "utf8");
const a = html.indexOf("<script>"), b = html.lastIndexOf("</script>");
if (a < 0 || b < 0) fail("ui.html has no script block");
const js = html.slice(a + 8, b);
const scratch = join(tmpdir(), "pxf-uicheck.js");
writeFileSync(scratch, js, "utf8");
try { execFileSync("node", ["--check", scratch], { stdio: "pipe" }); ok("plugin window parses"); }
catch (e) { fail("plugin window does not parse: " + String(e.stderr || e.message).slice(0, 200)); }

// ---------- 3. the state line ----------
// A run passes through all of these. Two of them used to be reported in red as a lost connection
// when nothing was wrong: the runner busy in Pixso, and the runner finished and exited.
const el = () => ({ textContent: "", className: "", hidden: false, disabled: false, onclick: null, style: {} });
const S = el(), byId = { s: S, l: el(), p: el(), go: el() };
const ctx = createContext({
  fetch: () => new Promise(() => {}),           // both loops park; they are not under test here
  document: { getElementById: (i) => byId[i] || el() },
  parent: { postMessage() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController: function () { this.abort = () => {}; this.signal = null; },
  Promise, Set, Math, JSON, String, Number, Object, Error, console,
});
try {
  runInContext(js, ctx);
  const line = (label, drive, wantText, wantClass) => {
    if (drive) ctx.state(drive);
    if (S.textContent.indexOf(wantText) < 0 || S.className !== wantClass) {
      fail("state line, " + label + ": got [" + S.className + "] " + S.textContent);
    } else ok("state line, " + label);
  };
  line("before any contact", null, "Проверяю связь", "wait");
  line("runner up, nothing started", { link: "up", phase: "idle" }, "Готов. Нажмите кнопку", "on");
  line("extracting, no job yet", { phase: "working" }, "Идёт извлечение из Pixso", "wait");
  line("between jobs", { everJob: true }, "готовит следующий объект", "wait");
  line("job running", { stage: "Собираю объект в Figma" }, "Собираю объект в Figma", "on");
  line("job failed", { trouble: "Объект не собрался: нет шрифта" }, "не собрался", "off");
  line("finished, runner up", { trouble: null, stage: null, phase: "done" }, "Смотрите результат", "on");
  line("finished, runner exited", { link: "down" }, "Раннер закончил работу", "on");
  line("runner never started", { sawDone: false, phase: "idle" }, "Раннер не запущен", "wait");
  line("stopped by an error", { link: "up", phase: "stopped" }, "остановлен", "off");
} catch (e) { fail("plugin window threw on load: " + e.message); }

// ---------- 4. progress must be held, not polled ----------
// On a timer this ran once a minute whenever the plugin window was not in front, which is exactly
// when someone leaves it to watch extraction.
const PORT = 3779;
const srv = startJobServer(PORT);
await srv.ready;
const ctl = (q) => fetch("http://127.0.0.1:" + PORT + "/control" + q).then((r) => r.json());
try {
  let t = Date.now();
  const first = await ctl("?rev=0");
  if (Date.now() - t > 1000) fail("a client that has seen nothing was made to wait");
  else ok("first request answered at once (rev " + first.rev + ")");

  t = Date.now();
  const held = ctl("?rev=" + first.rev);
  setTimeout(() => srv.say("линия"), 400);
  const second = await held;
  const dt = Date.now() - t;
  if (dt < 300) fail("the request was not held");
  else if (dt > 3000) fail("it did not wake when a line was said (" + dt + " ms)");
  else ok("held until there was something to say (" + dt + " ms)");

  let early = false;
  ctl("?rev=" + second.rev).then(() => { early = true; });
  await new Promise((r) => setTimeout(r, 1200));
  if (early) fail("answered with nothing new to report");
  else ok("with nothing new, keeps holding");

  const p = ctl("?rev=" + second.rev);
  srv.phase("working");
  const third = await p;
  if (third.phase !== "working") fail("a phase change is not reported");
  else ok("a phase change wakes it too");
} catch (e) { fail("progress endpoint: " + e.message); }
srv.close();

console.log("");
console.log(failed ? failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "all checks pass");
process.exit(failed ? 1 : 0);

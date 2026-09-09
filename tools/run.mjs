// The whole migration, started from the button in the plugin window.
//
//   node run.mjs [name]
//
// A designer opens the file in Pixso, opens an empty file in Figma, starts the pix-to-fig runner
// plugin, and presses the button. This process does everything else and sends its progress back
// into that window.
//
// It cannot be the plugin itself: the plugin is allowed to talk to exactly one address — this
// runner — and has no way to reach Pixso. And this process has to hold that address for the whole
// run, extraction included, or there is nobody to report progress to during the long part. That
// is why building is a function here rather than a separate script.
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startJobServer } from "./jobserver.mjs";
import { buildAll, verdict } from "./build-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const pi = argv.indexOf("--page");
const ONLY_PAGE = pi >= 0 ? argv.splice(pi, 2)[1] : null;
const WORK = join(HERE, "..", "out", argv[0] || "run");
const PAGES = join(WORK, "pages.json");
const DIRS = join(WORK, "obj");

const srv = startJobServer(3778);
await srv.ready;

// Everything said here goes to two places: this console, for whoever started the runner, and the
// plugin window, for whoever pressed the button.
const say = (line) => { console.log(line); srv.say(line); };

console.log("runner on http://localhost:3778");
console.log("open the pix-to-fig runner plugin in Figma and press the button in its window\n");

function sh(script, args, env) {
  return spawnSync("node", [join(HERE, script), ...args], {
    cwd: HERE, stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, env || {}),
  });
}

await srv.waitForStart();

try {
  srv.phase("working");

  // ---------- is Pixso there? ----------
  say("Проверяю Pixso…");
  try {
    execFileSync("node", [join(HERE, "mcp.mjs"), "info"], { cwd: HERE, encoding: "utf8", timeout: 30000 });
  } catch (e) {
    say("Pixso не отвечает на 127.0.0.1:3667.");
    say("Откройте Pixso, включите в нём MCP и откройте нужный файл.");
    srv.phase("idle");
    throw new Error("pixso not reachable");
  }

  // ---------- what is in the file ----------
  mkdirSync(WORK, { recursive: true });
  const pg = sh("px-pages.mjs", [PAGES]);
  if (pg.status !== 0) {
    // Say WHY. The first time this failed for someone else, the reason was captured and thrown
    // away, and all they had was "could not read the file".
    say("Не удалось прочитать файл в Pixso:");
    const why = String(pg.stderr || pg.stdout || "").split(String.fromCharCode(10)).filter(Boolean).slice(-4);
    for (const w of why) say("  " + w.slice(0, 160));
    srv.phase("idle");
    throw new Error("px-pages failed");
  }
  const doc = JSON.parse(readFileSync(PAGES, "utf8"));
  const objects = doc.pages.reduce((a, p) => a + p.children.length, 0);
  const nodes = doc.pages.reduce((a, p) => a + p.nodes, 0);
  say("Файл: " + doc.file);
  say("Страниц " + doc.pages.length + ", объектов " + objects + ", узлов " + nodes);

  // Extraction is Pixso handing over one vector at a time and there is no way round it, so say
  // what that costs before spending it rather than after. A file of a third of a million nodes
  // is a working day, and nobody should discover that an hour in.
  const mins = Math.round(nodes / 1000);
  if (ONLY_PAGE) say("Беру только страницу: " + ONLY_PAGE);
  say("Ожидаемое время извлечения: примерно " + (mins > 90 ? Math.round(mins / 60) + " ч" : mins + " мин"));
  if (!ONLY_PAGE && nodes > 60000) {
    say("");
    say("Это очень большой файл. Разумнее переносить его по одной странице:");
    for (let k = 0; k < doc.pages.length && k < 8; k++) {
      say("   node run.mjs <имя> --page " + JSON.stringify(doc.pages[k].name) + "   (" + doc.pages[k].nodes + " узлов)");
    }
    if (doc.pages.length > 8) say("   … и ещё " + (doc.pages.length - 8));
    say("");
    say("Продолжаю целиком — прервать можно в любой момент, извлечённое сохранится.");
  }

  // ---------- out of Pixso ----------
  say("");
  say("Извлекаю из Pixso — это самая долгая часть,");
  say("примерно минута на тысячу узлов. Плагин пока не нужен.");
  const exArgs = [join(HERE, "migrate-file.mjs"), PAGES, DIRS];
  if (ONLY_PAGE) exArgs.push("--page", ONLY_PAGE);
  // Read the child line by line as it goes, rather than collecting everything and parsing it
  // when it is over. Extraction is twenty minutes of silence otherwise — and the whole reason
  // to capture the output was to be able to show it while it matters.
  const status = await new Promise((resolve) => {
    const p = spawn("node", exArgs, { cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const NL = String.fromCharCode(10);
    const onData = (chunk) => {
      buf += String(chunk);
      let at;
      while ((at = buf.indexOf(NL)) >= 0) {
        const line = buf.slice(0, at).replace(String.fromCharCode(13), "");
        buf = buf.slice(at + 1);
        // Parsed by hand rather than by pattern: the line shape is fixed and known, and a
        // regular expression written through three layers of shell quoting has eaten its own
        // backslashes more than once today.
        //   [12/34] FRAME 2161n  "Ресурсы/ Меню закрыто"   (382s elapsed)
        if (line.charAt(0) === "[") {
          const close = line.indexOf("]");
          const q1 = line.indexOf(String.fromCharCode(34));
          const q2 = line.lastIndexOf(String.fromCharCode(34));
          const counter = close > 0 ? line.slice(1, close) : "";
          const name = q2 > q1 ? line.slice(q1 + 1, q2) : "";
          say("  " + counter.replace("/", " из ") + "   " + name);
        } else if (line.indexOf("FAILED") >= 0 || line.indexOf("extracted ") >= 0) {
          say("  " + line.trim().slice(0, 120));
        }
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => resolve(code));
  });
  const ex = { status };
  if (ex.status !== 0) say("Часть объектов извлечь не удалось — продолжаю с тем, что есть.");

  const list = join(DIRS, "dirs.txt");
  if (!existsSync(list)) { say("Извлекать оказалось нечего."); srv.phase("idle"); throw new Error("nothing extracted"); }
  const dirs = readFileSync(list, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  // ---------- source against payload ----------
  const cov = sh("coverage.mjs", ["--dirs", list]);
  const covOut = String(cov.stdout || "");
  const loss = /unexplained loss\s+(-?\d+)/.exec(covOut);
  say("");
  say("Проверка: потерь при извлечении " + (loss ? loss[1] : "?"));

  // ---------- into Figma ----------
  say("");
  say("Собираю в Figma: " + dirs.length + " объектов");
  process.env.PX_PLACE_ABS = "1";
  const results = await buildAll({ srv, dirs, pages: doc, clean: true, say });

  say("");
  say("================ итог ================");
  verdict(results, say);
  srv.phase("done");
  say("");
  say("Готово. Смотрите результат в Figma.");
} catch (e) {
  say("Остановлено: " + (e.message || e));
  srv.phase("idle");
} finally {
  // Give the plugin a moment to pick up the last lines before the port closes.
  await new Promise((r) => setTimeout(r, 4000));
  srv.close();
}

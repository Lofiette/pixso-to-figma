# pix-to-fig

Moves a design from **Pixso to Figma** layer by layer — frames, text, vectors, images, auto-layout,
pages — and then measures what it built against the source instead of asking you to trust it.

No model in the loop. The whole transfer is deterministic code: the same file gives the same
result twice.

Three files have been migrated with it so far — one heavy on boolean geometry and photographs
(25 351 nodes), one dense interface (28 190 nodes), one small set of app concepts. Every node
count came out exact; the largest position error in the interface file was one pixel.

---

## What it does not do

Read this before you start, so nothing surprises you.

- **Components arrive as frames.** A component, a component set and an instance all become plain
  frames. They look right and they are editable; they are not components, and they are not linked
  to any library. Re-linking is a separate job we have not built yet.
- **Fonts must already be installed.** Text set in a font this machine does not have is drawn in a
  substitute, which is a different width — so the layout around it cannot match. The report says
  which fonts were missing and counts those objects separately from real defects. Install them,
  **restart Figma** (it scans fonts only at startup), and rebuild.
- **Boolean shapes lose their operands.** A shape built from several paths arrives as one vector
  with exactly the right geometry, but you can no longer take it apart. On a file full of
  illustration this was 708 nodes of 25 351; on an interface file it was 2 of 28 190.
- **Prototype links, comments and version history do not travel.**

---

## What you need

- **Node.js 20 or newer.** `node --version` to check.
- **Pixso desktop** with its local MCP server running (see Setup).
- **Figma desktop.** Not the browser — the runner is a development plugin, and Figma only allows
  those in the desktop app.
- The fonts your file uses, installed on this machine.

---

## Setup, once

**1. Turn on Pixso's MCP server.**

> TODO: the exact menu path. It answers on `http://127.0.0.1:3667/mcp` when it is on; check with
> `node tools/mcp.mjs info` from the repository — you should get a JSON block back, not an error.

**2. Import the runner plugin into Figma.**

Figma desktop → menu **Plugins → Development → Import plugin from manifest…** → choose
`figma-plugin/manifest.json` from this repository. It appears as **pix-to-fig runner** under
Plugins → Development. You only do this once.

**3. Check the two ends talk.**

```bash
cd tools
node mcp.mjs info      # Pixso answers
```

---

## Migrating a file

1. Open the file you want to move **in Pixso**.
2. Create an empty file **in Figma**.
3. **Double-click `start.cmd`** in this repository. A console window opens and stays open.
4. In Figma: **Plugins → Development → pix-to-fig runner**.
5. Press **«Перенести файл из Pixso»** in the plugin window.

That is the whole procedure. The plugin window shows what is happening — reading the file,
extracting from Pixso, building — and the verdict at the end. Leave both windows open until it
says it is done.

The button cannot do this on its own: the plugin is allowed to talk to exactly one address, the
local runner, and has no way to reach Pixso. `start.cmd` is that runner. Everything it does is
also available as separate commands if you prefer them — see `tools/`.

A file of 28 000 nodes takes about half an hour, and most of that is Pixso handing over vectors
one at a time. Interrupting is safe: run it again and it skips what it already has.

---

## Checking it looks right, not just measures right

The geometry check compares the built tree against what was sent to Figma. It therefore proves the
build did what it was told — and it is blind to anything the two editors *draw* differently. Every
defect that a person noticed on our test files passed it with zero nodes out of position: text
rendered backwards, shapes sitting on white rectangles, a pill with the wrong corner rounded.

So there is a second check, which renders both sides and compares pixels:

```bash
node visual-all.mjs ../out/mine/obj/dirs.txt ../out/mine/vis 700
```

It ranks objects by the share of pixels that are inked on one side and blank on the other — the
signature of something that did not arrive — and keeps both pictures for anything over 1 %.

**Keep the Figma window in front while this runs.** Figma only rasterises in the foreground: in a
background window an export never returns. The tool raises the window itself, but if you click
away it will stall.

And a third check, which needs neither editor:

```bash
node coverage.mjs --dirs ../out/mine/obj/dirs.txt
```

Source against payload. It splits the difference between "collapsed on purpose" — the boolean
operands above — and **unexplained loss**, which should always be zero.

---

## When something is wrong

Tell us, and send:

- the last twenty lines of the build output (the table and the verdict);
- `out/mine/obj/<object>/check-report.json` for the object that is wrong — it names the nodes;
- a screenshot of the source next to the result, if the defect is something you can see.

That last one matters more than it sounds. Two of the defects fixed on the pilot files were found
by eye and by nothing else: the measurements said the object was perfect.

---

## If it stops

- **The plugin says "runner not reachable".** Normal between steps — nothing is listening while
  extraction runs. It reconnects on its own.
- **A build sits at "waiting: the plugin has not polled".** Check no runner from an earlier run is
  still alive: `Get-Process node` on Windows. One that outlived its shell keeps the plugin's
  connection and the new run waits forever for a plugin that is already busy talking to a corpse.
- **Renders hang but builds work.** The Figma window is not in front. That is the whole cause.
- **The plugin window is stuck on one job.** Close it and run it again from Plugins → Development.

---

## What is in here

| | |
|---|---|
| `tools/px-*.mjs` | the Pixso side: tree, vectors as SVG, transforms, text, images |
| `tools/pack4.mjs` | builds the payload, and the builder and verifier that travel inside it |
| `tools/builder4.js` | the algorithm — everything that decides how a node is rebuilt |
| `tools/migrate-file.mjs` | extracts a whole file, object by object |
| `tools/build-all.mjs` | builds and verifies a whole file in one plugin session |
| `tools/visual-all.mjs` | renders both sides and ranks by how different they look |
| `tools/coverage.mjs` | source against payload |
| `figma-plugin/` | the runner: transport and host, no migration logic |
| `docs/METHOD.md` | why it is built this way |
| `docs/FINDINGS.md` | every defect found so far, with the measurement that found it |

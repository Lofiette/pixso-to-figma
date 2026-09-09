# State

## Now

- **Task:** Pixso -> Figma migration, 1:1, whole files, no model in the loop.
- **Status:** the first file migrates cleanly. A second file — "Кейс Айдентика Лукоморье", 3 pages,
  290 top-level objects, 25 351 nodes, heavy on photographs and boolean geometry — migrates
  structurally (every node count exact) and is still being worked on visually.

```
node tools/px-pages.mjs ../out/new/pages.json                    # what pages exist
node tools/migrate-file.mjs ../out/new/pages.json <outDir>       # extract every object, Pixso only
node tools/repack-all.mjs <outDir>/dirs.txt                      # after any builder/packer change
PX_PLACE_ABS=1 node tools/build-all.mjs --pages ../out/new/pages.json --dirs <outDir>/dirs.txt
node tools/visual-all.mjs <outDir>/dirs.txt ../out/new/vis 700   # how different it LOOKS
node tools/coverage.mjs --dirs <outDir>/dirs.txt                 # source vs payload
```

Extraction needs Pixso desktop with its MCP on `127.0.0.1:3667`. Building needs the
`pix-to-fig runner` plugin open in the target Figma file — and only the plugin, because the MCP
channel cannot see locally installed fonts at all. Figma screenshots can also come through the
Figma MCP (`get_screenshot`), which is the cheap way to look at a result.

## The one thing to understand before touching anything

**The geometry verifier compares the built tree against the payload.** It proves the build
faithful to the payload. It says nothing about (a) the payload being faithful to the source, or
(b) the two engines drawing the same payload the same way. Every defect a person actually noticed
on this file passed it with zero nodes out of position.

Three checks, not one:

| check | what it catches | tool |
|---|---|---|
| build vs payload | a build that did not do what it was told | the verifier, in `build-all` |
| source vs payload | anything that never reached the payload | `coverage.mjs` |
| render vs render | anything the two engines draw differently | `visual-all.mjs` |

## Second file: what has been found and fixed

- **Rotation and mirroring are dropped on auto-layout flow children.** The flow expresses where a
  child sits and nothing else. A design that stands a label upright by flipping the parent and
  flipping the child back arrives with the child's flip gone — a label written backwards. 671 nodes
  in this file carry a mirror. Such children now leave the flow. The packer still bakes a quarter
  turn into a LEAF's size, which is right for a divider and wrong for a node with children.
- **Figma has no Hue among its image filters** (exposure, contrast, saturation, temperature, tint,
  highlights, shadows — that is the list). A filter that cannot travel as data travels as pixels:
  Pixso renders the node, and the render is turned back into the node's own frame first, because
  exports come out in screen orientation.
- **Figma drops an image whose longest side is over 4096** and says so on the canvas. The render
  fallback was exporting a 4096-wide node at 4x — 16384 x 9216, 76 MB. Both renderers now fit.
- **Rounding is not one decision.** Two decimals is right for pixels and wrong for anything
  normalised to 0..1. Colours, transforms, gradient stops, filters and opacities keep six.
- **A line height that differs from the font's natural one puts the first line 23 px low.** Half
  the difference is applied where the node has its own transform, and the amount is stored on the
  node so the verifier corrects its expectation by the same amount. Text inside a flow is left
  alone and counted: taking it out of the flow to move it collapsed its parent to the padding, and
  cost 61 of 88 objects in one run.

## Transport, which cost more time than any of the above

- **Never use setTimeout inside the plugin.** Chromium throttles timers in a background window to
  one wake-up a MINUTE. A single yield cost 60 seconds; three passes over a 27-node object took
  three minutes and the watchdog then wrote it off as hung. Turns are taken through
  `getNodeByIdAsync`, which resolves on Figma's own message loop.
- **Settling and breathing are different things.** `settle()` gives Figma a real turn so a pending
  relayout happens and a measurement is of the current layout; `breathe()` only stops Figma killing
  the plugin. Making both cheap produced 6 259 of 10 133 nodes and errors of 400 px.
- **Everything crossing into or out of the plugin must be sliced.** The report path was the one
  direction that was not, and a report carrying a render never arrived: the frame latched on busy
  and kept heartbeating, so the runner saw a healthy plugin that would never take another job.
- **Image bytes travel as base64 text**, never as an array of numbers (102 MB became an array of a
  hundred million numbers and never came back), and each hash crosses once per session.
- **A watchdog must scale with the work handed over**, and must not free the frame while the
  sandbox may still be busy — a single-threaded sandbox with two jobs queued fails the second one
  for no reason of its own.

## Extraction cost, measured

- Each image is fetched once per file and cached by hash: 236 MB of the first 520 MB were repeats.
- `pixso.base64Encode` is native and 3.8x the hand-rolled loop, and a 16-million character response
  arrives intact, so an image up to 11 MB travels in one call.
- What remains is Pixso's own floor: it exports one vector at a time, and a section of 933 vector
  nodes costs twenty minutes no matter what the driver does.

## Open

- **Fonts this machine does not have** — Fact Semi Expanded, Stolzl, Pragmatica, SF Pro Text
  Semibold. 13 objects cannot match until they are installed. Owner's decision: report them
  honestly, do not compensate. `build-all` counts them separately from real defects.
- **The visual audit has not yet been run on the whole file.** Owner reports plenty of visible
  defects beyond the fonts; two are known by picture — a mirrored label (fixed, unverified) and
  petal shapes sitting on opaque white squares (cause not yet found; the first guess, white fills
  in the payload, was checked and is wrong).
- Boolean operands are collapsed into one SVG on purpose: 708 of 25 351 nodes. Geometry exact,
  operand structure not preserved. Unexplained loss: zero.

## Checkpoint

- **Updated:** 2026-09-08
- **Verified by:** node counts per object, `coverage.mjs` over all 290 objects, and — from here on
  — `visual-all.mjs`, which is the only one of the three that sees what the owner sees.

## Day 2 (2026-09-09): what a second and a third file taught

**Regression file — "Концепты приложений для демо в Спектре", 2 pages, 9 objects, 1611 nodes —
migrated first time with no change to the algorithm.** 1574/1574 nodes, nothing out of position,
no size difference, unexplained loss zero, and the only objects not marked exact were the four
whose fonts this machine does not have. A screen of 400 nodes — poster, vector QR code, dashed
tear line — compares at mean 3.6 against its source. Everything found on the hard file below was
specific to complex geometry; none of it broke the simple case.

### Defects found by looking, not by measuring

- **Frames imported from an SVG must never paint.** A group inside an SVG arrives as a nested
  FRAME and a frame in Figma is white by default, so every petal of a diagram sat on an opaque
  white rectangle. Nothing in the payload was white; the geometry check called the object exact.
  Found by asking the built file which nodes paint white — 64 of them, petal-sized, called
  "Frame". Clearing the wrapper's fill was never enough.
- **A corner radius of zero is a value, not a default.** Pixso reports `cornerRadius` as one
  number even when the corners differ (19.93 for 0/42.5/42.5/42.5) — the same lie it tells about
  `strokeWeight`. The zero was dropped as "same as default", so the average stood. When the four
  corners disagree they all travel and the average does not travel at all.
- **The first line of text is placed with `leadingTrim: CAP_HEIGHT`, not by moving the node.**
  Pixso puts the cap at the top of the line box; Figma centres the leading. Measured on the built
  heading: ink top 19.6 without the trim, -3.4 with it, -3 in the source, box height unchanged.
  Two earlier attempts moved the node instead — one collapsed hugging parents (61 of 88 objects
  wrong), the other did nothing inside a flow.
- **Guard a correction on position, not on size.** The trim can leave a box at exactly 22x48 and
  still move the node 12 px, because a parent that aligns children on the baseline reflows when
  the baseline moves. And guard in bulk: a relayout after every text meant 153 relayouts of one
  section, fifty minutes instead of two seconds.

### The rule that cost half a day

**Rasterisation only happens in the front window.** `exportAsync` and `absoluteRenderBounds` never
return while Figma is in the background — not slowly, never. Node lookups, property reads and
whole builds work either way, which is why this took so long to see: the same export is 24 ms in
front and unbounded behind. `tools/focus-figma.mjs` raises the window and the render tools call it.
Figma MCP `get_screenshot` needs no window at all and is the better channel for pictures — but it
renders the *saved* file, so a node built seconds ago may not be there yet.

### Also fixed

- The plugin's poll loop re-entered itself with nothing to await while a job ran — a spin, not a
  poll. It took the frame's thread so the report could never be handled.
- The runner holds a `/job` request until it has work, because a timer in a background window
  fires once a minute and the runner was giving up after 45 seconds on a healthy plugin.
- `build-one` took no page, so objects landed on whichever page was open. It takes `--pages` now.
- **A runner process that outlives its shell keeps the plugin's connection.** Check
  `Get-Process node` before believing anything about the plugin.

### Open, in order

1. **A few pixels of per-card offset** in "Инфографика блоки": the best alignment differs per
   card (-8,-7 for one, -3,-5 for another), so it is not one global shift. The geometry verifier
   cannot see it — it agrees with the payload. Largest open class by magnitude.
2. The visual audit has still never completed over a whole file.
3. Fonts this machine lacks: SF Pro Text/Display, Proxima Nova, Helvetica, Fact Semi Expanded,
   Stolzl, Pragmatica. Report, do not compensate.

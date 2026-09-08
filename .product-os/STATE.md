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

## Resume here (evening of 2026-09-08)

Everything is committed and nothing is running. To pick up:

1. Open the `pix-to-fig runner` plugin in Figma. **Check first that no node process is alive** —
   `Get-Process node` — because a runner that outlived its shell keeps an established connection
   to the plugin, and the plugin, now that it waits inside a held request, will sit on that dead
   connection while a new runner waits for a plugin that never comes. Both sides look healthy and
   neither can tell. That cost most of an evening.
2. `PX_PLACE_ABS=1 node tools/build-all.mjs --clean --pages ../out/new/pages.json --dirs ../out/new/obj/dirs.txt`
3. `node tools/visual-all.mjs ../out/new/obj/dirs.txt ../out/new/vis 700`

The build has not been run since the mirror fix, so the file in Figma is from before it. All 290
payloads are repacked and current.

**The next real question is the visual audit's output**, which has never been produced. The owner
looked at the file and reported plenty of visible defects beyond the known fonts, and was right to:
the geometry verifier reported 222 of 290 objects exact on a build that looked wrong in places.
Two defects are known by picture — a label rendered backwards (mirror handling, fixed but not yet
verified) and petal shapes sitting on opaque white squares with a ring outline missing (cause
unknown; the first hypothesis, white fills in the payload, was checked and is wrong).

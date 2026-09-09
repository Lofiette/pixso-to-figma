# State

## Now

- **Task:** Pixso -> Figma migration, 1:1, whole files, no model in the loop.
- **Status:** four files migrated. The mechanism works and is packaged for designers to test.
  What is not finished is the *acceptance*: one check is blind by construction, one has never run
  to the end of a file, and one object's verification is unexplained.

The transfer itself contains no model call. Every step is deterministic code: the same file gives
the same result twice. What has needed a model is **debugging** — a new class of defect does not
find itself.

## How it is run

```
start.cmd                                    # designer path: double-click, then press the button
node tools/run.mjs <name>                    # the same thing, with a console
node tools/run.mjs <name> --page "<page>"    # one page of a very large file
```

Or the steps separately, from `tools/`:

```
node px-pages.mjs ../out/mine/pages.json
node migrate-file.mjs ../out/mine/pages.json ../out/mine/obj
node repack-all.mjs ../out/mine/obj/dirs.txt        # after any builder or packer change
PX_PLACE_ABS=1 node build-all.mjs --clean --pages ../out/mine/pages.json --dirs ../out/mine/obj/dirs.txt
node visual-all.mjs ../out/mine/obj/dirs.txt ../out/mine/vis 700
node coverage.mjs --dirs ../out/mine/obj/dirs.txt
```

Extraction needs Pixso desktop with its MCP on `127.0.0.1:3667`. Building needs the
`pix-to-fig runner` plugin open in the target Figma file. Figma MCP `get_screenshot` is the
reliable way to get a picture — but it renders the **saved** file, so a node built seconds ago may
not be there yet.

## The one thing to understand before touching anything

**The geometry verifier compares the built tree against the payload.** It proves the build faithful
to the payload and nothing else. It cannot see the payload being wrong about the source, and it
cannot see the two editors drawing the same payload differently. Every defect a person actually
noticed passed it with zero nodes out of position.

| check | what it catches | tool |
|---|---|---|
| build vs payload | a build that did not do what it was told | the verifier, inside `build-all` |
| source vs payload | anything that never reached the payload | `coverage.mjs` |
| render vs render | anything the two editors draw differently | `visual-all.mjs` |

## What four files proved

| file | nodes | result |
|---|---|---|
| Кейс Айдентика Лукоморье | 25 351 | boolean geometry, photographs, filters — the hard one |
| Концепты для демо в Спектре | 1 611 | migrated first time, no change to the algorithm |
| Капасити-менеджмент | 28 190 | dense interface; every node count exact, worst error 1 px |
| Концепты (45 objects) | 45 110 | 43 of 45 verified, worst 1.41 px; two verification failures below |

`coverage.mjs` has never reported an unexplained loss on any of them.

## Defects fixed, and what each was

Design-side, found by looking rather than measuring:

- **Frames imported from an SVG must never paint.** A group inside an SVG becomes a nested FRAME
  and a frame in Figma is white by default, so every petal of a diagram sat on a white rectangle.
  Nothing in the payload was white. Found by asking the built file which nodes paint white.
- **A corner radius of zero is a value, not a default.** Pixso reports `cornerRadius` as one number
  even when the corners differ — the same lie it tells about `strokeWeight`. Dropping the zero as
  "same as the default" left the average standing. The owner found this by eye.
- **The first line of text is placed with `leadingTrim: CAP_HEIGHT`.** Pixso puts the cap at the top
  of the line box, Figma centres the leading — 23 px on a 140 px heading. Measured: ink top 19.6
  without the trim, -3.4 with it, -3 in the source, box height unchanged.
- **Guard a correction on position, not on size, and in bulk.** The trim can leave a box at exactly
  22x48 and still move the node 12 px, because a parent aligning children on the baseline reflows
  when the baseline moves. Checking after each of 153 texts took fifty minutes; two relayouts do.
- **Rotation and mirroring are dropped on auto-layout flow children.** The flow expresses position
  and nothing else, so a child whose linear part is not the identity leaves the flow. 671 mirrored
  nodes in one file; a label built by flipping the parent and flipping the child back came out
  backwards.
- **Figma has no Hue among its image filters**, so that filter travels as pixels: Pixso renders the
  node, and the render is turned back into the node's own frame first.
- **Figma drops an image whose longest side is over 4096.** Both renderers scale to fit.
- **An image rotation of 360 degrees or more loses the whole fill** — Figma refuses the assignment
  outright, so the node ends with no image at all. Normalised at pack time.
- **Rounding is not one decision.** Colours, transforms, gradient stops, filters and opacities keep
  six decimals; geometry keeps two.

Transport, which cost more than all of the above:

- **Never use setTimeout inside the plugin.** Chromium throttles timers in a background window to
  one wake-up a MINUTE. A single yield cost 60 s. Turns go through `getNodeByIdAsync`.
- **Settling and breathing are different.** `settle()` gives Figma a real turn so a pending relayout
  happens; `breathe()` only stops Figma killing the plugin. Making both cheap produced 6 259 of
  10 133 nodes and errors of 400 px.
- **Rasterisation only happens in the front window.** `exportAsync` and `absoluteRenderBounds` never
  return in the background. `tools/focus-figma.mjs` raises it; the render tools call it.
- **Everything crossing the plugin boundary must be sliced**, in both directions, and image bytes
  travel as base64 text — never as an array of numbers.
- **The runner holds a `/job` request** until it has work, so the plugin needs no timer to poll.
- **The poll loop must not re-enter itself while a job runs** — that is a spin, and it takes the
  frame's only thread so the report can never be handled.
- **A runner process that outlives its shell keeps the plugin's connection.** Check
  `Get-Process node` before believing anything about the plugin.

## Packaged for designers

`README.md` is written for them and leads with what the tool does **not** do. `start.cmd` starts the
runner; the plugin has a button that asks it to begin; `tools/build-lib.mjs` holds the build loop so
the button and the command line share one copy of it. Extraction progress is streamed as it happens.

One step in the README is still marked TODO: the menu path that turns on Pixso's MCP server. The
owner knows it; ask.

## Open, in order

1. **A node id that points at different nodes at different times. Start here.** The "WIP" section of
   the fourth file (5722 nodes) verifies as 3 nodes. The section is in the file and complete — 30
   children, 6809 nodes — but the id recorded for it was a RECTANGLE named "Resize" minutes later,
   and a probe of that id returned a FRAME with two TEXT children. Reproducible. Until this is
   understood, that object cannot be verified and nothing about id stability should be assumed.
   A second object failed verification as "root not found" and then verified 20/20 on a retry,
   which may be the same thing.
2. **macOS.** `start.cmd` is Windows-only; `focus-figma.mjs` is PowerShell. Needs `start.command`
   and `osascript -e 'tell application "Figma" to activate'`. Half an hour.
3. **The plugin's UX.** "connecting…" and "runner not reachable" report an emergency when nothing is
   wrong — the runner has simply gone off to Pixso. One coherent line of state instead.
4. **A per-card offset of a few pixels** in "Инфографика блоки" of the Лукоморье file: the best
   alignment differs per card, so it is not one global shift. The geometry verifier agrees with the
   payload and cannot see it.
5. **The visual audit has never completed over a whole file.**
6. Fonts this machine lacks: SF Pro Text/Display, Proxima Nova, Helvetica, Fact Semi Expanded,
   Stolzl, Pragmatica. Report, do not compensate — the owner's decision.
7. Components arrive as frames. Deferred by the owner as a separate task. If it is taken up, the
   cheap thing to do first is to record each instance's Pixso component id on the built node with
   `setPluginData`: that keeps the option open and costs nothing, and without it the link is gone
   for good.

## Checkpoint

- **Updated:** 2026-09-09, end of day two.
- **Verified by:** node counts per object on four files, `coverage.mjs` over all of them, and pixel
  comparison on individual objects. Not by a completed visual audit — that has never run to the end.

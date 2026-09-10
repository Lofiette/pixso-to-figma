# State

## Now

- **Task:** Pixso -> Figma migration, 1:1, whole files, no model in the loop.
- **Status:** five files migrated. Day three went into the *instrument* rather than the algorithm:
  the verdict now distinguishes what a person could see from what only a measurement can, and the
  one thing that was unexplained at the end of day two is explained.

The transfer itself contains no model call. Every step is deterministic code: the same file gives
the same result twice. What has needed a model is **debugging** — a new class of defect does not
find itself.

## How it is run

```
start.cmd            (Windows)      # designer path: double-click, then press the button
start.command        (macOS)
node tools/run.mjs <name>                    # the same thing, with a console
node tools/run.mjs <name> --page "<page>"    # one page of a very large file
node tools/selftest.mjs                      # everything checkable with neither editor open
```

Or the steps separately, from `tools/`:

```
node px-pages.mjs ../out/mine/pages.json
node migrate-file.mjs ../out/mine/pages.json ../out/mine/obj
node repack-all.mjs ../out/mine/obj/dirs.txt        # after any builder or packer change
PX_PLACE_ABS=1 node build-all.mjs --clean --pages ../out/mine/pages.json --dirs ../out/mine/obj/dirs.txt
node coverage.mjs --dirs ../out/mine/obj/dirs.txt
node visual-all.mjs ../out/mine/obj/dirs.txt ../out/mine/vis 700
```

Extraction needs Pixso desktop with its MCP on `127.0.0.1:3667`. Building needs the
`pix-to-fig runner` plugin open in the target Figma file. **A change to `builder4.js` or `pack4.mjs`
reaches Figma only through `repack-all.mjs`** — both travel inside the payload.

## The two things to understand before touching anything

**1. The geometry verifier compares the built tree against the payload.** It proves the build
faithful to the payload and nothing else. It cannot see the payload being wrong about the source,
and it cannot see the two editors drawing the same payload differently. Every defect a person
actually noticed passed it with zero nodes out of position.

| check | what it catches | tool |
|---|---|---|
| build vs payload | a build that did not do what it was told | the verifier, inside `build-all` |
| source vs payload | anything that never reached the payload | `coverage.mjs` |
| render vs render | anything the two editors draw differently | `visual-all.mjs` |

The third one **completed over a whole file for the first time on day three**: 69 objects compared,
**one worth looking at**, and it is the right one. It took three corrections to get there, all of them
in the instrument rather than the algorithm:

- **Raise the Figma window before every object, not once at the start.** Rasterisation happens only in
  the front window, and over a run this long something always takes focus. Raised once, the first
  stolen click turns every remaining render into a two-minute timeout.
- **Composite both renders over white before comparing.** Under a fully transparent pixel Pixso stores
  0,0,0 and Figma stores 255,255,255 — same invisibility, opposite colour underneath. Compared raw,
  that put a byte-perfect object at the top of the ranking with 10.32 % "ink on one side".
- **Rank by mean difference, not by the share of grossly different pixels.** "Ink on one side" assumes
  dark ink on light paper. The one real defect in the file is dark blue-grey text on pale blue and
  scored 0.00 % by that measure while its mean was 36.9 against 2.3 for the next object.

**2. A Figma node id is not a handle you can carry between two jobs.** Measured on a run of 45
objects: two of them reported a root id that resolved to a node built long before them. So the build
stamps its root with the id of the Pixso node it came from (`setPluginData("pxSrc", ...)`), and
everything that looks a root up afterwards — the check, the visual audit, `--clean` — makes the node
prove itself and says in the report when the id had gone stale. Nothing may delete by remembered id
alone; `tools/test-clean.mjs` proves what `--clean` is allowed to remove.

## What the verdict means now

Three numbers that used to be one, because summing them made "not clean" fire on almost every
object and mean nothing:

- **out of position / the wrong size** — over a pixel, visible, someone can point at it. This is
  what the verdict keys on.
- **within a pixel** — exactly 0.5 px, vertical, inherited by a whole subtree. Explained below. Not
  a defect in the transfer.
- **wrong size but hidden** — nodes the source does not draw.

Everything is still counted and printed. Nothing is rounded away.

## What five files proved

| file | nodes | result |
|---|---|---|
| Кейс Айдентика Лукоморье | 25 351 | boolean geometry, photographs, filters — the hard one |
| Концепты для демо в Спектре | 1 611 | migrated first time, no change to the algorithm |
| Капасити-менеджмент | 28 190 | dense interface; every node count exact, worst error 1 px |
| Концепты (45 objects) | 45 110 | 43 of 45 verified; the two failures were the stale-id bug |
| Редизайн. Ширина статьи | 39 585 | **69 of 69 exact** — every node count, zero out of position, zero wrong size |

`coverage.mjs` has never reported an unexplained loss on any of them.

## Engine differences, which are not defects

- **An inside border on one side of an auto-layout frame.** Figma takes an inside border out of the
  content box; Pixso does not. A row 56 px tall with a 1 px top border and a centred counter axis
  puts a 56 px child at `1 + (55 - 56) / 2 = 0.5`, and a 16 px child at `1 + (55 - 16) / 2 = 20.5`.
  Both measured to the digit. Every descendant inherits the half pixel, which is why it surfaces on
  frames imported from SVG — those are just the first descendants small enough to cross a threshold.
  No clean fix exists: stopping the border from consuming layout space means changing its alignment,
  which moves the drawn line by the same half pixel.

  Ruled out on the way, so they are not re-tested: the payload is right about the source (Pixso's own
  absolute positions agree with the payload's composed transform chain to three decimals), and it is
  not the SCALE constraints every reported node happened to carry.

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
- **Constraints are applied after the last resize, not during the place passes.** A constraint says
  what happens when the parent is resized, and this build resizes parents on purpose several times.
  Setting them on auto-layout flow children is catastrophic — a relayout each time, five minutes for
  two objects — so the pass skips exactly the nodes the old code skipped.

Transport, which cost more than all of the above:

- **Never use setTimeout inside the plugin.** Chromium throttles timers in a background window to
  one wake-up a MINUTE. A single yield cost 60 s. Turns go through `getNodeByIdAsync`. The same rule
  is why both the job channel and the progress channel are long-polled by the runner.
- **Settling and breathing are different.** `settle()` gives Figma a real turn so a pending relayout
  happens; `breathe()` only stops Figma killing the plugin. Making both cheap produced 6 259 of
  10 133 nodes and errors of 400 px.
- **Rasterisation only happens in the front window.** `exportAsync` and `absoluteRenderBounds` never
  return in the background — not slowly, not at all. `tools/focus-figma.mjs` raises it; the render
  tools call it, and `visual-all.mjs` retries once with the window raised.
- **Everything crossing the plugin boundary must be sliced**, in both directions, and image bytes
  travel as base64 text — never as an array of numbers.
- **The poll loop must not re-enter itself while a job runs** — that is a spin, and it takes the
  frame's only thread so the report can never be handled.
- **A runner that outlives its shell keeps the plugin's connection**, and the new run waits forever
  for a plugin busy talking to a corpse. This happened again on day three. Identify it rather than
  guess: `netstat -ano | findstr :3778` shows a second process on the port that is not the one
  listening. Kill that one and the plugin reconnects by itself.

## Packaged for designers

`README.md` leads with what the tool does **not** do. `start.cmd` / `start.command` starts the
runner; the plugin has a button that asks it to begin; `tools/build-lib.mjs` holds the build loop so
the button and the command line share one copy.

The plugin window composes **one** line of state in one place. It used to be written by two loops
that knew nothing about each other, so a runner busy in Pixso and a runner that had finished and
closed its port were both reported in red as a lost connection. `selftest.mjs` drives that line
through all ten situations a run passes through.

**`README.md` is in Russian**, on the owner's instruction: it is the document designers read, and they
read it in Russian. `docs/METHOD.md` and `docs/FINDINGS.md` stay in English — they are engineering
notes, not the designer's instructions. The last TODO in the README is closed: turning on Pixso's MCP
needs no menu path, only "включите Pixso MCP в открытом файле десктопного приложения Pixso".

## Open, in order

1. **Why a node id goes stale is still unknown.** It is no longer harmful — the stamp finds the right
   node and the report says when the id was wrong — but the mechanism is not understood. `builder4.js`
   now records `rootIdAtCreate` and compares it with the id at the end of the build: if a run ever
   reports `rootIdChanged`, the id moves under a live node and the answer is there. If it never does,
   whatever happens to it happens between one job and the next.
2. **A heading wraps onto two lines because Figma measures the string one pixel wider. Start here.**
   Found by the visual audit, and by nothing else — the geometry check called the object exact, and it
   was. Box 1323, Pixso's ink 1310.3, Figma's measurement of the same string in the same Inter Semi
   Bold 120: **1324**. One pixel past the box, and the last word goes to its own line.

   The builder meets this case today and decides the other way: `textAutoResize = NONE` and the box
   forced to the source size, because source geometry wins. That was decided without knowing this
   consequence. The trigger is measurable — Pixso's ink fits the box while Figma's measurement does
   not — so the nodes where the source shows one line and the build shows two can be named exactly.
   Changing it reverses a deliberate decision and needs a rebuild plus a re-audit, so it is the
   owner's call. Pictures: `out/day3/vis/0-044-Группа-4.{pixso,figma}.png`.
3. **A per-card offset of a few pixels** in "Инфографика блоки" of the Лукоморье file: the best
   alignment differs per card, so it is not one global shift. Needs that file open in Pixso.
4. **macOS is written but has never been run on a Mac.** `start.command` (exec bit set in the index,
   line endings pinned in `.gitattributes`) and `osascript` focus. Needs one real test.
5. Fonts this machine lacks: SF Pro Text/Display, Proxima Nova, Helvetica, Fact Semi Expanded,
   Stolzl, Pragmatica. Report, do not compensate — the owner's decision.
6. Components arrive as frames. Deferred by the owner as a separate task. The groundwork is now in
   place for free: every built root already carries its Pixso source id in plugin data, and the same
   could be recorded per instance.

## Checkpoint

- **Updated:** 2026-09-10, day three.
- **Verified by:** node counts per object on five files, `coverage.mjs` over all of them, and
  `selftest.mjs` (17 checks, no editors). `test-clean.mjs` proves the delete rule against nodes it
  makes itself. And, for the first time, **a visual audit that ran to the end of a file**: 69 objects,
  one flagged, and the flagged one is a genuine defect the geometry check cannot see.
- **The fifth file's own result:** 69 of 69 exact — every node count, zero out of position, zero wrong
  size, zero unexplained loss. The two differences that remain are named and understood: 1074 nodes
  half a pixel low from Figma's border accounting, and one wrapped heading.

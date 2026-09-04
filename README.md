# pix-to-fig

Pixso → Figma migration that transfers a design **1:1** — layer for layer, editable, not a
screenshot — and then **proves** it did, by measuring every node against the source instead of
comparing screenshots by eye.

No plugin to install on either side. No `.fig` binary. No local relay server.

## How it works

Both editors expose the same thing: a JavaScript channel into a live document. Pixso's plugin API
is a member-for-member clone of Figma's — same globals, same node types, same style and variable
APIs — so the same code shape runs on both ends.

```
Pixso desktop                                            Figma desktop
     │  MCP eval_script                                       ▲  MCP use_figma
     ▼                                                        │
  px-export ─ tree, styles, component definitions              │
  px-svg    ─ every vector subtree as SVG (dedup by hash)      │
  px-bounds ─ absoluteRenderBounds for those                   │
  px-abs    ─ absoluteTransform for every node                 │
  px-textink─ inked text extents                               │
     │                                                         │
     └──► pack4 ──► one PNG carrier ──► upload_assets + curl ──┘
                    (tree + SVG assets + builder + verifier)
```

The payload never passes through the agent's context. It is written as a PNG whose greyscale
scanlines *are* the JSON, uploaded straight from disk with `curl`, and read back inside the Figma
sandbox with `getImageByHash().getBytesAsync()`. The carrier is written with **stored** deflate
blocks, so unpacking it in-sandbox is a ten-line loop rather than a hand-written inflate.

The builder and the verifier travel **inside** the payload (`PAY.B`, `PAY.V`) and are run with the
AsyncFunction constructor. What has to be typed by hand each run is a fixed ~1.2 KB bootstrap.

## The three decisions that make it work

**1. Vector geometry travels as SVG.** `node.exportAsync({format:"SVG"})` in Pixso →
`figma.createNodeFromSvg()` in Figma. This removes an entire class of defects at once: boolean
operation semantics, per-vertex corner radii that `vectorPaths` cannot express, Pixso's
`handleMirroring: "RIGHT_ANGLE"` which Figma rejects, boolean children using a different coordinate
origin, and rotated containers. The renderer resolves all of it. 324 vector subtrees in the pilot
deduplicate to 102 unique SVGs / 122 KB.

**2. Placement travels as a matrix.** `inverse(parentAbsolute) × nodeAbsolute` assigned to
`relativeTransform`. Never `x`/`y`/`rotation`: groups, boolean operations and rotated nodes each
report a different origin, and groups are coordinate-transparent in both tools while becoming
coordinate-establishing frames on rebuild.

**3. The build verifies itself.** The verifier composes the expected absolute transform of every
node from the stored matrices and compares it with `absoluteBoundingBox` in Figma, split by
effective visibility. Its first run reported 855 of 1486 nodes more than 1 px out, worst 1230 px —
while the page still *looked* right. Screenshots are not an acceptance test.

## Current state — pilot section `Яга Статьи`

```
nodes            1486 / 1486     svg 326 (324 vector + 2 rendered text)
size             1640 × 2157     exact
visible nodes    728             0 more than 0.5 px out of position
size delta       max 0.07 px over all 1486 nodes
failures         0 property, 0 relativeTransform
fonts            1 substitution (Rostelecom Basis Medium → Inter Regular)
```

`out/final-sbs.png` is the side-by-side; `out/section-pixso.png` and `out/section-figma-v10.png`
are the two full renders it is built from.

## Known limits

- **Pixso does not disclose some instance text overrides.** The renderer draws the real string;
  `characters`, `componentProperties`, `overrides`, `get_node_dsl` (even with
  `isDetachInstance: true`), `design_to_code` and the SVG export all return the component default.
  Detected automatically by comparing Pixso's inked width with the width Figma measures for the
  same string, then rebuilt from the Pixso render as vector — exact pixels, **not editable text**.
  2 of 178 text nodes in the pilot. The build names every flagged node so they can be retyped
  instead if editability matters more.
- **Library links are not restored.** By the owner's decision: transfer first, relink to the
  already-migrated Figma libraries by hand afterwards. Pixso component keys do not resolve in
  Figma, so matching would have to go through names and variant property strings.
- **Missing fonts substitute.** `Rostelecom Basis`, `PP Neue Machina`, `Hack` are absent from the
  Figma account. Missing fonts are acceptable — content must not be lost.
- Hidden nodes sit at different coordinates. Not a defect: hidden children are excluded from
  auto-layout flow in both tools, and Pixso's own stored coordinates for them are stale.

## Running it

Requires the Pixso desktop app open on the target file with its MCP at
`http://127.0.0.1:3667/mcp`, and the Figma MCP connected. Node 24, no dependencies.

```bash
cd tools
node px-export.mjs  <rootId> ../out/ir.json
node px-svg.mjs     ../out/ir.json <rootId> ../out/svg.json
node px-bounds.mjs  ../out/ir.json <rootId> ../out/bounds.json
node px-abs.mjs     ../out/ir.json <rootId> ../out/abs.json
node px-textink.mjs ../out/ir.json <rootId> ../out/textink.json
node pack4.mjs ../out/ir.json <rootId> ../out/svg.json ../out/bounds.json ../out/abs.json \
               ../out/payload.png ../out/textink.json [../out/textsvg.json]
```

Then upload `payload.png` with `upload_assets` + `curl` and run the bootstrap in `use_figma`.
Nodes the build flags as `textOverrideLost` get a second pass: put their paths in
`out/textlost.json`, run `px-textsvg.mjs`, and repack with the resulting `textsvg.json`.

## Tools

| file | what it does |
|---|---|
| `mcp.mjs` | minimal MCP Streamable-HTTP client (`info \| tools \| call \| script`) |
| `ser-lib.js` | node serializer injected into Pixso `eval_script` |
| `px-export.mjs` | chunked 4-phase tree/style/component export with adaptive batch splitting |
| `px-svg.mjs` | vector subtrees → SVG, deduplicated by content hash |
| `px-bounds.mjs` / `px-abs.mjs` / `px-textink.mjs` | render bounds, transforms, inked text extents |
| `px-textsvg.mjs` | renders specific text nodes whose override Pixso will not disclose |
| `pack4.mjs` | builds the PNG carrier (tree + assets + builder + verifier) |
| `builder4.js` | the in-sandbox builder and verifier, shipped inside the payload |
| `crop.mjs` / `diffmap.mjs` / `sbs.mjs` | dependency-free PNG crop, block difference map, side-by-side |
| `inflate.js` | raw-DEFLATE inflate, kept for carriers not written with stored blocks |

`docs/FINDINGS.md` is the engineering record: every measured number, every editor quirk, and every
defect with the evidence that found it. `.product-os/STATE.md` is where to resume.

## What is not in the repository

- `.claude/` — the Product OS method library attached to this project. Environment, not project
  source; it lives in its own place and is re-attached per project.
- `out/*.json` — the intermediate exports, ~29 MB. All of it is regenerated from the Pixso file by
  `px-*.mjs` in a few minutes and none of it is source.

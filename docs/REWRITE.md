# The rewrite: two sources, one IR, native components, kit mode

Status: **plan of record, second edition (2026-10-04); milestones not started.** Agreed in direction with the owner
on 2026-10-04, then revised after an independent review of the first edition and new measurements on two Сова
files. This document replaces the "Open, in order" list in `.product-os/STATE.md` (§10 says where each item went).
Engineering notes in English, like `METHOD.md` and `FINDINGS.md`; the designer's README stays in Russian.

**Evidence.** Every number was measured with read-only scripts:
- §3 onwards: two real files, the **test design file** (9 372 stored nodes, about 14 external libraries) and the
  **test kit**, a component library that itself consumes libraries (86 578 stored nodes);
- the Сова numbers (§3, §5): two more files measured on 2026-10-04, a **Сова UI kit file** (111 548 nodes) and a
  **Сова-based product file** (40 472 nodes, 15 577 instances);
- §2 and the 3 345 lost borders: the current tool's own logs and payloads across the files migrated so far, and
  1 019 build reports.

The detailed research notes and the measuring scripts are kept **outside this public repository**, because they name
internal files and components. Labels: **C** confirmed (measured), **I** inferred, **A** assumed (needs a probe).

## 1. What the owner asked for

1. A choice of **source**: a saved `.pix` file, or live Pixso through MCP.
2. **Native** components, variant sets, component properties, instances with overrides, and paint, text and effect
   styles, instead of frames and raw values.
3. A **UI-kit mode**:
   - migrate a kit first and record a **kit map**;
   - then migrate design files whose library components become **instances of the published Figma library**;
   - fall back to local copies with a reason when a kit is missing;
   - a separate case for the Сова design system, whose kit already exists in both editors.
4. No LLM in the transfer. Deterministic: the same input gives the same result.
5. All earlier improvement ideas:
   - honest failure accounting;
   - security of the local channel;
   - speed;
   - verification.

Pixso2Figma ("Rainbow", by a colleague) already solves much of 1–2 from `.pix`. Its licence is PolyForm Strict and
this repository is public, so **no code is copied from it**; behaviours and pitfalls learned from reading it are
described in our own words and marked "(seen in Rainbow)".

## 2. Why today's tool is slow and loses things (C unless marked)

- **Reading through MCP is 90–95 % of a run**, at 42–78 s per 1 000 nodes.
  - Component definitions are re-read for every object (15.5× more than needed).
  - Vectors are exported once per instance, not once per shape (7 356 exports gave 785 distinct SVGs).
  - Every call is a new process and a new MCP handshake.
- **Building in Figma is ~3.8 s per 1 000 nodes.**
  - 89 % of it is node creation.
  - Text-heavy objects cost more per node (3.89 against 2.98 ms). The likely cause (I) is the box read right after
    writing text, plus font and characters work; probe P6 measures it.
- **Silent loss.**
  - In the one library run, the last 249 of 577 objects (102 078 of 195 194 nodes, 52 %) failed in 193 s, 0.78 s
    each, which points to Pixso going away (I).
  - The recorded error was only the last three output lines (`stderr: null | } | Node.js v24.19.0`), so the real
    cause was lost.
  - Failed objects never reached the verdict, so PASS was still possible.
- **By design, components become frames and styles become raw values.**
- **Security.** The plugin executes builder code that arrives in the payload, and the job server answers any origin
  with no authentication; its read routes hand the payload and the images to any caller.

## 3. What the `.pix` settles (C unless marked)

- **Reading.**
  - A `.pix` is a ZIP: the Kiwi schema `pixso.binary` travels inside, so nothing is guessed.
  - The document is one zstd frame holding `PixsoMsg { pixsoNodes, blobs }`.
  - Decoding takes 0.6 s for the test design file and 3.5 s for the test kit.
- **Placement.**
  - Each node's `transform` is relative to its direct parent (groups included). Composing it reproduces Pixso's
    absolute position for 3 987/3 987 and 21 359/21 359 nodes.
  - Sibling order comes from `parentIndex.position`, using plain string comparison.
- **Units and enums that differ from Figma.**
  - Colours are stored 0–255. Percent spacing is stored as a fraction. Miter is an angle.
  - SPACE_EVENLY means SPACE_BETWEEN (the single-child case is open, P18), XOR means EXCLUDE, image STRETCH means
    CROP, FOREGROUND_BLUR means LAYER_BLUR.
  - A missing per-corner radius means 0.
- **Strokes.** The stored stroke-area path proves how per-side weights work. This fixes **3 345 nodes whose borders
  the current tool loses** (all four sides 0 with a visible stroke): 157 in the test design file and 3 188 in the
  test kit. 2 975 of them are an instance or sit inside one; 370 lie outside instances.
- **Vectors.**
  - Path blobs use only opcodes 0/1/2/4, with a winding rule per path.
  - The vector-network blob decodes exactly on every vector (1 397 + 8 935), including per-vertex radii.
  - So vectors can be built natively from the network instead of through SVG import (I: Figma's acceptance of
    decoded networks, per-vertex radii and per-region fills is untested, P19).
  - Regions and `fillGeometry` disagree on 35 and 220 vectors. The harmful part is 10 and 136 vectors with fill
    geometry but no region (auto-closed loops): they are built from their stored `fillGeometry` and
    `strokeGeometry` and counted as VECTOR_FROM_GEOMETRY, unless P19 shows that Figma fills a region-less open
    network the same way. The other 25 and 84 have a region but no fill to draw.
- **Text.**
  - Per-range style ids come per code point.
  - Lists, hyperlinks and truncation are stored.
  - Pixso's own line breaks are stored, which gives a direct check for the "heading wraps one pixel early" defect
    (decision 9).
- **Variants are not a property type.**
  - A variant's coordinate lives in its SYMBOL name inside a state-group frame.
  - 64/67 and 308/312 sets parse cleanly; mixed axis order must be normalised.
  - Sets that do not parse (a duplicate coordinate, a duplicate axis or a different axis count; 3 and 4 sets) are
    built as standalone native components and reported as VARIANT_SET_REJECTED.
- **Properties.**
  - Raw definition ids repeat across owners, and newer Pixso writes variant-local aliases as unnamed BOOL (6 771 of
    6 771 in the test kit; 1 105 references disagree with the alias type). Type, name and default therefore always
    come from the root definition on the set, and every definition is keyed by (family, id).
  - An assignment whose definition cannot be reached from the instance's current family is stale (I; 130 in the
    test design file, 2 034 in the test kit). It is dropped and counted as STALE_ASSIGNMENT, never matched by name.
- **Overrides.**
  - `symbolOverrides` are addressed by guidPath. With swaps resolved, `derivedSymbolData` paths resolve
    35 808/35 808 and 160 980/160 982, and non-root override entries resolve 6 353 of 7 079 and 42 456 of 43 406.
  - The other 726 and 950 are exactly the entries whose path is absent from `derivedSymbolData`, so they are
    provably stale: dropped and counted.
  - Many override fields only echo the master's value and must be dropped before applying.
- **`derivedSymbolData`** (Pixso's resolved geometry for every instance sublayer) is not used to expand instances,
  because Figma recomputes them. The reader uses it to prove which overrides are live, any fallback frame takes
  geometry and vector paths from it, and the verifier uses it as the oracle.
- **Styles** (the cases are C; the binding rule is I).
  - A reference resolves by guid, or else through a local copy's `overrideKey`; `0:0` and the all-ones guid mean
    "no style". A reference that resolves nowhere keeps the node's raw values and is counted
    STYLE_MISSING_IN_SOURCE.
  - On ordinary nodes, the node's own value is what Pixso draws. The style is bound when its value equals the node's
    within 1/255 per channel; otherwise the raw value stays and STYLE_VALUE_DIFFERS is counted. In override
    records, the referenced style wins over the cached paint.
  - Style identity is the styleKey plus a value signature, never the name and never the guid alone, so copies of one
    styleKey with different values stay separate (seen in Rainbow).
  - A soft-deleted target is bound if it was built; otherwise raw values are kept and counted.
- **Library identity.**
  - Every library component copy carries `publishFile` (library file key), `publishID` (master guid in that
    library), `componentKey`, `sharedSymbolVersion`, and `overrideKey` on its layers.
  - `overrideKey` equals the layer's guid in the library's own file: 2 069/2 069 layers, 518/518 versions in sync.
  - Identity is the pair (`publishFile`, `publishID`). Names are not: on the Сова pair only 2 149 of 3 828 resolved
    copies still carry their master's name (§5).
  - `componentKey` on copies equals the key Pixso MCP reports for the same component: the Сова files match the
    «Проверка макета» key lists by 12-hex prefix for 4 588 keys of the UI kit, 587 of a second Сова library and 419
    of the icons library. The `.pix` and the MCP source therefore share component identity.
  - A kit's own masters carry no `componentKey`.
  - A kit's own file key is stored on its own styles, if it has any (214/214 in the test kit), and on its copies of
    its own published components, if it consumes itself (5 100 internal-canvas copies in the Сова UI kit file; none
    in the test kit). Those self-copies also carry `componentKey`, so they can feed componentKey enrichment (I).
- **Images are often not in the archive.** 0 of 5 referenced images in one file and 41 of 66 missing in the other;
  some `.png` entries are JPEG or WebP.

## 4. Architecture

```
 runner (Node ≥ 22.15, no dependencies)                      Figma desktop, development plugin
 ──────────────────────────────────────                      ─────────────────────────────────
 source ─┬─ .pix reader (kiwi, two-pass, bounds-checked)     ui.html  (origin "null")
         └─ MCP reader (one session, one walk)                 fetch ⇄ runner with a per-run token
            │                                                  prefetches the next task
            ▼ IR (documented, versioned, data only)          code.js  (builder BUNDLED, no eval)
 planner: definitions and variant families first,              serial task queue
          styles, images, fonts, kit-map resolution,           styles · variables · images · fonts
          tasks ≤ 4 MB, resume ledger                          definitions (shell → combine → props → fill)
 transport: 127.0.0.1/::1, token on every route,               roots (nodes → layout passes → overrides)
          Origin "null" only, Host check, window of one        MEASURE / VERIFY / RENDER / KITMAP / CLEAN / PROBE
          task, acks
 report: every object ends in a recorded state;
          reason codes; never a silent PASS
```

- **One IR, one builder.** The source never reaches the plugin.
- **The IR is data only**, validated on load; an unknown version is refused. It carries ordinary nodes, component
  definitions (sets with axes, members with coordinates, property definitions), instances (master reference,
  property values, overrides with resolved paths), styles, image references and fonts. Its header carries:
  - the **source snapshot**: the `.pix` SHA-256, or the Pixso file key plus the read time;
  - the **capabilities** the source provides: `{authoredOverrides, resolvedOverrides, overrideKeys, publishIds,
    symbolVersions, derivedBoxes, inkBounds, renders}`. The builder, the kit-map resolver and the verifier use only
    what the header declares.
- **The `.pix` source** builds the IR straight from the file in seconds, but it is not fully standalone. Three things
  need live Pixso with the **same file open**: image bytes missing from the archive (all 5 in the test design file,
  41 of 66 in the test kit), Hue and other filters Figma lacks (rendered by Pixso), and the render-vs-render audit.
  - The image chain: archive bytes; Pixso MCP bytes by hash (the SHA-1 is checked); a Pixso render of the smallest
    carrier node (needs the same file open, and Q5); a counted placeholder. A missing image is never an empty fill.
  - Before it uses Pixso for renders, the runner checks that the open file matches the `.pix` (root name, page ids,
    a sample of node ids).
  - A run without Pixso lists these gaps in its preflight table, and its verdict reads `BUILT, NOT VISUALLY
    AUDITED`, with the placeholder and unrendered-filter counts. It never reads PASS.
- **The MCP source** exists for what `.pix` cannot do: the live selection or open page, unsaved edits, the kit's file
  key and component keys, renders for visual checks, and filling missing images. It leaves `overrideKey`,
  `publishID` and `sharedSymbolVersion` empty unless Q4 shows Pixso exposes them, and marks overrides `resolved`.
  Its redesign:
  - one persistent session, each request with a 45 s deadline and reconnect;
  - on every reconnect, the open file's key, root name and page ids are re-checked; a different file stops the run
    (IDENTITY_CHANGED);
  - one walk per object in calls of ~6 s, under Pixso's ~15 s script limit (Q3 and Q10 set the budget);
  - definitions, styles, images and vectors read once per file;
  - instances read as master + properties + overrides, found by comparison with the master (Pixso's own override list
    omits text, fills and swaps: 0 of 148 244 mentions);
  - top-level ids and boxes are read at the start and at the end of the read; any change marks the IR
    `changed-during-read`, and the verdict refuses PASS.

  Expected 8–22 s per 1 000 nodes (I), against 42–78 today.
- **Creation order in Figma.** Each step happens once, and nothing written early is undone later:
  1. fonts: every font the IR declares (nodes, text ranges, text styles), plus the fonts of every imported library
     master (from the kit map's `fonts`, or read once per imported master after import), is loaded before any text
     write. Figma reads installed fonts only at startup, so missing fonts are listed in the preflight table with
     "install, restart Figma, run again". If the designer continues, text falls back to one fixed font; every
     substitution is counted per node and per style, kept apart from real defects, and a text style is still
     created with all its other properties;
  2. images;
  3. styles (and, for Сова, library variables imported by key and bound with `setBoundVariableForPaint`);
  4. component definitions in two phases: empty components, then variants combined **before any instance exists**
     (A, P14), then properties, then content leaves-first;
  5. roots: nodes parent-first; auto layout deepest-first (P5); child layout; instance overrides (swaps, then
     properties, then field deltas, then size); constraints last.
- **Write-only discipline.** No layout reads during creation. Reads happen only in named MEASURE/VERIFY phases, each
  after one settle, in bulk.
- **Yielding** stays on `getNodeByIdAsync`, our measured fix for background timers that wake once a minute, until
  probe P2 says otherwise.
- **Document access.** The plugin manifest sets `documentAccess: "dynamic-page"`, so the builder and the verifier use
  the async getters (`getNodeByIdAsync`, `getMainComponentAsync`, `getStyleByIdAsync`) and never read
  `mainComponent`.
- **Stamps, not remembered ids.**
  - Roots carry `pxSrc`, `pxRun` and `pxState`; components and sets carry `pxDef` (Pixso guid, plus
    `publishFile`/`publishID`); styles carry `pxStyle`; pages carry `pxPage`; all carry the source snapshot
    (`pxSnap`). They are shared plugin data (today's root stamp is private plugin data).
  - Resume, clean and verify find nodes by stamp, as today. A stamped root is resumed only when its snapshot equals
    the current IR's; otherwise it is rebuilt.
  - Per-layer stamps exist only in kit mode, and only if P7 allows them (§5).

## 5. Modes

**Design mode** (a product file):
1. **Preflight before any build.** Collect every library publication and style the file uses, resolve them against
   the loaded kit maps, and import every needed Figma key once (`importComponentByKeyAsync`, `…SetByKeyAsync`,
   `importStyleByKeyAsync`, `importVariableByKeyAsync`). Print a table per library (linked / fallback / reason),
   plus missing fonts and missing images. The user can stop here.
2. **Per instance.** A failure in steps 2–6 falls back to a local copy; a failure in steps 7–8 follows decision 1.

   | step | check | on failure |
   |---|---|---|
   | 1 | no `publishFile`: own master → local component | — |
   | 2 | kit map for `publishFile` loaded | KIT_MAP_MISSING |
   | 3 | entry `publishFile@publishID` present | MASTER_NOT_IN_MAP |
   | 4 | built and not hidden | MASTER_NOT_BUILT, MASTER_HIDDEN |
   | 5 | import succeeded in preflight | IMPORT_FAILED |
   | 6 | `sharedSymbolVersion` equal | VERSION_DRIFT: link if every touched layer still maps (decision 2), else DRIFT_UNMAPPABLE |
   | 7 | set properties | PROP_NOT_IN_MAP, SWAP_TARGET_UNMAPPED |
   | 8 | translate overrides (item 4) | OVERRIDE_PATH_UNRESOLVED, OVERRIDE_FIELD_UNSUPPORTED, OVERRIDE_APPLY_FAILED, … |
3. **A file read through MCP.** The master is looked up by (library file key from `getLibraryInfoAsync`, Pixso
   `componentKey`), or by `publishID` if Q4 shows that MCP `node_id` equals it. Overrides map by child-index path
   inside the master and are accepted only when the master's layer count and types equal the kit entry; otherwise
   the result is DRIFT_UNMAPPABLE. Kit maps therefore record each master's Pixso `componentKey`, taken from MCP
   `get_all_components` on the kit, from the kit's own self-copies, or from the copies in consumer `.pix` files. New
   keys are appended, and a conflict is an error.
4. **Overrides are translated hop by hop.**
   - (a) A layer of a library copy → its `overrideKey` → the kit layer.
   - (b) A step that is itself an `overrideKey` → looked up directly in the hop's entry (seen in Rainbow).
   - (c) A layer of an unpublished local duplicate of the same library set (437 of 6 428 overrides in the test design
     file, mostly text) → accepted only if set name, variant name, child-index path and type match exactly one layer
     of the expected copy (OVERRIDE_VIA_LOCAL_MIRROR, a warning); otherwise OVERRIDE_PATH_UNRESOLVED.
   - (d) A layer of an own master stays local.
   - At a nested instance of another library, translation switches to that library's kit map.
   - The Figma target is `I<instance>;<kit layer id>` (A, P11b). If P11b shows the ids differ, the kit map stores
     index paths, and each imported master is walked once per run to convert them.
5. **Fallback is a local copy with a reason code, never a silent frame.** Every code is counted, the style codes of
   §3 and STYLE_NOT_IN_MAP included.

**Kit mode** (a library), always chosen explicitly. A detector pre-selects it and shows why.
- **Built natively, in place:** every own master and set, its properties and its own styles.
- **Every own master on Pixso's internal canvas** is built on a page "Pixso: deleted components", described with its
  old path from `ancestorPathBeforeDeletion`. They are soft-deleted in Pixso but still used: 694 in the test kit,
  used by 2 030 of its own instances; 12 of the 41 kit masters the test design file places directly are among them.
- **Dependency order.** The preflight lists the libraries the kit itself consumes (43 for the test kit), by Pixso
  file key, with counts. Base libraries are migrated first, then the kits that consume them, then design files, and
  the map records `dependsOn`. A kit migrated before one of its dependencies keeps local copies of it
  (KIT_MAP_MISSING) until it is re-run. A cycle is reported, never broken. Copies of the kit's own components (§3)
  resolve to its own masters and are not a dependency (I).
- **Re-running a kit updates it in place.** Components, sets, styles and layers are found by stamp and updated, never
  recreated, so Figma keys and consumer links survive. New masters are added. Masters gone from Pixso move to the
  deleted page. A node changed in Figma since the last run is reported and left alone (decision 8). The kit map gets
  a new version, and consumers built against the older one report VERSION_DRIFT.
- **Kit map.**
  - Stamps on every built component, set and style are the source of truth inside the Figma kit. Per-layer guid
    stamps are added only if P7 shows that 10 000 stamps cost under 2 % of build time; otherwise the layer map lives
    in the map header in `figma.root` (chunked; chunk size from P17) and in the exported JSON.
  - The **kit map JSON is exported outside this repository**: per user, or published on the internal docs site. The
    runner refuses to write a map inside the working tree, and M0 adds `*.kitmap.json` to `.gitignore` (§8).
- **Publishing the Figma library is a manual step** (the plugin API cannot publish). A VERIFY command, run from
  another file, imports every key and marks the map verified. Keys are recorded at build time, which assumes
  `ComponentNode.key` is readable before publishing and unchanged after (A, P15).
- **The kit's Pixso file key**, in order of trust: MCP `getLibraryInfoAsync` (I, Q4); its own styles; its copies of
  its own components (§3); a consumer file that references it; the user. Conflicting sources stop the run
  (KIT_FILEKEY_CONFLICT); with no source, no map is written.

**Сова pairing** (no migration; both kits exist):
- **Measured (C)** on the Сова UI kit file and the Сова-based product file:
  - in the product file, 4 972 of 6 575 library copies are Сова components, 4 724 of them from the UI kit; 16 copies
    come from a different company design system that is not Сова;
  - the Pixso half joins by identity: 3 828 of the 4 724 UI-kit copies have a `publishID` equal to the guid of an own
    master in the kit file; the other 896 do not resolve (MASTER_NOT_IN_MAP);
  - drift is common: only 2 149 of those 3 828 still carry their master's name. The copy → master step therefore
    goes by identity, never by name; `sharedSymbolVersion` is compared and every drifted copy is reported
    (decision 2 sets the policy).
- **Assumed (A):** the Figma side has not been measured, so the cross-editor rules below are a design that M5 measures
  first.
- **Two steps.**
  1. Product-file copy → Pixso Сова master, by `publishFile@publishID` and `overrideKey`, as in design mode.
  2. Pixso Сова master → Figma Сова component, by an offline, deterministic matcher per file pair: normalised names,
     full variant tuples, a structure signature and a curated alias table. Colour styles map to `[Sova] Style`
     variables (Pixso `<theme>/<token>` → variable `<token>` in mode `<theme>`); text styles use a rule table.
- Ambiguities are reported, never auto-picked. A person approves the map before design runs use it.
- Copies from non-Сова libraries are never paired with Сова: they follow ordinary design mode and appear in the
  preflight table.
- **Inputs:**
  - `.pix` of the three Pixso Сова files (UI kit, second library, icons), all in hand (decision 10);
  - Pixso component keys: via MCP, or from `componentKey` in any `.pix` that uses the component (they are equal, §3);
  - Figma REST components, sets and styles;
  - a read-only plugin export of each Figma kit, including hidden parts and variables.
- **Coverage is checked** against the key lists already maintained by the «Проверка макета» plugin, which the `.pix`
  `componentKey` values match (C, §3). The lists hold 12-hex prefixes, so they serve membership and coverage, not
  matching.

**How a designer runs it.** The launcher only starts the runner; every choice is made in the plugin window.
- **Source:** a `.pix` file (dropped on the launcher, passed as a path, or picked in the plugin window and uploaded to
  the runner over the token channel), or "the file open in Pixso".
- **Mode:** design or kit, pre-selected by the detector with its reason.
- **Scope:** for a `.pix`, the whole file or chosen pages and top-level objects; for Pixso, the whole file, the open
  page or the selection.
- Kit maps are read from the per-user folder and listed with their verified state.
- Every run stops at the preflight table and continues only when the designer presses "Build".
- A kit run ends with a checklist in the window and in the README: publish the library in Figma (Assets → Publish);
  open another Figma file and run VERIFY; the map is written to the per-user folder.
- The console accepts the same choices as `--source`, `--mode`, `--scope` and `--kitmaps`.

## 6. Reliability and security

- **Every object ends in a recorded state:** built, built-with-fallbacks, failed or skipped. The verdict counts
  them, so a failed extraction is a failed object.
- **Full error text is kept**, in the local run log (§8).
- **Circuit breaker, Pixso channel:** after three consecutive transport failures, or 60 s with no successful MCP call,
  the run stops issuing work, writes the checkpoint and says "Pixso stopped answering at object X: N done, M left".
  It probes every 5 s for up to 10 min, re-checks the open file's identity and resumes.
- **Liveness, Figma channel:** the plugin posts progress with a counter that advances only when the main thread
  completes a chunk or a pass. The runner warns after 60 s without an advance, and stops the run (FAIL, resumable)
  after 5 min without one, or when a per-task ceiling scaled by node count is reached. A heartbeat without an
  advancing counter never extends a task.
- **No code over the network.** The plugin accepts an enum of data tasks and refuses anything else. A selftest
  fails if `dist/` contains `eval(`, `Function(` or the AsyncFunction constructor.
- **MCP scripts are read-only by construction.** They are generated only from the repository's fixed script library
  and never arrive over the network. A static check rejects any script that assigns node properties or calls a
  mutating method (`setPluginData`, `remove`, `appendChild`, `resize*`, `setRange*`, `detachInstance`,
  `swapComponent`, …), and selftest covers that check.
- **Per-run token.** The token is generated at start into the plugin UI, which M0 git-ignores (§8). If that is not
  possible, the user types a pairing code.
- **Requests the runner refuses:**
  - any Origin other than the UI frame's real origin (P1);
  - a `Host` other than `localhost:PORT`, `127.0.0.1:PORT` or `[::1]:PORT` (421);
  - any request that lacks `Authorization: Bearer <token>` (compared in constant time), read routes included: tasks,
    IR, images, reports and kit maps. The only exceptions are the CORS preflight and the one-time `/pair` exchange,
    at most 5 attempts per run. `Origin: null` alone proves nothing, because any web page can produce it from a
    sandboxed iframe; the token is the proof;
  - a token bound to an earlier `runId`.
- **Runtime.** The runner requires Node 22.15 or newer (built-in zstd). The launcher checks the version and says what
  to install, and the Russian README is corrected (today it says Node 20).
- **Truncated or hostile `.pix`.** The reader kept from `tools/kiwi.mjs` gains bounds checks on every read. Reading
  past the end, meeting a field id the bundled schema does not define, or a document that does not end on its last
  byte stops the run with PIX_CORRUPT before anything is built. Selftest covers a truncated fixture.

## 7. Verification (kept, extended)

- **Build vs IR.** Geometry and node counts, now including instance sublayers, are checked against
  `derivedSymbolData`. Every entry is within 1 px or in a named class: a sublayer field Figma ignores (P13), scale
  (P10), the half-pixel border band. Zero unclassified.
- **Source vs IR.** Coverage, with every loss given a reason code.
- **Render vs render.** The visual audit, attributing a known per-master delta for Сова pairs before calling
  something a defect. It needs the same file open in Pixso; without it the verdict reads `BUILT, NOT VISUALLY
  AUDITED`.
- **Linked instances.** The component returned by `await instance.getMainComponentAsync()` must have the expected
  `key` and `remote === true`, and the count of applied overrides must equal the count intended.
- **Determinism.** Two runs on the same input give a byte-identical IR.

## 8. Tests and data hygiene (public repository)

- **Nothing real enters the repository.** No byte, name, key or picture from a real file: not in tests, fixtures,
  docs, PR descriptions or commit messages. Milestone evidence is counts only, as in this document.
- **Synthetic `.pix` fixture** (seen in Rainbow). An in-repo Kiwi encoder builds the ZIP, schema and zstd document in
  memory. The fixture covers an internal canvas, a state group with mixed axis order, nested and swapped instances,
  properties with aliases, a stale override, local and dangling styles, a missing image, a vector network, an
  unsupported node type and a truncated file. Encode-then-decode round trips are tested.
- **Headless Figma double** (seen in Rainbow). It implements only the calls the builder makes and fails on any other.
  It must reproduce every probe verdict (conformance test). When Figma changes, the probe is re-run first and the
  double changed after.
- **Private artefacts live outside the working tree.** Kit maps, the Сова alias table and review report, IR dumps,
  resume ledgers, image caches, run logs and probe results go to the per-user data folder, and the runner refuses to
  write them inside the repository. M0 adds `*.kitmap.json` and the generated plugin UI (`figma-plugin/dist/`) to
  `.gitignore`, and selftest fails if a tracked file matches them.

## 9. Probes before relying on assumptions (bundled `PROBE` command, stamped service page)

Figma, in the owner's Figma desktop:

| id | question |
|---|---|
| P1 | the UI frame's real Origin; does `ACAO: null` pass in Figma desktop |
| P2 | yield cost of `setTimeout(0)` vs `getNodeByIdAsync` vs message round-trip, front/covered/minimised |
| P3 | the largest message delivered reliably in each direction |
| P4 | image bytes as base64 vs `Uint8Array`: speed, same hash |
| P5 | auto layout at creation vs deepest-first after |
| P6 | gain from removing the in-loop text read |
| P7 | `setSharedPluginData` cost: 10 000 stamps vs none; stamp every kit layer only if < 2 % of build time |
| P8 | images over 4 096 px, WebP, JPEG-in-PNG: throw or drop; an IMAGE paint with an unknown hash |
| P9 | instance sublayer ids `I<inst>;<layer>` stable, also after a swap (local masters) |
| P9b | does an equal-value write on an instance sublayer create an override or a reflow (seen in Rainbow) |
| P10 | scaled instances: `rescale` vs `resize` vs `derivedSymbolData` |
| P11 | library import of a component, a set, a style and a variable, with the library enabled and not enabled; latency; hidden and deleted components |
| P11b | sublayer ids of an instance of an imported component against the kit's own layer ids |
| P12 | plugin data on imported remote masters |
| P13 | which override field kinds Figma accepts on instance sublayers |
| P14 | `combineAsVariants` and `addComponentProperty` on empty component shells; instances created later show the content filled in after combining |
| P15 | `ComponentNode.key` readable before publishing, unchanged after publishing and import |
| P16 | `setProperties` on an unexposed nested instance |
| P17 | the largest shared plugin data value accepted on `figma.root` (sets the map-header chunk size) |
| P18 | single-child SPACE_EVENLY in Pixso against SPACE_BETWEEN in Figma (render both) |
| P19 | `setVectorNetworkAsync` with decoded networks: per-vertex radius, per-region fills, auto-closed loops, an open network with no region; compared with `fillGeometry` |
| P20 | a remote variable bound with `setBoundVariableForPaint` on a node and in an instance override; an explicit Theme mode set on a frame |

MCP, read-only in Pixso:

| id | question |
|---|---|
| Q1 | are `fillGeometry`/`strokeGeometry` exposed, and at what cost against SVG export |
| Q2 | cost per getter against a full read |
| Q3 | does `globalThis` survive between calls |
| Q4 | are `publishID`, `overrideKey`, `sharedSymbolVersion` exposed; `getLibraryInfoAsync` on local and remote mains; MCP `component_key` = `.pix` `componentKey` on full keys (equal by 12-hex prefix, C); `node_id` = `publishID` |
| Q5 | sublayer id segments = `.pix` guidPath elements; API `s:l` ids = `.pix` guids |
| Q6 | `ping`, and the status for an expired session |
| Q7 | two concurrent `eval_script` calls |
| Q8 | does `exportAsync` need Pixso in front |
| Q9 | `getRange*` bisection against per-character reads |
| Q10 | the exact script time limit (10/12/14/16 s busy-wait), and the cost of `loadAllPagesAsync` per call on the test kit |

P1–P20 run in a scratch file (decision 6); P11, P11b, P12 and P15 also need a library the owner can publish (decision
7). P11's import-only parts (latency; library enabled or not) run early against the published Сова libraries. Q1–Q10
run before the MCP milestone starts; Q3 and Q10 set the call budget. §10 says which milestone each probe gates.

**Results so far (2026-10-04, through the Figma MCP in a scratch file; C).** The MCP environment differs from our
plugin in two ways that matter for reading these: it starts with `figma.skipInvisibleInstanceChildren = true` (hidden
instance sublayers vanish from `children` and `getNodeByIdAsync` returns null for them until it is set to false), and it
does not support `setPluginData`, so P7, P12 and P17 must run in our own plugin.

| probe | result | consequence |
|---|---|---|
| P14 | empty components combine into a set; `addComponentProperty` works before any content exists; an instance created before the content was filled shows it afterwards | the two-phase definition order stands |
| P15 (first half) | `ComponentNode.key` is readable on a local, unpublished component | the second half (unchanged after publishing) needs decision 7 |
| P9 | sublayer ids are `I<instance>;<master layer>`, nested ones chain `I<outer>;<nested instance>;<layer>`; after a variant switch the last segment becomes the new master's layer id | ids are computable without reading layout |
| P16 | `setProperties` on an unexposed nested instance switches its variant | nested variant switches need no swap |
| P9b | writing a sublayer's current value creates no override | the no-reassert rule holds; echo overrides are harmless but still dropped |
| P13 | accepted on instance sublayers: fills, strokes, stroke weight per side, stroke align, effects, opacity, blend mode, name, corner radii (per corner too), visibility, text size, fills and auto-resize; a text bound to a property takes `characters` as the property value. Refused with an error: rotation and position (relative transform), constraints. **Silently ignored:** `resize` and `resizeWithoutConstraints` | Pixso size, position and rotation overrides on instance sublayers cannot be expressed: each one is counted (OVERRIDE_FIELD_UNSUPPORTED) and handled by decision 1 (a local copy by default). Size changes are never verified by the absence of an error |
| P19 | a decoded network with per-vertex `cornerRadius` and per-region fills is accepted and drawn; an open network with no region is not filled even with a node fill | the `fillGeometry` fallback for region-less vectors (§3) is required |
| P11 | importing a published component by key works **without** enabling its library in the file: 2.4 s first, 1.1 s again, a 154-variant set in 1.4 s; the import is `remote` with the same key | preflight imports must run in parallel batches (latency, P11 parallel) |
| P11b | sublayer ids of an instance of an imported component are `I<instance>;<kit layer id>`, the kit file's own ids | kit maps record Figma layer ids from the kit file; overrides translate directly |
| P20 | with the variables library enabled in the file: a Theme variable imports by its **published** key, binds to a node fill and to a fill override inside an imported instance, and an explicit Dark mode on a frame resolves it to the dark value. The key a kit node reports for its bound variable is **not** importable even with the library enabled: the Figma kit is bound to another publication of the styles library | Сова colour binding uses the keys the enabled library publishes (`teamLibrary.getVariablesInLibraryCollectionAsync`, matched by collection and variable name), never keys read from kit nodes; the design-mode preflight requires the variables library to be enabled in the target file and says so |

The Figma Сова kit also uses Figma's `SLOT` node type inside its components; the matcher, the verifier and the IR's
node-type list must know it.

## 10. Milestones

Each milestone is one branch and one pull request, accepted by numbers on the test files and on any file the owner
adds (counts only, §8).

| # | milestone | gated by | accepted when |
|---|---|---|---|
| M0 | **Foundation**: IR schema. Today's builder, verifier, guarded clean and render bundled in the plugin as fixed commands (BUILD, VERIFY, CLEAN, RENDER, PROBE) that consume today's payload; `visual-all.mjs`, `visual.mjs`, `build-lib.mjs` (clean) and `test-clean.mjs` moved onto them. Token transport; recorded object states and circuit breaker in the current MCP path; synthetic `.pix` fixture; `.gitignore` guards. Before the cut-over, today's tool runs once on the test design file and on the test-kit objects that build today; its build reports and render audit are kept outside the repository as the baseline. Decision 6 is made | P1, P2, P3, P9 | selftest proves no code over the network; a killed Pixso mid-run gives FAIL with the error, not PASS; the same payloads rebuilt through the bundled builder give the same node counts and verifier numbers as the baseline; `test-clean.mjs` passes through CLEAN; the render baseline exists; selftest passes on the synthetic fixture with no real file present; the `.gitignore` guards are in place |
| M1 | **`.pix` → IR → Figma for ordinary nodes**: the bounds-checked reader, native vectors with the geometry fallback, per-side strokes, text ranges, auto layout, the image fallback chain (through the current MCP path kept in M0: bytes by hash with a SHA-1 check, then a render). Instances are built as counted placeholders (INSTANCE_DEFERRED) with the instance's box. Masters that contain no instance (386 in the test design file, 2 500 in the test kit, own and library copies) are built as plain components without properties on a service page, so the vector and text work is exercised where it lives | P4, P5, P6, P8, P18, P19, run on the first build before the creation order is frozen | node count equals the IR for every non-instance node; geometry within 1 px; side stroke weights equal the IR on every built node, including the 370 lost borders outside instances; for every vector, VERIFY's fill path count and per-path bounds equal the `.pix` `fillGeometry` within 1 px, or the vector carries a reason code; every text whose Figma line count differs from Pixso's stored `baselines` is counted and named; every placeholder is counted; without Pixso the verdict is NOT VISUALLY AUDITED; build time is reported per phase and per 1 000 stored nodes and becomes the baseline (today 3.8 s) |
| M2a | **IR for components, offline** (needs no Figma; can run in parallel with M1): family validation, property roots, swap-aware guidPath resolver, stale and echo classification | — | derived entries resolve 35 808/35 808 and 160 980/160 982; a non-root override resolves exactly when its path is in `derivedSymbolData` (6 353/726 and 42 456/950); families parse 64/67 and 308/312, and the rest are REJECTED with a reason; the 130 and 2 034 stale assignments are dropped and counted; no property is declared with a type other than its root definition's; two runs give byte-identical IR |
| M2b | **Components in Figma**: definitions, variant sets, properties, instances, overrides, local styles | P9b, P10, P13, P14, P16 | every `derivedSymbolData` entry is within 1 px or in a named class (§7), zero unclassified; every unapplied override and every dropped property assignment is counted with a reason; all 3 345 lost borders present; with the same file open in Pixso, the render audit against the M0 baseline is no worse than today; override time per 1 000 overrides and stamping time are reported; whole-file build time on both test files is no worse than the M1 baseline plus the override time |
| M3 | **Kit mode and design mode** (from `.pix`): kit map, stamps, VERIFY, preflight, linking, fallbacks, dependency order, in-place re-run, the designer's run flow. Decision 7 is made | P7, P11, P11b, P12, P15, P17 | of the test design file's 335 direct instances of test-kit masters, every one is linked (`remote === true`, key equal to the map's) or carries a reason code, and instances of the 12 masters deleted in the kit follow decision 3; for every linked instance, the overrides applied equal the overrides intended, or the lost ones are listed under decision 1; the per-library table lists all 14 libraries the design file uses; a second kit run changes no Figma component key; the run flow (§5) is walked through on the test pair without the console |
| M4 | **MCP source v2**: session, walker, tiered instance reads, selection and page scope, unsaved edits | Q1–Q10 | on a file saved as `.pix` and also open in Pixso, the two IRs are equal on every field both declare, and every other per-guidPath difference carries a class (stale in `.pix`, undisclosed text, a field the capabilities header does not declare, changed during read), zero unclassified; the test design file is read at ≤ 18 s per 1 000 nodes, against 55.2 s today; design mode from the MCP source links through `componentKey`, and whatever Q4 rules out is reported as unsupported; one run with a real selection |
| M5 | **Сова pairing**: data collection, matcher, review report, approved map; builder support for library variables (`importVariableByKeyAsync`, `setBoundVariableForPaint` on nodes and in instance overrides, an explicit Theme mode on the nearest frame whose subtree uses one theme, mixed-theme subtrees counted). Inputs supplied (decision 10), review process agreed (decision 5) | P11, P20 | the Сова-based product file arrives with instances of the Figma Сова libraries and colours bound to `[Sova] Style` variables in the right mode; every Pixso Сова key is matched or listed as unmatched; every Сова copy whose `sharedSymbolVersion` differs from its master, and every copy that does not resolve (896 today), is reported with its code |
| M6 | **Designer packaging**: launcher, Russian README, the «Ресурсы» page on the docs site | — | the walkthrough is done by someone who has never run it, on Windows and on macOS, with only the stated Node version installed (launcher, token route, per-user data folder) |

Carried from `.product-os/STATE.md` "Open, in order": item 1 (stale ids) is closed by design (stamps, §4); 2 (the
one-pixel heading wrap) is decision 9, measured in M1; 3 (migrating from a `.pix`) is M1–M3; 4 (a real selection) is
in the M4 acceptance; 5 (a per-card offset) is re-checked in M1 on the file where it was seen; 6 (macOS) is in the M6
acceptance; 7 (missing fonts) is the font plan in §4; 8 (components as frames) is M2b.

## 11. Decisions

Answered by the owner on 2026-10-04: the proposed defaults are accepted, and **every policy below is a setting the
designer can change** — in the plugin window before the build, and as a console flag. The run report and the IR header
record the settings used, so two runs are comparable.

| # | question | default (owner) | setting |
|---|---|---|---|
| 1 | an override cannot be applied to a library instance | fidelity first: a local copy, the lost link reported | `--overrides fidelity\|link` |
| 2 | version drift between a copy and its kit master | link when every touched layer still maps, else a local copy (on the Сова pair 1 679 of 3 828 resolved copies no longer carry their master's name) | `--drift link\|local` |
| 3 | kit masters deleted in Pixso but still used | built and published from "Pixso: deleted components" | `--deleted publish\|skip` |
| 4 | where kit maps live | the per-user folder, with the internal docs site as the shared copy | `--kitmaps <dir>` |
| 8 | a kit re-run when both sides changed | Pixso wins only on nodes nobody edited in Figma; Figma edits are reported and kept | `--resync pixso-unless-edited\|report-only` |
| 9 | a heading that wraps one pixel early (STATE.md open item 2) | widen only texts whose stored `baselines` show one line, counted as TEXT_WIDENED_TO_SOURCE_LINES | `--text-fit widen\|source-box` |

Also settled:
- **6. Probes.** The assistant may create and use scratch files in a dedicated experiments project in the owner's
  Figma team. Probes that need the development plugin itself (P1–P3) run there with the owner's plugin window open.
- **7. Test kits** are published in the same experiments project, not to the whole organisation.
- **10. Сова inputs.** All three Pixso Сова files (UI kit, second library, icons) and one Сова-based product file
  were supplied on 2026-10-04. The icons library already exists in Figma as well.
- **5. Сова map review.** The matcher writes a review page of the pairs it could not decide, with renders of both sides; the owner or a designer of the Сова team confirms them, and the confirmed table (aliases included) is kept with the private «Проверка макета» repository, next to the Сова key lists.

## 12. Kept and dropped

- **Kept:**
  - `docs/METHOD.md` (its §3, "relink by hand", is rewritten in M3) and `docs/FINDINGS.md`;
  - the payload ideas (flat parent-first records, value dictionary);
  - matrix placement, per-side strokes and corners, paint and effect sanitisers, leadingTrim;
  - the re-measure-and-revert repair rule, constraints last;
  - the three-way verification, stamps and guarded clean, moved onto fixed commands in M0;
  - `tools/kiwi.mjs` (with bounds checks added) and `tools/pix-open.mjs`, as the base of the `.pix` reader.
- **Replaced:**
  - the per-call MCP layer (`tools/mcp.mjs`, `tools/px-*.mjs`, `migrate*.mjs`), kept in use until M4;
  - network-delivered builder code, including the code sent inside today's render and clean jobs;
  - the CORS `*` job server.
- **Removed once replaced:** the legacy packers and probes listed in `.gitignore`.

# Decisions

## 2026-09-03 — Resolve components via mainComponent, never by key

**Decision:** the exporter resolves component definitions through `instance.mainComponent` and
`pixso.getNodeById(mc.id)`, not `pixso.importComponentByKeyAsync(key)`.
**Because:** import-by-key failed on 93 of 171 keys in the pilot ("could not be found") because the
library is not published to this file, while `mainComponent` resolved 100% and returns a fully
traversable subtree from the hidden `Internal Only Canvas` page.
**Rejected:** import-by-key (54% failure); detaching instances (visual fidelity only, destroys the
design system); requiring the library file up front (blocks the pilot).
**Revisit if:** we migrate the Sova library file itself, where components are local and by-key
import becomes both available and more correct.

## 2026-09-03 — Do not attempt to write a .fig file

**Decision:** the injection path into Figma is a Figma plugin using the Plugin API.
**Because:** Figma's REST API is read-only for design content, and `.fig` is an undocumented
self-describing kiwi binary (ZIP + zlib + zstd, 534+ types). Pixso reads `.fig` but cannot write it.
**Rejected:** generating `.fig` directly (reverse-engineering project, breaks on Figma updates,
grey-zone ToS); REST API writes (structurally impossible); reversing Pixso's Figma importer (one-way).
**Revisit if:** Figma ships a documented write API for design content.

## 2026-09-03 — No Figma plugin; re-link to the existing library instead of rebuilding it

**Decision:** write into Figma through the `use_figma` MCP tool, and rebuild consumer files by
creating instances of the **already-migrated** Sova library components rather than recreating
component definitions from the Pixso export.
**Because:** `use_figma` executes Plugin API JavaScript directly, so the plugin + localhost relay
that was planned is unnecessary. The Sova DS is already published in Figma as three libraries, and
`importComponentSetByKeyAsync` + `createInstance()` was verified to work against it. Recreating
components would produce N duplicate design systems instead of one linked library.
**Rejected:** building a dev plugin (unnecessary work); reconstructing the used component subset
per file (duplicates the DS, breaks library updates); matching by key (Pixso keys do not resolve
in Figma — tested, all four FAIL).
**Revisit if:** a Pixso component turns out to have no counterpart in the Figma library, in which
case that specific component gets rebuilt from the IR and flagged in the fidelity ledger.

# State

## Now

- **Task:** Pixso -> Figma migration, 1:1, whole files.
- **Status: the whole open file migrates**, both pages, 87 401 source nodes.

  ```
  node tools/px-pages.mjs ../out/pages.json          # what pages exist
  PX_EXTRACT_ONLY=1 node tools/migrate.mjs <id> <dir>   # per top-level object, Pixso only
  PX_PLACE_ABS=1 node tools/build-all.mjs --pages ../out/pages.json <dir> [<dir> ...]
  ```

  Extraction needs Pixso desktop with its MCP on `127.0.0.1:3667`. Building needs the
  `pix-to-fig runner` plugin open in the target Figma file — and only the plugin, because the MCP
  channel cannot see locally installed fonts at all.

## Last clean run

| object | nodes | misplaced | worst | sizes off | max size |
|---|---|---|---|---|---|
| Обложка (page) | 33/33 | 0 | 0 | 0 | 0 |
| divider | 2/2 | 0 | 0 | 0 | 0 |
| Яга Статьи | 1486/1486 | 28 | 0.5 | 1 | 4 |
| Стрелка | 5997/5997 | 5 | 0.5 | 0 | 0.01 |
| Диво Сервис | 5834/5834 | 3 | 1 | 0 | 0.01 |
| Диво Бот | 17482/17482 | 36 | 1 | 4 | 4 |   *(rebuilt with Hack present: fonts clean, geometry identical)*
| Диво Мера | 18719/18719 | 164 | 2.83 | 4 | 2 |
| Яга | 36995/36995 | 418 | 0.5 | 0 | 0.01 |

Every node count exact. Worst positional error anywhere: 2.83 px. Pixel comparison of the pilot
section against the Pixso render: 67% of pixels identical, 31% differing by 1–15 levels out of 255,
**0.00% differing by more than 191** — nothing is drawn on one side and not the other.

Fonts resolve through the plugin with **no substitutions at all**, once every family is installed
and Figma has been restarted so it rescans them — it does that only at startup.

## What is left, and what each is

- **Half-pixel SVG wrappers** — the bulk of the remaining count. Below visual significance.
- **INSIDE stroke content box** — Figma insets both the size and the origin of an auto-layout
  frame's content box by the stroke; Pixso does not. Shows as 1–2.83 px.
- **`layoutAlign: STRETCH` against an axis that cannot stretch** — Pixso centres, Figma pins. 2 px.
- **Text rasterisation and gradient interpolation** — not defects, not fixable.
- One diagnosed but unexplained case: placeholder text Figma draws where Pixso draws nothing.

## Read this before touching anything

`docs/METHOD.md` is the method. `docs/FINDINGS.md` is every defect with the evidence that found
it. Two things in there matter more than the rest:

1. **A repair pass must measure with the acceptance test's rule, re-read before acting, undo what
   did not help — and look at what else moved.** Every one of those clauses was paid for. The last
   one cost a 223 px error made out of a 2 px one.
2. **Do not verify with `page.children`.** Figma loads pages lazily and an unloaded page reads as
   empty, which looked exactly like two migrated objects vanishing. `getNodeByIdAsync` is
   authoritative.

## Direction (set by owner)

Transfer 1:1 first; relink to the Figma libraries by hand afterwards. Missing fonts are
acceptable, lost content is not. No hand-patching of layouts: everything is a rule in code that
runs without a model. The end state is migrating every file of the team this way.

## Checkpoint

- **Updated:** 2026-09-07
- **Verified by:** in-sandbox verifier per section, plus a 1:1 pixel comparison with magnitude
  distribution rather than a block count.

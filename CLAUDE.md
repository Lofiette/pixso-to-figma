# pix-to-fig

<!-- PRODUCT-OS BEGIN (managed by po.ps1) -->
## Product OS

Working state for this project lives in `.product-os/`. Read `STATE.md` at the start of a
session; read `KNOWLEDGE.md` and `DECISIONS.md` only when the task touches durable product
behaviour. Never load the whole tree speculatively.

@.product-os/STATE.md

### Working invariants

- Do not invent facts, approvals, evidence, measurements, or subagent results. Missing evidence
  is reported as missing, never upgraded to PASS.
- Do not silently broaden scope. If the work grows past what was agreed, say so and re-agree.
- Build success is not product success. Tests passing, a clean typecheck, and a rendered screen
  are not proof that the behaviour is right for the user.
- Separate confirmed, inferred, and assumed. Label which is which in any claim that will outlive
  this session.
- Read only what can change the next decision. Stop discovery when the plan is trustworthy, not
  when the repository is exhausted.
- Before ending a work session, or before a compaction you can anticipate, update `STATE.md` so
  the next session can resume without re-deriving context.
- A durable decision goes in `DECISIONS.md` with its rejected alternatives. A durable fact about
  the product goes in `KNOWLEDGE.md` with its evidence and confidence.

### Method skills

Installed packs expose `cpt-*` skills. Use the smallest set that changes a decision or an
artifact. Selecting a skill is not ceremony: if it would not change the output, skip it.

- Unclear outcome, users, or scope -> `cpt-product-scope`
- Non-trivial multi-file work -> `cpt-task-planning` (produce an Impact Map before writing)
- Any interface work -> `cpt-design-recon` first, then the relevant design skill
- Reviewing rendered UI -> `cpt-visual-acceptance-review`
- Shipping something with user data, auth, or external exposure -> `cpt-cross-cutting-risk`

Skill reference files are loaded on demand. Open the one section you need, not the catalogue.
<!-- PRODUCT-OS END -->

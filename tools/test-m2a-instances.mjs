// Part C's tests: the resolver, overrides and derived entries (docs/M2A.md D7-D11, D17, §6 C).
//
//   node tools/test-m2a-instances.mjs
//
// STUB written by part P0 (docs/M2A.md §5.5): it prints "pending: part C" and exits 2 while
// tools/pix/ir/resolve.mjs, overrides.mjs and derived.mjs are P0's stubs, and FAILS (exit 1) once
// part C's code is in (any of them without its STUB) and this file has not been replaced. Part C
// replaces this file; it owns it (§9).
//
// THE CONTRACT this test must hold, on the synthetic fixture (tools/pix/fixture.mjs, M2A ids) only:
//   - every fixture path, swap and entry case as its comment states, and each rule switched off once
//     failing exactly its case: --swap-dangling strict (Chip assigned's icon path then resolves only
//     through rule C), --swap-reset off (Rule B's [5:421, 5:403, 5:310]), --swap-fallback off (Rule C's
//     [5:421, 5:402, 5:310]); the overrideKey-only hop stays stale;
//   - `at` indices; echo through a nested master's override (Echo nested); a field never echoed
//     against the wrong (pre-swap) master (Rule B's red Bg); a bound field's baseline is the
//     property's effective value (Entries' title: boundConflicts); a no-op swap kept (swaps.noOp);
//     root box fields never in the path [] override (Entries: root-box or echo by --override-merge);
//     a nested INSTANCE target's fill and style carried; not-on-type, layer-not-carried and
//     no-equivalent drops; the "unknown" drop failing G6 on the planted fault
//     (M2A_PLANTS.unknownOverrideField); rule C's ignored assignment absent from the IR; each merge
//     rule (last, first, outer) on Entries' Bg fills; refused fields kept and classed; each
//     --derived-geometry value; --instance-own own (Text styles' own fill); sparse and empty derived
//     entries (Entries), oracleSides and lines, no derived data (No derived), scale (Scaled), exposed
//     (Row's Trail); byte-identical IR twice;
//   - the census and OVERRIDE_SOURCE_FIELDS list the same fields (also tools/test-m2a-contract.mjs);
//   - stats.m2a.instances, .overrides and .derived as frozen in tools/pix/ir/index.mjs (newM2aStats)
//     and overrides.mjs's header, with G6's balances holding.
// The nested-assignment and echo checks that need part B print "pending: B" until B merges.
// DONE WHEN (docs/M2A.md §6 C) this test passes and on D, K, M and P: derived 35 808 / 35 808,
// 160 982 / 160 982, 86 941 / 86 941, 342 679 / 342 679 with 36 via rule C; live / stale 6 353 / 726,
// 42 456 / 950, 52 982 / 949, 107 190 / 6 563 with resolvedNotDerived and inDerivedUnresolved 0; no
// unknown field; root size all echo or root-box; the balances of §8 add up; and the measurements of
// §6 C recorded in the pull request.
import { stub } from "./test/m2a-stub.mjs";
import * as resolve from "./pix/ir/resolve.mjs";
import * as overrides from "./pix/ir/overrides.mjs";
import * as derived from "./pix/ir/derived.mjs";

const landed = [resolve, overrides, derived].some((m) => m.STUB === undefined);
stub({ part: "C", file: "tools/test-m2a-instances.mjs", landed, evidence: "resolve.mjs, overrides.mjs or derived.mjs exports no STUB" });

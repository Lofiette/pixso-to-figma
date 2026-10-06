// Derived entries: Pixso's resolved boxes of an instance's sublayers, as the IR carries them
// (docs/M2A.md D10, §6 C). Part C owns this file; part P0 wrote it as a stub. Its only caller is
// overrides.mjs instanceData, so its signature is part C's to change.
//
//   import { derivedEntries } from "./derived.mjs";
//   derivedEntries(cx, n, i, ctx) -> [{ path, at?, size?, transform?, fillGeometry?, strokeGeometry?, lines?, oracleSides? }]
//
// What part C writes (docs/M2A.md D10, docs/IR.md §9): every derivedSymbolData entry of the stored
// INSTANCE n (record i) that resolves (resolve.mjs, rules A-C), sparse as stored: size and transform
// only when stored, lines from the entry's baselines, oracleSides from its strokePaddingPath (M1 D15's
// oracle), and geometry under --derived-geometry (changed: only where it differs from the target
// layer's own); `at` where every element has a record. An entry with nothing to write is not written
// and is counted (cx.m2a.derived.empty), so entries = written + empty (gate G1). ctx is part C's.
//
// STUB (part P0): no entry, as M1 writes none. tools/test-m2a-instances.mjs fails until part C
// replaces this.
export const STUB = "pending: part C";

export function derivedEntries(cx, n, i, ctx) {
  return [];
}

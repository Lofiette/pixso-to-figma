// The populations of docs/M1.md D1, §1.3 and §8.2, as lists of IR record indices, ascending.
//
// Five of them partition the IR: each lists root records, and a root's population covers its subtree
// down to, not including, any record that is itself a root of a population:
//   userTop                       the top-level records of user pages (S1)
//   mastersNoInstance             internal-canvas COMPONENT records with no INSTANCE record below (S2)
//   mastersWithInstanceInternal   internal-canvas COMPONENT records with an INSTANCE record below
//   stateGroupsInternal           internal-canvas state-group records: an accepted set's COMPONENT_SET
//                                 record or a rejected group's FRAME (docs/M2A.md D2, D13; under
//                                 --variant-sets frames every group is a FRAME, as in M1). Their masters
//                                 are roots of the two populations above, so the population is the
//                                 group's record alone
//   internalLoose                 the other internal-canvas records: the topmost record of each run
//                                 that is in no master and is no state group
// Two cut across them, record by record:
//   userMasters                   COMPONENT records on user pages (inside S1)
//   lostBorder                    non-instance FRAME, COMPONENT and RECTANGLE records with a visible
//                                 stroke of weight above 0 and no border*Weight field (§0.5; SECTIONs,
//                                 which Figma draws without strokes, are counted apart in the stats)
// A state group is told by meta.stateGroup, which the seam (nodes.mjs emit) sets for a stored FRAME with
// isStateGroup whatever its record type, and by the type COMPONENT_SET itself; a COMPONENT_SET is never a
// master (only COMPONENT records are), so the populations do not depend on --variant-sets (D13).
// counts(ir, pops) gives, per partition population, its records split into non-instance and INSTANCE.
export function populations(recs, meta, pages) {
  const P = { userTop: [], userMasters: [], mastersNoInstance: [], mastersWithInstanceInternal: [], internalLoose: [],
    stateGroupsInternal: [], lostBorder: [] };
  // Whether an INSTANCE record sits below each record: records are parent-first, so one pass from
  // the end carries it up.
  const below = new Array(recs.length).fill(false);
  for (let i = recs.length - 1; i >= 0; i--) {
    const p = recs[i].parent;
    if (p >= 0 && (below[i] || recs[i].type === "INSTANCE")) below[p] = true;
  }
  const pageOf = new Array(recs.length);
  const inMaster = new Array(recs.length).fill(false);
  const loose = new Array(recs.length).fill(false);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    pageOf[i] = r.parent === -1 ? r.page : pageOf[r.parent];
    const internal = pages[pageOf[i]].internal;
    const isMaster = r.type === "COMPONENT";
    inMaster[i] = isMaster || (r.parent >= 0 && inMaster[r.parent]);
    if (!internal) {
      if (r.parent === -1) P.userTop.push(i);
      if (isMaster) P.userMasters.push(i);
    } else if (isMaster) {
      // A master inside a master would belong to the outer one; none is measured (0 / 0 / 0).
      if (!(r.parent >= 0 && inMaster[r.parent])) (below[i] ? P.mastersWithInstanceInternal : P.mastersNoInstance).push(i);
    } else if ((meta[i].stateGroup || r.type === "COMPONENT_SET") && !(r.parent >= 0 && inMaster[r.parent])) {
      P.stateGroupsInternal.push(i);
    } else if (!inMaster[i]) {
      loose[i] = true;
      if (!(r.parent >= 0 && loose[r.parent])) P.internalLoose.push(i);
    }
    if (meta[i].lostBorder) P.lostBorder.push(i);
  }
  return P;
}

export const PARTITION = ["userTop", "mastersNoInstance", "mastersWithInstanceInternal", "stateGroupsInternal", "internalLoose"];

// Records per partition population: { name: { records, nonInstance, instances } }, each record counted
// once, in the population of its nearest root.
export function populationCounts(recs, P) {
  const rootOf = new Map();
  for (const name of PARTITION) for (const i of P[name]) rootOf.set(i, name);
  const out = {};
  for (const name of PARTITION) out[name] = { records: 0, nonInstance: 0, instances: 0 };
  const owner = new Array(recs.length);
  for (let i = 0; i < recs.length; i++) {
    owner[i] = rootOf.has(i) ? rootOf.get(i) : recs[i].parent >= 0 ? owner[recs[i].parent] : null;
    if (!owner[i]) continue;
    const c = out[owner[i]];
    c.records++;
    if (recs[i].type === "INSTANCE") c.instances++; else c.nonInstance++;
  }
  return out;
}

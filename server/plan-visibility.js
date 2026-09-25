// What a client sees: every Verified plan of every proposal slot Kennion has
// left ON for the group.
//
// The carrier's proposal is the source of truth. If it quotes 100 medical
// plans, all 100 are stored, audited and shown - EPO, narrow-network
// (LocalPlus), HMO, POS, any deductible or rate. Those are plan attributes
// the client filters and sorts on in the grid, never reasons to remove a
// quoted option. The one normal control is the proposal slot, per group:
// ON shows every Verified plan in it, OFF shows none (server/index.js,
// slotEnabled / clientAvailablePlans). Turning a slot OFF is a presentation
// decision only; its plans stay stored, validated and dual-audited.
//
// Plan-level exceptions are kept technically possible - an advanced rule
// added here hides a plan and says why - but there are none, and none should
// be added as a normal workflow.

/** Advanced, per-plan exceptions: { key, reason, hides(plan, group) }. None by default. */
export const VISIBILITY_RULES = [];

/** Why a plan is hidden from the client by an advanced exception, or null (always, today). */
export function hiddenReason(pl, group) {
  for (const r of VISIBILITY_RULES) if (r.hides(pl, group)) return r.reason;
  return null;
}

/** The plans of an ON slot a client is shown: all of them, unless an advanced exception exists. */
export const clientPlans = (plans, group) => (plans || []).filter((pl) => !hiddenReason(pl, group));

// What a client sees, decided separately from what is stored.
//
// Every unique plan on a carrier's proposal is loaded into Postgres and
// audited - all of them. Which of those a group's client is shown is a
// separate, explicit decision made here, when the grid, the plan cards and
// the AI Assistant are served. Hidden plans stay in the database, keep their
// BenSync IDs, and are audited like any other; they are just not offered.
//
// Today there is one rule: Kennion offers PPO plans only, so EPO plans are
// hidden from every group. This is the one place to extend when Kennion wants
// to show or hide specific plans for a group (a per-group list of BenSync IDs
// to show or hide, say) - nothing else in the app filters plans for clients.

import { isEpoPlan } from "./plan-canonical.js";

/** The rules, in order; the first that matches hides the plan and says why. */
export const VISIBILITY_RULES = [{ key: "epo", reason: "EPO - Kennion offers PPO plans only", hides: (pl) => isEpoPlan(pl) }];

/** Why a plan is hidden from the client, or null when it is shown. */
export function hiddenReason(pl /*, group */) {
  for (const r of VISIBILITY_RULES) if (r.hides(pl)) return r.reason;
  return null;
}

/** The plans a client is shown. */
export const clientPlans = (plans, group) => (plans || []).filter((pl) => !hiddenReason(pl, group));

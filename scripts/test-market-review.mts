// What's New for 2027 on the Welcome page: how many priced options a group
// has and whether the market review is complete (every proposal slot the
// group goes to market in holds a priced plan) or still in progress. Runs
// with `node scripts/test-market-review.mts`.
import assert from "node:assert/strict";
import { marketReview, PROPOSAL_SLOTS, type Group, type KennionData } from "../client/src/lib/model.ts";

const g = { name: "Test Group", n: 10, members: [], plans: [] } as unknown as Group;
const plan = (name: string, EE: number | null) => ({
  name,
  plan_code: name,
  network: "Choice Plus",
  plan_type: "PPO",
  deductible: "$4,000",
  oop_max: "$8,150",
  benefits: {},
  rates: { EE, ES: EE == null ? null : EE * 2, EC: EE == null ? null : EE * 1.8, FAM: EE == null ? null : EE * 3 },
});
let id = 0;
const proposal = (slot: string, carrier: string, plans: ReturnType<typeof plan>[]) => ({
  id: ++id,
  slot,
  carrier,
  funding: "level funded",
  effectiveDate: "2027-01-01",
  proposalType: "renewal",
  enrolledOnDocument: 10,
  plans,
  totalMonthly: null,
  summary: null,
  filename: `${slot}.pdf`,
  uploadedAt: "2026-09-01T00:00:00.000Z",
});
const data = (proposals: ReturnType<typeof proposal>[], slots?: string[]) =>
  ({ groups: [g], proposals, slots, uhc: { plans: [], mapping: [] } }) as unknown as KennionData;

// 1. Nothing quoted yet: zero options, in progress.
{
  const r = marketReview(data([]), g);
  assert.equal(r.options, 0);
  assert.equal(r.complete, false);
  assert.equal(r.slotsExpected, PROPOSAL_SLOTS.length);
}

// 2. Two of five slots quoted: the options count, but the review is still in progress.
{
  const r = marketReview(data([proposal("UHC Fully Insured", "UnitedHealthcare", [plan("A", 700), plan("B", 650)]), proposal("Gravie", "Gravie", [plan("G", 600)])]), g);
  assert.equal(r.options, 3);
  assert.equal(r.slotsQuoted, 2);
  assert.equal(r.complete, false);
}

// 3. Every slot the group has quoted: complete. The group's own slot list, not the program's, is what counts.
{
  const slots = ["UHC Fully Insured", "Gravie"];
  const r = marketReview(data([proposal("UHC Fully Insured", "UnitedHealthcare", [plan("A", 700)]), proposal("Gravie", "Gravie", [plan("G", 600)])], slots), g);
  assert.equal(r.slotsExpected, 2);
  assert.equal(r.complete, true);
}

// 4. A slot whose plans carry no rates does not count as quoted.
{
  const slots = ["UHC Fully Insured", "Gravie"];
  const r = marketReview(data([proposal("UHC Fully Insured", "UnitedHealthcare", [plan("A", 700)]), proposal("Gravie", "Gravie", [plan("G", null)])], slots), g);
  assert.equal(r.options, 1);
  assert.equal(r.complete, false);
}

// 5. Cobalt is never expected, even when listed.
{
  const slots = ["UHC Fully Insured", "Cobalt"];
  const r = marketReview(data([proposal("UHC Fully Insured", "UnitedHealthcare", [plan("A", 700)])], slots), g);
  assert.equal(r.slotsExpected, 1);
  assert.equal(r.complete, true);
}

console.log("market review: all assertions passed");

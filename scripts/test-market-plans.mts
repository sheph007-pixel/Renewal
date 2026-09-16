// 2027 options from proposals: plans read off a group's proposals are priced
// at its census, come first, and replace the carrier placeholders and any menu
// plan they also price. Runs with `node --experimental-strip-types`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { marketPlans, proposalPlans, moneyNum, costSplit, tierSplit, splitCopays, networkTypeOf, networkDirectory, networkLabel, CIGNA_DIRECTORY, contributionFloor, minimumContribution, type KennionData, type Group, type GroupProposal } from "../client/src/lib/model.ts";

const seed = JSON.parse(readFileSync(new URL("../server/data/kennion.json", import.meta.url), "utf8"));
const g0 = seed.groups.find((x: Group) => x.name === "Aesto Health") as Group;
const g = { ...g0, code: "AESTO" } as Group;
const base = { ...seed, groups: [g], proposals: [], funding: null } as KennionData;

const before = marketPlans(base, g);
assert.equal(before.length, 0, "no proposals, no options: the seed's menu quotes are not proposals and are not shown");

const proposals: GroupProposal[] = [
  {
    id: 7,
    slot: "Gravie",
    carrier: "Gravie",
    funding: "level funded",
    effectiveDate: "2027-01-01",
    proposalType: "new business",
    enrolledOnDocument: 39,
    plans: [
      { name: "Gravie Comfort 1500", planType: "Level Funded", deductible: "$1,500", oopMax: "$4,000", rates: { EE: 600, ES: 1200, EC: 1110, FAM: 1710 }, monthlyTotal: null },
      { name: "Gravie Comfort 3000", planType: "Level Funded", deductible: "$3,000", oopMax: "$6,000", rates: { EE: 520, ES: null, EC: null, FAM: null }, monthlyTotal: null },
      { name: "Unpriced", planType: null, deductible: null, oopMax: null, rates: { EE: null, ES: null, EC: null, FAM: null }, monthlyTotal: null },
    ],
    totalMonthly: null,
    summary: "Two Comfort plans.",
    filename: "gravie.pdf",
    uploadedAt: "2026-09-01T12:00:00Z",
  },
  {
    id: 8,
    slot: "UHC Level Funded",
    carrier: "UnitedHealthcare",
    funding: "level funded",
    effectiveDate: null,
    proposalType: "renewal",
    enrolledOnDocument: 39,
    plans: [{ name: "P4000i8021B", planType: "PPO", deductible: "1000", oopMax: "5000", rates: { EE: 700, ES: 1400, EC: 1295, FAM: 1995 }, monthlyTotal: null }],
    totalMonthly: null,
    summary: null,
    filename: "uhc.pdf",
    uploadedAt: "2026-09-02T12:00:00Z",
  },
  {
    id: 9,
    slot: "Angle",
    carrier: "Angle Health",
    funding: "level funded",
    effectiveDate: "2027-01-01",
    proposalType: "new business",
    enrolledOnDocument: 39,
    // Angle's quote names its design family as the plan type and the network as bare "Cigna".
    plans: [{ name: "Angle Traditional 2000", planType: "Traditional", network: "Cigna", deductible: "$2,000", oopMax: "$5,000", rates: { EE: 610, ES: 1220, EC: 1130, FAM: 1740 }, monthlyTotal: null }],
    totalMonthly: null,
    summary: null,
    filename: "angle.pdf",
    uploadedAt: "2026-09-16T12:00:00Z",
  },
];
const data = { ...base, proposals } as KennionData;

const counts = { EE: 0, ES: 0, EC: 0, FAM: 0 } as Record<string, number>;
for (const m of g.members || []) {
  const t = m.tier.startsWith("Employee + Spouse") ? "ES" : m.tier.startsWith("Employee + Child") ? "EC" : m.tier.startsWith("Employee + Family") ? "FAM" : m.tier === "Employee" ? "EE" : "";
  if (t) counts[t]++;
}
const pp = proposalPlans(data, g);
// Comfort 3000 is priced for Employee Only alone: with people in any other
// tier it cannot be priced for the group, so it is not shown.
const partial = counts.ES + counts.EC + counts.FAM > 0;
assert.equal(pp.length, partial ? 3 : 4, "a plan with no rate on any tier is left out; so is one missing a tier people are in");
const comfort = pp.find((p) => p.plan === "Gravie Comfort 1500")!;
assert.equal(comfort.carrier, "Gravie");
assert.equal(comfort.label, "Level Funded");
assert.equal(comfort.ded, 1500);
assert.equal(comfort.oop, 4000);
assert.deepEqual(comfort.quoted, { slot: "Gravie", date: "2027-01-01", proposalId: 7, audit: null });
assert.equal(comfort.monthly, 600 * counts.EE + 1200 * counts.ES + 1110 * counts.EC + 1710 * counts.FAM, "priced at the census");
assert.equal(!!pp.find((p) => p.plan === "Gravie Comfort 3000"), !partial, "a tier with people but no rate: the plan is not shown at all");
const uhc = pp.find((p) => p.carrier === "UnitedHealthcare")!;
assert.equal(uhc.quoted!.date, "2026-09-02", "no effective date on the paper: the upload date");

// Funding is Fully Insured or Level Funded, nothing else; the design family is the type.
const angle = pp.find((p) => p.carrier === "Angle Health")!;
assert.equal(angle.label, "Level Funded", "Angle Health is level funded; 'Traditional' is not a funding");
assert.equal(angle.type, "Traditional");
// Gravie and Angle Health are the same Cigna network, with the same lookup.
assert.equal(angle.network, "Cigna");
assert.equal(comfort.network, "Cigna");
assert.equal(networkTypeOf(angle), "PPO", "a bare 'Cigna' network is a PPO");
assert.equal(networkTypeOf(comfort), "PPO");
assert.equal(networkDirectory(angle.network)!.url, CIGNA_DIRECTORY);
assert.equal(networkDirectory(comfort.network)!.url, CIGNA_DIRECTORY);
assert.equal(networkLabel("Cigna Open Access Plus (PPO)"), "Cigna");
assert.equal(networkLabel("Angle / Cigna PPO"), "Cigna");
assert.equal(networkLabel("United Choice Plus"), "United Choice Plus");

const after = marketPlans(data, g);
assert.deepEqual(after.map((p) => p.plan), pp.map((p) => p.plan), "the grid is the proposals' plans and nothing else");
assert.ok(after.every((p) => p.monthly != null && p.quoted), "every row is priced at the group's whole census and read off a proposal");
assert.equal(after.find((p) => p.plan === uhc.plan)!.rates.EE, 700);

// Benefits: a Gravie plan carries its family's benefits.
assert.match(comfort.copays, /No cost \/ No cost/, "a Gravie Comfort plan gets the Comfort family's PCP / specialist");
assert.equal(comfort.er, "$500 copay");
assert.equal(comfort.hospital, "No cost after OOPM");
assert.match(comfort.rx, /generic/);

// Flat-dollar defined contribution: the employer pays the same per tier on every plan; the employee pays the rest.
const contrib = { EE: 500, ES: 2000, EC: 0, FAM: 1000 };
assert.deepEqual(tierSplit(comfort, contrib, "EE"), { rate: 600, er: 500, ee: 100 });
assert.deepEqual(tierSplit(comfort, contrib, "ES"), { rate: 1200, er: 1200, ee: 0 }, "a contribution above the premium: the employer pays the premium, never more");
assert.deepEqual(tierSplit(comfort, contrib, "EC"), { rate: 1110, er: 0, ee: 1110 });
const cs = costSplit(comfort, contrib, counts as Record<"EE" | "ES" | "EC" | "FAM", number>)!;
assert.equal(cs.total, comfort.monthly);
assert.equal(cs.er, +(500 * counts.EE + 1200 * counts.ES + 0 * counts.EC + 1000 * counts.FAM).toFixed(2), "contribution × enrolled, whatever the plan");
assert.equal(cs.ee, +(100 * counts.EE + 0 * counts.ES + 1110 * counts.EC + Math.max(0, 1710 - 1000) * counts.FAM).toFixed(2));
const flat = { EE: 100, ES: 100, EC: 100, FAM: 100 };
const c3000 = { ...comfort, plan: "Gravie Comfort 3000", rates: { EE: 520, ES: null, EC: null, FAM: null }, monthly: null };
const c3 = costSplit(c3000, flat, { EE: 5, ES: 0, EC: 0, FAM: 0 })!;
assert.equal(c3.er, 500, "the same employer figure on a different plan");
assert.equal(costSplit(c3000, contrib, { EE: 0, ES: 0, EC: 0, FAM: 0 }), null, "nobody enrolled: no split");
assert.equal(costSplit(c3000, flat, { EE: 5, ES: 1, EC: 0, FAM: 0 }), null, "a tier with people but no rate: no split at all, never a partial one");

assert.equal(moneyNum("$1,500 individual / $3,000 family"), 1500);
assert.equal(moneyNum("n/a"), null);
assert.equal(moneyNum(250), 250);

console.log("market-plans: all assertions passed", { withProposals: after.length, census: counts });

// Doctor visit / specialist split out of a menu copay string, for the card's fixed rows.
assert.deepEqual(splitCopays("$40 / $100"), ["$40", "$100"]);
assert.deepEqual(splitCopays("On the proposal"), [null, null]);
assert.equal(comfort.pcp, "No cost", "a Gravie Comfort plan carries its doctor-visit cost");

// Where the contribution starts: half the lowest employee-only rate, on every tier.
const cheapestEE = Math.min(...pp.map((p) => p.rates.EE as number));
assert.equal(contributionFloor(pp), Math.ceil(cheapestEE * 0.5));
assert.deepEqual(minimumContribution(pp), { EE: contributionFloor(pp), ES: contributionFloor(pp), EC: contributionFloor(pp), FAM: contributionFloor(pp) });

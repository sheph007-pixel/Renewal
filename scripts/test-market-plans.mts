// 2027 options from proposals: plans read off a group's proposals are priced
// at its census, come first, and replace the carrier placeholders and any menu
// plan they also price. Runs with `node --experimental-strip-types`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { marketPlans, proposalPlans, moneyNum, costSplit, tierSplit, type KennionData, type Group, type GroupProposal } from "../client/src/lib/model.ts";

const seed = JSON.parse(readFileSync(new URL("../server/data/kennion.json", import.meta.url), "utf8"));
const g0 = seed.groups.find((x: Group) => x.name === "Aesto Health") as Group;
const g = { ...g0, code: "AESTO" } as Group;
const base = { ...seed, groups: [g], proposals: [], funding: null } as KennionData;

const before = marketPlans(base, g);
assert.ok(before.some((p) => p.carrier === "Gravie" && p.pending), "Gravie is a placeholder until it quotes");
const menuCount = before.length;

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
    plans: [{ name: before.find((p) => p.carrier === "UnitedHealthcare")!.plan, planType: "PPO", deductible: "1000", oopMax: "5000", rates: { EE: 700, ES: 1400, EC: 1295, FAM: 1995 }, monthlyTotal: null }],
    totalMonthly: null,
    summary: null,
    filename: "uhc.pdf",
    uploadedAt: "2026-09-02T12:00:00Z",
  },
];
const data = { ...base, proposals } as KennionData;

const pp = proposalPlans(data, g);
assert.equal(pp.length, 3, "a plan with no rate on any tier is left out");
const comfort = pp.find((p) => p.plan === "Gravie Comfort 1500")!;
assert.equal(comfort.carrier, "Gravie");
assert.equal(comfort.label, "Level Funded");
assert.equal(comfort.ded, 1500);
assert.equal(comfort.oop, 4000);
assert.deepEqual(comfort.quoted, { slot: "Gravie", date: "2027-01-01", proposalId: 7 });
const counts = { EE: 0, ES: 0, EC: 0, FAM: 0 } as Record<string, number>;
for (const m of g.members || []) {
  const t = m.tier.startsWith("Employee + Spouse") ? "ES" : m.tier.startsWith("Employee + Child") ? "EC" : m.tier.startsWith("Employee + Family") ? "FAM" : m.tier === "Employee" ? "EE" : "";
  if (t) counts[t]++;
}
assert.equal(comfort.monthly, 600 * counts.EE + 1200 * counts.ES + 1110 * counts.EC + 1710 * counts.FAM, "priced at the census");
const c3000 = pp.find((p) => p.plan === "Gravie Comfort 3000")!;
assert.equal(c3000.monthly, counts.ES + counts.EC + counts.FAM > 0 ? null : 520 * counts.EE, "a tier with people but no rate leaves no monthly figure");
const uhc = pp.find((p) => p.carrier === "UnitedHealthcare")!;
assert.equal(uhc.quoted!.date, "2026-09-02", "no effective date on the paper: the upload date");

const after = marketPlans(data, g);
assert.deepEqual(after.slice(0, 3).map((p) => p.plan), pp.map((p) => p.plan), "proposal plans come first");
assert.ok(!after.some((p) => p.carrier === "Gravie" && p.pending), "the Gravie placeholder is gone");
assert.equal(after.filter((p) => p.plan === uhc.plan).length, 1, "the menu copy of a plan the proposal prices is replaced");
assert.equal(after.find((p) => p.plan === uhc.plan)!.rates.EE, 700);
assert.equal(after.length, menuCount + 3 - 2, "three quoted rows in, the Gravie placeholder and one menu duplicate out");

// Benefits: a Gravie plan carries its family's benefits; a UHC menu plan its coinsurance, urgent care and ER.
assert.match(comfort.copays, /No cost \/ No cost/, "a Gravie Comfort plan gets the Comfort family's PCP / specialist");
assert.equal(comfort.er, "$500 copay");
assert.equal(comfort.hospital, "No cost after OOPM");
assert.match(comfort.rx, /generic/);
const menuPlan = before.find((p) => p.carrier === "UnitedHealthcare" && !p.quoted)!;
assert.ok(menuPlan.coins && menuPlan.uc && menuPlan.er, "UHC menu plans carry coinsurance, urgent care and ER");

// Employer contribution: each tier pays the lower of the contribution and the rate; totals follow the census.
const contrib = { EE: 500, ES: 2000, EC: 0, FAM: 1000 };
assert.deepEqual(tierSplit(comfort, contrib, "EE"), { rate: 600, er: 500, ee: 100 });
assert.deepEqual(tierSplit(comfort, contrib, "ES"), { rate: 1200, er: 1200, ee: 0 }, "a contribution above the premium pays the premium, no more");
assert.deepEqual(tierSplit(comfort, contrib, "EC"), { rate: 1110, er: 0, ee: 1110 });
const cs = costSplit(comfort, contrib, counts as Record<"EE" | "ES" | "EC" | "FAM", number>)!;
assert.equal(cs.total, comfort.monthly);
assert.equal(cs.er, +(500 * counts.EE + 1200 * counts.ES + 0 * counts.EC + 1000 * counts.FAM).toFixed(2));
assert.equal(+(cs.er + cs.ee).toFixed(2), cs.total);
assert.equal(costSplit(pp.find((p) => p.plan === "Gravie Comfort 3000")!, contrib, { EE: 0, ES: 0, EC: 0, FAM: 0 }), null, "nobody enrolled: no split");

assert.equal(moneyNum("$1,500 individual / $3,000 family"), 1500);
assert.equal(moneyNum("n/a"), null);
assert.equal(moneyNum(250), 250);

console.log("market-plans: all assertions passed", { menu: menuCount, withProposals: after.length, census: counts });

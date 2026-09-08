// The file a group exports from their own page: rates, and what the employer
// and the employees each pay.
//
// The split is the reason this file exists, and it is the thing most easily
// got wrong: where Employee Navigator carries the configured payroll
// contribution it is a fact, and everywhere else it is a model. Both branches
// are checked against the same group, with and without its split, so the
// wording and the arithmetic are held to each case. Runs with `npx tsx`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { planRowsFor, tierRowsFor, splitNote, COLUMNS, DETAIL_COLUMNS, ENROLL_URL } from "../client/src/lib/plansheet.ts";
import {
  hasActualSplit,
  planRows,
  type Group,
  type KennionData,
  type Overrides,
} from "../client/src/lib/model.ts";

const PORT = 5087;
const CODE = "test-only-code-not-in-repo";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, DATABASE_URL: "", KENNION_FAKE_AI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
process.on("exit", () => server.kill());

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

// Sign in as a group, so this runs on exactly the payload a client receives.
const admin = await (
  await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }),
  })
).json();
const target = admin.groups.find((x: Group) => (x.plans || []).length > 1)!;
const payload = await (
  await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: target.code }),
  })
).json();

const g: Group = payload.group;
const data = {
  meta: payload.meta,
  groups: [g],
  planDesigns: payload.planDesigns,
  uhc: payload.uhc,
  splits: payload.splits || {},
  funding: payload.funding,
} as unknown as KennionData;
const overrides: Overrides = payload.overrides || {};
const EE_PCT = 80;
const DEP_PCT = 32;
const rows = planRows(data, overrides, g, EE_PCT, DEP_PCT);
assert.ok(rows.length > 1, "a group with more than one plan");

const plans = planRowsFor(data, overrides, g, rows, EE_PCT, DEP_PCT);
const tiers = tierRowsFor(data, overrides, g, rows, EE_PCT, DEP_PCT);

const ER = COLUMNS.length - 3;
const EE = COLUMNS.length - 2;
const TOTAL = COLUMNS.length - 1;

// 1. The columns answer the three questions a client asks: what do we have,
//    what are the rates, and who pays what.
assert.deepEqual(COLUMNS, [
  "Plan",
  "Enrolled",
  "Employee",
  "Employee + Child(ren)",
  "Employee + Spouse",
  "Employee + Family",
  "Employer / Month",
  "Employee / Month",
  "Monthly Premium",
]);

// 2. Employer plus employee is the premium, on every plan. If these two ever
//    drift apart the file is worse than useless — an employer would budget off
//    a number that does not add up.
for (const r of plans) {
  const er = r[ER] as number;
  const ee = r[EE] as number;
  const total = r[TOTAL] as number;
  assert.ok(
    Math.abs(er + ee - total) < 0.02,
    `${r[0]}: employer ${er} + employee ${ee} should be ${total}`,
  );
  assert.ok(er >= 0 && ee >= 0, `${r[0]}: neither side pays a negative amount`);
}

// 3. And across all plans, which is the figure the total row carries.
const erAll = plans.reduce((n, r) => n + (r[ER] as number), 0);
const eeAll = plans.reduce((n, r) => n + (r[EE] as number), 0);
const premium = plans.reduce((n, r) => n + (r[TOTAL] as number), 0);
assert.ok(Math.abs(erAll + eeAll - premium) < 0.05, "the totals add up too");

// 4. The plan total is the sum of its tiers — the arithmetic an employer would
//    do by hand if they doubted it.
for (const r of plans) {
  const mine = tiers.filter((t) => t[0] === r[0]);
  const summed = mine.reduce((n, t) => n + (t[DETAIL_COLUMNS.length - 1] as number), 0);
  assert.ok(Math.abs(summed - (r[TOTAL] as number)) < 0.02, `${r[0]}: tiers sum to the plan total`);
}

// 5. A tier with nobody in it costs nobody anything, whatever rate is shown.
for (const t of tiers) {
  if ((t[2] as number) === 0) {
    assert.equal(t[4], 0, `${t[0]} ${t[1]}: no one enrolled, so the employer pays nothing`);
    assert.equal(t[5], 0, `${t[0]} ${t[1]}: no one enrolled, so employees pay nothing`);
    assert.equal(t[6], 0, `${t[0]} ${t[1]}: and nothing is in the total`);
  }
}

// 6. Enrolled on a plan row is the sum of that plan's tiers.
for (const r of plans) {
  const mine = tiers.filter((t) => t[0] === r[0]);
  assert.equal(
    mine.reduce((n, t) => n + (t[2] as number), 0),
    r[1],
    `${r[0]}: enrolled matches the tiers`,
  );
}

// 7. The note tells the truth about where the split came from.
//
//    This group carries a real payroll split from Employee Navigator, so the
//    note must not call it an estimate. Live data has more of these than the
//    shipped roster does, so this is the branch most clients will see.
assert.equal(hasActualSplit(data, g), true, "this group has a configured payroll split");
const actual = splitNote(data, g, EE_PCT, DEP_PCT);
assert.match(actual, /configured in your Employee Navigator payroll setup/);
assert.match(actual, /not an estimate/, "it says plainly that it is not one");
assert.doesNotMatch(actual, /illustrative|modelled/, "and does not describe a fact as a model");

//    With the split taken away — a group whose payroll setup we do not hold —
//    the same figures become a model, and the note has to say so.
const noSplit = { ...data, splits: {} } as unknown as KennionData;
assert.equal(hasActualSplit(noSplit, g), false);
const modelled = splitNote(noSplit, g, EE_PCT, DEP_PCT);
assert.match(modelled, /illustrative/);
assert.match(modelled, /80% of the employee rate and 32% of the dependent cost/);
assert.doesNotMatch(modelled, /not an estimate/);

// 8. And the two are not the same numbers: the configured split is used where
//    it exists rather than the percentages.
const plan = rows[0].p.plan;
const modelledRows = planRowsFor(noSplit, overrides, g, rows, EE_PCT, DEP_PCT);
const a = plans.find((r) => r[0] === plan)!;
const b = modelledRows.find((r) => r[0] === plan)!;
assert.notEqual(a[ER], b[ER], "the configured split differs from the model");
for (const r of [a, b]) {
  assert.ok(
    Math.abs((r[ER] as number) + (r[EE] as number) - (r[TOTAL] as number)) < 0.02,
    "and both still add up to the premium",
  );
}

// 9. The file points a client at their own live data rather than pretending to be it.
assert.equal(ENROLL_URL, "https://go.kennion.com/enroll");

console.log(
  `plan sheet: ${plans.length} plans, ${tiers.length} tier rows — employer ${erAll.toFixed(2)} + ` +
    `employee ${eeAll.toFixed(2)} = ${premium.toFixed(2)}; both split notes read true`,
);
server.kill();

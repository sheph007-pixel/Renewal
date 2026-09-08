// The audit workbook handed to the account managers: group, plan, four rates,
// one sheet each.
//
// It runs against a live server and uses the payload the admin screen itself
// receives, so the roster rules — archived groups, the totals row in the
// source spreadsheet, who holds each group — are the server's, not a fixture's
// guess at them. Runs with `npx tsx`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rowsFor, auditGroups, COLUMNS, managerName } from "../client/src/lib/worksheet.ts";
import { TIERS, rateFor, type Group, type Overrides } from "../client/src/lib/model.ts";

const PORT = 5086;
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

const payload = await (
  await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }),
  })
).json();
assert.ok(payload.token, "signed in");

const groups: Group[] = payload.groups;
const overrides: Overrides = payload.overrides || {};
const active = auditGroups(groups);
const rows = rowsFor(active, overrides);

// 1. The sheet is group, plan and the four rates. Nothing else — an auditor
//    should not have to read past the numbers they are checking.
assert.deepEqual(COLUMNS, [
  "Group",
  "Plan",
  "Employee",
  "Employee + Spouse",
  "Employee + Child(ren)",
  "Employee + Family",
]);
for (const r of rows) assert.deepEqual(Object.keys(r), COLUMNS, "every row is those six columns");

// 2. Every plan of every group in the portal gets a row, and nothing else does.
const expected = active.reduce((n, g) => n + (g.plans || []).length, 0);
assert.equal(rows.length, expected, "one row per plan");
assert.ok(rows.length > 100, `the workbook is worth sending: ${rows.length} rows`);

// 3. The totals line in the source spreadsheet is not a company. It carries a
//    premium and a headcount, so a sheet listing it would double the book.
for (const r of rows) assert.doesNotMatch(String(r.Group), /^TOTAL\b/i, "no totals row");

// 4. Groups come out in name order, so a manager can read down their sheet.
const names = [...new Set(rows.map((r) => String(r.Group)))];
assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "groups in name order");

// 5. The rates are the rates the screen shows — same function on the same
//    payload, so this checks the wiring rather than the arithmetic.
for (const g of active) {
  for (const p of g.plans || []) {
    const row = rows.find((r) => r.Group === g.name && r.Plan === p.plan);
    assert.ok(row, `${g.name} / ${p.plan} has a row`);
    for (const t of TIERS) {
      const want = rateFor(overrides, g, p.plan, t.key);
      assert.equal(row[t.label], want.rate == null ? "" : want.rate, `${g.name} ${p.plan} ${t.short}`);
    }
  }
}

// 6. Group and plan together name the row, so they have to be unique — a
//    duplicate would take a correction to the wrong plan.
const keys = rows.map((r) => `${r.Group} :: ${r.Plan}`);
assert.equal(new Set(keys).size, keys.length, "no two rows name the same group and plan");

// 7. Rates are numbers, not text, so Excel shows them as money and reads back
//    as numbers.
for (const r of rows) {
  for (const t of TIERS) {
    const v = r[t.label];
    assert.ok(v === "" || typeof v === "number", `${r.Group} ${t.short} is a number or blank`);
  }
}

// 8. Every group lands on exactly one manager's sheet.
const perManager = new Map<string, number>();
for (const g of active) perManager.set(managerName(g), (perManager.get(managerName(g)) || 0) + 1);
assert.equal(
  [...perManager.values()].reduce((a, b) => a + b, 0),
  active.length,
  "every group lands on one sheet",
);

console.log(
  `audit workbook: ${rows.length} rows, ${COLUMNS.length} columns, across ${active.length} groups — ` +
    [...perManager].sort().map(([m, n]) => `${m} ${n}`).join(", "),
);
server.kill();

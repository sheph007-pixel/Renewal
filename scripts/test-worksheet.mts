// The audit workbook handed to the account managers: one row per plan, the
// rates the Rates screen shows, and empty columns to key corrections into.
//
// It runs against a live server and uses the payload the admin screen itself
// receives, so the roster rules — archived groups, the totals row in the
// source spreadsheet, who holds each group — are the server's, not a fixture's
// guess at them. Runs with `npx tsx`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rowsFor, auditGroups, COLUMNS, KEY_HEADER, rowKey, splitKey } from "../client/src/lib/worksheet.ts";
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

// 1. Every plan of every group in the portal gets a row, and nothing else does.
const expected = active.reduce((n, g) => n + (g.plans || []).length, 0);
assert.equal(rows.length, expected, "one row per plan");
assert.ok(rows.length > 100, `the workbook is worth sending: ${rows.length} rows`);

// 2. The totals line in the source spreadsheet is not a company. It carries a
//    premium and a headcount, so a sheet that listed it would double the book.
for (const r of rows) {
  assert.doesNotMatch(String(r.Group), /^TOTAL\b/i, "no totals row on an auditor's sheet");
}

// 3. Groups come out in name order, so a manager can read down their sheet.
const names = [...new Set(rows.map((r) => String(r.Group)))];
assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "groups in name order");

// 4. Every column is present on every row, including the empty ones the
//    auditor types into. A missing key would silently drop a correction.
for (const r of rows) {
  for (const c of COLUMNS) assert.ok(c in r, `row for ${r[KEY_HEADER]} is missing the ${c} column`);
}

// 5. The rates in the workbook are the rates the screen shows — same function
//    on the same payload, so this checks the wiring rather than the arithmetic.
for (const g of active) {
  for (const p of g.plans || []) {
    const row = rows.find((r) => r[KEY_HEADER] === rowKey(g.name, p.plan));
    assert.ok(row, `${g.name} / ${p.plan} has a row`);
    for (const t of TIERS) {
      const want = rateFor(overrides, g, p.plan, t.key);
      assert.equal(row[t.label], want.rate == null ? "" : want.rate, `${g.name} ${p.plan} ${t.short}`);
    }
  }
}

// 6. The key survives a round trip, including names carrying commas and dots.
for (const r of rows) {
  const back = splitKey(String(r[KEY_HEADER]));
  assert.ok(back, `key parses: ${r[KEY_HEADER]}`);
  assert.equal(back.group, r.Group, "group comes back whole");
  assert.equal(back.plan, r.Plan, "plan comes back whole");
}

// 7. Keys are unique, or a correction would land on the wrong row.
const keys = rows.map((r) => String(r[KEY_HEADER]));
assert.equal(new Set(keys).size, keys.length, "every row key is unique");

// 8. Correction columns start empty — the auditor's answer, not ours.
for (const r of rows) {
  for (const t of TIERS) assert.equal(r[`Correct ${t.label}`], "", "correction columns start empty");
  assert.equal(r.Notes, "", "notes start empty");
}

// 9. An estimated tier is one with no billed rate, and is named as such. This
//    is the column the audit is really for.
for (const r of rows) {
  const k = splitKey(String(r[KEY_HEADER]))!;
  const g = active.find((x) => x.name === k.group)!;
  const named = String(r["Estimated Tiers"]);
  const list = named === "None — all billed" ? [] : named.split(", ");
  for (const t of TIERS) {
    const { rate, derived } = rateFor(overrides, g, k.plan, t.key);
    const shouldName = rate != null && derived;
    assert.equal(list.includes(t.short), shouldName, `${g.name} ${k.plan}: ${t.short} estimated flag`);
  }
}

// 10. Every group lands on exactly one sheet.
const sheetFor = (g: Group) => g.manager || "Unassigned";
const perManager = new Map<string, number>();
for (const g of active) perManager.set(sheetFor(g), (perManager.get(sheetFor(g)) || 0) + 1);
assert.equal(
  [...perManager.values()].reduce((a, b) => a + b, 0),
  active.length,
  "every group lands on one sheet",
);

const estimated = rows.filter((r) => r["Estimated Tiers"] !== "None — all billed").length;
console.log(
  `audit workbook: ${rows.length} rows across ${active.length} groups — ` +
    [...perManager].sort().map(([m, n]) => `${m} ${n}`).join(", ") +
    ` — ${estimated} rows carry an estimated tier`,
);
server.kill();

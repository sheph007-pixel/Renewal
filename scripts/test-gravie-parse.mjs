// A Gravie rate workbook, built here the way Gravie lays one out, read back:
// header facts, subscribers by tier, every plan on the PPO, EPO and Narrow
// Network (LocalPlus) sheets - all stored, audited and shown - and the
// proposal shape the Options page prices from.
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseGravieWorkbook, gravieExtracted, gravieQuoteRows } from "../server/gravie-parse.js";

function sheet(withType, rows) {
  const head = [
    ["Gravie", "comfort", null, null, null, null, null, "Contingencies"],
    ["Group Name:", "Example Co, LLC", null, "Subscribers Quoted by Tier", null, null, null, "Minimum participation is 75%"],
    ["Effective Date", 46388, null, "EE:", 10, null, null, "Group must have 15 enrolled"],
    ["Date Generated:", 46273, null, "ES:", 2],
    ["Quote Number:", "00099999", null, "EC:", 1],
    ["Network:", "Cigna Healthcare Open Access Plus Network", null, "F:", 3],
    ["PBM:", "Express Scripts", null, "Total:", 16],
    [], [], [], [], [], [], [], [], [],
    withType
      ? ["Plan Name", "Plan Type", "Deductible", "OOPM", "Coinsurance", "Column1", "EE Rate", "ES Rate", "EC Rate", "F Rate"]
      : ["Plan Name", "Deductible", "OOPM", "Column1", "Coinsurance", "EE Rate", "ES Rate", "EC Rate", "F Rate"],
  ];
  return XLSX.utils.aoa_to_sheet([...head, ...rows]);
}
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet(false, [
  ["Gravie Copay $3,000 Ded/$6,000 OOPM EPO", "$3000/$6000", "$6000/$12000", 20, 0.2, 400, 800, 700, 1200],
  ["Gravie Copay $3,000 Ded/$6,000 OOPM", "$3000/$6000", "$6000/$12000", 20, 0.2, 410, 820, 710, 1220],
]), "Narrow Network");
XLSX.utils.book_append_sheet(wb, sheet(true, [
  ["Gravie QHDHP $5,000 Ded/$5,000 OOPM EPO", "QHDHP", "$5000/$10000", "$5000/$10000", 0, 0, 350, 700, 600, 1000],
  ["Gravie Comfort $2,500 OOPM EPO", "Comfort", "$2500/$5000", "$2500/$5000", 0, 0, 500, 1000, 900, 1500],
  ["Not a plan row", "Copay", "", "", 0, 0, null, null, null, null],
]), "EPO");
XLSX.utils.book_append_sheet(wb, sheet(true, [
  ["Gravie QHDHP $5,000 Ded/$5,000 OOPM", "QHDHP", "$5000/$10000", "$5000/$10000", 0, 0, 360, 720, 620, 1030],
]), "PPO");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Gravie"], ["Plan Type", "Preventative"], ["Comfort", "No Cost"]]), "Benefits Grid (static)");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

const p = parseGravieWorkbook(buf);
assert.equal(p.group, "Example Co, LLC");
assert.equal(p.quoteNumber, "00099999");
assert.equal(p.effectiveDate, "2027-01-01", "Excel serial 46388 is 1 Jan 2027");
assert.equal(p.generated, "2026-09-08");
assert.deepEqual(p.tiers, { EE: 10, ES: 2, EC: 1, FAM: 3, total: 16 });
assert.equal(p.plans.length, 5, "every priced plan: the PPO, EPO and Narrow Network sheets (nothing from the benefits grid, which has no rates)");
assert.deepEqual(p.plans.map((x) => `${x.sheet}:${x.variant}`), ["PPO:PPO", "EPO:EPO", "EPO:EPO", "NARROW NETWORK:EPO", "NARROW NETWORK:PPO"], "PPO first, then EPO, then Narrow Network");
assert.deepEqual(p.plans.slice(3).map((x) => x.network), ["Cigna LocalPlus (EPO)", "Cigna LocalPlus (PPO)"], "the Narrow Network sheet's plans are priced on Cigna LocalPlus");
assert.equal(p.plans[0].network, "Cigna Open Access Plus (PPO)");
assert.equal(p.plans[0].planType, "QHDHP");
assert.deepEqual(p.plans[0].rates, { EE: 360, ES: 720, EC: 620, FAM: 1030 });
assert.equal(p.plans[0].coinsurance, 0);
assert.equal(p.plans[0].sheet, "PPO");
assert.equal(p.plans[0].row, 18, "each plan knows the sheet row it came from");
// Only what the workbook states: the plan type exactly as its column prints
// it, and none where the sheet has no Plan Type column (never read off the name).
assert.equal(p.plans[3].planType, null, "the Narrow Network sheet has no Plan Type column: no type, though the name says Copay");
assert.deepEqual(p.plans[3].raw, { coinsurance: 0.2, network: "Cigna Healthcare Open Access Plus Network" }, "the source cells, before normalization");

const x = gravieExtracted(p);
assert.equal(x.carrier, "Gravie");
assert.equal(x.funding, "level funded");
assert.equal(x.quote_id, "00099999");
assert.equal(x.enrolled_on_document, 16);
assert.equal(x.plans.length, 5, "every quoted plan stored: 5 in the workbook, 5 in the database");
assert.deepEqual([x.reconciliation.unique_plans, x.reconciliation.unique_ppo, x.reconciliation.unique_epo, x.reconciliation.expected], [5, 2, 3, 5]);
assert.deepEqual(x.coverage.sheets.map((sh) => `${sh.name}:${sh.status}:${sh.plans}`), ["Narrow Network:parsed:2", "EPO:parsed:2", "PPO:parsed:1", "Benefits Grid (static):not a quote sheet:0"], "every sheet accounted for");
// The same design name on Open Access Plus and on LocalPlus is two plans - the network tells them apart.
assert.equal(new Set(x.plans.map((pl) => `${pl.name}|${pl.network}`)).size, 5);
assert.deepEqual(x.plans[0].source, { identity: [], benefits: [], rates: [], sheet: "PPO", rows: "row 18", appearances: 1, codes: [] });
assert.equal(x.plans[0].monthly_total, 360 * 10 + 720 * 2 + 620 * 1 + 1030 * 3, "priced on the quoted tiers");
assert.equal(x.plans[0].deductible, "$5000/$10000");
// SOURCE NORMALIZATION with the source kept: 0.2 is stored as the "20%" it
// means, and the cell itself stays beside it with the sheet and row.
const narrow = x.plans.find((pl) => pl.network === "Cigna LocalPlus (PPO)");
assert.equal(narrow.benefits.coinsurance, "20%");
assert.deepEqual(narrow.raw, { coinsurance: 0.2, network: "Cigna Healthcare Open Access Plus Network", sheet: "NARROW NETWORK", row: 19 });
assert.equal(narrow.plan_type, null);
assert.ok(x.plans.every((pl) => !("hsa_eligible" in (pl.benefits || {}))), "HSA eligibility is never filled in: the workbook does not state it");

const rows = gravieQuoteRows(p);
assert.equal(rows.length, 5);
assert.deepEqual(rows.map((r) => r.network), ["PPO", "EPO", "EPO", "LocalPlus EPO", "LocalPlus PPO"]);
assert.equal(rows[0].monthly, 360 * 10 + 720 * 2 + 620 * 1 + 1030 * 3);
assert.equal(rows[0].name, "Gravie QHDHP $5,000 Ded/$5,000 OOPM");
assert.match(x.summary, /quote 00099999/);

{
  const other = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(other, XLSX.utils.aoa_to_sheet([["Carrier", "Rows"], ["UHC", 12]]), "Sheet1");
  const bytes = XLSX.write(other, { type: "buffer", bookType: "xlsx" });
  assert.throws(() => parseGravieWorkbook(bytes), /Not a Gravie/, "some other spreadsheet is refused");
}

console.log("gravie parse: all assertions passed");

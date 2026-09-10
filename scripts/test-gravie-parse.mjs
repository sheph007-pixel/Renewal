// A Gravie rate workbook, built here the way Gravie lays one out, read back:
// header facts, subscribers by tier, every plan on every rate sheet with its
// network, and the proposal shape the Options page prices from.
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseGravieWorkbook, gravieExtracted } from "../server/gravie-parse.js";

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
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Gravie"], ["Plan Type", "Preventative"], ["Comfort", "No Cost"]]), "Benefits Grid (static)");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

const p = parseGravieWorkbook(buf);
assert.equal(p.group, "Example Co, LLC");
assert.equal(p.quoteNumber, "00099999");
assert.equal(p.effectiveDate, "2027-01-01", "Excel serial 46388 is 1 Jan 2027");
assert.equal(p.generated, "2026-09-08");
assert.deepEqual(p.tiers, { EE: 10, ES: 2, EC: 1, FAM: 3, total: 16 });
assert.equal(p.plans.length, 4, "every priced plan row, nothing from the benefits grid");
assert.equal(p.plans[0].network, "Cigna LocalPlus (EPO)");
assert.equal(p.plans[1].network, "Cigna LocalPlus (PPO)");
assert.equal(p.plans[0].planType, "Copay", "type read off the name when the sheet has no column");
assert.equal(p.plans[2].planType, "QHDHP");
assert.equal(p.plans[2].network, "Cigna Open Access Plus (EPO)");
assert.deepEqual(p.plans[3].rates, { EE: 500, ES: 1000, EC: 900, FAM: 1500 });
assert.equal(p.plans[3].coinsurance, 0);

const x = gravieExtracted(p);
assert.equal(x.carrier, "Gravie");
assert.equal(x.funding, "level funded");
assert.equal(x.quote_id, "00099999");
assert.equal(x.enrolled_on_document, 16);
assert.equal(x.plans.length, 4);
assert.equal(x.plans[0].monthly_total, 400 * 10 + 800 * 2 + 700 * 1 + 1200 * 3, "priced on the quoted tiers");
assert.equal(x.plans[0].deductible, "$3000/$6000");
assert.match(x.summary, /quote 00099999/);

{
  const other = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(other, XLSX.utils.aoa_to_sheet([["Carrier", "Rows"], ["UHC", 12]]), "Sheet1");
  const bytes = XLSX.write(other, { type: "buffer", bookType: "xlsx" });
  assert.throws(() => parseGravieWorkbook(bytes), /Not a Gravie/, "some other spreadsheet is refused");
}

console.log("gravie parse: all assertions passed");

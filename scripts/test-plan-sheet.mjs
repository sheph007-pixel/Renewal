// The All Plans workbook: the page's columns and rows become a two-sheet
// .xlsx with the header in row 1 and an About sheet.
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { renderPlanSheet } from "../server/documents.js";

const columns = ["Option", "Carrier/TPA", "Plan", "Employee Only Rate", "Total Monthly Bill"];
const rows = [
  ["UH3", "UnitedHealthcare", "P4000i8021B", 640, 5120],
  ["GR1", "Gravie", "Gravie Copay $500", 610.5, 4880],
];
const file = renderPlanSheet({ group: { name: "Test Group, Inc.", tiers: { EE: 3, ES: 1, EC: 0, FAM: 1 } }, columns, rows, contribution: { EE: 300, ES: 300, EC: 300, FAM: 300 } });
assert.equal(file.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
assert.match(file.filename, /^Test Group Inc - 2027 Medical Plans \d{4}-\d{2}-\d{2}\.xlsx$/);
assert.equal(file.data.subarray(0, 2).toString(), "PK");
const wb = XLSX.read(file.data, { type: "buffer" });
assert.deepEqual(wb.SheetNames, ["Plans", "About"]);
const plans = XLSX.utils.sheet_to_json(wb.Sheets.Plans, { header: 1 });
assert.deepEqual(plans[0], columns);
assert.equal(plans.length, 3);
assert.equal(plans[2][3], 610.5, "numbers stay numbers");
const about = XLSX.utils.sheet_to_json(wb.Sheets.About, { header: 1 });
assert.equal(about[1][0], "Test Group, Inc.");
assert.ok(about.some((r) => String(r[0]).startsWith("Employer contribution applied")));
console.log("ok - plan sheet:", file.data.length, "bytes");

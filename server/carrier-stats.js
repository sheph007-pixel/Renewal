// Reads Employee Navigator's "Carrier Stats" report.
//
// It is the independent check on the XML import: one row per carrier with
// eligible and enrolled employees, companies, plans, and the monthly employee
// and plan (total) costs, plus a total row. The portal stores the latest
// report and reconciles what it imported against it, carrier by carrier.
import * as XLSX from "xlsx";

const HEAD = {
  carrier: /^carrier$/i,
  eligible: /eligible/i,
  enrolled: /enrolled/i,
  companies: /compan/i,
  plans: /^plans?$/i,
  employeeCosts: /employee\s*cost/i,
  planCosts: /plan\s*cost/i,
};

const num = (v) => {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse an .xls / .xlsx / .csv carrier stats export.
 * Returns { rows: [{carrier, eligible, enrolled, companies, plans, employeeCosts, planCosts}],
 *           total: {employeeCosts, planCosts} | null, reportDate: "yyyy-mm-dd" | null }
 */
export function parseCarrierStats(buffer, filename = "") {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer", raw: false });
  } catch (e) {
    throw new Error("Could not open that file as a spreadsheet: " + e.message);
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("The spreadsheet has no sheets.");
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });

  // Find the header row: the one that has a "Carrier" cell and an "Enrolled" cell.
  const hi = grid.findIndex(
    (r) => r.some((c) => HEAD.carrier.test(String(c || "").trim())) && r.some((c) => HEAD.enrolled.test(String(c || ""))),
  );
  if (hi < 0) {
    throw new Error(
      'This does not look like the Carrier Stats report - no "Carrier" / "Enrolled Employees" header row.',
    );
  }
  const header = grid[hi].map((c) => String(c || "").trim());
  const col = {};
  for (const [key, re] of Object.entries(HEAD)) {
    const i = header.findIndex((h) => re.test(h));
    if (i >= 0) col[key] = i;
  }
  if (col.carrier == null || col.enrolled == null || col.planCosts == null) {
    throw new Error("The report is missing a Carrier, Enrolled Employees or Plan Costs column.");
  }

  const rows = [];
  let total = null;
  for (const r of grid.slice(hi + 1)) {
    const carrier = String(r[col.carrier] || "").trim();
    if (!carrier) continue;
    const rec = {
      carrier,
      eligible: num(r[col.eligible]),
      enrolled: num(r[col.enrolled]),
      companies: num(r[col.companies]),
      plans: num(r[col.plans]),
      employeeCosts: num(r[col.employeeCosts]),
      planCosts: num(r[col.planCosts]),
    };
    if (/total/i.test(carrier) && /^-+\s*total/i.test(carrier)) {
      total = { employeeCosts: rec.employeeCosts, planCosts: rec.planCosts };
      continue;
    }
    rows.push(rec);
  }
  if (!rows.length) throw new Error("No carrier rows found in the report.");

  // The report's own totals if it had a total row; ours otherwise.
  if (!total) {
    total = {
      employeeCosts: rows.reduce((n, x) => n + x.employeeCosts, 0),
      planCosts: rows.reduce((n, x) => n + x.planCosts, 0),
    };
  }

  const m = /(\d{4})[_-](\d{2})[_-](\d{2})/.exec(filename);
  const reportDate = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  return { rows, total, reportDate };
}

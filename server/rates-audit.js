// Reading back the audit workbook the account managers filled in.
//
// The workbook is group, plan and four rates, typed over in place. What comes
// back is whatever Excel made of it: re-sorted, filtered, with currency
// formatting and stray spaces. So nothing here trusts position — a row is
// found by the group and plan it names, and every rate is compared against the
// one the workbook showed, so a sheet that was only read and returned changes
// nothing.
import xlsx from "xlsx";

/**
 * The two administrators the program runs on. A plan on anything else is not
 * Kennion's to rate, so the workbook never carries one and a rate for one is
 * refused rather than written.
 */
export const PROGRAM_TPAS = ["EBPA", "HealthEZ"];

/** The four tiers, named as the workbook names them. */
export const TIERS = [
  { key: "EE", label: "Employee", census: "Employee", factor: 1 },
  { key: "EC", label: "Employee + Child(ren)", census: "Employee + Child(ren)", factor: 1.85 },
  { key: "ES", label: "Employee + Spouse", census: "Employee + Spouse", factor: 2.0 },
  { key: "FAM", label: "Employee + Family", census: "Employee + Family", factor: 2.85 },
];

/**
 * A rate as typed by a person: "1,234.56", "$1234.56", " 1234.56 ", or a
 * number Excel already made of it. Anything else is refused rather than
 * coerced, because a silently misread rate is worse than a rejected one.
 */
export function parseRate(raw) {
  if (raw == null) return { empty: true };
  if (typeof raw === "number") {
    return isFinite(raw) ? { value: raw } : { error: "not a number" };
  }
  const text = String(raw).trim();
  if (!text || text === "—" || text === "-") return { empty: true };
  if (!/^\$?\s*-?[\d,]*\.?\d+\s*$/.test(text)) return { error: `not a rate: "${text}"` };
  const n = Number(text.replace(/[$,\s]/g, ""));
  if (!isFinite(n)) return { error: `not a rate: "${text}"` };
  return { value: n };
}

/** Header names differ by a space or a case; match on something steadier. */
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Pull the corrections out of a workbook.
 *
 * `shown(group, plan, censusTier)` gives the rate the workbook displayed for
 * that cell — including one derived from the employee rate — so a rate that
 * came back untouched is not read as a change. `undefined` means there is no
 * such group and plan, which is reported rather than invented.
 *
 * Returns the changes and everything that could not be used, with a reason.
 * Nothing here writes; the caller decides.
 */
export function readAuditWorkbook(buffer, shown) {
  const book = xlsx.read(buffer, { type: "buffer", cellDates: false });
  const changes = [];
  const problems = [];
  let rowsRead = 0;
  let sheetsRead = 0;

  // The same plan on two sheets: fine if they agree, a problem if they do not.
  const seen = new Map();

  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true });
    if (!rows.length) continue;

    // A sheet is a worksheet if it names a group, a plan and at least one
    // tier. Anything else in the file is left alone without comment.
    const headers = Object.keys(rows[0]);
    const groupHeader = headers.find((h) => norm(h) === "group");
    const planHeader = headers.find((h) => norm(h) === "plan");
    const tierHeaders = TIERS.map((t) => ({
      tier: t,
      header: headers.find((h) => norm(h) === norm(t.label)),
    })).filter((x) => x.header);
    if (!groupHeader || !planHeader || !tierHeaders.length) continue;
    sheetsRead++;

    for (const row of rows) {
      const group = row[groupHeader] == null ? "" : String(row[groupHeader]).trim();
      const plan = row[planHeader] == null ? "" : String(row[planHeader]).trim();
      if (!group && !plan) continue;
      rowsRead++;
      if (!group || !plan) {
        problems.push({ sheet: name, group, plan, reason: "the row names no group or no plan" });
        continue;
      }

      for (const { tier, header } of tierHeaders) {
        const parsed = parseRate(row[header]);
        if (parsed.empty) continue;
        if (parsed.error) {
          problems.push({ sheet: name, group, plan, tier: tier.census, reason: parsed.error });
          continue;
        }
        if (parsed.value <= 0) {
          problems.push({
            sheet: name,
            group,
            plan,
            tier: tier.census,
            reason: `a rate must be more than zero, not ${parsed.value}`,
          });
          continue;
        }

        const was = shown(group, plan, tier.census);
        if (was === undefined) {
          problems.push({
            sheet: name,
            group,
            plan,
            tier: tier.census,
            reason: "not an EBPA or HealthEZ plan in the portal",
          });
          continue;
        }

        const rate = +parsed.value.toFixed(2);
        const id = `${group}||${plan}||${tier.census}`;
        const already = seen.get(id);
        if (already != null && already !== rate) {
          problems.push({
            sheet: name,
            group,
            plan,
            tier: tier.census,
            reason: `two sheets give different rates for this tier: ${already} and ${rate}`,
          });
          continue;
        }
        if (already != null) continue;
        seen.set(id, rate);

        // The rate the workbook showed, sent back unchanged, is not a change.
        if (was != null && Math.abs(was - rate) < 0.005) continue;

        changes.push({
          group,
          plan,
          censusTier: tier.census,
          was: was == null ? null : +was.toFixed(2),
          rate,
        });
      }
    }
  }

  changes.sort((a, b) => a.group.localeCompare(b.group) || a.plan.localeCompare(b.plan));
  return { changes, problems, rowsRead, sheetsRead };
}

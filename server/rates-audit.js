// Reading back the audit workbook the account managers filled in.
//
// The workbook goes out with one row per plan and four empty "Correct"
// columns. What comes back is whatever Excel made of it: re-sorted, filtered,
// with currency formatting, stray spaces, and — because people work how they
// work — the odd extra sheet. So nothing here trusts position. Every row is
// found by the key it carries, and a row without one is reported rather than
// guessed at.
import xlsx from "xlsx";

export const KEY_HEADER = "Row Key — Do Not Edit";
export const NOTES_HEADER = "Notes";

/** The four tiers, named as the workbook names them. */
export const TIERS = [
  { key: "EE", label: "Employee", census: "Employee" },
  { key: "ES", label: "Employee + Spouse", census: "Employee + Spouse" },
  { key: "EC", label: "Employee + Child(ren)", census: "Employee + Child(ren)" },
  { key: "FAM", label: "Employee + Family", census: "Employee + Family" },
];

const CORRECT = (label) => `Correct ${label}`;

/** Split a row key back into its parts. Group names may contain anything. */
export function splitKey(key) {
  const at = String(key).lastIndexOf(" :: ");
  if (at < 0) return null;
  return { group: String(key).slice(0, at), plan: String(key).slice(at + 4) };
}

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
  if (!text) return { empty: true };
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
 * `current(group, plan, censusTier)` gives the rate on file, so a cell that
 * merely repeats what is already there is not counted as a change.
 *
 * Returns changes, and everything that could not be used, with a reason. The
 * caller decides whether to apply; nothing here writes.
 */
export function readAuditWorkbook(buffer, current) {
  const book = xlsx.read(buffer, { type: "buffer", cellDates: false });
  const changes = [];
  const problems = [];
  let rowsRead = 0;
  let sheetsRead = 0;

  // Same key seen twice: fine if it says the same thing, a problem if not.
  const seen = new Map();

  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true });
    if (!rows.length) continue;

    // Only sheets carrying the key column are worksheets. The read-me and the
    // read-only overview have no key, and are skipped without comment.
    const headers = Object.keys(rows[0]);
    const keyHeader = headers.find((h) => norm(h) === norm(KEY_HEADER));
    if (!keyHeader) continue;
    sheetsRead++;

    const columnFor = (label) => headers.find((h) => norm(h) === norm(CORRECT(label)));
    const notesHeader = headers.find((h) => norm(h) === norm(NOTES_HEADER));

    for (const row of rows) {
      const key = row[keyHeader];
      if (key == null || String(key).trim() === "") continue;
      rowsRead++;
      const parts = splitKey(String(key).trim());
      if (!parts) {
        problems.push({ sheet: name, key: String(key), reason: "the row key is not one this workbook wrote" });
        continue;
      }
      const notes = notesHeader && row[notesHeader] != null ? String(row[notesHeader]).trim() : "";

      for (const t of TIERS) {
        const column = columnFor(t.label);
        if (!column) continue;
        const parsed = parseRate(row[column]);
        if (parsed.empty) continue;
        if (parsed.error) {
          problems.push({
            sheet: name,
            group: parts.group,
            plan: parts.plan,
            tier: t.census,
            reason: parsed.error,
          });
          continue;
        }
        if (parsed.value <= 0) {
          problems.push({
            sheet: name,
            group: parts.group,
            plan: parts.plan,
            tier: t.census,
            reason: `a rate must be more than zero, not ${parsed.value}`,
          });
          continue;
        }

        const was = current(parts.group, parts.plan, t.census);
        if (was === undefined) {
          problems.push({
            sheet: name,
            group: parts.group,
            plan: parts.plan,
            tier: t.census,
            reason: "no such group and plan in the portal",
          });
          continue;
        }

        const rate = +parsed.value.toFixed(2);
        const id = `${parts.group}||${parts.plan}||${t.census}`;
        const already = seen.get(id);
        if (already != null && already !== rate) {
          problems.push({
            sheet: name,
            group: parts.group,
            plan: parts.plan,
            tier: t.census,
            reason: `two sheets give different rates for this tier: ${already} and ${rate}`,
          });
          continue;
        }
        if (already != null) continue;
        seen.set(id, rate);

        // Repeating the rate already on file is not a change.
        if (was != null && Math.abs(was - rate) < 0.005) continue;

        changes.push({
          group: parts.group,
          plan: parts.plan,
          censusTier: t.census,
          was: was == null ? null : +was.toFixed(2),
          rate,
          notes,
        });
      }
    }
  }

  changes.sort((a, b) => a.group.localeCompare(b.group) || a.plan.localeCompare(b.plan));
  return { changes, problems, rowsRead, sheetsRead };
}

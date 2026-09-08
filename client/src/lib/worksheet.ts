import { TIERS, rateFor, factorsHold, planCounts, FACTORS } from "./model";
import type { Group, Overrides, TierKey } from "./model";

/**
 * The roster stores a manager as a key. Sheets and columns want the person's
 * name, so an auditor opening the file sees who it is for.
 */
const MANAGER_FULL: Record<string, string> = {
  debbie: "Debbie Bostic",
  tracy: "Tracy Sanders",
};
export const managerName = (g: Group): string =>
  (g.manager && (MANAGER_FULL[g.manager] || g.manager)) || "Unassigned";

/**
 * The audit workbook: every current plan and rate, laid out for someone to
 * check by hand and send back.
 *
 * It is built here rather than on the server so the numbers are produced by
 * the very code that draws the Rates screen — same `rateFor`, same overrides,
 * same roster rule. A workbook that disagreed with the screen would be worse
 * than none at all.
 *
 * Each row carries a key made of the group and plan. Corrections are read back
 * by that key, so the auditor can sort, filter and re-order freely without the
 * upload losing track of which row is which.
 */

export const KEY_HEADER = "Row Key — Do Not Edit";
export const NOTES_HEADER = "Notes";
const CORRECT = (label: string) => `Correct ${label}`;

/** The columns, in order. Correction columns are left empty for the auditor. */
export const COLUMNS = [
  "Group",
  "Account Manager",
  "Plan",
  "Enrolled",
  ...TIERS.map((t) => t.label),
  "Monthly Premium",
  "Tiering",
  "Estimated Tiers",
  ...TIERS.map((t) => CORRECT(t.label)),
  NOTES_HEADER,
  KEY_HEADER,
];

/**
 * The overview sheet carries no correction columns and no key. Every editable
 * row then exists exactly once, on one manager's sheet, so two sheets can
 * never come back disagreeing about the same plan.
 */
export const OVERVIEW_COLUMNS = COLUMNS.filter(
  (c) => !c.startsWith("Correct ") && c !== NOTES_HEADER && c !== KEY_HEADER,
);

export const rowKey = (group: string, plan: string) => `${group} :: ${plan}`;

/** Split a key back into its parts, tolerating a group name with a colon. */
export function splitKey(key: string): { group: string; plan: string } | null {
  const at = String(key).lastIndexOf(" :: ");
  if (at < 0) return null;
  return { group: String(key).slice(0, at), plan: String(key).slice(at + 4) };
}

export interface SheetRow {
  [column: string]: string | number | null;
}

/**
 * How this plan's tiers relate to the program factors — the question the
 * Rates screen answers with colour, said in words for a spreadsheet.
 */
function tieringOf(overrides: Overrides, g: Group, plan: string): string {
  const billed = (g.rates || {})[plan] || {};
  const known = TIERS.filter(
    (t) => billed[t.census] != null || overrides[`${g.name}||${plan}||${t.census}`] != null,
  ).length;
  if (known < 2) return "Not enough rates to judge";
  return factorsHold(overrides, g, plan)
    ? `On schedule (${TIERS.map((t) => FACTORS[t.key]).join(", ")})`
    : "Off schedule — check";
}

/** One row per plan, for the groups given. */
export function rowsFor(groups: Group[], overrides: Overrides): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const g of groups) {
    for (const p of g.plans || []) {
      const counts = planCounts(g, p.plan);
      const enrolled = TIERS.reduce((n, t) => n + (counts[t.key] || 0), 0);
      const row: SheetRow = {
        Group: g.name,
        "Account Manager": managerName(g),
        Plan: p.plan,
        Enrolled: enrolled,
      };

      let monthly = 0;
      const estimated: string[] = [];
      for (const t of TIERS) {
        const r = rateFor(overrides, g, p.plan, t.key as TierKey);
        row[t.label] = r.rate == null ? "" : r.rate;
        if (r.rate != null) monthly += r.rate * (counts[t.key] || 0);
        // A derived rate is the program factors applied to the employee rate,
        // not something a carrier billed. Say so, because that is exactly what
        // an audit is for.
        if (r.rate != null && r.derived) estimated.push(t.short);
      }

      row["Monthly Premium"] = monthly ? +monthly.toFixed(2) : "";
      row.Tiering = tieringOf(overrides, g, p.plan);
      row["Estimated Tiers"] = estimated.length ? estimated.join(", ") : "None — all billed";
      for (const t of TIERS) row[CORRECT(t.label)] = "";
      row[NOTES_HEADER] = "";
      row[KEY_HEADER] = rowKey(g.name, p.plan);
      rows.push(row);
    }
  }
  return rows;
}

/** The groups the portal actually covers, in name order. */
export function auditGroups(groups: Group[]): Group[] {
  return groups
    .filter(
      (g) =>
        !(g as unknown as { archived?: boolean }).archived &&
        (g as unknown as { eligible?: boolean }).eligible !== false,
    )
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

const README = [
  ["Current Plans And Rates — Audit"],
  [],
  ["What this is"],
  ["Every plan the portal shows for your groups, with the rate it is using for each tier."],
  [],
  ["What to do"],
  ["1. Check each rate against the carrier's billing."],
  ["2. Where a rate is wrong, type the right one in the Correct column beside it."],
  ["3. Leave the Correct columns empty where the rate is already right."],
  ["4. Put anything worth saying in Notes."],
  ["5. Send the file back. Only the Correct columns are read; everything else is ignored."],
  [],
  ["Two columns worth reading first"],
  [
    "Estimated Tiers",
    "Tiers with no billed rate on file. The figure shown is the employee rate times the program factor, so it is a guess. These are the ones most worth checking.",
  ],
  [
    "Tiering",
    "Whether the billed tiers sit on the program factors. Off schedule means they do not, which is worth a look but is not necessarily wrong.",
  ],
  [],
  ["Please do not"],
  ["Change the Row Key column, rename a sheet, or delete a row. Sorting and filtering are fine."],
];

/**
 * Build and download the workbook: a sheet per account manager, plus one of
 * everything. SheetJS is pulled in on demand so it stays out of the bundle
 * everyone loads to look at their rates.
 */
export async function buildAuditWorkbook(groups: Group[], overrides: Overrides) {
  const XLSX = await import("xlsx");
  const active = auditGroups(groups);

  const book = XLSX.utils.book_new();

  const readme = XLSX.utils.aoa_to_sheet(README);
  readme["!cols"] = [{ wch: 18 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(book, readme, "Read Me");

  // Everything first, to read across the book, then a sheet per manager to
  // work in. Only the manager sheets carry correction columns, so any given
  // plan can be corrected in exactly one place.
  const managers = [...new Set(active.map(managerName))].sort();
  const sheets: Array<{ name: string; groups: Group[]; edit: boolean }> = [
    { name: "All Groups", groups: active, edit: false },
    ...managers.map((m) => ({
      name: m,
      groups: active.filter((g) => managerName(g) === m),
      edit: true,
    })),
  ];

  for (const s of sheets) {
    const rows = rowsFor(s.groups, overrides);
    if (!rows.length) continue;
    const header = s.edit ? COLUMNS : OVERVIEW_COLUMNS;
    // `header` orders the columns but does not drop the others: SheetJS
    // appends any key it finds. The overview must carry no correction columns
    // and no key at all, so the rows themselves are narrowed.
    const shaped = s.edit
      ? rows
      : rows.map((r) => Object.fromEntries(header.map((c) => [c, r[c]])) as SheetRow);
    const sheet = XLSX.utils.json_to_sheet(shaped, { header });
    sheet["!cols"] = header.map((c) => ({
      wch: c === "Group" ? 34 : c === "Plan" ? 40 : c === KEY_HEADER ? 46 : c === NOTES_HEADER ? 34 : Math.max(12, c.length + 2),
    }));
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
    // The header row stays put while an auditor scrolls a long sheet.
    sheet["!freeze"] = { xSplit: "0", ySplit: "1", topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
    // A sheet name cannot carry : \ / ? * [ ] and stops at 31 characters.
    XLSX.utils.book_append_sheet(book, sheet, s.name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31));
  }

  return book;
}

/** Build it and hand it to the browser. */
export async function downloadAuditWorkbook(groups: Group[], overrides: Overrides): Promise<void> {
  const XLSX = await import("xlsx");
  const book = await buildAuditWorkbook(groups, overrides);
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(book, `kennion-current-rates-audit-${stamp}.xlsx`);
}

import { TIERS, programPlans, rateFor } from "./model";
import type { Group, Overrides, TierKey } from "./model";

/**
 * The audit workbook: group, plan, four rates. Nothing else.
 *
 * The rates are typed over in place — there is no separate column to key a
 * correction into — so what comes back is the same shape that went out, with
 * the wrong numbers made right. A row is found again by its group and plan.
 *
 * Built here rather than on the server so the numbers are produced by the very
 * code that draws the Rates screen. A workbook that disagreed with the page
 * would be worse than none at all.
 */

/**
 * The roster stores a manager as a key. Sheets want the person's name, so an
 * auditor opening the file sees whose it is.
 */
const MANAGER_FULL: Record<string, string> = {
  debbie: "Debbie Bostic",
  tracy: "Tracy Hayden",
};
export const managerName = (g: Group): string =>
  (g.manager && (MANAGER_FULL[g.manager] || g.manager)) || "Unassigned";

/** The columns, in order. Group and plan name the row; the rest are the rates. */
export const COLUMNS = ["Group", "Plan", ...TIERS.map((t) => t.label)];

export interface SheetRow {
  [column: string]: string | number | null;
}

/**
 * One row per program plan — EBPA and HealthEZ, which is what the program
 * runs on. A plan nobody is enrolled in is still listed: an empty plan with a
 * wrong rate is exactly the sort of thing an audit should catch.
 */
export function rowsFor(groups: Group[], overrides: Overrides): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const g of groups) {
    for (const p of programPlans(g)) {
      const row: SheetRow = { Group: g.name, Plan: p.plan };
      for (const t of TIERS) {
        const r = rateFor(overrides, g, p.plan, t.key as TierKey);
        row[t.label] = r.rate == null ? "" : r.rate;
      }
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

/**
 * Build the workbook: one sheet per account manager, holding only their
 * groups, so a sheet can go to one person as it is. Each row appears on
 * exactly one sheet, so two sheets can never come back disagreeing about the
 * same plan.
 */
export async function buildAuditWorkbook(groups: Group[], overrides: Overrides) {
  const XLSX = await import("xlsx");
  const active = auditGroups(groups);
  const book = XLSX.utils.book_new();

  for (const manager of [...new Set(active.map(managerName))].sort()) {
    const rows = rowsFor(
      active.filter((g) => managerName(g) === manager),
      overrides,
    );
    if (!rows.length) continue;

    const sheet = XLSX.utils.json_to_sheet(rows, { header: COLUMNS });
    sheet["!cols"] = [{ wch: 38 }, { wch: 42 }, ...TIERS.map(() => ({ wch: 16 }))];
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: COLUMNS.length - 1 } }),
    };
    // The header row stays put while an auditor scrolls a long sheet.
    sheet["!freeze"] = { xSplit: "0", ySplit: "1", topLeftCell: "A3", activePane: "bottomLeft", state: "frozen" };

    // Show the rates as money. The cell keeps its number, so what comes back
    // is read as a number whatever Excel displays.
    for (let r = 1; r <= rows.length; r++) {
      for (let c = 2; c < COLUMNS.length; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === "n") cell.z = "$#,##0.00";
      }
    }

    // A sheet name cannot carry : \ / ? * [ ] and stops at 31 characters.
    XLSX.utils.book_append_sheet(book, sheet, manager.replace(/[:\\/?*[\]]/g, " ").slice(0, 31));
  }

  return book;
}

/** Build it and hand it to the browser. */
export async function downloadAuditWorkbook(groups: Group[], overrides: Overrides): Promise<void> {
  const XLSX = await import("xlsx");
  const book = await buildAuditWorkbook(groups, overrides);
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(book, `kennion-current-rates-${stamp}.xlsx`);
}

import { TIERS, money, rateFor, split, type Group, type KennionData, type Overrides, type PlanRow } from "./model";

/**
 * A group's own plans and rates, as a spreadsheet.
 *
 * Two sheets. The first is what the page shows — a row per plan, the four tier
 * rates, and the monthly premium. The second is the detail that used to sit
 * behind a click: every tier of every plan with what the employer pays and
 * what the employee pays.
 *
 * SheetJS is pulled in on demand, so a group looking at their rates never
 * downloads it.
 */

export const SUMMARY_COLUMNS = ["Plan", "Enrolled", ...TIERS.map((t) => t.label), "Monthly Premium"];

export const DETAIL_COLUMNS = [
  "Plan",
  "Tier",
  "Enrolled",
  "Rate",
  "Employer Per Month",
  "Employee Per Month",
  "Total Per Month",
];

type Row = Record<string, string | number>;

export function summaryRows(g: Group, overrides: Overrides, rows: PlanRow[]): Row[] {
  return rows.map((r) => {
    const out: Row = {
      Plan: r.p.plan,
      Enrolled: TIERS.reduce((n, t) => n + (r.counts[t.key] || 0), 0),
    };
    for (const t of TIERS) {
      const rate = rateFor(overrides, g, r.p.plan, t.key);
      out[t.label] = rate.rate == null ? "" : rate.rate;
    }
    out["Monthly Premium"] = +r.total.toFixed(2);
    return out;
  });
}

export function detailRows(
  data: KennionData,
  overrides: Overrides,
  g: Group,
  rows: PlanRow[],
  eePct: number,
  depPct: number,
): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    for (const t of TIERS) {
      const n = r.counts[t.key] || 0;
      const s = split(data, overrides, g, r.p.plan, t.key, eePct, depPct);
      if (s.rate == null) continue;
      out.push({
        Plan: r.p.plan,
        Tier: t.label,
        Enrolled: n,
        Rate: +s.rate.toFixed(2),
        // Nobody enrolled means nothing is paid, whatever the rate would be.
        "Employer Per Month": +((s.er || 0) * n).toFixed(2),
        "Employee Per Month": +((s.ee || 0) * n).toFixed(2),
        "Total Per Month": +(s.rate * n).toFixed(2),
      });
    }
  }
  return out;
}

/** Build the workbook and hand it to the browser. */
export async function downloadPlanSheet(
  data: KennionData,
  overrides: Overrides,
  g: Group,
  rows: PlanRow[],
  eePct: number,
  depPct: number,
): Promise<void> {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();

  type Sheet = ReturnType<typeof XLSX.utils.json_to_sheet>;
  const money2 = (sheet: Sheet, n: number, from: number, to: number) => {
    for (let r = 1; r <= n; r++) {
      for (let c = from; c <= to; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === "n") cell.z = "$#,##0.00";
      }
    }
  };

  const summary = summaryRows(g, overrides, rows);
  const s1 = XLSX.utils.json_to_sheet(summary, { header: SUMMARY_COLUMNS });
  s1["!cols"] = [{ wch: 40 }, { wch: 10 }, ...TIERS.map(() => ({ wch: 18 })), { wch: 18 }];
  money2(s1, summary.length, 2, SUMMARY_COLUMNS.length - 1);
  XLSX.utils.book_append_sheet(book, s1, "Current Plans");

  const detail = detailRows(data, overrides, g, rows, eePct, depPct);
  if (detail.length) {
    const s2 = XLSX.utils.json_to_sheet(detail, { header: DETAIL_COLUMNS });
    s2["!cols"] = [{ wch: 40 }, { wch: 22 }, { wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 18 }];
    money2(s2, detail.length, 3, DETAIL_COLUMNS.length - 1);
    XLSX.utils.book_append_sheet(book, s2, "Employer & Employee");
  }

  const safe = g.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  XLSX.writeFile(book, `${safe}-current-plans.xlsx`);
}

/** The same summary as text, for anything that wants it without a download. */
export const summaryLine = (rows: PlanRow[]) =>
  rows.map((r) => `${r.p.plan} ${money(r.total)}`).join(" · ");

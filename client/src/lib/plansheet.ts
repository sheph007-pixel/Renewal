import { TIERS, fmtDate, hasActualSplit, money0, rateFor, split, type Group, type KennionData, type Overrides, type PlanRow } from "./model";

/**
 * A group's own plans and rates, as a spreadsheet.
 *
 * The page answers "what do we have and what are the rates". The file answers
 * the third question an employer always asks next — "what are we paying versus
 * what are the employees paying" — which is why the split lives here and not
 * on the page.
 *
 * Whether that split is a fact or a guess depends on the group. Where Employee
 * Navigator carries the configured payroll contribution it is used exactly and
 * the file says so; where it does not, the amounts are modelled at assumed
 * percentages and the file says that instead. Labelling a real payroll split
 * "estimated" would be as wrong as passing a model off as the real thing.
 *
 * SheetJS is pulled in on demand, so a group looking at their rates never
 * downloads it.
 */

export const ENROLL_URL = "https://go.kennion.com/enroll";

export const COLUMNS = [
  "Plan",
  "Enrolled",
  ...TIERS.map((t) => t.label),
  "Employer / Month",
  "Employee / Month",
  "Monthly Premium",
];

export const DETAIL_COLUMNS = [
  "Plan",
  "Tier",
  "Enrolled",
  "Rate",
  "Employer / Month",
  "Employee / Month",
  "Total / Month",
];

type Cell = string | number | null;

const round = (n: number) => Math.round(n * 100) / 100;

/** One row per plan: rates, what each side pays, and the premium. */
export function planRowsFor(
  data: KennionData,
  overrides: Overrides,
  g: Group,
  rows: PlanRow[],
  eePct: number,
  depPct: number,
): Cell[][] {
  return rows.map((r) => {
    const enrolled = TIERS.reduce((n, t) => n + (r.counts[t.key] || 0), 0);
    let er = 0;
    let ee = 0;
    for (const t of TIERS) {
      const n = r.counts[t.key] || 0;
      if (!n) continue;
      const s = split(data, overrides, g, r.p.plan, t.key, eePct, depPct);
      er += (s.er || 0) * n;
      ee += (s.ee || 0) * n;
    }
    return [
      r.p.plan,
      enrolled,
      ...TIERS.map((t) => {
        const rate = rateFor(overrides, g, r.p.plan, t.key).rate;
        return rate == null ? "" : rate;
      }),
      round(er),
      round(ee),
      round(r.total),
    ];
  });
}

/** Every tier of every plan, for anyone who wants to check the arithmetic. */
export function tierRowsFor(
  data: KennionData,
  overrides: Overrides,
  g: Group,
  rows: PlanRow[],
  eePct: number,
  depPct: number,
): Cell[][] {
  const out: Cell[][] = [];
  for (const r of rows) {
    for (const t of TIERS) {
      const s = split(data, overrides, g, r.p.plan, t.key, eePct, depPct);
      if (s.rate == null) continue;
      const n = r.counts[t.key] || 0;
      out.push([
        r.p.plan,
        t.label,
        n,
        round(s.rate),
        // Nobody enrolled means nobody is paying, whatever the rate would be.
        round((s.er || 0) * n),
        round((s.ee || 0) * n),
        round(s.rate * n),
      ]);
    }
  }
  return out;
}

/** How the employer and employee amounts were arrived at, in the group's own case. */
export function splitNote(data: KennionData, g: Group, eePct: number, depPct: number): string {
  return hasActualSplit(data, g)
    ? "Employer and employee amounts are the contributions configured in your Employee Navigator payroll setup — not an estimate."
    : `Employer and employee amounts are illustrative: your payroll contributions are not in the data we hold, so they are modelled at ${eePct}% of the employee rate and ${depPct}% of the dependent cost.`;
}

/** Where the figures came from — the line the page used to carry. */
export function sourceNote(data: KennionData): string {
  const m = data.funding?.month;
  const when = m
    ? new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;
  return when
    ? `Rates as billed in ${when}; enrollment from your Employee Navigator export.`
    : "Enrollment and rates from your Employee Navigator export.";
}

const DISCLAIMER =
  "For general information and discussion only. Rates are determined by the carrier and are not final until the group is enrolled with the carrier.";

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

  const plans = planRowsFor(data, overrides, g, rows, eePct, depPct);
  const enrolled = plans.reduce((n, r) => n + (r[1] as number), 0);
  const erTotal = plans.reduce((n, r) => n + (r[COLUMNS.length - 3] as number), 0);
  const eeTotal = plans.reduce((n, r) => n + (r[COLUMNS.length - 2] as number), 0);
  const premium = plans.reduce((n, r) => n + (r[COLUMNS.length - 1] as number), 0);

  const period =
    g.pyStart && g.pyEnd ? `Plan year ${fmtDate(g.pyStart)} to ${fmtDate(g.pyEnd)}` : "Current plan year";
  const totalRow: Cell[] = [
    `All plans (${plans.length})`,
    enrolled,
    ...TIERS.map(() => ""),
    round(erTotal),
    round(eeTotal),
    round(premium),
  ];

  const sheet1: Cell[][] = [
    [g.name],
    [period],
    [],
    COLUMNS,
    ...plans,
    totalRow,
    [],
    [`${money0(premium * 12)} a year at today's enrollment. ${g.enrolled} employees, ${g.lives} lives with dependents.`],
    [sourceNote(data)],
    [splitNote(data, g, eePct, depPct)],
    ["Tiers with nobody enrolled have no billed rate; those are calculated and are in no total."],
    [DISCLAIMER],
    [`Your live enrollment is in Employee Navigator: ${ENROLL_URL}`],
  ];

  const s1 = XLSX.utils.aoa_to_sheet(sheet1);
  s1["!cols"] = [{ wch: 40 }, { wch: 10 }, ...TIERS.map(() => ({ wch: 18 })), { wch: 18 }, { wch: 18 }, { wch: 18 }];
  // The money columns, over the plan rows and the total row.
  for (let r = 4; r < 4 + plans.length + 1; r++) {
    for (let c = 2; c < COLUMNS.length; c++) {
      const cell = s1[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = "$#,##0.00";
    }
  }
  XLSX.utils.book_append_sheet(book, s1, "Current Plans");

  const tiers = tierRowsFor(data, overrides, g, rows, eePct, depPct);
  if (tiers.length) {
    const sheet2: Cell[][] = [
      [`${g.name} — by tier`],
      [],
      DETAIL_COLUMNS,
      ...tiers,
      ["All plans", "", enrolled, "", round(erTotal), round(eeTotal), round(premium)],
      [],
      [sourceNote(data)],
      [splitNote(data, g, eePct, depPct)],
      [DISCLAIMER],
    ];
    const s2 = XLSX.utils.aoa_to_sheet(sheet2);
    s2["!cols"] = [{ wch: 40 }, { wch: 22 }, { wch: 10 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
    for (let r = 3; r < 3 + tiers.length + 1; r++) {
      for (let c = 3; c < DETAIL_COLUMNS.length; c++) {
        const cell = s2[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === "n") cell.z = "$#,##0.00";
      }
    }
    XLSX.utils.book_append_sheet(book, s2, "By Tier");
  }

  const safe = g.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  XLSX.writeFile(book, `${safe}-current-plans.xlsx`);
}

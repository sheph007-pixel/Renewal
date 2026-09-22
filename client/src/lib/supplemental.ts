/**
 * The Kennion supplemental package - dental, vision, life, disability and the
 * Guardian worksite lines. The rates are the same for every group (this is
 * the master association program, not a per-group quote), so they live in
 * server/data/supplemental-rates.json - the one source of truth both this
 * page and the AI assistant's own context read from, so the assistant can
 * never say a supplemental product "isn't on file": unlike Medical, which
 * is quoted per group, every one of these rates always is. Plan year 2027
 * (calendar year), effective January 1, 2027. All rates are MONTHLY.
 */
import ratesData from "../../../server/data/supplemental-rates.json";

export const SUPPLEMENTAL_YEAR = ratesData.year;
export const SUPPLEMENTAL_EFFECTIVE = ratesData.effective;

export type TierKey = "ee" | "eeCh" | "eeSp" | "fam";

export const SUPPLEMENTAL_TIERS: { key: TierKey; label: string }[] = ratesData.tiers as { key: TierKey; label: string }[];

/** Monthly rates by tier; a missing tier means the rate does not apply. */
export interface SupplementalRow {
  plan: string;
  ee: number;
  eeCh?: number;
  eeSp?: number;
  fam?: number;
}

export interface SupplementalSection {
  id: string;
  product: string;
  carrier: string;
  rows: SupplementalRow[];
}

export const SUPPLEMENTAL_SECTIONS: SupplementalSection[] = ratesData.sections as SupplementalSection[];

/**
 * 100% employer-paid life insurance, Guardian: a flat per-employee monthly
 * rate by benefit amount, no dependent tiers (this is the employer's own
 * cost, not an employee election). Offered on Sign Up alongside the
 * voluntary lines above, which are the employee's own cost and need no
 * employer election.
 */
export interface EmployerLifeOption {
  key: string;
  label: string;
  amount: number | null;
  pepm: number | null;
}
export const EMPLOYER_PAID_LIFE: EmployerLifeOption[] = [
  ...(ratesData.employerPaidLife as EmployerLifeOption[]),
  { key: "none", label: "I don't want Employer Paid Life", amount: null, pepm: null },
];

/** The carrier's own footnote - keep verbatim. */
export const SUPPLEMENTAL_FOOTNOTE = ratesData.footnote;

export const CARRIERS = [
  {
    name: "Guardian",
    covers: "Dental, life/AD&D, accident, critical illness, cancer, hospital and short term disability.",
    linkLabel: "Find a Guardian provider",
    href: "https://www.guardianlife.com/find-a-provider",
  },
  {
    name: "VSP Vision",
    covers: "Vision only.",
    linkLabel: "Find a VSP eye doctor",
    href: "https://www.vsp.com/eye-doctor",
  },
] as const;

// ------------------------------------------------------------------ pay frequency

export type Frequency = "monthly" | "semimonthly" | "biweekly" | "weekly";

/** Periods per year, so a monthly rate converts as monthly × 12 ÷ periods. */
export const FREQUENCIES: { key: Frequency; label: string; periods: number }[] = [
  { key: "monthly", label: "Monthly", periods: 12 },
  { key: "semimonthly", label: "Semi-Monthly", periods: 24 },
  { key: "biweekly", label: "Bi-Weekly", periods: 26 },
  { key: "weekly", label: "Weekly", periods: 52 },
];

export function frequencyLabel(f: Frequency): string {
  return FREQUENCIES.find((x) => x.key === f)?.label ?? "Monthly";
}

/** Convert a monthly rate to the pay frequency, rounded to cents. */
export function convertRate(monthly: number, f: Frequency): number {
  const periods = FREQUENCIES.find((x) => x.key === f)?.periods ?? 12;
  return Math.round(((monthly * 12) / periods) * 100) / 100;
}

// ------------------------------------------------------------------ Excel

type Cell = string | number;

function sheetFor(XLSX: typeof import("xlsx"), f: Frequency) {
  const label = frequencyLabel(f);
  const rows: Cell[][] = [
    ["Kennion Supplemental Package"],
    [`${SUPPLEMENTAL_YEAR} calendar year · rates effective ${SUPPLEMENTAL_EFFECTIVE} · ${label} rates`],
    [],
  ];
  const moneyRows: number[] = [];
  for (const s of SUPPLEMENTAL_SECTIONS) {
    rows.push([`${s.product} · ${s.carrier}`]);
    rows.push(["Plan", ...SUPPLEMENTAL_TIERS.map((t) => t.label)]);
    for (const row of s.rows) {
      moneyRows.push(rows.length);
      rows.push([row.plan, ...SUPPLEMENTAL_TIERS.map((t) => (row[t.key] == null ? "-" : convertRate(row[t.key]!, f)))]);
    }
    rows.push([`Carrier/TPA: ${s.carrier}`]);
    rows.push([SUPPLEMENTAL_FOOTNOTE]);
    rows.push([]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 34 }, ...SUPPLEMENTAL_TIERS.map(() => ({ wch: 22 }))];
  for (const r of moneyRows) {
    for (let c = 1; c <= SUPPLEMENTAL_TIERS.length; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = "$#,##0.00";
    }
  }
  return sheet;
}

/** One workbook: the grid at the chosen pay frequency, plus Monthly always. */
export async function downloadSupplementalSheet(f: Frequency): Promise<void> {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheetFor(XLSX, f), frequencyLabel(f));
  if (f !== "monthly") XLSX.utils.book_append_sheet(book, sheetFor(XLSX, "monthly"), "Monthly");
  XLSX.writeFile(book, `kennion-supplemental-package-${SUPPLEMENTAL_YEAR}-${f}.xlsx`);
}

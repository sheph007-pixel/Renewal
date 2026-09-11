/**
 * The Kennion supplemental package — dental, vision, life, disability and the
 * Guardian worksite lines. The rates are the same for every group, so they
 * live here as data rather than coming off any export. Plan year 2027
 * (calendar year), effective January 1, 2027. All rates are MONTHLY.
 */

export const SUPPLEMENTAL_YEAR = 2027;
export const SUPPLEMENTAL_EFFECTIVE = "January 1, 2027";

export type TierKey = "ee" | "eeCh" | "eeSp" | "fam";

export const SUPPLEMENTAL_TIERS: { key: TierKey; label: string }[] = [
  { key: "ee", label: "Employee" },
  { key: "eeCh", label: "Employee + Child(ren)" },
  { key: "eeSp", label: "Employee + Spouse" },
  { key: "fam", label: "Employee + Family" },
];

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

const r = (plan: string, ee: number, eeCh?: number, eeSp?: number, fam?: number): SupplementalRow =>
  eeCh == null ? { plan, ee } : { plan, ee, eeCh, eeSp, fam };

export const SUPPLEMENTAL_SECTIONS: SupplementalSection[] = [
  {
    id: "dental",
    product: "Dental",
    carrier: "Guardian",
    rows: [
      r("Advantage Dental (W Ortho)", 52.52, 93.03, 81.63, 123.14),
      r("Complete Dental (W Ortho)", 45.66, 80.89, 70.97, 107.09),
      r("Value Dental (W Ortho)", 40.88, 77.75, 68.0, 103.53),
      r("Complete Dental", 41.67, 65.34, 57.83, 87.01),
      r("Value Dental", 36.87, 59.93, 52.49, 79.65),
      r("Basic Dental", 29.36, 55.83, 48.81, 74.34),
      r("Choice Dental", 20.43, 38.86, 33.98, 51.73),
    ],
  },
  {
    id: "vision",
    product: "Vision",
    carrier: "VSP",
    rows: [
      r("Premium Vision", 8.71, 18.65, 17.42, 29.8),
      r("Standard Vision", 7.69, 16.46, 15.4, 26.32),
      r("Value Vision", 7.34, 15.7, 14.69, 25.11),
      r("Base Vision", 3.62, 7.75, 7.24, 12.38),
    ],
  },
  {
    id: "life",
    product: "Voluntary Life/AD&D",
    carrier: "Guardian",
    rows: [
      r("Under Age 30", 10.2, 12.0, 15.3, 17.1),
      r("Age 30-34", 11.5, 13.3, 17.25, 19.05),
      r("Age 35-39", 14.1, 15.9, 21.15, 22.95),
      r("Age 40-44", 17.3, 19.1, 25.95, 27.75),
      r("Age 45-49", 25.8, 27.6, 38.7, 40.5),
      r("Age 50-54", 41.2, 43.0, 61.8, 63.6),
      r("Age 55-59", 58.9, 60.7, 88.35, 90.15),
    ],
  },
  {
    id: "accident",
    product: "Accident Insurance",
    carrier: "Guardian",
    rows: [r("Accident Insurance", 13.41, 23.34, 20.66, 30.59)],
  },
  {
    id: "critical",
    product: "Critical Illness Insurance",
    carrier: "Guardian",
    rows: [
      r("Under Age 30", 4.4, 4.4, 6.6, 6.6),
      r("Age 30-39", 6.3, 6.3, 9.45, 9.45),
      r("Age 40-49", 12.4, 12.4, 18.6, 18.6),
      r("Age 50-59", 23.5, 23.5, 35.25, 35.25),
    ],
  },
  {
    id: "cancer",
    product: "Cancer Insurance",
    carrier: "Guardian",
    rows: [r("Cancer Insurance", 11.21, 13.18, 22.76, 24.73)],
  },
  {
    id: "hospital",
    product: "Hospital Insurance",
    carrier: "Guardian",
    rows: [
      r("Enhanced Hospital Plan", 70.0, 118.71, 141.89, 190.59),
      r("Preferred Hospital Plan", 47.09, 80.87, 95.33, 129.11),
      r("Basic Hospital Plan", 34.04, 58.43, 68.58, 92.98),
      r("Choice Hospital Plan", 19.99, 34.87, 40.19, 55.08),
    ],
  },
  {
    id: "std",
    product: "Voluntary Short Term Disability",
    carrier: "Guardian",
    rows: [
      r("Under Age 25", 28.0),
      r("Age 25-29", 39.0),
      r("Age 30-34", 64.0),
      r("Age 35-39", 53.0),
      r("Age 40-44", 32.5),
      r("Age 45-49", 31.0),
      r("Age 50-54", 39.0),
      r("Age 55-59", 45.0),
    ],
  },
];

/** The carrier's own footnote — keep verbatim. */
export const SUPPLEMENTAL_FOOTNOTE =
  "Rates shown for: Vol. Life $100K EE / $50K Spouse / $10K Child(ren). Critical Illness $10K EE / $5K Spouse / $2.5K Child(ren). Vol. Disability $500 weekly benefit (Vol. Disability is not available for all groups). Additional rates for age 60+ available in platform.";

export const PROGRAM_URL = "https://www.kennionprogram.com";

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
      rows.push([row.plan, ...SUPPLEMENTAL_TIERS.map((t) => (row[t.key] == null ? "—" : convertRate(row[t.key]!, f)))]);
    }
    rows.push([`Carrier: ${s.carrier}`]);
    rows.push([SUPPLEMENTAL_FOOTNOTE]);
    rows.push([]);
  }
  rows.push([`View program details: ${PROGRAM_URL}`]);

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

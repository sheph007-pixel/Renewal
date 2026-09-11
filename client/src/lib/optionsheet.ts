/**
 * The 2027 options grid as an Excel file: the rows on screen, in the order
 * shown, plus a Compare sheet when plans are being compared side by side.
 * Loaded on demand, since the xlsx library is the largest thing in the app.
 */
import * as XLSX from "xlsx";
import { TIERS, fmtDed, type Group, type MarketPlan, type TierKey } from "@/lib/model";
import { costSplit } from "@/views/OptionsGrid";

const carrierOf = (p: MarketPlan) => p.carrier.replace(" (UnitedHealthcare)", " by UHC");

function optionRow(p: MarketPlan, today: number, budget: Record<TierKey, number>, counts: Record<TierKey, number>) {
  const sp = costSplit(p, budget, counts);
  return {
    Carrier: carrierOf(p),
    Plan: p.plan,
    Funding: p.label,
    Type: p.type,
    Network: p.network,
    Deductible: p.ded == null ? "" : fmtDed(p.ded),
    "OOP Max": p.oop ?? "",
    "PCP / SPC": p.copays,
    Rx: p.rx,
    Employee: p.rates.EE ?? "",
    "EE + Spouse": p.rates.ES ?? "",
    "EE + Child(ren)": p.rates.EC ?? "",
    "EE + Family": p.rates.FAM ?? "",
    "Employer Cost": sp ? sp.er : "",
    "Employees Pay": sp ? sp.ee : "",
    "Monthly Premium": p.monthly ?? "",
    "Vs Today": p.monthly == null ? "" : +(p.monthly - today).toFixed(2),
    Basis: p.quoted ? `Quoted ${p.quoted.date || ""}`.trim() : p.indicative ? "Indicative" : p.pending ? "Quote requested" : "Menu rate",
  };
}

export function downloadOptions(
  g: Group,
  list: MarketPlan[],
  compare: MarketPlan[],
  today: number,
  budget: Record<TierKey, number>,
  counts: Record<TierKey, number>,
) {
  const book = XLSX.utils.book_new();
  const rows = list.map((p) => optionRow(p, today, budget, counts));
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = [18, 40, 14, 12, 26, 12, 10, 22, 30, 11, 12, 14, 12, 14, 14, 16, 12, 18].map((wch) => ({ wch }));
  const bsheet = XLSX.utils.aoa_to_sheet([
    ["Tier", "Enrolled", "Monthly budget each"],
    ...TIERS.map((t) => [t.label, counts[t.key] || 0, budget[t.key] || 0]),
    ["Total", TIERS.reduce((n, t) => n + (counts[t.key] || 0), 0), TIERS.reduce((n, t) => n + (counts[t.key] || 0) * (budget[t.key] || 0), 0)],
  ]);
  bsheet["!cols"] = [{ wch: 24 }, { wch: 10 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(book, bsheet, "Budget");
  XLSX.utils.book_append_sheet(book, sheet, "2027 Options");
  if (compare.length) {
    // Attributes down the side, one column per plan — the way the page shows it.
    const attrs: [string, (p: MarketPlan) => string | number][] = [
      ["Carrier", carrierOf],
      ["Funding", (p) => p.label],
      ["Type", (p) => p.type],
      ["Network", (p) => p.network],
      ["Deductible", (p) => (p.ded == null ? "" : fmtDed(p.ded))],
      ["OOP Max", (p) => p.oop ?? ""],
      ["PCP / SPC", (p) => p.copays],
      ["Rx", (p) => p.rx],
      ...TIERS.map((t): [string, (p: MarketPlan) => string | number] => [t.label, (p) => p.rates[t.key] ?? ""]),
      ["Employer Cost", (p) => costSplit(p, budget, counts)?.er ?? ""],
      ["Employees Pay", (p) => costSplit(p, budget, counts)?.ee ?? ""],
      ["Monthly Premium", (p) => p.monthly ?? ""],
      ["Vs Today", (p) => (p.monthly == null ? "" : +(p.monthly - today).toFixed(2))],
    ];
    const aoa = [["", ...compare.map((p) => p.plan)], ...attrs.map(([label, f]) => [label, ...compare.map(f)])];
    const cs = XLSX.utils.aoa_to_sheet(aoa);
    cs["!cols"] = [{ wch: 18 }, ...compare.map(() => ({ wch: 34 }))];
    XLSX.utils.book_append_sheet(book, cs, "Compare");
  }
  const safe = g.name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  XLSX.writeFile(book, `${safe}-2027-options.xlsx`);
}

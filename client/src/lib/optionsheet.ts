/**
 * The 2027 options as an Excel file: the Employer Contribution, the grid as
 * shown, and a Proposal sheet with one block per chosen plan laid out the way
 * the plan card reads. Loaded on demand, since xlsx is the largest library.
 */
import * as XLSX from "xlsx";
import { TIERS, costSplit, fmtDed, type Group, type MarketPlan, type TierContribution, type TierKey } from "@/lib/model";
import { cardModel } from "@/views/PlanCard";

const carrierOf = (p: MarketPlan) => p.carrier.replace(" (UnitedHealthcare)", " by UHC");

function optionRow(p: MarketPlan, today: number, contribution: Record<TierKey, number>, counts: Record<TierKey, number>) {
  const sp = costSplit(p, contribution, counts);
  return {
    Carrier: carrierOf(p),
    Plan: p.plan,
    Funding: p.label,
    Type: p.type,
    Network: p.network,
    Deductible: p.ded == null ? "" : fmtDed(p.ded),
    "OOP Max": p.oop ?? "",
    Coinsurance: p.coins ?? "",
    "PCP / SPC": p.copays,
    "Urgent Care": p.uc ?? "",
    "Emergency Room": p.er ?? "",
    Rx: p.rx,
    Employee: p.rates.EE ?? "",
    "EE + Spouse": p.rates.ES ?? "",
    "EE + Child(ren)": p.rates.EC ?? "",
    "EE + Family": p.rates.FAM ?? "",
    "Employer Cost": sp ? sp.er : "",
    "Employees Pay": sp ? sp.ee : "",
    "Monthly Premium": p.monthly ?? "",
    "Vs Today": p.monthly == null ? "" : +(p.monthly - today).toFixed(2),
    Basis: p.quoted ? `Quoted ${p.quoted.date || ""}`.trim() : p.indicative ? "Illustrative" : p.pending ? "Quote requested" : "Menu rate",
  };
}

export function downloadOptions(
  g: Group,
  list: MarketPlan[],
  proposed: MarketPlan[],
  today: number,
  contribution: Record<TierKey, number>,
  counts: Record<TierKey, number>,
  todayByTier: TierContribution[],
) {
  const book = XLSX.utils.book_new();

  const csheet = XLSX.utils.aoa_to_sheet([
    ["Tier", "Enrolled", "Monthly contribution each", "Today"],
    ...TIERS.map((t) => [t.label, counts[t.key] || 0, contribution[t.key] || 0, todayByTier.find((c) => c.key === t.key)?.er ?? ""]),
    ["Total", TIERS.reduce((n, t) => n + (counts[t.key] || 0), 0), TIERS.reduce((n, t) => n + (counts[t.key] || 0) * (contribution[t.key] || 0), 0), ""],
  ]);
  csheet["!cols"] = [{ wch: 24 }, { wch: 10 }, { wch: 26 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(book, csheet, "Employer Contribution");

  const sheet = XLSX.utils.json_to_sheet(list.map((p) => optionRow(p, today, contribution, counts)));
  sheet["!cols"] = [18, 40, 14, 12, 26, 12, 10, 12, 22, 22, 16, 30, 11, 12, 14, 12, 14, 14, 16, 12, 18].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(book, sheet, "2027 Options");

  if (proposed.length) {
    const rows: (string | number)[][] = [
      [`${g.name} · 2027 Medical Options Proposal`],
      [`Priced at ${TIERS.reduce((n, t) => n + (counts[t.key] || 0), 0)} enrolled · employer contribution ${TIERS.map((t) => `${t.short} $${(contribution[t.key] || 0).toFixed(2)}`).join(" · ")} per month`],
      [],
    ];
    for (const p of proposed) {
      const m = cardModel(p, contribution, counts, today);
      rows.push([`${m.carrier} · ${m.plan}`, m.funding + (m.type ? ` · ${m.type}` : "")]);
      rows.push(["Total Monthly Cost", m.monthly ?? ""]);
      rows.push(["Basis", m.basis]);
      for (const [label, value] of m.benefits) rows.push([label, value]);
      rows.push(["Monthly Composite Rates", "Rate", "Employer", "Employee"]);
      for (const t of m.tiers) rows.push([`${t.label} (${t.count})`, t.rate ?? "", t.er ?? "", t.ee ?? ""]);
      rows.push(["Total Monthly Employer Cost", m.er ?? ""]);
      rows.push(["Total Monthly Employee Cost", m.ee ?? ""]);
      rows.push(["Monthly Premium", m.premium ?? ""]);
      if (m.vsToday != null) rows.push(["Vs today", m.vsToday]);
      rows.push([]);
    }
    const ps = XLSX.utils.aoa_to_sheet(rows);
    ps["!cols"] = [{ wch: 30 }, { wch: 44 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(book, ps, "Proposal");
  }
  const safe = g.name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  XLSX.writeFile(book, `${safe}-2027-options.xlsx`);
}

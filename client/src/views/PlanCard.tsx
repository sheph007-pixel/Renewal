import { TIERS, costSplit, fmtDate, fmtDed, money, money0, tierSplit, type MarketPlan, type TierKey } from "@/lib/model";
import { C, num } from "@/lib/ui";

/**
 * One plan, the way a broker's comparison card reads: the carrier and plan,
 * one big Total Monthly Cost, the benefits, the composite rates with how
 * many are enrolled in each tier and what employer and employee each pay
 * at the applied contribution, then the three totals. The same card is the
 * popup, the proposal on screen, the printed proposal and the Excel block.
 */
export interface CardModel {
  carrier: string;
  plan: string;
  funding: string;
  type: string | null;
  basis: string;
  quoted: boolean;
  monthly: number | null;
  benefits: [string, string][];
  tiers: { key: TierKey; label: string; count: number; rate: number | null; er: number | null; ee: number | null }[];
  er: number | null;
  ee: number | null;
  premium: number | null;
  vsToday: number | null;
}

export const TIER_NAMES: Record<TierKey, string> = { EE: "Employee Only", ES: "Employee + Spouse", EC: "Employee + Children", FAM: "Employee + Family" };

export const carrierOf = (p: MarketPlan) => p.carrier.replace(" (UnitedHealthcare)", "");

/** How the plan is funded, from what the carrier said or the carrier itself. */
export function fundingOf(p: MarketPlan): string {
  const t = `${p.label} ${p.type}`;
  if (/fully/i.test(t)) return "Fully Insured";
  if (/self/i.test(t)) return "Self Funded";
  if (/level/i.test(t) || /Gravie|UnitedHealthcare|Surest/i.test(p.carrier)) return "Level Funded";
  return p.label || "Quoted";
}

export const basisOf = (p: MarketPlan) =>
  p.quoted ? `Quoted for you · ${fmtDate(p.quoted.date || undefined)}` : p.indicative ? "Illustrative rate" : p.pending ? "Quote requested" : "Carrier menu rate";

export function cardModel(p: MarketPlan, contribution: Record<TierKey, number>, counts: Record<TierKey, number>, today: number): CardModel {
  const sp = costSplit(p, contribution, counts);
  const benefits: [string, string | null | undefined][] = [
    ["Deductible", p.ded == null ? null : fmtDed(p.ded)],
    ["Out-of-pocket max", p.oop == null ? null : money0(p.oop)],
    ["Coinsurance", p.coins],
    ["Primary / specialist visit", p.copays],
    ["Urgent care", p.uc],
    ["Emergency room", p.er],
    ["Labs & imaging", p.labs],
    ["Hospital stay", p.hospital],
    ["Prescription drugs", p.rx],
    ["Network", p.network],
  ];
  const type = p.type && p.type !== p.label && p.type !== fundingOf(p) ? p.type : null;
  return {
    carrier: carrierOf(p),
    plan: p.plan,
    funding: fundingOf(p),
    type,
    basis: basisOf(p),
    quoted: !!p.quoted,
    monthly: p.monthly,
    benefits: benefits.filter((b): b is [string, string] => !!b[1] && b[1] !== "On the proposal"),
    tiers: TIERS.map((t) => {
      const s = tierSplit(p, contribution, t.key);
      return { key: t.key, label: TIER_NAMES[t.key], count: counts[t.key] || 0, rate: s?.rate ?? null, er: s?.er ?? null, ee: s?.ee ?? null };
    }),
    er: sp?.er ?? null,
    ee: sp?.ee ?? null,
    premium: sp?.total ?? p.monthly,
    vsToday: p.monthly == null || !today ? null : +(p.monthly - today).toFixed(2),
  };
}

export default function PlanCard({ m, actions }: { m: CardModel; actions?: React.ReactNode }) {
  return (
    <div className="card panel" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, padding: "16px 18px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: C.muted }}>{m.carrier}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: C.blueInk, background: C.blueTint, border: `1px solid ${C.blueEdge}`, borderRadius: 10, padding: "1px 8px" }}>{m.funding}</span>
          {m.type && <span style={{ fontSize: 11, color: C.faint }}>{m.type}</span>}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.ink, lineHeight: 1.3, marginTop: 4 }}>{m.plan}</div>
      </div>
      <div style={{ textAlign: "center", padding: "6px 0 8px", borderTop: `1px solid ${C.hairline}`, borderBottom: `1px solid ${C.hairline}` }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: C.ink, letterSpacing: "-0.5px", ...num }}>{m.monthly == null ? "—" : money(m.monthly)}</div>
        <div style={{ fontSize: 12.5, color: C.muted }}>Total Monthly Cost</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: m.quoted ? C.green : C.amber, marginTop: 2 }}>{m.basis}</div>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
        <tbody>
          {m.benefits.map(([label, value]) => (
            <tr key={label}>
              <td style={{ padding: "4px 8px 4px 0", color: C.muted, verticalAlign: "top", whiteSpace: "nowrap" }}>{label}</td>
              <td style={{ padding: "4px 0", color: C.ink, textAlign: "right", fontWeight: 500 }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, borderBottom: `1px solid ${C.hairline}`, paddingBottom: 4 }}>Monthly Composite Rates</div>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5, marginTop: 2 }}>
          <thead>
            <tr>
              {["", "Rate", "Employer", "Employee"].map((h, i) => (
                <th key={h || "tier"} style={{ padding: "3px 0", fontSize: 11, fontWeight: 500, color: C.faint, textAlign: i ? "right" : "left" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.tiers.map((t) => (
              <tr key={t.key}>
                <td style={{ padding: "3px 8px 3px 0", color: C.muted, whiteSpace: "nowrap" }}>
                  {t.label} <span style={{ color: C.faint }}>({t.count})</span>
                </td>
                <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.ink, ...num }}>{t.rate == null ? "—" : money(t.rate)}</td>
                <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.er == null ? "—" : money(t.er)}</td>
                <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.ee == null ? "—" : money(t.ee)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, borderTop: `1px solid ${C.hairline}`, paddingTop: 4 }}>
        <tbody>
          {(
            [
              ["Total Monthly Employer Cost", m.er, true],
              ["Total Monthly Employee Cost", m.ee, true],
              ["Monthly Premium", m.premium, false],
            ] as [string, number | null, boolean][]
          ).map(([label, v, strong]) => (
            <tr key={label}>
              <td style={{ padding: "4px 8px 4px 0", color: strong ? C.ink : C.muted, fontWeight: strong ? 600 : 400 }}>{label}</td>
              <td style={{ padding: "4px 0", textAlign: "right", color: C.ink, fontWeight: strong ? 600 : 500, ...num }}>{v == null ? "—" : money(v)}</td>
            </tr>
          ))}
          {m.vsToday != null && (
            <tr>
              <td style={{ padding: "4px 8px 4px 0", color: C.muted }}>Vs today</td>
              <td style={{ padding: "4px 0", textAlign: "right", fontWeight: 600, color: m.vsToday >= 0 ? C.red : C.green, ...num }}>
                {m.vsToday >= 0 ? "+" : "−"}
                {money0(Math.abs(m.vsToday))} / mo
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {actions && <div className="noprint" style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>{actions}</div>}
    </div>
  );
}

import { TIERS, networkDirectory, networkTypeOf, pbmOf, splitCopays, costSplit, fmtDed, money, money0, tierSplit, type MarketPlan, type TierKey } from "@/lib/model";
import { C, num } from "@/lib/ui";
import CarrierMark from "@/views/CarrierMark";

/**
 * One plan, the way a broker's comparison card reads: the carrier and plan,
 * one big Total Monthly Cost, the benefits, the composite rates with how
 * many are enrolled in each tier and what employer and employee each pay
 * at the applied contribution, then the three totals. The same card is the
 * popup, the proposal on screen, the printed proposal and the Excel block.
 */
export interface CardModel {
  /** UH3, GR1 — the handle the client, Kennion and the assistant all use for this plan. */
  optionId: string | null;
  carrier: string;
  links: { directory: { name: string; url: string } | null; formulary: { name: string; url: string } | null };
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
  /** The proposal the figures came from and whether it was audited; absent for an illustrative plan. */
  source?: { proposalId: number; audit: { status: "pass" | "issues" | "unreadable"; completedAt: string } | null } | null;
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

/** Where the figures come from: always the carrier's own quote for this group — read off its proposal, or quoted on the menu. */
export const basisOf = (p: MarketPlan) => (p.quoted ? "Carrier Proposal" : "Carrier Quote");

export function cardModel(p: MarketPlan, contribution: Record<TierKey, number>, counts: Record<TierKey, number>): CardModel {
  const sp = costSplit(p, contribution, counts);
  const benefits: [string, string | null | undefined][] = [
    ["Deductible", p.ded == null ? null : fmtDed(p.ded)],
    ["Out-of-pocket max", p.oop == null ? null : money0(p.oop)],
    ["Doctor visit", p.pcp ?? splitCopays(p.copays)[0]],
    ["Specialist", p.specialist ?? splitCopays(p.copays)[1]],
    ["Imaging", p.imaging],
    ["Urgent care", p.uc],
    ["Hospital", p.hospital],
    ["Prescription drugs", p.rx],
    ["Network type", networkTypeOf(p)],
    ["Network", p.network],
    ["Pharmacy (PBM)", pbmOf(p.carrier)?.name ?? null],
  ];
  const type = p.type && p.type !== p.label && p.type !== fundingOf(p) ? p.type : null;
  return {
    optionId: p.optionId ?? null,
    carrier: carrierOf(p),
    /** Where to look things up on this plan: the provider directory and the PBM's formulary, where Kennion has the link. */
    links: { directory: networkDirectory(p.network), formulary: pbmOf(p.carrier) },
    plan: p.plan,
    funding: fundingOf(p),
    type,
    basis: basisOf(p),
    quoted: !!p.quoted,
    monthly: p.monthly,
    // The same rows on every plan, so cards read alike; "—" where the carrier's document (or Kennion's links) does not say.
    benefits: benefits.map(([k, v]): [string, string] => [k, v && v !== "On the proposal" ? v : "—"]),
    tiers: TIERS.map((t) => {
      const s = tierSplit(p, contribution, t.key);
      return { key: t.key, label: TIER_NAMES[t.key], count: counts[t.key] || 0, rate: s?.rate ?? null, er: s?.er ?? null, ee: s?.ee ?? null };
    }),
    er: sp?.er ?? null,
    ee: sp?.ee ?? null,
    premium: sp?.total ?? p.monthly,
    source: p.quoted ? { proposalId: p.quoted.proposalId, audit: p.quoted.audit || null } : null,
  };
}

/**
 * The card's footer: the figures above were checked against the carrier's
 * own quote, and when. The document itself and who did the checking are
 * Kennion's business, on the Proposals page; the client sees the verdict.
 * A plan whose audit found something reads as under review; one not yet
 * audited says so; an illustrative plan has no footer.
 */
function AuditFoot({ source }: { source: NonNullable<CardModel["source"]> }) {
  const a = source.audit;
  const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const foot = { display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: "2px 8px", fontSize: 11.5, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8 };
  if (a && a.status === "pass") {
    return (
      <div className="noprint" style={foot} title="The plan name, benefits and rates shown here were checked against the carrier's own quote">
        <span style={{ color: C.green, fontWeight: 600 }}>✓ Proposal Audit Completed</span>
        <span>{when(a.completedAt)}</span>
      </div>
    );
  }
  return (
    <div className="noprint" style={foot}>
      <span style={{ color: C.amber, fontWeight: 600 }}>{a ? "Proposal audit: under review by Kennion" : "Proposal audit pending"}</span>
    </div>
  );
}

export default function PlanCard({ m, actions, compact }: { m: CardModel; actions?: React.ReactNode; compact?: boolean }) {
  const tiers = compact ? m.tiers.filter((t) => t.count > 0) : m.tiers;
  const benefits = compact ? m.benefits.filter(([label]) => ["Deductible", "Out-of-pocket max", "Network type", "Network", "Pharmacy (PBM)"].includes(label)) : m.benefits;
  return (
    <div className="card panel" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, padding: "16px 18px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {m.optionId && <span style={{ fontSize: 12, fontWeight: 700, color: C.onColor, background: C.navy, borderRadius: 6, padding: "2px 8px", letterSpacing: "0.3px", fontVariantNumeric: "tabular-nums" }}>{m.optionId}</span>}
          <CarrierMark name={m.carrier} size={20} fontSize={12.5} color={C.muted} />
          <span style={{ fontSize: 11, fontWeight: 600, color: C.blueInk, background: C.blueTint, border: `1px solid ${C.blueEdge}`, borderRadius: 10, padding: "1px 8px" }}>{m.funding}</span>
          {m.type && !compact && <span style={{ fontSize: 11, color: C.faint }}>{m.type}</span>}
        </div>
        <div style={{ fontSize: compact ? 15 : 16, fontWeight: 600, color: C.ink, lineHeight: 1.3, marginTop: 4, minHeight: compact ? 40 : undefined }}>{m.plan}</div>
      </div>
      <div style={{ textAlign: "center", padding: "6px 0 8px", borderTop: `1px solid ${C.hairline}`, borderBottom: `1px solid ${C.hairline}` }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: C.ink, letterSpacing: "-0.5px", ...num }}>{m.monthly == null ? "—" : money(m.monthly)}</div>
        <div style={{ fontSize: 12.5, color: C.muted }}>Total Monthly Cost</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: m.quoted ? C.green : C.amber, marginTop: 2 }}>{m.basis}</div>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
        <tbody>
          {benefits.map(([label, value]) => {
            // Lookups sit on their row: the directory on Network, the formulary on Pharmacy.
            const link = label === "Network" && m.links.directory ? { ...m.links.directory, text: "Find a doctor" } : label === "Pharmacy (PBM)" && m.links.formulary ? { ...m.links.formulary, text: "Formulary" } : null;
            return (
              <tr key={label}>
                <td style={{ padding: "4px 8px 4px 0", color: C.muted, verticalAlign: "top", whiteSpace: "nowrap" }}>{label}</td>
                <td style={{ padding: "4px 0", color: C.ink, textAlign: "right", fontWeight: 500 }}>
                  {value}
                  {link && value !== "—" && (
                    <>
                      {" · "}
                      <a href={link.url} target="_blank" rel="noreferrer" title={link.name} onClick={(e) => e.stopPropagation()} style={{ color: C.blue, fontWeight: 500, whiteSpace: "nowrap" }}>
                        {link.text}
                      </a>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, borderBottom: `1px solid ${C.hairline}`, paddingBottom: 4 }}>Monthly Composite Rates</div>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5, marginTop: 2 }}>
          {!compact && (
            <thead>
              <tr>
                {["", "Rate", "Employer", "Employee"].map((h, i) => (
                  <th key={h || "tier"} style={{ padding: "3px 0", fontSize: 11, fontWeight: 500, color: C.faint, textAlign: i ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {tiers.map((t) => (
              <tr key={t.key}>
                <td style={{ padding: "3px 8px 3px 0", color: C.muted, whiteSpace: "nowrap" }}>
                  {t.label} <span style={{ color: C.faint }}>({t.count})</span>
                </td>
                <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.ink, ...num }}>{t.rate == null ? "—" : money(t.rate)}</td>
                {/* A tier nobody is in has no split to show: the contribution for it is a default, not a decision. */}
                {!compact && <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.er == null || !t.count ? "—" : money(t.er)}</td>}
                {!compact && <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.ee == null || !t.count ? "—" : money(t.ee)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, borderTop: `1px solid ${C.hairline}`, paddingTop: 4 }}>
        <tbody>
          {(
            [
              ["Employer Cost", m.er, true],
              ["Employee Cost", m.ee, true],
              ["Monthly Premium", m.premium, false],
            ] as [string, number | null, boolean][]
          ).map(([label, v, strong]) => {
            const pct = strong && v != null && m.premium ? Math.round((v / m.premium) * 100) : null;
            return (
              <tr key={label}>
                <td style={{ padding: "4px 8px 4px 0", color: strong ? C.ink : C.muted, fontWeight: strong ? 600 : 400 }}>{label}</td>
                <td style={{ padding: "4px 0", textAlign: "right", color: C.ink, fontWeight: strong ? 600 : 500, ...num }}>
                  {v == null ? "—" : money(v)}
                  {pct != null && <span style={{ color: C.faint, fontWeight: 400 }}> ({pct}%)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {m.source && <AuditFoot source={m.source} />}
      {actions && <div className="noprint" style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>{actions}</div>}
    </div>
  );
}

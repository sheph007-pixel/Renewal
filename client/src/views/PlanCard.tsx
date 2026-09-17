import { useState } from "react";
import { FREQS, TIERS, networkDirectory, networkTypeOf, pbmOf, splitCopays, costSplit, fmtDed, money, money0, tierSplit, type MarketPlan, type TierKey, ILLUSTRATIVE_QUOTE, RATE_NOTICE_SHORT } from "@/lib/model";
import Link from "@/lib/Link";
import { C, num } from "@/lib/ui";
import CarrierMark from "@/views/CarrierMark";
import InfoTip from "@/views/InfoTip";

/**
 * One plan, the way a broker's comparison card reads: the carrier and plan,
 * one big Average Employee Monthly Contribution (what employees pay, over
 * everyone enrolled) with Your Company Pays under it, the benefits, the composite rates with how many are
 * enrolled in each tier and what employer and employee each pay at the
 * applied contribution, then the three totals. The same card is the popup,
 * the proposal on screen, the printed proposal and the Excel block.
 */
export interface CardModel {
  /** UH3, GR1 - the handle the client, Kennion and the assistant all use for this plan. */
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
  /** Everyone enrolled, across the tiers - what the employee share is averaged over. */
  enrolled: number;
  /** The proposal the figures came from and whether it was audited; absent for an illustrative plan. */
  source?: { proposalId: number; audit: { status: "pass" | "issues" | "unreadable"; completedAt: string } | null } | null;
}

export const TIER_NAMES: Record<TierKey, string> = { EE: "Employee Only", ES: "Employee + Spouse", EC: "Employee + Children", FAM: "Employee + Family" };

export const carrierOf = (p: MarketPlan) => p.carrier.replace(" (UnitedHealthcare)", "");

/**
 * How the plan is funded: one of two things. UnitedHealthcare quotes fully
 * insured and level funded; every other carrier and partner is level funded.
 * A plan's design family (Traditional, HDHP, Value) is its type, not its
 * funding, so it never shows up here.
 */
export function fundingOf(p: MarketPlan): "Fully Insured" | "Level Funded" {
  return /fully/i.test(p.label) ? "Fully Insured" : "Level Funded";
}

/** Where the figures come from: always the carrier's own quote for this group - read off its proposal, or quoted on the menu. */
/** Every rate is an illustrative quote, read from the carrier's document or not: never a proposal or an offer. */
export const basisOf = (_p: MarketPlan) => ILLUSTRATIVE_QUOTE;

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
    // The same rows on every plan, so cards read alike; "-" where the carrier's document (or Kennion's links) does not say.
    benefits: benefits.map(([k, v]): [string, string] => [k, v && v !== "On the proposal" ? v : "-"]),
    tiers: TIERS.map((t) => {
      const s = tierSplit(p, contribution, t.key);
      return { key: t.key, label: TIER_NAMES[t.key], count: counts[t.key] || 0, rate: s?.rate ?? null, er: s?.er ?? null, ee: s?.ee ?? null };
    }),
    er: sp?.er ?? null,
    ee: sp?.ee ?? null,
    premium: sp?.total ?? p.monthly,
    enrolled: TIERS.reduce((n, t) => n + (counts[t.key] || 0), 0),
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

export default function PlanCard({ m, actions, compact, wide, disclaimersHref }: { m: CardModel; actions?: React.ReactNode; compact?: boolean; wide?: boolean; disclaimersHref?: string }) {
  const tiers = compact ? m.tiers.filter((t) => t.count > 0) : m.tiers;
  // The pay cycle the rates and totals are shown per: monthly as quoted, or
  // divided down to what comes out of a paycheck. Local to the card; the
  // headline above stays monthly.
  const [freqKey, setFreqKey] = useState<(typeof FREQS)[number]["key"]>("M");
  const freq = FREQS.find((f) => f.key === freqKey) || FREQS[0];
  const per = (v: number | null | undefined) => (v == null ? null : v / freq.div);
  const ratesTitle = freq.key === "M" ? "Monthly Composite Rates" : `${freq.label} Paycheck Deductions`;
  const benefits = compact ? m.benefits.filter(([label]) => ["Deductible", "Out-of-pocket max", "Network type", "Network", "Pharmacy (PBM)"].includes(label)) : m.benefits;
  return (
    <div className="card panel" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, padding: "16px 18px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <CarrierMark name={m.carrier} size={20} fontSize={12.5} color={C.muted} />
          <span style={{ fontSize: 11, fontWeight: 600, color: C.blueInk, background: C.blueTint, border: `1px solid ${C.blueEdge}`, borderRadius: 10, padding: "1px 8px" }}>{m.funding}</span>
          {m.type && !compact && <span style={{ fontSize: 11, color: C.faint }}>{m.type}</span>}
        </div>
        {/* The one way a plan is named everywhere: Carrier/TPA, Option, ID - in bold; the carrier's long name under it. */}
        <div style={{ fontSize: compact ? 15 : 17, fontWeight: 700, color: C.ink, lineHeight: 1.3, marginTop: 4, ...num }}>{m.optionId ? `${m.carrier} Option ${m.optionId}` : m.plan}</div>
        {m.optionId && <div style={{ fontSize: compact ? 12 : 12.5, color: C.muted, lineHeight: 1.3, marginTop: 1, minHeight: compact ? 32 : undefined }}>{m.plan}</div>}
      </div>
      {/* Wide (the grid's dialog): what it costs and what it covers on the
          left, the rates and the split on the right - one screen, no
          scrolling, every card the same shape. Narrow screens stack them. */}
      {wide ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", columnGap: 28, rowGap: 10, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      {/* The headline is what an employee pays on average once the company's
          contribution is in - the figure a client can hold against a paycheck - 
          with what the company pays under it. Both follow the applied contribution. */}
      <div style={{ textAlign: "center", padding: "6px 0 8px", borderTop: `1px solid ${C.hairline}`, borderBottom: `1px solid ${C.hairline}` }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: C.ink, letterSpacing: "-0.5px", ...num }}>{m.ee == null || !m.enrolled ? "-" : money(m.ee / m.enrolled)}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: C.muted }}>
          Average Employee Monthly Contribution
          <InfoTip text="Average employee contribution after your company’s contribution. Actual amounts vary by coverage tier." />
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginTop: 3, ...num }}>
          <span style={{ fontWeight: 500, color: C.muted }}>Your Company Pays: </span>
          {m.er == null ? "-" : money(m.er)}
          <span style={{ fontWeight: 500, color: C.muted }}>/month</span>
        </div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, marginTop: 2 }}>{m.basis}</div>
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
                  {link && value !== "-" && (
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
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div>
        {!compact && (
          <div className="noprint" role="tablist" aria-label="Pay cycle" style={{ display: "flex", gap: 4, marginBottom: 8, padding: 3, borderRadius: 8, background: C.zebra, border: `1px solid ${C.hairline}` }}>
            {FREQS.map((f) => {
              const on = f.key === freq.key;
              return (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={on}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFreqKey(f.key);
                  }}
                  style={{ flex: 1, padding: "6px 4px", fontSize: 12, fontWeight: 600, color: on ? "#fff" : C.body, background: on ? C.blue : "transparent", border: "none", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, borderBottom: `1px solid ${C.hairline}`, paddingBottom: 4 }}>{ratesTitle}</div>
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
                <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.ink, ...num }}>{t.rate == null ? "-" : money(per(t.rate)!)}</td>
                {/* A tier nobody is in has no split to show: the contribution for it is a default, not a decision. */}
                {!compact && <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.er == null || !t.count ? "-" : money(per(t.er)!)}</td>}
                {!compact && <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.ee == null || !t.count ? "-" : money(per(t.ee)!)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, borderTop: `1px solid ${C.hairline}`, paddingTop: 4 }}>
        <tbody>
          {(
            [
              ["Your Company Pays", per(m.er), true],
              ["Your Employees Pay", per(m.ee), true],
              [`Total ${freq.label} Bill`, per(m.premium), false],
            ] as [string, number | null, boolean][]
          ).map(([label, v, strong]) => {
            const total = per(m.premium);
            const pct = strong && v != null && total ? Math.round((v / total) * 100) : null;
            return (
              <tr key={label}>
                <td style={{ padding: "4px 8px 4px 0", color: strong ? C.ink : C.muted, fontWeight: strong ? 600 : 400 }}>{label}</td>
                <td style={{ padding: "4px 0", textAlign: "right", color: C.ink, fontWeight: strong ? 600 : 500, ...num }}>
                  {v == null ? "-" : money(v)}
                  {pct != null && <span style={{ color: C.faint, fontWeight: 400 }}> ({pct}%)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
          </div>
        </div>
      ) : (
        <>
      {/* The headline is what an employee pays on average once the company's
          contribution is in - the figure a client can hold against a paycheck - 
          with what the company pays under it. Both follow the applied contribution. */}
      <div style={{ textAlign: "center", padding: "6px 0 8px", borderTop: `1px solid ${C.hairline}`, borderBottom: `1px solid ${C.hairline}` }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: C.ink, letterSpacing: "-0.5px", ...num }}>{m.ee == null || !m.enrolled ? "-" : money(m.ee / m.enrolled)}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: C.muted }}>
          Average Employee Monthly Contribution
          <InfoTip text="Average employee contribution after your company’s contribution. Actual amounts vary by coverage tier." />
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginTop: 3, ...num }}>
          <span style={{ fontWeight: 500, color: C.muted }}>Your Company Pays: </span>
          {m.er == null ? "-" : money(m.er)}
          <span style={{ fontWeight: 500, color: C.muted }}>/month</span>
        </div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, marginTop: 2 }}>{m.basis}</div>
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
                  {link && value !== "-" && (
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
        {!compact && (
          <div className="noprint" role="tablist" aria-label="Pay cycle" style={{ display: "flex", gap: 4, marginBottom: 8, padding: 3, borderRadius: 8, background: C.zebra, border: `1px solid ${C.hairline}` }}>
            {FREQS.map((f) => {
              const on = f.key === freq.key;
              return (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={on}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFreqKey(f.key);
                  }}
                  style={{ flex: 1, padding: "6px 4px", fontSize: 12, fontWeight: 600, color: on ? "#fff" : C.body, background: on ? C.blue : "transparent", border: "none", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, borderBottom: `1px solid ${C.hairline}`, paddingBottom: 4 }}>{ratesTitle}</div>
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
                <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.ink, ...num }}>{t.rate == null ? "-" : money(per(t.rate)!)}</td>
                {/* A tier nobody is in has no split to show: the contribution for it is a default, not a decision. */}
                {!compact && <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.er == null || !t.count ? "-" : money(per(t.er)!)}</td>}
                {!compact && <td style={{ padding: "3px 0 3px 8px", textAlign: "right", color: C.body, ...num }}>{t.ee == null || !t.count ? "-" : money(per(t.ee)!)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, borderTop: `1px solid ${C.hairline}`, paddingTop: 4 }}>
        <tbody>
          {(
            [
              ["Your Company Pays", per(m.er), true],
              ["Your Employees Pay", per(m.ee), true],
              [`Total ${freq.label} Bill`, per(m.premium), false],
            ] as [string, number | null, boolean][]
          ).map(([label, v, strong]) => {
            const total = per(m.premium);
            const pct = strong && v != null && total ? Math.round((v / total) * 100) : null;
            return (
              <tr key={label}>
                <td style={{ padding: "4px 8px 4px 0", color: strong ? C.ink : C.muted, fontWeight: strong ? 600 : 400 }}>{label}</td>
                <td style={{ padding: "4px 0", textAlign: "right", color: C.ink, fontWeight: strong ? 600 : 500, ...num }}>
                  {v == null ? "-" : money(v)}
                  {pct != null && <span style={{ color: C.faint, fontWeight: 400 }}> ({pct}%)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
        </>
      )}
      {m.source && <AuditFoot source={m.source} />}
      {/* The notice, on the card itself: the card is what gets screenshotted and passed around. */}
      {!compact && (
        <div className="noprint" style={{ fontSize: 10.5, color: C.faint, lineHeight: 1.45, borderTop: `1px solid ${C.hairline}`, paddingTop: 8 }}>
          {RATE_NOTICE_SHORT}
          {disclaimersHref && (
            <>
              {" "}
              <Link href={disclaimersHref} style={{ color: C.blue, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
                View Disclaimers
              </Link>
            </>
          )}
        </div>
      )}
      {actions && <div className="noprint" style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>{actions}</div>}
    </div>
  );
}

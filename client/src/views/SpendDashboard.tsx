import type { ReactNode } from "react";
import { money, money0 } from "@/lib/model";
import InfoTip from "@/views/InfoTip";
import { C, num, panel } from "@/lib/ui";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";

interface Props {
  totals: { er: number; ee: number; total: number };
  enrolled: number;
}

function BuildingIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
      <path d="M10 21v-4h4v4" />
    </svg>
  );
}

function PersonIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1-3.5 4-5.5 7-5.5s6 2 7 5.5" />
    </svg>
  );
}

function StackIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/** A small group mark for the "Monthly Amounts for N Enrolled Employees" line. */
function GroupIcon({ color }: { color: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M17 14.5c2.3 0 4 1.3 4.6 3.5" />
    </svg>
  );
}

/** One figure: what it is, the month, the year, and its share of the bill. */
function SpendTile({ icon, label, tip, amount, pct, bg, edge, fg }: { icon: ReactNode; label: string; tip: string; amount: number; pct?: number; bg: string; edge: string; fg: string }) {
  return (
    <div style={{ flex: "1 1 200px", minWidth: 0, padding: "10px 14px", borderRadius: 8, background: bg, border: `1px solid ${edge}`, display: "flex", alignItems: "center", gap: 10 }}>
      <span aria-hidden style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 7, background: fg, flex: "none" }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: fg, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
          {label}
          <InfoTip text={tip} color={fg} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: C.ink, letterSpacing: "-0.4px", lineHeight: 1.15, ...num }}>
          {money0(amount)}
          <span style={{ fontSize: 12, fontWeight: 500, color: C.faint }}> /mo</span>
          <span style={{ fontSize: 11.5, fontWeight: 500, color: C.faint, marginLeft: 8 }}>{money0(amount * 12)} / yr</span>
        </div>
      </div>
      {pct != null && <span style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 700, color: fg, ...num }}>{pct}%</span>}
    </div>
  );
}

/**
 * The strip a client opens this page to see: Your Company Pays, Your
 * Employees Pay and Total Monthly Bill - the table below's employer cost,
 * employee cost and premium on a group basis - with the split as one thin
 * bar. Read straight off the table's own totals, so the two never disagree.
 * The per-tier estimate that used to sit under it is gone: the rate table
 * carries the figures, and an estimate dressed as four inputs read as
 * something to type over.
 */
export default function SpendDashboard({ totals, enrolled }: Props) {
  const erPct = totals.total ? Math.round((totals.er / totals.total) * 1000) / 10 : 0;
  const eePct = totals.total ? Math.round((100 - erPct) * 10) / 10 : 0;

  return (
    <div style={{ ...panel, padding: "12px 16px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.faint, textTransform: "uppercase", letterSpacing: "0.5px" }}>Current Group Plan</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted }}>
          <GroupIcon color={C.muted} />
          Monthly amounts for {enrolled} enrolled employee{enrolled === 1 ? "" : "s"} · from Employee Navigator, for illustration ·{" "}
          <a href={NAVIGATOR_URL} target="_blank" rel="noreferrer" style={{ color: C.blue, textDecoration: "none" }}>
            View Details
          </a>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <SpendTile icon={<BuildingIcon color="#fff" />} label="Your Company Pays" tip="The monthly contribution your company sets. Your company decides this first; employees pay the rest." amount={totals.er} pct={erPct} bg={C.blueTint} edge={C.blueEdge} fg={C.blue} />
        <SpendTile icon={<PersonIcon color="#fff" />} label="Your Employees Pay" tip="What employees pay each month: the premium left after your company’s contribution." amount={totals.ee} pct={eePct} bg={C.amberTint} edge={C.amberEdge} fg={C.orange} />
        <SpendTile icon={<StackIcon color="#fff" />} label="Total Monthly Bill" tip="The full monthly premium: what your company pays plus what employees pay." amount={totals.total} bg={C.greenTint} edge={C.greenEdge} fg={C.green} />
      </div>

      {/* Employer vs. employee as one thin bar, the legend beside it. */}
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <div role="img" aria-label={`Your company pays ${erPct}% of the bill; employees pay ${eePct}%`} style={{ flex: "1 1 240px", display: "flex", height: 10, borderRadius: 5, overflow: "hidden", border: `1px solid ${C.border}` }}>
          <div style={{ width: `${Math.max(erPct, totals.er > 0 ? 3 : 0)}%`, background: C.blue }} />
          <div style={{ width: `${Math.max(eePct, totals.ee > 0 ? 3 : 0)}%`, background: C.orange }} />
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 11.5, color: C.faint, whiteSpace: "nowrap" }}>
          <span>
            <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: C.blue, marginRight: 5 }} />
            Company {money(totals.er)} · {erPct}%
          </span>
          <span>
            <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: C.orange, marginRight: 5 }} />
            Employees {money(totals.ee)} · {eePct}%
          </span>
        </div>
      </div>
    </div>
  );
}

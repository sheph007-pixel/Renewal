import type { ReactNode } from "react";
import { money, money0, type TierContribution } from "@/lib/model";
import { C, num, panel } from "@/lib/ui";

interface Props {
  totals: { er: number; ee: number; total: number };
  contribution: TierContribution[];
  enrolled: number;
}

const TIER_LABEL: Record<string, string> = {
  EE: "Employee Only",
  ES: "Employee + Spouse",
  EC: "Employee + Children",
  FAM: "Employee + Family",
};

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

/** One big colorful number: what it is, the figure, and the year alongside the month. */
function SpendTile({
  icon,
  label,
  amount,
  pct,
  bg,
  edge,
  fg,
}: {
  icon: ReactNode;
  label: string;
  amount: number;
  pct?: number;
  bg: string;
  edge: string;
  fg: string;
}) {
  return (
    <div style={{ flex: "1 1 220px", padding: "16px 18px", borderRadius: 8, background: bg, border: `1px solid ${edge}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 7, background: fg, flex: "none" }}
        >
          {icon}
        </span>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: fg }}>{label}</div>
        {pct != null && (
          <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 600, color: fg }}>{pct}%</span>
        )}
      </div>
      <div style={{ marginTop: 10, fontSize: 26, fontWeight: 700, color: C.ink, letterSpacing: "-0.5px", ...num }}>
        {money0(amount)}
        <span style={{ fontSize: 13, fontWeight: 500, color: C.faint }}> /mo</span>
      </div>
      <div style={{ marginTop: 2, fontSize: 12, color: C.faint, ...num }}>{money0(amount * 12)} / year</div>
    </div>
  );
}

/**
 * The dashboard a client actually opens this page to see: what does the
 * company pay, what do employees pay, and what does the whole thing come to
 * — the way an ICHRA budget tool shows a monthly number, not a grid of rates
 * to add up by hand. Read straight off the current grid's own totals, so it
 * can never disagree with the table underneath it.
 */
export default function SpendDashboard({ totals, contribution, enrolled }: Props) {
  const erPct = totals.total ? Math.round((totals.er / totals.total) * 100) : 0;
  const eePct = 100 - erPct;

  return (
    <div style={{ ...panel, padding: "20px 22px", marginBottom: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink }}>Your Monthly Health Bill</div>
          <div style={{ marginTop: 2, fontSize: 12.5, color: C.muted }}>
            What the company pays, what employees pay, and the total — at today&rsquo;s {enrolled} enrolled.
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.3px",
            color: C.faint,
            textTransform: "uppercase",
            padding: "3px 8px",
            border: `1px solid ${C.border}`,
            borderRadius: 3,
          }}
        >
          From your current plan
        </span>
      </div>

      <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 14 }}>
        <SpendTile
          icon={<BuildingIcon color="#fff" />}
          label="Employer Pays"
          amount={totals.er}
          pct={erPct}
          bg={C.blueTint}
          edge={C.blueEdge}
          fg={C.blue}
        />
        <SpendTile
          icon={<PersonIcon color="#fff" />}
          label="Employees Pay"
          amount={totals.ee}
          pct={eePct}
          bg={C.amberTint}
          edge={C.amberEdge}
          fg={C.orange}
        />
        <SpendTile
          icon={<StackIcon color="#fff" />}
          label="Total Monthly Bill"
          amount={totals.total}
          bg={C.greenTint}
          edge={C.greenEdge}
          fg={C.green}
        />
      </div>

      {/* Employer vs. employee, as one bar rather than two numbers to compare by eye. */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: "flex", height: 26, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.border}` }}>
          <div
            style={{
              width: `${Math.max(erPct, totals.er > 0 ? 6 : 0)}%`,
              background: C.blue,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11.5,
              fontWeight: 600,
              color: "#fff",
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            {erPct >= 12 && `${erPct}%`}
          </div>
          <div
            style={{
              width: `${Math.max(eePct, totals.ee > 0 ? 6 : 0)}%`,
              background: C.orange,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11.5,
              fontWeight: 600,
              color: "#fff",
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            {eePct >= 12 && `${eePct}%`}
          </div>
        </div>
        <div style={{ marginTop: 6, display: "flex", gap: 16, fontSize: 11.5, color: C.faint }}>
          <span>
            <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: C.blue, marginRight: 5 }} />
            Employer {money(totals.er)}
          </span>
          <span>
            <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: C.orange, marginRight: 5 }} />
            Employee {money(totals.ee)}
          </span>
        </div>
      </div>

      {/* Same split, one row per tier, for anyone who wants it broken down that far. */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.hairline}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.faint, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.3px" }}>
          Employer contribution by tier
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
          {contribution.map((t) => (
            <div key={t.key} style={{ flex: "1 1 130px", minWidth: 130 }}>
              <div style={{ fontSize: 12, color: C.faint, marginBottom: 4 }}>{TIER_LABEL[t.key]}</div>
              <div style={{ fontSize: 17, fontWeight: 600, color: t.count ? C.ink : C.faint, ...num }}>
                {t.er == null ? "—" : money0(t.er)}
              </div>
              <div style={{ marginTop: 2, fontSize: 11.5, color: C.faint }}>
                {t.count ? `${t.count} enrolled` : "none enrolled"}
              </div>
            </div>
          ))}
        </div>
        {!contribution.some((t) => t.actual) && contribution.some((t) => t.count) && (
          <div style={{ marginTop: 12, fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>
            Estimated from a standard employer/employee split until your Employee Navigator contribution
            configuration is loaded — ask your account manager to confirm the real numbers.
          </div>
        )}
      </div>
    </div>
  );
}

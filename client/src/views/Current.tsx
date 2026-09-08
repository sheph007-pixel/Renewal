import {
  TIERS,
  factorsHold,
  money,
  money0,
  rateFor,
  type Group,
  type KennionData,
  type Overrides,
  type PlanRow,
} from "@/lib/model";
import { C, h2, num, panel, sectionHead, th } from "@/lib/ui";

/**
 * What a group has today: one row per plan, the four tier rates, and what that
 * comes to a month.
 *
 * This page used to say the same numbers three times — a card per plan, five
 * tiles, and a combined table underneath. One grid says it once. The monthly
 * figure is the sum of each tier's rate times the people in that tier, which
 * is the only way to get it right: a headcount times the employee rate would
 * understate any group with families on the book.
 */

/** The page is one section now, so there is nothing to jump between. */
export const CURRENT_SECTIONS: { id: string; label: string }[] = [];

interface Props {
  data: KennionData;
  overrides: Overrides;
  g: Group;
  rows: PlanRow[];
  totals: { er: number; ee: number; total: number };
  eePct: number;
  depPct: number;
  onOpenPlan: (plan: string) => void;
}

const monthName = (m: string | null) =>
  m ? new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : null;

export default function Current({ data, overrides, g, rows, totals, onOpenPlan }: Props) {
  const enrolled = rows.reduce((n, r) => n + TIERS.reduce((m, t) => m + (r.counts[t.key] || 0), 0), 0);

  // Any tier with nobody in it has no billed rate, so it is shown at the
  // program factors. Say so once, under the table, rather than per plan.
  const anyDerived = rows.some((r) => TIERS.some((t) => rateFor(overrides, g, r.p.plan, t.key).derived));
  const anyOffSchedule = rows.some(
    (r) =>
      TIERS.some((t) => rateFor(overrides, g, r.p.plan, t.key).derived) &&
      !factorsHold(overrides, g, r.p.plan),
  );

  const cell = { padding: "12px 10px", borderBottom: `1px solid ${C.hairline}`, fontSize: 14 };
  const rateCell = { ...cell, textAlign: "right" as const, ...num };

  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>Current Medical Plan(s)</h2>
      </div>

      <div style={{ ...panel, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", padding: "11px 10px" }}>Plan</th>
              <th style={{ ...th, textAlign: "right", padding: "11px 10px" }}>Enrolled</th>
              {TIERS.map((t) => (
                <th key={t.key} style={{ ...th, textAlign: "right", padding: "11px 10px" }}>
                  {t.label}
                </th>
              ))}
              <th style={{ ...th, textAlign: "right", padding: "11px 14px 11px 10px" }}>Monthly</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const n = TIERS.reduce((m, t) => m + (r.counts[t.key] || 0), 0);
              return (
                <tr key={r.p.plan}>
                  <td style={{ ...cell, paddingLeft: 14 }}>
                    <div style={{ fontWeight: 600, color: C.ink }}>{r.p.plan}</div>
                    <button
                      className="noprint"
                      onClick={() => onOpenPlan(r.p.plan)}
                      style={{
                        marginTop: 3,
                        background: "none",
                        border: "none",
                        padding: 0,
                        fontSize: 12.5,
                        color: C.blue,
                        cursor: "pointer",
                      }}
                    >
                      What this costs you and your employees
                    </button>
                  </td>
                  <td style={{ ...rateCell, fontWeight: 600, color: C.ink }}>{n}</td>
                  {TIERS.map((t) => {
                    const rate = rateFor(overrides, g, r.p.plan, t.key);
                    const count = r.counts[t.key] || 0;
                    return (
                      <td key={t.key} style={rateCell}>
                        <div style={{ fontWeight: 600, color: count ? C.ink : C.faint }}>
                          {rate.rate == null ? "—" : money(rate.rate)}
                        </div>
                        <div style={{ marginTop: 2, fontSize: 12, color: C.faint }}>
                          {count ? `× ${count}` : "none enrolled"}
                        </div>
                      </td>
                    );
                  })}
                  <td style={{ ...rateCell, paddingRight: 14, fontWeight: 600, color: C.ink }}>
                    {money(r.total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ padding: "12px 10px 12px 14px", fontSize: 14, fontWeight: 600, color: C.ink }}>
                {rows.length === 1 ? "Total" : `Total — ${rows.length} plans`}
              </td>
              <td style={{ padding: "12px 10px", textAlign: "right", fontSize: 14, fontWeight: 600, color: C.ink, ...num }}>
                {enrolled}
              </td>
              <td colSpan={TIERS.length} />
              <td
                style={{
                  padding: "12px 14px 12px 10px",
                  textAlign: "right",
                  fontSize: 16,
                  fontWeight: 600,
                  color: C.ink,
                  ...num,
                }}
              >
                {money(totals.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{ marginTop: 12, fontSize: 12.5, color: C.muted, lineHeight: 1.7, maxWidth: 940 }}>
        <strong style={{ color: C.body }}>{money0(totals.total * 12)}</strong> a year at today&rsquo;s
        enrollment, covering {g.enrolled} employee{g.enrolled === 1 ? "" : "s"} and {g.lives} lives in
        total.{" "}
        {data.funding?.month
          ? `Rates as billed in ${monthName(data.funding.month)}; enrollment from your Employee Navigator export.`
          : "Enrollment and rates from your Employee Navigator export."}
        {anyDerived &&
          (anyOffSchedule
            ? " Tiers with nobody enrolled have no billed rate, so they are shown at the program factors (1.00 · 1.85 · 2.00 · 2.85) and are approximate. They are in no total above."
            : " Tiers with nobody enrolled have no billed rate, so they are shown at the program factors (1.00 · 1.85 · 2.00 · 2.85). They are in no total above.")}
      </div>
    </div>
  );
}

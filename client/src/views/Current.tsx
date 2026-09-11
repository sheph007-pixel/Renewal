import { useMemo, useState } from "react";
import {
  TIERS,
  contributionByTier,
  money,
  rateFor,
  type Group,
  type KennionData,
  type Overrides,
  type PlanRow,
  type TierKey,
} from "@/lib/model";
import { C, h2, num, panel, sectionHead, th } from "@/lib/ui";
import SpendDashboard from "@/views/SpendDashboard";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";

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

/** "2026-09" as "September 2026"; anything else as given. */
function monthLabel(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return month;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

interface Props {
  data: KennionData;
  overrides: Overrides;
  g: Group;
  rows: PlanRow[];
  totals: { er: number; ee: number; total: number };
  eePct: number;
  depPct: number;
}

/**
 * The eight supplemental lines Kennion places, in the order the Supplemental
 * Package lists them, each with the words that identify it in an Employee
 * Navigator benefit name or an invoice product line.
 */
const OTHER_BENEFITS: [string, RegExp][] = [
  ["Dental", /dental/i],
  ["Vision", /vision/i],
  ["Voluntary Life / AD&D", /\blife\b|ad&d|ad\s*&\s*d/i],
  ["Accident", /accident/i],
  ["Critical Illness", /critical/i],
  ["Cancer", /cancer/i],
  ["Hospital Indemnity", /hospital/i],
  ["Vol. Short Term Disability", /short.?term|\bstd\b|disab/i],
];

/**
 * Enrolled per supplemental benefit: from the Employee Navigator export's
 * lines when the group has them, else from the invoice's product rows.
 */
function otherBenefits(g: Group, invoice: KennionData["invoice"]): { benefit: string; enrolled: number; source: "en" | "invoice" | null }[] {
  const lines = g.lines || [];
  const products = invoice?.products || [];
  const source: "en" | "invoice" | null = lines.length ? "en" : products.length ? "invoice" : null;
  return OTHER_BENEFITS.map(([benefit, re]) => {
    // Long-term disability is not a line Kennion places; keep it out of the
    // STD row. Medical lines never count toward any of these.
    const counts = (t: string) => re.test(t) && !/medical|health plan/i.test(t) && !(benefit.includes("Disability") && /long.?term|\bltd\b/i.test(t));
    let enrolled = 0;
    if (source === "en") lines.forEach((l) => counts(`${l.benefit} ${l.plan}`) && (enrolled += l.enrolled || 0));
    else if (source === "invoice") products.forEach((r) => counts(r.product) && (enrolled += r.count || 0));
    return { benefit, enrolled, source };
  });
}

/** What a column sorts on. Tiers sort on their rate. */
type SortKey = "plan" | "enrolled" | "monthly" | TierKey;

/** A column header that sorts. The arrow says which way, and only on the one in force. */
function Head({
  label,
  k,
  sort,
  by,
  left,
  pad,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; desc: boolean };
  by: (k: SortKey) => void;
  left?: boolean;
  pad?: string;
}) {
  const on = sort.key === k;
  return (
    <th
      style={{
        ...th,
        textAlign: left ? "left" : "right",
        padding: pad || "12px 10px",
        background: C.headerBg,
        color: "#fff",
        borderBottom: "none",
        borderRight: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <button
        onClick={() => by(k)}
        aria-label={`Sort by ${label}`}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "#fff",
          fontWeight: on ? 700 : 600,
          cursor: "pointer",
        }}
      >
        {label}
        <span style={{ marginLeft: 4, color: on ? "#fff" : "transparent" }}>
          {sort.desc ? "\u2193" : "\u2191"}
        </span>
      </button>
    </th>
  );
}

export default function Current({ data, overrides, g, rows, totals, eePct, depPct }: Props) {
  const enrolled = rows.reduce((n, r) => n + TIERS.reduce((m, t) => m + (r.counts[t.key] || 0), 0), 0);

  // Biggest premium first, which is the order an employer reads it in.
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "monthly", desc: true });

  const countOf = (r: PlanRow) => TIERS.reduce((m, t) => m + (r.counts[t.key] || 0), 0);
  const sorted = useMemo(() => {
    const value = (r: PlanRow): string | number => {
      if (sort.key === "plan") return r.p.plan.toLowerCase();
      if (sort.key === "enrolled") return countOf(r);
      if (sort.key === "monthly") return r.total;
      // A tier with no rate sorts last either way rather than as zero.
      const rate = rateFor(overrides, g, r.p.plan, sort.key).rate;
      return rate == null ? (sort.desc ? -Infinity : Infinity) : rate;
    };
    return rows.slice().sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return sort.desc ? -c : c;
    });
  }, [rows, sort, overrides, g]);

  const by = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "plan" }));

  // Excel-style grid: a thin light line around every cell, plain white rows —
  // not alternating bands, which read as color-coding when there is none here.
  const cell = { padding: "10px 10px", border: `1px solid ${C.rule}`, fontSize: 14, background: C.card };
  const rateCell = { ...cell, textAlign: "right" as const, ...num };

  const contribution = useMemo(
    () => contributionByTier(data, overrides, g, eePct, depPct),
    [data, overrides, g, eePct, depPct],
  );

  // Every section header button — View Invoice, Employee Navigator — reads
  // the same way, so the page never looks like it has two button styles.
  const headerBtn = {
    padding: "6px 14px",
    fontSize: 13,
    fontWeight: 500,
    color: C.ink,
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    textDecoration: "none",
  } as const;

  return (
    <div>
      <SpendDashboard totals={totals} contribution={contribution} enrolled={enrolled} />

      <div className="anchor" style={{ ...sectionHead, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={h2}>Your 2026 Medical Plans</h2>
        {data.invoice && (
          // The group's own invoice, served against the session cookie, so
          // the link carries nothing secret and opens in its own tab.
          <a
            className="noprint"
            href="/api/group/invoice"
            target="_blank"
            rel="noreferrer"
            title={`${data.invoice.filename} — opens in a new tab`}
            style={headerBtn}
          >
            View Invoice{data.invoice.month ? ` · ${monthLabel(data.invoice.month)}` : ""}
          </a>
        )}
      </div>

      <div style={{ ...panel, padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead>
            <tr>
              <Head label="Plan" k="plan" left sort={sort} by={by} pad="11px 10px 11px 14px" />
              <Head label="Enrolled" k="enrolled" sort={sort} by={by} />
              {TIERS.map((t) => (
                <Head key={t.key} label={t.label} k={t.key} sort={sort} by={by} />
              ))}
              <Head label="Monthly Premium" k="monthly" sort={sort} by={by} pad="11px 14px 11px 10px" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const n = TIERS.reduce((m, t) => m + (r.counts[t.key] || 0), 0);
              return (
                <tr key={r.p.plan}>
                  <td style={{ ...cell, paddingLeft: 14, fontWeight: 600, color: C.ink }}>
                    {r.p.plan}
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
            <tr style={{ background: C.hairline }}>
              <td style={{ padding: "12px 10px 12px 14px", fontSize: 14, fontWeight: 600, color: C.ink, border: `1px solid ${C.rule}` }}>
                {rows.length === 1 ? "Total" : `Total — ${rows.length} plans`}
              </td>
              <td style={{ padding: "12px 10px", textAlign: "right", fontSize: 14, fontWeight: 600, color: C.ink, border: `1px solid ${C.rule}`, ...num }}>
                {enrolled}
              </td>
              <td colSpan={TIERS.length} style={{ border: `1px solid ${C.rule}` }} />
              <td
                style={{
                  padding: "12px 14px 12px 10px",
                  textAlign: "right",
                  fontSize: 16,
                  fontWeight: 600,
                  color: C.ink,
                  border: `1px solid ${C.rule}`,
                  ...num,
                }}
              >
                {money(totals.total)}
              </td>
            </tr>
          </tfoot>
        </table>
        </div>
      </div>

      {(() => {
        const other = otherBenefits(g, data.invoice);
        const known = other.some((b) => b.source);
        const hcell = { ...th, background: C.headerBg, color: "#fff", borderBottom: "none", borderRight: "1px solid rgba(255,255,255,0.12)", padding: "12px 10px" };
        return (
          <>
            <div className="anchor" style={{ ...sectionHead, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2 style={h2}>Your 2026 Supplemental Package</h2>
              <div className="noprint" style={{ display: "flex", gap: 8 }}>
                {data.invoice && (
                  <a href="/api/group/invoice" target="_blank" rel="noreferrer" title={`${data.invoice.filename} — opens in a new tab`} style={headerBtn}>
                    View Invoice
                  </a>
                )}
                <a href={NAVIGATOR_URL} target="_blank" rel="noreferrer" style={headerBtn}>
                  Employee Navigator
                </a>
              </div>
            </div>
            <div style={{ ...panel, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                  <thead>
                    <tr>
                      <th style={{ ...hcell, textAlign: "left", padding: "11px 10px 11px 14px" }}>Benefit</th>
                      <th style={{ ...hcell, textAlign: "center", width: 120 }}>Offered</th>
                      <th style={{ ...hcell, textAlign: "right", width: 160, borderRight: "none", padding: "11px 14px 11px 10px" }}>Enrolled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {other.map((b) => {
                      const on = b.enrolled > 0;
                      return (
                        <tr key={b.benefit}>
                          <td style={{ ...cell, paddingLeft: 14, fontWeight: 600, color: on ? C.ink : C.muted }}>{b.benefit}</td>
                          <td style={{ ...cell, textAlign: "center", fontSize: 16, color: on ? C.green : C.ghost }} aria-label={on ? "Offered" : "Not offered"}>
                            {known ? (on ? "✓" : "✕") : "—"}
                          </td>
                          <td style={{ ...rateCell, paddingRight: 14, fontWeight: on ? 600 : 400, color: on ? C.ink : C.ghost }}>{known ? (on ? b.enrolled : "—") : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
              {!known
                ? "Enrollment in other benefits appears here once this group's Employee Navigator export or invoice has been read."
                : other[0].source === "en"
                  ? "Enrolled counts are from Employee Navigator. Dental, life, accident, critical illness, cancer, hospital indemnity and short term disability are with Guardian; vision with VSP."
                  : "Enrolled counts are from this month's invoice. Dental, life, accident, critical illness, cancer, hospital indemnity and short term disability are with Guardian; vision with VSP."}
            </div>
          </>
        );
      })()}
    </div>
  );
}

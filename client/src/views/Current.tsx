import { useMemo, useState } from "react";
import {
  TIERS,
  money,
  rateFor,
  type Group,
  type KennionData,
  type Overrides,
  type PlanRow,
  type TierKey,
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
        background: C.ink,
        color: "#fff",
        borderBottom: "none",
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

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

  const download = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const { downloadPlanSheet } = await import("@/lib/plansheet");
      await downloadPlanSheet(data, overrides, g, rows, eePct, depPct);
    } catch (e) {
      setSaveError((e as Error).message || "Could not build the file.");
    } finally {
      setSaving(false);
    }
  };

  const cell = { padding: "12px 10px", borderBottom: `1px solid ${C.hairline}`, fontSize: 14 };
  const rateCell = { ...cell, textAlign: "right" as const, ...num };

  return (
    <div>
      <div className="anchor" style={{ ...sectionHead, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={h2}>Current Medical Plan(s)</h2>
        <button
          className="noprint"
          onClick={() => void download()}
          disabled={saving}
          title="This table, plus what the employer and the employees each pay by tier"
          style={{
            padding: "6px 14px",
            fontSize: 13,
            fontWeight: 500,
            color: C.ink,
            background: "#fff",
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Building…" : "Export To Excel"}
        </button>
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
              <Head label="Monthly" k="monthly" sort={sort} by={by} pad="11px 14px 11px 10px" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const n = TIERS.reduce((m, t) => m + (r.counts[t.key] || 0), 0);
              return (
                // Alternating bands, so the eye keeps its place across a wide
                // row of rates.
                <tr key={r.p.plan} style={{ background: i % 2 ? C.zebra : "#fff" }}>
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
      </div>

      {saveError && (
        <div role="alert" style={{ marginTop: 10, fontSize: 13, color: C.red }}>
          {saveError}
        </div>
      )}

    </div>
  );
}

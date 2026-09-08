import { useEffect } from "react";
import {
  FREQS,
  TIERS,
  factorsHold,
  hasActualSplit,
  money,
  planDesign,
  rateFor,
  split,
  planCounts,
  type Freq,
  type Group,
  type KennionData,
  type Overrides,
  type PlanRow,
} from "@/lib/model";
import { C, num, smallPrimaryBtn } from "@/lib/ui";

interface Props {
  data: KennionData;
  overrides: Overrides;
  g: Group;
  row: PlanRow | undefined;
  plan: string;
  freq: Freq["key"];
  eePct: number;
  depPct: number;
  onFreq: (k: Freq["key"]) => void;
  onClose: () => void;
  onPrint: () => void;
}

export default function BreakdownModal({
  data,
  overrides,
  g,
  row,
  plan,
  freq,
  eePct,
  depPct,
  onFreq,
  onClose,
  onPrint,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const f = FREQS.find((x) => x.key === freq)!;
  const per = (n: number | null | undefined) => (n == null ? "—" : money(n / f.div));
  // Enrollment by tier. The census stays on the server, so these pages never
  // hold an employee's name, age or ZIP.
  const counts = planCounts(g, plan);
  const enrolled = TIERS.reduce((n, t) => n + counts[t.key], 0);
  const des = planDesign(data, plan);
  const tpa = row ? row.p.tpa : g.tpa;
  const anyDerived = TIERS.some((t) => rateFor(overrides, g, plan, t.key).derived);
  const actual = hasActualSplit(data, g);

  const rateNote = !anyDerived
    ? `Composite rates as billed by ${tpa} for the current plan year.`
    : `Rates without "(calc.)" are as billed by ${tpa} for the current plan year. Tiers marked (calc.) have no one enrolled today, so nothing is billed for them. ` +
      (factorsHold(overrides, g, plan)
        ? "They are calculated at the program tier factors (EE 1.00, EE+SP 2.00, EE+CH 1.85, EE+Family 2.85), which reconcile to every billed rate on this plan."
        : `This plan is priced off the standard program schedule, so they are approximate — calculated at the standard factors (EE 1.00, EE+SP 2.00, EE+CH 1.85, EE+Family 2.85) pending the ${tpa} rate sheet.`) +
      " They do not affect any total on this page.";

  const headCell = {
    textAlign: "right" as const,
    padding: "6px 8px 11px",
    fontSize: 12.5,
    color: C.ink,
    fontWeight: 600,
    borderBottom: `1px solid ${C.border}`,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Employee Cost Breakdown"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(38,44,48,.5)",
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "26px 20px",
        overflow: "auto",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 4,
          width: "100%",
          maxWidth: 1180,
          boxShadow: "0 12px 40px rgba(20,28,34,.28)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 20,
            padding: "16px 22px 14px",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 19, fontWeight: 600, color: C.ink }}>
              Employee Cost Breakdown
            </div>
            <div style={{ marginTop: 7, fontSize: 14, fontWeight: 600, color: C.ink }}>{plan}</div>
            <div style={{ fontSize: 12.5, color: C.muted }}>
              {tpa}
              {des && ` · ${des["Deductible"]} deductible · ${des["Out-of-Pocket Max"]} OOP max`}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              className="noprint"
              style={{
                display: "flex",
                border: `1px solid ${C.inputEdge}`,
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              {FREQS.map((x) => (
                <button
                  key={x.key}
                  onClick={() => onFreq(x.key)}
                  style={{
                    border: "none",
                    padding: "7px 12px",
                    fontSize: 12.5,
                    cursor: "pointer",
                    ...(x.key === freq
                      ? { background: C.blue, color: "#fff", fontWeight: 500 }
                      : { background: "#fff", color: C.body }),
                  }}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              className="noprint"
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                fontSize: 24,
                lineHeight: 1,
                color: C.faint,
                cursor: "pointer",
              }}
            >
              &times;
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "288px 1fr" }}>
          <div
            style={{
              background: "#f7f9fa",
              borderRight: `1px solid ${C.border}`,
              padding: "17px 20px",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 12 }}>
              {f.label} Composite Rates
            </div>
            {TIERS.map((t) => {
              const rf = rateFor(overrides, g, plan, t.key);
              return (
                <div
                  key={t.key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "9px 0",
                    borderBottom: `1px solid ${C.rule}`,
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: C.body }}>
                    {t.label}
                    {rf.derived ? "  (calc.)" : ""}
                  </span>
                  <span style={{ fontWeight: 600, color: C.ink, ...num }}>{per(rf.rate)}</span>
                </div>
              );
            })}
            <div style={{ marginTop: 16, fontSize: 12, lineHeight: 1.6, color: C.faint }}>
              {rateNote}
            </div>
          </div>

          <div style={{ padding: "16px 20px 22px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th
                    colSpan={2}
                    style={{
                      textAlign: "left",
                      padding: "6px 8px 11px 0",
                      fontSize: 14,
                      fontWeight: 600,
                      color: C.ink,
                      borderBottom: `1px solid ${C.border}`,
                    }}
                  >
                    Enrolled employees ({enrolled})
                  </th>
                  <th style={{ ...headCell, textAlign: "center" }}>Enrolled</th>
                  <th style={headCell}>Employee Cost</th>
                  <th style={headCell}>Employer Cost</th>
                  <th style={{ ...headCell, padding: "6px 0 11px 8px" }}>Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((t, i) => {
                  const n = counts[t.key];
                  if (!n) return null;
                  const sp = split(data, overrides, g, plan, t.key, eePct, depPct);
                  const cell = {
                    padding: "9px 8px",
                    borderBottom: `1px solid ${C.hairline}`,
                    textAlign: "right" as const,
                    color: C.ink,
                    ...num,
                  };
                  return (
                    <tr key={t.key} style={{ background: i % 2 ? C.zebra : "#fff" }}>
                      <td
                        style={{
                          padding: "9px 8px 9px 0",
                          borderBottom: `1px solid ${C.hairline}`,
                          color: C.ghost,
                          ...num,
                        }}
                      >
                        {i + 1}
                      </td>
                      <td style={{ padding: "9px 8px", borderBottom: `1px solid ${C.hairline}`, color: C.ink }}>
                        {t.label}
                      </td>
                      <td
                        style={{
                          padding: "9px 8px",
                          borderBottom: `1px solid ${C.hairline}`,
                          textAlign: "center",
                          color: C.body,
                          ...num,
                        }}
                      >
                        {n}
                      </td>
                      <td style={cell}>{sp.ee == null ? "—" : per(sp.ee * n)}</td>
                      <td style={cell}>{sp.er == null ? "—" : per(sp.er * n)}</td>
                      <td style={{ ...cell, padding: "9px 0 9px 8px" }}>{sp.rate == null ? "—" : per(sp.rate * n)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "flex-end",
                gap: 26,
                padding: "14px 0 0",
                fontSize: 14,
                color: C.ink,
              }}
            >
              <span>
                Total Employee: <strong style={num}>{per(row?.ee)}</strong>
              </span>
              <span>
                Total Employer: <strong style={num}>{per(row?.er)}</strong>
              </span>
              <span>
                Total Premium: <strong style={num}>{per(row?.total)}</strong>
              </span>
            </div>

            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: `1px solid ${C.hairline}`,
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
              }}
            >
              <button onClick={onPrint} className="noprint" style={smallPrimaryBtn}>
                Print
              </button>
              <span
                style={{
                  fontSize: 12,
                  color: C.faint,
                  lineHeight: 1.5,
                  flex: 1,
                  minWidth: 260,
                }}
              >
                {f.key === "M"
                  ? "Monthly amounts as billed."
                  : `${f.label} amounts = monthly × 12 ÷ ${f.divisorLabel}.`}{" "}
                {actual
                  ? "Employee and employer cost are the amounts configured in Employee Navigator — actual, not adjustable."
                  : "Employee and employer cost are modeled pending your contribution file; total cost is as billed."}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import ImportSection from "@/views/ImportSection";
import { C, money0 } from "@/lib/importui";
import { pill } from "@/lib/ui";
import { carrierKey, matchCarrier } from "@/lib/carriers";
import type { AdminGroup } from "@/views/GroupsTable";

/** Employee Navigator's Carrier Stats report, as stored. */
export interface CarrierStats {
  filename: string;
  reportDate: string | null;
  rows: { carrier: string; eligible: number; enrolled: number; companies: number; plans: number; employeeCosts: number; planCosts: number }[];
  total: { employeeCosts: number; planCosts: number } | null;
  uploadedAt: string;
  uploadedBy: string | null;
}

/** What the last import left out, and why. Aggregates by carrier program. */
export interface ImportDiagnostics {
  employees: { total: number; byStatus: Record<string, number>; skipped: Record<string, number> };
  medical: {
    kept: { n: number; premium: number };
    excluded: Record<"terminatedEmployee" | "ended" | "waived", { n: number; premium: number; byProgram: Record<string, { n: number; premium: number }> }>;
    noPremium: { n: number; byProgram: Record<string, number> };
    endDates: { nil: number; absent: number; past: number; future: number };
  };
  /** Every non-medical benefit line, by the same rules. Absent on older imports. */
  lines?: { kept: { n: number; premium: number }; excluded: Record<"terminatedEmployee" | "ended" | "waived", number>; noPremium: number };
  /** Company records the parser could not use, and why. Absent on older imports. */
  rejected?: { name: string; reason: string }[];
}

const REASON_LABEL: Record<string, string> = {
  terminatedEmployee: "Terminated employee whose medical coverage has not ended",
  ended: "Medical enrollment that has ended (EndDate in the past)",
  waived: "Waived or declined medical election",
};

type Plan = { plan: string; tpa?: string; enrolled?: number; monthly?: number; program?: string | null; groupHealth?: boolean; assumed?: boolean };
type Line = { benefit: string; carrier: string; plan: string; enrolled: number; monthly: number };
type G = AdminGroup & {
  lines?: Line[];
  linesLoaded?: boolean;
  /** Distinct employees on any line, per carrier as the export named it. */
  carrierHeads?: Record<string, number> | null;
  groupHealthMonthly?: number;
  groupHealthEnrolled?: number;
};

/**
 * One side of the comparison, live groups or archived ones. Employee
 * Navigator's report counts every benefit line a carrier has — medical,
 * dental, vision, life … — and "enrolled" is distinct employees on any of
 * them, so the portal is added up the same way.
 */
interface Side {
  heads: number;
  headsExact: boolean;
  medical: number;
  lines: number;
  groups: number;
  assumedMedical: number;
}
const side = (): Side => ({ heads: 0, headsExact: true, medical: 0, lines: 0, groups: 0, assumedMedical: 0 });
const total = (s: Side) => s.medical + s.lines;

export interface Recon {
  carrier: string;
  program: string | null;
  report: { enrolled: number; companies: number; monthly: number ; rows?: number };
  live: Side;
  archived: Side;
  service: boolean; // no premium either side — an administrator, not a carrier
  ok: boolean | null;
}

/** Group health as the report states it: EBPA + HealthEZ, every line. */
export function reportGroupHealth(stats: CarrierStats | null) {
  if (!stats) return null;
  const gh = stats.rows.filter((r) => {
    const p = matchCarrier(r.carrier);
    return p === "EBPA" || p === "HealthEZ";
  });
  return { enrolled: gh.reduce((n, r) => n + r.enrolled, 0), monthly: gh.reduce((n, r) => n + r.planCosts, 0) };
}

/**
 * The portal added up on the report's basis for EBPA + HealthEZ: medical plus
 * every other line on those carriers, live groups and archived ones.
 */
export function portalComparable(groups: AdminGroup[]) {
  let medicalLive = 0;
  let linesLive = 0;
  let archived = 0;
  (groups as G[]).forEach((g) => {
    const med = ((g.plans || []) as Plan[]).filter((p) => p.groupHealth).reduce((n, p) => n + (p.monthly || 0), 0);
    const ln = (g.lines || []).filter((l) => ["EBPA", "HealthEZ"].includes(matchCarrier(l.carrier) || "")).reduce((n, l) => n + (l.monthly || 0), 0);
    if (g.archived) archived += med + ln;
    else {
      medicalLive += med;
      linesLive += ln;
    }
  });
  return { monthly: medicalLive + linesLive + archived, medicalLive, linesLive, archived };
}

const close = (a: number, b: number, tolFrac: number, tolAbs: number) => Math.abs(a - b) <= Math.max(tolAbs, tolFrac * Math.abs(b));

/** Every carrier in the report against what the portal holds from the XML. */
export function reconcile(stats: CarrierStats, groups: AdminGroup[]): Recon[] {
  const gs = groups as G[];
  // The report can name one carrier twice ("Blue Cross Blue Shield" with
  // nothing on it beside "Blue Cross Blue Shield of Alabama"); both map to the
  // same program here, so they are read as one row, under the larger name.
  const merged = new Map<string, { carrier: string; enrolled: number; companies: number; planCosts: number; rows: number }>();
  stats.rows.forEach((r) => {
    const k = matchCarrier(r.carrier) || carrierKey(r.carrier);
    const m = merged.get(k);
    if (!m) merged.set(k, { carrier: r.carrier, enrolled: r.enrolled, companies: r.companies, planCosts: r.planCosts, rows: 1 });
    else {
      if (r.planCosts > m.planCosts) m.carrier = r.carrier;
      m.enrolled += r.enrolled;
      m.companies += r.companies;
      m.planCosts += r.planCosts;
      m.rows++;
    }
  });
  return [...merged.values()].map((r) => {
    const program = matchCarrier(r.carrier);
    const key = carrierKey(r.carrier);
    const report = { enrolled: r.enrolled, companies: r.companies, monthly: Math.round(r.planCosts * 100) / 100, rows: r.rows };
    const planMatches = (p: Plan) => (program ? p.program === program || (!!p.assumed && program !== "BCBS-AL") : carrierKey(p.tpa) === key);
    const nameMatches = (c: string) => (program ? matchCarrier(c) === program : carrierKey(c) === key);

    const live = side();
    const archived = side();
    gs.forEach((g) => {
      const s = g.archived ? archived : live;
      const plans = ((g.plans || []) as Plan[]).filter(planMatches);
      const lines = (g.lines || []).filter((l) => nameMatches(l.carrier));
      if (!plans.length && !lines.length) return;
      s.groups++;
      plans.forEach((p) => {
        s.medical += p.monthly || 0;
        if (p.assumed) s.assumedMedical += p.monthly || 0;
      });
      lines.forEach((l) => {
        s.lines += l.monthly || 0;
      });
      if (g.carrierHeads) {
        Object.entries(g.carrierHeads).forEach(([c, n]) => {
          if (nameMatches(c)) s.heads += n;
        });
      } else {
        // Older import without per-carrier head counts: enrollments instead
        // of people, which over-counts anyone on two lines.
        s.headsExact = false;
        s.heads += plans.reduce((n, p) => n + (p.enrolled || 0), 0) + lines.reduce((n, l) => n + (l.enrolled || 0), 0);
      }
    });

    const both = total(live) + total(archived);
    const heads = live.heads + archived.heads;
    const service = report.monthly === 0 && both === 0;
    const ok = service
      ? null
      : close(both, report.monthly, 0.01, 50) && (!(live.headsExact && archived.headsExact) || close(heads, report.enrolled, 0.01, 2));
    return { carrier: r.carrier, program, report, live, archived, service, ok };
  });
}

interface Props {
  token: string;
  stats: CarrierStats | null;
  /** Every group — live and archived — with classified plans, lines and head counts. */
  groups: AdminGroup[];
  onStats: (s: CarrierStats) => void;
  diagnostics?: ImportDiagnostics | null;
  lastImport?: { filename: string | null; when: string } | null;
  ai?: boolean;
}

const cell = (right = false): React.CSSProperties => ({
  padding: "8px 8px",
  borderBottom: `1px solid ${C.hairline}`,
  textAlign: right ? "right" : "left",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
});
const th = (right = false): React.CSSProperties => ({
  ...cell(right),
  fontWeight: 600,
  color: C.muted,
  fontSize: 11.5,
  textTransform: "uppercase",
  letterSpacing: ".3px",
});

const diff = (portal: number, report: number, money = false) => {
  const d = portal - report;
  if (Math.abs(d) < 0.5) return <span style={{ color: C.green }}>match</span>;
  const s = money ? money0(Math.abs(d)) : Math.abs(d).toLocaleString();
  return (
    <span style={{ color: d < 0 ? C.red : C.amber }}>
      {d < 0 ? "−" : "+"}
      {s}
    </span>
  );
};

/**
 * Second upload on the Import tab: Employee Navigator's Carrier Stats report,
 * kept alongside the XML so the two can be checked against each other.
 */
export default function Reconciliation({ token, stats, groups, onStats, diagnostics, lastImport, ai }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState("");

  async function explain(rows: Recon[]) {
    setExplaining(true);
    setExplanation("");
    try {
      const portal = rows.map((r) => ({ carrier: r.carrier, program: r.program, report: r.report, live: r.live, archived: r.archived }));
      const r = await fetch("/api/admin/reconcile/explain", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ portal }),
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      setExplanation(r.ok ? j.text : `Could not get an explanation: ${j.error}`);
    } finally {
      setExplaining(false);
    }
  }

  /** Pull the reconciliation file down with the staff token and hand it to the browser. */
  async function download() {
    const r = await fetch("/api/admin/reconcile/export", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      setError("Could not build the reconciliation file — sign in again.");
      return;
    }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kennion-reconciliation-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function upload(f: File) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/carrier-stats?filename=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": f.type || "application/octet-stream" },
        body: f,
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      if (!r.ok) setError(j.error || "Could not read the report.");
      else onStats(j.stats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  const rows = stats ? reconcile(stats, groups) : [];
  const gh = reportGroupHealth(stats);
  const comparable = portalComparable(groups);
  const tile = (groups as G[]).filter((g) => !g.archived && g.eligible !== false).reduce((n, g) => n + (g.groupHealthMonthly ?? 0), 0);
  const checked = rows.filter((r) => r.ok !== null);
  const mismatches = checked.filter((r) => r.ok === false);
  const linesLoaded = (groups as G[]).some((g) => g.linesLoaded);
  const archivedCount = (groups as G[]).filter((g) => g.archived).length;

  const okCount = checked.length - mismatches.length;
  return (
    <ImportSection
      step={2}
      title="Carrier stats report"
      what="carrier_stats_report_yyyy_mm_dd.xls — Employee Navigator's own count per carrier"
      accept=".xls,.xlsx,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
      ariaLabel="Upload the carrier stats report"
      inputRef={ref}
      disabled={busy}
      onFile={(f) => void upload(f)}
      busy={busy ? "Reading…" : ""}
      last={stats ? { filename: stats.filename, when: stats.uploadedAt, by: stats.uploadedBy } : null}
      status={
        !stats
          ? { kind: "none", label: "Not uploaded yet" }
          : mismatches.length
            ? { kind: "warn", label: `${mismatches.length} carrier${mismatches.length === 1 ? "" : "s"} to check` }
            : { kind: "ok", label: "Matches Employee Navigator" }
      }
      summary={
        stats
          ? `Report of ${stats.reportDate || "—"} · ${checked.length} carriers checked · ${okCount} match${mismatches.length ? ` · ${mismatches.length} off by more than 1%: ${mismatches.map((r) => r.carrier).join(", ")}` : ""}`
          : "Once uploaded, every carrier is checked against the XML side by side."
      }
      error={error}
    >
      {stats && gh && (
        <>
          <div
            style={{
              marginTop: 16,
              padding: "12px 14px",
              background: mismatches.length ? C.amberTint : C.greenTint,
              border: `1px solid ${mismatches.length ? C.amberEdge : C.greenEdge}`,
              borderRadius: 4,
              fontSize: 13,
              color: C.ink,
              lineHeight: 1.7,
            }}
          >
            <strong>EBPA + HealthEZ, on the report&rsquo;s basis</strong> — Employee Navigator:{" "}
            <strong>{gh.enrolled.toLocaleString()} enrolled · {money0(gh.monthly)} / mo</strong>; the portal:{" "}
            <strong>{money0(comparable.monthly)} / mo</strong> ({diff(comparable.monthly, gh.monthly, true)}).
            <div style={{ fontSize: 12.5, color: C.muted }}>
              That portal figure is {money0(comparable.medicalLive)} medical in live groups + {money0(comparable.linesLive)} dental and other
              EBPA/HealthEZ lines + {money0(comparable.archived)} in {archivedCount} archived group{archivedCount === 1 ? "" : "s"}. The Groups
              page&rsquo;s group-health tile is the medical-only, live-groups part: {money0(tile)}.
            </div>
            <div style={{ fontSize: 12.5, color: C.muted }}>
              {checked.length} carrier{checked.length === 1 ? "" : "s"} checked ·{" "}
              {mismatches.length ? `${mismatches.length} off by more than 1% — see the rows marked Check` : "all within 1%"}
              {!linesLoaded ? " · supplemental lines will fill in after the next XML import" : ""}
            </div>
          </div>

          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1040 }}>
              <thead>
                <tr>
                  <th style={th()}>Carrier/TPA</th>
                  <th style={th(true)}>EN enrolled</th>
                  <th style={th(true)}>Portal</th>
                  <th style={th(true)}>In archived</th>
                  <th style={th(true)}>EN companies</th>
                  <th style={th(true)}>Portal</th>
                  <th style={th(true)}>EN monthly</th>
                  <th style={th(true)}>Portal (medical + other lines)</th>
                  <th style={th(true)}>In archived</th>
                  <th style={th(true)}>Diff</th>
                  <th style={th(true)}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const both = total(r.live) + total(r.archived);
                  const heads = r.live.heads + r.archived.heads;
                  const exact = r.live.headsExact && r.archived.headsExact;
                  return (
                    <tr key={r.carrier} style={{ color: r.service ? C.faint : C.ink }}>
                      <td style={{ ...cell(), whiteSpace: "normal" }}>
                        {r.carrier}
                        {r.program && (
                          <span style={{ fontSize: 11.5, color: r.program === "BCBS-AL" ? C.faint : C.green }}>
                            {" "}
                            · {r.program === "BCBS-AL" ? "medical, not group health" : "group health"}
                          </span>
                        )}
                      </td>
                      <td style={cell(true)}>{r.report.enrolled.toLocaleString()}</td>
                      <td style={cell(true)} title={exact ? "Distinct employees on any line with this carrier" : "Enrollments, not people — older import"}>
                        {r.live.heads.toLocaleString()}
                        {!exact ? "*" : ""}
                      </td>
                      <td style={{ ...cell(true), color: C.faint }}>{r.archived.heads ? r.archived.heads.toLocaleString() : "—"}</td>
                      <td style={cell(true)}>{r.report.companies}</td>
                      <td style={cell(true)}>
                        {r.live.groups}
                        {r.archived.groups ? <span style={{ color: C.faint }}> +{r.archived.groups}</span> : ""}
                      </td>
                      <td style={cell(true)}>{money0(r.report.monthly)}</td>
                      <td style={cell(true)}>
                        {money0(total(r.live))}
                        {r.live.lines > 0 && (
                          <div style={{ fontSize: 11, color: C.faint }}>
                            {money0(r.live.medical)} medical + {money0(r.live.lines)} other
                          </div>
                        )}
                        {r.live.assumedMedical > 0 && <div style={{ fontSize: 11, color: C.amber }}>incl. {money0(r.live.assumedMedical)} assumed</div>}
                      </td>
                      <td style={{ ...cell(true), color: C.faint }}>{total(r.archived) ? money0(total(r.archived)) : "—"}</td>
                      <td style={cell(true)}>
                        {!r.service && diff(both, r.report.monthly, true)}
                        {!r.service && exact && <div style={{ fontSize: 11 }}>{diff(heads, r.report.enrolled)} people</div>}
                      </td>
                      <td style={cell(true)}>
                        {r.service ? (
                          <span style={pill(C.faint, "#f2f4f5", "#e0e4e6")}>No premium</span>
                        ) : r.ok ? (
                          <span style={pill(C.green, C.greenTint, C.greenEdge)}>Matches</span>
                        ) : (
                          <span style={pill(C.red, C.redTint, C.redEdge)}>Check</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {stats.total && (
                <tfoot>
                  <tr>
                    <td style={{ ...cell(), fontWeight: 600 }}>Report total</td>
                    <td colSpan={5} />
                    <td style={{ ...cell(true), fontWeight: 600 }}>{money0(stats.total.planCosts)}</td>
                    <td colSpan={4} style={{ ...cell(), color: C.faint, fontSize: 12 }}>
                      every line, every carrier — employee share {money0(stats.total.employeeCosts)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
            Diff is portal live + archived against the report. Groups you archived still count in Employee Navigator, so they are shown rather than dropped.
            {rows.some((r) => !(r.live.headsExact && r.archived.headsExact)) ? " * Enrollments rather than people — re-import the XML for exact head counts." : ""}
          </div>
        </>
      )}

      {diagnostics && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.rule}` }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.ink }}>What The Last XML Import Left Out</h3>
            {lastImport && (
              <span style={{ fontSize: 12.5, color: C.faint }}>
                {lastImport.filename || "export"} · {new Date(lastImport.when).toLocaleString()} ·{" "}
                {diagnostics.employees.total.toLocaleString()} employees in the file
              </span>
            )}
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted, lineHeight: 1.6, maxWidth: 880 }}>
            Every medical enrollment the parser did not count, by the rule that excluded it and the
            carrier it was on, with the premium it carried.
          </div>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12.5, minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ ...th(), whiteSpace: "normal" }}>Left out because</th>
                  {["EBPA", "HealthEZ", "BCBS-AL", "Other"].map((p) => (
                    <th key={p} style={th(true)}>{p === "BCBS-AL" ? "BCBS AL" : p}</th>
                  ))}
                  <th style={th(true)}>Total</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(REASON_LABEL) as (keyof ImportDiagnostics["medical"]["excluded"])[]).map((k) => {
                  const b = diagnostics.medical.excluded[k];
                  if (!b) return null;
                  return (
                    <tr key={k} style={{ color: b.n ? C.ink : C.faint }}>
                      <td style={{ ...cell(), whiteSpace: "normal" }}>{REASON_LABEL[k]}</td>
                      {["EBPA", "HealthEZ", "BCBS-AL", "Other"].map((p) => {
                        const v = b.byProgram[p];
                        return (
                          <td key={p} style={cell(true)}>
                            {v ? `${v.n} · ${money0(v.premium)}` : "—"}
                          </td>
                        );
                      })}
                      <td style={{ ...cell(true), fontWeight: 600 }}>{b.n ? `${b.n} · ${money0(b.premium)}` : "—"}</td>
                    </tr>
                  );
                })}
                <tr style={{ color: diagnostics.medical.noPremium.n ? C.amber : C.faint }}>
                  <td style={{ ...cell(), whiteSpace: "normal" }}>Counted as enrolled, but no PlanCost in the file (adds $0)</td>
                  {["EBPA", "HealthEZ", "BCBS-AL", "Other"].map((p) => (
                    <td key={p} style={cell(true)}>{diagnostics.medical.noPremium.byProgram[p] ?? "—"}</td>
                  ))}
                  <td style={{ ...cell(true), fontWeight: 600 }}>{diagnostics.medical.noPremium.n || "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
            Counted: {diagnostics.medical.kept.n.toLocaleString()} medical enrollments · {money0(diagnostics.medical.kept.premium)} / mo, every company in the file.
            {" "}Employees by status: {Object.entries(diagnostics.employees.byStatus).map(([k, n]) => `${k} ${n}`).join(" · ")}.
            {" "}Medical EndDate: {diagnostics.medical.endDates.nil} nil · {diagnostics.medical.endDates.absent} absent · {diagnostics.medical.endDates.future} future · {diagnostics.medical.endDates.past} past.
          </div>
          {diagnostics.lines && (
            <div style={{ marginTop: 6, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
              Other benefit lines (dental, vision, life, disability…): counted {diagnostics.lines.kept.n.toLocaleString()} · {money0(diagnostics.lines.kept.premium)} / mo
              {diagnostics.lines.noPremium ? ` (${diagnostics.lines.noPremium} with no PlanCost, adding $0)` : ""}.
              {" "}Left out: {diagnostics.lines.excluded.terminatedEmployee} on terminated employees · {diagnostics.lines.excluded.ended} ended · {diagnostics.lines.excluded.waived} waived.
            </div>
          )}
          {diagnostics.rejected && diagnostics.rejected.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: C.amber, lineHeight: 1.6 }}>
              {diagnostics.rejected.length} company record{diagnostics.rejected.length === 1 ? "" : "s"} in the file could not be used and hold nothing in the portal:{" "}
              {diagnostics.rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}.
            </div>
          )}
          {!diagnostics.lines && (
            <div style={{ marginTop: 6, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
              This import predates line-level diagnostics and per-carrier head counts; re-importing the same export fills them in.
            </div>
          )}
        </div>
      )}

      {stats && (
        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => void explain(rows)}
            disabled={explaining || !ai}
            title={ai ? "Send the report, the portal totals and the import diagnostics to Claude for a plain-language explanation" : "Needs ANTHROPIC_API_KEY on the server"}
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 500,
              color: "#fff",
              background: C.blue,
              border: `1px solid ${C.blue}`,
              borderRadius: 4,
              cursor: explaining || !ai ? "default" : "pointer",
              opacity: explaining || !ai ? 0.6 : 1,
            }}
          >
            {explaining ? "Claude is reading…" : "Ask Claude what explains the gap"}
          </button>
          <button
            onClick={() => void download()}
            title="A small JSON file with the report, the portal totals by carrier, the import exclusions and each group's plan classification — no employee data."
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 500,
              color: C.blue,
              background: "#fff",
              border: `1px solid ${C.blue}`,
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Download reconciliation file
          </button>
          <span style={{ fontSize: 12, color: C.faint }}>Aggregates only — no member data leaves the server.</span>
        </div>
      )}
      {explanation && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: C.blueTint, border: `1px solid ${C.blueEdge}`, borderRadius: 4, fontSize: 13, color: C.ink, lineHeight: 1.65, whiteSpace: "pre-wrap", maxWidth: 900 }}>
          {explanation}
        </div>
      )}
    </ImportSection>
  );
}

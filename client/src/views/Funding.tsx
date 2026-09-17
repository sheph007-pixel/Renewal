import { useMemo, useRef, useState, type CSSProperties } from "react";
import ImportSection from "@/views/ImportSection";
import { C, money0, panel } from "@/lib/importui";
import { pill } from "@/lib/ui";
import Link from "@/lib/Link";
import { groupPath } from "@/lib/router";
import type { AdminGroup } from "@/views/GroupsTable";

/** One group's slice of a month's billing, as the server summarises it. */
export interface GroupFunding {
  invoices: string[];
  orgs: string[];
  medical: {
    /** Distinct people with a current-month medical line. */
    participants: number;
    lines: number;
    /** The month's own billing; `adjustments` is retro adds and credits on top. */
    monthly: number;
    adjustments: number;
    retro: number;
    credits: number;
    billed: number;
    byPlan: Record<string, { lines: number; monthly: number; adjustments: number; byTier: Record<string, { n: number; monthly: number; adjustments: number; rate: number | null; rateLines: number; rateProrated?: boolean; otherRates: { rate: number; n: number }[]; partialLines?: number; retro: number; credits: number }>; untiered?: { n: number; monthly: number; rates: number[] } | null }>;
  };
  other: { lines: number; monthly: number; byProduct: Record<string, { lines: number; monthly: number }> };
  totalMonthly: number;
  totalBilled: number;
}

export interface Assignment {
  group: string | null;
  votes: number;
  matched: number;
  total: number;
  orgs: string[];
  by: "names" | "org name" | "staff" | null;
  candidates: { group: string; votes: number }[];
}

/** The month's funding workbook, minus the participant lines (server only). */
export interface FundingInfo {
  month: string | null;
  filename: string;
  fileStamp: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  byInvoice: Record<string, Assignment>;
  summary: Record<string, GroupFunding>;
  totals: {
    lines: number;
    medicalLines: number;
    medicalMonthly: number;
    adjustments: number;
    retroLines: number;
    creditLines: number;
    otherMonthly: number;
    participantsAll: number;
    participants: number;
    assignedMedicalMonthly: number;
    invoices: number;
    assigned: number;
    unassigned: number;
  };
}

type G = AdminGroup & { funding?: GroupFunding | null; rates?: Record<string, Record<string, number>>; medicalMonthly?: number };

const TIERS = ["Employee", "Employee + Spouse", "Employee + Child(ren)", "Employee + Family"];
const TIER_SHORT: Record<string, string> = { Employee: "EE", "Employee + Spouse": "EE + SP", "Employee + Child(ren)": "EE + CH", "Employee + Family": "Family" };

/** money0 with the sign in front of the dollar: "-$24,042", "+$1,160". */
const signed = (n: number) => `${n < 0 ? "-" : "+"}${money0(Math.abs(n))}`;

const monthLabel = (m: string | null) =>
  m ? new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "the month";

const cell = (right = false): CSSProperties => ({
  padding: "8px 8px",
  borderBottom: `1px solid ${C.hairline}`,
  textAlign: right ? "right" : "left",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
});
const th = (right = false): CSSProperties => ({ ...cell(right), fontWeight: 600, color: C.muted, fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".3px" });

const close = (a: number, b: number, frac: number, abs: number) => Math.abs(a - b) <= Math.max(abs, frac * Math.abs(b));

const diff = (a: number, b: number, money = false) => {
  const d = a - b;
  if (Math.abs(d) < 0.5) return <span style={{ color: C.green }}>match</span>;
  return (
    <span style={{ color: d < 0 ? C.red : C.amber }}>
      {d < 0 ? "-" : "+"}
      {money ? money0(Math.abs(d)) : Math.abs(d).toLocaleString()}
    </span>
  );
};

const btn = (primary: boolean): CSSProperties => ({
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 500,
  color: primary ? "#fff" : C.blue,
  background: primary ? C.blue : "#fff",
  border: `1px solid ${C.blue}`,
  borderRadius: 4,
  cursor: "pointer",
});

async function post(token: string, path: string, body?: unknown) {
  const r = await fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
  if (!r.ok) throw new Error(j.error || "Request failed.");
  return j;
}

interface PanelProps {
  token: string;
  funding: FundingInfo | null;
  /** Every group, archived included. */
  groups: AdminGroup[];
  onFunding: (f: FundingInfo, groups?: unknown[]) => void;
  onOverrides: (o: Record<string, string>) => void;
}

/** Third upload on the Import tab: the month's funding workbook from Employee Navigator. */
export default function FundingPanel({ token, funding, groups, onFunding, onOverrides }: PanelProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function upload(f: File) {
    setBusy("Reading the workbook and filing invoices…");
    setError("");
    setDone("");
    try {
      const r = await fetch(`/api/admin/funding?filename=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": f.type || "application/octet-stream" },
        body: f,
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      if (!r.ok) setError(j.error || "Could not read the workbook.");
      else {
        onFunding(j.funding, j.groups);
        if (j.overrides) onOverrides(j.overrides);
        const a = j.rates?.applied || 0;
        setDone(`Workbook read. ${a ? `${a} tier rate${a === 1 ? "" : "s"} set from billing across ${j.rates.groups} group${j.rates.groups === 1 ? "" : "s"}` : "Every billed rate already matched the XML"}${j.rates?.skipped ? ` · ${j.rates.skipped} billed plan${j.rates.skipped === 1 ? "" : "s"} not in the group's XML` : ""}.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      if (ref.current) ref.current.value = "";
    }
  }

  async function assign(invoice: string, group: string | null) {
    setError("");
    try {
      const j = await post(token, "/api/admin/funding/assign", { invoice, group });
      onFunding(j.funding, j.groups);
      if (j.overrides) onOverrides(j.overrides);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function applyAll() {
    setBusy("Writing billed rates…");
    setError("");
    try {
      const j = await post(token, "/api/admin/funding/apply-rates", { all: true });
      onOverrides(j.overrides);
      setDone(`${j.applied} tier rate${j.applied === 1 ? "" : "s"} set from ${monthLabel(funding?.month || null)} billing across ${j.groups} group${j.groups === 1 ? "" : "s"}${j.skipped ? ` · ${j.skipped} skipped (plan not in the group's XML)` : ""}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const gs = groups as G[];
  const rows = useMemo(() => {
    if (!funding) return [];
    return gs
      .map((g) => {
        const f = funding.summary[g.name] || null;
        // The workbook is the captives' billing, so the XML side is the
        // group's EBPA/HealthEZ medical; a Blue Cross plan is billed elsewhere.
        const xmlN = g.groupHealthEnrolled ?? g.enrolled ?? 0;
        const xml$ = g.groupHealthMonthly ?? (g.plans || []).reduce((n, p) => n + (p.monthly || 0), 0);
        const billN = f ? f.medical.participants : 0;
        const bill$ = f ? f.medical.monthly : 0;
        const ok = f ? close(bill$, xml$, 0.01, 50) && close(billN, xmlN, 0.02, 2) : null;
        return { g, f, xmlN, xml$, billN, bill$, ok };
      })
      .filter((r) => r.f || (r.xmlN > 0 && !r.g.archived))
      .sort((a, b) => Math.abs(b.bill$ - b.xml$) - Math.abs(a.bill$ - a.xml$));
  }, [funding, gs]);

  const unassigned = funding ? Object.entries(funding.byInvoice).filter(([, a]) => !a.group) : [];
  const sortedNames = [...groups].map((g) => g.name).sort((a, b) => a.localeCompare(b));
  const mismatches = rows.filter((r) => r.ok === false).length;
  const noBilling = rows.filter((r) => !r.f).length;

  return (
    <ImportSection
      step={3}
      title="Monthly funding workbook"
      what="September_Funding_….xlsx - the month's billing, one line per participant per product"
      accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
      ariaLabel="Upload the monthly funding workbook"
      inputRef={ref}
      disabled={!!busy}
      onFile={(f) => void upload(f)}
      busy={busy}
      last={funding ? { filename: funding.filename, when: funding.uploadedAt, by: funding.uploadedBy } : null}
      status={
        !funding
          ? { kind: "none", label: "Not uploaded yet" }
          : funding.totals.unassigned
            ? { kind: "warn", label: `${funding.totals.unassigned} invoice${funding.totals.unassigned === 1 ? "" : "s"} need a group` }
            : { kind: "ok", label: "Filed and applied" }
      }
      summary={
        funding
          ? `${monthLabel(funding.month)} · ${funding.totals.assigned} of ${funding.totals.invoices} invoices filed · ${funding.totals.participantsAll.toLocaleString()} medical participants · ${money0(funding.totals.medicalMonthly)} / mo · ${mismatches ? `${mismatches} group${mismatches === 1 ? "" : "s"} differ from the XML` : "every group within 1% of the XML"}`
          : "Once uploaded, every invoice is filed under its group and the billed rates go onto the plans."
      }
      error={error}
      done={done}
    >
      {funding && (
        <>
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12 }}>
            {[
              ["Medical Participants Billed", funding.totals.participantsAll.toLocaleString(), `${funding.totals.participants.toLocaleString()} on invoices filed under a group`],
              ["Medical Premium Billed", money0(funding.totals.medicalMonthly), `the month's own lines · ${signed(funding.totals.adjustments)} in ${funding.totals.retroLines} retro and ${funding.totals.creditLines} credit lines`],
              ["Other Lines Billed", money0(funding.totals.otherMonthly), "dental, vision, life, disability …"],
              ["Invoices", `${funding.totals.assigned} of ${funding.totals.invoices}`, funding.totals.unassigned ? `${funding.totals.unassigned} need a group` : "all filed under a group"],
            ].map(([label, value, note]) => (
              <div key={label} style={{ padding: "10px 12px", background: C.zebra, border: `1px solid ${C.hairline}`, borderRadius: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.body }}>{label}</div>
                <div style={{ marginTop: 3, fontSize: 20, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
                <div style={{ fontSize: 11.5, color: C.faint }}>{note}</div>
              </div>
            ))}
          </div>

          {unassigned.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.amber }}>
                Invoices Not Filed Under A Group · {unassigned.length}
              </h3>
              <div style={{ marginTop: 4, fontSize: 12.5, color: C.muted, lineHeight: 1.6, maxWidth: 880 }}>
                None of the people billed on these invoices appear in any group&rsquo;s XML members, and the billing
                org does not carry a group&rsquo;s name. Most are companies that are not in the Employee Navigator
                export at all. Pick a group if one belongs here; otherwise leave it and it stays out of every group figure.
              </div>
              <table style={{ borderCollapse: "collapse", fontSize: 12.5, marginTop: 8, minWidth: 700 }}>
                <tbody>
                  {unassigned.map(([inv, a]) => (
                    <tr key={inv}>
                      <td style={cell()}>#{inv}</td>
                      <td style={{ ...cell(), whiteSpace: "normal", color: C.body }}>{a.orgs.join(" · ")}</td>
                      <td style={cell(true)}>{a.total} medical line{a.total === 1 ? "" : "s"}</td>
                      <td style={cell()}>
                        <select
                          value=""
                          onChange={(e) => e.target.value && void assign(inv, e.target.value)}
                          aria-label={`Group for invoice ${inv}`}
                          style={{ padding: "5px 8px", fontSize: 12.5, border: `1px solid ${C.inputEdge}`, borderRadius: 4, maxWidth: 280 }}
                        >
                          <option value=""> - file under a group - </option>
                          {a.candidates.map((c) => (
                            <option key={"c" + c.group} value={c.group}>
                              {c.group} (likely: {c.votes} matched)
                            </option>
                          ))}
                          {sortedNames.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 18, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.ink }}>Billing Against The XML, Group By Group</h3>
            <span style={{ fontSize: 12.5, color: C.faint }}>
              {rows.length} groups · {mismatches ? `${mismatches} differ by more than 1% or 2 people` : "all within 1%"}
              {noBilling ? ` · ${noBilling} with medical in the XML but no billing this month` : ""}
            </span>
          </div>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={th()}>Group</th>
                  <th style={th(true)}>XML enrolled</th>
                  <th style={th(true)}>Billed participants</th>
                  <th style={th(true)}>Diff</th>
                  <th style={th(true)}>XML medical / mo</th>
                  <th style={th(true)}>Billed medical</th>
                  <th style={th(true)}>Diff</th>
                  <th style={th(true)}>Other lines billed</th>
                  <th style={th(true)}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ g, f, xmlN, xml$, billN, bill$, ok }) => (
                  <tr key={g.name} style={{ color: g.archived ? C.faint : C.ink }}>
                    <td style={{ ...cell(), whiteSpace: "normal" }}>
                      <Link href={groupPath(g.name)}>{g.name}</Link>
                      {g.archived && <span style={{ fontSize: 11.5, color: C.faint }}> · archived</span>}
                      {f && f.orgs.length > 1 && <div style={{ fontSize: 11, color: C.ghost }}>{f.orgs.length} billing divisions</div>}
                    </td>
                    <td style={cell(true)}>{xmlN}</td>
                    <td style={cell(true)}>{f ? billN : "-"}</td>
                    <td style={cell(true)}>{f ? diff(billN, xmlN) : ""}</td>
                    <td style={cell(true)}>{money0(xml$)}</td>
                    <td style={cell(true)}>{f ? money0(bill$) : "-"}</td>
                    <td style={cell(true)}>{f ? diff(bill$, xml$, true) : ""}</td>
                    <td style={{ ...cell(true), color: C.body }}>{f ? money0(f.other.monthly) : "-"}</td>
                    <td style={cell(true)}>
                      {!f ? (
                        <span style={pill(C.amber, C.amberTint, C.amberEdge)}>No billing</span>
                      ) : ok ? (
                        <span style={pill(C.green, C.greenTint, C.greenEdge)}>Matches</span>
                      ) : (
                        <span style={pill(C.red, C.redTint, C.redEdge)}>Check</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <button onClick={() => void applyAll()} disabled={!!busy} style={btn(true)}>
              Use billed rates for every group
            </button>
            <span style={{ fontSize: 12.5, color: C.faint, maxWidth: 640, lineHeight: 1.5 }}>
              Sets each plan&rsquo;s tier rate to what {monthLabel(funding.month)} billing shows, wherever the XML has no billed
              rate for that tier or a different one. Rates already matching are left alone; each company page can do the same for one group.
            </span>
          </div>
        </>
      )}
    </ImportSection>
  );
}

interface BillingProps {
  token: string;
  group: AdminGroup;
  month: string | null;
  onOverrides: (o: Record<string, string>) => void;
}

/** The company page's billing panel: what this group is billed this month, plan by plan and tier by tier. */
export function GroupBilling({ token, group, month, onOverrides }: BillingProps) {
  const g = group as G;
  const f = g.funding;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (!f) return null;

  const xmlRate = (plan: string, tier: string) => g.rates?.[plan]?.[tier];
  const plans = Object.entries(f.medical.byPlan);
  const inXml = new Set((g.plans || []).map((p) => p.plan));
  const differing = plans.reduce(
    (n, [plan, p]) => n + Object.entries(p.byTier).filter(([t, x]) => x.rate != null && inXml.has(plan) && (xmlRate(plan, t) == null || Math.abs((xmlRate(plan, t) as number) - x.rate) > 0.01)).length,
    0,
  );

  async function apply() {
    setBusy(true);
    setNote("");
    try {
      const j = await post(token, "/api/admin/funding/apply-rates", { group: group.name });
      onOverrides(j.overrides);
      setNote(`${j.applied} tier rate${j.applied === 1 ? "" : "s"} set from billing${j.skipped ? ` · ${j.skipped} skipped (plan not in this group's XML)` : ""}.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>{monthLabel(month)} Billing</h3>
        <span style={{ fontSize: 12.5, color: C.faint }}>
          {f.medical.participants} medical participants · {money0(f.medical.monthly)} medical
          {f.medical.adjustments ? ` (${signed(f.medical.adjustments)} in ${[f.medical.retro ? `${f.medical.retro} retro` : "", f.medical.credits ? `${f.medical.credits} credit${f.medical.credits === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")})` : ""}
          {" "}· {money0(f.other.monthly)} other lines · {money0(f.totalBilled)} billed · invoice{f.invoices.length === 1 ? "" : "s"} {f.invoices.map((i) => "#" + i).join(", ")}
          {f.orgs.length > 1 ? ` · ${f.orgs.length} billing divisions` : ""}
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted, lineHeight: 1.6, maxWidth: 820 }}>
        What Employee Navigator billed this group for the month, from the funding workbook. The rate is the
        amount most of the month&rsquo;s lines carry for that tier; retro lines and credits are prior months
        billed late or reversed and sit outside the count.
      </div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
          <thead>
            <tr>
              <th style={th()}>Plan</th>
              {TIERS.map((t) => (
                <th key={t} style={th(true)}>{TIER_SHORT[t]}</th>
              ))}
              <th style={th(true)}>Billed / mo</th>
            </tr>
          </thead>
          <tbody>
            {plans.map(([plan, p]) => (
              <tr key={plan}>
                <td style={{ ...cell(), whiteSpace: "normal" }}>
                  {plan}
                  {!inXml.has(plan) && <div style={{ fontSize: 11, color: C.amber }}>not among this group&rsquo;s XML plans</div>}
                  {p.untiered && (
                    <div style={{ fontSize: 11, color: C.amber }}>
                      {p.untiered.n} line{p.untiered.n === 1 ? "" : "s"} with no rate band @ {p.untiered.rates.map((r) => `$${r.toFixed(2)}`).join(", ")}
                    </div>
                  )}
                </td>
                {TIERS.map((t) => {
                  const x = p.byTier[t];
                  const xr = xmlRate(plan, t);
                  const off = x && x.rate != null && xr != null && Math.abs(xr - x.rate) > 0.01;
                  return (
                    <td key={t} style={cell(true)}>
                      {x && (x.n > 0 || x.rate != null) ? (
                        <>
                          <div>
                            <strong>{x.n}</strong> @ {x.rate == null ? "-" : `$${x.rate.toFixed(2)}`}
                            {x.rateProrated ? <span style={{ fontSize: 11, color: C.amber }}> prorated</span> : ""}
                          </div>
                          <div style={{ fontSize: 11, color: off ? C.red : xr == null ? C.amber : C.ghost }}>
                            {xr == null ? "XML: no billed rate" : off ? `XML: $${xr.toFixed(2)}` : "XML same"}
                            {x.retro ? ` · ${x.retro} retro` : ""}
                            {x.credits ? ` · ${x.credits} credit${x.credits === 1 ? "" : "s"}` : ""}
                          </div>
                        </>
                      ) : x ? (
                        <span style={{ fontSize: 11, color: C.ghost }}>
                          - {x.retro ? ` · ${x.retro} retro` : ""}
                          {x.credits ? ` · ${x.credits} credit${x.credits === 1 ? "" : "s"}` : ""}
                        </span>
                      ) : (
                        <span style={{ color: C.ghost }}>-</span>
                      )}
                    </td>
                  );
                })}
                <td style={{ ...cell(true), fontWeight: 600 }}>{money0(p.monthly)}</td>
              </tr>
            ))}
            {Object.keys(f.other.byProduct).length > 0 && (
              <tr>
                <td style={{ ...cell(), color: C.body, whiteSpace: "normal" }}>
                  Other lines: {Object.entries(f.other.byProduct).map(([k, v]) => `${k} (${v.lines})`).join(" · ")}
                </td>
                <td colSpan={4} />
                <td style={{ ...cell(true), fontWeight: 600 }}>{money0(f.other.monthly)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <button onClick={() => void apply()} disabled={busy || !differing} style={{ ...btn(true), opacity: busy || !differing ? 0.6 : 1, cursor: busy || !differing ? "default" : "pointer" }}>
          {differing
            ? `Use billed rates (${differing} tier${differing === 1 ? "" : "s"} differ)`
            : plans.some(([plan]) => inXml.has(plan))
              ? "Billed rates already match"
              : "No XML plan to compare"}
        </button>
        {note && <span style={{ fontSize: 12.5, color: C.green }}>{note}</span>}
      </div>
    </div>
  );
}


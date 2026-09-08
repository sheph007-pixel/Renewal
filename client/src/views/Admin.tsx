import { useMemo, useState } from "react";
import {
  TIERS,
  factorsHold,
  ovKey,
  rateFor,
  type KennionData,
  type Overrides,
} from "@/lib/model";
import { C, chip, Logo, num, panel, pill, textInput, th } from "@/lib/ui";
import Link from "@/lib/Link";
import { PATHS, navigate } from "@/lib/router";
import Footer from "@/views/Footer";
import ImportPanel from "@/views/ImportPanel";
import GroupsTable, { type AdminGroup } from "@/views/GroupsTable";
import GroupDetail from "@/views/GroupDetail";
import Proposals from "@/views/Proposals";
import Reconciliation, { type CarrierStats, type ImportDiagnostics } from "@/views/Reconciliation";
import FundingPanel, { type FundingInfo } from "@/views/Funding";
import TwoFactor from "@/views/TwoFactor";
import AuditPanel from "@/views/AuditPanel";

interface Props {
  data: KennionData;
  token: string;
  durable: boolean;
  storage: string;
  saveState: "idle" | "saving" | "saved" | "error";
  onImported: (groups: unknown[], imports?: ImportRecord[]) => void;
  imports: ImportRecord[];
  /** Employee Navigator's carrier stats report, if one has been uploaded. */
  carrierStats: CarrierStats | null;
  /** Whether the server has an Anthropic key. */
  ai: boolean;
  /** The month's funding workbook, if uploaded. */
  funding: FundingInfo | null;
  onFunding: (f: FundingInfo, groups?: unknown[]) => void;
  onOverrides: (o: Record<string, string>) => void;
  onCarrierStats: (s: CarrierStats) => void;
  /** Which tab the address names. */
  tab: AdminTab;
  /** The company page open under /admin/groups/:name, if any. */
  openGroup: string | null;
  overrides: Overrides;
  query: string;
  tpa: string;
  gapsOnly: boolean;
  onQuery: (v: string) => void;
  onTpa: (v: string) => void;
  onToggleGaps: () => void;
  onSetOverride: (group: string, plan: string, census: string, raw: string) => void;
  onExport: () => void;
  onExit: () => void;
}

const cellBase = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  textAlign: "right" as const,
  border: `1px solid ${C.border}`,
  borderRadius: 3,
  outline: "none",
  background: "#fff",
  ...num,
};

export type AdminTab = "groups" | "rates" | "proposals" | "import";

const TABS: { key: AdminTab; label: string; href: string }[] = [
  { key: "groups", label: "Groups", href: PATHS.groups },
  { key: "rates", label: "Existing Plans & Rates", href: PATHS.rates },
  { key: "proposals", label: "Proposals", href: PATHS.proposals },
  { key: "import", label: "Import", href: PATHS.import },
];

export interface ImportRecord {
  filename: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
  companies_found: number;
  companies_applied: number;
  /** What the parser left out of this import and why (see server/en-parse.js). */
  diagnostics?: ImportDiagnostics | null;
}

export default function Admin({
  data,
  token,
  durable,
  storage,
  saveState,
  onImported,
  imports,
  carrierStats,
  onCarrierStats,
  ai,
  funding,
  onFunding,
  onOverrides,
  tab,
  openGroup,
  overrides,
  query,
  tpa,
  gapsOnly,
  onQuery,
  onTpa,
  onToggleGaps,
  onSetOverride,
  onExport,
  onExit,
}: Props) {
  /**
   * One roster rule for the whole admin: a group that is archived, or not on a
   * program carrier, is not in the portal — so it is not rate-administered
   * either. Plans & Rates used to iterate every group and disagreed with the
   * Groups tab's count.
   */
  // Bumped after any upload so the audit at the top re-reads.
  const [auditVersion, setAuditVersion] = useState(0);
  const bump = () => setAuditVersion((v) => v + 1);

  const activeGroups = useMemo(
    () =>
      data.groups.filter(
        (g) =>
          !(g as unknown as { archived?: boolean }).archived &&
          (g as unknown as { eligible?: boolean }).eligible !== false,
      ),
    [data.groups],
  );

  const { all, stats } = useMemo(() => {
    let nBilled = 0;
    let nManual = 0;
    let nCalc = 0;
    let nNone = 0;
    let nOff = 0;
    let nOnSchedule = 0;
    let nUnjudged = 0;
    let totalCells = 0;

    const all = activeGroups.flatMap((g) =>
      (g.plans || []).map((p) => {
        const billedMap = (g.rates || {})[p.plan] || {};
        const billedCount = TIERS.filter((t) => billedMap[t.census] != null).length;
        // A plan can only be judged off-schedule once two tiers are billed.
        const offSchedule = billedCount >= 2 && !factorsHold(overrides, g, p.plan);
        if (offSchedule) nOff++;
        else if (billedCount >= 2) nOnSchedule++;
        else nUnjudged++;

        const cells = TIERS.map((t) => {
          totalCells++;
          const ovRaw = overrides[ovKey(g.name, p.plan, t.census)];
          const billed = billedMap[t.census];
          const calc = rateFor(overrides, g, p.plan, t.key);

          if (ovRaw != null && String(ovRaw) !== "") {
            nManual++;
            return {
              census: t.census,
              value: String(ovRaw),
              placeholder: "",
              title: "Entered by hand",
              style: {
                ...cellBase,
                color: C.blue,
                fontWeight: 600,
                borderColor: "#9cbdf0",
                background: "#f5f9ff",
              },
            };
          }
          if (billed != null) {
            nBilled++;
            return {
              census: t.census,
              value: billed.toFixed(2),
              placeholder: "",
              title: "Billed rate from Employee Navigator",
              style: { ...cellBase, color: C.ink, fontWeight: 600, background: "#fbfcfc" },
            };
          }
          if (calc.rate != null) {
            nCalc++;
            return {
              census: t.census,
              value: "",
              placeholder: calc.rate.toFixed(2),
              title: offSchedule
                ? "Approximate — this plan is priced off the standard schedule. Key the real rate."
                : "Calculated at the program tier factors. Type over it with the billed rate.",
              style: {
                ...cellBase,
                color: C.blue,
                fontWeight: 600,
                borderColor: offSchedule ? "#ecc9a4" : C.border,
              },
            };
          }
          nNone++;
          return {
            census: t.census,
            value: "",
            placeholder: "—",
            title: "No rate on file and nothing to calculate from.",
            style: {
              ...cellBase,
              color: C.blue,
              fontWeight: 600,
              borderColor: C.redEdge,
              background: "#fefaf9",
            },
          };
        });

        const missing = cells.filter((c) => c.value === "").length;
        const noBasis = cells.every((c) => c.value === "" && c.placeholder === "—");
        const status = noBasis
          ? "No basis"
          : offSchedule
            ? "Off schedule"
            : missing === 0
              ? "Complete"
              : `${missing} calculated`;
        const tone: Record<string, [string, string, string]> = {
          Complete: [C.green, C.greenTint, C.greenEdge],
          "Off schedule": [C.amber, C.amberTint, C.amberEdge],
          "No basis": [C.red, C.redTint, C.redEdge],
        };
        const [fg, bg, bd] = tone[status] || [C.body, "#f2f4f5", "#e0e4e6"];

        return {
          group: g.name,
          code: g.code,
          plan: p.plan,
          tpa: p.tpa,
          enrolled: p.enrolled,
          cells,
          status,
          missing,
          statusStyle: pill(fg, bg, bd),
        };
      }),
    );

    return {
      all,
      stats: { nBilled, nManual, nCalc, nNone, nOff, nOnSchedule, nUnjudged, totalCells },
    };
  }, [activeGroups, overrides]);

  const q = query.trim().toLowerCase();
  const rows = all.filter(
    (r) =>
      (tpa === "All" || r.tpa === tpa) &&
      (!gapsOnly || r.missing > 0) &&
      (!q || `${r.group} ${r.plan}`.toLowerCase().includes(q)),
  );

  const kpis = [
    {
      label: "Groups",
      value: String(activeGroups.length),
      note: `${all.length} plans in force`,
    },
    {
      label: "Rates Billed",
      value: String(stats.nBilled),
      note: `of ${stats.totalCells} tier rates, from Employee Navigator`,
    },
    {
      label: "Entered By Hand",
      value: String(stats.nManual),
      note: stats.nManual ? (storage === "postgres" ? "saved to the database" : "saved on the server") : "none yet",
    },
    {
      label: "Still Calculated",
      value: String(stats.nCalc + stats.nNone),
      note: "at the tier schedule, until a real rate is keyed",
    },
    {
      label: "On The Tier Schedule",
      value: stats.nOff ? `${stats.nOnSchedule} of ${stats.nOnSchedule + stats.nOff}` : String(stats.nOnSchedule),
      note: stats.nOff
        ? `${stats.nOff} plan${stats.nOff === 1 ? "" : "s"} priced off it — key the real rates`
        : "every plan with two billed tiers holds",
    },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.page }}>
      <div style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, padding: "0 22px" }}>
        <div
          style={{
            maxWidth: 1680,
            margin: "0 auto",
            height: 56,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Link href={PATHS.groups} aria-label="Rate Administration home" style={{ display: "block" }}>
              <img src={Logo} alt="Kennion Benefit Advisors" style={{ height: 30, display: "block" }} />
            </Link>
            <Link
              href={PATHS.groups}
              style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, textDecoration: "none" }}
            >
              Rate Administration
            </Link>
          </div>
          <button
            onClick={onExit}
            style={{
              background: "none",
              border: "none",
              fontSize: 13.5,
              color: C.blue,
              cursor: "pointer",
              padding: 0,
            }}
          >
            Exit
          </button>
        </div>

        <nav
          aria-label="Rate Administration"
          style={{ maxWidth: 1680, margin: "0 auto", display: "flex", gap: 2 }}
        >
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              aria-current={tab === t.key ? "page" : undefined}
              style={{
                display: "block",
                borderBottom: `3px solid ${tab === t.key ? C.orange : "transparent"}`,
                padding: "0 15px 11px",
                fontSize: 13.5,
                fontWeight: tab === t.key ? 600 : 400,
                color: tab === t.key ? C.ink : C.body,
                textDecoration: "none",
              }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>

      <div style={{ maxWidth: 1680, margin: "0 auto", padding: "20px 22px 60px" }}>
        {tab === "rates" && (
        <>
        <div
          style={{
            ...panel,
            padding: "20px 22px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 20,
          }}
        >
          <div style={{ maxWidth: 900 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 23,
                fontWeight: 600,
                color: C.ink,
                letterSpacing: "-0.2px",
              }}
            >
              Existing 2026 Rates &mdash; All Groups, All Plans
            </h1>
          </div>
          <button
            onClick={onExport}
            style={{
              padding: "8px 16px",
              fontSize: 13.5,
              fontWeight: 500,
              color: "#fff",
              background: C.blue,
              border: `1px solid ${C.blue}`,
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Export rates
          </button>
        </div>


        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(178px,1fr))",
            gap: 14,
            marginTop: 16,
          }}
        >
          {kpis.map((k) => (
            <div key={k.label} style={{ ...panel, padding: "15px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.body }}>{k.label}</div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 24,
                  fontWeight: 600,
                  color: C.ink,
                  letterSpacing: "-0.4px",
                  ...num,
                }}
              >
                {k.value}
              </div>
              <div style={{ marginTop: 3, fontSize: 12, color: C.faint }}>{k.note}</div>
            </div>
          ))}
        </div>

        <div style={{ ...panel, marginTop: 16, padding: "12px 16px", fontSize: 12.5, color: C.body, lineHeight: 1.6 }}>
          <strong style={{ color: C.ink }}>Tier Schedule</strong> — Employee 1.00 · Employee + Child(ren) 1.85 · Employee
          + Spouse 2.00 · Employee + Family 2.85. Every calculated rate on this page is the plan&rsquo;s employee rate at
          these factors.{" "}
          {stats.nOff
            ? `${stats.nOnSchedule} of ${stats.nOnSchedule + stats.nOff} plans with two or more billed tiers hold the schedule; ${stats.nOff} do not and are marked "Off schedule".`
            : `All ${stats.nOnSchedule} plans with two or more billed tiers hold it.`}
          {stats.nUnjudged ? ` ${stats.nUnjudged} plan${stats.nUnjudged === 1 ? " has" : "s have"} fewer than two billed tiers, so there is nothing to check against.` : ""}
        </div>

        <div
          style={{
            ...panel,
            marginTop: 16,
            padding: "12px 16px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
          }}
        >
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search group or plan"
            aria-label="Search group or plan"
            autoComplete="off"
            style={{ ...textInput, flex: 1, minWidth: 240, fontSize: 13.5, padding: "8px 11px" }}
          />
          <div style={{ display: "flex", gap: 2 }}>
            {["All", "EBPA", "HealthEZ"].map((t) => (
              <button key={t} onClick={() => onTpa(t)} style={chip(tpa === t)}>
                {t}
              </button>
            ))}
          </div>
          <button onClick={onToggleGaps} style={chip(gapsOnly)}>
            Needs a real rate
          </button>
          <span
            style={{
              fontSize: 12.5,
              marginLeft: "auto",
              color:
                saveState === "error" ? C.red : saveState === "saved" ? C.green : C.faint,
            }}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : saveState === "error"
                  ? "Not saved — sign in again"
                  : `${rows.length} of ${all.length} plans`}
          </span>
        </div>

        <div style={{ ...panel, marginTop: 16, padding: "4px 18px 16px", overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1120 }}
          >
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ ...th, padding: "12px 8px 11px 0" }}>Group</th>
                <th style={th}>Plan</th>
                <th style={{ ...th, textAlign: "right" }} title="Employees enrolled in this plan — the same count the Groups page adds up per group">
                  Enrolled
                </th>
                {TIERS.map((t) => (
                  <th key={t.key} style={{ ...th, textAlign: "right", width: 112 }}>
                    {t.key === "EE"
                      ? "EE"
                      : t.key === "FAM"
                        ? "EE + Family"
                        : `EE + ${t.key === "ES" ? "SP" : "CH"}`}
                  </th>
                ))}
                <th style={{ ...th, padding: "12px 0 11px 8px" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.group}||${r.plan}`}>
                  <td
                    style={{
                      padding: "8px 8px 8px 0",
                      color: C.ink,
                      borderBottom: `1px solid ${C.hairline}`,
                      lineHeight: 1.4,
                    }}
                  >
                    {r.group}
                    <div style={{ fontSize: 11.5, color: C.ghost }}>{r.code}</div>
                  </td>
                  <td
                    style={{
                      padding: 8,
                      color: C.body,
                      borderBottom: `1px solid ${C.hairline}`,
                      lineHeight: 1.4,
                    }}
                  >
                    {r.plan}
                    <div style={{ fontSize: 11.5, color: C.ghost }}>{r.tpa}</div>
                  </td>
                  <td
                    style={{
                      padding: 8,
                      textAlign: "right",
                      color: C.body,
                      borderBottom: `1px solid ${C.hairline}`,
                      ...num,
                    }}
                  >
                    {r.enrolled}
                  </td>
                  {r.cells.map((c) => (
                    <td
                      key={c.census}
                      style={{ padding: "5px 4px", borderBottom: `1px solid ${C.hairline}` }}
                    >
                      <input
                        value={c.value}
                        placeholder={c.placeholder}
                        title={c.title}
                        aria-label={`${r.group} — ${r.plan} — ${c.census}`}
                        onChange={(e) =>
                          onSetOverride(r.group, r.plan, c.census, e.target.value)
                        }
                        inputMode="decimal"
                        autoComplete="off"
                        style={c.style}
                      />
                    </td>
                  ))}
                  <td style={{ padding: "8px 0 8px 8px", borderBottom: `1px solid ${C.hairline}` }}>
                    <span style={r.statusStyle}>{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        </>
        )}

        {tab === "groups" &&
          (openGroup ? (
            (() => {
              const g = (data.groups as unknown as AdminGroup[]).find((x) => x.name === openGroup);
              return g ? (
                <GroupDetail
                  group={g}
                  token={token}
                  onChanged={(gs) => onImported(gs as unknown[])}
                  onBack={() => navigate(PATHS.groups)}
                  onOpenRates={(name) => {
                    onQuery(name);
                    onTpa("All");
                  }}
                  fundingMonth={funding?.month || null}
                  onOverrides={onOverrides}
                />
              ) : (
                <div style={{ ...panel, marginTop: 16, padding: "20px 22px" }}>
                  <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 10 }}>
                    <Link href={PATHS.groups}>Groups</Link>
                  </nav>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>
                    No group called &ldquo;{openGroup}&rdquo;
                  </h2>
                  <div style={{ marginTop: 8, fontSize: 13, color: C.muted, lineHeight: 1.65 }}>
                    The link may be out of date, or the company is filed under a different name.{" "}
                    <Link href={PATHS.groups}>Back to the Groups list</Link> to find it.
                  </div>
                </div>
              );
            })()
          ) : (
            <GroupsTable
              groups={data.groups as unknown as AdminGroup[]}
              token={token}
              onChanged={(gs) => onImported(gs as unknown[])}
            />
          ))}

        {tab === "proposals" && (
          <Proposals
            token={token}
            groups={(data.groups as unknown as AdminGroup[]).filter(
              (g) => !g.archived && g.eligible !== false,
            )}
          />
        )}

        {tab === "import" && (
          <>
            {storage !== "postgres" && !durable && (
              <div style={{ marginTop: 16, fontSize: 13, color: C.amber, lineHeight: 1.6, maxWidth: 840 }}>
                No database is connected, so uploads are lost on the next deploy.
              </div>
            )}
            <AuditPanel token={token} version={auditVersion} ai={ai} />
            <ImportPanel
              token={token}
              durable={durable}
              storage={storage}
              onImported={(gs, ims) => {
                onImported(gs, ims as ImportRecord[] | undefined);
                bump();
              }}
              last={
                imports[0]
                  ? {
                      filename: imports[0].filename,
                      when: imports[0].uploaded_at,
                      by: imports[0].uploaded_by,
                      companies: imports[0].companies_applied,
                      enrolled: activeGroups.reduce((n, g) => n + (g.enrolled || 0), 0),
                    }
                  : null
              }
            />

            <Reconciliation
              token={token}
              stats={carrierStats}
              groups={data.groups as unknown as AdminGroup[]}
              onStats={(st) => {
                onCarrierStats(st);
                bump();
              }}
              diagnostics={imports[0]?.diagnostics || null}
              lastImport={imports[0] ? { filename: imports[0].filename, when: imports[0].uploaded_at } : null}
              ai={ai}
            />

            <FundingPanel
              token={token}
              funding={funding}
              groups={data.groups as unknown as AdminGroup[]}
              onFunding={(f, gs) => {
                onFunding(f, gs);
                bump();
              }}
              onOverrides={onOverrides}
            />

            <TwoFactor token={token} />

            <details style={{ ...panel, marginTop: 16, padding: "14px 22px" }}>
              <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600, color: C.ink }}>
                XML Import History{imports?.length ? ` (${imports.length})` : ""}
              </summary>
              {!imports?.length ? (
                <div style={{ marginTop: 10, fontSize: 13, color: C.faint }}>
                  Nothing imported yet. The portal is serving the shipped census.
                </div>
              ) : (
                <table
                  style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}
                >
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: "left" }}>File</th>
                      <th style={{ ...th, textAlign: "left" }}>When</th>
                      <th style={{ ...th, textAlign: "left" }}>By</th>
                      <th style={{ ...th, textAlign: "right" }}>Found</th>
                      <th style={{ ...th, textAlign: "right" }}>Imported</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imports.map((im, i) => (
                      <tr key={i}>
                        <td
                          style={{
                            padding: "8px 8px 8px 0",
                            borderBottom: `1px solid ${C.hairline}`,
                            color: C.ink,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {im.filename || "(unnamed)"}
                        </td>
                        <td
                          style={{
                            padding: 8,
                            borderBottom: `1px solid ${C.hairline}`,
                            color: C.body,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {new Date(im.uploaded_at).toLocaleString()}
                        </td>
                        <td style={{ padding: 8, borderBottom: `1px solid ${C.hairline}`, color: C.body }}>
                          {im.uploaded_by || "—"}
                        </td>
                        <td
                          style={{
                            padding: 8,
                            borderBottom: `1px solid ${C.hairline}`,
                            textAlign: "right",
                            color: C.body,
                            ...num,
                          }}
                        >
                          {im.companies_found}
                        </td>
                        <td
                          style={{
                            padding: "8px 0 8px 8px",
                            borderBottom: `1px solid ${C.hairline}`,
                            textAlign: "right",
                            color: C.ink,
                            fontWeight: 600,
                            ...num,
                          }}
                        >
                          {im.companies_applied}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}

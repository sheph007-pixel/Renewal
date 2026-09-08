import { useMemo, useState, type CSSProperties } from "react";
import { C, money0, panel } from "@/lib/importui";
import Link from "@/lib/Link";
import { groupPath } from "@/lib/router";

export interface AdminGroup {
  name: string;
  code: string;
  sizeCategory: "2-50" | "51+";
  sizeIsSet?: boolean;
  codeIsSet?: boolean;
  /** Who brokers the group. Only the label is kept, never a broker's name. */
  broker?: "kennion" | "outside";
  brokerIsSet?: boolean;
  /** The Kennion account manager who looks after the group. */
  manager?: "debbie" | "tracy" | null;
  /** The proposal slots this group has — Cobalt only where it is quoted. */
  slots?: string[];
  /** The group's permanent, unguessable address token. */
  linkToken?: string | null;
  /** Where the 2027 renewal stands, for tracking. */
  renewal?: Renewal;
  /** Carrier proposals filed under this group. */
  proposals?: number;
  /** Billed rates from the XML, plan → tier → rate. */
  rates?: Record<string, Record<string, number>>;
  /** This month's billing for the group, from the funding workbook. */
  funding?: import("@/views/Funding").GroupFunding | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  sic: string | null;
  sicDesc: string | null;
  taxId?: string | null;
  phone?: string | null;
  contacts?: { name: string | null; email: string | null; phone: string | null }[];
  enrolled: number;
  lives: number;
  imported?: boolean;
  importedAt?: string | null;
  archived?: boolean;
  /** Set when an import found no record of this census-only company and archived it. */
  notInExport?: string | null;
  eligible?: boolean;
  programs?: string[];
  carriersSeen?: string[];
  enName?: string | null;
  duplicateOf?: string[];
  tpa?: string;
  plans?: { plan: string; tpa: string; enrolled: number; monthly: number }[];
  /** Medical premium on EBPA + HealthEZ only — the captive program. BCBS of Alabama is excluded. */
  groupHealthMonthly?: number;
  /** Every medical plan, BCBS included. */
  medicalMonthly?: number;
  /** Dental, vision, life, disability … — 0 until the group's export has been re-read for them. */
  supplementalMonthly?: number;
  /** Medical + supplemental. */
  totalMonthly?: number;
  /** Whether supplemental lines were captured for this group at all. */
  linesLoaded?: boolean;
  groupHealthEnrolled?: number;
  bcbsMonthly?: number;
  bcbsEnrolled?: number;
  unrecognizedMonthly?: number;
  unrecognizedEnrolled?: number;
  assumedMonthly?: number;
  /** Every non-medical benefit in force, with no member detail. */
  lines?: AdminLine[];
}

export interface AdminLine {
  benefit: string;
  carrier: string;
  plan: string;
  enrolled: number;
  monthly: number;
}

export const BROKER_LABEL = { kennion: "Kennion", outside: "Outside Broker" } as const;
type Broker = keyof typeof BROKER_LABEL;

/** Kennion's account managers, as the roster names them. */
export const MANAGER_LABEL = { debbie: "Debbie", tracy: "Tracy" } as const;
const MANAGER_FULL = { debbie: "Debbie Bostic", tracy: "Tracy Sanders" } as const;
type Manager = keyof typeof MANAGER_LABEL;

export const RENEWALS = ["open", "sent", "renewed", "non-renewed"] as const;
export type Renewal = (typeof RENEWALS)[number];
export const RENEWAL_LABEL: Record<Renewal, string> = {
  open: "Open",
  sent: "Sent",
  renewed: "Renewed",
  "non-renewed": "Non-Renewed",
};
/** [text, background, border] for each renewal state. */
export const RENEWAL_TONE: Record<Renewal, [string, string, string]> = {
  open: [C.blue, C.blueTint, C.blueEdge],
  sent: [C.amber, C.amberTint, C.amberEdge],
  renewed: [C.green, C.greenTint, C.greenEdge],
  "non-renewed": [C.red, C.redTint, C.redEdge],
};

type Field = "companyId" | "sizeCategory" | "broker" | "renewal" | "manager";

type SortKey = "name" | "location" | "contact" | "enrolled" | "share" | "sizeCategory" | "broker" | "manager" | "renewal";

/** Share of the block, as "4.2%". */
const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");

/** Medical premium, summed from the plans in force. */
const monthlyOf = (g: AdminGroup) => (g.plans || []).reduce((n, p) => n + (p.monthly || 0), 0);
/** Group health: EBPA + HealthEZ medical only, as the server works it out. */
const groupHealthOf = (g: AdminGroup) => g.groupHealthMonthly ?? 0;
/** Every line — medical plus whatever supplemental has been loaded. */
const totalOf = (g: AdminGroup) => g.totalMonthly ?? monthlyOf(g);

/**
 * The rows on screen, as a CSV Excel opens cleanly. Exports exactly what the
 * table shows — same search, filters and sort — so a filtered view is a report.
 */
function groupsCsv(rows: AdminGroup[], blockEnrolled: number): string {
  const cols: [string, (g: AdminGroup) => unknown][] = [
    ["Company", (g) => g.name],
    ["Company ID", (g) => g.code],
    ["Employee Navigator name", (g) => g.enName],
    ["Renewal", (g) => RENEWAL_LABEL[g.renewal || "open"]],
    ["Proposals on file", (g) => g.proposals || 0],
    ["Broker", (g) => BROKER_LABEL[g.broker || "kennion"]],
    ["Manager", (g) => (g.manager ? MANAGER_FULL[g.manager] : "")],
    [
      "Client link",
      (g) => {
        if (g.archived || g.eligible === false) return "";
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        return g.linkToken ? `${origin}/g/${g.linkToken}` : `${origin}/?code=${encodeURIComponent(g.code)}`;
      },
    ],
    ["Size", (g) => g.sizeCategory],
    ["Enrolled", (g) => g.enrolled],
    ["% of block (enrolled)", (g) => (blockEnrolled ? ((g.enrolled || 0) / blockEnrolled * 100).toFixed(1) : "")],
    ["Covered lives", (g) => g.lives],
    ["TPA", (g) => g.tpa],
    ["Program carriers", (g) => (g.programs || []).join("; ")],
    ["Plans in force", (g) => (g.plans || []).map((p) => p.plan).join("; ")],
    ["Group health premium (EBPA+HealthEZ)", (g) => groupHealthOf(g).toFixed(2)],
    ["Medical premium", (g) => (g.medicalMonthly ?? monthlyOf(g)).toFixed(2)],
    ["Supplemental premium", (g) => (g.supplementalMonthly ?? 0).toFixed(2)],
    ["Total Premium", (g) => totalOf(g).toFixed(2)],
    ["Supplemental loaded", (g) => (g.linesLoaded ? "Yes" : "No")],
    ["Address", (g) => g.address1],
    ["City", (g) => g.city],
    ["State", (g) => g.state],
    ["ZIP", (g) => g.zip],
    ["SIC", (g) => g.sic],
    ["SIC description", (g) => g.sicDesc],
    ["EIN", (g) => g.taxId],
    ["Phone", (g) => g.phone],
    ["Contact", (g) => g.contacts?.[0]?.name],
    ["Contact email", (g) => g.contacts?.[0]?.email],
    ["Contact phone", (g) => g.contacts?.[0]?.phone],
    ["Other contacts", (g) => (g.contacts || []).slice(1).map((c) => c.name).filter(Boolean).join("; ")],
    ["In program", (g) => (g.eligible === false ? "No" : "Yes")],
    ["Carriers found", (g) => (g.carriersSeen || []).join("; ")],
    ["Archived", (g) => (g.archived ? "Yes" : "No")],
    ["Data from", (g) => (g.importedAt ? `XML import ${new Date(g.importedAt).toLocaleDateString()}` : "Census 7/31/2026")],
  ];
  const cell = (v: unknown) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [cols.map(([h]) => cell(h)).join(",")];
  rows.forEach((g) => lines.push(cols.map(([, f]) => cell(f(g))).join(",")));
  // BOM so Excel reads the file as UTF-8 (names with apostrophes and accents).
  return "﻿" + lines.join("\r\n");
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

interface Props {
  groups: AdminGroup[];
  token: string;
  onChanged: (groups: AdminGroup[]) => void;
  /** Group health as Employee Navigator's carrier stats report states it. */
}

const th: CSSProperties = {
  textAlign: "left",
  padding: "10px 10px",
  fontSize: 12,
  fontWeight: 600,
  color: C.muted,
  textTransform: "uppercase",
  letterSpacing: ".3px",
  borderBottom: `1px solid ${C.border}`,
  whiteSpace: "nowrap",
};
const td: CSSProperties = {
  padding: "10px 10px",
  borderBottom: `1px solid ${C.hairline}`,
  color: C.ink,
  verticalAlign: "top",
  fontSize: 13,
};
const num: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** Compact select, the one control used for every editable label in the grid. */
const selectStyle = (color: string, bg: string = "#fff", border: string = C.border): CSSProperties => ({
  appearance: "none",
  WebkitAppearance: "none",
  padding: "5px 24px 5px 9px",
  fontSize: 12.5,
  fontWeight: 500,
  color,
  background: `${bg} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238b9296' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 8px center`,
  border: `1px solid ${border}`,
  borderRadius: 4,
  cursor: "pointer",
  outline: "none",
  width: "100%",
});

const filterSelect: CSSProperties = {
  ...selectStyle(C.ink, "#fff", C.inputEdge),
  width: "auto",
  padding: "8px 28px 8px 11px",
  fontSize: 13,
  fontWeight: 400,
};

export default function GroupsTable({ groups, token, onChanged }: Props) {
  const [query, setQuery] = useState("");
  const [size, setSize] = useState<"All" | "2-50" | "51+">("All");
  const [broker, setBroker] = useState<"All" | Broker>("All");
  const [manager, setManager] = useState<"All" | Manager | "none">("All");
  const [renewal, setRenewal] = useState<"All" | Renewal>("All");
  const [proposalsFilter, setProposalsFilter] = useState<"All" | "with" | "without">("All");
  const [view, setView] = useState<"live" | "all" | "excluded" | "archived">("live");
  const [sort, setSort] = useState<SortKey>("name");
  const [dir, setDir] = useState(1);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function save(group: string, field: Field, value: string) {
    setError("");
    const r = await fetch("/api/admin/group-meta", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ group, field, value }),
    });
    const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
    if (!r.ok) {
      setError(j.error || "Could not save.");
      return false;
    }
    onChanged(j.groups);
    setSaved(group + "|" + field);
    setTimeout(() => setSaved(""), 1500);
    return true;
  }

  // The roster the dashboard describes: in the portal, not archived. The same
  // rule Plans & Rates uses, so the two pages count the same groups.
  const live = useMemo(() => groups.filter((g) => !g.archived && g.eligible !== false), [groups]);
  // The block a "% of block" is a share of: every group the current view holds,
  // before the other filters. So a share can never exceed 100%.
  const block = useMemo(
    () =>
      groups.filter((g) =>
        view === "all"
          ? true
          : view === "archived"
            ? !!g.archived
            : view === "excluded"
              ? !g.archived && g.eligible === false
              : !g.archived && g.eligible !== false,
      ),
    [groups, view],
  );
  const counts = {
    small: block.filter((g) => g.sizeCategory === "2-50").length,
    large: block.filter((g) => g.sizeCategory === "51+").length,
    archived: groups.filter((g) => g.archived).length,
    excluded: groups.filter((g) => !g.archived && g.eligible === false).length,
    outside: block.filter((g) => g.broker === "outside").length,
    dupes: groups.filter((g) => !g.archived && (g.duplicateOf || []).length).length,
    enrolled: block.reduce((n, g) => n + (g.enrolled || 0), 0),
    lives: block.reduce((n, g) => n + (g.lives || 0), 0),
    monthly: block.reduce((n, g) => n + monthlyOf(g), 0),
    groupHealth: block.reduce((n, g) => n + groupHealthOf(g), 0),
    total: block.reduce((n, g) => n + totalOf(g), 0),
    renewal: Object.fromEntries(
      RENEWALS.map((r) => [r, block.filter((g) => (g.renewal || "open") === r).length]),
    ) as Record<Renewal, number>,
  };

  const q = query.trim().toLowerCase();
  // Everything but the renewal filter, so the renewal tile can count each state
  // within the current slice and still let you switch between states.
  const slice = groups.filter(
    (g) =>
      (view === "all"
        ? true
        : view === "archived"
          ? !!g.archived
          : view === "excluded"
            ? !g.archived && g.eligible === false
            : !g.archived && g.eligible !== false) &&
      (size === "All" || g.sizeCategory === size) &&
      (broker === "All" || (g.broker || "kennion") === broker) &&
      (manager === "All" || (manager === "none" ? !g.manager : g.manager === manager)) &&
      (proposalsFilter === "All" || (proposalsFilter === "with" ? (g.proposals || 0) > 0 : !(g.proposals || 0))) &&
      (!q ||
        `${g.name} ${g.enName ?? ""} ${g.code} ${g.city ?? ""} ${g.state ?? ""} ${g.zip ?? ""} ${g.sic ?? ""} ${g.sicDesc ?? ""} ${g.taxId ?? ""} ${g.tpa ?? ""} ${BROKER_LABEL[g.broker || "kennion"]} ${g.manager ? MANAGER_FULL[g.manager] : ""} ${RENEWAL_LABEL[g.renewal || "open"]} ${(g.contacts ?? []).map((c) => `${c.name} ${c.email}`).join(" ")}`
          .toLowerCase()
          .includes(q)),
  );
  const filtered = slice.filter((g) => renewal === "All" || (g.renewal || "open") === renewal);
  const sliceRenewal = Object.fromEntries(
    RENEWALS.map((r) => [r, slice.filter((g) => (g.renewal || "open") === r).length]),
  ) as Record<Renewal, number>;

  const sortVal = (g: AdminGroup): string | number => {
    if (sort === "enrolled" || sort === "share") return g.enrolled ?? 0;
    if (sort === "contact") return (g.contacts?.[0]?.name || "").toLowerCase();
    if (sort === "location") return `${g.state || ""} ${g.city || ""}`.trim().toLowerCase();
    if (sort === "broker") return BROKER_LABEL[g.broker || "kennion"].toLowerCase();
    if (sort === "manager") return g.manager ? MANAGER_LABEL[g.manager].toLowerCase() : "";
    if (sort === "renewal") return RENEWALS.indexOf(g.renewal || "open");
    const v = (g as unknown as Record<string, unknown>)[sort];
    return String(v ?? "").toLowerCase();
  };
  const rows = [...filtered].sort((a, b) => {
    const va = sortVal(a);
    const vb = sortVal(b);
    if (va === vb) return a.name.localeCompare(b.name);
    // Blanks sort last regardless of direction, so an empty column does not
    // bury the rows that actually have values.
    if (va === "") return 1;
    if (vb === "") return -1;
    return (va > vb ? 1 : -1) * dir;
  });

  const filtering =
    !!q || size !== "All" || broker !== "All" || manager !== "All" || renewal !== "All" || proposalsFilter !== "All" || view !== "live";

  // Totals for what is on screen. They follow every search, filter and sort.
  const shown = {
    enrolled: rows.reduce((n, g) => n + (g.enrolled || 0), 0),
    lives: rows.reduce((n, g) => n + (g.lives || 0), 0),
    monthly: rows.reduce((n, g) => n + monthlyOf(g), 0),
    groupHealth: rows.reduce((n, g) => n + groupHealthOf(g), 0),
    groupHealthEnrolled: rows.reduce((n, g) => n + (g.groupHealthEnrolled ?? g.enrolled ?? 0), 0),
    bcbs: rows.reduce((n, g) => n + (g.bcbsMonthly ?? 0), 0),
    bcbsEnrolled: rows.reduce((n, g) => n + (g.bcbsEnrolled ?? 0), 0),
    unrecognized: rows.reduce((n, g) => n + (g.unrecognizedMonthly ?? 0), 0),
    unrecognizedEnrolled: rows.reduce((n, g) => n + (g.unrecognizedEnrolled ?? 0), 0),
    total: rows.reduce((n, g) => n + totalOf(g), 0),
    // Whether any row's export has been read for supplemental lines; until
    // one has, "total" is medical only and the tile says so.
    linesLoaded: rows.some((g) => g.linesLoaded),
    small: rows.filter((g) => g.sizeCategory === "2-50").length,
    large: rows.filter((g) => g.sizeCategory === "51+").length,
  };

  const sortBy = (k: SortKey) => {
    setDir((d) => (sort === k ? -d : 1));
    setSort(k);
  };
  const H = ({ k, label, align, width }: { k: SortKey; label: string; align?: "right"; width?: number }) => (
    <th
      onClick={() => sortBy(k)}
      aria-sort={sort === k ? (dir > 0 ? "ascending" : "descending") : "none"}
      style={{ ...th, width, textAlign: align || "left", cursor: "pointer", userSelect: "none" }}
    >
      {label}
      <span style={{ color: sort === k ? C.blue : "transparent" }}>{dir > 0 ? " ▲" : " ▼"}</span>
    </th>
  );

  const clear = () => {
    setQuery("");
    setSize("All");
    setBroker("All");
    setManager("All");
    setRenewal("All");
    setProposalsFilter("All");
    setView("live");
  };

  const exportRows = () => {
    const tag = [
      view === "live" ? "" : view === "all" ? "all-groups" : view === "excluded" ? "not-in-program" : "archived",
      renewal === "All" ? "" : renewal,
      broker === "All" ? "" : broker === "outside" ? "outside-broker" : "kennion",
      manager === "All" ? "" : manager === "none" ? "no-manager" : manager,
      size === "All" ? "" : size.replace("+", "plus"),
      q ? "search" : "",
    ]
      .filter(Boolean)
      .join("-");
    const stamp = new Date().toISOString().slice(0, 10);
    download(`kennion-groups${tag ? "-" + tag : ""}-${stamp}.csv`, groupsCsv(rows, counts.enrolled));
  };

  const tile = (label: string, value: string, note: string, aside?: string) => (
    <div key={label} style={{ ...panel, padding: "11px 13px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.body }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 20, fontWeight: 600, color: C.ink, letterSpacing: "-0.3px", ...num }}>
        {value}
      </div>
      <div style={{ marginTop: 2, fontSize: 11.5, color: C.faint }}>{note}</div>
      {aside && <div style={{ marginTop: 4, fontSize: 11, color: C.ghost, lineHeight: 1.4 }}>{aside}</div>}
    </div>
  );

  return (
    <div>
      {/* Dashboard: four numbers for whatever is on screen. They move with
          every search and filter, so a slice of the book reads as a block of
          its own; unfiltered, they describe the whole live roster. Premium is
          shown twice, monthly and annual: group health (EBPA + HealthEZ
          medical, the captive program) and the total across every line. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))",
          gap: 10,
          marginTop: 14,
        }}
      >
        {tile(
          view === "all" ? "Groups (All)" : filtering ? "Groups Shown" : "Groups",
          String(rows.length),
          view === "all"
            ? `${live.length} in the portal · ${counts.archived} archived · ${counts.excluded} not in program`
            : filtering
              ? `of ${live.length} in the portal · ${shown.small} at 2-50 · ${shown.large} at 51+`
              : `${counts.small} at 2-50 · ${counts.large} at 51+ (ALE)`,
        )}
        {tile(
          "Enrolled Employees",
          shown.enrolled.toLocaleString(),
          `${shown.lives.toLocaleString()} covered lives${filtering ? ` · ${pct(shown.enrolled, counts.enrolled)} of block` : ""}`,
        )}
        {tile(
          "Group Health Premium",
          `${money0(shown.groupHealth)} / mo`,
          `${money0(shown.groupHealth * 12)} / yr · ${shown.groupHealthEnrolled.toLocaleString()} enrolled${filtering ? ` · ${pct(shown.groupHealth, counts.groupHealth)} of block` : ""}`,
        )}
        {tile(
          "Total Premium",
          `${money0(shown.total)} / mo`,
          `${money0(shown.total * 12)} / yr · all lines${filtering ? ` · ${pct(shown.total, counts.total)} of block` : ""}`,
          rows.length && !shown.linesLoaded
            ? "Supplemental lines appear after the next Employee Navigator import."
            : undefined,
        )}
        <div style={{ ...panel, padding: "14px 16px", gridColumn: "span 2", minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.body }}>2027 Renewal</div>
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {RENEWALS.map((r) => {
              const [fg, bg, bd] = RENEWAL_TONE[r];
              const on = renewal === r;
              return (
                <button
                  key={r}
                  onClick={() => setRenewal(on ? "All" : r)}
                  aria-pressed={on}
                  title={on ? "Show all renewal states" : `Show only ${RENEWAL_LABEL[r]}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 7,
                    padding: "6px 11px",
                    fontSize: 13,
                    borderRadius: 4,
                    cursor: "pointer",
                    color: fg,
                    background: bg,
                    border: `1px solid ${on ? fg : bd}`,
                    boxShadow: on ? `inset 0 0 0 1px ${fg}` : "none",
                    opacity: renewal !== "All" && !on ? 0.6 : 1,
                  }}
                >
                  <span style={{ fontSize: 18, fontWeight: 600, ...num }}>{sliceRenewal[r]}</span>
                  <span>{RENEWAL_LABEL[r]}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ ...panel, marginTop: 16 }}>
        {/* One row of controls: search, three filters, which roster, export. */}
        <div
          style={{
            padding: "14px 18px",
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search company, ID, city, contact…"
            aria-label="Search groups"
            style={{
              flex: "1 1 240px",
              minWidth: 200,
              padding: "8px 11px",
              fontSize: 13.5,
              color: C.ink,
              border: `1px solid ${C.inputEdge}`,
              borderRadius: 4,
              outline: "none",
            }}
          />
          <select aria-label="Size" value={size} onChange={(e) => setSize(e.target.value as typeof size)} style={filterSelect}>
            <option value="All">All sizes</option>
            <option value="2-50">2-50</option>
            <option value="51+">51+ (ALE)</option>
          </select>
          <select aria-label="Account manager" value={manager} onChange={(e) => setManager(e.target.value as typeof manager)} style={filterSelect}>
            <option value="All">All managers</option>
            {(Object.keys(MANAGER_LABEL) as Manager[]).map((m) => (
              <option key={m} value={m}>
                {MANAGER_FULL[m]}
              </option>
            ))}
            <option value="none">No manager set</option>
          </select>
          <select aria-label="Broker" value={broker} onChange={(e) => setBroker(e.target.value as typeof broker)} style={filterSelect}>
            <option value="All">All brokers</option>
            <option value="kennion">Kennion</option>
            <option value="outside">Outside Broker</option>
          </select>
          <select aria-label="Renewal" value={renewal} onChange={(e) => setRenewal(e.target.value as typeof renewal)} style={filterSelect}>
            <option value="All">All renewal states</option>
            {RENEWALS.map((r) => (
              <option key={r} value={r}>
                {RENEWAL_LABEL[r]}
              </option>
            ))}
          </select>
          <select aria-label="Proposals" value={proposalsFilter} onChange={(e) => setProposalsFilter(e.target.value as typeof proposalsFilter)} style={filterSelect}>
            <option value="All">Proposals: any</option>
            <option value="with">With a proposal</option>
            <option value="without">No proposal yet</option>
          </select>
          {(counts.excluded > 0 || counts.archived > 0) && (
            <select aria-label="Which groups" value={view} onChange={(e) => setView(e.target.value as typeof view)} style={filterSelect}>
              {/* Widest first, then the parts of it, so the counts read as a sum. */}
              <option value="all">All groups ({groups.length})</option>
              <option value="live">In the portal ({live.length})</option>
              {counts.excluded > 0 && <option value="excluded">Not in program ({counts.excluded})</option>}
              {counts.archived > 0 && <option value="archived">Archived ({counts.archived})</option>}
            </select>
          )}
          {filtering && (
            <button
              onClick={clear}
              style={{ background: "none", border: "none", fontSize: 13, color: C.blue, cursor: "pointer", padding: "0 2px" }}
            >
              Clear
            </button>
          )}
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.faint, whiteSpace: "nowrap" }}>
            {rows.length} shown
          </span>
          <button
            onClick={exportRows}
            disabled={!rows.length}
            title="Download the rows shown, with the current search, filters and sort, as a CSV for Excel"
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 500,
              color: "#fff",
              background: C.blue,
              border: `1px solid ${C.blue}`,
              borderRadius: 4,
              cursor: rows.length ? "pointer" : "default",
              opacity: rows.length ? 1 : 0.5,
              whiteSpace: "nowrap",
            }}
          >
            Export {rows.length === 1 ? "1 group" : `${rows.length} groups`}
          </button>
        </div>

        {view === "excluded" && (
          <div style={{ padding: "12px 18px 0", fontSize: 13, color: C.muted, lineHeight: 1.65, maxWidth: 880 }}>
            These groups have no enrolled medical plan with EBPA, HealthEZ or BCBS of Alabama, so
            they are not in the 2027 portal and their access codes are refused. The carriers found
            on each are listed — if one of those <em>is</em> a program carrier under a name the
            rule does not recognise, say so and it will be matched.
          </div>
        )}

        {counts.dupes > 0 && view === "live" && (
          <div
            style={{
              margin: "12px 18px 0",
              padding: "10px 12px",
              background: C.amberTint,
              border: `1px solid ${C.amberEdge}`,
              borderRadius: 4,
              fontSize: 12.5,
              color: C.amber,
              lineHeight: 1.55,
            }}
          >
            <strong>{counts.dupes} rows look like the same client under two names.</strong> Open each
            pair, decide which holds the current data, and archive the other — nothing is deleted.
            Flagged with <span style={{ color: C.red }}>⚠ duplicate</span> below.
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              margin: "12px 18px 0",
              padding: "9px 12px",
              background: C.redTint,
              border: `1px solid ${C.redEdge}`,
              borderRadius: 4,
              fontSize: 13,
              color: C.red,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ overflowX: "auto", padding: "0 8px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 960 }}>
            <thead>
              <tr>
                <H k="name" label="Company" />
                <H k="location" label="Location" width={150} />
                <H k="contact" label="Contact" />
                <H k="enrolled" label="Enrolled" align="right" width={90} />
                <H k="share" label="% of block" align="right" width={96} />
                <H k="sizeCategory" label="Size" width={110} />
                <H k="broker" label="Broker" width={150} />
                <H k="manager" label="Manager" width={120} />
                <H k="renewal" label="Renewal" width={140} />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const key = g.name + "|companyId";
                const val = editing[key] ?? g.code;
                const r = g.renewal || "open";
                const [rfg, rbg, rbd] = RENEWAL_TONE[r];
                const b = g.broker || "kennion";
                const contact = g.contacts?.[0];
                return (
                  <tr key={g.name}>
                    <td style={{ ...td, lineHeight: 1.4 }}>
                      <Link href={groupPath(g.name)} style={{ color: C.blue, fontWeight: 500 }}>
                        {g.name}
                      </Link>
                      {/* In the all-groups view a row can be one the portal
                          leaves out, so say which. */}
                      {view === "all" && (g.archived || g.eligible === false) && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: C.faint }}>
                          {g.archived ? "· archived" : "· not in program"}
                        </span>
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                        <input
                          value={val}
                          onChange={(e) => setEditing((p) => ({ ...p, [key]: e.target.value.toUpperCase() }))}
                          onBlur={async () => {
                            if (val === g.code) return;
                            await save(g.name, "companyId", val);
                            setEditing((p) => {
                              const n = { ...p };
                              delete n[key];
                              return n;
                            });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                          aria-label={`Company ID for ${g.name}`}
                          title="Access code — type over it to change"
                          style={{
                            width: 92,
                            padding: "2px 5px",
                            fontSize: 12,
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                            fontWeight: 600,
                            color: g.codeIsSet ? C.blue : C.body,
                            border: `1px solid ${saved === key ? C.greenEdge : "transparent"}`,
                            background: saved === key ? C.greenTint : C.hairline,
                            borderRadius: 3,
                            outline: "none",
                          }}
                        />
                        <span style={{ fontSize: 11.5, color: C.ghost }}>
                          {view === "excluded"
                            ? `carriers found: ${(g.carriersSeen || []).join(", ") || "none"}`
                            : (g.programs || []).join(" · ")}
                        </span>
                        {!g.archived && g.eligible !== false && (
                        <a
                          href={g.linkToken ? `/g/${g.linkToken}` : `/?code=${encodeURIComponent(g.code)}`}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open ${g.name}'s own pages, exactly as the client sees them`}
                          style={{ fontSize: 11.5, color: C.blue, textDecoration: "none", whiteSpace: "nowrap" }}
                        >
                          view as client ↗
                        </a>
                      )}
                      {(g.proposals || 0) > 0 && (
                          <Link
                            href={groupPath(g.name)}
                            title="Proposals on file — open the company page"
                            style={{ fontSize: 11.5, color: C.green, textDecoration: "none", whiteSpace: "nowrap" }}
                          >
                            📎 {g.proposals} proposal{g.proposals === 1 ? "" : "s"}
                          </Link>
                        )}
                      </div>
                      {!!g.duplicateOf?.length && (
                        <div style={{ fontSize: 11.5, color: C.red, marginTop: 2 }}>
                          ⚠ duplicate of {g.duplicateOf.join(", ")}
                        </div>
                      )}
                      {g.enName && (
                        <div style={{ fontSize: 11.5, color: C.ghost, marginTop: 2 }}>
                          Employee Navigator: {g.enName}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, color: g.city ? C.ink : C.ghost, lineHeight: 1.4 }}>
                      {g.city ? `${g.city}${g.state ? `, ${g.state}` : ""}` : g.state || "—"}
                      {g.zip && <div style={{ fontSize: 11.5, color: C.ghost, ...num }}>{g.zip}</div>}
                    </td>
                    <td style={{ ...td, lineHeight: 1.4 }}>
                      {contact ? (
                        <>
                          {contact.name}
                          {contact.email && (
                            <div style={{ fontSize: 11.5 }}>
                              <a href={`mailto:${contact.email}`}>{contact.email}</a>
                            </div>
                          )}
                        </>
                      ) : (
                        <span style={{ color: C.ghost }}>—</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right", ...num }}>
                      {g.enrolled}
                      <div style={{ fontSize: 11.5, color: C.ghost }}>{g.lives} lives</div>
                    </td>
                    <td
                      style={{ ...td, textAlign: "right", color: C.body, ...num }}
                      title={`${g.enrolled} of ${counts.enrolled.toLocaleString()} enrolled across the block`}
                    >
                      {pct(g.enrolled || 0, counts.enrolled)}
                    </td>
                    <td style={{ ...td, padding: "7px 10px" }}>
                      <select
                        value={g.sizeCategory}
                        onChange={(e) => void save(g.name, "sizeCategory", e.target.value)}
                        aria-label={`Size for ${g.name}`}
                        title={g.sizeIsSet ? "Set by staff" : "Defaulted from headcount"}
                        style={selectStyle(g.sizeIsSet ? C.ink : C.body, saved === g.name + "|sizeCategory" ? C.greenTint : "#fff")}
                      >
                        <option value="2-50">2-50</option>
                        <option value="51+">51+</option>
                      </select>
                    </td>
                    <td style={{ ...td, padding: "7px 10px" }}>
                      <select
                        value={b}
                        onChange={(e) => void save(g.name, "broker", e.target.value)}
                        aria-label={`Broker for ${g.name}`}
                        style={selectStyle(
                          b === "outside" ? C.amber : C.ink,
                          saved === g.name + "|broker" ? C.greenTint : b === "outside" ? C.amberTint : "#fff",
                          b === "outside" ? C.amberEdge : C.border,
                        )}
                      >
                        <option value="kennion">Kennion</option>
                        <option value="outside">Outside Broker</option>
                      </select>
                    </td>
                    <td style={{ ...td, padding: "7px 10px" }}>
                      <select
                        value={g.manager || ""}
                        onChange={(e) => void save(g.name, "manager", e.target.value)}
                        aria-label={`Account manager for ${g.name}`}
                        title={g.manager ? MANAGER_FULL[g.manager] : "No account manager set"}
                        style={selectStyle(
                          g.manager ? C.ink : C.faint,
                          saved === g.name + "|manager" ? C.greenTint : "#fff",
                        )}
                      >
                        <option value="">—</option>
                        {(Object.keys(MANAGER_LABEL) as Manager[]).map((m) => (
                          <option key={m} value={m}>
                            {MANAGER_LABEL[m]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...td, padding: "7px 10px" }}>
                      <select
                        value={r}
                        onChange={(e) => void save(g.name, "renewal", e.target.value)}
                        aria-label={`Renewal for ${g.name}`}
                        style={selectStyle(rfg, saved === g.name + "|renewal" ? C.greenTint : rbg, rbd)}
                      >
                        {RENEWALS.map((x) => (
                          <option key={x} value={x}>
                            {RENEWAL_LABEL[x]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={8} style={{ ...td, padding: "26px 10px", textAlign: "center", color: C.faint }}>
                    No groups match.{" "}
                    {filtering && (
                      <button onClick={clear} style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 13, padding: 0 }}>
                        Clear the filters
                      </button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
            {/* Totals for the rows shown — they move with every filter. */}
            <tfoot>
              <tr>
                <td colSpan={3} style={{ padding: "12px 10px", fontSize: 13, color: C.ink, borderTop: `1px solid ${C.border}` }}>
                  <strong>{rows.length === 1 ? "1 group" : `${rows.length} groups`}</strong>
                  <span style={{ color: C.muted }}>
                    {" "}
                    · {shown.lives.toLocaleString()} covered lives · {money0(shown.groupHealth)} group health ·{" "}
                    {money0(shown.total)} total premium · {money0(shown.total * 12)} annualized (total)
                  </span>
                </td>
                <td style={{ padding: "12px 10px", textAlign: "right", fontSize: 13, fontWeight: 600, color: C.ink, borderTop: `1px solid ${C.border}`, ...num }}>
                  {shown.enrolled.toLocaleString()}
                  <div style={{ fontSize: 11.5, fontWeight: 400, color: C.ghost }}>enrolled</div>
                </td>
                <td
                  style={{ padding: "12px 10px", textAlign: "right", fontSize: 13, fontWeight: 600, color: C.ink, borderTop: `1px solid ${C.border}`, ...num }}
                  title="Share of all enrolled employees in the block held by the groups shown"
                >
                  {pct(shown.enrolled, counts.enrolled)}
                  <div style={{ fontSize: 11.5, fontWeight: 400, color: C.ghost }}>of block</div>
                </td>
                <td colSpan={3} style={{ borderTop: `1px solid ${C.border}` }} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { TIERS, censusCounts, costSplit, fmtDed, money0, type AccountManager, type Group, type MarketPlan, type TierContribution, type TierKey } from "@/lib/model";
import { C, chip, num, panel, textInput } from "@/lib/ui";
import PlanCard, { TIER_NAMES, carrierOf, cardModel, fundingOf } from "@/views/PlanCard";

/**
 * Every 2027 plan from every carrier, one grid, lowest cost first.
 *
 * Above it, Employer Contribution: four figures and Apply. Employer Cost on
 * every row is that contribution × enrolled in each tier (never more than
 * the premium). Filter tabs along the top; a short row per plan; a card
 * with everything when a row is clicked. ♡ shortlists a plan — the list
 * Sign Up sends — and + adds it to a proposal that downloads as Excel or
 * prints to PDF, one card per plan.
 */

export interface GridProps {
  g: Group;
  plans: MarketPlan[];
  totals: { total: number; enrolled: number };
  selected: Record<string, boolean>;
  onToggleSelected: (plan: string) => void;
  /** Shown on the printed proposal's footer. */
  manager: AccountManager | null;
  /** Today's employer contribution by tier: the starting point, and "Reset to today". */
  contribution: TierContribution[];
  /** The applied contribution per tier — what Employer Cost is computed from. */
  applied: Record<TierKey, number>;
  appliedChanged: boolean;
  onApply: (values: Record<TierKey, number>) => void;
  onReset: () => void;
}

type Tab = "carrier" | "network" | "ded" | "oop" | "cost";
type SortKey = "carrier" | "network" | "plan" | "ded" | "oop" | "er" | "total";
/** The network as a column: "Cigna Open Access Plus (PPO)" reads as "Cigna Open Access Plus" beside a PPO-only grid. */
const networkOf = (p: MarketPlan) => (p.network || "").replace(/\s*\((EPO|PPO)\)\s*$/i, "");
const TABS: [Tab, string][] = [
  ["carrier", "Carrier"],
  ["network", "Network"],
  ["ded", "Deductible"],
  ["oop", "OOP Max"],
  ["cost", "Total Monthly Cost"],
];
const DED_BANDS: [string, (v: number) => boolean][] = [
  ["$0", (v) => v === 0],
  ["$1 – $1,000", (v) => v > 0 && v <= 1000],
  ["$1,001 – $2,500", (v) => v > 1000 && v <= 2500],
  ["$2,501 – $5,000", (v) => v > 2500 && v <= 5000],
  ["$5,001+", (v) => v > 5000],
];
const OOP_BANDS: [string, (v: number) => boolean][] = [
  ["Up to $3,000", (v) => v <= 3000],
  ["$3,001 – $6,000", (v) => v > 3000 && v <= 6000],
  ["$6,001 – $8,000", (v) => v > 6000 && v <= 8000],
  ["$8,001+", (v) => v > 8000],
];
const COST_TIERS = ["$", "$$", "$$$", "$$$$"];
const dedOf = (p: MarketPlan): number | null => (p.ded == null || p.ded === "" ? null : Number.isFinite(+p.ded) ? +p.ded : null);
/** Whole dollars in the fields: nobody sets a contribution to the cent. */
const fmtDraft = (v: number) => String(Math.round(v));

/** CSV of whatever rows are showing (all, or the current filter). */
function exportCsv(g: Group, list: MarketPlan[], applied: Record<TierKey, number>, counts: Record<TierKey, number>) {
  const head = ["Carrier", "Network", "Plan", "Funding", "Deductible", "OOP Max", "Employer Cost", "Employee Cost", "Total Monthly Cost", "Rate Basis", ...TIERS.map((t) => `${t.label} Rate`)];
  const cell = (v: unknown) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = list.map((p) => {
    const s = costSplit(p, applied, counts);
    return [carrierOf(p), p.network ?? "", p.plan, fundingOf(p), p.ded ?? "", p.oop ?? "", s ? Math.round(s.er) : "", s ? Math.round(s.ee) : "", s ? Math.round(s.total) : "", p.quoted ? "Quoted" : p.pending ? "Pending" : "Illustrative", ...TIERS.map((t) => p.rates[t.key] ?? "")];
  });
  const csv = [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${g.name.replace(/[^\w]+/g, "-")}-2027-options.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function OptionsGrid({ g, plans, totals, selected, onToggleSelected, manager, contribution, applied, appliedChanged, onApply, onReset }: GridProps) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [carriers, setCarriers] = useState<Set<string>>(new Set());
  const [networks, setNetworks] = useState<Set<string>>(new Set());
  const [deds, setDeds] = useState<Set<string>>(new Set());
  const [oops, setOops] = useState<Set<string>>(new Set());
  const [costs, setCosts] = useState<Set<string>>(new Set());
  const [costDir, setCostDir] = useState<1 | -1>(1);
  const [sortBy, setSortBy] = useState<SortKey>("total");
  const [contribOpen, setContribOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [compareOnly, setCompareOnly] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [proposal, setProposal] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Employer Contribution: a draft the employer types, applied on Apply.
  const [draft, setDraft] = useState<Record<TierKey, string>>(() => toDraft(applied));
  useEffect(() => setDraft(toDraft(applied)), [applied]);
  const parsed = TIERS.reduce((acc, t) => ({ ...acc, [t.key]: Number(draft[t.key]) }), {} as Record<TierKey, number>);
  const draftValid = TIERS.every((t) => draft[t.key].trim() !== "" && Number.isFinite(parsed[t.key]) && parsed[t.key] >= 0);
  const draftDirty = TIERS.some((t) => Math.abs((parsed[t.key] || 0) - (applied[t.key] || 0)) > 0.004);
  // The carriers' floor: the employer pays at least half the employee-only
  // rate of the least expensive plan. Off this group's own quotes, so it is a
  // different figure for every group; whole dollars, rounded up.
  const floorEE = useMemo(() => {
    const rates = plans.map((p) => p.rates.EE).filter((r): r is number => r != null && r > 0);
    return rates.length ? Math.ceil(Math.min(...rates) * 0.5) : 0;
  }, [plans]);
  const belowFloor = floorEE > 0 && parsed.EE < floorEE;
  // A default under the floor is not a contribution a carrier would accept:
  // lift it, so the first Employer Cost the page shows is a lawful one.
  useEffect(() => {
    if (floorEE > 0 && (applied.EE || 0) < floorEE) onApply({ ...applied, EE: floorEE });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorEE, applied.EE]);
  const canApply = draftValid && draftDirty && !belowFloor;
  const apply = () => {
    if (!canApply) return;
    onApply(parsed);
    setContribOpen(false);
  };

  const counts = useMemo(() => censusCounts(g), [g]);
  const split = (p: MarketPlan) => costSplit(p, applied, counts);
  const card = (p: MarketPlan) => cardModel(p, applied, counts);

  const carrierList = useMemo(() => Array.from(new Set(plans.map(carrierOf))), [plans]);
  const networkList = useMemo(() => Array.from(new Set(plans.map(networkOf).filter(Boolean))), [plans]);
  // Quartile cutoffs off this group's own priced plans, so "Show" reads as
  // real dollar ranges for this group rather than a generic $ / $$$$ scale.
  const costCuts = useMemo(() => {
    const priced = plans.map((p) => p.monthly).filter((m): m is number => m != null).sort((a, b) => a - b);
    const cut = (q: number) => priced[Math.min(priced.length - 1, Math.floor(priced.length * q))] ?? Infinity;
    return priced.length ? [cut(0.25), cut(0.5), cut(0.75)] : [];
  }, [plans]);
  const costTier = useMemo(() => {
    return (p: MarketPlan) => {
      if (p.monthly == null || !costCuts.length) return null;
      const i = costCuts.findIndex((c) => p.monthly! < c);
      return COST_TIERS[i === -1 ? 3 : i];
    };
  }, [costCuts]);
  const costLabels = useMemo(() => {
    if (!costCuts.length) return COST_TIERS;
    const [a, b, c] = costCuts;
    return [`Under ${money0(a)}`, `${money0(a)} – ${money0(b)}`, `${money0(b)} – ${money0(c)}`, `${money0(c)}+`];
  }, [costCuts]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };
  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    const dedOk = (p: MarketPlan) => !deds.size || (dedOf(p) != null && DED_BANDS.some(([l, f]) => deds.has(l) && f(dedOf(p)!)));
    const oopOk = (p: MarketPlan) => !oops.size || (p.oop != null && OOP_BANDS.some(([l, f]) => oops.has(l) && f(p.oop!)));
    return plans
      .filter(
        (p) =>
          (!carriers.size || carriers.has(carrierOf(p))) &&
          (!networks.size || networks.has(networkOf(p))) &&
          dedOk(p) &&
          oopOk(p) &&
          (!favoritesOnly || !!selected[p.plan]) &&
          (!compareOnly || proposal.includes(p.plan)) &&
          (!costs.size || (costTier(p) != null && costs.has(costTier(p)!))) &&
          (!q || `${p.plan} ${p.carrier} ${p.type} ${p.copays} ${p.network}`.toLowerCase().includes(q)),
      )
      .slice()
      .sort((a, b) => {
        const val = (p: MarketPlan): number | string => {
          if (sortBy === "carrier") return carrierOf(p).toLowerCase();
          if (sortBy === "network") return networkOf(p).toLowerCase();
          if (sortBy === "plan") return p.plan.toLowerCase();
          if (sortBy === "ded") return dedOf(p) ?? Infinity;
          if (sortBy === "oop") return p.oop ?? Infinity;
          if (sortBy === "er") return split(p)?.er ?? Infinity;
          return p.monthly ?? Infinity;
        };
        const va = val(a);
        const vb = val(b);
        if (va === vb) return a.plan.localeCompare(b.plan);
        return (va > vb ? 1 : -1) * costDir;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, carriers, networks, deds, oops, costs, costTier, q, costDir, sortBy, applied, counts, favoritesOnly, selected, compareOnly, proposal]);

  const favorites = plans.filter((p) => selected[p.plan]).length;
  const filtering = carriers.size + networks.size + deds.size + oops.size + costs.size > 0 || !!q || favoritesOnly || compareOnly;
  const clearAll = () => {
    setCarriers(new Set());
    setNetworks(new Set());
    setDeds(new Set());
    setOops(new Set());
    setCosts(new Set());
    setQuery("");
    setFavoritesOnly(false);
    setCompareOnly(false);
  };
  const sortOn = (k: SortKey) => {
    if (sortBy === k) setCostDir((d) => (d > 0 ? -1 : 1));
    else {
      setSortBy(k);
      setCostDir(1);
    }
  };
  const count = (t: Tab) => ({ carrier: carriers.size, network: networks.size, ded: deds.size, oop: oops.size, cost: costs.size })[t];
  const MAX_FAVORITES = 8;
  const MAX_COMPARE = 4;
  const inProposal = (name: string) => proposal.includes(name);
  const compareFull = proposal.length >= MAX_COMPARE;
  const favoritesFull = favorites >= MAX_FAVORITES;
  /** Up to four plans side by side; a fifth is refused until one is removed. */
  const toggleProposal = (name: string) =>
    setProposal((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : prev.length >= MAX_COMPARE ? prev : [...prev, name]));
  /** Up to eight favorites; a ninth is refused until one is removed. */
  const toggleHeart = (name: string) => {
    if (!selected[name] && favoritesFull) return;
    onToggleSelected(name);
  };
  const viewComparison = () => {
    setCompareOpen(true);
    setTimeout(() => document.getElementById("proposal")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const proposed = proposal.map((n) => plans.find((p) => p.plan === n)).filter((p): p is MarketPlan => !!p);
  const opened = open ? plans.find((p) => p.plan === open) || null : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const downloadExcel = async () => {
    setSaving(true);
    try {
      const { downloadOptions } = await import("@/lib/optionsheet");
      downloadOptions(g, list, proposed, applied, counts, contribution);
    } finally {
      setSaving(false);
    }
  };
  /** The proposal alone, to the printer — Save as PDF is the browser's own button. */
  const printProposal = () => {
    document.body.classList.add("print-proposal");
    const done = () => document.body.classList.remove("print-proposal");
    window.addEventListener("afterprint", done, { once: true });
    window.print();
    setTimeout(done, 2000);
  };
  const chips = (values: string[], set: Set<string>, setter: (s: Set<string>) => void) =>
    values.map((v) => (
      <button key={v} onClick={() => toggle(set, setter, v)} style={chip(set.has(v))}>
        {v}
      </button>
    ));
  const actionsFor = (p: MarketPlan) => (
    <>
      <button onClick={() => toggleHeart(p.plan)} disabled={!selected[p.plan] && favoritesFull} title={!selected[p.plan] && favoritesFull ? `Up to ${MAX_FAVORITES} favorites` : undefined} style={{ ...chip(!!selected[p.plan]), padding: "7px 12px", fontSize: 13 }}>
        {selected[p.plan] ? "♥ On your shortlist" : "♡ Add to shortlist"}
      </button>
      <button onClick={() => toggleProposal(p.plan)} style={{ ...chip(inProposal(p.plan)), padding: "7px 12px", fontSize: 13 }}>
        {inProposal(p.plan) ? "✓ In comparison" : "+ Add to comparison"}
      </button>
    </>
  );

  return (
    <div>
      {/* Employer Contribution: four figures, Apply; collapses to one line once set. */}
      <div id="contribution" className="panel anchor noprint" style={{ ...panel, background: C.border, border: `2px solid ${C.inputEdge}`, marginBottom: 12, padding: 0 }}>
        <button
          onClick={() => setContribOpen((v) => !v)}
          aria-expanded={contribOpen}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>Employer Contribution</span>
          <span style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13, color: C.body }}>
            <span style={{ ...num }}>
              <strong style={{ color: C.ink }}>{money0(TIERS.reduce((n, t) => n + (applied[t.key] || 0) * (counts[t.key] || 0), 0))}</strong> / mo across {totals.enrolled} enrolled
              {!contribOpen && ` · ${TIERS.map((t) => `${t.short} ${money0(applied[t.key] || 0)}`).join(" · ")}`}
            </span>
            <span style={{ fontSize: 12.5, color: C.blue, fontWeight: 600 }}>{contribOpen ? "Collapse ▴" : "Edit ▾"}</span>
          </span>
        </button>
        {contribOpen && (
          <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${C.hairline}` }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12, marginTop: 14 }}>
              {TIERS.map((t) => (
                <label key={t.key} style={{ display: "block", flex: "1 1 150px", minWidth: 150 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>
                    {TIER_NAMES[t.key]} <span style={{ fontWeight: 400, color: C.faint }}>({counts[t.key] || 0})</span>
                    {t.key === "EE" && floorEE > 0 && (
                      <span
                        style={{ fontWeight: 400, color: belowFloor ? C.red : C.faint, marginLeft: 8 }}
                        title="Carriers require the employer to pay at least half the employee-only rate of the least expensive plan"
                      >
                        Minimum {money0(floorEE)}
                      </span>
                    )}
                  </div>
                  <div style={{ position: "relative", marginTop: 4 }}>
                    <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 15, color: C.faint, pointerEvents: "none" }}>$</span>
                    <input
                      value={draft[t.key]}
                      inputMode="numeric"
                      aria-label={`Monthly employer contribution, ${TIER_NAMES[t.key]}`}
                      onChange={(e) => setDraft((d) => ({ ...d, [t.key]: e.target.value.replace(/[^\d]/g, "") }))}
                      onBlur={() => {
                        if (draft[t.key].trim() === "") setDraft((d) => ({ ...d, [t.key]: "0" }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") apply();
                      }}
                      style={{ ...textInput, width: "100%", padding: "8px 10px 8px 22px", fontSize: 17, fontWeight: 600, color: C.ink, ...num }}
                    />
                  </div>
                </label>
              ))}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={apply}
                  disabled={!canApply}
                  title={belowFloor ? `Employee Only must be at least ${money0(floorEE)}: half the employee-only rate of the least expensive plan` : undefined}
                  style={{
                    padding: "11px 30px",
                    fontSize: 15,
                    fontWeight: 700,
                    borderRadius: 4,
                    color: "#fff",
                    background: canApply ? C.blue : C.ghost,
                    border: `1px solid ${canApply ? C.blue : C.ghost}`,
                    cursor: canApply ? "pointer" : "default",
                  }}
                >
                  Apply
                </button>
                {appliedChanged && (
                  <button onClick={onReset} style={{ ...chip(false), color: C.blue }}>
                    Reset to today
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Filter tabs: one open at a time, each with its chips beneath. */}
      <div className="noprint" style={{ ...panel, padding: "10px 14px 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {TABS.map(([t, label]) => {
            const on = tab === t;
            const n = count(t);
            return (
              <button
                key={t}
                onClick={() => setTab(on ? null : t)}
                style={{
                  padding: "7px 13px",
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 4,
                  cursor: "pointer",
                  color: on ? "#fff" : n ? C.blue : C.ink,
                  background: on ? C.blue : n ? C.blueTint : C.card,
                  border: `1px solid ${on || n ? C.blue : C.border}`,
                }}
              >
                {label}
                {n ? ` · ${n}` : ""}
              </button>
            );
          })}
          <button
            onClick={() => setFavoritesOnly((v) => !v)}
            aria-pressed={favoritesOnly}
            title={favoritesOnly ? "Show all plans" : "Show only your favorites"}
            style={{
              padding: "7px 13px",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 4,
              cursor: "pointer",
              color: favoritesOnly ? "#fff" : favorites ? C.red : C.ink,
              background: favoritesOnly ? C.red : favorites ? C.redTint : C.card,
              border: `1px solid ${favoritesOnly || favorites ? C.red : C.border}`,
            }}
          >
            {favoritesOnly || favorites ? "♥" : "♡"} {favorites}
          </button>
          <button
            onClick={() => setCompareOnly((v) => !v)}
            aria-pressed={compareOnly}
            title={compareOnly ? "Show all plans" : `Show only the plans you're comparing (up to ${MAX_COMPARE})`}
            style={{
              padding: "7px 13px",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 4,
              cursor: "pointer",
              color: compareOnly ? "#fff" : proposal.length ? C.blue : C.ink,
              background: compareOnly ? C.blue : proposal.length ? C.blueTint : C.card,
              border: `1px solid ${compareOnly || proposal.length ? C.blue : C.border}`,
            }}
          >
            + {proposal.length}
          </button>
          {proposal.length > 0 && (
            <button onClick={compareOpen ? () => setCompareOpen(false) : viewComparison} style={{ ...chip(compareOpen), fontWeight: 600 }}>
              {compareOpen ? "Hide comparison" : "View comparison"}
            </button>
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plans"
            aria-label="Search 2027 plan options"
            style={{ ...textInput, fontSize: 13, padding: "7px 11px", width: 150, marginLeft: "auto" }}
          />
          <button onClick={() => exportCsv(g, list, applied, counts)} disabled={!list.length} title="Export the plans showing to CSV" style={{ ...chip(false), fontWeight: 700 }}>
            Export
          </button>
          {filtering && (
            <button onClick={clearAll} style={{ ...chip(false), color: C.blue }}>
              Clear all
            </button>
          )}
        </div>
        {tab && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.hairline}` }}>
            {tab === "carrier" && chips(carrierList, carriers, setCarriers)}
            {tab === "network" && chips(networkList, networks, setNetworks)}
            {tab === "ded" && chips(DED_BANDS.map(([l]) => l), deds, setDeds)}
            {tab === "oop" && chips(OOP_BANDS.map(([l]) => l), oops, setOops)}
            {tab === "cost" && (
              <>
                <span style={{ fontSize: 12.5, color: C.muted }}>Sort</span>
                <button onClick={() => { setSortBy("total"); setCostDir(1); }} style={chip(sortBy === "total" && costDir > 0)}>
                  $ → $$$$
                </button>
                <button onClick={() => { setSortBy("total"); setCostDir(-1); }} style={chip(sortBy === "total" && costDir < 0)}>
                  $$$$ → $
                </button>
                <span style={{ fontSize: 12.5, color: C.muted, marginLeft: 10 }}>Show</span>
                {COST_TIERS.map((tier, i) => (
                  <button key={tier} onClick={() => toggle(costs, setCosts, tier)} style={chip(costs.has(tier))}>
                    {costLabels[i]}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* The proposal being built: one card per plan. */}
      {proposed.length > 0 && compareOpen && (
        <div id="proposal" className="panel noprint" style={{ ...panel, marginBottom: 12, padding: "14px 18px 16px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>
              Compare · {proposed.length} of {MAX_COMPARE} plans
            </h3>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => void downloadExcel()} disabled={saving} style={{ ...chip(false), fontWeight: 600 }}>
                {saving ? "Building…" : "⬇ Excel"}
              </button>
              <button onClick={printProposal} style={{ ...chip(false), fontWeight: 600 }} title="Print, or Save as PDF from the print dialog">
                ⬇ PDF
              </button>
              <button onClick={() => setProposal([])} style={{ ...chip(false), color: C.blue }}>
                Clear
              </button>
            </div>
          </div>
          <div className="cardgrid">
            {proposed.map((p) => (
              <PlanCard
                key={p.plan}
                m={card(p)}
                compact
                actions={
                  <>
                    <button onClick={() => toggleHeart(p.plan)} disabled={!selected[p.plan] && favoritesFull} style={chip(!!selected[p.plan])}>
                      {selected[p.plan] ? "♥ Favorite" : "♡ Favorite"}
                    </button>
                    <button onClick={() => toggleProposal(p.plan)} style={{ ...chip(false), color: C.blue }}>
                      Remove
                    </button>
                  </>
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* The grid: a short row per plan; the row opens the card. */}
      <div className="panel" style={{ ...panel, padding: "0 0 10px", overflow: "auto" }}>
        <table style={{ width: "100%", minWidth: 860, borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              {(
                [
                  ["carrier", "Carrier"],
                  ["network", "Network"],
                  ["plan", "Plan"],
                  ["ded", "Deductible"],
                  ["oop", "OOP Max"],
                  ["er", "Employer Cost"],
                  ["total", "Total Monthly Cost"],
                  [null, ""],
                  [null, ""],
                ] as [SortKey | null, string][]
              ).map(([k, h], i) => (
                <th
                  key={i}
                  onClick={k ? () => sortOn(k) : undefined}
                  title={k ? "Sort by this column" : undefined}
                  style={{
                    padding: "12px 10px 11px",
                    fontSize: 13,
                    color: C.onColor,
                    background: C.headerBg,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    textAlign: i >= 3 && i <= 6 ? "right" : "left",
                    width: i >= 7 ? 44 : undefined,
                    cursor: k ? "pointer" : undefined,
                    userSelect: "none",
                  }}
                >
                  {h}
                  {k && sortBy === k ? (costDir > 0 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((p, i) => {
              const sp = split(p);
              const heart = !!selected[p.plan];
              const added = inProposal(p.plan);
              const cell = { padding: "9px 10px", borderBottom: `1px solid ${C.hairline}`, color: C.ink };
              const right = { ...cell, textAlign: "right" as const, ...num };
              return (
                <tr key={p.plan} className="rowlink" onClick={() => setOpen(p.plan)} style={{ background: heart ? C.blueTint : i % 2 ? C.zebra : C.card, cursor: "pointer" }} title="Click for every detail">
                  <td style={{ ...cell, whiteSpace: "nowrap", color: C.body }}>{carrierOf(p)}</td>
                  <td style={{ ...cell, color: C.body }}>{networkOf(p) || "—"}</td>
                  <td style={cell}>
                    <div>{p.plan}</div>
                    <div style={{ fontSize: 11.5, color: C.faint }}>
                      {fundingOf(p)}
                      {p.type && p.type !== p.label && p.type !== fundingOf(p) ? ` · ${p.type}` : ""}
                      {p.quoted && <span style={{ color: C.green, fontWeight: 600 }}> · quoted</span>}
                    </div>
                  </td>
                  <td style={right}>{fmtDed(p.ded)}</td>
                  <td style={right}>{p.oop == null ? "—" : money0(p.oop)}</td>
                  <td style={{ ...right, fontWeight: 700, fontSize: 14.5, whiteSpace: "nowrap" }} title={sp ? `Employees pay ${money0(sp.ee)} / mo between them` : undefined}>
                    {sp ? money0(sp.er) : p.pending ? "quote requested" : "—"}
                  </td>
                  <td style={{ ...right, fontWeight: 700, fontSize: 14.5, whiteSpace: "nowrap" }}>
                    {p.monthly == null ? "—" : money0(p.monthly)}
                  </td>
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => toggleHeart(p.plan)} disabled={!heart && favoritesFull} aria-label={heart ? `Remove ${p.plan} from favorites` : `Add ${p.plan} to favorites`} title={heart ? "Remove From Favorites" : favoritesFull ? `Up to ${MAX_FAVORITES} favorites — remove one first` : "Add To Favorites"} style={{ ...iconBtn, color: heart ? C.red : favoritesFull ? C.hairline : C.ghost }}>
                      {heart ? "♥" : "♡"}
                    </button>
                  </td>
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => toggleProposal(p.plan)} disabled={!added && compareFull} aria-label={added ? `Remove ${p.plan} from the comparison` : `Add ${p.plan} to the comparison`} title={added ? "Remove From Compare" : compareFull ? `Up to ${MAX_COMPARE} plans side by side — remove one first` : "Add To Compare"} style={{ ...iconBtn, color: added ? C.green : compareFull ? C.hairline : C.blue, fontWeight: 700 }}>
                      {added ? "✓" : "+"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={9} style={{ padding: "26px 10px", textAlign: "center", color: C.faint }}>
                  {favoritesOnly && !favorites ? "No favorites yet — press ♡ on a plan to add one." : "No plan matches those filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{ padding: "12px 14px 0", fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>
          {list.length === plans.length ? `${list.length} plans` : `${list.length} of ${plans.length} plans`}. Click a column heading to sort, a plan for every detail. ♡ adds it to your favorites (up to {MAX_FAVORITES}; the list Sign Up sends); + picks up to {MAX_COMPARE} to compare side by side and download.
        </div>
      </div>

      {opened && (
        <div role="dialog" aria-modal="true" aria-label={`${opened.plan} details`} onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,24,28,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)", maxHeight: "92vh", overflow: "auto", position: "relative" }}>
            <button onClick={() => setOpen(null)} aria-label="Close" style={{ ...iconBtn, position: "absolute", top: 8, right: 10, fontSize: 22, color: C.muted, zIndex: 1 }}>
              ×
            </button>
            <PlanCard m={card(opened)} actions={actionsFor(opened)} />
          </div>
        </div>
      )}

      {/* The printed proposal: only this prints when PDF is pressed. */}
      {proposed.length > 0 && (
        <div id="print-proposal" className="printonly" style={{ display: "none" }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: C.ink }}>{g.name} · 2027 Medical Options Proposal</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              Priced at {totals.enrolled} enrolled · employer contribution {TIERS.map((t) => `${t.short} ${money0(applied[t.key] || 0)}`).join(" · ")} per month ·{" "}
              {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </div>
          </div>
          <div className="cardgrid">
            {proposed.map((p) => (
              <PlanCard key={p.plan} m={card(p)} />
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: C.faint, marginTop: 12, lineHeight: 1.5 }}>
            Rates shown are monthly composite rates by tier. Illustrative rates are scaled from comparable quotes and confirm at underwriting. All rates and benefits are for general information and discussion only and are not final until the group is enrolled with the carrier.
          </div>
          {(manager?.name || manager?.phone || manager?.email) && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.hairline}`, textAlign: "center", fontSize: 11, color: C.muted }}>
              {[manager.name, manager.title, manager.phone, manager.email].filter(Boolean).join(" · ")}
              {" · "}
              {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const toDraft = (v: Record<TierKey, number>): Record<TierKey, string> =>
  TIERS.reduce((acc, t) => ({ ...acc, [t.key]: fmtDraft(v[t.key] || 0) }), {} as Record<TierKey, string>);

const iconBtn = {
  background: "none",
  border: "none",
  padding: "2px 6px",
  fontSize: 17,
  lineHeight: 1,
  cursor: "pointer",
} as const;

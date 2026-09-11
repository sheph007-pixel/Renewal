import { useEffect, useMemo, useState } from "react";
import { TIERS, censusCounts, costSplit, fmtDed, money0, type Group, type MarketPlan, type TierContribution, type TierKey } from "@/lib/model";
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
  direct: boolean;
  /** Today's employer contribution by tier: the starting point, and "Reset to today". */
  contribution: TierContribution[];
  /** The applied contribution per tier — what Employer Cost is computed from. */
  applied: Record<TierKey, number>;
  appliedChanged: boolean;
  onApply: (values: Record<TierKey, number>) => void;
  onReset: () => void;
}

type Tab = "carrier" | "ded" | "oop" | "funding" | "cost";
type SortKey = "carrier" | "network" | "plan" | "ded" | "oop" | "er" | "total";
/** The network as a column: "Cigna Open Access Plus (PPO)" reads as "Cigna Open Access Plus" beside a PPO-only grid. */
const networkOf = (p: MarketPlan) => (p.network || "").replace(/\s*\((EPO|PPO)\)\s*$/i, "");
const TABS: [Tab, string][] = [
  ["carrier", "Carrier"],
  ["ded", "Deductible"],
  ["oop", "OOP Max"],
  ["funding", "Funding"],
  ["cost", "Total Cost"],
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

export default function OptionsGrid({ g, plans, totals, selected, onToggleSelected, direct, contribution, applied, appliedChanged, onApply, onReset }: GridProps) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [carriers, setCarriers] = useState<Set<string>>(new Set());
  const [deds, setDeds] = useState<Set<string>>(new Set());
  const [oops, setOops] = useState<Set<string>>(new Set());
  const [fundings, setFundings] = useState<Set<string>>(new Set());
  const [costs, setCosts] = useState<Set<string>>(new Set());
  const [costDir, setCostDir] = useState<1 | -1>(1);
  const [sortBy, setSortBy] = useState<SortKey>("total");
  const [contribOpen, setContribOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [proposal, setProposal] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Employer Contribution: a draft the employer types, applied on Apply.
  const [draft, setDraft] = useState<Record<TierKey, string>>(() => toDraft(applied));
  useEffect(() => setDraft(toDraft(applied)), [applied]);
  const parsed = TIERS.reduce((acc, t) => ({ ...acc, [t.key]: Number(draft[t.key]) }), {} as Record<TierKey, number>);
  const draftValid = TIERS.every((t) => draft[t.key].trim() !== "" && Number.isFinite(parsed[t.key]) && parsed[t.key] >= 0);
  const draftDirty = TIERS.some((t) => Math.abs((parsed[t.key] || 0) - (applied[t.key] || 0)) > 0.004);
  const apply = () => {
    onApply(parsed);
    setContribOpen(false);
  };

  const counts = useMemo(() => censusCounts(g), [g]);
  const split = (p: MarketPlan) => costSplit(p, applied, counts);
  const card = (p: MarketPlan) => cardModel(p, applied, counts);

  const carrierList = useMemo(() => Array.from(new Set(plans.map(carrierOf))), [plans]);
  const fundingList = useMemo(() => Array.from(new Set(plans.map(fundingOf))), [plans]);
  const costTier = useMemo(() => {
    const priced = plans.map((p) => p.monthly).filter((m): m is number => m != null).sort((a, b) => a - b);
    const cut = (q: number) => priced[Math.min(priced.length - 1, Math.floor(priced.length * q))] ?? Infinity;
    const cuts = [cut(0.25), cut(0.5), cut(0.75)];
    return (p: MarketPlan) => {
      if (p.monthly == null) return null;
      const i = cuts.findIndex((c) => p.monthly! < c);
      return COST_TIERS[i === -1 ? 3 : i];
    };
  }, [plans]);

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
          dedOk(p) &&
          oopOk(p) &&
          (!fundings.size || fundings.has(fundingOf(p))) &&
          (!favoritesOnly || !!selected[p.plan]) &&
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
  }, [plans, carriers, deds, oops, fundings, costs, costTier, q, costDir, sortBy, applied, counts, favoritesOnly, selected]);

  const favorites = plans.filter((p) => selected[p.plan]).length;
  const filtering = carriers.size + deds.size + oops.size + fundings.size + costs.size > 0 || !!q || favoritesOnly;
  const clearAll = () => {
    setCarriers(new Set());
    setDeds(new Set());
    setOops(new Set());
    setFundings(new Set());
    setCosts(new Set());
    setQuery("");
    setFavoritesOnly(false);
  };
  const sortOn = (k: SortKey) => {
    if (sortBy === k) setCostDir((d) => (d > 0 ? -1 : 1));
    else {
      setSortBy(k);
      setCostDir(1);
    }
  };
  const count = (t: Tab) => ({ carrier: carriers.size, ded: deds.size, oop: oops.size, funding: fundings.size, cost: costs.size })[t];
  const inProposal = (name: string) => proposal.includes(name);
  const toggleProposal = (name: string) => setProposal((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
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
      <button onClick={() => onToggleSelected(p.plan)} style={{ ...chip(!!selected[p.plan]), padding: "7px 12px", fontSize: 13 }}>
        {selected[p.plan] ? "♥ On your shortlist" : "♡ Add to shortlist"}
      </button>
      <button onClick={() => toggleProposal(p.plan)} style={{ ...chip(inProposal(p.plan)), padding: "7px 12px", fontSize: 13 }}>
        {inProposal(p.plan) ? "✓ In your proposal" : "+ Add to proposal"}
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
                        if (e.key === "Enter" && draftValid && draftDirty) apply();
                      }}
                      style={{ ...textInput, width: "100%", padding: "8px 10px 8px 22px", fontSize: 17, fontWeight: 600, color: C.ink, ...num }}
                    />
                  </div>
                </label>
              ))}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={apply}
                  disabled={!draftValid || !draftDirty}
                  style={{
                    padding: "11px 30px",
                    fontSize: 15,
                    fontWeight: 700,
                    borderRadius: 4,
                    color: "#fff",
                    background: draftValid && draftDirty ? C.blue : C.ghost,
                    border: `1px solid ${draftValid && draftDirty ? C.blue : C.ghost}`,
                    cursor: draftValid && draftDirty ? "pointer" : "default",
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
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plans"
            aria-label="Search 2027 plan options"
            style={{ ...textInput, fontSize: 13, padding: "7px 11px", width: 150, marginLeft: "auto" }}
          />
          {filtering && (
            <button onClick={clearAll} style={{ ...chip(false), color: C.blue }}>
              Clear all
            </button>
          )}
        </div>
        {tab && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.hairline}` }}>
            {tab === "carrier" && chips(carrierList, carriers, setCarriers)}
            {tab === "ded" && chips(DED_BANDS.map(([l]) => l), deds, setDeds)}
            {tab === "oop" && chips(OOP_BANDS.map(([l]) => l), oops, setOops)}
            {tab === "funding" && chips(fundingList, fundings, setFundings)}
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
                {chips(COST_TIERS, costs, setCosts)}
              </>
            )}
          </div>
        )}
      </div>

      {/* The proposal being built: one card per plan. */}
      {proposed.length > 0 && (
        <div id="proposal" className="panel noprint" style={{ ...panel, marginBottom: 12, padding: "14px 18px 16px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>
              Your proposal · {proposed.length} plan{proposed.length === 1 ? "" : "s"}
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
                    <button onClick={() => onToggleSelected(p.plan)} style={chip(!!selected[p.plan])}>
                      {selected[p.plan] ? "♥ Shortlisted" : "♡ Shortlist"}
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
                    {sp?.underBudget && <div style={{ fontSize: 10.5, fontWeight: 400, color: C.faint }}>under budget</div>}
                  </td>
                  <td style={{ ...right, fontWeight: 700, fontSize: 14.5, whiteSpace: "nowrap" }}>
                    {p.monthly == null ? "—" : money0(p.monthly)}
                  </td>
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => onToggleSelected(p.plan)} aria-label={heart ? `Remove ${p.plan} from favorites` : `Add ${p.plan} to favorites`} title={heart ? "Remove From Favorites" : "Add To Favorites"} style={{ ...iconBtn, color: heart ? C.red : C.ghost }}>
                      {heart ? "♥" : "♡"}
                    </button>
                  </td>
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => toggleProposal(p.plan)} aria-label={added ? `Remove ${p.plan} from your proposal` : `Add ${p.plan} to your proposal`} title={added ? "In your proposal — click to remove" : "Add to your proposal"} style={{ ...iconBtn, color: added ? C.green : C.blue, fontWeight: 700 }}>
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
          {list.length === plans.length ? `${list.length} plans` : `${list.length} of ${plans.length} plans`}. Click a column heading to sort, a plan for every detail. ♡ adds it to your favorites (the list Sign Up sends); + adds it to a proposal you can download.
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
        {direct
          ? "Illustrative rate — scaled from the plans UnitedHealthcare quoted directly for your group. Un-marked rows are your quoted rates."
          : "Illustrative rate — your current rate level applied to the UnitedHealthcare menu quoted for comparable Kennion groups; your own underwriting is still open."}{" "}
        Total Monthly is that plan&rsquo;s rates × your current enrollment by tier. Rows marked quoted are read off the proposal the carrier sent for your group. Final rates confirm at enrollment and underwriting approval.
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

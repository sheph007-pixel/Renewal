import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { NETWORK_TYPES, TIERS, censusCounts, costSplit, fmtDed, money0, networkDirectory, networkLabel, networkTypeOf, optionSortKey, pbmOf, type AccountManager, type Group, type MarketPlan, type TierContribution, type TierKey } from "@/lib/model";
import { C, chip, num, panel, primaryBtn, textInput } from "@/lib/ui";
import { RECOMMENDATIONS_TITLE, askAssistant, loadThreads, threadTitled, useChat } from "@/lib/chat";
import { useNarrow } from "@/lib/narrow";
import { DED_BANDS, DEFAULT_SORT, EMPTY_FILTERS, OOP_BANDS, bandsWithData, filterChips, filterCount, filtersEmpty, matches, optionCounts, type FilterKey, type ListKey, type PlanFacets, type PlanFilters, type SortKey, type SortState } from "@/lib/planfilters";
import { AppliedFilters, FilterDrawer, FilterDropdowns, FiltersButton, SortSelect, type AppliedChip, type BillBounds, type FilterOptionLists } from "@/views/PlanFilters";
import PlanCard, { TIER_NAMES, carrierOf, cardModel, fundingOf } from "@/views/PlanCard";
import CarrierMark from "@/views/CarrierMark";
import InfoTip from "@/views/InfoTip";
import MarketResults from "@/views/MarketResults";

/**
 * Every 2027 plan from every carrier, one grid, lowest cost first.
 *
 * Above it, Employer Contribution: four figures and Apply. Employer Cost on
 * every row is that contribution × enrolled in each tier (never more than
 * the premium). A toolbar of filter dropdowns along the top (a Filters
 * drawer on a phone), Sort by beside them, chips for what is applied; a
 * short row per plan; a card with everything when a row is clicked. ♡
 * shortlists a plan — the list Sign Up sends — and + adds it to a proposal
 * that downloads as Excel or prints to PDF, one card per plan. Filtering
 * and sorting touch only the grid: Your Market Results reads every quoted
 * plan regardless.
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
  /** The assistant is on for this group, so "Get Plan Recommendations" can open it. */
  assistantOn?: boolean;
}

/** What the Get Plan Recommendations button asks the assistant, in the client's voice. */
const RECOMMEND_ASK = "Please give me your plan recommendations for my group: a Lower Cost, a Best Fit and a Richer Benefits option, for each carrier that quoted us, based on our employees' ages and our enrollment. Tell me which you'd start with and why.";
/** The network as a column: any Cigna network reads "Cigna"; "(PPO)" is dropped beside a PPO-only grid. */
const networkOf = (p: MarketPlan) => (networkLabel(p.network) || "").replace(/\s*\((EPO|PPO)\)\s*$/i, "");
/** PPO / EPO / RBP, from the proposal; "—" where the quote does not say. */
const netType = (p: MarketPlan) => networkTypeOf(p) || "—";
const dedOf = (p: MarketPlan): number | null => (p.ded == null || p.ded === "" ? null : Number.isFinite(+p.ded) ? +p.ded : null);
/** Whole dollars in the fields: nobody sets a contribution to the cent. */
const fmtDraft = (v: number) => String(Math.round(v));

/** CSV of whatever rows are showing (all, or the current filter). */
function exportCsv(g: Group, list: MarketPlan[], applied: Record<TierKey, number>, counts: Record<TierKey, number>) {
  const head = ["Option", "Carrier/TPA", "Network Type", "Network", "Provider Directory", "PBM", "Formulary", "Plan", "Funding", "Deductible", "OOP Max", "Your Company Pays", "Employee Cost", "Total Monthly Bill", "Rate Basis", ...TIERS.map((t) => `${t.label} Rate`)];
  const cell = (v: unknown) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = list.map((p) => {
    const s = costSplit(p, applied, counts);
    return [p.optionId ?? "", carrierOf(p), netType(p), p.network ?? "", networkDirectory(p.network)?.url ?? "", pbmOf(p.carrier)?.name ?? "", pbmOf(p.carrier)?.url ?? "", p.plan, fundingOf(p), p.ded ?? "", p.oop ?? "", s ? Math.round(s.er) : "", s ? Math.round(s.ee) : "", s ? Math.round(s.total) : "", p.quoted ? "Quoted" : "Carrier Quote", ...TIERS.map((t) => p.rates[t.key] ?? "")];
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

/**
 * A percentage box that can be typed into. It keeps what is typed until the
 * field is left or Enter is pressed, then clamps to the floor and 100; clamping
 * on every keystroke would turn "9" into the floor before the "5" arrives.
 */
function PctInput({ label, value, min, onCommit }: { label: string; value: number; min: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const n = Number(text.replace(/[^\d]/g, ""));
    const v = Math.max(min, Math.min(100, Number.isFinite(n) && text.trim() !== "" ? n : value));
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      value={text}
      inputMode="numeric"
      aria-label={`${label} percentage`}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
        setText(t);
        const n = Number(t);
        if (t !== "" && n >= min && n <= 100) onCommit(n);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      style={{ ...textInput, width: 62, padding: "5px 8px", fontSize: 14, fontWeight: 600, textAlign: "right", ...num }}
    />
  );
}

export default function OptionsGrid({ g, plans, totals, selected, onToggleSelected, manager, contribution, applied, appliedChanged, onApply, onReset, assistantOn = false }: GridProps) {
  // Which filter panel is open (one at a time), and the phone's drawer.
  const narrow = useNarrow();
  const [openPanel, setOpenPanel] = useState<FilterKey | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const filtersBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The toolbar and the drawer swap over at the breakpoint; neither carries an open panel across.
    setOpenPanel(null);
    setDrawerOpen(false);
  }, [narrow]);
  // Whether the group already has its recommendations conversation: the
  // button then reopens it rather than asking again.
  const chat = useChat();
  useEffect(() => {
    if (assistantOn && !chat.loaded) loadThreads().catch(() => undefined);
  }, [assistantOn, chat.loaded]);
  const recommended = chat.loaded && !!threadTitled(RECOMMENDATIONS_TITLE);
  const [filters, setFilters] = useState<PlanFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
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
  // Percentage mode: a share of the least expensive plan, turned into dollars
  // per tier, so the contribution is still one fixed amount on every plan.
  // Employees % applies to the employee-only rate; Dependents % to what each
  // family tier adds on top of it.
  const [mode, setMode] = useState<"amount" | "percent">("amount");
  const [pctEE, setPctEE] = useState(50);
  const [pctDep, setPctDep] = useState(0);
  const basePlan = useMemo(() => {
    const priced = plans.filter((p) => p.rates.EE != null && p.rates.EE > 0);
    return priced.sort((a, b) => (a.rates.EE || 0) - (b.rates.EE || 0))[0] || null;
  }, [plans]);
  const fromPercent = (ee: number, dep: number): Record<TierKey, number> => {
    const base = basePlan?.rates;
    const eeRate = base?.EE || 0;
    const eeDollars = Math.ceil((eeRate * ee) / 100);
    return TIERS.reduce((acc, t) => {
      const rate = base?.[t.key] ?? null;
      const extra = t.key === "EE" || rate == null ? 0 : Math.max(0, rate - eeRate);
      return { ...acc, [t.key]: t.key === "EE" ? eeDollars : eeDollars + Math.ceil((extra * dep) / 100) };
    }, {} as Record<TierKey, number>);
  };
  const setPercent = (ee: number, dep: number) => {
    setPctEE(ee);
    setPctDep(dep);
    setDraft(toDraft(fromPercent(ee, dep)));
  };
  const canApply = draftValid && draftDirty && !belowFloor;
  const apply = () => {
    if (!canApply) return;
    onApply(parsed);
    setContribOpen(false);
  };

  const counts = useMemo(() => censusCounts(g), [g]);
  const split = (p: MarketPlan) => costSplit(p, applied, counts);
  const card = (p: MarketPlan) => cardModel(p, applied, counts);

  // What each plan is filtered on, read once. The dropdowns' choices come
  // off every quoted plan and never change shape as filters are applied; the
  // count beside each is what choosing it would show given the rest.
  const faceted = useMemo(() => plans.map((p) => ({ p, x: { carrier: carrierOf(p), network: netType(p), funding: fundingOf(p), ded: dedOf(p), oop: p.oop ?? null, bill: p.monthly ?? null } as PlanFacets })), [plans]);
  const choices = useMemo(() => {
    const xs = faceted.map((f) => f.x);
    const distinct = (k: "carrier" | "funding") => Array.from(new Set(xs.map((x) => x[k]))).map((v) => ({ value: v, label: v }));
    return {
      carriers: distinct("carrier"),
      networks: NETWORK_TYPES.filter((t) => xs.some((x) => x.network === t)).map((v) => ({ value: v, label: v })),
      fundings: distinct("funding"),
      deds: bandsWithData(DED_BANDS, xs.map((x) => x.ded)).map((b) => ({ value: b.id, label: b.label })),
      oops: bandsWithData(OOP_BANDS, xs.map((x) => x.oop)).map((b) => ({ value: b.id, label: b.label })),
    } satisfies Record<ListKey, { value: string; label: string }[]>;
  }, [faceted]);
  const bounds = useMemo<BillBounds>(() => {
    const ms = plans.map((p) => p.monthly).filter((m): m is number => m != null);
    return ms.length ? { min: Math.min(...ms), max: Math.max(...ms) } : null;
  }, [plans]);

  // Search, Favorites and Compare narrow the list before the filter
  // categories do, so the counts in every dropdown are true to what is showing.
  const q = query.trim().toLowerCase();
  const base = useMemo(
    () =>
      faceted.filter(
        ({ p, x }) =>
          (!favoritesOnly || !!selected[p.plan]) &&
          (!compareOnly || proposal.includes(p.plan)) &&
          (!q || `${p.optionId ?? ""} ${p.plan} ${p.carrier} ${p.type} ${p.copays} ${p.network} ${x.network}`.toLowerCase().includes(q)),
      ),
    [faceted, q, favoritesOnly, selected, compareOnly, proposal],
  );
  const optionsFor = useCallback(
    (f: PlanFilters): FilterOptionLists => {
      const xs = base.map((b) => b.x);
      const lists = {} as FilterOptionLists;
      (Object.keys(choices) as ListKey[]).forEach((k) => {
        const counts = optionCounts(xs, f, k, choices[k].map((c) => c.value));
        lists[k] = choices[k].map((c) => ({ ...c, count: counts[c.value] ?? 0 }));
      });
      return lists;
    },
    [base, choices],
  );
  const resultCountFor = useCallback((f: PlanFilters) => base.filter((b) => matches(b.x, f)).length, [base]);
  const options = useMemo(() => optionsFor(filters), [optionsFor, filters]);

  const list = useMemo(() => {
    return base
      .filter((b) => matches(b.x, filters))
      .map((b) => b.p)
      .sort((a, b) => {
        const val = (p: MarketPlan): number | string => {
          if (sort.key === "option") {
            const [pfx, n] = optionSortKey(p.optionId);
            return `${pfx} ${String(n === Infinity ? 999999 : n).padStart(6, "0")}`;
          }
          if (sort.key === "carrier") return carrierOf(p).toLowerCase();
          if (sort.key === "network") return `${netType(p)} ${networkOf(p)}`.toLowerCase();
          if (sort.key === "plan") return p.plan.toLowerCase();
          if (sort.key === "ded") return dedOf(p) ?? Infinity;
          if (sort.key === "oop") return p.oop ?? Infinity;
          if (sort.key === "er") return split(p)?.er ?? Infinity;
          return p.monthly ?? Infinity;
        };
        const va = val(a);
        const vb = val(b);
        if (va === vb) return a.plan.localeCompare(b.plan);
        return (va > vb ? 1 : -1) * sort.dir;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, filters, sort, applied, counts]);

  const favorites = plans.filter((p) => selected[p.plan]).length;
  const filtering = !filtersEmpty(filters) || !!q || favoritesOnly || compareOnly;
  /** Every filter off. The sort, the favorites and the comparison stay as they are. */
  const clearAll = () => {
    setFilters(EMPTY_FILTERS);
    setQuery("");
    setFavoritesOnly(false);
    setCompareOnly(false);
  };
  // What is applied, as chips: one per selection in a category, then the
  // search, Favorites and Compare views, each removable on its own.
  const appliedChips: AppliedChip[] = [
    ...filterChips(filters).map((c) => ({ key: c.key, label: c.label, onRemove: () => setFilters((f) => c.remove(f)) })),
    ...(q ? [{ key: "search", label: `Search: “${query.trim()}”`, onRemove: () => setQuery("") }] : []),
    ...(favoritesOnly ? [{ key: "favorites", label: "Favorites only", onRemove: () => setFavoritesOnly(false) }] : []),
    ...(compareOnly ? [{ key: "compare", label: "Comparing only", onRemove: () => setCompareOnly(false) }] : []),
  ];
  /** A column heading: first click sorts it ascending, the next flips it. The Sort by control shows the same. */
  const sortOn = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir > 0 ? -1 : 1 } : { key: k, dir: 1 }));
  const MAX_FAVORITES = 8;
  const MAX_COMPARE = 4;
  const inProposal = (name: string) => proposal.includes(name);
  const compareFull = proposal.length >= MAX_COMPARE;
  const favoritesFull = favorites >= MAX_FAVORITES;
  // One carrier, one funding type: a group's 2027 plans all come from one
  // carrier, and with UnitedHealthcare all fully insured or all level
  // funded — the shortlist is what Sign Up sends, so it holds to that. The
  // first plan shortlisted sets the carrier and funding; a plan that does
  // not fit cannot be added until the shortlist is cleared. Comparing
  // across carriers (the + column) is still open.
  const shortlist = plans.filter((p) => selected[p.plan]);
  const lock = shortlist.length ? { carrier: carrierOf(shortlist[0]), funding: fundingOf(shortlist[0]) } : null;
  const fits = (p: MarketPlan) => !lock || (carrierOf(p) === lock.carrier && fundingOf(p) === lock.funding);
  const heartBlocked = (p: MarketPlan) => !selected[p.plan] && (favoritesFull || !fits(p));
  const heartTitle = (p: MarketPlan) =>
    selected[p.plan] ? "Remove From Favorites" : favoritesFull ? `Up to ${MAX_FAVORITES} favorites — remove one first` : !fits(p) ? `One carrier, one funding type: your shortlist is ${lock!.carrier} ${lock!.funding}` : "Add To Favorites";
  /** Up to four plans side by side; a fifth is refused until one is removed. */
  const toggleProposal = (name: string) =>
    setProposal((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : prev.length >= MAX_COMPARE ? prev : [...prev, name]));
  /** Up to eight favorites; a ninth is refused until one is removed. */
  const toggleHeart = (name: string) => {
    const p = plans.find((x) => x.plan === name);
    if (p && heartBlocked(p)) return;
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
  const actionsFor = (p: MarketPlan) => (
    <>
      <button onClick={() => toggleHeart(p.plan)} disabled={heartBlocked(p)} title={heartTitle(p)} style={{ ...chip(!!selected[p.plan]), padding: "7px 12px", fontSize: 13 }}>
        {selected[p.plan] ? "♥ On Your Shortlist" : "♡ Add To Shortlist"}
      </button>
      <button onClick={() => toggleProposal(p.plan)} style={{ ...chip(inProposal(p.plan)), padding: "7px 12px", fontSize: 13 }}>
        {inProposal(p.plan) ? "✓ In Comparison" : "+ Add To Comparison"}
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
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, color: C.ink }}>
            Employer Contribution
            <InfoTip text="You set the budget: what to spend each month, as a dollar amount or a percentage. That amount goes toward whichever plan each employee picks; if they choose a plan that costs more, they pay the difference, so your budget never moves. Carriers require at least half the lowest employee-only rate." color={C.blue} />
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13, color: C.body }}>
            <span style={{ ...num }}>
              Your company pays <strong style={{ color: C.ink }}>{money0(TIERS.reduce((n, t) => n + (applied[t.key] || 0) * (counts[t.key] || 0), 0))}</strong> / mo for {totals.enrolled} enrolled
              {!contribOpen && ` · ${TIERS.map((t) => `${t.short} ${money0(applied[t.key] || 0)}`).join(" · ")}`}
            </span>
            <span style={{ fontSize: 12.5, color: C.blue, fontWeight: 600 }}>{contribOpen ? "Collapse ▴" : "Edit ▾"}</span>
          </span>
        </button>
        {contribOpen && (
          <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${C.hairline}` }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 18, marginTop: 14 }}>
              <div role="radiogroup" aria-label="How to set the contribution" style={{ display: "flex", gap: 6 }}>
                {(["amount", "percent"] as const).map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => {
                      setMode(m);
                      if (m === "percent") setPercent(pctEE, pctDep);
                    }}
                    style={{ ...chip(mode === m), fontWeight: 600 }}
                  >
                    {m === "amount" ? "Monthly Defined Amount" : "Percentage"}
                  </button>
                ))}
              </div>
              {mode === "percent" && basePlan && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 22, alignItems: "flex-end" }}>
                  {(
                    [
                      ["Employees", pctEE, 50, (v: number) => setPercent(v, pctDep), `of the employee-only rate on the least expensive plan (${basePlan.plan}, ${money0(basePlan.rates.EE || 0)})`],
                      ["Dependents", pctDep, 0, (v: number) => setPercent(pctEE, v), "of what spouse and child coverage adds on that plan"],
                    ] as [string, number, number, (v: number) => void, string][]
                  ).map(([label, value, min, set, hint]) => (
                    <label key={label} style={{ display: "block", width: 260 }} title={`${label}: ${hint}`}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: C.ink }}>
                        {label}
                        <PctInput label={label} value={value} min={min} onCommit={set} />
                        <span style={{ color: C.faint, fontWeight: 400 }}>%</span>
                        {min > 0 && <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 400, color: value <= min ? C.orange : C.faint, whiteSpace: "nowrap" }}>Minimum {min}%</span>}
                      </div>
                      {/* The bar always runs 0 to 100 so half way looks like half; a drag below the floor snaps back up to it. */}
                      <input type="range" min={0} max={100} step={1} value={value} onChange={(e) => set(Math.max(min, Number(e.target.value)))} aria-label={`${label} percentage slider`} style={{ width: "100%", marginTop: 6, accentColor: C.blue }} />
                    </label>
                  ))}
                </div>
              )}
            </div>
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
                      readOnly={mode === "percent"}
                      title={mode === "percent" ? "Set by the percentages above" : undefined}
                      aria-label={`Monthly employer contribution, ${TIER_NAMES[t.key]}`}
                      onChange={(e) => setDraft((d) => ({ ...d, [t.key]: e.target.value.replace(/[^\d]/g, "") }))}
                      onBlur={() => {
                        if (draft[t.key].trim() === "") setDraft((d) => ({ ...d, [t.key]: "0" }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") apply();
                      }}
                      style={{ ...textInput, width: "100%", padding: "8px 10px 8px 22px", fontSize: 17, fontWeight: 600, color: C.ink, background: mode === "percent" ? C.hairline : C.card, ...num }}
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

      {/* What came back from market, from every quoted plan — fixed 50% employer share, untouched by the controls above. */}
      <MarketResults plans={plans} />

      {/* Browse the grid, or ask the assistant for a short list first. */}
      <div className="noprint" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, margin: "6px 0 10px" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.navy, lineHeight: 1.2 }}>Browse All Plans</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
            {plans.length} quoted plan{plans.length === 1 ? "" : "s"} — filter, compare, or let the assistant narrow it down.
          </div>
        </div>
        {assistantOn && (
          <button onClick={() => void askAssistant(RECOMMEND_ASK, RECOMMENDATIONS_TITLE)} style={{ ...primaryBtn, padding: "11px 22px", fontSize: 15, fontWeight: 600, borderRadius: 6, display: "inline-flex", alignItems: "center", gap: 8 }} title={recommended ? "Open the recommendations the assistant already gave you" : "The assistant recommends a Lower Cost, Best Fit and Richer Benefits option from your census"}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
              <path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
            </svg>
            {recommended ? "View Plan Recommendations" : "Get Plan Recommendations"}
          </button>
        )}
      </div>

      {/* Filters and sort: a button per category with its panel beneath (one Filters
          drawer on a phone), Sort by apart from them, then the chips for what is applied. */}
      <div className="noprint" style={{ ...panel, padding: "10px 14px 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {narrow ? (
            <FiltersButton count={filterCount(filters)} open={drawerOpen} onClick={() => setDrawerOpen(true)} buttonRef={filtersBtn} />
          ) : (
            <FilterDropdowns filters={filters} onChange={setFilters} options={options} bounds={bounds} open={openPanel} setOpen={setOpenPanel} />
          )}
          <SortSelect sort={sort} onChange={setSort} />
          {!narrow && <span aria-hidden="true" style={{ width: 1, height: 22, background: C.border, margin: "0 4px" }} />}
          <button onClick={() => setFavoritesOnly((v) => !v)} aria-pressed={favoritesOnly} title={favoritesOnly ? "Show all plans" : "Show only your favorites"} style={viewToggle(favoritesOnly, favorites > 0, C.red, C.redTint)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill={favoritesOnly || favorites ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.9 12 20.5 12 20.5Z" />
            </svg>
            Favorites ({favorites})
          </button>
          <button onClick={() => setCompareOnly((v) => !v)} aria-pressed={compareOnly} title={compareOnly ? "Show all plans" : `Show only the plans you're comparing (up to ${MAX_COMPARE})`} style={viewToggle(compareOnly, proposal.length > 0, C.blue, C.blueTint)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Compare ({proposal.length})
          </button>
          {proposal.length > 0 && (
            <button onClick={compareOpen ? () => setCompareOpen(false) : viewComparison} style={{ ...chip(compareOpen), fontWeight: 600 }}>
              {compareOpen ? "Hide Comparison" : "View Comparison"}
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
        </div>
        <AppliedFilters showing={list.length} total={plans.length} chips={appliedChips} onClearAll={clearAll} />
      </div>
      {narrow && <FilterDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} applied={filters} onApply={setFilters} optionsFor={optionsFor} resultCountFor={resultCountFor} bounds={bounds} returnTo={filtersBtn} />}

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
                    <button onClick={() => toggleHeart(p.plan)} disabled={heartBlocked(p)} title={heartTitle(p)} style={chip(!!selected[p.plan])}>
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

      {/* Every dollar figure below is a month at the group's own enrollment.
          Right, above the table, on the same 10px margin as the cells. */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 7, margin: "0 10px 8px", fontSize: 13.5, fontWeight: 700, color: C.ink }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: C.blue }}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Monthly Amounts For {totals.enrolled} Enrolled Employee{totals.enrolled === 1 ? "" : "s"}
      </div>

      {/* The grid: a short row per plan; the row opens the card. */}
      <div className="panel" style={{ ...panel, padding: "0 0 10px", overflow: "auto" }}>
        <table style={{ width: "100%", minWidth: 860, borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              {(
                [
                  ["option", "Option"],
                  ["carrier", "Carrier/TPA"],
                  ["network", "Network Type"],
                  ["plan", "Plan"],
                  ["ded", "Deductible"],
                  ["oop", "OOP Max"],
                  ["er", "Your Company Pays"],
                  ["total", "Total Monthly Bill"],
                  [null, ""],
                  [null, ""],
                ] as [SortKey | null, string][]
              ).map(([k, h], i) => (
                <th
                  key={i}
                  onClick={k ? () => sortOn(k) : undefined}
                  title={k ? "Sort by this column" : undefined}
                  aria-sort={k && sort.key === k ? (sort.dir > 0 ? "ascending" : "descending") : undefined}
                  style={{
                    padding: "12px 10px 11px",
                    fontSize: 13,
                    color: C.onColor,
                    background: C.headerBg,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    // Every column reads from the left, headings and figures
                    // alike, on one margin; the digits stay tabular so the
                    // dollar columns still line up under each other.
                    textAlign: "left",
                    width: i >= 8 ? 52 : i === 0 ? 72 : undefined,
                    cursor: k ? "pointer" : undefined,
                    userSelect: "none",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {h}
                    {k === "er" && (
                      <InfoTip text="The monthly contribution your company sets, applied to each plan. Your company decides this first; employees pay the rest." color="rgba(255,255,255,0.85)" place="below" />
                    )}
                    {k === "total" && (
                      <InfoTip text="The full monthly premium: what your company pays plus what employees pay." color="rgba(255,255,255,0.85)" place="below" />
                    )}
                  </span>
                  {k && sort.key === k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
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
              const numCell = { ...cell, textAlign: "left" as const, ...num };
              return (
                <tr key={p.plan} className="rowlink" onClick={() => setOpen(p.plan)} style={{ background: heart ? C.blueTint : i % 2 ? C.zebra : C.card, cursor: "pointer" }} title="Click for every detail">
                  <td style={{ ...cell, whiteSpace: "nowrap", fontWeight: 700, color: p.optionId ? C.ink : C.faint, ...num }}>{p.optionId ?? "—"}</td>
                  <td style={{ ...cell, whiteSpace: "nowrap", color: C.body }}>
                    <CarrierMark name={carrierOf(p)} size={22} fontSize={13} color={C.body} />
                  </td>
                  <td style={{ ...cell, color: C.body, whiteSpace: "nowrap" }}>
                    <div style={{ fontWeight: 600, color: networkTypeOf(p) ? C.ink : C.faint }}>{netType(p)}</div>
                    <div style={{ fontSize: 11.5, color: C.faint }}>{networkOf(p) || ""}</div>
                  </td>
                  <td style={cell}>
                    <div>{p.plan}</div>
                    <div style={{ fontSize: 11.5, color: C.faint }}>
                      {fundingOf(p)}
                      {p.type && p.type !== p.label && p.type !== fundingOf(p) ? ` · ${p.type}` : ""}

                    </div>
                  </td>
                  <td style={numCell}>{fmtDed(p.ded)}</td>
                  <td style={numCell}>{p.oop == null ? "—" : money0(p.oop)}</td>
                  <td style={{ ...numCell, fontWeight: 700, fontSize: 14.5, whiteSpace: "nowrap" }} title={sp ? `Employees pay ${money0(sp.ee)} / mo between them` : undefined}>
                    {sp ? money0(sp.er) : "—"}
                  </td>
                  <td style={{ ...numCell, fontWeight: 700, fontSize: 14.5, whiteSpace: "nowrap" }}>
                    {p.monthly == null ? "—" : money0(p.monthly)}
                  </td>
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button className="grid-icon" onClick={() => toggleHeart(p.plan)} disabled={heartBlocked(p)} aria-label={heart ? `Remove ${p.plan} from favorites` : `Add ${p.plan} to favorites`} title={heartTitle(p)} style={{ ...iconBtn, color: heart ? C.red : heartBlocked(p) ? C.hairline : C.ghost }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill={heart ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                        <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.9 12 20.5 12 20.5Z" />
                      </svg>
                    </button>
                  </td>
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button className="grid-icon" onClick={() => toggleProposal(p.plan)} disabled={!added && compareFull} aria-label={added ? `Remove ${p.plan} from the comparison` : `Add ${p.plan} to the comparison`} title={added ? "Remove From Compare" : compareFull ? `Up to ${MAX_COMPARE} plans side by side — remove one first` : "Add To Compare"} style={{ ...iconBtn, color: added ? "#fff" : compareFull ? C.hairline : C.blue, background: added ? C.green : "transparent", borderRadius: 8 }}>
                      {added ? (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                      ) : (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={10} style={{ padding: "34px 10px 30px", textAlign: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{favoritesOnly && !favorites ? "No favorites yet" : plans.length ? "No plans match these filters" : "No quoted plans yet"}</div>
                  <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
                    {favoritesOnly && !favorites ? "Press ♡ on a plan to add it to your favorites." : plans.length ? "Try removing a filter, or clear them all to see every quoted plan." : "Plans appear here as carriers' proposals come in."}
                  </div>
                  {filtering && (
                    <button onClick={clearAll} style={{ ...chip(false), color: C.blue, fontWeight: 600, marginTop: 14 }}>
                      Clear filters
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{ padding: "12px 14px 0", fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>
          Click a column heading to sort, a plan for every detail. ♡ adds it to your favorites (up to {MAX_FAVORITES}; the list Sign Up sends) — one carrier and one funding type per group, so the first favorite sets both{lock ? ` (now ${lock.carrier} ${lock.funding})` : ""}; + picks up to {MAX_COMPARE} from any carrier to compare side by side and download.
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
            Rates shown are monthly composite rates by tier, as quoted by the carrier for this group. All rates and benefits are for general information and discussion only and are not final until the group is enrolled with the carrier.
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

/** Favorites / Compare in the toolbar: filled in its colour while on, tinted while it has anything, plain otherwise. */
const viewToggle = (on: boolean, has: boolean, color: string, tint: string): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 13px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 4,
  cursor: "pointer",
  whiteSpace: "nowrap",
  color: on ? "#fff" : has ? color : C.ink,
  background: on ? color : has ? tint : C.card,
  border: `1px solid ${on || has ? color : C.border}`,
});

const iconBtn = {
  display: "inline-grid",
  placeItems: "center",
  width: 36,
  height: 36,
  background: "none",
  border: "none",
  padding: 0,
  lineHeight: 1,
  cursor: "pointer",
} as const;

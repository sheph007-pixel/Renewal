import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { NETWORK_TYPES, RATE_DISCLAIMER, TIERS, censusCounts, censusProfile, contributionFloor, costSplit, fmtDed, money0, networkLabel, networkTypeOf, optionSortKey, type AccountManager, type Group, type MarketPlan, type TierContribution, type TierKey } from "@/lib/model";
import { C, chip, num, panel, textInput } from "@/lib/ui";
import { RECOMMENDATIONS_TITLE, askQuietly, loadRecommendations, loadThreads, useChat, type RecommendedPick, exportGridPdf, exportPlanCardPdf, exportPlansExcel } from "@/lib/chat";
import { websiteOf } from "@/lib/carrier-sites";
import { useNarrow } from "@/lib/narrow";
import { groupHome } from "@/lib/router";
import Link from "@/lib/Link";
import { DED_BANDS, DEFAULT_SORT, EMPTY_FILTERS, OOP_BANDS, bandsWithData, filterChips, filterCount, filtersEmpty, matches, optionCounts, type FilterKey, type ListKey, type PlanFacets, type PlanFilters, type SortKey, type SortState } from "@/lib/planfilters";
import { AppliedFilters, FilterDrawer, FilterDropdowns, FiltersButton, SortSelect, type AppliedChip, type BillBounds, type FilterOptionLists, showingText } from "@/views/PlanFilters";
import PlanCard, { TIER_NAMES, carrierOf, cardModel, fundingOf } from "@/views/PlanCard";
import CarrierMark from "@/views/CarrierMark";
import InfoTip from "@/views/InfoTip";
import AnalyzingGroup from "@/views/AnalyzingGroup";
import MarketResults from "@/views/MarketResults";

/**
 * Every 2027 plan from every carrier, one grid, lowest cost first.
 *
 * Above it, Employer Contribution: four figures and Apply. Employer Cost on
 * every row is that contribution × enrolled in each tier (never more than
 * the premium). A toolbar of filter dropdowns along the top (a Filters
 * drawer on a phone), Sort by beside them, chips for what is applied; a
 * short row per plan; a card with everything when a row is clicked. ♡
 * shortlists a plan - the list Sign Up sends - and + adds it to a proposal
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
  /** Today's employer contribution by tier, for the printed proposal's footer. The starting point on the page is the minimum, not this. */
  contribution: TierContribution[];
  /** The applied contribution per tier - what Employer Cost is computed from. */
  applied: Record<TierKey, number>;
  appliedChanged: boolean;
  onApply: (values: Record<TierKey, number>) => void;
  onReset: () => void;
  /** The assistant is on for this group, so "Get Plan Recommendations" can open it. */
  assistantOn?: boolean;
}

/** What the Get Plan Recommendations button asks the assistant, in the client's voice. */
type GridView = "all" | "picks" | "favorites" | "compare";

/** The assistant's three picks per carrier, as tagged on the grid. */
const TIER_LABEL: Record<RecommendedPick["tier"], string> = { lower_cost: "Lower Cost", best_fit: "Best Fit", richer_benefits: "Richer Benefits" };
const RECOMMEND_ASK = "Please give me your plan recommendations for my group: a Lower Cost, a Best Fit and a Richer Benefits option, for each carrier that quoted us - and for UnitedHealthcare, for each funding it quoted, based on our employees' ages and our enrollment. Tell me which you'd start with and why.";
/** The network as a column: any Cigna network reads "Cigna"; "(PPO)" is dropped beside a PPO-only grid. */
const networkOf = (p: MarketPlan) => (networkLabel(p.network) || "").replace(/\s*\((EPO|PPO)\)\s*$/i, "");
/** PPO / EPO / RBP, from the proposal; "-" where the quote does not say. */
const netType = (p: MarketPlan) => networkTypeOf(p) || "-";
const dedOf = (p: MarketPlan): number | null => (p.ded == null || p.ded === "" ? null : Number.isFinite(+p.ded) ? +p.ded : null);
/** Whole dollars in the fields: nobody sets a contribution to the cent. */
const fmtDraft = (v: number) => String(Math.round(v));

/**
 * Every plan's card as one row: the same details the card shows (benefits
 * as printed, rates by tier and the split at the applied contribution, the
 * totals), plus the lookups as links. Numbers stay numbers so Excel can sum.
 */
function planSheet(list: MarketPlan[], applied: Record<TierKey, number>, counts: Record<TierKey, number>): { columns: string[]; rows: (string | number | null)[][] } {
  const columns = [
    "Option", "Carrier/TPA", "Carrier Website", "Funding", "Plan", "Plan Type", "Network Type", "Network", "Provider Directory",
    "Deductible", "Out-of-Pocket Max", "Doctor Visit", "Specialist", "Imaging", "Urgent Care", "Hospital", "Prescription Drugs", "Pharmacy (PBM)", "Formulary",
    ...TIERS.flatMap((t) => [`${TIER_NAMES[t.key]} Rate`, `${TIER_NAMES[t.key]} Employer`, `${TIER_NAMES[t.key]} Employee`]),
    "Your Company Pays / Mo", "Your Employees Pay / Mo", "Total Monthly Bill", "Average Employee Monthly Contribution", "Rate Basis", "Proposal Audit",
  ];
  const cents = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);
  const rows = list.map((p) => {
    const m = cardModel(p, applied, counts);
    const b = Object.fromEntries(m.benefits) as Record<string, string>;
    const audit = m.source?.audit;
    return [
      m.optionId, m.carrier, websiteOf(m.carrier), m.funding, m.plan, m.type, b["Network type"], b["Network"], m.links.directory?.url ?? null,
      b["Deductible"], b["Out-of-pocket max"], b["Doctor visit"], b["Specialist"], b["Imaging"], b["Urgent care"], b["Hospital"], b["Prescription drugs"], b["Pharmacy (PBM)"], m.links.formulary?.url ?? null,
      ...m.tiers.flatMap((t) => [cents(t.rate), t.count ? cents(t.er) : null, t.count ? cents(t.ee) : null]),
      cents(m.er), cents(m.ee), cents(m.premium), m.ee == null || !m.enrolled ? null : cents(m.ee / m.enrolled), m.basis,
      audit ? (audit.status === "pass" ? `Completed ${new Date(audit.completedAt).toLocaleDateString("en-US")}` : "Under review") : m.source ? "Not yet audited" : null,
    ];
  });
  return { columns, rows };
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
  // The desktop filter row is closed until asked for: one quiet toolbar row, the six dropdowns beneath it on Filters.
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  // The assistant's picks, shown above the grid; fetched once, then kept
  // current by the chat stream as the assistant places new ones.
  useEffect(() => {
    if (assistantOn && chat.recommendations === undefined) loadRecommendations().catch(() => undefined);
  }, [assistantOn, chat.recommendations]);
  const rec = assistantOn ? (chat.recommendations ?? null) : null;
  /** The assistant's picks resolved to rows on the grid: plan → tier, why, and whether it is the one to start with. A pick whose option is no longer quoted is left out. */
  const picks = useMemo(() => {
    const m = new Map<string, { tier: RecommendedPick["tier"]; reason: string; start: boolean }>();
    if (!rec) return m;
    for (const pick of rec.picks) {
      const p = plans.find((x) => (x.optionId || "").toUpperCase() === pick.optionId.toUpperCase());
      if (p && !m.has(p.plan)) m.set(p.plan, { tier: pick.tier, reason: pick.reason, start: !!rec.startWith && rec.startWith.toUpperCase() === pick.optionId.toUpperCase() });
    }
    return m;
  }, [rec, plans]);
  // Which plans the grid shows: all, the assistant's picks, favorites or the
  // comparison - one at a time, so a view is never "on" behind another. A
  // fresh set of picks switches to them.
  const [view, setViewState] = useState<GridView>("all");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  /** Switch the view and give it its natural order: All by total bill, low to high; a chosen set (AI Picks, Favorites, Compare) by option ID. The sort can still be changed after. */
  const setView = useCallback((next: GridView | ((v: GridView) => GridView)) => {
    setViewState((v) => {
      const n = typeof next === "function" ? next(v) : next;
      if (n !== v) setSort(n === "all" ? DEFAULT_SORT : { key: "option", dir: 1 });
      return n;
    });
  }, []);
  const picksOnly = view === "picks";
  const favoritesOnly = view === "favorites";
  const compareOnly = view === "compare";
  const picksStamp = rec?.createdAt ?? null;
  // The grid opens on All every time (a refresh, a tab and back); it moves
  // to AI Picks only when a run started here lands, never on loading saved picks.
  useEffect(() => {
    if (picksStamp && picks.size && analyzing !== "off") setView("picks");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksStamp]);
  // Asking for picks happens in place: the button spins, the chat stays
  // closed, and the picks land in the grid when the answer is in.
  const [asking, setAsking] = useState(false);
  // Export: a small menu - the view showing as a PDF, or the rows as CSV.
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const away = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [exportOpen]);
  /** The four sets a PDF can be of, whatever view is showing; an empty one is muted in the menu. */
  const exportSets = (): { view: GridView; label: string; hint: string; plans: MarketPlan[] }[] => {
    const favs = plans.filter((p) => selected[p.plan]);
    const cmp = proposal.map((n) => plans.find((p) => p.plan === n)).filter((p): p is MarketPlan => !!p);
    const pk = plans.filter((p) => picks.has(p.plan));
    return [
      { view: "all", label: "All Plans", hint: `Every 2027 plan's details, one row each (${plans.length})`, plans },
      { view: "picks", label: "AI Picks report", hint: pk.length ? "Your census, each pick's reason, the bills side by side" : "Press AI Picks first", plans: pk },
      { view: "favorites", label: "Favorites", hint: favs.length ? `${favs.length} plan${favs.length === 1 ? "" : "s"} side by side, with benefits` : "Heart a plan first", plans: favs },
      { view: "compare", label: "Comparison", hint: cmp.length ? `${cmp.length} plan${cmp.length === 1 ? "" : "s"} side by side, with benefits` : "Add a plan with + first", plans: cmp },
    ];
  };
  const exportPdf = async (set: { view: GridView; plans: MarketPlan[] }) => {
    setExportOpen(false);
    setExporting(true);
    setExportError("");
    try {
      if (set.view === "all") {
        const sheet = planSheet(set.plans, applied, counts);
        await exportPlansExcel(sheet.columns, sheet.rows, applied, g.name);
      } else {
        await exportGridPdf(set.view, set.plans.map((p) => p.optionId ?? p.plan), applied, g.name);
      }
    } catch (e) {
      setExportError((e as Error).message || "Could not build that file.");
    } finally {
      setExporting(false);
    }
  };
  // The analysis dialog: open while the request runs, "picks ready" for a beat once they land, then closed.
  const [analyzing, setAnalyzing] = useState<"off" | "working" | "done">("off");
  const profile = useMemo(() => censusProfile(g), [g]);
  const askForPicks = () => {
    if (asking) return;
    setAsking(true);
    setAnalyzing("working");
    askQuietly(RECOMMEND_ASK, RECOMMENDATIONS_TITLE, "options")
      .catch(() => undefined)
      .finally(() => setAsking(false));
  };
  useEffect(() => {
    if (analyzing !== "working" || !picks.size || !picksStamp) return;
    setAnalyzing("done");
    const t = setTimeout(() => setAnalyzing("off"), 1100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksStamp]);
  useEffect(() => {
    // The request ended without picks (an error, or none placed): nothing to wait for.
    if (!asking && analyzing === "working" && !picks.size) setAnalyzing("off");
  }, [asking, analyzing, picks.size]);
  /** The AI Picks segment: with picks, show them (or go back to all); without, ask. */
  const aiPicksAction = () => {
    if (picks.size) setView((v) => (v === "picks" ? "all" : "picks"));
    else askForPicks();
  };
  const [filters, setFilters] = useState<PlanFilters>(EMPTY_FILTERS);
  // Closed until asked for: one line says what the company pays; Edit opens the fields.
  const [contribOpen, setContribOpen] = useState(false);
  const [query, setQuery] = useState("");
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
  const floorEE = useMemo(() => contributionFloor(plans), [plans]);
  // Every tier: the rule is per employee, whatever tier they are in, so the
  // Employee + Family amount must be at least half the Employee Only rate too.
  const belowFloorOn = (k: TierKey) => floorEE > 0 && parsed[k] < floorEE;
  const belowFloor = TIERS.some((t) => belowFloorOn(t.key));
  // A default under the floor on any tier is not a contribution a carrier
  // would accept: lift it, so the first Employer Cost the page shows is one.
  useEffect(() => {
    if (floorEE > 0 && TIERS.some((t) => (applied[t.key] || 0) < floorEE)) onApply(TIERS.reduce((acc, t) => ({ ...acc, [t.key]: Math.max(applied[t.key] || 0, floorEE) }), {} as Record<TierKey, number>));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorEE, applied.EE, applied.ES, applied.EC, applied.FAM]);
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
          (!picksOnly || picks.has(p.plan)) &&
          (!favoritesOnly || !!selected[p.plan]) &&
          (!compareOnly || proposal.includes(p.plan)) &&
          (!q || `${p.optionId ?? ""} ${p.plan} ${p.carrier} ${p.type} ${p.copays} ${p.network} ${x.network}`.toLowerCase().includes(q)),
      ),
    [faceted, q, picksOnly, picks, favoritesOnly, selected, compareOnly, proposal],
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
  const filtering = !filtersEmpty(filters) || !!q || picksOnly || favoritesOnly || compareOnly;
  /** Every filter off. The sort, the favorites and the comparison stay as they are. */
  const clearAll = () => {
    setFilters(EMPTY_FILTERS);
    setQuery("");
    setView("all");
  };
  // What is applied, as chips: one per selection in a category, then the
  // search, each removable on its own. A view (AI Picks, Favorites, Compare)
  // is not a chip: its segment says it is on, and nothing shifts when it is.
  const appliedChips: AppliedChip[] = [
    ...filterChips(filters).map((c) => ({ key: c.key, label: c.label, onRemove: () => setFilters((f) => c.remove(f)) })),
    ...(q ? [{ key: "search", label: `Search: “${query.trim()}”`, onRemove: () => setQuery("") }] : []),
  ];
  // "Show in grid" from a recommended plan: its row is scrolled to and lit
  // for a moment - after the filters are cleared, when they were hiding it.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const row = document.querySelector<HTMLElement>(`tr[data-plan="${CSS.escape(flash)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash, list]);
  /** A column heading: first click sorts it ascending, the next flips it. The Sort by control shows the same. */
  const sortOn = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir > 0 ? -1 : 1 } : { key: k, dir: 1 }));
  const MAX_COMPARE = 4;
  const inProposal = (name: string) => proposal.includes(name);
  const compareFull = proposal.length >= MAX_COMPARE;
  // Any plan can be a favorite, as many as you like - the heart works like
  // the +. Sign Up is where the one-carrier, one-funding rule lives.
  const heartTitle = (p: MarketPlan) => (selected[p.plan] ? "Remove From Favorites" : "Add To Favorites");
  /** Up to four plans side by side; a fifth is refused until one is removed. */
  const toggleProposal = (name: string) =>
    setProposal((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : prev.length >= MAX_COMPARE ? prev : [...prev, name]));
  const toggleHeart = (name: string) => onToggleSelected(name);
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
  /** The proposal alone, to the printer - Save as PDF is the browser's own button. */
  const printProposal = () => {
    document.body.classList.add("print-proposal");
    const done = () => document.body.classList.remove("print-proposal");
    window.addEventListener("afterprint", done, { once: true });
    window.print();
    setTimeout(done, 2000);
  };
  /** The open card as a PDF: the same model the card renders, sent as it shows. */
  const [cardBusy, setCardBusy] = useState(false);
  const downloadCard = async (p: MarketPlan) => {
    const m = cardModel(p, applied, counts);
    const title = m.optionId ? `${m.carrier} Option ${m.optionId}` : m.plan;
    const audit = m.source?.audit;
    const card = {
      title,
      subtitle: m.optionId ? m.plan : null,
      carrier: m.carrier,
      funding: m.funding,
      type: m.type,
      headline: { average: m.ee == null || !m.enrolled ? null : m.ee / m.enrolled, companyPays: m.er, basis: m.basis },
      benefits: m.benefits.map(([label, value]) => [label, value, label === "Network" ? m.links.directory?.url ?? null : label === "Pharmacy (PBM)" ? m.links.formulary?.url ?? null : null]),
      tiers: m.tiers.map((t) => ({ label: t.label, count: t.count, rate: t.rate, er: t.er, ee: t.ee })),
      totals: { er: m.er, ee: m.ee, premium: m.premium, enrolled: m.enrolled },
      audit: audit ? (audit.status === "pass" ? `Proposal audit completed ${new Date(audit.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}: the name, benefits and rates were checked against the carrier's own quote.` : "Proposal audit: under review.") : m.source ? "Proposal audit: not yet audited." : null,
    };
    setCardBusy(true);
    setExportError("");
    try {
      await exportPlanCardPdf(card, title, g.name);
    } catch (e) {
      setExportError((e as Error).message || "Could not build that file.");
    } finally {
      setCardBusy(false);
    }
  };
  const actionsFor = (p: MarketPlan) => (
    <>
      <button onClick={() => void downloadCard(p)} disabled={cardBusy} title="Save this plan's card as a PDF" style={{ ...chip(false), padding: "7px 12px", fontSize: 13, opacity: cardBusy ? 0.6 : 1 }}>
        {cardBusy ? "Building…" : "⤓ Download PDF"}
      </button>
      <button onClick={() => toggleHeart(p.plan)} title={heartTitle(p)} style={{ ...chip(!!selected[p.plan]), padding: "7px 12px", fontSize: 13 }}>
        {selected[p.plan] ? "♥ On Your Shortlist" : "♡ Add To Shortlist"}
      </button>
      <button onClick={() => toggleProposal(p.plan)} style={{ ...chip(inProposal(p.plan)), padding: "7px 12px", fontSize: 13 }}>
        {inProposal(p.plan) ? "✓ In Comparison" : "+ Add To Comparison"}
      </button>
    </>
  );

  return (
    <div>
      {/* What came back from market, from every quoted plan - fixed 50% employer share, untouched by the controls above - and what to do next, with the assistant's recommendations beside it. */}
      <MarketResults plans={plans} />


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
                    <button onClick={() => toggleHeart(p.plan)} title={heartTitle(p)} style={chip(!!selected[p.plan])}>
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

      {/* While the assistant is picking: what it is looking at, and where it is. */}
      {analyzing !== "off" && (
        <AnalyzingGroup profile={profile} counts={counts} enrolled={TIERS.reduce((n, t) => n + (counts[t.key] || 0), 0)} done={analyzing === "done"} pickCount={picks.size} onClose={() => setAnalyzing("off")} />
      )}

      {/* The grid: its toolbar on top, then a short row per plan; the row opens
          the card. Every dollar figure is a month at the group's own enrollment - 
          the column tooltips say so. */}
      <div className="panel" style={{ ...panel, padding: 0 }}>
        {/* Employer Contribution: the grid card's top band - one line, Edit opens the four fields. */}
        <div id="contribution" className="anchor noprint" style={{ background: C.band, borderBottom: `1px solid ${C.rule}`, borderRadius: "10px 10px 0 0" }}>
          <button
            onClick={() => setContribOpen((v) => !v)}
            aria-expanded={contribOpen}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, color: C.ink }}>
              Employer Contribution
              <InfoTip text="Cost control: you define your budget. With a defined contribution, you tell us how much you can spend. Employees use your contribution toward the plan that fits their needs. Most groups offer 2 or 3 options. If someone picks a plan that costs more, they pay the difference, and your budget does not change. See Disclaimers for the details." color={C.blue} />
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13, color: C.body }}>
              <span style={{ ...num }}>
                Your company pays <strong style={{ color: C.ink }}>{money0(TIERS.reduce((n, t) => n + (applied[t.key] || 0) * (counts[t.key] || 0), 0))}</strong> per month for{" "}
                <Link href={groupHome(g, "census")} onClick={(e) => e.stopPropagation()} title="Who is enrolled: the census every rate is priced on" style={{ color: C.blue, fontWeight: 600, textDecoration: "none" }}>
                  {totals.enrolled} enrolled
                </Link>
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
                      {belowFloorOn(t.key) && (
                        <span style={{ fontWeight: 400, color: C.red, marginLeft: 8 }} title="The Carrier/TPA minimum: at least half the Employee Only rate of the lowest-cost plan quoted, toward every employee, whatever their tier">
                          At least {money0(floorEE)}
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
                    <button onClick={onReset} title="Back to where it started: half the lowest employee-only rate on every tier" style={{ ...chip(false), color: C.blue }}>
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* The grid's toolbar, attached to the table it drives. One quiet row:
            Filters (a count badge, the six dropdowns open beneath on click; a
            drawer on a phone), how many plans are showing, Sort by, favorites and
            compare, then search and export at the right. Chips for what is
            applied appear only once something is. */}
        <div className="noprint" style={{ padding: "10px 14px 12px", borderBottom: `1px solid ${C.rule}`, background: C.zebra }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            {narrow ? (
              <FiltersButton count={filterCount(filters)} open={drawerOpen} onClick={() => setDrawerOpen(true)} buttonRef={filtersBtn} />
            ) : (
              <FiltersButton count={filterCount(filters)} open={filtersOpen} onClick={() => setFiltersOpen((v) => !v)} buttonRef={filtersBtn} />
            )}
            <SortSelect sort={sort} onChange={setSort} />
            {!narrow && <span aria-hidden="true" style={{ width: 1, height: 22, background: C.border, margin: "0 2px" }} />}
            {/* One view at a time: All, AI Picks, Favorites, Compare. The selected segment is tinted; a view with nothing in it is greyed. */}
            <div role="group" aria-label="Which plans to show" style={{ display: "inline-flex", alignItems: "stretch", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden", background: C.card }}>
              <button onClick={() => setView("all")} aria-pressed={view === "all"} title="Every quoted plan" style={segment(view === "all", false)}>
                All ({plans.length})
              </button>
              {assistantOn && (
                <span style={{ display: "inline-flex", alignItems: "stretch", borderRight: `1px solid ${C.border}` }}>
                  <button onClick={aiPicksAction} disabled={asking} aria-pressed={picksOnly} aria-busy={asking} title={asking ? "Working on your picks…" : picks.size ? "The assistant's picks: a Lower Cost, Best Fit and Richer Benefits option from each carrier and funding" : "The assistant picks a Lower Cost, Best Fit and Richer Benefits option from each carrier and funding, from your census"} style={{ ...segment(picksOnly, false), borderRight: "none", paddingRight: picks.size ? 8 : 12, opacity: asking ? 0.6 : 1, cursor: asking ? "progress" : "pointer" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill={picksOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
                    </svg>
                    AI Picks ({picks.size})
                  </button>
                  {picks.size > 0 && (
                    <button onClick={askForPicks} disabled={asking} aria-label="Run AI Picks again" title="Run again - new quotes or a changed contribution can change the picks" style={{ ...segment(picksOnly, false), borderRight: "none", padding: "7px 9px 7px 4px", opacity: asking ? 0.6 : 1 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 12a8 8 0 1 1-2.3-5.7" />
                        <path d="M20 4v5h-5" />
                      </svg>
                    </button>
                  )}
                </span>
              )}
              <button onClick={() => setView("favorites")} disabled={!favorites} aria-pressed={favoritesOnly} title={favorites ? "Only your favorites" : "Press ♡ on a plan to add it to your favorites"} style={segment(favoritesOnly, !favorites)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill={favorites ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.9 12 20.5 12 20.5Z" />
                </svg>
                Favorites ({favorites})
              </button>
              <button onClick={() => setView("compare")} disabled={!proposal.length} aria-pressed={compareOnly} title={proposal.length ? `Only the plans you're comparing (up to ${MAX_COMPARE})` : `Press + on a plan to compare it (up to ${MAX_COMPARE})`} style={segment(compareOnly, !proposal.length)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Compare ({proposal.length})
              </button>
            </div>
            {proposal.length > 0 && (
              <button onClick={compareOpen ? () => setCompareOpen(false) : viewComparison} style={{ ...chip(compareOpen), fontWeight: 600 }}>
                {compareOpen ? "Hide Comparison" : "View Comparison"}
              </button>
            )}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              {/* The count reads only when a filter or search narrows the list, at the right with Search and Export; a view switch says its count on its own segment. */}
              {(!filtersEmpty(filters) || !!q) && (
                <span aria-live="polite" style={{ fontSize: 13, color: C.muted, marginRight: 4, whiteSpace: "nowrap", ...num }}>
                  {showingText(list.length, plans.length)}
                </span>
              )}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search 2027 plan options"
                style={{ ...textInput, fontSize: 13, padding: "7px 11px", width: 104 }}
              />
              <div ref={exportRef} style={{ position: "relative" }}>
                <button onClick={() => setExportOpen((v) => !v)} disabled={!plans.length || exporting} aria-haspopup="menu" aria-expanded={exportOpen} title={exporting ? "Building your file…" : "Save the plans: every plan as a spreadsheet, or a set as a PDF"} style={{ ...chip(exportOpen), fontWeight: 700, opacity: exporting ? 0.6 : 1 }}>
                  {exporting ? "Exporting…" : "Export ▾"}
                </button>
                {exportOpen && (
                  <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 5, minWidth: 250, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(15,42,71,0.14)", padding: 4 }}>
                    {exportSets().map((set) => {
                      const empty = !set.plans.length;
                      return (
                        <button key={set.view} role="menuitem" onClick={() => void exportPdf(set)} disabled={empty} aria-disabled={empty} style={{ ...menuItem, opacity: empty ? 0.45 : 1, cursor: empty ? "default" : "pointer" }}>
                          <strong>{set.label} ({set.view === "all" ? "Excel" : "PDF"})</strong>
                          <span style={{ fontSize: 11.5, color: C.faint }}>{set.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </span>
          </div>
          {!narrow && filtersOpen && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 10 }}>
              <FilterDropdowns filters={filters} onChange={setFilters} options={options} bounds={bounds} open={openPanel} setOpen={setOpenPanel} />
            </div>
          )}
          {exportError && (
            <div role="alert" style={{ padding: "0 16px 8px", fontSize: 12.5, color: C.red }}>
              {exportError}
            </div>
          )}
          {appliedChips.length > 0 && <AppliedFilters showing={list.length} total={plans.length} chips={appliedChips} onClearAll={clearAll} showCount={false} />}
        </div>

        <div style={{ overflow: "auto", paddingBottom: 10 }}>
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
                    width: i === 8 ? (picks.size ? 58 : 40) : i > 8 ? 40 : i === 0 ? 72 : undefined,
                    cursor: k ? "pointer" : undefined,
                    userSelect: "none",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {h}
                    {k === "er" && (
                      <InfoTip text="You define your budget per plan in the setup process with Kennion. You control this amount. Employees pay the rest, pre-tax, through payroll deduction." color="rgba(255,255,255,0.85)" place="below" />
                    )}
                    {k === "total" && (
                      <InfoTip text={`The full monthly premium for your ${totals.enrolled} enrolled employee${totals.enrolled === 1 ? "" : "s"}: what your company pays plus what employees pay.`} color="rgba(255,255,255,0.85)" place="below" />
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
                <tr key={p.plan} data-plan={p.plan} className={flash === p.plan ? "rowlink row-flash" : "rowlink"} onClick={() => setOpen(p.plan)} style={{ background: heart ? C.blueTint : i % 2 ? C.zebra : C.card, cursor: "pointer" }} title="Click for every detail">
                  <td style={{ ...cell, whiteSpace: "nowrap", fontWeight: 700, color: p.optionId ? C.ink : C.faint, ...num }}>{p.optionId ?? "-"}</td>
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
                  <td style={numCell}>{p.oop == null ? "-" : money0(p.oop)}</td>
                  <td style={{ ...numCell, fontWeight: 700, fontSize: 14.5, whiteSpace: "nowrap" }} title={sp ? `Employees pay ${money0(sp.ee)} / mo between them` : undefined}>
                    {sp ? money0(sp.er) : "-"}
                  </td>
                  <td style={{ ...numCell, fontWeight: 700, fontSize: 14.5, whiteSpace: "nowrap" }}>
                    {p.monthly == null ? "-" : money0(p.monthly)}
                  </td>
                  <td className="noprint" style={{ ...cell, padding: "9px 4px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    {/* The AI pick mark: lit on a picked plan whatever view is on; the row opens the card with the reason. */}
                    {(() => {
                      const pk = picks.get(p.plan);
                      return (
                        <button className="grid-icon" onClick={() => setOpen(p.plan)} disabled={!pk} aria-label={pk ? `AI pick: ${TIER_LABEL[pk.tier]}` : "Not an AI pick"} title={pk ? `AI pick · ${TIER_LABEL[pk.tier]}${pk.start ? " · start here" : ""} - ${pk.reason}` : assistantOn ? "Not one of the assistant's picks" : undefined} style={{ ...iconBtn, width: "auto", minWidth: 30, height: "auto", minHeight: 30, padding: pk ? "2px 2px" : 0, gap: 1, fontSize: 9.5, lineHeight: 1.05, fontWeight: 700, letterSpacing: 0.1, color: pk ? C.blueInk : C.hairline, cursor: pk ? "pointer" : "default" }}>
                          <svg width={pk ? 16 : 20} height={pk ? 16 : 20} viewBox="0 0 24 24" fill={pk ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
                          </svg>
                          {pk && <span style={{ display: "block", maxWidth: 54, whiteSpace: "normal" }}>{TIER_LABEL[pk.tier]}</span>}
                        </button>
                      );
                    })()}
                  </td>
                  <td className="noprint" style={{ ...cell, padding: "9px 4px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button className="grid-icon" onClick={() => toggleHeart(p.plan)} aria-label={heart ? `Remove ${p.plan} from favorites` : `Add ${p.plan} to favorites`} title={heartTitle(p)} style={{ ...iconBtn, color: heart ? C.red : C.ghost }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill={heart ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                        <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.9 12 20.5 12 20.5Z" />
                      </svg>
                    </button>
                  </td>
                  <td className="noprint" style={{ ...cell, padding: "9px 4px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button className="grid-icon" onClick={() => toggleProposal(p.plan)} disabled={!added && compareFull} aria-label={added ? `Remove ${p.plan} from the comparison` : `Add ${p.plan} to the comparison`} title={added ? "Remove From Compare" : compareFull ? `Up to ${MAX_COMPARE} plans side by side - remove one first` : "Add To Compare"} style={{ ...iconBtn, color: added ? "#fff" : compareFull ? C.hairline : C.blue, background: added ? C.green : "transparent", borderRadius: 8 }}>
                      {added ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
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
                <td colSpan={11} style={{ padding: "34px 10px 30px", textAlign: "center" }}>
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
        </div>
      </div>

      {opened && (
        <div role="dialog" aria-modal="true" aria-label={`${opened.plan} details`} onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,24,28,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(860px, 100%)", maxHeight: "94vh", overflow: "auto", position: "relative" }}>
            <button onClick={() => setOpen(null)} aria-label="Close" style={{ ...iconBtn, position: "absolute", top: 8, right: 10, fontSize: 22, color: C.muted, zIndex: 1 }}>
              ×
            </button>
            {picks.get(opened.plan) && (
              <div style={{ background: "#e8eef5", border: "1px solid #c9d6e6", borderRadius: 4, padding: "8px 12px", marginBottom: 8, fontSize: 13, color: C.navy, lineHeight: 1.5 }}>
                <strong>{picks.get(opened.plan)!.start ? "★ Start here · " : "✦ "}{TIER_LABEL[picks.get(opened.plan)!.tier]}</strong> - {picks.get(opened.plan)!.reason}
              </div>
            )}
            <PlanCard m={card(opened)} actions={actionsFor(opened)} wide disclaimersHref={groupHome(g, "disclaimers")} />
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
            Rates shown are monthly composite rates by tier, as quoted by the Carrier/TPA for this group. {RATE_DISCLAIMER}
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
/** One segment of the view control: the selected one tinted, an empty one greyed, the rest plain. */
const segment = (on: boolean, empty: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  fontSize: 13,
  fontWeight: on ? 700 : 500,
  whiteSpace: "nowrap",
  color: on ? C.blueInk : empty ? C.ghost : C.ink,
  background: on ? C.blueTint : "transparent",
  border: "none",
  borderRight: `1px solid ${C.border}`,
  cursor: empty ? "default" : "pointer",
});

const menuItem = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  width: "100%",
  padding: "8px 10px",
  background: "none",
  border: "none",
  borderRadius: 6,
  textAlign: "left",
  fontSize: 13,
  color: C.ink,
  cursor: "pointer",
} as const;

const iconBtn = {
  display: "inline-grid",
  placeItems: "center",
  width: 30,
  height: 30,
  background: "none",
  border: "none",
  padding: 0,
  lineHeight: 1,
  cursor: "pointer",
} as const;

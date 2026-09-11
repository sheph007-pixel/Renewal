import { useEffect, useMemo, useState } from "react";
import { TIERS, censusCounts, fmtDate, fmtDed, money, money0, type Group, type MarketPlan, type TierContribution, type TierKey } from "@/lib/model";
import { C, chip, num, panel, textInput } from "@/lib/ui";

/**
 * Every 2027 plan from every carrier, one grid, lowest monthly premium first.
 *
 * Reads the way a broker's comparison tool does: filter tabs along the top
 * (Carrier, Deductible, OOP Max, Funding, Total Cost), a short row per plan
 * (carrier, plan, deductible, OOP max, monthly), and the whole story in a
 * popup when a row is clicked. A heart marks a plan the group wants to talk
 * about — that is the shortlist Sign Up sends — and + adds it to a proposal
 * the group can download as Excel or print to PDF.
 */

export interface GridProps {
  g: Group;
  plans: MarketPlan[];
  /** Today's monthly premium and enrolment, for "vs today". */
  totals: { total: number; enrolled: number };
  /** The shortlist (hearts), owned by the app since Sign Up sends it. */
  selected: Record<string, boolean>;
  onToggleSelected: (plan: string) => void;
  /** Whether any UHC rate is a direct quote, for the footnote. */
  direct: boolean;
  /** Today's employer contribution by tier — the budget's starting point and the "today" it is compared to. */
  contribution: TierContribution[];
  /** The employer's monthly budget per tier: what they put in toward any plan. */
  budget: Record<TierKey, number>;
  budgetChanged: boolean;
  onBudgetChange: (key: TierKey, value: number) => void;
  onBudgetReset: () => void;
}

const TIER_NAMES: Record<TierKey, string> = { EE: "Employee Only", ES: "Employee + Spouse", EC: "Employee + Children", FAM: "Employee + Family" };

/**
 * What the employer pays for a plan at the budget: each tier's headcount
 * times the lower of the budget and that tier's rate, so a budget above the
 * premium never pays more than the premium. Employees cover the rest.
 */
export function costSplit(p: MarketPlan, budget: Record<TierKey, number>, counts: Record<TierKey, number>) {
  let er = 0;
  let total = 0;
  let any = false;
  for (const t of TIERS) {
    const n = counts[t.key] || 0;
    const rate = p.rates[t.key];
    if (!n || rate == null) continue;
    any = true;
    er += Math.min(Math.max(budget[t.key] || 0, 0), rate) * n;
    total += rate * n;
  }
  return any ? { er: +er.toFixed(2), ee: +(total - er).toFixed(2), total: +total.toFixed(2) } : null;
}

type Tab = "carrier" | "ded" | "oop" | "funding" | "cost";
const TABS: [Tab, string][] = [
  ["carrier", "Carrier"],
  ["ded", "Deductible"],
  ["oop", "OOP Max"],
  ["funding", "Funding"],
  ["cost", "Total Cost"],
];

/** Deductible bands a client can pick. */
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

const carrierOf = (p: MarketPlan) => p.carrier.replace(" (UnitedHealthcare)", "");
const dedOf = (p: MarketPlan): number | null => (p.ded == null || p.ded === "" ? null : Number.isFinite(+p.ded) ? +p.ded : null);

/** How the plan is funded, from what the carrier said or the carrier itself. */
export function fundingOf(p: MarketPlan): string {
  const t = `${p.label} ${p.type}`;
  if (/fully/i.test(t)) return "Fully Insured";
  if (/self/i.test(t)) return "Self Funded";
  if (/level/i.test(t) || /Gravie|UnitedHealthcare|Surest/i.test(p.carrier)) return "Level Funded";
  return p.label || "Quoted";
}

const basisOf = (p: MarketPlan) =>
  p.quoted ? `Quoted for you ${fmtDate(p.quoted.date || undefined)}` : p.indicative ? "Indicative rate †" : p.pending ? "Quote requested" : "Carrier menu rate";

export default function OptionsGrid({ g, plans, totals, selected, onToggleSelected, direct, contribution, budget, budgetChanged, onBudgetChange, onBudgetReset }: GridProps) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(true);
  const [sortBy, setSortBy] = useState<"total" | "er">("total");
  const counts = useMemo(() => censusCounts(g), [g]);
  const split = (p: MarketPlan) => costSplit(p, budget, counts);
  const budgetTotal = TIERS.reduce((n, t) => n + (counts[t.key] || 0) * (budget[t.key] || 0), 0);
  const todayEr = contribution.reduce((n, t) => n + (t.er ?? 0) * t.count, 0);
  const [carriers, setCarriers] = useState<Set<string>>(new Set());
  const [deds, setDeds] = useState<Set<string>>(new Set());
  const [oops, setOops] = useState<Set<string>>(new Set());
  const [fundings, setFundings] = useState<Set<string>>(new Set());
  const [costs, setCosts] = useState<Set<string>>(new Set());
  const [costDir, setCostDir] = useState<1 | -1>(1);
  const [query, setQuery] = useState("");
  const [proposal, setProposal] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const carrierList = useMemo(() => Array.from(new Set(plans.map(carrierOf))), [plans]);
  const fundingList = useMemo(() => Array.from(new Set(plans.map(fundingOf))), [plans]);

  // Cost tiers: quartiles of the priced plans, so $ … $$$$ always splits
  // this group's own market into four.
  const costTier = useMemo(() => {
    const priced = plans.map((p) => p.monthly).filter((m): m is number => m != null).sort((a, b) => a - b);
    const cut = (q: number) => priced[Math.min(priced.length - 1, Math.floor(priced.length * q))] ?? Infinity;
    const cuts = [cut(0.25), cut(0.5), cut(0.75)];
    return (p: MarketPlan) => (p.monthly == null ? null : COST_TIERS[cuts.findIndex((c) => p.monthly! < c) === -1 ? 3 : cuts.findIndex((c) => p.monthly! < c)]);
  }, [plans]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };

  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    const dedOk = (p: MarketPlan) => {
      if (!deds.size) return true;
      const v = dedOf(p);
      return v != null && DED_BANDS.some(([label, f]) => deds.has(label) && f(v));
    };
    const oopOk = (p: MarketPlan) => {
      if (!oops.size) return true;
      return p.oop != null && OOP_BANDS.some(([label, f]) => oops.has(label) && f(p.oop!));
    };
    return plans
      .filter(
        (p) =>
          (!carriers.size || carriers.has(carrierOf(p))) &&
          dedOk(p) &&
          oopOk(p) &&
          (!fundings.size || fundings.has(fundingOf(p))) &&
          (!costs.size || (costTier(p) != null && costs.has(costTier(p)!))) &&
          (!q || `${p.plan} ${p.carrier} ${p.type} ${p.copays} ${p.network}`.toLowerCase().includes(q)),
      )
      .slice()
      .sort((a, b) => {
        const va = sortBy === "er" ? (split(a)?.er ?? Infinity) : (a.monthly ?? Infinity);
        const vb = sortBy === "er" ? (split(b)?.er ?? Infinity) : (b.monthly ?? Infinity);
        return (va - vb) * costDir || a.plan.localeCompare(b.plan);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, carriers, deds, oops, fundings, costs, costTier, q, costDir, sortBy, budget, counts]);

  const filtering = carriers.size + deds.size + oops.size + fundings.size + costs.size > 0 || !!q;
  const clearAll = () => {
    setCarriers(new Set());
    setDeds(new Set());
    setOops(new Set());
    setFundings(new Set());
    setCosts(new Set());
    setQuery("");
  };
  const count = (t: Tab) =>
    ({ carrier: carriers.size, ded: deds.size, oop: oops.size, funding: fundings.size, cost: costs.size })[t];

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
      downloadOptions(g, list, proposed, totals.total, budget, counts);
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

  return (
    <div>
      {/* The budget bar: what the employer puts in per tier, and what that adds up to. */}
      <div id="budget" className="panel anchor" style={{ ...panel, marginBottom: 12, padding: budgetOpen ? "12px 16px 14px" : "10px 16px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>Your monthly budget</h3>
            <span style={{ fontSize: 20, fontWeight: 600, color: C.ink, letterSpacing: "-0.3px", ...num }}>{money0(budgetTotal)}</span>
            <span style={{ fontSize: 12.5, color: C.faint }}>
              / mo across {totals.enrolled} enrolled
              {!budgetOpen && ` · ${TIERS.map((t) => `${t.short} ${money0(budget[t.key] || 0)}`).join(" · ")}`}
              {todayEr > 0 && ` · today ${money0(todayEr)}`}
            </span>
          </div>
          <div className="noprint" style={{ display: "flex", gap: 6 }}>
            {budgetChanged && (
              <button onClick={onBudgetReset} style={{ ...chip(false), color: C.blue }}>
                Reset to today
              </button>
            )}
            <button onClick={() => setBudgetOpen((v) => !v)} style={chip(false)} aria-expanded={budgetOpen}>
              {budgetOpen ? "Collapse ▴" : "Edit ▾"}
            </button>
          </div>
        </div>
        {budgetOpen && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
            {TIERS.map((t) => {
              const today = contribution.find((c) => c.key === t.key);
              return (
                <label key={t.key} style={{ display: "block", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 4, background: C.zebra }}>
                  <div style={{ fontSize: 12, color: C.muted }}>{TIER_NAMES[t.key]}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginTop: 4 }}>
                    <span style={{ fontSize: 14, color: C.faint }}>$</span>
                    <BudgetInput value={budget[t.key] || 0} onChange={(v) => onBudgetChange(t.key, v)} label={`Monthly budget for ${TIER_NAMES[t.key]}`} />
                    <span style={{ fontSize: 12, color: C.faint }}>/ mo each</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3 }}>
                    {counts[t.key] || 0} enrolled{today && today.er != null ? ` · today ${money0(today.er)}` : ""}
                  </div>
                </label>
              );
            })}
          </div>
        )}
        {budgetOpen && (
          <div style={{ fontSize: 12, color: C.faint, marginTop: 8, lineHeight: 1.5 }}>
            Employer Cost on each plan is your budget × enrolled in each tier, never more than that plan&rsquo;s premium; employees pay the difference.
            Today&rsquo;s figures are what you contribute now, averaged by tier.
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
                {t === "cost" && !n ? (costDir > 0 ? " · $ → $$$$" : " · $$$$ → $") : ""}
              </button>
            );
          })}
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
                <span style={{ fontSize: 12.5, color: C.muted }}>Sort by</span>
                <button onClick={() => setSortBy("total")} style={chip(sortBy === "total")}>
                  Total monthly
                </button>
                <button onClick={() => setSortBy("er")} style={chip(sortBy === "er")}>
                  Employer cost
                </button>
                <button onClick={() => setCostDir(1)} style={{ ...chip(costDir > 0), marginLeft: 6 }}>
                  $ → $$$$
                </button>
                <button onClick={() => setCostDir(-1)} style={chip(costDir < 0)}>
                  $$$$ → $
                </button>
                <span style={{ fontSize: 12.5, color: C.muted, marginLeft: 10 }}>Show</span>
                {chips(COST_TIERS, costs, setCosts)}
                <span style={{ fontSize: 12, color: C.faint }}>— quarters of your market, cheapest to dearest</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* The proposal being built: side by side, downloadable, printable. */}
      {proposed.length > 0 && (
        <div id="proposal" className="panel" style={{ ...panel, marginBottom: 12, padding: "14px 18px 16px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>
                Your proposal · {proposed.length} plan{proposed.length === 1 ? "" : "s"}
              </h3>
              <div className="printonly" style={{ display: "none", fontSize: 12, color: C.faint, marginTop: 2 }}>
                {g.name} · 2027 medical options · priced at {totals.enrolled} enrolled · {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
              </div>
            </div>
            <div className="noprint" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%", minWidth: 160 + proposed.length * 170 }}>
              <thead>
                <tr>
                  <th style={{ ...cmpHead, width: 150 }} />
                  {proposed.map((p) => (
                    <th key={p.plan} style={cmpHead}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: C.faint }}>{carrierOf(p)}</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>{p.plan}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailRows(totals.total, split).map(([label, f, strong]) => (
                  <tr key={label}>
                    <td style={{ ...cmpLabel, ...(strong ? { fontWeight: 600, color: C.ink } : {}) }}>{label}</td>
                    {proposed.map((p) => (
                      <td key={p.plan} style={{ ...cmpCell, ...(strong ? { fontWeight: 600, color: C.ink, ...num } : {}) }}>
                        {f(p)}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="noprint">
                  <td style={cmpLabel} />
                  {proposed.map((p) => (
                    <td key={p.plan} style={{ ...cmpCell, paddingTop: 10 }}>
                      <button onClick={() => onToggleSelected(p.plan)} style={{ ...chip(!!selected[p.plan]), width: "100%" }}>
                        {selected[p.plan] ? "♥ Shortlisted" : "♡ Shortlist"}
                      </button>
                      <button onClick={() => toggleProposal(p.plan)} style={linkBtnStyle}>
                        Remove
                      </button>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* The grid: a short row per plan; the row opens the details. */}
      <div className="panel" style={{ ...panel, padding: "0 0 10px", overflow: "auto" }}>
        <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              {["", "Carrier", "Plan", "Deductible", "OOP Max", "Employer Cost", "Total Monthly", ""].map((h, i) => (
                <th
                  key={i}
                  style={{
                    padding: "12px 10px 11px",
                    fontSize: 12.5,
                    color: C.muted,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    borderBottom: `1px solid ${C.border}`,
                    textAlign: i >= 3 && i <= 6 ? "right" : "left",
                    width: i === 0 || i === 7 ? 44 : undefined,
                  }}
                >
                  {h}
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
                <tr
                  key={p.plan}
                  onClick={() => setOpen(p.plan)}
                  style={{ background: heart ? C.blueTint : i % 2 ? C.zebra : C.card, cursor: "pointer" }}
                  title="Click for every detail"
                >
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => onToggleSelected(p.plan)}
                      aria-label={heart ? `Remove ${p.plan} from your shortlist` : `Shortlist ${p.plan}`}
                      title={heart ? "On your shortlist — click to remove" : "Shortlist this plan"}
                      style={{ ...iconBtn, color: heart ? C.red : C.ghost }}
                    >
                      {heart ? "♥" : "♡"}
                    </button>
                  </td>
                  <td style={{ ...cell, whiteSpace: "nowrap", color: C.body }}>{carrierOf(p)}</td>
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
                  <td style={{ ...right, fontWeight: 600, whiteSpace: "nowrap" }} title={sp ? `Employees pay ${money0(sp.ee)} / mo between them` : undefined}>
                    {sp ? money0(sp.er) : p.pending ? "quote requested" : "—"}
                    {sp && sp.ee > 0 && <div style={{ fontSize: 11, fontWeight: 400, color: C.faint }}>employees {money0(sp.ee)}</div>}
                  </td>
                  <td style={{ ...right, whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 11, color: C.faint, marginRight: 8, letterSpacing: 1 }}>{costTier(p) || ""}</span>
                    {p.monthly == null ? "—" : money0(p.monthly) + (p.indicative ? " †" : "")}
                  </td>
                  <td className="noprint" style={{ ...cell, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => toggleProposal(p.plan)}
                      aria-label={added ? `Remove ${p.plan} from your proposal` : `Add ${p.plan} to your proposal`}
                      title={added ? "In your proposal — click to remove" : "Add to your proposal"}
                      style={{ ...iconBtn, color: added ? C.green : C.blue, fontWeight: 700 }}
                    >
                      {added ? "✓" : "+"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={8} style={{ padding: "26px 10px", textAlign: "center", color: C.faint }}>
                  No plan matches those filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{ padding: "12px 14px 0", fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>
          {list.length === plans.length ? `${list.length} plans` : `${list.length} of ${plans.length} plans`}, {costDir > 0 ? "lowest" : "highest"} {sortBy === "er" ? "employer cost" : "total monthly"} first.
          Click a plan for every detail. ♡ shortlists it for Sign Up; + adds it to a proposal you can download.
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
        {direct
          ? "† Indicative rate — scaled from the plans UnitedHealthcare quoted directly for your group. Un-marked rows are your quoted rates."
          : "† Indicative rate — your current rate level applied to the UnitedHealthcare menu quoted for comparable Kennion groups; your own underwriting is still open."}{" "}
        Monthly Premium is that plan's rates × your current enrollment by tier, i.e. every enrolled employee on that one plan.
        Rows marked quoted are read off the proposal the carrier sent for your group. Final rates confirm at enrollment and underwriting approval.
      </div>

      {opened && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${opened.plan} details`}
          onClick={() => setOpen(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(20,24,28,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ ...panel, width: "min(640px, 100%)", maxHeight: "90vh", overflow: "auto", padding: "18px 22px 20px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12.5, color: C.faint }}>{carrierOf(opened)} · {fundingOf(opened)}</div>
                <h3 style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>{opened.plan}</h3>
              </div>
              <button onClick={() => setOpen(null)} aria-label="Close" style={{ ...iconBtn, fontSize: 20, color: C.muted }}>
                ×
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "12px 0 4px" }}>
              <span style={{ fontSize: 26, fontWeight: 600, color: C.ink, letterSpacing: "-0.4px", ...num }}>
                {opened.monthly == null ? "—" : money0(opened.monthly)}
              </span>
              <span style={{ fontSize: 12.5, color: C.faint }}>/ mo with all {totals.enrolled} enrolled on this plan</span>
            </div>
            {(() => {
              const sp = split(opened);
              return sp ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 13, marginTop: 4 }}>
                  <span><strong style={{ color: C.ink }}>{money0(sp.er)}</strong> <span style={{ color: C.muted }}>you pay at your budget</span></span>
                  <span><strong style={{ color: C.ink }}>{money0(sp.ee)}</strong> <span style={{ color: C.muted }}>employees pay between them</span></span>
                  {totals.total > 0 && (
                    <span style={{ fontWeight: 600, color: opened.monthly! - totals.total >= 0 ? C.red : C.green }}>
                      {opened.monthly! - totals.total >= 0 ? "+" : "−"}
                      {money0(Math.abs(opened.monthly! - totals.total))} total vs today
                    </span>
                  )}
                </div>
              ) : null;
            })()}
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, marginTop: 12 }}>
              <thead>
                <tr>
                  {["Tier", "Enrolled", "Premium", "You pay", "Employee pays"].map((h, i) => (
                    <th key={h} style={{ ...cmpLabel, textAlign: i ? "right" : "left", fontWeight: 600, color: C.ink }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TIERS.map((t) => {
                  const rate = opened.rates[t.key];
                  const er = rate == null ? null : Math.min(Math.max(budget[t.key] || 0, 0), rate);
                  return (
                    <tr key={t.key}>
                      <td style={cmpLabel}>{TIER_NAMES[t.key]}</td>
                      <td style={{ ...cmpCell, textAlign: "right", ...num }}>{counts[t.key] || 0}</td>
                      <td style={{ ...cmpCell, textAlign: "right", ...num }}>{rate == null ? "—" : money(rate)}</td>
                      <td style={{ ...cmpCell, textAlign: "right", ...num }}>{er == null ? "—" : money(er)}</td>
                      <td style={{ ...cmpCell, textAlign: "right", ...num, fontWeight: 600, color: C.ink }}>{rate == null || er == null ? "—" : money(rate - er)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, marginTop: 12 }}>
              <tbody>
                {detailRows(totals.total, split)
                  .filter(([label]) => !["Monthly premium", "Vs today", "Employer cost", "Employees pay"].includes(label) && !TIERS.some((t) => t.label === label))
                  .map(([label, f]) => (
                    <tr key={label}>
                      <td style={{ ...cmpLabel, width: 150 }}>{label}</td>
                      <td style={cmpCell}>{f(opened)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="noprint" style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <button onClick={() => onToggleSelected(opened.plan)} style={{ ...chip(!!selected[opened.plan]), padding: "8px 14px", fontSize: 13 }}>
                {selected[opened.plan] ? "♥ On your shortlist" : "♡ Add to shortlist"}
              </button>
              <button onClick={() => toggleProposal(opened.plan)} style={{ ...chip(inProposal(opened.plan)), padding: "8px 14px", fontSize: 13 }}>
                {inProposal(opened.plan) ? "✓ In your proposal" : "+ Add to proposal"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Every detail of a plan, as label / value rows, shared by the popup and the proposal. */
function detailRows(
  today: number,
  split: (p: MarketPlan) => { er: number; ee: number; total: number } | null,
): [string, (p: MarketPlan) => string, boolean?][] {
  return [
    ["Funding", fundingOf],
    ["Plan type", (p) => p.type || "—"],
    ["Network", (p) => p.network],
    ["Deductible", (p) => fmtDed(p.ded)],
    ["OOP max", (p) => (p.oop == null ? "—" : money0(p.oop))],
    ["PCP / SPC", (p) => p.copays],
    ["Rx", (p) => p.rx],
    ...TIERS.map((t): [string, (p: MarketPlan) => string] => [t.label, (p) => (p.rates[t.key] == null ? "—" : money(p.rates[t.key]))]),
    ["Basis", basisOf],
    ["Employer cost", (p) => (split(p) ? money0(split(p)!.er) : "—"), true],
    ["Employees pay", (p) => (split(p) ? money0(split(p)!.ee) : "—")],
    ["Monthly premium", (p) => (p.monthly == null ? "—" : money0(p.monthly)), true],
    ["Vs today", (p) => (p.monthly == null ? "—" : `${p.monthly - today >= 0 ? "+" : "−"}${money0(Math.abs(p.monthly - today))} / mo`)],
  ];
}

const iconBtn = {
  background: "none",
  border: "none",
  padding: "2px 6px",
  fontSize: 17,
  lineHeight: 1,
  cursor: "pointer",
} as const;
const cmpHead = {
  padding: "8px 10px",
  borderBottom: `1px solid ${C.border}`,
  textAlign: "left" as const,
  verticalAlign: "bottom" as const,
  minWidth: 150,
};
const cmpLabel = {
  padding: "7px 10px 7px 0",
  fontSize: 12.5,
  color: C.muted,
  borderBottom: `1px solid ${C.hairline}`,
  whiteSpace: "nowrap" as const,
  verticalAlign: "top" as const,
};
const cmpCell = {
  padding: "7px 10px",
  color: C.body,
  borderBottom: `1px solid ${C.hairline}`,
  verticalAlign: "top" as const,
};
const linkBtnStyle = {
  background: "none",
  border: "none",
  padding: 0,
  marginTop: 6,
  fontSize: 12,
  color: C.blue,
  cursor: "pointer",
  display: "block",
} as const;

/** A dollar field that keeps what is typed while focused and commits a number on every valid keystroke. */
function BudgetInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  return (
    <input
      value={text}
      inputMode="decimal"
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const v = e.target.value.replace(/[^\d.]/g, "");
        setText(v);
        const n = Number(v);
        if (v !== "" && !Number.isNaN(n)) onChange(n);
      }}
      style={{ ...textInput, width: 90, padding: "5px 8px", fontSize: 15, fontWeight: 600, color: C.ink, ...num }}
    />
  );
}

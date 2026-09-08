// Domain model for the Kennion 2027 renewal portal.
//
// Ported from the Claude Design prototype. The rate rules below are the ones
// the design iterated to and are load-bearing for every figure on the page:
//
//  - A tier rate is BILLED when Employee Navigator has a premium for it. That
//    only happens when someone is actually enrolled in that tier.
//  - A tier with nobody in it has no billed rate anywhere, so it is CALCULATED
//    at the program tier factors (EE 1.00 / EE+SP 2.00 / EE+CH 1.85 /
//    EE+Family 2.85). These reconcile to 161 of 165 billed rates in the export.
//  - Calculated tiers are labelled "calc." and never contribute to a total,
//    because no one is enrolled in them.
//  - A hand-keyed rate from a carrier sheet (MANUAL) beats both.

export type TierKey = "EE" | "ES" | "EC" | "FAM";

export interface Tier {
  key: TierKey;
  label: string;
  census: string;
  short: string;
}

export const TIERS: Tier[] = [
  { key: "EE", label: "Employee", census: "Employee", short: "EE" },
  { key: "ES", label: "Employee + Spouse", census: "Employee + Spouse", short: "ES" },
  { key: "EC", label: "Employee + Child(ren)", census: "Employee + Child(ren)", short: "EC" },
  { key: "FAM", label: "Employee + Family", census: "Employee + Family", short: "EF" },
];

export const FACTORS: Record<TierKey, number> = { EE: 1, ES: 2.0, EC: 1.85, FAM: 2.85 };

export interface Freq {
  key: "M" | "SM" | "BW" | "W";
  label: string;
  div: number;
  divisorLabel: string;
}

export const FREQS: Freq[] = [
  { key: "M", label: "Monthly", div: 1, divisorLabel: "12" },
  { key: "SM", label: "Semi-Monthly", div: 2, divisorLabel: "24" },
  { key: "BW", label: "Bi-Weekly", div: 26 / 12, divisorLabel: "26" },
  { key: "W", label: "Weekly", div: 52 / 12, divisorLabel: "52" },
];

// ---------------------------------------------------------------- data shapes

export interface Member {
  first: string;
  last: string;
  gender?: string;
  age?: number;
  zip?: string;
  tier: string;
  plan: string;
  tpa?: string;
  premium?: number | null;
  spAges?: number[];
  chAges?: number[];
}

export interface GroupPlan {
  plan: string;
  tpa: string;
  enrolled: number;
  monthly: number;
}

export interface Group {
  /** Enrolled counts by tier for each plan. The census itself stays on the server. */
  planTiers?: Record<string, Record<TierKey, number>>;
  n: number;
  name: string;
  divisionCode?: string;
  city?: string;
  state?: string;
  pyStart?: string;
  pyEnd?: string;
  tpa: string;
  enrolled: number;
  lives: number;
  tiers?: Record<TierKey, number>;
  monthly?: number;
  annual?: number;
  plans?: GroupPlan[];
  members?: Member[];
  rates?: Record<string, Record<string, number>>;
  /** Derived at load time from the group name. */
  code: string;
}

export interface MenuPlan {
  plan: string;
  type: string;
  ded: number | string | null;
  coins?: string;
  oop: number | null;
  copays: string;
  uc?: string;
  er?: string;
  rx: string;
  refRate: number | null;
}

export interface DetailRow {
  currentPlan: string;
  tier: TierKey;
  enrolled: number;
  currentRate: number | null;
  uhcPlan: string;
  uhcRate: number | null;
}

export interface MappingRow {
  currentPlan: string;
  uhcPlan: string;
}

export interface SplitAmounts {
  total: number;
  er: number;
  ee: number;
}

export interface GroupSplit {
  source: string;
  plans: Record<string, Record<string, SplitAmounts>>;
}

/** One plan option read off a carrier proposal, with monthly composite rates by tier. */
export interface ProposalPlan {
  name: string;
  /** The carrier's code for the plan, where one is printed. */
  planCode?: string | null;
  /** The network it is priced on, where the quote distinguishes them. */
  network?: string | null;
  planType: string | null;
  deductible: string | null;
  oopMax: string | null;
  rates: Record<TierKey, number | null>;
  monthlyTotal: number | null;
}

/** A group's current proposal in one slot (UHC Fully Insured, UHC Level Funded, Gravie, Nationwide, Angle, Cobalt). */
export interface GroupProposal {
  id: number;
  slot: string;
  carrier: string | null;
  funding: string | null;
  effectiveDate: string | null;
  proposalType: string | null;
  enrolledOnDocument: number | null;
  plans: ProposalPlan[];
  totalMonthly: number | null;
  summary: string | null;
  filename: string;
  uploadedAt: string;
}

/** What Employee Navigator billed the group for the month — counts and rates only. */
export interface GroupFundingSnapshot {
  month: string | null;
  participants: number;
  monthly: number;
  adjustments: number;
  billed: number;
  otherMonthly: number;
  byPlan: Record<string, { monthly: number; byTier: Record<string, { n: number; rate: number | null }> }>;
}

export interface KennionData {
  meta: { source: string; asOf: string };
  groups: Group[];
  planDesigns: Record<string, Record<string, string>>;
  uhc: {
    detail: Record<string, DetailRow[]>;
    summary: unknown;
    menu: MenuPlan[];
    mapping: MappingRow[];
    /** Average EE current rate of a reference group, for scaling an un-quoted group. */
    refEE?: number | null;
  };
  splits: Record<string, GroupSplit>;
  /** The signed-in group's proposals on file (group sessions only). */
  proposals?: GroupProposal[];
  /** The proposal slots this group has — Cobalt only where it is quoted. */
  slots?: string[];
  /** The signed-in group's billing this month (group sessions only). */
  funding?: GroupFundingSnapshot | null;
}

/** Rate overrides keyed by `group||plan||censusTier`, persisted per browser. */
export type Overrides = Record<string, string>;

// ------------------------------------------------------------------ utilities

export function money(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function money0(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** Stable per-group access code, e.g. Johnson Storage → KEN-JOHN-4669. */
export function codeFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100000;
  const letters = name
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, "X");
  return "KEN-" + letters + "-" + String(h).padStart(5, "0").slice(0, 4);
}

export function fmtDed(v: number | string | null | undefined): string {
  if (v === 0 || v === "0") return "$0";
  return money0(v == null ? null : +v);
}

export function fmtDate(s: string | undefined): string {
  if (!s) return "";
  return new Date(s + "T00:00:00").toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

export const tierByKey = (key: TierKey): Tier => TIERS.find((t) => t.key === key)!;
export const tierByCensus = (census: string): Tier | undefined =>
  TIERS.find((t) => t.census === census);

// ------------------------------------------------------------------ rate rules

export const ovKey = (group: string, plan: string, census: string): string =>
  group + "||" + plan + "||" + census;

/** A hand-keyed override for one tier, or null when none is set. */
export function override(
  overrides: Overrides,
  g: Group,
  plan: string,
  census: string,
): number | null {
  const v = overrides[ovKey(g.name, plan, census)];
  if (v === "" || v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : null;
}

/**
 * Employee-only rate: billed if present, otherwise the average of the bases
 * implied by every billed tier. Averaging keeps this order-independent — an
 * earlier version depended on which tier happened to be visited first.
 */
export function baseRate(overrides: Overrides, g: Group, plan: string): number | null {
  const r = (g.rates || {})[plan] || {};
  const ovEE = override(overrides, g, plan, "Employee");
  if (ovEE != null) return ovEE;
  if (r["Employee"] != null) return r["Employee"];
  const implied = TIERS.map((t) => {
    const ov = override(overrides, g, plan, t.census);
    const v = ov != null ? ov : r[t.census];
    return v != null ? v / FACTORS[t.key] : null;
  }).filter((v): v is number => v != null);
  if (!implied.length) return null;
  return implied.reduce((a, b) => a + b, 0) / implied.length;
}

export interface RateResult {
  rate: number | null;
  derived: boolean;
  manual?: boolean;
}

export function rateFor(
  overrides: Overrides,
  g: Group,
  plan: string,
  tierKey: TierKey,
): RateResult {
  const r = (g.rates || {})[plan] || {};
  const t = tierByKey(tierKey);
  const ov = override(overrides, g, plan, t.census);
  if (ov != null) return { rate: ov, derived: false, manual: true };
  if (r[t.census] != null) return { rate: r[t.census], derived: false };
  const base = baseRate(overrides, g, plan);
  if (base == null) return { rate: null, derived: true };
  return { rate: +(base * FACTORS[tierKey]).toFixed(2), derived: true };
}

/**
 * Whether the program tier factors reconcile for this plan.
 *
 * Compares the bases IMPLIED by each billed tier against each other, on a 0.5%
 * relative tolerance. Testing each tier against their average instead would
 * halve a single deviating tier and hide genuinely off-schedule plans.
 */
export function factorsHold(overrides: Overrides, g: Group, plan: string): boolean {
  const r = (g.rates || {})[plan] || {};
  const implied = TIERS.map((t) => {
    const ov = override(overrides, g, plan, t.census);
    const v = ov != null ? ov : r[t.census];
    return v != null ? v / FACTORS[t.key] : null;
  }).filter((v): v is number => v != null);
  if (!implied.length) return false;
  const lo = Math.min(...implied);
  const hi = Math.max(...implied);
  return (hi - lo) / lo < 0.005;
}

// ----------------------------------------------------------- employer/employee

export function hasActualSplit(data: KennionData, g: Group): boolean {
  return !!(data.splits || {})[g.name];
}

export function splitSource(data: KennionData, g: Group): string | null {
  return ((data.splits || {})[g.name] || {}).source || null;
}

function actualSplit(
  data: KennionData,
  g: Group,
  plan: string,
  tierKey: TierKey,
): SplitAmounts | null {
  const sp = ((data.splits || {})[g.name] || {}).plans;
  if (!sp) return null;
  return (sp[plan] || {})[tierByKey(tierKey).census] || null;
}

export interface Split {
  rate: number | null;
  er: number | null;
  ee: number | null;
  actual: boolean;
}

/**
 * Employer/employee split for one tier.
 *
 * Where Employee Navigator carries the real configured split it is used exactly
 * and is not adjustable — it is payroll configuration, not something to model.
 * Groups whose EN export has not been loaded fall back to the placeholder
 * percentages, and the UI labels that clearly as pending.
 */
export function split(
  data: KennionData,
  overrides: Overrides,
  g: Group,
  plan: string,
  tierKey: TierKey,
  eePct: number,
  depPct: number,
): Split {
  const { rate } = rateFor(overrides, g, plan, tierKey);
  if (rate == null) return { er: null, ee: null, rate: null, actual: false };

  const a = actualSplit(data, g, plan, tierKey);
  if (a) {
    const share = a.total ? a.er / a.total : 0;
    const er = +(rate * share).toFixed(2);
    return { rate, er, ee: +(rate - er).toFixed(2), actual: true };
  }

  const eeOnly = rateFor(overrides, g, plan, "EE").rate ?? rate;
  const dep = Math.max(0, rate - eeOnly);
  const er = +((eeOnly * eePct) / 100 + (dep * depPct) / 100).toFixed(2);
  return { rate, er, ee: +(rate - er).toFixed(2), actual: false };
}

export interface PlanRow {
  p: GroupPlan;
  counts: Record<TierKey, number>;
  er: number;
  ee: number;
  total: number;
}

/** Per-plan enrollment counts and money, summed over tiers that have members. */
export function planRows(
  data: KennionData,
  overrides: Overrides,
  g: Group,
  eePct: number,
  depPct: number,
): PlanRow[] {
  return (g.plans || []).map((p) => {
    const counts = planCounts(g, p.plan);
    let er = 0;
    let ee = 0;
    let total = 0;
    TIERS.forEach((t) => {
      const s = split(data, overrides, g, p.plan, t.key, eePct, depPct);
      if (counts[t.key] && s.rate != null) {
        er += s.er! * counts[t.key];
        ee += s.ee! * counts[t.key];
        total += s.rate * counts[t.key];
      }
    });
    return { p, counts, er, ee, total };
  });
}

export function planDesign(
  data: KennionData,
  planName: string,
): Record<string, string> | null {
  const pd = data.planDesigns || {};
  const key = Object.keys(pd).find((k) => planName && planName.indexOf(k) !== -1);
  return key ? pd[key] : null;
}

export function censusCounts(g: Group): Record<TierKey, number> {
  // Tier counts come from the server; the census they were counted from never
  // leaves it. An admin session still holds members, so fall back to those.
  if (g.tiers) return { EE: g.tiers.EE || 0, ES: g.tiers.ES || 0, EC: g.tiers.EC || 0, FAM: g.tiers.FAM || 0 };
  const c: Record<TierKey, number> = { EE: 0, ES: 0, EC: 0, FAM: 0 };
  (g.members || []).forEach((m) => {
    const t = tierByCensus(m.tier);
    if (t) c[t.key]++;
  });
  return c;
}

/** One plan's enrolled counts by tier. */
export function planCounts(g: Group, plan: string): Record<TierKey, number> {
  const fromServer = g.planTiers?.[plan];
  if (fromServer) return { EE: fromServer.EE || 0, ES: fromServer.ES || 0, EC: fromServer.EC || 0, FAM: fromServer.FAM || 0 };
  const c: Record<TierKey, number> = { EE: 0, ES: 0, EC: 0, FAM: 0 };
  (g.members || [])
    .filter((m) => m.plan === plan)
    .forEach((m) => {
      const t = tierByCensus(m.tier);
      if (t) c[t.key]++;
    });
  return c;
}

// ------------------------------------------------------------ 2027 market menu

export interface MarketPlan {
  carrier: string;
  label: string;
  plan: string;
  type: string;
  ded: number | string | null;
  oop: number | null;
  copays: string;
  rx: string;
  network: string;
  rates: Record<TierKey, number | null>;
  monthly: number | null;
  /** Rate scaled from comparable groups rather than quoted for this one. */
  indicative: boolean;
  /** Carrier has not returned rates at all. */
  pending?: boolean;
  /** Read off a proposal the carrier sent for this group. */
  quoted?: { slot: string; date: string | null; proposalId: number };
}

/** The four proposal slots a group's 2027 options are built from, in the order they are shown. */
export const PROPOSAL_SLOTS = ["UHC Fully Insured", "UHC Level Funded", "Gravie", "Nationwide", "Angle", "Cobalt"];

/** "$1,500" / "1500.00" / "$1,500 individual" → 1500; anything unreadable → null. */
export function moneyNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /-?\$?\s*([\d,]+(?:\.\d+)?)/.exec(String(v));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const planKey = (s: string) => s.toLowerCase().replace(/\b(plan|option|uhc|unitedhealthcare|surest|gravie|nationwide)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** How a proposal slot is shown: the carrier column and the funding label. */
function slotPresentation(slot: string, carrier: string | null, planType: string | null): { carrier: string; label: string; network: string } {
  if (slot === "UHC Fully Insured") return { carrier: "UnitedHealthcare", label: "Fully Insured", network: "UHC Choice Plus" };
  if (slot === "UHC Level Funded") return { carrier: "UnitedHealthcare", label: "Level Funded", network: "UHC Choice Plus" };
  if (slot === "Surest") return { carrier: "Surest (UnitedHealthcare)", label: "Copay-only", network: "UHC Choice Plus" };
  if (slot === "Gravie") return { carrier: "Gravie", label: planType || "Level Funded", network: "Gravie / Aetna" };
  if (slot === "Nationwide") return { carrier: "Nationwide", label: planType || "Level Funded", network: "Nationwide" };
  if (slot === "Angle") return { carrier: "Angle Health", label: planType || "Level Funded", network: "Angle / Cigna PPO" };
  if (slot === "Cobalt") return { carrier: "Cobalt", label: planType || "Self Funded", network: "On the proposal" };
  return { carrier: carrier || "Other", label: planType || "Quoted", network: "On the proposal" };
}

/**
 * The plans on a group's proposals, priced at its census. A plan with no rate
 * on any tier is left out; one missing a tier that has people in it has no
 * monthly figure.
 */
export function proposalPlans(data: KennionData, g: Group): MarketPlan[] {
  const counts = censusCounts(g);
  const out: MarketPlan[] = [];
  for (const pr of data.proposals || []) {
    for (const pl of pr.plans || []) {
      const rates = {} as Record<TierKey, number | null>;
      TIERS.forEach((t) => {
        const v = pl.rates?.[t.key];
        rates[t.key] = v == null ? null : v;
      });
      if (!TIERS.some((t) => rates[t.key] != null)) continue;
      let monthly: number | null = 0;
      TIERS.forEach((t) => {
        if (!counts[t.key]) return;
        const v = rates[t.key];
        if (v == null) monthly = null;
        else if (monthly != null) monthly += v * counts[t.key];
      });
      const show = slotPresentation(pr.slot, pr.carrier, pl.planType);
      out.push({
        carrier: show.carrier,
        label: show.label,
        plan: pl.name,
        type: pl.planType || show.label,
        ded: moneyNum(pl.deductible) ?? pl.deductible ?? null,
        oop: moneyNum(pl.oopMax),
        copays: "On the proposal",
        rx: "On the proposal",
        network: pl.network || show.network,
        rates,
        monthly,
        indicative: false,
        quoted: { slot: pr.slot, date: pr.effectiveDate || pr.uploadedAt.slice(0, 10), proposalId: pr.id },
      });
    }
  }
  return out;
}

function uhcRows(data: KennionData, g: Group): DetailRow[] {
  const det = (data.uhc || {}).detail || {};
  return det[g.name] || det[g.name.replace(/,? (Inc|LLC)\.?$/i, "")] || [];
}

export function hasDirectQuote(data: KennionData, g: Group): boolean {
  return uhcRows(data, g).some((r) => r.uhcRate);
}

/**
 * Ratio between this group's rate level and the menu's reference rates, used to
 * scale un-quoted plans. Falls back to a benchmark against the first quoted
 * group when UHC has not underwritten this group at all.
 */
function groupFactor(data: KennionData, g: Group): number | null {
  const rows = uhcRows(data, g);
  const menu = (data.uhc || {}).menu || [];
  const eeRows = rows.filter((r) => r.tier === "EE" && r.uhcRate);
  if (eeRows.length) {
    let num = 0;
    let den = 0;
    eeRows.forEach((r) => {
      const m = menu.find((x) => x.plan === r.uhcPlan);
      if (m && m.refRate) {
        num += r.uhcRate!;
        den += m.refRate;
      }
    });
    if (den) return num / den;
  }
  return benchmarkFactor(data, g);
}

function benchmarkFactor(data: KennionData, g: Group): number | null {
  // The server sends this as a single number, so a group's payload carries no
  // other company's rows. An admin session still has the detail to work from.
  const det = (data.uhc || {}).detail || {};
  const refName = Object.keys(det).find((n) => n !== g.name);
  let refAvg = data.uhc?.refEE ?? null;
  if (refAvg == null && refName) {
    const refEE = det[refName].filter((r) => r.tier === "EE" && r.currentRate);
    if (refEE.length) refAvg = refEE.reduce((a, r) => a + r.currentRate!, 0) / refEE.length;
  }
  if (refAvg == null) return null;
  const own = Object.values(g.rates || {})
    .map((r) => r["Employee"])
    .filter((v) => v != null);
  if (!own.length || !refAvg) return null;
  return own.reduce((a, b) => a + b, 0) / own.length / refAvg;
}

function tierFactors(data: KennionData, g: Group): Record<TierKey, number> {
  const rows = uhcRows(data, g);
  const f = {} as Record<TierKey, number>;
  (["ES", "EC", "FAM"] as TierKey[]).forEach((k) => {
    const pairs = rows.filter((r) => r.tier === k && r.uhcRate);
    const bases = rows.filter((r) => r.tier === "EE" && r.uhcRate);
    if (pairs.length && bases.length) {
      f[k] =
        pairs.reduce((a, r) => a + r.uhcRate!, 0) /
        pairs.length /
        (bases.reduce((a, r) => a + r.uhcRate!, 0) / bases.length);
    } else {
      f[k] = FACTORS[k];
    }
  });
  f.EE = 1;
  return f;
}

/** The full 2027 menu priced at this group's own census. */
export function marketPlans(data: KennionData, g: Group): MarketPlan[] {
  const u = data.uhc || {};
  const menu = u.menu || [];
  const gf = groupFactor(data, g);
  const tf = tierFactors(data, g);
  const counts = censusCounts(g);

  const quoted: Record<string, Partial<Record<TierKey, number>>> = {};
  uhcRows(data, g).forEach((r) => {
    if (!r.uhcRate) return;
    quoted[r.uhcPlan] = quoted[r.uhcPlan] || {};
    quoted[r.uhcPlan][r.tier] = r.uhcRate;
  });

  const out: MarketPlan[] = menu.map((m) => {
    const q = quoted[m.plan] || {};
    const baseEE = q.EE != null ? q.EE : gf && m.refRate ? +(m.refRate * gf).toFixed(2) : null;
    const rates = {} as Record<TierKey, number | null>;
    TIERS.forEach((t) => {
      rates[t.key] =
        q[t.key] != null ? q[t.key]! : baseEE != null ? +(baseEE * tf[t.key]).toFixed(2) : null;
    });
    let monthly = 0;
    TIERS.forEach((t) => {
      const v = rates[t.key];
      if (v != null) monthly += v * counts[t.key];
    });
    return {
      carrier: "UnitedHealthcare",
      label: "Level Funded",
      plan: m.plan,
      type: m.type,
      ded: m.ded,
      oop: m.oop,
      copays: m.copays,
      rx: (m.rx || "").replace(/,.*$/, ""),
      network: m.type === "EPO" ? "UHC Choice" : "UHC Choice Plus",
      rates,
      monthly: baseEE != null ? monthly : null,
      indicative: q.EE == null,
    };
  });

  // Surest was quoted only where UHC included it; Gravie has not returned rates.
  const surestQuoted = /Ecological/i.test(g.name);
  const sRates: Record<TierKey, number | null> = surestQuoted
    ? { EE: 476.32, ES: 1152.69, EC: 862.14, FAM: 1586.15 }
    : { EE: null, ES: null, EC: null, FAM: null };
  let sMonthly: number | null = null;
  if (surestQuoted) {
    sMonthly = 0;
    TIERS.forEach((t) => {
      sMonthly! += sRates[t.key]! * counts[t.key];
    });
  }
  out.unshift({
    carrier: "Surest (UnitedHealthcare)",
    label: "Copay-only",
    plan: "Surest Copay Plan",
    type: "Copay",
    ded: 0,
    oop: 8000,
    copays: "Priced per service",
    rx: "Copay by drug",
    network: "UHC Choice Plus",
    rates: sRates,
    monthly: sMonthly,
    indicative: false,
    pending: !surestQuoted,
  });
  out.unshift({
    carrier: "Gravie",
    label: "Comfort",
    plan: "Gravie Comfort",
    type: "Level Funded",
    ded: 0,
    oop: null,
    copays: "$0 on most services",
    rx: "Included on preventive+",
    network: "Gravie / Aetna",
    rates: { EE: null, ES: null, EC: null, FAM: null },
    monthly: null,
    indicative: false,
    pending: true,
  });

  // Proposals the carriers actually sent for this group come first and win:
  // a placeholder for a carrier that has now quoted goes, and a menu plan the
  // proposal also prices is shown at the proposal's rates.
  const fromProposals = proposalPlans(data, g);
  if (fromProposals.length) {
    const quotedCarriers = new Set(fromProposals.map((p) => p.carrier));
    const quotedPlans = new Set(fromProposals.map((p) => planKey(p.plan)));
    const rest = out.filter((p) => !(p.pending && quotedCarriers.has(p.carrier)) && !quotedPlans.has(planKey(p.plan)));
    return [...fromProposals, ...rest];
  }
  return out;
}

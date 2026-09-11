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

/**
 * The two third-party administrators the program runs on. A plan on anything
 * else is not Kennion's to rate-administer, so it is not on the Rates page and
 * not in the audit workbook — one rule, read by both, so they cannot disagree.
 */
export const PROGRAM_TPAS = ["EBPA", "HealthEZ"];

const tpaOf = (g: Group, plan: GroupPlan) => String(plan.tpa || g.tpa || "").trim();

/** Is this plan on a program TPA? Matched without case, which imports vary on. */
export function isProgramPlan(g: Group, plan: GroupPlan): boolean {
  const t = tpaOf(g, plan).toLowerCase();
  return PROGRAM_TPAS.some((p) => p.toLowerCase() === t);
}

/** A group's program plans, in the order they came in. */
export function programPlans(g: Group): GroupPlan[] {
  return (g.plans || []).filter((p) => isProgramPlan(g, p));
}

/**
 * In program factor order — 1.00, 1.85, 2.00, 2.85 — so a row of rates always
 * climbs left to right and a tier out of step is obvious at a glance. Nothing
 * reads this list by position, so the order is presentation only.
 */
export const TIERS: Tier[] = [
  { key: "EE", label: "Employee", census: "Employee", short: "EE" },
  { key: "EC", label: "Employee + Child(ren)", census: "Employee + Child(ren)", short: "EC" },
  { key: "ES", label: "Employee + Spouse", census: "Employee + Spouse", short: "ES" },
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
  /**
   * Active employees on the census as of the last import, whether or not
   * they took medical. Absent on a group imported before this field
   * existed.
   */
  medicalEligible?: number;
  lives: number;
  tiers?: Record<TierKey, number>;
  monthly?: number;
  annual?: number;
  plans?: GroupPlan[];
  members?: Member[];
  rates?: Record<string, Record<string, number>>;
  /** Which account manager holds the group. Staff payloads only. */
  manager?: string | null;
  /** Derived at load time from the group name. */
  code: string;
  /**
   * Dental, vision, life, disability … — every benefit besides medical.
   * Present only once an Employee Navigator export has been read for
   * supplemental lines; `linesLoaded` says whether it has been.
   */
  lines?: SupplementalLine[];
  linesLoaded?: boolean;
  supplementalMonthly?: number;
}

/**
 * ACA's small/large group line: 2-50 employees is small, 51+ is large. Off
 * the group's own headcount (active employees on the census, whether or not
 * they took medical) rather than just who is medically enrolled. Null when
 * there is no headcount to go on.
 */
export function groupSizeLabel(g: Group): string | null {
  const n = g.medicalEligible ?? g.enrolled;
  if (!n || n < 1) return null;
  return n <= 50 ? "Small Group 2-50" : "Large Group 51+";
}

/** One supplemental benefit in force: no member detail, group totals only. */
export interface SupplementalLine {
  benefit: string;
  carrier: string;
  plan: string;
  enrolled: number;
  monthly: number;
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
  /** In-network member cost per service, as printed; null until the reader has seen the document. */
  benefits?: PlanBenefits | null;
  rates: Record<TierKey, number | null>;
  monthlyTotal: number | null;
}

export interface PlanBenefits {
  doctorVisit: string | null;
  specialist: string | null;
  imaging: string | null;
  urgentCare: string | null;
  hospital: string | null;
  rx: string | null;
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
  /** The signed-in group's own invoice on file, if any (group sessions only). */
  invoice?: {
    month: string | null;
    filename: string;
    uploadedAt: string;
    /** The invoice's Charge Summary rows: product, coverage tier and headcount. */
    products?: { product: string; coverage: string; count: number | null }[];
  } | null;
  /** Who at Kennion looks after this group (group sessions only). */
  accountManager?: AccountManager | null;
  /** This group's most recent Sign Up submission, if it has ever sent one. */
  signup?: GroupSignup | null;
}

/** What a group most recently submitted on its own Sign Up page. */
export interface GroupSignup {
  plans: string[];
  note: string | null;
  submittedAt: string;
}

/** The Kennion contact shown on a client's pages. */
export interface AccountManager {
  name: string;
  title?: string;
  phone?: string;
  email?: string;
  calendly?: string;
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

/** What the employer puts toward one tier, on average per enrolled member. */
export interface TierContribution {
  key: TierKey;
  label: string;
  count: number;
  /** Null when nobody in this tier has a priced plan to average from. */
  er: number | null;
  ee: number | null;
  /** True only when every member counted here came off a real Employee Navigator split — not the placeholder estimate. */
  actual: boolean;
}

/**
 * The employer's contribution today, one figure per tier rather than one per
 * plan — what "Employee Only", "Employee + Spouse", etc. actually cost the
 * company on average, blended across however many plans a group runs. This is
 * the number a group already spends, read off its own current rates and
 * enrollment; New 2027 Medical Options starts an employer's own contribution
 * choice from here rather than from zero.
 */
export function contributionByTier(
  data: KennionData,
  overrides: Overrides,
  g: Group,
  eePct: number,
  depPct: number,
): TierContribution[] {
  return TIERS.map((t) => {
    let count = 0;
    let erSum = 0;
    let eeSum = 0;
    let allActual = true;
    let any = false;
    (g.plans || []).forEach((p) => {
      const n = planCounts(g, p.plan)[t.key];
      if (!n) return;
      const s = split(data, overrides, g, p.plan, t.key, eePct, depPct);
      if (s.rate == null) return;
      any = true;
      count += n;
      erSum += (s.er ?? 0) * n;
      eeSum += (s.ee ?? 0) * n;
      if (!s.actual) allActual = false;
    });
    return {
      key: t.key,
      label: t.label,
      count,
      er: count ? +(erSum / count).toFixed(2) : null,
      ee: count ? +(eeSum / count).toFixed(2) : null,
      actual: any && allActual,
    };
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
  /** Further in-network benefits where the carrier gave them; null where it did not. */
  coins?: string | null;
  uc?: string | null;
  er?: string | null;
  /** Labs, X-ray and advanced imaging. */
  imaging?: string | null;
  hospital?: string | null;
  /** Doctor (primary care) and specialist visits, split out of `copays`. */
  pcp?: string | null;
  specialist?: string | null;
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
  if (slot === "UHC Fully Insured") return { carrier: "UnitedHealthcare", label: "Fully Insured", network: "United Choice Plus" };
  if (slot === "UHC Level Funded") return { carrier: "UnitedHealthcare", label: "Level Funded", network: "United Choice Plus" };
  if (slot === "Surest") return { carrier: "Surest (UnitedHealthcare)", label: "Copay-only", network: "United Choice Plus" };
  if (slot === "Gravie") return { carrier: "Gravie", label: planType || "Level Funded", network: "Cigna OAP" };
  if (slot === "Nationwide") return { carrier: "Nationwide", label: planType || "Level Funded", network: "Nationwide" };
  if (slot === "Angle") return { carrier: "Angle Health", label: planType || "Level Funded", network: "Angle / Cigna PPO" };
  if (slot === "Cobalt") return { carrier: "Cobalt", label: planType || "Self Funded", network: "On the proposal" };
  return { carrier: carrier || "Other", label: planType || "Quoted", network: "On the proposal" };
}

/**
 * Every Gravie plan is on the Cigna OAP network and every UnitedHealthcare
 * plan (Fully Insured, Level Funded, or Surest) is on the United Choice Plus
 * network — a fixed rule, not something a carrier's own proposal document
 * gets to override with a differently-worded network name.
 */
const FIXED_NETWORK_SLOTS = new Set(["UHC Fully Insured", "UHC Level Funded", "Surest", "Gravie"]);

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
      // Gravie's benefits are by plan family and the same for every group.
      const fam = pr.slot === "Gravie" ? gravieFamily(pl.planType, pl.name) : null;
      const gb = fam ? GRAVIE_BENEFITS[fam] : null;
      const pb = pl.benefits || null;
      out.push({
        carrier: show.carrier,
        label: show.label,
        plan: pl.name,
        type: pl.planType || show.label,
        ded: moneyNum(pl.deductible) ?? pl.deductible ?? null,
        oop: moneyNum(pl.oopMax),
        copays: gb ? `${gb.pcp} / ${gb.specialist}` : pb?.doctorVisit || pb?.specialist ? `${pb.doctorVisit ?? "—"} / ${pb.specialist ?? "—"}` : "On the proposal",
        rx: gb ? `${gb.rxGeneric} generic · ${gb.rxPreferredBrand} preferred brand · ${gb.rxNonPreferredBrand} non-preferred` : pb?.rx || "On the proposal",
        coins: null,
        pcp: gb ? gb.pcp : pb?.doctorVisit ?? null,
        specialist: gb ? gb.specialist : pb?.specialist ?? null,
        uc: gb ? gb.uc : pb?.urgentCare ?? null,
        er: gb ? gb.er : null,
        imaging: gb ? (gb.basicLabs === gb.advancedLabs ? gb.basicLabs : `${gb.basicLabs} basic · ${gb.advancedLabs} advanced`) : pb?.imaging ?? null,
        hospital: gb ? gb.hospital : pb?.hospital ?? null,
        network: FIXED_NETWORK_SLOTS.has(pr.slot) ? show.network : pl.network || show.network,
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

/** "$40 / $100" → doctor visit and specialist copays. */
export function splitCopays(copays: string | null | undefined): [string | null, string | null] {
  const parts = (copays || "").split("/").map((x) => x.trim()).filter(Boolean);
  if (!parts.length || !/\d/.test(parts[0])) return [null, null];
  return [parts[0], parts[1] ?? null];
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
      pcp: splitCopays(m.copays)[0],
      specialist: splitCopays(m.copays)[1],
      rx: (m.rx || "").replace(/,.*$/, ""),
      coins: m.coins ?? null,
      uc: m.uc ?? null,
      er: m.er ?? null,
      network: "United Choice Plus",
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
    network: "United Choice Plus",
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
    network: "Cigna OAP",
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

/** The headline comparison — today's total against 2027, plans mapped 1-for-1 — reused wherever the site needs it in one line rather than the full grid. */
export interface MarketSummary {
  todayTotal: number;
  /** Null while every plan a group's members are on is still unpriced. */
  mappedTotal: number | null;
  delta: number | null;
  /** Whether UnitedHealthcare has underwritten this group directly, or the figures above are indicative. */
  direct: boolean;
  /** How many 2027 options carry a real price at this group's census. */
  pricedCount: number;
}

/**
 * The same "today vs. 2027, mapped 1-for-1" figure Options.tsx builds for its
 * own summary card, factored out so a page that only needs the headline number
 * — not the whole grid — does not have to recompute it by hand and risk it
 * drifting out of step with the grid's own math.
 */
export function marketSummary(data: KennionData, g: Group, rows: PlanRow[], todayTotal: number): MarketSummary {
  const plans = marketPlans(data, g);
  const mapping = (data.uhc || {}).mapping || [];
  let sum = 0;
  let any = false;
  rows.forEach((r) => {
    const mp = mapping.find((m) => m.currentPlan && r.p.plan.indexOf(m.currentPlan) !== -1);
    if (!mp) return;
    const p = plans.find((x) => x.plan === mp.uhcPlan);
    if (!p) return;
    TIERS.forEach((t) => {
      const v = p.rates[t.key];
      if (v != null) {
        sum += v * r.counts[t.key];
        any = true;
      }
    });
  });
  const mappedTotal = any ? sum : null;
  return {
    todayTotal,
    mappedTotal,
    delta: mappedTotal == null ? null : mappedTotal - todayTotal,
    direct: hasDirectQuote(data, g),
    pricedCount: plans.filter((p) => p.monthly != null).length,
  };
}

/**
 * A flat-dollar defined contribution, the way Employee Navigator sets one
 * up: the employer puts the same amount toward a tier whatever plan the
 * employee picks, and the employee pays the rest. `over` marks a plan that
 * costs less than the contribution for this tier — the employer would pay
 * only the premium there, and the employee nothing.
 */
export function tierSplit(
  p: MarketPlan,
  contribution: Record<TierKey, number>,
  t: TierKey,
): { rate: number; er: number; ee: number } | null {
  const rate = p.rates[t];
  if (rate == null) return null;
  // The employer pays its contribution, never more than the premium: on a
  // plan cheaper than the allowance the employer cost is the premium itself.
  const er = Math.min(Math.max(contribution[t] || 0, 0), rate);
  return { rate, er: +er.toFixed(2), ee: +(rate - er).toFixed(2) };
}

/**
 * A plan's monthly split at the employer's contribution: the contribution
 * times headcount in every tier — the same figure on every plan — and what
 * employees pay between them. Null when no enrolled tier has a rate.
 */
export function costSplit(
  p: MarketPlan,
  contribution: Record<TierKey, number>,
  counts: Record<TierKey, number>,
): { er: number; ee: number; total: number } | null {
  let er = 0;
  let ee = 0;
  let total = 0;
  let any = false;
  for (const t of TIERS) {
    const n = counts[t.key] || 0;
    const s = tierSplit(p, contribution, t.key);
    if (!n || !s) continue;
    any = true;
    er += s.er * n;
    ee += s.ee * n;
    total += s.rate * n;
  }
  return any ? { er: +er.toFixed(2), ee: +ee.toFixed(2), total: +total.toFixed(2) } : null;
}

// ---- Gravie benefits by plan family -------------------------------------
// (Kept in this file rather than its own module so the model stays runnable
// under node --experimental-strip-types for scripts/test-market-plans.mts.)
/**
 * Gravie's benefits by plan family — the static "Benefits Grid" sheet that
 * is the same in every rate workbook, transcribed once. A plan's family
 * (Comfort, ComfortFit, Copay, QHDHP, HDHP) is in its name and plan type;
 * its deductible and out-of-pocket max are on the rate row. In-network
 * benefits; EPO versions cover nothing out of network. Teladoc visits are
 * free on QHDHP, Copay, Comfort and ComfortFit plans.
 */
export interface GravieBenefits {
  preventive: string;
  pcp: string;
  specialist: string;
  uc: string;
  er: string;
  basicLabs: string;
  advancedLabs: string;
  hospital: string;
  rxGeneric: string;
  rxPreferredBrand: string;
  rxNonPreferredBrand: string;
  rxNonPreferredSpecialty: string;
}

export type GravieFamily = "Comfort" | "ComfortFit" | "Copay" | "QHDHP" | "HDHP";

const COINS = "0–20% coins after ded";

export const GRAVIE_BENEFITS: Record<GravieFamily, GravieBenefits> = {
  Comfort: {
    preventive: "No cost",
    pcp: "No cost",
    specialist: "No cost",
    uc: "No cost",
    er: "$500 copay",
    basicLabs: "No cost",
    advancedLabs: "No cost",
    hospital: "No cost after OOPM",
    rxGeneric: "No cost",
    rxPreferredBrand: "$75 copay",
    rxNonPreferredBrand: "$100 copay",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOn; otherwise $250 copay",
  },
  ComfortFit: {
    preventive: "No cost",
    pcp: "No cost",
    specialist: "No cost",
    uc: "No cost",
    er: "$950 copay",
    basicLabs: "No cost",
    advancedLabs: "No cost after OOPM",
    hospital: "No cost after OOPM",
    rxGeneric: "No cost",
    rxPreferredBrand: "$75 copay",
    rxNonPreferredBrand: "$150 copay",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOn; otherwise $500 copay",
  },
  Copay: {
    preventive: "No cost",
    pcp: "No cost through Teladoc; otherwise $25 copay",
    specialist: "$75 copay",
    uc: "No cost through Teladoc; otherwise $75 copay",
    er: "$500 copay",
    basicLabs: COINS,
    advancedLabs: COINS,
    hospital: "0–30% coins after ded",
    rxGeneric: "$10 copay",
    rxPreferredBrand: "$50 copay",
    rxNonPreferredBrand: "$125 copay",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOn; otherwise $350 copay",
  },
  QHDHP: {
    preventive: "No cost",
    pcp: `No cost through Teladoc; otherwise ${COINS}`,
    specialist: COINS,
    uc: `No cost through Teladoc; otherwise ${COINS}`,
    er: COINS,
    basicLabs: COINS,
    advancedLabs: COINS,
    hospital: COINS,
    rxGeneric: COINS,
    rxPreferredBrand: COINS,
    rxNonPreferredBrand: "0–50% coins after ded",
    rxNonPreferredSpecialty: COINS,
  },
  HDHP: {
    preventive: "No cost",
    pcp: "No cost after ded",
    specialist: "No cost after ded",
    uc: "No cost after ded",
    er: "No cost after ded",
    basicLabs: "No cost after ded",
    advancedLabs: "No cost after ded",
    hospital: "No cost after ded",
    rxGeneric: "No cost after ded",
    rxPreferredBrand: "No cost after ded",
    rxNonPreferredBrand: "No cost after ded",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOnSP; otherwise no cost after ded",
  },
};

export const GRAVIE_BENEFIT_NOTES = [
  "In-network benefits. EPO versions of Gravie plans do not cover out-of-network services.",
  "Teladoc visits are free on QHDHP, Copay, Comfort and ComfortFit plans.",
];

/** The family a Gravie plan belongs to, from its plan type or, failing that, its name. */
export function gravieFamily(planType: string | null | undefined, name: string): GravieFamily | null {
  const t = `${planType || ""} ${name}`;
  if (/\bQHDHP\b/i.test(t)) return "QHDHP";
  if (/\bHDHP\b/i.test(t)) return "HDHP";
  if (/Comfort\s?Fit/i.test(t)) return "ComfortFit";
  if (/\bComfort\b/i.test(t)) return "Comfort";
  if (/\bCopay\b/i.test(t)) return "Copay";
  return null;
}

// Domain model for the Kennion 2027 renewal portal.
//
// Ported from the Claude Design prototype. The rate rules below are the ones
// the design iterated to and are load-bearing for every figure on the page:
//
// - A tier rate is BILLED when Employee Navigator has a premium for it. That
//    only happens when someone is actually enrolled in that tier.
// - A tier with nobody in it has no billed rate anywhere, so it is CALCULATED
//    at the program tier factors (EE 1.00 / EE+SP 2.00 / EE+CH 1.85 /
//    EE+Family 2.85). These reconcile to 161 of 165 billed rates in the export.
// - Calculated tiers are labelled "calc." and never contribute to a total,
//    because no one is enrolled in them.
// - A hand-keyed rate from a carrier sheet (MANUAL) beats both.

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
 * not in the audit workbook - one rule, read by both, so they cannot disagree.
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
 * In program factor order - 1.00, 1.85, 2.00, 2.85 - so a row of rates always
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
  /** The plan as the portal files it: Employee Navigator's name with the trailing year dropped. */
  plan: string;
  /** The full name as Employee Navigator spells it, year and all. Absent on the shipped census. */
  enName?: string;
  /** The carrier or administrator, as Employee Navigator's plan catalog names it. */
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
  /** Whether the group is renewing prior coverage or enrolling for the first time. Defaults to "existing" when unset. */
  groupStatus?: "new" | "existing";
  /** The date this group's elections take effect, as "YYYY-MM-DD"; falls back to the system default when unset. */
  effectiveDate?: string;
  /** How the group's name reads on its own pages, when staff set one on the Welcome Page tab. Copy only; `name` stays the official key. */
  displayName?: string | null;
  /** How the effective date reads on the group's pages, when staff set one. Copy only; `effectiveDate` stays the official date. */
  effectiveDateLabel?: string | null;
  /** The Welcome page's words for this group's status, from the admin Welcome Page tab. */
  welcome?: WelcomeCopy;
  tpa: string;
  enrolled: number;
  /**
   * The ACA size bucket staff set for the group (or the default from its
   * enrolled count): the one figure the Group Size badge reads.
   */
  sizeCategory?: "2-50" | "51+";
  lives: number;
  tiers?: Record<TierKey, number>;
  monthly?: number;
  annual?: number;
  plans?: GroupPlan[];
  members?: Member[];
  /** The census as aggregates, from the server: what the assistant's picks are weighed on. */
  census?: ServerCensus | null;
  rates?: Record<string, Record<string, number>>;
  /** Which account manager holds the group. Staff payloads only. */
  manager?: string | null;
  /** Derived at load time from the group name. */
  code: string;
  /**
   * Dental, vision, life, disability … - every benefit besides medical.
   * Present only once an Employee Navigator export has been read for
   * supplemental lines; `linesLoaded` says whether it has been.
   */
  lines?: SupplementalLine[];
  linesLoaded?: boolean;
  supplementalMonthly?: number;
}

/**
 * ACA's small/large group line: 2-50 employees is small, 51+ is large. Reads
 * the size category staff keep on the company page - the same one Rate
 * Administration shows - so the client and the admin never disagree. It
 * used to be derived from the Employee Navigator roster count, which counts
 * everyone not marked terminated and put small groups over the line. Null
 * when no category is on file.
 */
/**
 * What the Group Size badge says on hover: where the size comes from, what
 * applies at that size, and who helps. General information, one note per
 * category; it never says a contribution is affordable or compliant, and
 * the page makes no such determination. Kennion is the broker.
 */
/** What every quoted rate is called, on the card, in the files and in the assistant's answers: never a proposal, an offer or a guarantee. */
export const ILLUSTRATIVE_QUOTE = "Illustrative Quote";

/**
 * The notice under every rate the site shows or writes: the page footer,
 * the plan card, the printed proposal, every PDF and workbook. The same
 * text lives in server/disclaimer.js for the server-made files;
 * scripts/test-disclaimer.mjs keeps the two identical.
 */
export const RATE_DISCLAIMER =
  "The above rates and benefits are for general information and discussion purposes only and are not valid unless approved by the Carrier/TPA. This rate quote is not an offer or a guarantee of coverage. The rates quoted are applicable to the plan design selected. Actual costs will vary based on factors such as the case characteristics of the group and/or the employees and dependents to be insured, the insurance plan selected and the start date. Rates are determined by the Carrier/TPA and are not final until the group is enrolled with the Carrier/TPA. A quote is final only when coverage is offered by the Carrier/TPA and final rates have been accepted by, and the initial premium paid by, the group.";

/** The one-line notice under rates on screen, with "View Disclaimers" beside it for the full text. */
export const RATE_NOTICE_SHORT = "Noted rates and benefits are obtained from carrier's available information not specifically provided for this tool, and are for discussion only. All rates are determined by the carrier and are not final until the group is enrolled with the carrier.";

export function groupSizeNote(g: Group): string | null {
  const from = "Group size is based on the enrollment data on file for your group; tell us if your full-time equivalent count differs.";
  const start = "The 50% starting point on the Medical Plans page is the Carrier/TPA's minimum contribution requirement, not an ACA affordability determination.";
  if (g.sizeCategory === "51+")
    return `${from} At 50 or more full-time equivalent employees, the Affordable Care Act's employer mandate applies: an Applicable Large Employer must offer minimum essential coverage that provides minimum value and is affordable to at least 95% of its full-time employees, or face penalties. ${start} The AI Assistant and your Kennion team can help you work through what applies before you decide.`;
  if (g.sizeCategory === "2-50")
    return `${from} Under 50 full-time equivalent employees, the Affordable Care Act's employer mandate does not apply. ${start} If your count is near 50, the AI Assistant and your Kennion team can help you confirm which rules apply.`;
  return null;
}

export function groupSizeLabel(g: Group): string | null {
  if (g.sizeCategory === "51+") return "Large Group 51+";
  if (g.sizeCategory === "2-50") return "Small Group 2-50";
  return null;
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
  /** The short handle everyone uses for the plan - UH3, GR1 - given once and kept. */
  optionId?: string | null;
  /** The canonical carrier identity the server computed (plan code, else exact name on its network): one per carrier plan. */
  identity?: string | null;
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
  /** The carrier's standard design this plan is, from the plan catalogue; absent when the plan is not a catalogue design. */
  design?: PlanDesign | null;
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
  /** Emergency room, as the carrier's proposal prints it. */
  er?: string | null;
  /** In-network coinsurance, as printed ("20%"). */
  coinsurance?: string | null;
  /** Whether the proposal says the plan is HSA-eligible; null when it does not say. */
  hsaEligible?: boolean | null;
}

/** In- and out-of-network figures for one design. */
export interface DesignLimits {
  deductibleIndividual: number | null;
  deductibleFamily: number | null;
  oopMaxIndividual: number | null;
  oopMaxFamily: number | null;
  coinsurance?: number | null;
}

/**
 * A carrier's standard plan design, the same for every group it quotes:
 * the catalogue row the server matched the quoted plan to by its code.
 */
export interface PlanDesign {
  planCode: string;
  planId: string | null;
  family: string | null;
  planYear: number;
  inNetwork: DesignLimits;
  outOfNetwork: DesignLimits;
  deductibleEmbedded: boolean | null;
  /** Every service line the carrier lists, in its order, with the member cost as the card reads it. */
  services: { label: string; costShare: string | null; deductibleApplies: boolean; text: string | null }[];
  /** Whether the carrier's actual Summary of Benefits and Coverage / Summary of Benefits PDF is on file for this design. */
  documents?: { sbc: boolean; sob: boolean } | null;
}

/** "ANG TRAD 5000 7000" -> "ang-trad-5000-7000", matching the server's planCodeSlug. */
const planCodeSlug = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
const carrierDocSlug = (carrier: string) => carrier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The URL for a design's SBC or SOB PDF; null when it is not on file. */
export function planDocumentUrl(carrier: string, d: PlanDesign, kind: "sbc" | "sob"): string | null {
  if (!d.documents || !d.documents[kind]) return null;
  return `/api/carriers/${carrierDocSlug(carrier)}/plan-documents/${planCodeSlug(d.planCode)}/${kind}?year=${d.planYear}`;
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
  /** The two-model check of the stored reading against the document, or null before it has run. */
  audit?: ProposalAudit | null;
  /** True only when the proposal passed the full check - source, extraction, validation, both audits of this exact reading, grid. */
  verified?: boolean;
}

/** Whether the figures read off a proposal were checked against the document, and when. */
export interface ProposalAudit {
  status: "pass" | "issues" | "pending" | "unreadable";
  completedAt: string | null;
}

/** What Employee Navigator billed the group for the month - counts and rates only. */
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
    /** The menu's option numbers for this group, by plan code: {P4000i8021B: "UH12"}. */
    optionIds?: Record<string, string>;
  };
  splits: Record<string, GroupSplit>;
  /** The signed-in group's proposals on file (group sessions only). */
  proposals?: GroupProposal[];
  /** The proposal slots this group has. */
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

/** What the guided Sign Up wizard posts once every step is answered and signed. */
export interface RenewalElectionFields {
  plans: string[];
  /** Up to 3 dental plans, or ["Waive Dental Coverage"]. */
  dental: string[];
  /** Up to 3 vision plans, or ["Waive Vision Coverage"]. */
  vision: string[];
  employerLife: string;
  signerName: string;
  signerTitle: string;
  signerEmail: string;
  signerPhone: string;
  note: string;
  attest: boolean;
}

/** What a group most recently submitted on its own Sign Up page: a plain shortlist send, or the guided wizard's full renewal election. */
export interface GroupSignup {
  plans: string[];
  note: string | null;
  submittedAt: string;
  kind: "shortlist" | "renewal";
  carrier: string | null;
  dental: string[];
  vision: string[];
  employerLife: string | null;
  signerName: string | null;
  signerTitle: string | null;
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
  if (n == null || isNaN(n)) return "-";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function money0(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
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

/** The date almost every group's elections take effect, when a group has none of its own on file. Matches the server's own fallback. */
export const DEFAULT_EFFECTIVE_DATE = "2027-01-01";

/**
 * The Welcome page copy staff write once per status (Existing, New) on the
 * admin Welcome Page tab. Words only: where each step links, the group's
 * name and date, and its team all stay dynamic.
 */
export interface WelcomeCopy {
  headline: string;
  intro: string;
  steps: { title: string; body: string }[];
  closingHeading: string;
  closingBody: string;
  closingTagline: string;
  teamNote: string;
  footer: string;
}

/** The group's name as its own pages show it: staff's display name when set, else the official one. */
export const shownName = (g: Pick<Group, "name" | "displayName">): string => g.displayName || g.name;

/** Remove trailing legal suffixes from a company name for display. */
export function shortName(name: string | null | undefined): string {
  const TRAILING_LEGAL = /[\s,]+(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|l\.?l\.?p\.?|l\.?p\.?|p\.?c\.?|p\.?l\.?l\.?c\.?|plc|p\.?a\.?)$/i;
  let s = String(name || "").trim();
  for (;;) {
    const next = s.replace(TRAILING_LEGAL, "").replace(/[\s,]+$/, "");
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

/** Text split into paragraphs on blank lines. */
export const paragraphsOf = (text: string | null | undefined): string[] =>
  String(text || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);

/**
 * A group's effective date as its pages show it: staff's wording when set on
 * the Welcome Page tab, else "2027-01-01" -> "January 1, 2027", parsed as UTC
 * so the browser's own timezone never shifts the day.
 */
export function effectiveDateLabel(g: Pick<Group, "effectiveDate" | "effectiveDateLabel">): string {
  if (g.effectiveDateLabel) return g.effectiveDateLabel;
  const iso = g.effectiveDate || DEFAULT_EFFECTIVE_DATE;
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Just the year of a group's effective date - "2027". */
export function effectiveYear(g: Pick<Group, "effectiveDate">): string {
  return (g.effectiveDate || DEFAULT_EFFECTIVE_DATE).slice(0, 4);
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
 * implied by every billed tier. Averaging keeps this order-independent - an
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
 * and is not adjustable - it is payroll configuration, not something to model.
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
  /** True only when every member counted here came off a real Employee Navigator split - not the placeholder estimate. */
  actual: boolean;
}

/**
 * The employer's contribution today, one figure per tier rather than one per
 * plan - what "Employee Only", "Employee + Spouse", etc. actually cost the
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
  /** Always false now: every plan shown carries the carrier's own rates for this group. */
  indicative: boolean;
  /** The plan's option ID (UH3, GR1); only a quoted plan has one. */
  optionId?: string | null;
  /** The carrier's standard design, from the plan catalogue, where the quoted plan is one. */
  design?: PlanDesign | null;
  /** Read off a proposal the carrier sent for this group. */
  quoted?: { slot: string; date: string | null; proposalId: number; audit?: ProposalAudit | null };
  /**
   * Set only for an Optimyl plan on a 2-50 enrolled group: the rate shown is
   * preliminary, and firm rates need underwriting Optimyl has not done yet
   * (an IHQ, or ExpressScreen then Optimyl's Short-Form IHQ). Null everywhere
   * else, including Optimyl on a 51+ group, which needs none of this.
   */
  underwritingNote?: string | null;
}

/** The proposal slots a group's 2027 options are built from, in the order they are shown. */
export const PROPOSAL_SLOTS = ["UHC Fully Insured", "UHC Level Funded", "Gravie", "Nationwide", "Angle", "Optimyl"];

/** "$1,500" / "1500.00" / "$1,500 individual" → 1500; anything unreadable → null. */
export function moneyNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /-?\$?\s*([\d,]+(?:\.\d+)?)/.exec(String(v));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * How a proposal slot is shown: the carrier column, the funding label and
 * the network. Funding is one of two things: UnitedHealthcare quotes both
 * fully insured and level funded, in separate slots; every other carrier
 * and partner is level funded. A plan's design family (Traditional, HDHP,
 * Value) is its type, never its funding.
 */
function slotPresentation(slot: string, carrier: string | null): { carrier: string; label: string; network: string } {
  if (slot === "UHC Fully Insured") return { carrier: "UnitedHealthcare", label: "Fully Insured", network: "United Choice Plus" };
  if (slot === "UHC Level Funded") return { carrier: "UnitedHealthcare", label: "Level Funded", network: "United Choice Plus" };
  if (slot === "Surest") return { carrier: "UnitedHealthcare", label: "Level Funded", network: "United Choice Plus" };
  if (slot === "Gravie") return { carrier: "Gravie", label: "Level Funded", network: CIGNA_NETWORK };
  if (slot === "Nationwide") return { carrier: "Nationwide", label: "Level Funded", network: "Nationwide" };
  if (slot === "Angle") return { carrier: "Angle Health", label: "Level Funded", network: CIGNA_NETWORK };
  if (slot === "Cobalt") return { carrier: "Cobalt", label: "Self Funded", network: "On the proposal" };
  if (slot === "Optimyl") return { carrier: "Optimyl Health", label: "Self Funded", network: "RBP Full" };
  return { carrier: carrier || "Other", label: "Level Funded", network: "On the proposal" };
}

/**
 * Optimyl's rate is preliminary, not firm, for a 2-50 enrolled group: per
 * Optimyl's RFP Guidelines for 2-50 Enrolled Groups, a firm offer needs
 * either an Individual Health Questionnaire (IHQ) for every enrolling
 * employee, or ExpressScreen underwriting on the census and renewal
 * followed by Optimyl's Short-Form IHQ. Neither has happened yet at
 * proposal stage, so every card and grid row for such a group flags it.
 */
export const OPTIMYL_UNDERWRITING_NOTE =
  "This rate is preliminary. Optimyl requires underwriting to firm it up for a group this size (2-50 enrolled): either an Individual Health Questionnaire (IHQ) for every enrolling employee, or ExpressScreen underwriting on the census and renewal followed by Optimyl's Short-Form IHQ.";

/**
 * How many plans a Carrier/TPA lets a group offer its employees, by enrolled
 * headcount. Kennion's own rule, not something every quote states, so it is
 * kept here and in the matching `CARRIER_PLAN_LIMIT_SEED` in server/index.js
 * (which seeds `kennion.carrier_plan_limits` - a row there wins once one
 * exists, so a limit can be corrected without a deploy). A carrier with no
 * entry has no limit on file.
 */
export type PlanLimitTier = { min: number; max: number | null; maxPlans: number; maxWithUnderwriting?: number };
const CARRIER_PLAN_LIMITS: Record<string, PlanLimitTier[]> = {
  "Optimyl Health": [
    { min: 2, max: 24, maxPlans: 2 },
    { min: 25, max: 50, maxPlans: 3 },
    { min: 51, max: null, maxPlans: 4 },
  ],
  UnitedHealthcare: [
    { min: 2, max: 50, maxPlans: 2 },
    { min: 51, max: null, maxPlans: 3, maxWithUnderwriting: 4 },
  ],
  Gravie: [
    { min: 2, max: 50, maxPlans: 3 },
    { min: 51, max: null, maxPlans: 4 },
  ],
};
/** Every carrier with a plan-count limit on file, for listing them (the disclaimers page). */
export const PLAN_LIMIT_CARRIERS: string[] = Object.keys(CARRIER_PLAN_LIMITS);

/** The tier covering this many enrolled, for a carrier with a limit on file; null for a carrier with none, or an enrolled count none of its tiers cover. */
export function planLimitFor(carrier: string, enrolled: number): PlanLimitTier | null {
  const tiers = CARRIER_PLAN_LIMITS[carrier];
  if (!tiers) return null;
  return tiers.find((t) => enrolled >= t.min && (t.max == null || enrolled <= t.max)) || null;
}

const tierRangeLabel = (t: PlanLimitTier) => (t.max == null ? `${t.min}+ enrolled` : `${t.min}-${t.max} enrolled`);

/**
 * Every tier of a carrier's plan-count limit, in one sentence, for the
 * disclaimers page; null for a carrier with no limit on file. Split into
 * the carrier's name and the rest of the sentence so the page can bold the
 * name - the same standardized wording either way, generated from the one
 * `CARRIER_PLAN_LIMITS` table that Sign Up's own logic reads.
 */
export function planLimitSummary(carrier: string): { carrier: string; rest: string } | null {
  const tiers = CARRIER_PLAN_LIMITS[carrier];
  if (!tiers) return null;
  const parts = tiers.map((t) => `${plural(t.maxPlans, "plan")} for a group with ${tierRangeLabel(t)}`);
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  let rest = ` allows ${joined}.`;
  const uw = tiers.find((t) => t.maxWithUnderwriting != null);
  if (uw) rest += ` A group with ${tierRangeLabel(uw)} may ask ${carrier}'s underwriting to raise that to ${uw.maxWithUnderwriting} plans.`;
  return { carrier, rest };
}

/**
 * Angle Health confirmed it sets no limit on how many plans a group may
 * offer, at any headcount - which is also why it carries no entry in
 * `CARRIER_PLAN_LIMITS` above: a carrier with no entry has no limit
 * enforced anywhere a plan-count cap is checked (Sign Up's `overLimit`
 * included). Stated here so the disclaimers page says so explicitly
 * instead of just omitting Angle Health from the capped-carrier list.
 */
export const ANGLE_HEALTH_NO_PLAN_CAP =
  "Angle Health has confirmed it places no limit on how many plans a group may offer its employees - a group may select as many Angle Health plans as fit its needs.";

/**
 * Gravie and Angle Health both run on Cigna's network, and every
 * UnitedHealthcare plan (Fully Insured, Level Funded, or Surest) is on the
 * United Choice Plus network - a fixed rule, not something a carrier's own
 * proposal document gets to override with a differently-worded network name
 * ("Cigna OAP", "Cigna Open Access Plus", "Angle / Cigna PPO" are all Cigna).
 */
const FIXED_NETWORK_SLOTS = new Set(["UHC Fully Insured", "UHC Level Funded", "Surest", "Gravie", "Angle"]);

/** The one name every Cigna network reads as, site-wide. */
export const CIGNA_NETWORK = "Cigna";
/** Cigna's public provider search: the lookup for every plan on a Cigna network, Gravie's and Angle Health's alike. */
export const CIGNA_DIRECTORY = "https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC001";
/** Gravie's own SBC library, covering every plan and network it quotes; the disclaimers page links here rather than picking one SBC to attach. */
export const GRAVIE_SBC_URL = "https://www.gravie.com/sbc/";

/** A network name as shown: any Cigna network - OAP, Open Access Plus, "Angle / Cigna PPO" - is "Cigna". */
export function networkLabel(network: string | null | undefined): string | null {
  const s = String(network || "").trim();
  if (!s) return null;
  if (/cigna/i.test(s)) return CIGNA_NETWORK;
  return s;
}

/**
 * Where a client looks up a doctor on a plan's network. Gravie's plans run on
 * Cigna's Open Access Plus (OAP) network, and Cigna's public directory answers
 * "is my doctor in it?" - so every place a Gravie plan names its network links
 * there. Null for a network with no public directory on file.
 */
/**
 * How a plan's network works, which is the first thing an employer asks:
 * PPO (in and out of network, the carrier's contracted rates), EPO (in
 * network only) or RBP (reference-based pricing - no network; claims paid at
 * a multiple of Medicare, which is how Cobalt's self-funded plans work). Read
 * off what the proposal says - the plan's name, its type, the network it is
 * priced on - with the carrier as the fallback rule: UnitedHealthcare's Choice
 * Plus and Cigna Open Access Plus are PPO networks; Gravie's EPO sheet says
 * EPO; Cobalt is RBP. Null when nothing on the quote says.
 */
export type NetworkType = "PPO" | "EPO" | "RBP";
export const NETWORK_TYPES: NetworkType[] = ["PPO", "EPO", "RBP"];
export function networkTypeOf(p: { plan?: string | null; type?: string | null; network?: string | null; carrier?: string | null; planType?: string | null }): NetworkType | null {
  const text = [p.plan, p.type, p.planType, p.network].filter(Boolean).join(" ");
  if (/\bRBP\b|reference[\s-]?based/i.test(text) || /cobalt/i.test(p.carrier || "")) return "RBP";
  if (/\bEPO\b/i.test(text)) return "EPO";
  // Cigna's network is a PPO wherever it appears - Gravie's Cigna OAP, Angle
  // Health's Cigna - so a quote that names only "Cigna" still reads PPO.
  if (/\bPPO\b|\bPOS\b|choice\s*plus|open\s*access\s*plus|\bOAP\b|cigna/i.test(text)) return "PPO";
  return null;
}

/**
 * The pharmacy benefit manager behind a carrier's plans, with its formulary
 * link where Kennion has one a client can open: Gravie's PBM, Express
 * Scripts, has a public formulary; Optimyl's PBM, CVS Caremark, runs a
 * closed formulary specific to the program, so the link here is Kennion's
 * own hosted copy of it rather than a public CVS page. Null for a carrier
 * with no PBM on file yet - the card still shows the row, blank, so every
 * card reads the same.
 */
export function pbmOf(carrier: string | null | undefined): { name: string; url?: string } | null {
  const c = String(carrier || "");
  if (/gravie/i.test(c)) return { name: "Express Scripts", url: "https://www.express-scripts.com/frontend/open-enrollment/gravie" };
  if (/optimyl/i.test(c)) return { name: "CVS Caremark", url: "https://app.kennion.com/assets/optimyl/cvs-caremark-value-formulary.pdf" };
  // Angle Health's own drug list, not a named third-party PBM - nothing on its
  // SBCs names one, so the card names the plan rather than a vendor.
  if (/angle/i.test(c)) return { name: "Angle Health Formulary", url: "https://formulary.anglehealth.com/?hsCtaAttrib=195574382245" };
  return null;
}

export function networkDirectory(network: string | null | undefined): { name: string; url: string } | null {
  const s = String(network || "");
  // One Cigna lookup for every Cigna network, whichever carrier is on it.
  if (/cigna/i.test(s)) return { name: "Cigna provider directory", url: CIGNA_DIRECTORY };
  if (/choice\s*plus|united|uhc/i.test(s)) {
    return { name: "UnitedHealthcare Choice Plus directory", url: UHC_DIRECTORY };
  }
  return null;
}

/** UnitedHealthcare's Choice Plus provider search (a guest link, no sign-in). */
export const UHC_DIRECTORY = "https://connect.werally.com/guest/eyJkZWxzeXMiOiI1MiIsInBsYW5OYW1lIjoiQ2hvaWNlIFBsdXMifQouGJEydhvvIF0CEkL7OR4zyxz11_MPxoMvtvbzh-eZw";

/** An option ID split for sorting: UH12 → ["UH", 12]; a plan without one sorts last. */
export function optionSortKey(id?: string | null): [string, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(id || "");
  return m ? [m[1], Number(m[2])] : ["~", Infinity];
}

/**
 * The plans on a group's proposals, priced at its census. A plan with no rate
 * on any tier is left out; one missing a tier that has people in it has no
 * monthly figure.
 */
export function proposalPlans(data: KennionData, g: Group): MarketPlan[] {
  const counts = censusCounts(g);
  const out: MarketPlan[] = [];
  const seen = new Set<string>();
  for (const pr of data.proposals || []) {
    // Cobalt is not offered for 2027, and Kennion offers PPO plans only: the
    // server already keeps both out of the payload; this holds the line if
    // an older payload or a new source ever carries them.
    if (pr.slot === "Cobalt") continue;
    for (const pl of pr.plans || []) {
      if (networkTypeOf({ plan: pl.name, planType: pl.planType, network: pl.network }) === "EPO") continue;
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
      // A plan the carrier did not price for every tier this group has
      // people in cannot be priced for the group: it is not shown, rather
      // than shown with a partial figure beside a blank one.
      if (monthly == null) continue;
      const show = slotPresentation(pr.slot, pr.carrier);
      // Gravie's benefits are by plan family and the same for every group.
      const fam = pr.slot === "Gravie" ? gravieFamily(pl.planType, pl.name) : null;
      const gb = fam ? GRAVIE_BENEFITS[fam] : null;
      const pb = pl.benefits || null;
      // Surest is UnitedHealthcare's own copay-only product, not a separate
      // company - the carrier reads "UnitedHealthcare", so the plan name is
      // where "Surest" has to show up.
      // The name is the carrier's, exactly as printed on the quote: it is what
      // the client will ask about by name, and what the audit checks.
      const planName = pr.slot === "Surest" && !/surest/i.test(pl.name) ? `Surest ${pl.name}` : pl.name;
      // One carrier plan, one row. The server has already folded a plan
      // printed several times into one canonical record and sends its
      // carrier identity (plan code, else exact name on its network); two
      // different plans are never collapsed because their rates agree.
      const dupKey = `${pr.slot}|${pl.identity || `${pl.planCode ? `code:${pl.planCode.trim().toUpperCase()}` : `name:${pl.name.toLowerCase()}|${(pl.network || "").toLowerCase()}`}`}`;
      if (seen.has(dupKey)) continue;
      seen.add(dupKey);
      const underwritingNote = pr.slot === "Optimyl" && g.sizeCategory === "2-50" ? OPTIMYL_UNDERWRITING_NOTE : null;
      out.push({
        optionId: pl.optionId ?? null,
        carrier: show.carrier,
        label: show.label,
        plan: planName,
        type: pl.planType || show.label,
        ded: moneyNum(pl.deductible) ?? pl.deductible ?? null,
        oop: moneyNum(pl.oopMax),
        copays: gb ? `${gb.pcp} / ${gb.specialist}` : pb?.doctorVisit || pb?.specialist ? `${pb.doctorVisit ?? "-"} / ${pb.specialist ?? "-"}` : "On the proposal",
        rx: gb ? `${gb.rxGeneric} generic · ${gb.rxPreferredBrand} preferred brand · ${gb.rxNonPreferredBrand} non-preferred` : pb?.rx || "On the proposal",
        coins: pb?.coinsurance ?? null,
        pcp: gb ? gb.pcp : pb?.doctorVisit ?? null,
        specialist: gb ? gb.specialist : pb?.specialist ?? null,
        uc: gb ? gb.uc : pb?.urgentCare ?? null,
        er: gb ? gb.er : pb?.er ?? null,
        imaging: gb ? (gb.basicLabs === gb.advancedLabs ? gb.basicLabs : `${gb.basicLabs} basic · ${gb.advancedLabs} advanced`) : pb?.imaging ?? null,
        hospital: gb ? gb.hospital : pb?.hospital ?? null,
        network: FIXED_NETWORK_SLOTS.has(pr.slot) ? show.network : networkLabel(pl.network) || show.network,
        rates,
        monthly,
        indicative: false,
        design: pl.design ?? null,
        quoted: { slot: pr.slot, date: pr.effectiveDate || pr.uploadedAt.slice(0, 10), proposalId: pr.id, audit: pr.audit || null },
        underwritingNote,
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

/** "$40 / $100" → doctor visit and specialist copays. */
export function splitCopays(copays: string | null | undefined): [string | null, string | null] {
  const parts = (copays || "").split("/").map((x) => x.trim()).filter(Boolean);
  if (!parts.length || !/\d/.test(parts[0])) return [null, null];
  return [parts[0], parts[1] ?? null];
}

/**
 * The 2027 options a group can be shown: the plans on its proposals, and
 * nothing else - every name and rate read off a carrier's own document by
 * the reader and checked by the audit, stored in the database. The menu
 * data in the seed file (UnitedHealthcare's August full-menu quotes, with
 * rates for some tiers only) is not a proposal and is not shown; nothing is
 * scaled, estimated or stood in for.
 */
export function marketPlans(data: KennionData, g: Group): MarketPlan[] {
  return proposalPlans(data, g);
}

/** The headline comparison - today's total against 2027, plans mapped 1-for-1 - reused wherever the site needs it in one line rather than the full grid. */
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
 * - not the whole grid - does not have to recompute it by hand and risk it
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

/** Where the market review stands for the Welcome page: how many priced options there are, and whether every proposal slot the group has is quoted yet. */
export interface MarketReview {
  /** Priced 2027 medical options on the Medical Plans page. */
  options: number;
  /** Proposal slots that hold at least one priced plan. */
  slotsQuoted: number;
  /** Proposal slots this group is taken to market in. */
  slotsExpected: number;
  /** True once every slot holds a priced plan: nothing more is expected. */
  complete: boolean;
}

/**
 * The Welcome page's one-line status. A group goes to market in a fixed set
 * of proposal slots (`data.slots`, or the program's slots when a group
 * carries none); the review is complete once every one of them holds a priced plan,
 * and in progress while any is still empty, so the page can say more options
 * may still be added without naming a carrier.
 */
export function marketReview(data: KennionData, g: Group): MarketReview {
  const priced = marketPlans(data, g).filter((p) => p.monthly != null);
  const expected = (data.slots && data.slots.length ? data.slots : PROPOSAL_SLOTS).filter((sl) => sl !== "Cobalt");
  const quoted = new Set(priced.map((p) => p.quoted?.slot).filter((sl): sl is string => !!sl));
  const slotsQuoted = expected.filter((sl) => quoted.has(sl)).length;
  return { options: priced.length, slotsQuoted, slotsExpected: expected.length, complete: expected.length > 0 && slotsQuoted === expected.length };
}

/**
 * A flat-dollar defined contribution, the way Employee Navigator sets one
 * up: the employer puts the same amount toward a tier whatever plan the
 * employee picks, and the employee pays the rest. `over` marks a plan that
 * costs less than the contribution for this tier - the employer would pay
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
 * times headcount in every tier - the same figure on every plan - and what
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
    if (!n) continue;
    const s = tierSplit(p, contribution, t.key);
    // A tier with people in it but no rate: there is no split for the plan
    // at all, never a partial one that leaves those people out.
    if (!s) return null;
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
 * Gravie's benefits by plan family - the static "Benefits Grid" sheet that
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

const COINS = "0-20% coins after ded";

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
    hospital: "0-30% coins after ded",
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
    rxNonPreferredBrand: "0-50% coins after ded",
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

/**
 * "Your Market Results": what Kennion got back after taking this group to
 * market, summed up from the full set of quoted plans - never the filtered
 * grid. Every figure is computed here, deterministically; the sentences are a
 * fixed template that only renders the clauses the group's data supports.
 * It recomputes from the plans it is given, so a new proposal or a change to
 * the group shows up the moment the page's data does.
 *
 * The cost figure is the average of the employee-only tier's monthly premium
 * across a partner's distinct plans, each plan weighted equally, then halved
 * for a fixed 50% employer contribution. It is a market read, not the
 * employer's own contribution, which the controls above the grid set.
 */
export const MARKET_RESULTS_EMPLOYER_SHARE = 0.5;
/** The ⓘ beside the title: what Kennion did for the client, and what the page is for. */
export const MARKET_RESULTS_TIP =
  "Kennion went to work for you. We took your group to the best carriers and partners in the market, gathered their strongest offers, and priced every plan for your people. The hard work is done. Now use our technology and our team to decide what is right for your group.";

export interface MarketPartner {
  name: string;
  /** Distinct plans this partner quoted, RBP included. */
  plans: number;
  /** Average employee-only monthly premium across its plans; null when any plan is missing the rate. */
  avgEmployeeOnlyPremium: number | null;
  /** That average at a 50% employer contribution; null when the premium is. */
  avgEmployeeOnlyCost: number | null;
  /** Reference-based pricing plans among its plans. */
  rbpPlans: number;
}

export interface MarketResults {
  totalPlans: number;
  partners: MarketPartner[];
  /** Partner(s) with the lowest average employee-only cost: several on a tie; empty when any partner's rates are incomplete. */
  lowestCost: MarketPartner[];
  /** Partner(s) with the most distinct plans: several on a tie; empty when every partner has the same count. */
  widest: MarketPartner[];
  /** Whether every partner quoted the same number of plans. */
  allSameCount: boolean;
  /** Provider networks on the network-based plans, in alphabetical order; RBP is a pricing approach, never a network. */
  networks: string[];
  /** Each network with the partners whose plans are on it, so a network is never read as another partner's. */
  networkPartners: { network: string; partners: string[] }[];
  /** Partners offering reference-based pricing, with their RBP plan counts. */
  rbp: { name: string; plans: number }[];
}

/** The partner a plan comes from, as shown: Surest rows read as UnitedHealthcare. */
const marketPartnerOf = (p: MarketPlan) => p.carrier.replace(" (UnitedHealthcare)", "");

/** A network name that names a network: the placeholder for "not on the quote" does not. */
const isNamedNetwork = (s: string | null) => !!s && !/^on the proposal$/i.test(s) && s !== "-";

export function marketResults(plans: MarketPlan[]): MarketResults | null {
  if (!plans.length) return null;
  const byPartner = new Map<string, MarketPlan[]>();
  for (const p of plans) {
    const k = marketPartnerOf(p);
    (byPartner.get(k) || byPartner.set(k, []).get(k)!).push(p);
  }
  const partners: MarketPartner[] = [...byPartner.entries()].map(([name, list]) => {
    const ee = list.map((p) => p.rates.EE);
    const complete = ee.every((v) => v != null && Number.isFinite(v));
    const avg = complete ? (ee as number[]).reduce((a, b) => a + b, 0) / ee.length : null;
    return {
      name,
      plans: list.length,
      avgEmployeeOnlyPremium: avg,
      avgEmployeeOnlyCost: avg == null ? null : avg * MARKET_RESULTS_EMPLOYER_SHARE,
      rbpPlans: list.filter((p) => networkTypeOf(p) === "RBP").length,
    };
  });
  // Rankings on the unrounded figures.
  const priced = partners.every((x) => x.avgEmployeeOnlyCost != null);
  const minCost = priced ? Math.min(...partners.map((x) => x.avgEmployeeOnlyCost as number)) : null;
  const lowestCost = minCost == null ? [] : partners.filter((x) => Math.abs((x.avgEmployeeOnlyCost as number) - minCost) < 1e-9);
  const maxPlans = Math.max(...partners.map((x) => x.plans));
  const allSameCount = partners.every((x) => x.plans === maxPlans);
  const widest = allSameCount ? [] : partners.filter((x) => x.plans === maxPlans);
  const networks = [...new Set(plans.filter((p) => networkTypeOf(p) !== "RBP").map((p) => networkLabel(p.network)).filter(isNamedNetwork) as string[])].sort((a, b) => a.localeCompare(b));
  // Which partners' plans are on each network, partners in the order they were quoted.
  const networkPartners = networks.map((network) => ({
    network,
    partners: partners.map((x) => x.name).filter((name) => plans.some((p) => marketPartnerOf(p) === name && networkTypeOf(p) !== "RBP" && networkLabel(p.network) === network)),
  }));
  const rbp = partners.filter((x) => x.rbpPlans > 0).map((x) => ({ name: x.name, plans: x.rbpPlans }));
  return { totalPlans: plans.length, partners, lowestCost, widest, allSameCount, networks, networkPartners, rbp };
}

/**
 * A sentence as segments: fixed wording, and the values populated from the
 * group's data marked so the page can set them apart (bold, underlined).
 */
export type MarketSegment = { text: string; value?: boolean };
export type MarketSentence = MarketSegment[];

const T = (text: string): MarketSegment => ({ text });
const V = (text: string): MarketSegment => ({ text, value: true });
/** "A", "A and B", "A, B and C" - each name a value, the joins fixed. */
function listValues(names: string[]): MarketSegment[] {
  const out: MarketSegment[] = [];
  names.forEach((n, i) => {
    if (i > 0) out.push(T(i === names.length - 1 ? " and " : ", "));
    out.push(V(n));
  });
  return out;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The summary as sentences. Only clauses the data supports are written: no
 * price claim when any partner's rates are incomplete, no sole winner on a
 * tie, no superlatives for a single partner, no network clause without a
 * named network, and no RBP sentence without an RBP plan.
 */
export function marketResultsSentences(s: MarketResults | null): MarketSentence[] {
  if (!s || !s.totalPlans) return [];
  const out: MarketSentence[] = [];
  // Each partner with its own count, so the total is accounted for - every
  // partner the same shape, UnitedHealthcare included: its two fundings
  // still both count toward its one plan count, but aren't named here, so
  // it reads like any other Carrier/TPA rather than a special case.
  const partnerList: MarketSegment[] = [];
  s.partners.forEach((x, i) => {
    if (i > 0) partnerList.push(T(i === s.partners.length - 1 ? " and " : ", "));
    partnerList.push(V(x.name), T(" ("), V(plural(x.plans, "plan")), T(")"));
  });
  out.push([T("Kennion took your group to market and received "), V(plural(s.totalPlans, "plan option")), T(" from "), ...partnerList, T(".")]);

  const assumption = "assuming a 50% employer contribution";
  const costOf = (x: MarketPartner) => V(`${money0(x.avgEmployeeOnlyCost)}/month`);

  if (s.partners.length === 1) {
    const only = s.partners[0];
    // One partner: its figures, no comparison.
    if (only.avgEmployeeOnlyCost != null) {
      out.push([V(only.name), T(`'s `), V(plural(only.plans, "plan")), T(" average "), costOf(only), T(` for employee-only coverage, ${assumption}.`)]);
    }
  } else {
    const soleLow = s.lowestCost.length === 1 ? s.lowestCost[0] : null;
    const soleWide = s.widest.length === 1 ? s.widest[0] : null;
    if (soleLow && soleWide && soleLow.name === soleWide.name) {
      // One partner wins both: one sentence.
      out.push([V(soleLow.name), T(" offered both the lowest average employee-only cost at "), costOf(soleLow), T(`, ${assumption}, and the widest selection with `), V(plural(soleLow.plans, "plan")), T(".")]);
    } else {
      if (soleLow) {
        out.push([V(soleLow.name), T(" offered the lowest average employee-only cost at "), costOf(soleLow), T(`, ${assumption}.`)]);
      } else if (s.lowestCost.length > 1) {
        out.push([...listValues(s.lowestCost.map((x) => x.name)), T(" tied for the lowest average employee-only cost at "), costOf(s.lowestCost[0]), T(`, ${assumption}.`)]);
      }
      if (soleWide) {
        out.push([V(soleWide.name), T(" offered the widest selection with "), V(plural(soleWide.plans, "plan")), T(".")]);
      } else if (s.widest.length > 1) {
        out.push([...listValues(s.widest.map((x) => x.name)), T(" each offered the widest selection with "), V(plural(s.widest[0].plans, "plan")), T(".")]);
      } else if (s.allSameCount) {
        out.push([T("Each partner offered "), V(plural(s.partners[0].plans, "plan")), T(".")]);
      }
    }
  }

  // Networks on their own sentence, each tied to the Carrier/TPA whose plans
  // are on it, so a network is never read as another partner's: "Angle Health
  // and Gravie plans are on the Cigna network, and UnitedHealthcare plans are
  // on the United Choice Plus network."
  if (s.networkPartners.length) {
    const parts: MarketSegment[] = [];
    s.networkPartners.forEach((n, i) => {
      if (i > 0) parts.push(T(i === s.networkPartners.length - 1 ? ", and " : ", "));
      parts.push(...listValues(n.partners), T(" plans are on the "), V(n.network), T(" network"));
    });
    out.push([T("Network options: "), ...parts, T(".")]);
  }

  if (s.rbp.length) {
    if (s.rbp.length === s.partners.length) {
      // Every partner on offer already prices this way: "we also included"
      // (nothing else was) and "an alternative to traditional network-based
      // coverage" (there is none among the options to contrast with) would
      // both invent a second kind of option that is not there.
      const one = s.rbp.length === 1;
      out.push([...listValues(s.rbp.map((r) => r.name)), T(` price${one ? "s" : ""} ${one ? "its" : "their"} plans with reference-based pricing (RBP), not a traditional provider network.`)]);
    } else {
      const parts: MarketSegment[] = [];
      s.rbp.forEach((r, i) => {
        if (i > 0) parts.push(T(i === s.rbp.length - 1 ? " and " : ", "));
        parts.push(V(r.name), T(", offering "), V(plural(r.plans, "reference-based pricing plan")));
      });
      out.push([T("We also included "), ...parts, T(", as an alternative to traditional network-based coverage.")]);
    }
  }
  // What happens next, in one fixed closing sentence - the same for every
  // group regardless of partner count, rendered on its own line and bold by
  // the page since it is the summary's takeaway, not a data-backed clause.
  out.push([T("Your company chooses a Carrier/TPA and the health plans to offer. Employees then choose from those selected plans during open enrollment.")]);
  return out;
}

/** The sentences as plain text, for exports and tests. */
export const marketResultsText = (s: MarketResults | null): string[] => marketResultsSentences(s).map((sent) => sent.map((x) => x.text).join(""));

/**
 * The carriers' floor for an employer contribution: at least half the
 * employee-only rate of the least expensive quoted plan, for every enrolled
 * employee whatever tier they are in. Whole dollars, rounded up; 0 with no
 * priced plan.
 */
export function contributionFloor(plans: MarketPlan[]): number {
  const rates = plans.map((p) => p.rates.EE).filter((r): r is number => r != null && r > 0);
  return rates.length ? Math.ceil(Math.min(...rates) * 0.5) : 0;
}

/**
 * Where a group's contribution starts: the floor on every tier - the same
 * dollars toward each employee's coverage, dependents on top of that being
 * the employee's. The employer can raise any tier from there.
 */
export function minimumContribution(plans: MarketPlan[]): Record<TierKey, number> {
  const floor = contributionFloor(plans);
  return TIERS.reduce((acc, t) => ({ ...acc, [t.key]: floor }), {} as Record<TierKey, number>);
}

/**
 * The group's census as the assistant is briefed with it (the server's
 * censusProfile, mirrored): aggregates only - how many employees, average
 * and median age, youngest and oldest, how tight the spread is, counts by
 * age band, and who covers a spouse or children. No name and no one
 * person's age leaves this shape. Null with no ages on file.
 */
export interface CensusProfile {
  employees: number;
  average: number;
  median: number;
  youngest: number;
  oldest: number;
  spread: "narrow" | "moderate" | "wide";
  bands: { label: string; count: number }[];
  spouses: number;
  withChildren: number;
  children: number;
}

/** The server's shape of the profile, as it travels in the group payload. */
export interface ServerCensus {
  employees: number;
  average: number;
  median: number;
  youngest: number;
  oldest: number;
  spread: "narrow" | "moderate" | "wide";
  bands: { under30: number; from30to44: number; from45to54: number; from55: number };
  spouses: number;
  withChildren: number;
  children: number;
}

export function censusProfile(g: Pick<Group, "members" | "census">): CensusProfile | null {
  // The page gets the profile from the server (members never travel to a client page); a staff view with members computes it.
  if (g.census) {
    const c = g.census;
    return {
      ...c,
      bands: [
        { label: "Under 30", count: c.bands.under30 },
        { label: "30-44", count: c.bands.from30to44 },
        { label: "45-54", count: c.bands.from45to54 },
        { label: "55+", count: c.bands.from55 },
      ],
    };
  }
  const members = Array.isArray(g.members) ? g.members : [];
  const ages = members.map((m) => Number(m.age)).filter((a) => Number.isFinite(a) && a > 0);
  if (!ages.length) return null;
  const sorted = [...ages].sort((a, b) => a - b);
  const mean = ages.reduce((s, a) => s + a, 0) / ages.length;
  const sd = Math.sqrt(ages.reduce((s, a) => s + (a - mean) ** 2, 0) / ages.length);
  const band = (lo: number, hi: number) => ages.filter((a) => a >= lo && a <= hi).length;
  return {
    employees: ages.length,
    average: Math.round(mean),
    median: sorted[Math.floor(sorted.length / 2)],
    youngest: sorted[0],
    oldest: sorted[sorted.length - 1],
    spread: sd < 8 ? "narrow" : sd < 13 ? "moderate" : "wide",
    bands: [
      { label: "Under 30", count: band(0, 29) },
      { label: "30-44", count: band(30, 44) },
      { label: "45-54", count: band(45, 54) },
      { label: "55+", count: band(55, 200) },
    ],
    spouses: members.filter((m) => Array.isArray(m.spAges) && m.spAges.length).length,
    withChildren: members.filter((m) => Array.isArray(m.chAges) && m.chAges.length).length,
    children: members.reduce((s, m) => s + (Array.isArray(m.chAges) ? m.chAges.length : 0), 0),
  };
}

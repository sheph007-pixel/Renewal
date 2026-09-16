/**
 * The Medical Plans filters and sort, as data: what is applied, what a plan
 * has to match, the chips that describe it, and the option counts each
 * dropdown shows. No React here, so `scripts/test-plan-filters.mts` can
 * exercise every rule — OR within a category, AND between them, clear all,
 * the bill range's validation — without a browser.
 */

/** The facets a plan is filtered on, read off it once by the grid. */
export interface PlanFacets {
  carrier: string;
  network: string;
  funding: string;
  ded: number | null;
  oop: number | null;
  /** Total Monthly Bill at the group's enrollment; null where a rate is missing. */
  bill: number | null;
}

/** A dollar band: inclusive at both ends, open-ended where `max` is null. */
export interface Band {
  id: string;
  label: string;
  min: number;
  max: number | null;
}

/** Fixed, round, non-overlapping bands; a group only sees the ones its quotes fall in. */
export const DED_BANDS: Band[] = [
  { id: "0", label: "$0", min: 0, max: 0 },
  { id: "1-1000", label: "$1 – $1,000", min: 1, max: 1000 },
  { id: "1001-2500", label: "$1,001 – $2,500", min: 1001, max: 2500 },
  { id: "2501-5000", label: "$2,501 – $5,000", min: 2501, max: 5000 },
  { id: "5001-", label: "$5,001+", min: 5001, max: null },
];
export const OOP_BANDS: Band[] = [
  { id: "0-3000", label: "$0 – $3,000", min: 0, max: 3000 },
  { id: "3001-6000", label: "$3,001 – $6,000", min: 3001, max: 6000 },
  { id: "6001-8000", label: "$6,001 – $8,000", min: 6001, max: 8000 },
  { id: "8001-", label: "$8,001+", min: 8001, max: null },
];

export const inBand = (b: Band, v: number) => v >= b.min && (b.max == null || v <= b.max);

/** The bands at least one of these values falls in, in order — so every band offered has a plan behind it. */
export function bandsWithData(bands: Band[], values: (number | null)[]): Band[] {
  return bands.filter((b) => values.some((v) => v != null && inBand(b, v)));
}

export interface BillRange {
  min: number | null;
  max: number | null;
}

export interface PlanFilters {
  carriers: string[];
  networks: string[];
  fundings: string[];
  /** Band ids from DED_BANDS / OOP_BANDS. */
  deds: string[];
  oops: string[];
  bill: BillRange;
}

/** The five checkbox categories. */
export type ListKey = "carriers" | "networks" | "fundings" | "deds" | "oops";
export type FilterKey = ListKey | "bill";
export const LIST_KEYS: ListKey[] = ["carriers", "networks", "fundings", "deds", "oops"];

export const CATEGORY_LABELS: Record<FilterKey, string> = {
  carriers: "Carrier/TPA",
  networks: "Network Type",
  fundings: "Funding",
  deds: "Deductible",
  oops: "OOP Max",
  bill: "Total Monthly Bill",
};

export const EMPTY_FILTERS: PlanFilters = { carriers: [], networks: [], fundings: [], deds: [], oops: [], bill: { min: null, max: null } };

export const billSet = (b: BillRange) => b.min != null || b.max != null;

/** How many selections a category carries: the bill range counts as one. */
export function categoryCount(f: PlanFilters, key: FilterKey): number {
  return key === "bill" ? (billSet(f.bill) ? 1 : 0) : f[key].length;
}

/** Every selection across every category. */
export const filterCount = (f: PlanFilters) => LIST_KEYS.reduce((n, k) => n + f[k].length, 0) + categoryCount(f, "bill");

export const filtersEmpty = (f: PlanFilters) => filterCount(f) === 0;

export function toggleIn(f: PlanFilters, key: ListKey, value: string): PlanFilters {
  const list = f[key];
  return { ...f, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
}

export const withBill = (f: PlanFilters, bill: BillRange): PlanFilters => ({ ...f, bill });

/**
 * Whether a plan passes the filters: OR within a category (any chosen carrier),
 * AND between categories. `except` leaves one category out — the count beside
 * each option is what choosing it would show, so it ignores that category's
 * own selections.
 */
export function matches(x: PlanFacets, f: PlanFilters, except?: FilterKey): boolean {
  const on = (k: FilterKey) => k !== except;
  if (on("carriers") && f.carriers.length && !f.carriers.includes(x.carrier)) return false;
  if (on("networks") && f.networks.length && !f.networks.includes(x.network)) return false;
  if (on("fundings") && f.fundings.length && !f.fundings.includes(x.funding)) return false;
  if (on("deds") && f.deds.length && (x.ded == null || !DED_BANDS.some((b) => f.deds.includes(b.id) && inBand(b, x.ded!)))) return false;
  if (on("oops") && f.oops.length && (x.oop == null || !OOP_BANDS.some((b) => f.oops.includes(b.id) && inBand(b, x.oop!)))) return false;
  if (on("bill") && billSet(f.bill)) {
    if (x.bill == null) return false;
    if (f.bill.min != null && x.bill < f.bill.min) return false;
    if (f.bill.max != null && x.bill > f.bill.max) return false;
  }
  return true;
}

/** The facet value a plan contributes to one category: the band it falls in for the dollar categories. */
export function facetValue(x: PlanFacets, key: ListKey): string | null {
  if (key === "carriers") return x.carrier;
  if (key === "networks") return x.network;
  if (key === "fundings") return x.funding;
  const bands = key === "deds" ? DED_BANDS : OOP_BANDS;
  const v = key === "deds" ? x.ded : x.oop;
  return v == null ? null : (bands.find((b) => inBand(b, v))?.id ?? null);
}

/**
 * How many plans each option would show, given every other category's
 * selections. `items` is the list already narrowed by whatever sits outside
 * these filters (search, favorites only); every option in `values` gets a
 * count, zero included, so the list never changes shape.
 */
export function optionCounts(items: PlanFacets[], f: PlanFilters, key: ListKey, values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  values.forEach((v) => (counts[v] = 0));
  items.forEach((x) => {
    if (!matches(x, f, key)) return;
    const v = facetValue(x, key);
    if (v != null && v in counts) counts[v] += 1;
  });
  return counts;
}

/** "$31,275" / "31275" / "31,275.50" → 31275 (whole dollars); blank or unreadable → null. */
export function parseDollars(text: string): number | null {
  const t = text.replace(/[^\d.]/g, "");
  if (!t || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Why a bill range cannot be applied, or null when it can. */
export function billError(b: BillRange): string | null {
  if (b.min != null && b.max != null && b.min > b.max) return "Minimum must not exceed maximum.";
  return null;
}

const dollars = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/** "Monthly bill: $30,000 – $40,000", "at least $30,000", "up to $40,000". */
export function billLabel(b: BillRange): string {
  if (b.min != null && b.max != null) return `${dollars(b.min)} – ${dollars(b.max)}`;
  if (b.min != null) return `at least ${dollars(b.min)}`;
  if (b.max != null) return `up to ${dollars(b.max)}`;
  return "";
}

export interface FilterChip {
  /** Unique across the row: "carriers:Gravie". */
  key: string;
  category: FilterKey;
  /** What the chip reads: "Carrier/TPA: Gravie". */
  label: string;
  /** The filters with this one selection taken out. */
  remove: (f: PlanFilters) => PlanFilters;
}

/** One chip per applied selection, in category order, so every filter is visible and removable below the toolbar. */
export function filterChips(f: PlanFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  const bandLabel = (bands: Band[], id: string) => bands.find((b) => b.id === id)?.label ?? id;
  LIST_KEYS.forEach((k) => {
    f[k].forEach((v) => {
      const text = k === "deds" ? bandLabel(DED_BANDS, v) : k === "oops" ? bandLabel(OOP_BANDS, v) : v;
      chips.push({ key: `${k}:${v}`, category: k, label: `${CATEGORY_LABELS[k]}: ${text}`, remove: (x) => ({ ...x, [k]: x[k].filter((y) => y !== v) }) });
    });
  });
  if (billSet(f.bill)) chips.push({ key: "bill", category: "bill", label: `Monthly bill: ${billLabel(f.bill)}`, remove: (x) => withBill(x, { min: null, max: null }) });
  return chips;
}

// ------------------------------------------------------------------- sort

export type SortKey = "option" | "carrier" | "network" | "plan" | "ded" | "oop" | "er" | "total";
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}
/** Lowest Total Monthly Bill first: the order the grid has always opened in. */
export const DEFAULT_SORT: SortState = { key: "total", dir: 1 };

const SORT_NAMES: Record<SortKey, string> = {
  option: "Option",
  carrier: "Carrier/TPA",
  network: "Network type",
  plan: "Plan",
  ded: "Deductible",
  oop: "OOP max",
  er: "Your company pays",
  total: "Monthly bill",
};
const TEXT_SORTS: SortKey[] = ["option", "carrier", "network", "plan"];

/** "Monthly bill: Low to high", "Carrier/TPA: A to Z" — plain words, for the Sort by control and its options. */
export function sortLabel(s: SortState): string {
  const text = TEXT_SORTS.includes(s.key);
  const dir = text ? (s.dir > 0 ? "A to Z" : "Z to A") : s.dir > 0 ? "Low to high" : "High to low";
  return `${SORT_NAMES[s.key]}: ${dir}`;
}

/** What the Sort by dropdown offers; a column sorted from the table header outside this list still shows as the current choice. */
export const SORT_CHOICES: SortState[] = [
  { key: "total", dir: 1 },
  { key: "total", dir: -1 },
  { key: "ded", dir: 1 },
  { key: "ded", dir: -1 },
  { key: "oop", dir: 1 },
  { key: "oop", dir: -1 },
];

export const sortValue = (s: SortState) => `${s.key}:${s.dir > 0 ? "asc" : "desc"}`;
export function parseSortValue(v: string): SortState | null {
  const [key, dir] = v.split(":");
  if (!(key in SORT_NAMES) || (dir !== "asc" && dir !== "desc")) return null;
  return { key: key as SortKey, dir: dir === "asc" ? 1 : -1 };
}

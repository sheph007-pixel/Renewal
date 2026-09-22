/**
 * The standardized dental/vision/supplemental (and legacy-medical) benefit
 * summaries the server reads from each carrier's own plan-summary PDF - see
 * server/data/benefit-summaries.json and describeGroup() in assistant.js,
 * which gives the AI assistant the same data. Fetched once and shared: this
 * is the same for every group, like the Supplemental Package rate grid it
 * backs.
 */

export type BenefitCategory = "dental" | "vision" | "supplemental" | "medical-legacy";

export interface BenefitLine {
  label: string;
  value?: string | null;
  copay?: string | null;
  note?: string | null;
  description?: string | null;
  frequency?: string | null;
}

export interface BenefitSummary {
  id: string;
  category: BenefitCategory;
  name: string;
  carrier: string;
  status: "current" | "legacy";
  effectiveThrough: string | null;
  summary: Record<string, string>;
  lines: BenefitLine[];
  notes: string | null;
  sourceFile?: string;
}

let cache: Promise<BenefitSummary[]> | null = null;

/** Fetched once per page load and reused - the list never changes per group. */
export function fetchBenefitSummaries(): Promise<BenefitSummary[]> {
  if (!cache) {
    cache = fetch("/api/benefit-summaries")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load benefit summaries."))))
      .then((j: { benefitSummaries: BenefitSummary[] }) => j.benefitSummaries || []);
    cache.catch(() => {
      cache = null; // let a later call retry after a network hiccup
    });
  }
  return cache;
}

/**
 * The Supplemental Package rate grid's sections don't all map one summary
 * entry per row: dental and vision have one plan per row, but the
 * single-product sections (life, accident, critical illness, cancer,
 * hospital, disability) show several rate rows - by age band or benefit
 * level - for one product, so every row in those sections opens the same
 * entry. Keyed by the grid section's own `id` (see lib/supplemental.ts).
 */
const SECTION_ENTRY_ID: Record<string, string> = {
  life: "supplemental-voluntary-life",
  accident: "supplemental-accident-insurance",
  critical: "supplemental-critical-illness-insurance",
  cancer: "supplemental-cancer-insurance",
  hospital: "supplemental-hospital-surgery-insurance-gap",
  std: "supplemental-disability-insurance",
};

/** The benefit summary for one Supplemental Package grid row, or null if none is on file. */
export function benefitSummaryFor(summaries: BenefitSummary[], sectionId: string, rowPlan: string): BenefitSummary | null {
  if (sectionId === "dental" || sectionId === "vision") {
    return summaries.find((e) => e.category === sectionId && e.name === rowPlan) || null;
  }
  const id = SECTION_ENTRY_ID[sectionId];
  return (id && summaries.find((e) => e.id === id)) || null;
}

/** camelCase summary key -> a readable label, e.g. "deductibleIndividual" -> "Deductible Individual". */
export function labelFor(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/** One line's value, whichever field it's stored under (dental/supplemental use `value`, vision uses `copay`). */
export function lineValue(l: BenefitLine): string {
  return l.value ?? l.copay ?? "-";
}

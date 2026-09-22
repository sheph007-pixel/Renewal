/**
 * Each carrier's and TPA's main website and public provider-search tool
 * ("is my doctor in network?"), from server/data/carrier-sites.json - the
 * one source of truth both this file and the AI assistant's own context
 * (server/assistant.js) read from, so the assistant can never be missing a
 * find-a-doctor link this file already has. The plan card links the website
 * in words ("Visit Angle Health's Website"), and the CSV export carries the
 * address; grid rows do not link, because a row's click opens the card. A
 * name not listed here simply shows without a link. Edit the JSON to add a
 * carrier or partner - both sides pick it up automatically.
 */
import carrierData from "../../../server/data/carrier-sites.json";

const SITES: Record<string, string> = {};
const FIND_A_DOCTOR: Record<string, string> = {};
for (const c of carrierData.carriers) {
  for (const slug of c.slugs) {
    if (c.website) SITES[slug] = c.website;
    if (c.findADoctor) FIND_A_DOCTOR[slug] = c.findADoctor;
  }
}

/** The same slug the logo store keys on: lower-case, punctuation to dashes. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The main website for a carrier or TPA name, or null when none is on file. */
export function websiteOf(name: string | null | undefined): string | null {
  const s = slug(String(name || "").replace(/\s*\(UnitedHealthcare\)\s*$/i, ""));
  if (!s) return null;
  if (SITES[s]) return SITES[s];
  // "UnitedHealthcare Level Funded", "HealthEZ (EBPA)": the carrier is the first word that is on file.
  for (const part of s.split("-")) if (SITES[part]) return SITES[part];
  return null;
}

/**
 * Each carrier's or TPA's public provider-search tool - "is my doctor in
 * network?" - independent of which specific plan a client is on. Gravie and
 * Angle Health both price their plans on Cigna's network (Open Access Plus),
 * so they point at Cigna's own directory rather than one of their own. A
 * name not listed here simply shows no "Find A Doctor" link - never a
 * guessed URL.
 */
export function findADoctorOf(name: string | null | undefined): string | null {
  const s = slug(String(name || "").replace(/\s*\(UnitedHealthcare\)\s*$/i, ""));
  if (!s) return null;
  if (FIND_A_DOCTOR[s]) return FIND_A_DOCTOR[s];
  for (const part of s.split("-")) if (FIND_A_DOCTOR[part]) return FIND_A_DOCTOR[part];
  return null;
}

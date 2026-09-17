/**
 * Each carrier's and TPA's main website, so the Carrier/TPA name is a link
 * wherever it is shown - a plan card's header, a grid row, the Today page.
 * One row per name the system uses; a name not listed here simply shows
 * without a link. Edit here to add a carrier or partner.
 */
const SITES: Record<string, string> = {
  unitedhealthcare: "https://www.uhc.com/",
  uhc: "https://www.uhc.com/",
  surest: "https://www.surest.com/",
  gravie: "https://www.gravie.com/",
  nationwide: "https://www.nationwide.com/",
  "angle-health": "https://www.anglehealth.com/",
  angle: "https://www.anglehealth.com/",
  cobalt: "https://www.cobaltbenefitsgroup.com/",
  "cobalt-benefits-group": "https://www.cobaltbenefitsgroup.com/",
  healthez: "https://healthez.com/",
  ebpa: "https://www.ebpabenefits.com/",
  "bcbs-of-alabama": "https://www.bcbsal.org/",
  "blue-cross-blue-shield-of-alabama": "https://www.bcbsal.org/",
  "blue-cross-and-blue-shield-of-alabama": "https://www.bcbsal.org/",
  cigna: "https://www.cigna.com/",
  aetna: "https://www.aetna.com/",
  humana: "https://www.humana.com/",
  guardian: "https://www.guardianlife.com/",
  vsp: "https://www.vsp.com/",
};

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

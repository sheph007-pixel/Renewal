/**
 * Each carrier's and TPA's main website. The plan card links to it in words
 * ("Visit Angle Health's Website"), and the CSV export carries the address;
 * grid rows do not link, because a row's click opens the card. One row per
 * name the system uses; a name not listed here simply shows without a link.
 * Edit here to add a carrier or partner.
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
  "optimyl-health": "https://www.optimyl.com/",
  optimyl: "https://www.optimyl.com/",
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

/**
 * Each carrier's or TPA's public provider-search tool - "is my doctor in
 * network?" - independent of which specific plan a client is on. Gravie and
 * Angle Health both price their plans on Cigna's network (Open Access Plus),
 * so they point at Cigna's own directory rather than one of their own. A
 * name not listed here simply shows no "Find A Doctor" link - never a
 * guessed URL.
 */
const FIND_A_DOCTOR: Record<string, string> = {
  unitedhealthcare: "https://connect.werally.com/guest/eyJkZWxzeXMiOiI1MiIsInBsYW5OYW1lIjoiQ2hvaWNlIFBsdXMifQouGJEydhvvIF0CEkL7OR4zyxz11_MPxoMvtvbzh-eZw",
  uhc: "https://connect.werally.com/guest/eyJkZWxzeXMiOiI1MiIsInBsYW5OYW1lIjoiQ2hvaWNlIFBsdXMifQouGJEydhvvIF0CEkL7OR4zyxz11_MPxoMvtvbzh-eZw",
  cigna: "https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC001",
  gravie: "https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC001",
  "angle-health": "https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC001",
  angle: "https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC001",
  guardian: "https://www.guardianlife.com/find-a-provider",
  vsp: "https://www.vsp.com/eye-doctor",
};

/** The provider-search link for a carrier or TPA name, or null when none is on file. */
export function findADoctorOf(name: string | null | undefined): string | null {
  const s = slug(String(name || "").replace(/\s*\(UnitedHealthcare\)\s*$/i, ""));
  if (!s) return null;
  if (FIND_A_DOCTOR[s]) return FIND_A_DOCTOR[s];
  for (const part of s.split("-")) if (FIND_A_DOCTOR[part]) return FIND_A_DOCTOR[part];
  return null;
}

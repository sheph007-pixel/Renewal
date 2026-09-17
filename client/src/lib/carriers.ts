/**
 * The same tolerant carrier rule the server uses (server/eligibility.js), so
 * the screen can put a carrier name from any source - the XML plan catalog,
 * the carrier stats report - into the same bucket the server would.
 */
export type Program = "EBPA" | "HealthEZ" | "BCBS-AL";

export function matchCarrier(text: string | null | undefined): Program | null {
  const s = String(text || "");
  if (/\bebpa\b/i.test(s)) return "EBPA";
  if (/health\s*-?\s*ez/i.test(s)) return "HealthEZ";
  if (
    /\bbcbs\b/i.test(s) ||
    /blue\s*cross/i.test(s) ||
    /blue\s*shield/i.test(s) ||
    /blue\s*(secure|choice|saver|preferred)/i.test(s)
  )
    return "BCBS-AL";
  return null;
}

/** Loose equality for carrier names from two sources: case, spacing, punctuation. */
export const carrierKey = (s: string | null | undefined) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

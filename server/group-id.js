// Group identifiers: four letters from the company name plus two random digits,
// e.g. Johnson Storage & Moving Co. Holdings, LLC -> JSMH47.
//
// Four or more significant words give their initials; anything shorter falls
// back to the first four letters of the name run together, which reads better
// than padding initials ("DAHL47", not "DGAH47"). Legal-form and filler
// words are ignored so "Co.", "LLC" and "The" never eat a slot.
// Codes are evergreen - they do not change year to year.

const NOISE = new Set([
  "the", "of", "and", "a", "an", "for", "at", "in", "on", "to", "dba",
  "llc", "l.l.c", "inc", "inc.", "incorporated", "corp", "corp.", "corporation",
  "co", "co.", "company", "companies", "ltd", "ltd.", "limited", "lp", "llp",
  "pc", "p.c", "pllc", "plc", "pa", "group", "holdings", "holding",
]);

const words = (name) =>
  String(name || "")
    .replace(/[^A-Za-z\s.&-]/g, " ")
    .split(/[\s&-]+/)
    .map((w) => w.trim())
    .filter(Boolean);

/** The four-letter stem, before the year and before collision handling. */
export function stemFor(name) {
  const all = words(name);
  const significant = all.filter((w) => !NOISE.has(w.toLowerCase().replace(/\.$/, "")));
  const use = significant.length ? significant : all;

  let stem =
    use.length >= 4
      ? use.slice(0, 4).map((w) => w[0]).join("")
      : use.join("").slice(0, 4);

  stem = stem.toUpperCase().replace(/[^A-Z]/g, "");
  // Very short names ("Aesto") still need four characters.
  if (stem.length < 4) stem = (stem + use.join("").toUpperCase().replace(/[^A-Z]/g, "")).slice(0, 4);
  return stem.padEnd(4, "X").slice(0, 4);
}

/**
 * Generate a deterministic two-digit suffix from a name and collision counter.
 * Uses name hash to make the digits consistent for the same name.
 */
function suffixFor(name, collision = 0) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash = hash & hash; // Keep it within 32-bit int range
  }
  const base = Math.abs(hash) % 90; // Maps to 0-89
  const digit1 = Math.floor((base + collision) / 10) % 10;
  const digit2 = (base + collision) % 10;
  return String(digit1) + String(digit2);
}

/**
 * Assign a unique evergreen code to every group. Codes are 4 letters + 2 digits
 * (e.g., ADOB47) and do not change year to year. Deterministic for a given set:
 * names are processed in sorted order so the same roster always yields the same codes.
 */
export function assignCodes(names) {
  const taken = new Set();
  const out = new Map();

  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const stem = stemFor(name);
    let suffix = suffixFor(name);
    let code = stem + suffix;

    // Handle collisions by incrementing the suffix
    let collision = 0;
    while (taken.has(code)) {
      collision++;
      suffix = suffixFor(name, collision);
      code = stem + suffix;
    }

    taken.add(code);
    out.set(name, code);
  }
  return out;
}

/** Default ALE bucket from headcount; a judgement call staff can override. */
export const sizeFor = (enrolled) => (Number(enrolled) >= 51 ? "51+" : "2-50");

/**
 * Normalised company name, used to recognise the same client across sources.
 *
 * Employee Navigator and the census do not always spell a company identically -
 * "Aesto Health" against "Aesto Health, LLC" - and matching on the raw string
 * imports the second as a brand new group, leaving the first behind as a stale
 * duplicate. Punctuation and legal-form words carry no identity, so they are
 * dropped; everything else is kept, so two genuinely different companies never
 * collapse into one.
 */
const LEGAL = new Set([
  "llc", "lc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "companies", "ltd", "limited", "lp", "llp", "pc", "pllc", "plc", "pa",
]);

export function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    // Periods and apostrophes are dropped rather than spaced, so "R.E." and
    // "RE" agree and "Mac's" and "Macs" agree.
    .replace(/[.'\u2019`"]/g, "")
    .replace(/&/g, " and ")
    .replace(/[,()\-/]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !LEGAL.has(w))
    .join(" ")
    .trim();
}

/**
 * A company name as a client reads it: the legal form at the end dropped,
 * with the comma before it. "Boss Logistics, LLC" -> "Boss Logistics",
 * "Atlas Welding Supply Co, Inc." -> "Atlas Welding Supply". Only trailing
 * words go, and never the last one left, so "Company" alone survives.
 */
const TRAILING_LEGAL = /[\s,]+(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|l\.?l\.?p\.?|l\.?p\.?|p\.?c\.?|p\.?l\.?l\.?c\.?|plc|p\.?a\.?)$/i;
export function shortName(name) {
  let s = String(name || "").trim();
  for (;;) {
    const next = s.replace(TRAILING_LEGAL, "").replace(/[\s,]+$/, "");
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

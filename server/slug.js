// The readable half of a group's address: the company name and its plan-year
// code, e.g. "Johnson Storage & Moving Co. Holdings, LLC" + "JSMH2027" ->
// `johnson-storage-moving-jsmh2027`. The same function lives in
// client/src/lib/router.ts; the two must agree, since the client builds the
// address and the server resolves it. The code makes every slug unique.
const SKIP_WORDS = new Set([
  "llc", "lc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "companies", "ltd", "limited", "lp", "llp", "pc", "pllc", "plc", "pa",
  "the", "of", "and", "a", "an",
]);

export function groupSlug(name, code) {
  const words = String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !SKIP_WORDS.has(w));
  const stem = words.slice(0, 5).join("-").slice(0, 60).replace(/-+$/, "");
  const tail = String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return [stem, tail].filter(Boolean).join("-") || "group";
}

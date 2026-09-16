// Which roster group a proposal reading points at.
//
// The reader is asked to copy the matched roster name exactly, and mostly
// does. But a carrier prints its own spelling — "tpi Global Solutions, Inc."
// on the quote, "tpiGlobalSolutions,Inc." in the file name — and a reading
// that mirrors the paper instead of the roster used to fail the exact string
// comparison and land in the queue as "needs assignment", however sure the
// reader was. So the reading is matched in order of trust, and the outcome
// says how it matched so the log and the screen can show it:
//
//   exact       the reader's matched_group is a roster name, verbatim;
//   normalized  the same name once punctuation and legal-form words go;
//   document    the reader named no roster group (or one not on it) but the
//               employer name it read off the paper identifies one roster
//               group by the invoice rule (every word in one name, or a
//               distinctive first word);
//   filename    the file name, or the email it came in, carries exactly one
//               roster name.
//
// Anything ambiguous stays unmatched: a proposal filed under the wrong
// company is worse than one waiting in the queue.
import { normalizeName } from "./group-id.js";
import { matchInvoiceName } from "./invoice-parse.js";

/**
 * Text a file name or email carries, spaced so names run together in a file
 * name still read as words: "01__01__2027_tpiGlobalSolutions,Inc._435483" ->
 * "01 01 2027 tpi Global Solutions, Inc. 435483".
 */
export function spacedOut(s) {
  return String(s || "")
    .replace(/[_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
}

/** The one roster group whose normalised name sits inside the text, or null. */
export function groupNamedIn(text, roster) {
  const hay = ` ${normalizeName(spacedOut(text))} `;
  const hits = roster.filter((g) => {
    const n = normalizeName(g.name);
    return n.length >= 4 && hay.includes(` ${n} `);
  });
  return hits.length === 1 ? hits[0].name : null;
}

/**
 * `reading` is the model's { matched_group, group_name_on_document };
 * `roster` is [{ name }]; `filename` and `context` (the email, if any) are
 * the last resort. Returns { name, how } or null.
 */
export function matchRosterGroup(reading, roster, filename, context) {
  const said = reading && reading.matched_group ? String(reading.matched_group).trim() : "";
  const onDoc = reading && reading.group_name_on_document ? String(reading.group_name_on_document).trim() : "";
  const names = roster.map((g) => g.name);

  if (said) {
    const exact = roster.find((g) => g.name === said);
    if (exact) return { name: exact.name, how: "exact" };
    const key = normalizeName(said);
    const same = key ? roster.filter((g) => normalizeName(g.name) === key) : [];
    if (same.length === 1) return { name: same[0].name, how: "normalized" };
  }
  for (const candidate of [onDoc, said]) {
    if (!candidate) continue;
    const byRule = matchInvoiceName(candidate, names, normalizeName);
    if (byRule) return { name: byRule, how: "document" };
  }
  const hay = [
    String(filename || "").replace(/\.[a-z0-9]+$/i, ""),
    context?.subject || "",
    context?.body || "",
  ].join(" \n ");
  const inText = groupNamedIn(hay, roster);
  if (inText) return { name: inText, how: "filename" };
  return null;
}

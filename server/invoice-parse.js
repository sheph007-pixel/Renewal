// Group-level facts from an Employee Navigator client invoice PDF: the header
// (invoice number, dates, amount billed) and the Charge Summary, one row per
// product and coverage tier. The per-employee Charge Detail carries names and
// masked SSNs and is not needed for a group baseline, so it is left out.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

// "$1,234.56" -> 1234.56, "($36.87)" -> -36.87, "-$14,187.19" -> -14187.19
const MONEY = String.raw`-?\(?\$[\d,]+\.\d{2}\)?`;
const money = (s) => {
  if (s == null) return null;
  const neg = /[()]/.test(s) || /^-/.test(s);
  const n = Number(s.replace(/[-$,()]/g, ""));
  return neg ? -n : n;
};
const r2 = (n) => Math.round(n * 100) / 100;
const COVERAGE = String.raw`Employee Only|Emp\.? \+ Spouse|Emp\.? \+ Children|Family|N/A`;

// "15150,000" -> count 15, volume 150000; "12,900" -> count 1, volume 2900;
// "5" -> count 5; "2-8,038" -> count 2, volume -8038; "" -> nothing.
function splitCountVolume(s) {
  if (!s) return { count: null, volume: null };
  const m = /^(\d*?)(-?\d{1,3}(?:,\d{3})+)$/.exec(s);
  if (m) return { count: m[1] ? Number(m[1]) : 1, volume: Number(m[2].replace(/,/g, "")) };
  return { count: Number(s), volume: null };
}

/**
 * Every Charge Summary block in the document: its product rows and the
 * "Total$charges$adjustments" line that closes it. A multi-entity invoice
 * prints one block per entity and sometimes a consolidated one after them.
 */
function parseBlocks(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const A = new RegExp(`^(${MONEY})(${COVERAGE})(\\d[\\d,]*)?$`);
  const B = new RegExp(`^(${MONEY})$`);
  const C = new RegExp(`^([\\d,]*-?[\\d,]*?)(${MONEY})(.+)$`);
  const T = new RegExp(`^Total(${MONEY})(${MONEY})$`);
  const TD = new RegExp(`^Total Due(${MONEY})$`);
  const pageNoise = (l) =>
    /^\d+\/\d+\/\d+ .*[AP]M$/.test(l) || /^Page \d+$/.test(l) || /^Invoice #\d+$/.test(l) || /Charge Summary$/.test(l) ||
    /^ChargesCharges/.test(l) || /^Adjustments$/.test(l) || /^ProductCoverage/.test(l) || /^Charges$/.test(l);
  const noise = (l) =>
    !l || pageNoise(l) || A.test(l) || B.test(l) || /^Total/.test(l) || /^\d+\/\d+\/\d+/.test(l) ||
    /Charge Detail/.test(l) || /^Charge Count:/.test(l);
  const nextIdx = (i) => {
    let j = i + 1;
    while (j < lines.length && pageNoise(lines[j])) j++;
    return j;
  };
  const blocks = [];
  let rows = [];
  const totalDues = [];
  for (let i = 0; i < lines.length; i++) {
    const td = TD.exec(lines[i]);
    if (td) {
      totalDues.push(money(td[1]));
      continue;
    }
    const t = T.exec(lines[i]);
    if (t) {
      blocks.push({ rows, charges: money(t[1]), adjustments: money(t[2]) });
      rows = [];
      continue;
    }
    const a = A.exec(lines[i]);
    if (!a) continue;
    const ib = nextIdx(i);
    const ic = nextIdx(ib);
    const bm = B.exec(lines[ib] || "");
    const cm = C.exec(lines[ic] || "");
    if (!bm || !cm) continue;
    let product = cm[3].trim();
    let last = ic;
    const inext = nextIdx(ic);
    if (!noise(lines[inext] || "")) {
      product += " " + lines[inext];
      last = inext;
    }
    const cv = splitCountVolume(a[3] || "");
    const av = splitCountVolume(cm[1] || "");
    const row = {
      product,
      coverage: a[2].replace("Emp.", "Emp"),
      count: cv.count,
      volume: cv.volume,
      adjustmentCount: av.count,
      adjustmentVolume: av.volume,
      charges: money(bm[1]),
      adjustments: money(a[1]),
      total: money(cm[2]),
    };
    // A row that straddles a page break is printed on both pages.
    const prev = rows[rows.length - 1];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(row)) rows.push(row);
    i = last;
  }
  return { blocks, totalDues };
}

/** The rows that make up the invoice: the consolidated block if there is one, else every entity's block. */
function chooseRows(blocks, totalDue) {
  const sum = (b) => r2(b.rows.reduce((s, r) => s + r.total, 0));
  const valid = blocks.filter((b) => b.rows.length && Math.abs(sum(b) - r2(b.charges + b.adjustments)) < 0.02);
  const meta = { blocksSeen: blocks.length, blocksValid: valid.length };
  if (totalDue != null) {
    const consolidated = valid.filter((b) => Math.abs(r2(b.charges + b.adjustments) - totalDue) < 0.02);
    if (consolidated.length) return { rows: consolidated[consolidated.length - 1].rows, how: "consolidated", ...meta };
  }
  return { rows: valid.flatMap((b) => b.rows), how: valid.length > 1 ? "entities" : "single", ...meta };
}

/** Parse the text of one invoice. Exported so the shape can be tested without a PDF. */
export function parseInvoiceText(text) {
  const get = (re) => {
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  const invoiceNumber = get(/Consolidated Invoice #(\d+)/) || get(/Invoice #(\d+)/);
  const hv = new RegExp(String.raw`Coverage Period:\s*\n(${MONEY})\s*\n(\d{2}/\d{2}/\d{4})\s*\n(\d{2}/\d{2}/\d{4}) - (\d{2}/\d{2}/\d{4})\s*\n(\d+)`).exec(text);
  const invoiceDate = get(/\n(\d{2}\/\d{2}\/\d{4})\n(?:[^\n]*\n){2,4}Consolidated Invoice/);
  const invoiceAmount = hv ? money(hv[1]) : null;
  const { blocks, totalDues } = parseBlocks(text);
  const totalDue =
    totalDues.find((d) => invoiceAmount != null && Math.abs(d - invoiceAmount) < 0.02) ??
    (totalDues.length ? totalDues[totalDues.length - 1] : null);
  const { rows, how, blocksSeen, blocksValid } = chooseRows(blocks, totalDue);
  const charges = r2(rows.reduce((s, r) => s + r.charges, 0));
  const adjustments = r2(rows.reduce((s, r) => s + r.adjustments, 0));
  const productSum = r2(rows.reduce((s, r) => s + r.total, 0));
  return {
    invoiceNumber,
    invoiceDate,
    invoiceAmount,
    dueDate: hv ? hv[2] : null,
    periodStart: hv ? hv[3] : null,
    periodEnd: hv ? hv[4] : null,
    charges,
    adjustments,
    productSum,
    totalDue,
    // Product rows tie out to Total Due, and Total Due is what the header bills.
    reconciles:
      totalDue != null &&
      Math.abs(productSum - totalDue) < 0.02 &&
      (invoiceAmount == null || Math.abs(invoiceAmount - totalDue) < 0.02),
    summaryLayout: how,
    blocksSeen,
    blocksValid,
    products: rows,
  };
}

/** Parse one invoice PDF (a Buffer). */
export async function parseInvoicePdf(buf) {
  const d = await pdfParse(buf);
  return { pages: d.numpages, ...parseInvoiceText(d.text) };
}

/** "Boss Logistics September Invoice.pdf" -> "Boss Logistics"; null if the name has no group in it. */
export function groupFromInvoiceFilename(base) {
  const name = base.replace(/\s+[A-Za-z]+ Invoice\.pdf$/i, "").trim();
  if (!name || name === base.replace(/\.pdf$/i, "")) return null;
  return name;
}

/** First words too common to identify a company on their own. */
const GENERIC_FIRST = new Set([
  "the", "first", "new", "south", "north", "east", "west", "alabama", "birmingham",
  "american", "united", "national", "southern", "greater", "central", "st", "saint",
  "mount", "city", "county", "group", "family", "medical", "clinic", "church", "school",
]);

/** Normalised words, with runs of single letters joined so "R E" and "RE" agree. */
function words(name, normalize) {
  return normalize(name).replace(/\b([a-z]) (?=[a-z]\b)/g, "$1").split(/\s+/).filter(Boolean);
}

/**
 * Which roster group an invoice belongs to, from the short name on the file.
 * The file says "Ashley Mac's" where the roster says "Ashley Mac's Holdings,
 * LLC", "Ursa Group" for "Ursa Logistics, LLC", "R E Garrison - 1099" for
 * "R.E. Garrison Trucking 1099". In order:
 *
 *   1. the same name once normalised;
 *   2. the one group whose name carries every word of the file's name — with
 *      several, the one with the fewest words left over, if that is unique;
 *   3. the one group sharing a distinctive first word (four letters or more,
 *      not a common opener), when no other group starts with it.
 *
 * Anything still ambiguous is left unmatched rather than filed under the wrong
 * company. Returns the roster name, or null.
 */
export function matchInvoiceName(name, roster, normalize) {
  const want = words(name, normalize);
  if (!want.length) return null;
  const key = want.join(" ");
  const cands = roster.map((r) => ({ name: r, words: words(r, normalize) }));
  const exact = cands.find((c) => c.words.join(" ") === key);
  if (exact) return exact.name;
  // A name made only of common words identifies nothing, whatever contains it.
  if (!want.some((w) => w.length >= 3 && !GENERIC_FIRST.has(w) && !/^\d+$/.test(w))) return null;
  // Every word of the file's name, in the roster name.
  const superset = cands
    .filter((c) => want.every((w) => c.words.includes(w)))
    .map((c) => ({ ...c, extra: c.words.length - want.length }))
    .sort((a, b) => a.extra - b.extra);
  if (superset.length === 1 || (superset.length > 1 && superset[0].extra < superset[1].extra)) return superset[0].name;
  if (superset.length > 1) return null;
  // A distinctive first word nobody else starts with.
  const first = want[0];
  if (first.length < 4 || GENERIC_FIRST.has(first) || /^\d+$/.test(first)) return null;
  const starts = cands.filter((c) => c.words[0] === first);
  return starts.length === 1 ? starts[0].name : null;
}

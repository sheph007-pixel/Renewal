// Targeted source packets for plan field audits.
//
// A plan field audit asks one question: "for these specific plans, what
// exact values does the cited source show?" It needs the pages (sheets,
// rows, lines) those plans are printed on - not the whole proposal again.
// The document-level reconciliation audit (server/proposal-audit.js) reads
// the complete source once per model per version; every field batch gets
// only the smallest complete packet for its plans, built from the
// provenance the reading kept (identity / benefit / rate pages, sheet and
// rows), with original page / row / line numbers preserved.
//
// Accuracy first: anything that cannot be shown to be complete falls back
// to the full source (`{ full: true, reason }`) - missing provenance, a page
// outside the document, a PDF that cannot be cut (encrypted carrier quotes),
// a sheet that cannot be found, rows that cannot be read, or a packet that
// would be most of the document anyway. The auditor can also say a packet
// lacked context; that batch is then read against the full source.
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";

/** A packet this close to the whole document is sent whole: no saving worth the risk. */
export const FULL_WHEN_SHARE = 0.8;
/** Rows at the top of a sheet kept as its header block (titles, network, tier labels, column headers). */
export const SHEET_HEADER_ROWS = 20;
/** Lines at the top of a text / CSV source kept as its header. */
export const TEXT_HEADER_LINES = 5;
/** Lines kept either side of a cited text range, for a continuation header. */
export const TEXT_MARGIN = 2;

const uniqSorted = (a) => [...new Set(a.filter((n) => Number.isInteger(n) && n > 0))].sort((x, y) => x - y);

/** Every page a plan's provenance cites (identity, benefits, rates). */
export const pagesOf = (pl) => {
  const s = pl.source_pages || pl.source || {};
  return uniqSorted([...(s.identity || []), ...(s.benefits || []), ...(s.rates || [])]);
};

/** Contiguous runs of page numbers: [3,4,5,9] -> [[3,5],[9,9]]. */
export function runs(pages) {
  const out = [];
  for (const p of pages) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

/**
 * The pages a PDF field batch needs: every page the batch's plans are cited
 * on, each once, plus context - page 1 (the cover: group, effective date,
 * funding, often the network) and the page before each run of cited pages
 * (a table continued from the previous page carries its column, network and
 * rate-tier headers there). Returns { pages, cited, context } or
 * { full: true, reason } when the provenance cannot support a packet.
 */
export function pdfPacketPages(plans, numpages) {
  if (!numpages) return { full: true, reason: "page count unknown" };
  const missing = plans.filter((pl) => !pagesOf(pl).length);
  if (missing.length) return { full: true, reason: `${missing.length} plan(s) without source pages` };
  const noRates = plans.filter((pl) => !((pl.source_pages || pl.source || {}).rates || []).length);
  if (noRates.length) return { full: true, reason: `${noRates.length} plan(s) without a rate page` };
  const cited = uniqSorted(plans.flatMap(pagesOf));
  if (cited.some((p) => p > numpages)) return { full: true, reason: "a cited page is past the end of the document" };
  const context = new Set([1]);
  for (const [from] of runs(cited)) if (from > 1) context.add(from - 1);
  const pages = uniqSorted([...cited, ...context]);
  if (pages.length >= numpages * FULL_WHEN_SHARE) return { full: true, reason: `packet would be ${pages.length} of ${numpages} pages` };
  return { pages, cited, context: [...context].filter((p) => !cited.includes(p)).sort((a, b) => a - b) };
}

/** A PDF of just these pages, in order. Throws for a PDF that cannot be rewritten (encrypted). */
export async function excerptPdf(buffer, pages) {
  const src = await PDFDocument.load(buffer);
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(src, pages.map((n) => n - 1));
  for (const pg of copied) doc.addPage(pg);
  return Buffer.from(await doc.save());
}

/** "row 18", "rows 12-14; row 30", "lines 40-52" -> [18] / [12,13,14,30] / [40..52]; null when nothing reads as a number. */
export function parseRows(s) {
  const out = [];
  for (const m of String(s || "").matchAll(/(\d+)\s*(?:-|to|\u2013)\s*(\d+)|(\d+)/g)) {
    if (m[3]) out.push(Number(m[3]));
    else {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (b < a || b - a > 2000) return null;
      for (let n = a; n <= b; n++) out.push(n);
    }
  }
  return out.length ? uniqSorted(out) : null;
}

const sheetsOf = (pl) =>
  String((pl.source_pages || pl.source || {}).sheet || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
const rowsOf = (pl) => (pl.source_pages || pl.source || {}).rows || "";

/**
 * A workbook batch: for each sheet the plans are cited on, the sheet's
 * header block and the cited rows, each row labelled with its original Excel
 * row number and its cells as the workbook holds them. Every other sheet -
 * other networks' rate sheets, a static benefits grid - is left out. Falls
 * back to full when a sheet or a row cannot be found.
 */
export function workbookPacket(buffer, plans, filename = "", { exactRows = true } = {}) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch {
    return { full: true, reason: "the workbook cannot be opened" };
  }
  const byName = new Map(wb.SheetNames.map((n) => [n.trim().toUpperCase(), n]));
  const want = new Map(); // sheet -> row numbers
  for (const pl of plans) {
    const sheets = sheetsOf(pl);
    if (!sheets.length) return { full: true, reason: `"${pl.name}" has no source sheet` };
    // Row numbers are only trusted when code recorded them (a parser); a
    // model's own row citations send the whole cited sheet instead.
    const rows = exactRows ? parseRows(rowsOf(pl)) : [];
    if (!rows) return { full: true, reason: `"${pl.name}" has no source rows` };
    for (const s of sheets) {
      const real = byName.get(s.toUpperCase());
      if (!real) return { full: true, reason: `sheet "${s}" is not in the workbook` };
      want.set(real, uniqSorted([...(want.get(real) || []), ...rows]));
    }
  }
  const blocks = [];
  const meta = [];
  for (const [name, rows] of want) {
    const ws = wb.Sheets[name];
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const rowAt = (excelRow) => grid[excelRow - 1 - range.s.r];
    const cell = (v) => (v == null ? "" : typeof v === "string" ? JSON.stringify(v) : String(v));
    const line = (n) => `R${n}: ${(rowAt(n) || []).map(cell).join(", ")}`;
    const lastRow = range.e.r + 1;
    if (rows.some((n) => n > lastRow)) return { full: true, reason: `a cited row is past the end of sheet "${name}"` };
    const header = [];
    for (let n = range.s.r + 1; n <= Math.min(lastRow, range.s.r + SHEET_HEADER_ROWS); n++) if ((rowAt(n) || []).some((v) => v != null && v !== "")) header.push(n);
    const every = [];
    if (!exactRows) for (let n = range.s.r + 1; n <= lastRow; n++) if ((rowAt(n) || []).some((v) => v != null && v !== "")) every.push(n);
    const all = uniqSorted([...header, ...rows, ...every]);
    blocks.push(`## Sheet: ${name} (rows ${describe(all)} of ${lastRow}; each line is "R<Excel row number>: cells")\n${all.map(line).join("\n")}`);
    meta.push({ sheet: name, rows: all, of: lastRow });
  }
  const text = blocks.join("\n\n");
  return { kind: "text", text, sheets: meta, note: `This packet holds only the sheets and rows the listed plans are cited on (plus each sheet's header rows) from the workbook ${filename}; row numbers are the workbook's own.` };
}

/**
 * A text / CSV batch: the source's first lines (its header) and each cited
 * line range with a small margin, every line prefixed with its original line
 * number. Falls back to full when a plan cites no lines, or a line is out of
 * range.
 */
export function textPacket(text, plans) {
  const lines = String(text || "").split("\n");
  const want = [];
  for (const pl of plans) {
    const rows = parseRows(rowsOf(pl));
    if (!rows) return { full: true, reason: `"${pl.name}" has no source lines` };
    if (rows.some((n) => n > lines.length)) return { full: true, reason: "a cited line is past the end of the document" };
    for (const [a, b] of runs(rows)) for (let n = Math.max(1, a - TEXT_MARGIN); n <= Math.min(lines.length, b + TEXT_MARGIN); n++) want.push(n);
  }
  for (let n = 1; n <= Math.min(lines.length, TEXT_HEADER_LINES); n++) want.push(n);
  // A flattened workbook: keep the "## Sheet:" heading each cited line sits under.
  for (const n of [...want]) {
    for (let k = n; k >= 1; k--) {
      if (/^## Sheet:/.test(lines[k - 1] || "")) {
        want.push(k);
        break;
      }
    }
  }
  const keep = uniqSorted(want);
  if (keep.length >= lines.length * FULL_WHEN_SHARE) return { full: true, reason: `packet would be ${keep.length} of ${lines.length} lines` };
  const body = keep.map((n) => `L${n}: ${lines[n - 1]}`).join("\n");
  return { kind: "text", text: body, lines: keep, of: lines.length, note: `This packet holds only lines ${describe(keep)} of the ${lines.length}-line document (each line is "L<original line number>: text").` };
}

/** [1,2,3,7,9,10] -> "1-3, 7, 9-10". */
export function describe(nums) {
  return runs(uniqSorted(nums))
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(", ");
}

/**
 * The packet for one field batch. `prepared` is what the model would get for
 * the whole file (intake.prepareForModel); `source` is the original file
 * { buffer, mime, filename } (a workbook is cut from the file itself);
 * `plans` are the batch's stored plans with provenance. Returns either
 *   { full: false, kind: "pdf", buffer, pages, cited, context, of }
 *   { full: false, kind: "text", text, note, sheets?|lines? }
 *   { full: true, reason }
 */
export async function buildPacket({ prepared, source, plans, numpages, exactRows = false }) {
  if (!prepared || prepared.kind === "image") return { full: true, reason: "an image is sent whole" };
  if (prepared.kind === "pdf") {
    const pick = pdfPacketPages(plans, numpages);
    if (pick.full) return pick;
    try {
      const buffer = await excerptPdf(prepared.buffer, pick.pages);
      return { full: false, kind: "pdf", buffer, pages: pick.pages, cited: pick.cited, context: pick.context, of: numpages };
    } catch (e) {
      return { full: true, reason: `the PDF cannot be cut into pages (${e.message.slice(0, 80)})` };
    }
  }
  const isWorkbook = /\.(xlsx|xlsm|xls)$/i.test(String(source && source.filename)) || /spreadsheet|excel/i.test(String(source && source.mime));
  if (isWorkbook && source && source.buffer) return { full: false, ...workbookPacket(source.buffer, plans, source.filename, { exactRows }) };
  if (prepared.truncated) return { full: true, reason: "the text was cut at the size limit" };
  // A text or CSV source read by a model: its line citations are the
  // model's own estimates, not positions code recorded - the field batch
  // reads the whole text (accuracy first).
  if (!exactRows) return { full: true, reason: "line citations were not recorded by code" };
  return { full: false, ...textPacket(prepared.text, plans) };
}

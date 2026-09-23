// Documents the assistant hands a client: a side-by-side comparison of 2027
// options at the group's own census (PDF or Excel), and a memo or
// announcement the model has written (PDF or Word). The comparison's numbers
// are computed here from the same figures the pages use, never by the model;
// the model only chooses which plans to put next to each other.
import PDFDocument from "pdfkit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { networkLabel } from "./proposal-kind.js";
import * as XLSX from "xlsx";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from "docx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The same benefit summaries the pages and the assistant read - here for the
// one figure a "Today (2026)" row needs that the census itself never carries:
// deductible and OOP max on the plan the group is in now.
const LEGACY_DESIGNS = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "benefit-summaries.json"), "utf8")).filter((d) => d.category === "medical-legacy");
const normPlan = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The legacy design a current plan's name is - "EBPA Deluxe Platinum" carries "Deluxe Platinum" - or null when none matches. */
function legacyDesignFor(planName) {
  const n = normPlan(planName);
  if (!n) return null;
  return LEGACY_DESIGNS.find((d) => n.includes(normPlan(d.name))) || null;
}
// Google Sans Flex, embedded so every PDF carries its own glyphs rather than
// falling back to whatever the reader's OS has installed. Static Regular/Bold
// instances, cut from Google's variable font (it has no italic axis - places
// that used to ask for "GSF" get the regular weight instead).
const FONT_REGULAR = path.join(__dirname, "assets/fonts/GoogleSansFlex-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "assets/fonts/GoogleSansFlex-Bold.ttf");

const TIER_KEYS = ["EE", "ES", "EC", "FAM"];
const TIER_CENSUS = { EE: "Employee", ES: "Employee + Spouse", EC: "Employee + Child(ren)", FAM: "Employee + Family" };
const TIER_LABEL = { EE: "Employee", ES: "EE + Spouse", EC: "EE + Child(ren)", FAM: "EE + Family" };

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? "-" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money0 = (n) => (n == null || !Number.isFinite(Number(n)) ? "-" : "$" + Math.round(Number(n)).toLocaleString("en-US"));
const signed = (n) => (n == null ? "-" : (n < 0 ? "-" : "+") + money0(Math.abs(n)));
const round2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const safeName = (s) => String(s || "document").replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "document";

const slotCarrier = (slot, carrier) => {
  if (/^UHC|Surest/.test(slot || "")) return "UnitedHealthcare";
  return carrier || slot || "-";
};
// Funding is one of two things: UnitedHealthcare quotes fully insured and
// level funded in separate slots; every other carrier and partner is level
// funded, whatever wording its quote uses.
const slotFunding = (slot) => (slot === "UHC Fully Insured" ? "Fully insured" : "Level funded");

/**
 * The rows of a comparison: what is in force today, then the chosen 2027
 * options priced at the group's tier counts. `plans` are the names the model
 * picked; each is matched against the quotes on file, loosely, and anything
 * that matches nothing is reported rather than invented. `contribution` is an
 * optional employer amount per tier per month, for the split columns.
 */
export function comparisonTable({ group: g, proposals, plans, includeCurrent = true, contribution }) {
  const counts = g.tiers || { EE: 0, ES: 0, EC: 0, FAM: 0 };
  const todayTotal = g.monthly ?? null;
  const rows = [];
  const notes = [];

  const splitFor = (rates) => {
    if (!contribution) return { er: null, ee: null };
    let er = 0;
    let ee = 0;
    for (const k of TIER_KEYS) {
      const n = counts[k] || 0;
      const r = rates[k];
      if (!n) continue;
      if (r == null) return { er: null, ee: null };
      const c = Math.min(Math.max(Number(contribution[k]) || 0, 0), r);
      er += c * n;
      ee += (r - c) * n;
    }
    return { er: round2(er), ee: round2(ee) };
  };

  if (includeCurrent) {
    for (const p of g.plans || []) {
      const billed = (g.rates || {})[p.plan] || {};
      const per = (g.planTiers || {})[p.plan] || {};
      const rates = {};
      TIER_KEYS.forEach((k) => (rates[k] = billed[TIER_CENSUS[k]] ?? null));
      let er = null;
      let ee = null;
      if (contribution) {
        er = 0;
        ee = 0;
        for (const k of TIER_KEYS) {
          const n = per[k] || 0;
          const r = rates[k];
          if (!n || r == null) continue;
          const c = Math.min(Math.max(Number(contribution[k]) || 0, 0), r);
          er += c * n;
          ee += (r - c) * n;
        }
        er = round2(er);
        ee = round2(ee);
      }
      const legacy = legacyDesignFor(p.plan);
      rows.push({
        section: "Today (2026)",
        name: p.plan,
        carrier: p.tpa || g.tpa || "-",
        funding: "In force",
        network: "-",
        deductible: legacy?.summary.deductibleIndividual || "-",
        oopMax: legacy?.summary.oopMaxIndividual || "-",
        rates,
        enrolled: p.enrolled,
        monthly: p.monthly ?? null,
        annual: p.monthly != null ? round2(p.monthly * 12) : null,
        vsToday: null,
        er,
        ee,
      });
    }
  }

  const wanted = (plans || []).map((s) => String(s || "").trim()).filter(Boolean);
  const all = [];
  for (const pr of proposals || []) for (const pl of pr.plans || []) all.push({ pr, pl });
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const used = new Set();
  for (const w of wanted) {
    const nw = norm(w);
    let hit = all.find((x) => x.pl.optionId && norm(x.pl.optionId) === nw && !used.has(x)) || all.find((x) => norm(x.pl.name) === nw && !used.has(x)) || all.find((x) => (norm(x.pl.name).includes(nw) || nw.includes(norm(x.pl.name))) && !used.has(x)) || all.find((x) => x.pl.planCode && norm(x.pl.planCode) === nw && !used.has(x));
    if (!hit) {
      notes.push(`"${w}" did not match a quoted plan on file, so it is not in the table.`);
      continue;
    }
    used.add(hit);
    const { pr, pl } = hit;
    const rates = {};
    TIER_KEYS.forEach((k) => (rates[k] = pl.rates && pl.rates[k] != null ? Number(pl.rates[k]) : null));
    let monthly = 0;
    let priced = true;
    for (const k of TIER_KEYS) {
      const n = counts[k] || 0;
      if (!n) continue;
      if (rates[k] == null) {
        priced = false;
        break;
      }
      monthly += rates[k] * n;
    }
    monthly = priced ? round2(monthly) : null;
    const { er, ee } = splitFor(rates);
    rows.push({
      section: "2027 options",
      // The one way a plan is named everywhere: Carrier/TPA, Option, ID; the long document name under it.
      name: pl.optionId ? `${slotCarrier(pr.slot, pr.carrier)} Option ${pl.optionId}\n${pl.name}` : pl.name,
      carrier: slotCarrier(pr.slot, pr.carrier),
      funding: slotFunding(pr.slot),
      network: networkLabel(pl.network) || "-",
      deductible: pl.deductible || "-",
      oopMax: pl.oopMax || "-",
      rates,
      enrolled: g.enrolled,
      monthly,
      annual: monthly != null ? round2(monthly * 12) : null,
      vsToday: monthly != null && todayTotal != null ? round2(monthly - todayTotal) : null,
      er,
      ee,
      benefits: pl.benefits || null,
    });
  }
  if (!rows.length) notes.push("Nothing to compare: no current plans on file and none of the requested options matched.");
  return { rows, notes, counts, todayTotal, contribution: contribution || null };
}

/** The comparison as plain text, for the model to read back what it made. */
export function comparisonText(table) {
  const lines = [];
  for (const r of table.rows) {
    const rates = TIER_KEYS.map((k) => `${k} ${money(r.rates[k])}`).join(", ");
    lines.push(`${r.section} - ${r.name} (${r.carrier}, ${r.funding}): ${rates}; monthly ${money(r.monthly)}; annual ${money0(r.annual)}${r.vsToday != null ? `; vs today ${signed(r.vsToday)}/mo` : ""}${r.er != null ? `; employer ${money(r.er)}/mo, employees ${money(r.ee)}/mo` : ""}`);
  }
  for (const n of table.notes) lines.push(`Note: ${n}`);
  return lines.join("\n");
}

const SHORT_TIER = { EE: "EE", ES: "EE+SP", EC: "EE+CH", FAM: "Family" };
const columnsFor = (table) => {
  const cols = [
    { key: "name", label: "Plan", width: 118, align: "left" },
    { key: "carrier", label: "Carrier/TPA / funding", width: 80, align: "left" },
    { key: "deductible", label: "Deductible", width: 52, align: "left" },
    { key: "oopMax", label: "OOP max", width: 52, align: "left" },
    ...TIER_KEYS.map((k) => ({ key: `rate_${k}`, label: `${SHORT_TIER[k]} (${table.counts[k] || 0})`, width: 50, align: "right" })),
    { key: "monthly", label: "Monthly", width: 58, align: "right" },
    { key: "annual", label: "Annual", width: 54, align: "right" },
    ...(table.todayTotal != null ? [{ key: "vsToday", label: "vs today /mo", width: 50, align: "right" }] : []),
  ];
  if (table.contribution) {
    cols.push({ key: "er", label: "Employer /mo", width: 56, align: "right" });
    cols.push({ key: "ee", label: "Employees /mo", width: 56, align: "right" });
  }
  return cols;
};
const cellText = (r, key) => {
  if (key.startsWith("rate_")) return money(r.rates[key.slice(5)]);
  if (key === "monthly" || key === "er" || key === "ee") return money(r[key]);
  if (key === "annual") return money0(r.annual);
  if (key === "vsToday") return r.vsToday == null ? (r.section.startsWith("Today") ? "" : "-") : signed(r.vsToday);
  if (key === "carrier") return `${r.carrier}\n${r.funding}`;
  return r[key] == null ? "-" : String(r[key]);
};

// --------------------------------------------------------------------- PDF

function pdfBuffer(build, opts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 40, bufferPages: true, ...opts });
    doc.registerFont("GSF", FONT_REGULAR);
    doc.registerFont("GSF-Bold", FONT_BOLD);
    doc.font("GSF");
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      build(doc);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

const NAVY = "#0F2A47";
const INK = "#333333";
const MUTED = "#6b7276";
const RULE = "#dfe3e6";

function pdfHeader(doc, { title, groupName, subtitle }) {
  doc.font("GSF-Bold").fontSize(9).fillColor("#1F8A5B").text("BenSync", doc.page.margins.left, 24, { continued: true }).fillColor(MUTED).font("GSF").text("  ·  Kennion Benefit Advisors");
  doc.moveDown(0.4);
  doc.font("GSF-Bold").fontSize(17).fillColor(NAVY).text(title);
  doc.moveDown(0.15);
  doc.font("GSF").fontSize(10).fillColor(MUTED).text(`${groupName}${subtitle ? `  ·  ${subtitle}` : ""}  ·  Prepared ${today()}`);
  doc.moveDown(0.8);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(0.6).strokeColor(RULE).stroke();
  doc.moveDown(0.6);
}

function pdfFooter(doc, { caption } = {}) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing below the bottom margin would open a new page; lift it for the footer.
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font("GSF").fontSize(7.5).fillColor(MUTED).text(
      `${caption || "Monthly composite rates at the group's current enrollment, from the Carrier/TPA quotes on file"}  ·  Page ${i - range.start + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - 24,
      { width: w, align: "center", lineBreak: false },
    );
    doc.page.margins.bottom = keep;
  }
}

/** A grid with a shaded header, wrapping cells and page breaks. Returns the y after it. */
function pdfTable(doc, { columns, rows, fontSize = 8, sectionOf }) {
  const x = doc.page.margins.left;
  const width = columns.reduce((n, c) => n + c.width, 0);
  const scale = Math.min(1, (doc.page.width - doc.page.margins.left - doc.page.margins.right) / width);
  const cols = columns.map((c) => ({ ...c, width: c.width * scale }));
  const pad = 4;
  const bottom = doc.page.height - 50;
  const header = () => {
    doc.font("GSF-Bold").fontSize(fontSize);
    const h = Math.max(...cols.map((c) => doc.heightOfString(c.label, { width: c.width - pad * 2 }))) + 10;
    doc.rect(x, doc.y, cols.reduce((n, c) => n + c.width, 0), h).fill("#202429");
    let cx = x;
    const y = doc.y;
    doc.fillColor("#ffffff");
    for (const c of cols) {
      doc.text(c.label, cx + pad, y + 5, { width: c.width - pad * 2, align: c.align });
      cx += c.width;
    }
    doc.y = y + h;
  };
  header();
  let lastSection = null;
  for (const r of rows) {
    doc.font("GSF").fontSize(fontSize);
    const texts = cols.map((c) => c.text(r));
    const h = Math.max(...texts.map((t, i) => doc.heightOfString(t || " ", { width: cols[i].width - pad * 2 }))) + pad * 2;
    const section = sectionOf ? sectionOf(r) : null;
    const needSection = section && section !== lastSection;
    if (doc.y + h + (needSection ? 16 : 0) > bottom) {
      doc.addPage();
      header();
      lastSection = null;
    }
    if (needSection) {
      doc.font("GSF-Bold").fontSize(fontSize).fillColor(NAVY).text(section, x + pad, doc.y + 4, { lineBreak: false });
      doc.y += 16;
      lastSection = section;
      doc.font("GSF").fontSize(fontSize);
    }
    const y = doc.y;
    let cx = x;
    texts.forEach((t, i) => {
      const c = cols[i];
      doc.fillColor(c.strong && c.strong(r) ? NAVY : INK).font(c.strong && c.strong(r) ? "GSF-Bold" : "GSF");
      doc.text(t, cx + pad, y + pad, { width: c.width - pad * 2, align: c.align });
      cx += c.width;
    });
    doc.y = y + h;
    doc.moveTo(x, doc.y).lineTo(x + cols.reduce((n, c) => n + c.width, 0), doc.y).lineWidth(0.4).strokeColor(RULE).stroke();
  }
  // Positioned text leaves the cursor in the last column; what follows starts at the margin again.
  doc.x = x;
  doc.fillColor(INK).font("GSF");
  return doc.y;
}

export async function renderComparison({ format, title, group: g, table }) {
  const name = title || "2027 Medical Options - Comparison";
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "xlsx") {
    const cols = columnsFor(table);
    const aoa = [[name], [g.name, `Prepared ${today()}`], [], cols.map((c) => c.label)];
    let section = null;
    for (const r of table.rows) {
      if (r.section !== section) {
        aoa.push([r.section]);
        section = r.section;
      }
      aoa.push(cols.map((c) => {
        if (c.key.startsWith("rate_")) return r.rates[c.key.slice(5)];
        if (["monthly", "annual", "vsToday", "er", "ee"].includes(c.key)) return r[c.key];
        return r[c.key] == null ? "" : r[c.key];
      }));
    }
    aoa.push([]);
    aoa.push([`Enrollment by tier: ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${table.counts[k] || 0}`).join(", ")}`]);
    if (table.contribution) aoa.push([`Employer contribution modeled at: ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${money(table.contribution[k])}`).join(", ")} per month`]);
    for (const n of table.notes) aoa.push([n]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = cols.map((c) => ({ wch: Math.max(10, Math.round(c.width / 6)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Comparison");
    const data = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    return { filename: `${safeName(g.name)} - ${safeName(name)} ${stamp}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data };
  }
  const data = await pdfBuffer(
    (doc) => {
      pdfHeader(doc, { title: name, groupName: g.name, subtitle: `${g.enrolled} enrolled · effective January 1, 2027` });
      const cols = columnsFor(table).map((c) => ({ ...c, text: (r) => cellText(r, c.key), strong: c.key === "name" ? () => true : c.key === "monthly" ? () => true : null }));
      pdfTable(doc, { columns: cols, rows: table.rows, sectionOf: (r) => r.section, fontSize: 7.5 });
      doc.moveDown(1);
      doc.font("GSF").fontSize(8.5).fillColor(MUTED);
      doc.text(`Enrollment by tier: ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${table.counts[k] || 0}`).join(" · ")}.`);
      if (table.todayTotal != null) doc.text(`Today's total medical premium: ${money(table.todayTotal)} per month (${money0(table.todayTotal * 12)} per year).`);
      if (table.contribution) doc.text(`Employer contribution modeled at ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${money(table.contribution[k])}`).join(", ")} per month; employees pay the rest.`);
      for (const n of table.notes) doc.text(n);
      const withBenefits = table.rows.filter((r) => r.benefits && Object.values(r.benefits).some(Boolean));
      if (withBenefits.length) {
        doc.moveDown(1);
        doc.font("GSF-Bold").fontSize(10).fillColor(NAVY).text("In-network benefits, as printed on the quotes");
        doc.moveDown(0.3);
        const bcols = [
          { key: "name", label: "Plan", width: 150, align: "left", text: (r) => r.name, strong: () => true },
          { key: "pcp", label: "Doctor visit", width: 90, align: "left", text: (r) => r.benefits.doctorVisit || "-" },
          { key: "spec", label: "Specialist", width: 90, align: "left", text: (r) => r.benefits.specialist || "-" },
          { key: "uc", label: "Urgent care", width: 90, align: "left", text: (r) => r.benefits.urgentCare || "-" },
          { key: "img", label: "Imaging / labs", width: 100, align: "left", text: (r) => r.benefits.imaging || "-" },
          { key: "hosp", label: "Hospital", width: 100, align: "left", text: (r) => r.benefits.hospital || "-" },
          { key: "rx", label: "Prescriptions", width: 110, align: "left", text: (r) => r.benefits.rx || "-" },
        ];
        pdfTable(doc, { columns: bcols, rows: withBenefits });
      }
      pdfFooter(doc);
    },
    { layout: "landscape", margin: 30 },
  );
  return { filename: `${safeName(g.name)} - ${safeName(name)} ${stamp}.pdf`, mime: "application/pdf", data };
}

// ------------------------------------------------------------ Plan workbook

/**
 * Every 2027 plan's card as one row of a workbook: the columns and rows come
 * from the page (the same figures the plan card shows, at the group's
 * enrollment and applied contribution), so the file reads exactly like the
 * screen. Sheet "Plans" is the table, header in row 1 so Excel's filters
 * work; sheet "About" says whose figures they are.
 */
export function renderPlanSheet({ group: g, columns, rows, contribution }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const ws = XLSX.utils.aoa_to_sheet([columns, ...rows]);
  ws["!cols"] = columns.map((c, i) => {
    const longest = rows.reduce((n, r) => Math.max(n, String(r[i] == null ? "" : r[i]).length), String(c).length);
    return { wch: Math.min(44, Math.max(9, longest + 2)) };
  });
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: Math.max(0, columns.length - 1) } }) };
  const counts = g.tiers || {};
  const about = [
    ["2027 Medical Plans"],
    [g.name],
    [`Prepared ${today()}`],
    [],
    ["Enrollment by tier", TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${counts[k] || 0}`).join(", ")],
    ["Enrolled", TIER_KEYS.reduce((n, k) => n + (counts[k] || 0), 0)],
    ...(contribution ? [["Employer contribution applied", `${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${money(contribution[k])}`).join(", ")} per month; employees pay the rest of their tier's rate.`]] : []),
    [],
    ["Every 2027 plan quoted for the group, one row each, with the same details the plan card shows: benefits as printed on the carrier's quote, monthly composite rates by tier, and the split at the employer contribution applied on the Medical Plans page."],
  ];
  const wa = XLSX.utils.aoa_to_sheet(about);
  wa["!cols"] = [{ wch: 30 }, { wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Plans");
  XLSX.utils.book_append_sheet(wb, wa, "About");
  const data = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return { filename: `${safeName(g.name)} - 2027 Medical Plans ${stamp}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data };
}

// ------------------------------------------------------------ One plan's card

/**
 * One plan's card as a page: what the client sees when they open a plan on
 * the grid, laid out for print. The page sends the card as it shows it
 * (title, the benefit rows, the rates by tier with the split at the applied
 * contribution, the totals); this only lays it out, so the file and the
 * screen never disagree.
 */
export async function renderPlanCardPdf({ group: g, card }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const data = await pdfBuffer((doc) => {
    const x0 = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    pdfHeader(doc, { title: card.title, groupName: g.name, subtitle: [card.carrier, card.funding, card.type].filter(Boolean).join(" · ") });
    if (card.subtitle) {
      doc.font("GSF").fontSize(10).fillColor(MUTED).text(card.subtitle, x0, doc.y - 4, { width });
      doc.moveDown(0.6);
    }
    // The headline: the average employee's monthly share, and what the company pays.
    const y = doc.y;
    doc.rect(x0, y, width, 58).fill(TINT);
    doc.font("GSF-Bold").fontSize(22).fillColor(NAVY).text(card.headline.average == null ? "-" : money(card.headline.average), x0, y + 9, { width, align: "center" });
    doc.font("GSF").fontSize(8.5).fillColor(MUTED).text("Average Employee Monthly Contribution", x0, y + 34, { width, align: "center" });
    doc.font("GSF-Bold").fontSize(9).fillColor(INK).text(`Your Company Pays ${card.headline.companyPays == null ? "-" : money(card.headline.companyPays)} / month  ·  ${card.headline.basis || ""}`, x0, y + 45, { width, align: "center" });
    doc.x = x0;
    doc.y = y + 70;
    // Two columns: what it covers on the left, what it costs on the right.
    const gap = 24;
    const colW = (width - gap) / 2;
    const top = doc.y;
    doc.font("GSF-Bold").fontSize(10).fillColor(NAVY).text("What it covers", x0, top, { width: colW });
    let ly = top + 16;
    for (const [label, value, url] of card.benefits || []) {
      doc.font("GSF").fontSize(8.5).fillColor(MUTED).text(label, x0, ly, { width: 100, lineBreak: false });
      doc.font("GSF").fontSize(8.5).fillColor(INK);
      const vh = doc.heightOfString(String(value == null ? "-" : value), { width: colW - 104 });
      doc.text(String(value == null ? "-" : value), x0 + 104, ly, { width: colW - 104, align: "right" });
      if (url) doc.fillColor("#1F8A5B").fontSize(7.5).text(label === "Network" ? "Find a doctor" : "Formulary", x0 + 104, ly + vh, { width: colW - 104, align: "right", link: url, lineBreak: false });
      ly += vh + (url ? 10 : 0) + 4;
      doc.moveTo(x0, ly - 1).lineTo(x0 + colW, ly - 1).lineWidth(0.3).strokeColor(RULE).stroke();
    }
    const leftEnd = ly;
    const rx = x0 + colW + gap;
    doc.font("GSF-Bold").fontSize(10).fillColor(NAVY).text("Monthly Composite Rates", rx, top, { width: colW });
    let ry = top + 16;
    const cw = [colW - 3 * 50, 50, 50, 50];
    const rowText = (cells, bold = false, color = INK) => {
      let cx = rx;
      cells.forEach((c, i) => {
        doc.font(bold ? "GSF-Bold" : "GSF").fontSize(8).fillColor(color).text(c, cx, ry, { width: cw[i] - 4, align: i ? "right" : "left", lineBreak: false, height: 10, ellipsis: true });
        cx += cw[i];
      });
      ry += 14;
    };
    rowText(["", "Rate", "Employer", "Employee"], false, MUTED);
    for (const t of card.tiers || []) rowText([`${t.label} (${t.count})`, t.rate == null ? "-" : money(t.rate), t.er == null || !t.count ? "-" : money(t.er), t.ee == null || !t.count ? "-" : money(t.ee)]);
    ry += 4;
    doc.moveTo(rx, ry).lineTo(rx + colW, ry).lineWidth(0.5).strokeColor(RULE).stroke();
    ry += 6;
    const tot = card.totals || {};
    const pct = () => "";
    const totalRow = (label, v, strong) => {
      doc.font(strong ? "GSF-Bold" : "GSF").fontSize(9).fillColor(INK).text(label, rx, ry, { width: colW - 120, lineBreak: false });
      doc.text(`${v == null ? "-" : money(v)}${strong ? pct(v) : ""}`, rx + colW - 120, ry, { width: 120, align: "right", lineBreak: false });
      ry += 15;
    };
    totalRow("Your Company Pays", tot.er, true);
    totalRow("Your Employees Pay", tot.ee, true);
    totalRow("Total Monthly Bill", tot.premium, false);
    doc.x = x0;
    doc.y = Math.max(leftEnd, ry) + 14;
    doc.font("GSF").fontSize(8.5).fillColor(MUTED);
    if (tot.enrolled != null) doc.text(`Priced at ${tot.enrolled} enrolled; the employer contribution applied on the Medical Plans page.`, { width });
    if (card.audit) doc.text(card.audit, { width });
    pdfFooter(doc);
  });
  return { filename: `${safeName(g.name)} - ${safeName(card.title)} ${stamp}.pdf`, mime: "application/pdf", data };
}

// ------------------------------------------------------------ AI Picks report

const PICK_LABEL = { lower_cost: "Lower Cost", best_fit: "Best Fit", richer_benefits: "Richer Benefits" };
const PICK_ORDER = ["lower_cost", "best_fit", "richer_benefits"];
const PICK_COLOR = { lower_cost: "#1F8A5B", best_fit: "#0F2A47", richer_benefits: "#e8781a" };
const GREEN = "#1F8A5B";
const TINT = "#f3f5f7";

/** A row of small labelled figures, each in a light box; returns the y below them. */
function pdfStats(doc, stats) {
  const x0 = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 8;
  const w = (width - gap * (stats.length - 1)) / stats.length;
  const h = 44;
  const y = doc.y;
  stats.forEach((st, i) => {
    const x = x0 + i * (w + gap);
    doc.rect(x, y, w, h).fill(TINT);
    doc.font("GSF").fontSize(7.5).fillColor(MUTED).text(st.label.toUpperCase(), x + 8, y + 8, { width: w - 16, lineBreak: false });
    doc.font("GSF-Bold").fontSize(13).fillColor(NAVY).text(st.value, x + 8, y + 20, { width: w - 16, lineBreak: false });
    if (st.note) doc.font("GSF").fontSize(7.5).fillColor(MUTED).text(st.note, x + 8, y + 34, { width: w - 16, lineBreak: false });
  });
  doc.x = x0;
  doc.y = y + h + 12;
  doc.fillColor(INK).font("GSF");
}

/** Vertical bars with a label under each and the count above; drawn in a box at (x, y) of the given width. */
function pdfBars(doc, { x, y, width, title, bars, color }) {
  const height = 96;
  doc.font("GSF-Bold").fontSize(9).fillColor(NAVY).text(title, x, y, { width, lineBreak: false });
  const top = y + 18;
  const base = top + height - 22;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const gap = 10;
  const w = (width - gap * (bars.length - 1)) / bars.length;
  doc.moveTo(x, base + 0.5).lineTo(x + width, base + 0.5).lineWidth(0.6).strokeColor(RULE).stroke();
  bars.forEach((b, i) => {
    const bx = x + i * (w + gap);
    const bh = Math.round(((base - top - 12) * b.value) / max);
    doc.rect(bx, base - bh, w, bh).fill(b.value ? color : RULE);
    doc.font("GSF-Bold").fontSize(8).fillColor(INK).text(String(b.value), bx, base - bh - 11, { width: w, align: "center", lineBreak: false });
    doc.font("GSF").fontSize(7.5).fillColor(MUTED).text(b.label, bx, base + 4, { width: w, align: "center", lineBreak: false });
  });
  doc.fillColor(INK).font("GSF");
  return top + height;
}

/** Horizontal bars, one per pick, longest to the page width; today's bill as a dashed line when known. */
function pdfBillChart(doc, { rows, todayTotal }) {
  const x0 = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelW = 236;
  const valueW = 56;
  const barW = width - labelW - valueW;
  const rowH = 18;
  const max = Math.max(1, ...rows.map((r) => r.monthly || 0), todayTotal || 0);
  const y0 = doc.y;
  rows.forEach((r, i) => {
    const y = y0 + i * rowH;
    doc.font("GSF").fontSize(7.5).fillColor(INK).text(r.label, x0, y + 4, { width: labelW - 8, height: 10, ellipsis: true });
    const w = Math.max(2, Math.round((barW * (r.monthly || 0)) / max));
    doc.rect(x0 + labelW, y + 3, w, rowH - 7).fill(r.color);
    doc.font("GSF-Bold").fontSize(8).fillColor(INK).text(money0(r.monthly), x0 + labelW + barW + 6, y + 4, { width: valueW - 6, lineBreak: false });
  });
  const bottom = y0 + rows.length * rowH;
  if (todayTotal) {
    const tx = x0 + labelW + Math.round((barW * todayTotal) / max);
    doc.moveTo(tx, y0 - 2).lineTo(tx, bottom + 2).lineWidth(0.8).dash(3, { space: 2 }).strokeColor(MUTED).stroke().undash();
    doc.font("GSF").fontSize(7.5).fillColor(MUTED).text(`Today ${money0(todayTotal)}`, tx - 60, bottom + 4, { width: 120, align: "center", lineBreak: false });
  }
  doc.x = x0;
  doc.y = bottom + (todayTotal ? 18 : 8);
  doc.fillColor(INK).font("GSF");
}

/**
 * The AI Picks as a document the client can keep: the census the picks were
 * weighed on, each pick with the assistant's reason, the bills side by side
 * and where to start. `recommendations` is the stored record (summary,
 * startWith, picks with reasons); `contribution` is the employer amount per
 * tier the page had applied, so the split matches what the client saw.
 */
export async function renderPicksReport({ group: g, proposals, recommendations: rec, contribution }) {
  const picks = Array.isArray(rec && rec.picks) ? rec.picks : [];
  // The picks stand against each other only: the plans in force today are not
  // an option for 2027, so nothing here says how a pick compares with today.
  const table = comparisonTable({ group: g, proposals, plans: picks.map((p) => p.optionId), includeCurrent: false, contribution });
  table.todayTotal = null;
  for (const r of table.rows) r.vsToday = null;
  const rowFor = (p) => table.rows.find((r) => r.section !== "Today (2026)" && r.name.includes(` Option ${p.optionId}\n`)) || null;
  const census = g.census || null;
  const counts = table.counts || {};
  const enrolled = TIER_KEYS.reduce((n, k) => n + (counts[k] || 0), 0);
  const ran = rec && rec.createdAt ? new Date(rec.createdAt) : new Date();
  const ranOn = ran.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const lineups = [];
  for (const p of picks) {
    const key = `${p.carrier}|${p.funding || ""}`;
    let l = lineups.find((x) => x.key === key);
    if (!l) lineups.push((l = { key, carrier: p.carrier, funding: p.funding || "", picks: [] }));
    l.picks.push(p);
  }
  for (const l of lineups) l.picks.sort((a, b) => PICK_ORDER.indexOf(a.tier) - PICK_ORDER.indexOf(b.tier));
  const stamp = new Date().toISOString().slice(0, 10);

  const data = await pdfBuffer((doc) => {
    const x0 = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = doc.page.height - 60;
    const room = (need) => {
      if (doc.y + need > bottom) doc.addPage();
    };
    pdfHeader(doc, { title: "AI Picks: Why These Plans", groupName: g.name, subtitle: `${picks.length} picks · run ${ranOn}` });

    // What this is.
    doc.font("GSF").fontSize(9.5).fillColor(INK).text(
      `Kennion Benefit Advisors took ${g.name} to market. From the plans quoted, the assistant chose three from each Carrier/TPA lineup - a Lower Cost, a Best Fit and a Richer Benefits option - weighing your census (ages and family make-up), your enrollment by tier and the employer contribution set on the Medical Plans page. This report keeps those picks and the reason behind each one.`,
      { width, lineGap: 1.5 },
    );
    if (rec && rec.summary) {
      doc.moveDown(0.5);
      doc.font("GSF").fontSize(9.5).fillColor(INK).text(rec.summary, { width, lineGap: 1.5 });
    }
    doc.moveDown(0.9);

    // The group the picks were weighed on.
    doc.font("GSF-Bold").fontSize(12).fillColor(NAVY).text("Your group");
    doc.moveDown(0.4);
    if (census) {
      pdfStats(doc, [
        { label: "Employees", value: String(enrolled || census.employees), note: `${census.employees} with an age on file` },
        { label: "Average age", value: String(census.average), note: `median ${census.median}` },
        { label: "Age range", value: `${census.youngest}-${census.oldest}`, note: `${census.spread} spread` },
        { label: "Spouses", value: String(census.spouses), note: "covered" },
        { label: "Children", value: String(census.children), note: `in ${census.withChildren} famil${census.withChildren === 1 ? "y" : "ies"}` },
      ]);
      const half = (width - 24) / 2;
      const y = doc.y;
      const b = census.bands || {};
      const yb = pdfBars(doc, { x: x0, y, width: half, title: "Ages", color: NAVY, bars: [
        { label: "Under 30", value: b.under30 || 0 },
        { label: "30-44", value: b.from30to44 || 0 },
        { label: "45-54", value: b.from45to54 || 0 },
        { label: "55+", value: b.from55 || 0 },
      ] });
      const yt = pdfBars(doc, { x: x0 + half + 24, y, width: half, title: "Enrollment by tier", color: GREEN, bars: TIER_KEYS.map((k) => ({ label: TIER_LABEL[k], value: counts[k] || 0 })) });
      doc.x = x0;
      doc.y = Math.max(yb, yt) + 6;
    } else {
      doc.font("GSF").fontSize(9).fillColor(MUTED).text(`No census ages on file. The picks were weighed on enrollment by tier: ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${counts[k] || 0}`).join(", ")}.`, { width });
      doc.moveDown(0.6);
    }
    doc.font("GSF").fontSize(8.5).fillColor(MUTED);
    if (table.contribution) doc.text(`Employer contribution applied: ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${money0(table.contribution[k])}`).join(" · ")} per month; employees pay the rest of their tier's rate.`, { width });
    doc.moveDown(1);

    // Where to start.
    const start = rec && rec.startWith ? picks.find((p) => p.optionId === rec.startWith) : null;
    if (start) {
      room(60);
      const y = doc.y;
      doc.font("GSF").fontSize(9.5);
      const lead = `${start.carrier} Option ${start.optionId}`;
      const rest = ` (${start.funding ? `${start.funding}, ` : ""}${PICK_LABEL[start.tier] || start.tier}; the ${start.plan}). ${rec.startWithReason || ""}`.trimEnd();
      const h = doc.heightOfString(lead + rest, { width: width - 28 }) + 30;
      doc.rect(x0, y, width, h).fill("#E8F3ED");
      doc.rect(x0, y, 4, h).fill(GREEN);
      doc.font("GSF-Bold").fontSize(9).fillColor("#16714A").text("START HERE", x0 + 14, y + 9, { lineBreak: false });
      doc.font("GSF-Bold").fontSize(9.5).fillColor(INK).text(lead, x0 + 14, y + 22, { width: width - 28, continued: true }).font("GSF").text(rest);
      doc.x = x0;
      doc.y = y + h + 14;
    }

    // Each lineup: its three picks, each with the figures and the reason.
    const blockOf = (p) => {
      const r = rowFor(p);
      const facts = r
        ? [r.network !== "-" ? `Network ${r.network}` : null, r.deductible !== "-" ? `Deductible ${r.deductible}` : null, r.oopMax !== "-" ? `Out-of-pocket max ${r.oopMax}` : null, r.rates.EE != null ? `Employee-only rate ${money(r.rates.EE)}` : null].filter(Boolean).join("  ·  ")
        : "";
      const bill = r && r.monthly != null
        ? `Total monthly bill ${money0(r.monthly)} for ${enrolled} enrolled${r.er != null ? `  ·  your company pays ${money0(r.er)}, employees pay ${money0(r.ee)}` : ""}`
        : "Not priced at your enrollment.";
      const reason = p.reason || "";
      // Every line wraps at the block's width; the block is as tall as its lines.
      const w = width - 24;
      doc.font("GSF").fontSize(8.5);
      const factsH = facts ? doc.heightOfString(facts, { width: w }) + 3 : 0;
      doc.font("GSF-Bold").fontSize(8.5);
      const billH = doc.heightOfString(bill, { width: w }) + 3;
      doc.font("GSF").fontSize(8.5);
      const reasonH = reason ? doc.heightOfString(reason, { width: w }) + 4 : 0;
      const need = 24 + 11 + factsH + billH + reasonH + 12;
      return { facts, bill, reason, factsH, billH, need, w };
    };
    for (const l of lineups) {
      // The heading stays with its first pick.
      room(28 + blockOf(l.picks[0]).need);
      doc.font("GSF-Bold").fontSize(12).fillColor(NAVY).text(`${l.carrier}${l.funding ? ` · ${l.funding}` : ""}`, x0, doc.y, { width });
      doc.moveDown(0.35);
      for (const p of l.picks) {
        const label = PICK_LABEL[p.tier] || p.tier;
        const { facts, bill, reason, factsH, billH, need, w } = blockOf(p);
        room(need);
        const y = doc.y;
        doc.rect(x0, y, width, need - 6).fill(TINT);
        doc.rect(x0, y, 4, need - 6).fill(PICK_COLOR[p.tier] || NAVY);
        doc.font("GSF-Bold").fontSize(8).fillColor(PICK_COLOR[p.tier] || NAVY).text(label.toUpperCase(), x0 + 12, y + 8, { lineBreak: false });
        const lw = doc.widthOfString(label.toUpperCase()) + 10;
        doc.font("GSF-Bold").fontSize(10).fillColor(NAVY).text(`${p.carrier} Option ${p.optionId}`, x0 + 12 + lw, y + 7, { width: w - lw, height: 12, ellipsis: true });
        doc.font("GSF").fontSize(8.5).fillColor(MUTED).text(p.plan, x0 + 12, y + 21, { width: w, height: 10, ellipsis: true });
        let ly = y + 33;
        if (facts) {
          doc.font("GSF").fontSize(8.5).fillColor(MUTED).text(facts, x0 + 12, ly, { width: w });
          ly += factsH;
        }
        doc.font("GSF-Bold").fontSize(8.5).fillColor(INK).text(bill, x0 + 12, ly, { width: w });
        ly += billH;
        if (reason) doc.font("GSF").fontSize(8.5).fillColor(INK).text(reason, x0 + 12, ly + 1, { width: w });
        doc.x = x0;
        doc.y = y + need;
      }
      doc.moveDown(0.5);
    }

    // The bills side by side.
    const chart = picks.map((p) => ({ p, r: rowFor(p) })).filter((x) => x.r && x.r.monthly != null);
    if (chart.length) {
      room(40 + chart.length * 18 + 30);
      doc.font("GSF-Bold").fontSize(12).fillColor(NAVY).text("Total monthly bill, side by side", x0, doc.y, { width });
      doc.font("GSF").fontSize(8.5).fillColor(MUTED).text(`Each pick at your enrollment of ${enrolled}. Green is Lower Cost, navy Best Fit, orange Richer Benefits.`, { width });
      doc.moveDown(0.6);
      pdfBillChart(doc, {
        rows: chart.sort((a, b) => a.r.monthly - b.r.monthly).map(({ p, r }) => ({ label: `${p.carrier} Option ${p.optionId}${p.funding ? ` (${p.funding})` : ""} · ${PICK_LABEL[p.tier] || p.tier}`, monthly: r.monthly, color: PICK_COLOR[p.tier] || NAVY })),
        todayTotal: null,
      });
    }

    room(50);
    doc.font("GSF-Bold").fontSize(10).fillColor(NAVY).text("How the picks were made", x0, doc.y, { width });
    doc.font("GSF").fontSize(8.5).fillColor(INK).text(
      "For each Carrier/TPA lineup the assistant read every quoted plan's rates, deductible, out-of-pocket maximum and benefits, then chose the option that costs least at your enrollment (Lower Cost), the one whose design best matches your group's ages and family make-up (Best Fit), and the one that covers the most for the money (Richer Benefits). UnitedHealthcare's fully insured and level funded quotes are separate lineups, so each gets its three. Run AI Picks again after new quotes arrive or the employer contribution changes; the picks can change with them. Your Kennion account manager can walk through any of these.",
      { width, lineGap: 1.2 },
    );
    pdfFooter(doc);
  });
  return { filename: `${safeName(g.name)} - AI Picks ${stamp}.pdf`, mime: "application/pdf", data };
}

// ----------------------------------------------------------- Markdown → doc

/** The same small Markdown the chat renders, as blocks. */
function parseBlocks(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isRule = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const bullet = /^\s*[-*•]\s+/;
  const number = /^\s*\d+[.)]\s+/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      out.push({ type: "table", head, rows });
      continue;
    }
    if (bullet.test(line) || number.test(line)) {
      const ordered = number.test(line);
      const re = ordered ? number : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i]) && !bullet.test(lines[i]) && !number.test(lines[i])) item += " " + lines[i++].trim();
        items.push(item);
      }
      out.push({ type: "list", ordered, items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !bullet.test(lines[i]) && !number.test(lines[i]) && !(isRow(lines[i]) && i + 1 < lines.length && isRule(lines[i + 1]))) para.push(lines[i++].trim());
    out.push({ type: "para", text: para.join(" ") });
  }
  return out;
}

/** Inline Markdown as [{text, bold}] runs; links keep their text, code its content. */
function runs(s) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of String(s).matchAll(re)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false });
    const t = m[0];
    if (t.startsWith("**")) out.push({ text: t.slice(2, -2), bold: true });
    else if (t.startsWith("`")) out.push({ text: t.slice(1, -1), bold: false });
    else out.push({ text: t.slice(1, t.indexOf("](")), bold: false });
    last = m.index + t.length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false });
  return out.map((r) => ({ ...r, text: r.text.replace(/\*([^*]+)\*/g, "$1") }));
}
const plain = (s) => runs(s).map((r) => r.text).join("");

export async function renderDocument({ format, title, markdown, group: g }) {
  const blocks = parseBlocks(markdown);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = title || "Summary";
  if (format === "docx") {
    const children = [
      new Paragraph({ children: [new TextRun({ text: "BenSync · Kennion Benefit Advisors", color: "6B7276", size: 18 })] }),
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: name })] }),
      new Paragraph({ children: [new TextRun({ text: `${g.name}  ·  Prepared ${today()}`, color: "6B7276", size: 20 })], spacing: { after: 240 } }),
    ];
    let listInstance = 0;
    for (const b of blocks) {
      if (b.type === "heading") {
        const level = b.level <= 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
        children.push(new Paragraph({ heading: level, children: [new TextRun({ text: plain(b.text) })], spacing: { before: 240, after: 100 } }));
      } else if (b.type === "para") {
        children.push(new Paragraph({ children: runs(b.text).map((r) => new TextRun({ text: r.text, bold: r.bold })), spacing: { after: 140 } }));
      } else if (b.type === "list") {
        listInstance++;
        b.items.forEach((it) =>
          children.push(
            new Paragraph({
              children: runs(it).map((r) => new TextRun({ text: r.text, bold: r.bold })),
              ...(b.ordered ? { numbering: { reference: "numbers", level: 0, instance: listInstance } } : { bullet: { level: 0 } }),
              spacing: { after: 60 },
            }),
          ),
        );
      } else if (b.type === "table") {
        const border = { style: BorderStyle.SINGLE, size: 4, color: "DFE3E6" };
        const cell = (t, head, j) =>
          new TableCell({
            children: [new Paragraph({ alignment: j && !head ? AlignmentType.RIGHT : AlignmentType.LEFT, children: runs(t).map((r) => new TextRun({ text: r.text, bold: head || r.bold, size: 19 })) })],
            borders: { top: border, bottom: border, left: border, right: border },
            shading: head ? { fill: "EEF1F2" } : undefined,
          });
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ tableHeader: true, children: b.head.map((t, j) => cell(t, true, j)) }), ...b.rows.map((r) => new TableRow({ children: b.head.map((_, j) => cell(r[j] ?? "", false, j)) }))],
          }),
        );
        children.push(new Paragraph({ spacing: { after: 120 } }));
      } else if (b.type === "rule") {
        children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "DFE3E6" } }, spacing: { after: 160 } }));
      }
    }
    children.push(new Paragraph({ spacing: { before: 360 }, children: [new TextRun({ text: `Prepared with the BenSync Assistant from the group's own figures on file; confirm with your Kennion account manager.`, color: "6B7276", size: 17 })] }));
    const doc = new Document({
      creator: "BenSync",
      title: name,
      numbering: { config: [{ reference: "numbers", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 540, hanging: 300 } } } }] }] },
      styles: { default: { document: { run: { font: "Google Sans Flex", size: 22 } } } },
      sections: [{ children }],
    });
    const data = await Packer.toBuffer(doc);
    return { filename: `${safeName(g.name)} - ${safeName(name)} ${stamp}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data };
  }
  const data = await pdfBuffer((doc) => {
    pdfHeader(doc, { title: name, groupName: g.name });
    const width = doc.page.width - 80;
    const write = (text, opts = {}) => {
      const rs = runs(text);
      rs.forEach((r, i) => {
        doc.font(r.bold ? "GSF-Bold" : "GSF").text(r.text, { ...opts, continued: i < rs.length - 1 });
      });
    };
    for (const b of blocks) {
      if (doc.y > doc.page.height - 90) doc.addPage();
      if (b.type === "heading") {
        doc.moveDown(0.5);
        doc.font("GSF-Bold").fontSize(b.level <= 1 ? 14 : b.level === 2 ? 12 : 11).fillColor(NAVY).text(plain(b.text), { width });
        doc.moveDown(0.25);
      } else if (b.type === "para") {
        doc.fontSize(10.5).fillColor(INK);
        write(b.text, { width, lineGap: 2 });
        doc.moveDown(0.5);
      } else if (b.type === "list") {
        doc.fontSize(10.5).fillColor(INK);
        b.items.forEach((it, i) => {
          const marker = b.ordered ? `${i + 1}.` : "•";
          const y = doc.y;
          doc.font("GSF").text(marker, 52, y, { width: 16, lineBreak: false });
          doc.x = 68;
          doc.y = y;
          write(it, { width: width - 28, lineGap: 2 });
          doc.x = 40;
          doc.moveDown(0.2);
        });
        doc.moveDown(0.4);
      } else if (b.type === "table") {
        const n = b.head.length || 1;
        const cols = b.head.map((label, j) => ({ label, width: width / n, align: j ? "right" : "left", text: (r) => plain(r[j] ?? "") }));
        pdfTable(doc, { columns: cols, rows: b.rows, fontSize: 9 });
        doc.moveDown(0.6);
      } else if (b.type === "rule") {
        doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(0.6).strokeColor(RULE).stroke();
        doc.moveDown(0.6);
      }
    }
    doc.moveDown(1);
    doc.font("GSF").fontSize(8.5).fillColor(MUTED).text("Prepared with the BenSync Assistant from the group's own figures on file; confirm with your Kennion account manager.", { width });
    pdfFooter(doc);
  });
  return { filename: `${safeName(g.name)} - ${safeName(name)} ${stamp}.pdf`, mime: "application/pdf", data };
}

// ------------------------------------------------ 2027 Program Overview

/** The network a slot's plans run on, the way the pages say it; a fixed rule for the carriers on one network, the quote's own word otherwise. */
const slotNetwork = (slot, network) => {
  if (/^UHC|^Surest/.test(slot || "")) return "United Choice Plus";
  if (slot === "Gravie" || slot === "Angle") return "Cigna";
  if (slot === "Nationwide") return "Nationwide";
  return networkLabel(network) || "On the proposal";
};
/** How a slot's carrier reads on a client's page: UnitedHealthcare for every UHC slot, Angle Health for Angle. */
const slotName = (slot, carrier) => {
  if (/^UHC|^Surest/.test(slot || "")) return "UnitedHealthcare";
  if (slot === "Angle") return "Angle Health";
  return carrier || slot || "Other";
};

/**
 * The 2027 options a group can see, one row per priced plan: the same rule
 * the Medical Plans page applies. A plan is priced when the carrier quoted
 * every tier the group has people in; a plan quoted twice at the same rates
 * is one row; Cobalt is not offered.
 */
function optionRows(g, proposals) {
  const counts = g.tiers || { EE: 0, ES: 0, EC: 0, FAM: 0 };
  const seen = new Set();
  const out = [];
  for (const pr of proposals || []) {
    if (pr.slot === "Cobalt") continue;
    for (const pl of pr.plans || []) {
      const rates = {};
      TIER_KEYS.forEach((k) => (rates[k] = pl.rates && pl.rates[k] != null ? Number(pl.rates[k]) : null));
      if (!TIER_KEYS.some((k) => rates[k] != null)) continue;
      let monthly = 0;
      for (const k of TIER_KEYS) {
        if (!counts[k]) continue;
        if (rates[k] == null) {
          monthly = null;
          break;
        }
        monthly += rates[k] * counts[k];
      }
      if (monthly == null) continue;
      const name = pr.slot === "Surest" && !/surest/i.test(pl.name || "") ? `Surest ${pl.name}` : pl.name || "-";
      const key = `${pr.slot}|${name.toLowerCase()}|${TIER_KEYS.map((k) => rates[k] ?? "").join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        slot: pr.slot,
        carrier: slotName(pr.slot, pr.carrier),
        // Title Case, the way the page's own headings and labels read.
        funding: slotFunding(pr.slot) === "Fully insured" ? "Fully Insured" : "Level Funded",
        optionId: pl.optionId || null,
        name,
        network: slotNetwork(pr.slot, pl.network),
        deductible: pl.deductible || "-",
        oopMax: pl.oopMax || "-",
        rates,
        monthly: round2(monthly),
      });
    }
  }
  return out;
}

/**
 * The 2027 Program Overview: the one document a client downloads from
 * Welcome and passes around the office. Two pages, high level and all good
 * news: the group's current medical plan runs through December 31 as it
 * does every year, and for January 1 the Kennion Program has expanded to
 * major national carriers and program partners, so the group picks its
 * 2027 medical plans from more options than before. The same Kennion team,
 * the same supplemental package, the same support; after January 1 two
 * bills, one from Kennion for the supplemental package and one from the
 * medical Carrier/TPA for medical. No rates, no plan tables: those live on
 * BenSync. A few FAQs and the team close it.
 */
export async function renderChangesReport({ group: g, proposals, slots, manager, broker, signup, assistant }) {
  const options = optionRows(g, proposals);
  const carriers = [...new Set(options.map((o) => o.carrier))];
  const planYear = String(g.pyEnd || "2026-12-31").slice(0, 4);
  const renewalYear = String(Number(planYear) + 1);
  const stamp = new Date().toISOString().slice(0, 10);
  const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
  const submittedOn = signup && (signup.submitted_at || signup.submittedAt) ? new Date(signup.submitted_at || signup.submittedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;
  const managerName = manager && manager.name ? manager.name : "your Kennion account manager";

  const data = await pdfBuffer((doc) => {
    const x0 = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = doc.page.height - 60;
    const room = (need) => {
      if (doc.y + need > bottom) doc.addPage();
    };
    const heading = (text, need = 60) => {
      room(need);
      doc.moveDown(0.4);
      doc.font("GSF-Bold").fontSize(12.5).fillColor(NAVY).text(text, x0, doc.y, { width });
      doc.moveDown(0.35);
    };
    const para = (text, opts = {}) => {
      doc.font(opts.font || "GSF").fontSize(opts.size || 9.5).fillColor(opts.color || INK).text(text, x0, doc.y, { width, lineGap: 1.5 });
      doc.moveDown(opts.after ?? 0.5);
    };
    /** Bullets in a column at (x, y) of the given width; returns the y below them. */
    const bulletsAt = (items, x, y, w, size = 9.5) => {
      let cy = y;
      for (const t of items) {
        doc.font("GSF").fontSize(size);
        const h = doc.heightOfString(t, { width: w - 14, lineGap: 1.5 });
        doc.fillColor(GREEN).text("•", x + 2, cy, { lineBreak: false });
        doc.fillColor(INK).text(t, x + 14, cy, { width: w - 14, lineGap: 1.5 });
        cy += h + 4;
      }
      return cy;
    };
    const bullets = (items) => {
      doc.font("GSF").fontSize(9.5);
      room(items.reduce((h, t) => h + doc.heightOfString(t, { width: width - 14, lineGap: 1.5 }) + 4, 0) + 6);
      doc.y = bulletsAt(items, x0, doc.y, width);
      doc.x = x0;
      doc.moveDown(0.4);
    };
    const callout = (label, text) => {
      doc.font("GSF").fontSize(10);
      const h = doc.heightOfString(text, { width: width - 28, lineGap: 1.5 }) + 34;
      room(h + 10);
      const y = doc.y;
      doc.rect(x0, y, width, h).fill(TINT);
      doc.rect(x0, y, 4, h).fill(GREEN);
      doc.font("GSF-Bold").fontSize(8.5).fillColor("#16714A").text(label.toUpperCase(), x0 + 14, y + 9, { lineBreak: false });
      doc.font("GSF").fontSize(10).fillColor(INK).text(text, x0 + 14, y + 23, { width: width - 28, lineGap: 1.5 });
      doc.x = x0;
      doc.y = y + h + 12;
    };
    /** Tinted boxes side by side, each a title, an optional line under it and bullets; all the same height. */
    const boxes = (cols) => {
      const gap = 12;
      const colW = (width - gap * (cols.length - 1)) / cols.length;
      const inner = colW - 24;
      const heights = cols.map((c) => {
        let h = 30;
        if (c.lead) {
          doc.font("GSF").fontSize(9).fillColor(MUTED);
          h += doc.heightOfString(c.lead, { width: inner, lineGap: 1.5 }) + 6;
        }
        doc.font("GSF").fontSize(9.5);
        h += (c.items || []).reduce((s, t) => s + doc.heightOfString(t, { width: inner - 14, lineGap: 1.5 }) + 4, 0);
        return h + 8;
      });
      const h = Math.max(...heights);
      room(h + 8);
      const y = doc.y;
      cols.forEach((c, i) => {
        const x = x0 + i * (colW + gap);
        doc.rect(x, y, colW, h).fill(TINT);
        doc.rect(x, y, colW, 3).fill(c.accent || GREEN);
        doc.font("GSF-Bold").fontSize(10.5).fillColor(NAVY).text(c.title, x + 12, y + 12, { width: inner, lineBreak: false });
        let cy = y + 30;
        if (c.lead) {
          doc.font("GSF").fontSize(9).fillColor(MUTED).text(c.lead, x + 12, cy, { width: inner, lineGap: 1.5 });
          cy += doc.heightOfString(c.lead, { width: inner, lineGap: 1.5 }) + 6;
        }
        if (c.items && c.items.length) bulletsAt(c.items, x + 12, cy, inner);
      });
      doc.x = x0;
      doc.y = y + h + 12;
    };
    const steps = (rows) => {
      rows.forEach(([title, body], i) => {
        doc.font("GSF").fontSize(9.5);
        const h = doc.heightOfString(body, { width: width - 30, lineGap: 1.5 }) + 15;
        room(h + 4);
        const y = doc.y;
        doc.circle(x0 + 8, y + 6, 8).fill("#E8F3ED");
        doc.font("GSF-Bold").fontSize(8).fillColor("#16714A").text(String(i + 1), x0, y + 2, { width: 16, align: "center", lineBreak: false });
        doc.font("GSF-Bold").fontSize(9.5).fillColor(NAVY).text(title, x0 + 24, y, { width: width - 30, lineBreak: false });
        doc.font("GSF").fontSize(9.5).fillColor(INK).text(body, x0 + 24, y + 13, { width: width - 30, lineGap: 1.5 });
        doc.x = x0;
        doc.y = y + h + 3;
      });
      doc.moveDown(0.3);
    };
    const faqs = (rows) => {
      rows.forEach(([q, a]) => {
        doc.font("GSF").fontSize(9.5);
        const h = 14 + doc.heightOfString(a, { width, lineGap: 1.5 });
        room(h + 8);
        const y = doc.y;
        doc.font("GSF-Bold").fontSize(9.5).fillColor(NAVY).text(q, x0, y, { width, lineBreak: false });
        doc.font("GSF").fontSize(9.5).fillColor(INK).text(a, x0, y + 14, { width, lineGap: 1.5 });
        doc.x = x0;
        doc.y = y + h + 7;
      });
    };

    pdfHeader(doc, { title: `${renewalYear} Program Overview`, groupName: g.name, subtitle: `Your ${planYear} To ${renewalYear} Renewal Summary` });

    // Page 1: the good news, in order.
    para("Good news: the Kennion Program is growing.", { font: "GSF-Bold", size: 12, color: NAVY, after: 0.35 });
    para(
      `Kennion has helped employers with employee benefits for more than 50 years and has operated the Kennion Program since 2013. As the program has grown and clients have asked for more choice, we have expanded our group health offering for ${renewalYear} to include major national carriers, networks and program partners. For ${g.name}, that means more medical plan options, more price points and more flexibility, backed by the same Kennion team you already know.`,
      { after: 0.8 },
    );

    callout(
      "The Short Version",
      `Your current group health plan through the Kennion Program runs through December 31, ${planYear}, as it does every year. For January 1, ${renewalYear}, you will choose your medical plans from new national Carriers/TPAs, with more options than ever before. Everything else stays the same: your Kennion team, your supplemental package, your enrollment system and your support. Kennion handles the implementation from start to finish.`,
    );

    heading("What Stays The Same, And What's New", 150);
    boxes([
      {
        title: "Stays The Same",
        accent: NAVY,
        items: [
          "Kennion as your broker and advocate, with the same account manager and licensed broker.",
          "Your supplemental package: dental, vision, life and your other lines, through Kennion as today.",
          "Employee Navigator for enrollment, new hires and changes during the year.",
          `Your plan year: January 1 to December 31, ${renewalYear}.`,
          "The support you are used to, before, during and after enrollment.",
        ],
      },
      {
        title: `New For ${renewalYear}`,
        accent: GREEN,
        items: [
          options.length
            ? `${n(options.length, "medical plan option", "medical plan options")} from ${n(carriers.length, "national carrier and program partner", "national carriers and program partners")}: ${list(carriers)}.`
            : "Medical plan options from major national carriers and program partners, priced for your group.",
          `Your medical plans for ${renewalYear} come from the new Carrier/TPA lineup rather than the single program plan you have today.`,
          "BenSync, Kennion's new benefits decision platform, to compare options side by side and model your contribution.",
          "Medical billed directly by your Carrier/TPA; your supplemental package still billed by Kennion.",
        ],
      },
    ]);

    heading("Billing After January 1: Two Bills, One Team", 120);
    para(`Today one Kennion Program bill covers everything. From January 1, ${renewalYear}, you will receive two.`, { after: 0.5 });
    boxes([
      {
        title: "From Kennion",
        accent: NAVY,
        lead: "Monthly, as today.",
        items: ["Your supplemental package: dental, vision, life and your other supplemental lines.", "Same Kennion invoice, same team to call with a question."],
      },
      {
        title: "From Your Medical Carrier/TPA",
        accent: GREEN,
        lead: "Monthly, direct from the carrier.",
        items: ["Your medical plan premium, billed and collected by the Carrier/TPA you choose.", "Kennion sets it up with the carrier and coordinates the first month's payment with you."],
      },
    ]);

    doc.moveDown(0.2);
    para(`The bottom line: more options from major national programs, more flexibility for your budget and your employees, and the same Kennion team walking you through every step. We are excited to bring it to you.`, { font: "GSF-Bold", size: 10.5, color: NAVY, after: 0 });

    // Page 2: what happens next, the questions we hear most, then the team.
    doc.addPage();
    heading("What Happens Next", 0);
    steps([
      ["Review Medical Options", `See your ${renewalYear} medical plans on BenSync, side by side, priced for your group.`],
      ["Review Supplemental Benefits", "Confirm your dental, vision, life and other supplemental lines. Nothing changes here unless you want it to."],
      ["Build Your Strategy", "Work with Kennion and the AI Assistant to compare plans, model contributions and narrow the options that make the most sense for your group."],
      ["Sign Up", submittedOn ? `You submitted your plan choices on ${submittedOn}. You can send an update any time.` : `Once your strategy is set, confirm the plans and benefits you want to offer for ${renewalYear}. The Sign Up page on BenSync takes about a minute.`],
    ]);
    para("Once your selections are finalized, Kennion coordinates Employee Navigator setup, carrier implementation, employee communications, open enrollment, enrollment support, final enrollment and first-month premium setup.", { after: 0.3 });
    para("We help you build the right strategy. Then we handle the rest.", { font: "GSF-Bold", after: 0.3 });

    heading("Questions We Hear Most", 100);
    faqs([
      ["Why is our medical plan changing?", `It is not so much changing as expanding. The Kennion Program has grown, and for ${renewalYear} we have added major national carriers and program partners so our clients have more choice. Your current plan runs through December 31, ${planYear}, exactly as it does every year; your new plan starts January 1, ${renewalYear}, with no gap.`],
      ["Does anything change with Kennion?", "No. Kennion is still your broker, your advocate and your first call. The same account manager, the same licensed broker and the same support, with the BenSync AI Assistant added for instant answers any time."],
      ["What about dental, vision, life and our other supplemental benefits?", "They stay exactly where they are: your supplemental package continues through Kennion, and Kennion continues to bill it monthly as today."],
      ["Will we receive more than one bill?", "Yes, two. Kennion bills your supplemental package monthly, as it does now. Your medical Carrier/TPA bills and collects your medical premium directly. Kennion sets both up and is there for any question about either."],
      ["Do our employees need to do anything?", "Employees choose their plan during open enrollment through Employee Navigator, the same system they use today. Kennion prepares the communications, supports open enrollment, helps employees enroll and completes the carrier enrollment for you."],
      ["Can we offer more than one plan?", "Yes. Many groups offer two or three plans at different price points. With a defined contribution the company sets one monthly amount per tier, employees put it toward the plan that fits them and your budget does not change with their choice."],
      ["When do we need to decide?", `Coverage begins January 1, ${renewalYear}. The earlier you choose, the more time there is for a smooth open enrollment; ${managerName} will confirm the dates for your group.`],
    ]);

    // The team, three across.
    const team = [];
    if (manager && manager.name) team.push({ name: manager.name, title: manager.title || "Kennion Account Manager", lines: [manager.phone ? `Direct ${manager.phone}` : null, manager.email || null, manager.calendly ? "Schedule A Meeting on BenSync" : null].filter(Boolean) });
    if (broker && broker.name) team.push({ name: broker.name, title: broker.title || "Licensed Broker", lines: [broker.phone ? `Direct ${broker.phone}` : null, broker.email || null].filter(Boolean) });
    if (assistant) team.push({ name: "BenSync AI Assistant", title: "AI Assistant · Available Any Time", lines: ["Instant answers on your plans,", "your options and contributions.", "Ask from any page on BenSync."] });
    if (team.length) {
      heading("Your Kennion Team", 110);
      const gap = 12;
      const colW = (width - gap * (team.length - 1)) / team.length;
      const y = doc.y;
      let tallest = 0;
      team.forEach((m, i) => {
        const x = x0 + i * (colW + gap);
        const h = 34 + m.lines.length * 12 + 10;
        tallest = Math.max(tallest, h);
        doc.rect(x, y, colW, h).fill(TINT);
        doc.font("GSF-Bold").fontSize(10).fillColor(NAVY).text(m.name, x + 10, y + 9, { width: colW - 20, lineBreak: false });
        doc.font("GSF").fontSize(8).fillColor(MUTED).text(m.title, x + 10, y + 21, { width: colW - 20, lineBreak: false });
        m.lines.forEach((l, j) => doc.font("GSF").fontSize(8.5).fillColor(INK).text(l, x + 10, y + 36 + j * 12, { width: colW - 20, lineBreak: false }));
      });
      doc.x = x0;
      doc.y = y + tallest + 10;
      para("Questions along the way? Your Kennion team is here throughout the process. We are glad to have you with us for the next chapter.", { color: MUTED, size: 9, after: 0 });
    }

    pdfFooter(doc, { caption: "Prepared for your group by Kennion Benefit Advisors. Plan details and rates are on BenSync." });
  });
  return { filename: `${safeName(g.name)} - ${renewalYear} Program Overview ${stamp}.pdf`, mime: "application/pdf", data };
}

/**
 * The Election Confirmation: a one-page receipt of a group's Sign Up
 * submission - the medical carrier and plan(s), dental, vision, employer
 * paid life and any note, then who signed and when. No rates, no plan
 * tables: this is a record of what was chosen, not a comparison.
 */
export async function renderSignupConfirmation({ group: g, signup, manager, broker }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const fmtDate = (v) => (v ? new Date(v).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null);
  const submittedOn = fmtDate(signup.submittedAt);
  const dash = (v) => (v == null || v === "" ? "-" : v);
  const listOrDash = (xs) => (Array.isArray(xs) && xs.length ? xs.join(", ") : "-");

  const data = await pdfBuffer((doc) => {
    const x0 = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = doc.page.height - 60;
    const room = (need) => {
      if (doc.y + need > bottom) doc.addPage();
    };
    const heading = (text, need = 40) => {
      room(need);
      doc.moveDown(0.4);
      doc.font("GSF-Bold").fontSize(12.5).fillColor(NAVY).text(text, x0, doc.y, { width });
      doc.moveDown(0.35);
    };
    /** One label/value line: the label bold in a fixed-width column, the value beside it, wrapping as needed. */
    const row = (label, value) => {
      const labelW = 170;
      const text = dash(value);
      doc.font("GSF").fontSize(9.5);
      const h = doc.heightOfString(text, { width: width - labelW, lineGap: 1.5 });
      room(h + 8);
      const y = doc.y;
      doc.font("GSF-Bold").fontSize(9.5).fillColor(INK).text(label, x0, y, { width: labelW, lineBreak: false });
      doc.font("GSF").fontSize(9.5).fillColor(INK).text(text, x0 + labelW, y, { width: width - labelW, lineGap: 1.5 });
      doc.x = x0;
      doc.y = y + h + 8;
    };

    pdfHeader(doc, { title: "Election Confirmation", groupName: g.name, subtitle: submittedOn ? `Submitted ${submittedOn}` : null });

    heading("Your Election", 60);
    row("Medical Carrier", signup.carrier);
    row("Medical Plan(s)", listOrDash(signup.plans));
    row("Dental", listOrDash(signup.dental));
    row("Vision", listOrDash(signup.vision));
    row("Employer Paid Life", signup.employerLife);
    if (signup.note) row("Notes", signup.note);

    heading("Signed By", 60);
    row("Name", signup.signerName);
    row("Title", signup.signerTitle);
    row("Submitted", submittedOn);

    if (manager && manager.name) {
      heading("Questions?", 40);
      const contact = [manager.name, manager.email].filter(Boolean).join(" · ");
      doc.font("GSF").fontSize(9.5).fillColor(INK).text(`Contact ${contact || "your Kennion account manager"} with any questions about this election.`, x0, doc.y, { width, lineGap: 1.5 });
      doc.moveDown(0.4);
    }
  });
  return { filename: `${safeName(g.name)} - Election Confirmation ${stamp}.pdf`, mime: "application/pdf", data };
}

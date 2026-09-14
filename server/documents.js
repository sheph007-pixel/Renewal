// Documents the assistant hands a client: a side-by-side comparison of 2027
// options at the group's own census (PDF or Excel), and a memo or
// announcement the model has written (PDF or Word). The comparison's numbers
// are computed here from the same figures the pages use, never by the model;
// the model only chooses which plans to put next to each other.
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from "docx";

const TIER_KEYS = ["EE", "ES", "EC", "FAM"];
const TIER_CENSUS = { EE: "Employee", ES: "Employee + Spouse", EC: "Employee + Child(ren)", FAM: "Employee + Family" };
const TIER_LABEL = { EE: "Employee", ES: "EE + Spouse", EC: "EE + Child(ren)", FAM: "EE + Family" };

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money0 = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-US"));
const signed = (n) => (n == null ? "—" : (n < 0 ? "−" : "+") + money0(Math.abs(n)));
const round2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const safeName = (s) => String(s || "document").replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "document";

const slotCarrier = (slot, carrier) => {
  if (/^UHC|Surest/.test(slot || "")) return "UnitedHealthcare";
  return carrier || slot || "—";
};
const slotFunding = (slot, funding) => {
  if (slot === "UHC Fully Insured") return "Fully insured";
  if (slot === "UHC Level Funded") return "Level funded";
  if (slot === "Cobalt") return funding || "Self funded";
  return funding ? funding.replace(/^\w/, (c) => c.toUpperCase()) : "Level funded";
};

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
      rows.push({
        section: "Today (2026)",
        name: p.plan,
        carrier: p.tpa || g.tpa || "—",
        funding: "In force",
        network: "—",
        deductible: "—",
        oopMax: "—",
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
    let hit = all.find((x) => norm(x.pl.name) === nw && !used.has(x)) || all.find((x) => (norm(x.pl.name).includes(nw) || nw.includes(norm(x.pl.name))) && !used.has(x)) || all.find((x) => x.pl.planCode && norm(x.pl.planCode) === nw && !used.has(x));
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
      name: pl.name,
      carrier: slotCarrier(pr.slot, pr.carrier),
      funding: slotFunding(pr.slot, pr.funding),
      network: pl.network || "—",
      deductible: pl.deductible || "—",
      oopMax: pl.oopMax || "—",
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
    lines.push(`${r.section} — ${r.name} (${r.carrier}, ${r.funding}): ${rates}; monthly ${money(r.monthly)}; annual ${money0(r.annual)}${r.vsToday != null ? `; vs today ${signed(r.vsToday)}/mo` : ""}${r.er != null ? `; employer ${money(r.er)}/mo, employees ${money(r.ee)}/mo` : ""}`);
  }
  for (const n of table.notes) lines.push(`Note: ${n}`);
  return lines.join("\n");
}

const SHORT_TIER = { EE: "EE", ES: "EE+SP", EC: "EE+CH", FAM: "Family" };
const columnsFor = (table) => {
  const cols = [
    { key: "name", label: "Plan", width: 118, align: "left" },
    { key: "carrier", label: "Carrier / funding", width: 80, align: "left" },
    { key: "deductible", label: "Deductible", width: 52, align: "left" },
    { key: "oopMax", label: "OOP max", width: 52, align: "left" },
    ...TIER_KEYS.map((k) => ({ key: `rate_${k}`, label: `${SHORT_TIER[k]} (${table.counts[k] || 0})`, width: 50, align: "right" })),
    { key: "monthly", label: "Monthly", width: 58, align: "right" },
    { key: "annual", label: "Annual", width: 54, align: "right" },
    { key: "vsToday", label: "vs today /mo", width: 50, align: "right" },
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
  if (key === "vsToday") return r.vsToday == null ? (r.section.startsWith("Today") ? "" : "—") : signed(r.vsToday);
  if (key === "carrier") return `${r.carrier}\n${r.funding}`;
  return r[key] == null ? "—" : String(r[key]);
};

// --------------------------------------------------------------------- PDF

function pdfBuffer(build, opts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 40, bufferPages: true, ...opts });
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
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#1F8A5B").text("BenSync", doc.page.margins.left, 24, { continued: true }).fillColor(MUTED).font("Helvetica").text("  ·  Kennion Benefit Advisors");
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(17).fillColor(NAVY).text(title);
  doc.moveDown(0.15);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`${groupName}${subtitle ? `  ·  ${subtitle}` : ""}  ·  Prepared ${today()}`);
  doc.moveDown(0.8);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(0.6).strokeColor(RULE).stroke();
  doc.moveDown(0.6);
}

function pdfFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing below the bottom margin would open a new page; lift it for the footer.
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
      `Figures from the carriers' quotes on file and the group's current enrollment; monthly composite rates. Not a binding quote.  ·  Page ${i - range.start + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - 26,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center", lineBreak: false },
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
    doc.font("Helvetica-Bold").fontSize(fontSize);
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
    doc.font("Helvetica").fontSize(fontSize);
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
      doc.font("Helvetica-Bold").fontSize(fontSize).fillColor(NAVY).text(section, x + pad, doc.y + 4, { lineBreak: false });
      doc.y += 16;
      lastSection = section;
      doc.font("Helvetica").fontSize(fontSize);
    }
    const y = doc.y;
    let cx = x;
    texts.forEach((t, i) => {
      const c = cols[i];
      doc.fillColor(c.strong && c.strong(r) ? NAVY : INK).font(c.strong && c.strong(r) ? "Helvetica-Bold" : "Helvetica");
      doc.text(t, cx + pad, y + pad, { width: c.width - pad * 2, align: c.align });
      cx += c.width;
    });
    doc.y = y + h;
    doc.moveTo(x, doc.y).lineTo(x + cols.reduce((n, c) => n + c.width, 0), doc.y).lineWidth(0.4).strokeColor(RULE).stroke();
  }
  // Positioned text leaves the cursor in the last column; what follows starts at the margin again.
  doc.x = x;
  doc.fillColor(INK).font("Helvetica");
  return doc.y;
}

export async function renderComparison({ format, title, group: g, table }) {
  const name = title || "2027 Medical Options — Comparison";
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
    aoa.push(["Figures from the carriers' quotes on file and the group's current enrollment; monthly composite rates. Not a binding quote."]);
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
      doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
      doc.text(`Enrollment by tier: ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${table.counts[k] || 0}`).join(" · ")}.`);
      if (table.todayTotal != null) doc.text(`Today's total medical premium: ${money(table.todayTotal)} per month (${money0(table.todayTotal * 12)} per year).`);
      if (table.contribution) doc.text(`Employer contribution modeled at ${TIER_KEYS.map((k) => `${TIER_LABEL[k]} ${money(table.contribution[k])}`).join(", ")} per month; employees pay the rest.`);
      for (const n of table.notes) doc.text(n);
      const withBenefits = table.rows.filter((r) => r.benefits && Object.values(r.benefits).some(Boolean));
      if (withBenefits.length) {
        doc.moveDown(1);
        doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY).text("In-network benefits, as printed on the quotes");
        doc.moveDown(0.3);
        const bcols = [
          { key: "name", label: "Plan", width: 150, align: "left", text: (r) => r.name, strong: () => true },
          { key: "pcp", label: "Doctor visit", width: 90, align: "left", text: (r) => r.benefits.doctorVisit || "—" },
          { key: "spec", label: "Specialist", width: 90, align: "left", text: (r) => r.benefits.specialist || "—" },
          { key: "uc", label: "Urgent care", width: 90, align: "left", text: (r) => r.benefits.urgentCare || "—" },
          { key: "img", label: "Imaging / labs", width: 100, align: "left", text: (r) => r.benefits.imaging || "—" },
          { key: "hosp", label: "Hospital", width: 100, align: "left", text: (r) => r.benefits.hospital || "—" },
          { key: "rx", label: "Prescriptions", width: 110, align: "left", text: (r) => r.benefits.rx || "—" },
        ];
        pdfTable(doc, { columns: bcols, rows: withBenefits });
      }
      pdfFooter(doc);
    },
    { layout: "landscape", margin: 30 },
  );
  return { filename: `${safeName(g.name)} - ${safeName(name)} ${stamp}.pdf`, mime: "application/pdf", data };
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
    children.push(new Paragraph({ spacing: { before: 360 }, children: [new TextRun({ text: "Prepared with the BenSync Assistant from the group's own figures on file. Not a binding quote; confirm with your Kennion account manager.", color: "6B7276", size: 17 })] }));
    const doc = new Document({
      creator: "BenSync",
      title: name,
      numbering: { config: [{ reference: "numbers", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 540, hanging: 300 } } } }] }] },
      styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
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
        doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").text(r.text, { ...opts, continued: i < rs.length - 1 });
      });
    };
    for (const b of blocks) {
      if (doc.y > doc.page.height - 90) doc.addPage();
      if (b.type === "heading") {
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").fontSize(b.level <= 1 ? 14 : b.level === 2 ? 12 : 11).fillColor(NAVY).text(plain(b.text), { width });
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
          doc.font("Helvetica").text(marker, 52, y, { width: 16, lineBreak: false });
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
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text("Prepared with the BenSync Assistant from the group's own figures on file. Not a binding quote; confirm with your Kennion account manager.", { width });
    pdfFooter(doc);
  });
  return { filename: `${safeName(g.name)} - ${safeName(name)} ${stamp}.pdf`, mime: "application/pdf", data };
}

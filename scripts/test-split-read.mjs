// Reading long proposals, against a local stand-in for the Messages API:
//  1. A proposal too long for one answer is halved down to single pages and
//     the halves' appearances fold into canonical plans - a plan printed on
//     page 1 and again on page 5 is one plan with both pages.
//  2. A long PDF is mapped first; only its medical pages are read, as an
//     excerpt, and a plan whose benefits sit on page 3 and whose rates sit on
//     page 20 comes back as ONE plan with both, merged by its plan code, its
//     provenance in original page numbers.
//  3. When the relevant-page reading cannot account for the plans the map
//     saw, the whole document is read instead.
//  4. An owner-password-encrypted carrier PDF - which pdf-parse cannot open
//     and pdf-lib will not cut - is still counted and read in halves, by
//     sending the whole file with "read only pages X-Y" (the Boss Logistics
//     UHC Level Funded quote failed exactly this way).
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

let doc = "short";
const seen = [];
const rates = (n) => ({ EE: 500 + n, ES: 1000, EC: 900, FAM: 1500 });
const bens = { doctor_visit: "$30", specialist: "$60", imaging: "", urgent_care: "$75", emergency_room: "$350", hospital: "20%", rx: "$10/$40", coinsurance: "20%", hsa_eligible: "no" };
const blankBens = Object.fromEntries(Object.keys(bens).map((k) => [k, ""]));
const plan = (o) => ({ name: "", plan_code: null, network: "Choice Plus", plan_type: "PPO", deductible: null, oop_max: null, benefits: blankBens, rates: { EE: null, ES: null, EC: null, FAM: null }, monthly_total: null, source_pages: { identity: [], benefits: [], rates: [] }, source_sheet: "", source_rows: "", ...o });

/** What each original page of the stand-in document shows. `pos` is its position in the file sent. */
function onPage(page, pos) {
  if (doc === "wide") return [plan({ name: `Grid ${page}`, plan_code: `G${page}`, deductible: "$1,000", oop_max: "$5,000", benefits: bens, rates: rates(page), source_pages: { identity: [pos], benefits: [pos], rates: [pos] } })];
  if (doc === "short" || doc === "encrypted") {
    const out = [plan({ name: `Plan p${page}`, plan_code: `P${page}`, deductible: "$1,000", oop_max: "$5,000", benefits: bens, rates: rates(page), source_pages: { identity: [pos], benefits: [pos], rates: [pos] } })];
    // The headline plan is printed again on the last page.
    if (page === 5) out.push(plan({ name: "Plan p1", plan_code: "P1", source_pages: { identity: [pos], benefits: [], rates: [] } }));
    return out;
  }
  if (page === 3) return [plan({ name: "Plan A", plan_code: "A1", deductible: "$1,000", oop_max: "$5,000", benefits: bens, source_pages: { identity: [pos], benefits: [pos], rates: [] } })];
  if (page === 4) return [plan({ name: "Plan B", plan_code: "B1", deductible: "$2,000", oop_max: "$6,000", benefits: bens, source_pages: { identity: [pos], benefits: [pos], rates: [] } })];
  if (page === 20) return [plan({ name: "Plan A", plan_code: "A1", rates: rates(1), source_pages: { identity: [pos], benefits: [], rates: [pos] } })];
  if (page === 21) return [plan({ name: "Plan B", plan_code: "B1", rates: rates(2), source_pages: { identity: [pos], benefits: [], rates: [pos] } })];
  return [];
}

const expand = (desc) => desc.split(",").flatMap((part) => {
  const [a, b] = part.trim().split("-").map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
});

let mapSays = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const j = JSON.parse(body || "{}");
    const content = j.messages[0].content;
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const system = Array.isArray(j.system) ? j.system.map((b) => b.text).join("") : String(j.system || "");
    const pdfDoc = content.find((c) => c.type === "document");
    const count = (await PDFDocument.load(Buffer.from(pdfDoc.source.data, "base64"), { ignoreEncryption: true })).getPageCount();
    let out;
    let stop = "end_turn";
    if (/You map a carrier's medical proposal/.test(system)) {
      seen.push(`map:${count}`);
      out = mapSays;
    } else {
      const m = /its pages are the original pages ([\d,\s-]+), in that order/.exec(text);
      const w = /but read ONLY pages ([\d,\s-]+): list only/.exec(text);
      const pages = m ? expand(m[1]) : w ? expand(w[1]) : Array.from({ length: count }, (_, i) => i + 1);
      if (!w) assert.equal(pages.length, count, "the excerpt holds exactly the pages it says it does");
      else assert.equal(count, 6, "a page window is sent the whole document");
      seen.push(`${w ? "window:" : ""}${m ? m[1].replace(/\s/g, "") : w ? w[1].replace(/\s/g, "") : `1-${count}`}`);
      // In a page window, page positions ARE the document's page numbers.
      const plans = pages.flatMap((pg, i) => onPage(pg, w ? pg : i + 1));
      const appearances = plans.length;
      out = {
        carrier: "UnitedHealthcare",
        funding: "level funded",
        quotes_medical: true,
        quote_id: null,
        group_name_on_document: pages.includes(1) ? "BOSS LOGISTICS" : null,
        matched_group: pages.includes(1) ? "Boss Logistics, LLC" : null,
        confidence: pages.includes(1) ? 0.95 : 0,
        effective_date: "2027-01-01",
        proposal_type: "renewal",
        enrolled_on_document: 12,
        plans,
        plan_appearances: appearances,
        unique_plans_found: new Set(plans.map((p) => p.plan_code)).size,
        unique_epo_found: 0,
        total_monthly: null,
        summary: `pages ${pages.join(",")}`,
        audit_flags: [],
      };
      if (pages.length > 2) stop = "max_tokens";
    }
    const text2 = stop === "max_tokens" ? JSON.stringify(out).slice(0, 200) : JSON.stringify(out);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text2 } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    ev("message_stop", {});
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY = "test";
delete process.env.KENNION_FAKE_AI;

const { analyzeProposal } = await import("../server/ai.js");
const pdfOf = async (n) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < n; i++) pdf.addPage([200, 200]).drawText(`page ${i + 1}`);
  return Buffer.from(await pdf.save());
};
const roster = [{ name: "Boss Logistics, LLC", enrolled: 12, tpa: null }];

// 1. Halved down to fit, folded into canonical plans.
let out = await analyzeProposal({ filename: "BOSS LOGISTICS WC UHC LF GRX.pdf", prepared: { kind: "pdf", buffer: await pdfOf(5) }, context: null }, roster);
assert.deepEqual(out.plans.map((p) => p.name), ["Plan p1", "Plan p2", "Plan p3", "Plan p4", "Plan p5"], "every page's plans, in order, the repeat of the headline plan merged into it");
assert.deepEqual(out.plans[0].source.identity, [1, 5], "the repeat on page 5 is evidence for plan p1, not another plan");
assert.deepEqual(out.plans[3].source.rates, [4], "pages are the carrier's page numbers, not positions in a half");
assert.equal(out.matched_group, "Boss Logistics, LLC");
assert.equal(out.confidence, 0.95, "parts that name no employer do not drag the match down");
assert.equal(out.reconciliation.unique_plans, 5);
assert.equal(out.reconciliation.appearances_read, 6);
assert.equal(out.extraction.method, "split");
assert.deepEqual(seen, ["1-5", "1-3", "1-2", "3", "4-5"], "halved until each part fits");

// 2. A 25-page proposal: mapped, only the medical pages read, benefits and
//    rates on distant pages paired by plan code.
doc = "long";
seen.length = 0;
mapSays = {
  carrier: "UnitedHealthcare",
  effective_date: "2027-01-01",
  page_count: 25,
  document_type: "digital",
  pages: Array.from({ length: 25 }, (_, i) => ({ page: i + 1, kinds: [3, 4].includes(i + 1) ? ["plan_identity", "benefit_detail"] : [20, 21].includes(i + 1) ? ["rates"] : ["cover_or_boilerplate"] })),
  approx_unique_ppo: 2,
  approx_unique_epo: 0,
  notes: "",
};
out = await analyzeProposal({ filename: "long.pdf", prepared: { kind: "pdf", buffer: await pdfOf(25) }, context: null }, roster);
assert.equal(seen[0], "map:25", "mapped first");
assert.ok(!seen.includes("1-25"), "the whole document is not read when the excerpt suffices");
assert.equal(out.extraction.method, "mapped");
assert.deepEqual(out.extraction.relevantPages, [3, 4, 20, 21]);
assert.equal(out.plans.length, 2, "benefit pages and rate pages are one plan each");
const a = out.plans.find((p) => p.plan_code === "A1");
assert.equal(a.deductible, "$1,000");
assert.equal(a.rates.EE, 501, "plan A's rates are plan A's, paired by code across the gap");
assert.deepEqual(a.source.benefits, [3]);
assert.deepEqual(a.source.rates, [20]);
const b = out.plans.find((p) => p.plan_code === "B1");
assert.equal(b.rates.EE, 502);
assert.deepEqual(b.source.rates, [21]);

// 3. The map saw more plans than the excerpt produced: read the whole document.
seen.length = 0;
mapSays = { ...mapSays, approx_unique_ppo: 5 };
out = await analyzeProposal({ filename: "long.pdf", prepared: { kind: "pdf", buffer: await pdfOf(25) }, context: null }, roster);
assert.ok(seen.includes("1-25"), "fell back to the whole document");
assert.equal(out.extraction.method, "split");
assert.equal(out.plans.length, 2);

// 4. An encrypted carrier PDF: counted, and read in page windows.
doc = "encrypted";
seen.length = 0;
const encrypted = readFileSync(new URL("./fixtures/encrypted-6-pages.pdf", import.meta.url));
await assert.rejects(PDFDocument.load(encrypted), /encrypted/, "the fixture is a PDF pdf-lib will not cut");
out = await analyzeProposal({ filename: "BOSS LOGISTICS WC UHC LF GRX.pdf", prepared: { kind: "pdf", buffer: encrypted }, context: null }, roster);
assert.deepEqual(seen, ["1-6", "window:1-3", "window:1-2", "window:3", "window:4-6", "window:4-5", "window:6"], "halved in page windows over the whole document");
assert.deepEqual(out.plans.map((p) => p.name), ["Plan p1", "Plan p2", "Plan p3", "Plan p4", "Plan p5", "Plan p6"]);
assert.deepEqual(out.plans[0].source.identity, [1, 5], "page 5's repeat of plan p1 merged, pages as printed");
assert.deepEqual(out.plans[5].source.rates, [6]);

// 5. A long quote with a plan grid on every page (Adobe HVAC's 300-page UHC
//    quote): the map finds every page relevant, so the whole document is
//    read - in 40-page windows from the start, never all at once first.
doc = "wide";
seen.length = 0;
mapSays = { carrier: "UnitedHealthcare", effective_date: "2027-01-01", page_count: 45, document_type: "digital", pages: Array.from({ length: 45 }, (_, i) => ({ page: i + 1, kinds: ["plan_identity", "rates"] })), approx_unique_ppo: 45, approx_unique_epo: 0, notes: "" };
out = await analyzeProposal({ filename: "wide.pdf", prepared: { kind: "pdf", buffer: await pdfOf(45) }, context: null }, roster);
assert.equal(seen[0], "map:45");
assert.equal(seen[1], "1-40", "the first read is a 40-page window, not the whole 45 pages");
assert.ok(!seen.includes("1-45"), "the whole document is never tried in one read");
assert.ok(seen.includes("41-45"));
assert.equal(out.plans.length, 45, "every page's plan, folded from the windows");

server.close();
console.log("split read: halved long reads fold into canonical plans; long PDFs mapped, relevant pages read and paired by plan code; fallback to the whole document - ok");

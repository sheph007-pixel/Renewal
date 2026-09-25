// Every source must be fully covered before a proposal can be Verified:
//  1. A CSV with several sections (a repeated header, a blank-line break) is
//     read to the end - every section, every line - not just the first table.
//  2. A CSV too long for one answer is halved by lines; every line is still
//     recorded as read.
//  3. A workbook: every sheet enumerated, an empty sheet counted as
//     inspected, every other sheet's lines read.
//  4. A file cut at the size limit can never pass coverage.
//  5. A Gravie workbook: every sheet accounted for; a sheet the parser does
//     not recognize sends the workbook to a person, never Verified.
//  6. The coverage check itself: pages, sheets, lines, the document version.
import assert from "node:assert/strict";
import http from "node:http";
import * as XLSX from "xlsx";

// A stand-in for the Messages API: every "Plan <name>,<EE>,<ES>,<EC>,<FAM>"
// line in the text it is given is a plan; more than 12 lines is too long for
// one answer (max_tokens), so the reader halves.
const reads = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const doc = j.messages[0].content.find((c) => c.type === "document");
    const text = doc.source.type === "text" ? doc.source.data : "";
    const lines = text.split("\n");
    reads.push(lines.length);
    const plans = lines
      .map((l) => /^Plan ([^,]+),(\d+),(\d+),(\d+),(\d+)/.exec(l))
      .filter(Boolean)
      .map((m) => ({ name: `Plan ${m[1]}`, plan_code: m[1], network: null, plan_type: "PPO", deductible: "$1,000", oop_max: "$5,000", benefits: {}, rates: { EE: +m[2], ES: +m[3], EC: +m[4], FAM: +m[5] }, monthly_total: null, source_pages: { identity: [], benefits: [], rates: [] }, source_sheet: "", source_rows: "row 1" }));
    const out = { carrier: "Nationwide", funding: "level funded", quotes_medical: true, quote_id: null, group_name_on_document: null, matched_group: null, confidence: 0, effective_date: "2027-01-01", proposal_type: "renewal", enrolled_on_document: null, plans, plan_appearances: plans.length, unique_plans_found: plans.length, unique_epo_found: 0, total_monthly: null, summary: "", audit_flags: [] };
    const long = lines.length > 12;
    const text2 = long ? JSON.stringify(out).slice(0, 50) : JSON.stringify(out);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text2 } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: long ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    ev("message_stop", {});
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY = "test";
delete process.env.KENNION_FAKE_AI;

const { analyzeProposal } = await import("../server/ai.js");
const { prepareForModel } = await import("../server/intake.js");
const { coverageCheck, validatePlans } = await import("../server/plan-validate.js");
const { parseGravieWorkbook, gravieExtracted } = await import("../server/gravie-parse.js");
const roster = [{ name: "Acme", enrolled: 10, tpa: null }];
const read = async (filename, mime, buffer) => analyzeProposal({ filename, prepared: await prepareForModel({ filename, mime, buffer }), context: null }, roster);
const ok = (cov) => coverageCheck(cov, null)[0].length === 0;

// 1. A CSV of three sections: a blank-line break and a repeated header.
let csv = "Plan,EE,ES,EC,FAM\nPlan A,1,2,3,4\nPlan B,5,6,7,8\n\nPlan,EE,ES,EC,FAM\nPlan C,9,10,11,12\nPlan,EE,ES,EC,FAM\nPlan D,13,14,15,16\n";
let out = await read("quote.csv", "text/csv", Buffer.from(csv));
assert.deepEqual(out.plans.map((p) => p.name), ["Plan A", "Plan B", "Plan C", "Plan D"], "every section's plans, not just the first table's");
assert.deepEqual([out.coverage.kind, out.coverage.format, out.coverage.total_lines, out.coverage.scanned_lines, out.coverage.total_sections, out.coverage.sections_read], ["text", "csv", 9, 9, 3, 3]);
assert.ok(ok(out.coverage));

// 2. Too long for one answer: halved by lines, every line still read.
reads.length = 0;
csv = `Plan,EE,ES,EC,FAM\n${Array.from({ length: 30 }, (_, i) => `Plan P${i},${i + 1},2,3,4`).join("\n")}\n`;
out = await read("big.csv", "text/csv", Buffer.from(csv));
assert.ok(reads.length > 1, "read in parts");
assert.equal(out.plans.length, 30);
assert.deepEqual([out.coverage.total_lines, out.coverage.scanned_lines], [32, 32], "every line of every part recorded as read");
assert.ok(ok(out.coverage));

// 3. A workbook: every sheet enumerated; the empty one counted as inspected.
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Plan", "EE", "ES", "EC", "FAM"], ["Plan W1", 1, 2, 3, 4]]), "PPO Rates");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Notes");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Plan", "EE", "ES", "EC", "FAM"], ["Plan W2", 5, 6, 7, 8]]), "HDHP Rates");
out = await read("quote.xlsx", "", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
assert.deepEqual(out.plans.map((p) => p.name), ["Plan W1", "Plan W2"], "plans from every sheet");
assert.deepEqual([out.coverage.kind, out.coverage.total_sheets, out.coverage.inspected_sheets], ["sheets", 3, 3]);
assert.deepEqual(out.coverage.sheets.map((sh) => `${sh.name}:${sh.status}`), ["PPO Rates:read", "Notes:empty", "HDHP Rates:read"]);
assert.ok(ok(out.coverage));

// 4. A file past the size limit is cut - and can never pass coverage.
const huge = `Plan,EE,ES,EC,FAM\nPlan Z,1,2,3,4\n${"x".repeat(310_000)}\nPlan Y,5,6,7,8\n`;
const prepared = await prepareForModel({ filename: "huge.csv", mime: "text/csv", buffer: Buffer.from(huge) });
assert.equal(prepared.truncated, true);
assert.ok(prepared.coverage.kept_lines < prepared.coverage.total_lines, "the lines cut off are counted, not forgotten");
const cut = { kind: "text", format: "csv", total_lines: prepared.coverage.total_lines, scanned_lines: prepared.coverage.kept_lines, total_chars: huge.length };
assert.match(coverageCheck(cut, null)[0][0], /lines were never read \(the file is past the size limit\)/);

// 5. Gravie: every sheet accounted for; an unrecognized one goes to a person.
const gsheet = (rows) =>
  XLSX.utils.aoa_to_sheet([["Gravie"], ["Group Name:", "Acme"], ["Effective Date", 46388, null, "EE:", 1], [], ["Plan Name", "Plan Type", "Deductible", "OOPM", "Coinsurance", "Column1", "EE Rate", "ES Rate", "EC Rate", "F Rate"], ...rows]);
const gwb = (extra) => {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, gsheet([["Gravie Copay 1500", "Copay", "$1500", "$5000", 0.2, 0, 500, 1000, 900, 1500]]), "PPO");
  XLSX.utils.book_append_sheet(w, gsheet([["Gravie Copay 1500 EPO", "Copay", "$1500", "$5000", 0.2, 0, 480, 960, 860, 1440]]), "EPO");
  XLSX.utils.book_append_sheet(w, gsheet([["Gravie LocalPlus 1500", "Copay", "$1500", "$5000", 0.2, 0, 450, 900, 800, 1350]]), "Narrow Network");
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([["Plan Type", "Preventative"]]), "Benefits Grid (static)");
  if (extra) XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([["Something new"]]), extra);
  return XLSX.write(w, { type: "buffer", bookType: "xlsx" });
};
let gx = gravieExtracted(parseGravieWorkbook(gwb()));
assert.deepEqual([gx.coverage.total_sheets, gx.coverage.inspected_sheets], [4, 4]);
assert.deepEqual(gx.coverage.sheets.map((sh) => `${sh.name}:${sh.status}:${sh.plans}`), ["PPO:parsed:1", "EPO:parsed:1", "Narrow Network:not a quote sheet:0", "Benefits Grid (static):not a quote sheet:0"]);
assert.ok(ok(gx.coverage));
gx = gravieExtracted(parseGravieWorkbook(gwb("Dental Rates")));
const [fail, fix] = coverageCheck(gx.coverage, null);
assert.match(fail[0], /1 of 5 sheets not inspected: "Dental Rates" \(a sheet the parser does not recognize\)/);
assert.equal(fix, "review", "a workbook the parser cannot fully account for goes to a person");

// 6. The check itself.
const pdf = (over = {}) => ({ kind: "pdf", total_pages: 50, mapped_pages: 50, deep_read_pages: 12, covered_pages: 50, uncovered: "", sourceSha: "sha-1", ...over });
assert.deepEqual(coverageCheck(pdf(), "sha-1")[0], []);
assert.match(coverageCheck(pdf(), "sha-1")[2], /All 50 pages inspected: 50 mapped, 12 deep-read/);
assert.match(coverageCheck(pdf({ covered_pages: 47, uncovered: "48-50" }), "sha-1")[0][0], /3 of 50 pages were never inspected \(pages 48-50\)/);
assert.match(coverageCheck(pdf(), "sha-2")[0][0], /different version of the document/, "coverage of another version of the file is stale");
assert.match(coverageCheck(pdf({ total_pages: null }), "sha-1")[0][0], /page count is unknown/);
assert.deepEqual(coverageCheck(null, "sha-1").slice(0, 2), [["The reading does not record that the whole source was inspected."], "read"]);
assert.match(coverageCheck({ kind: "text", total_lines: 9, scanned_lines: 9, total_sections: 3, sections_read: 2 }, null)[0][0], /1 of 3 sections were never read/);
// And it is part of validation: a reading that did not cover its source fails, and is read again.
const plan = { name: "Plan A", plan_code: "A1", network: "Choice Plus", deductible: "$1,000", oop_max: "$5,000", rates: { EE: 1, ES: 2, EC: 3, FAM: 4 }, option_id: "NW1", source: { identity: [1], benefits: [1], rates: [2], sheet: "", rows: "", appearances: 2, codes: ["A1"] } };
const reading = (coverage) => ({ plans: [plan], reconciliation: { plan_appearances: 2, unique_plans: 1, unique_ppo: 1, unique_epo: 0, expected: 1, reader_unique_plans: 1 }, extraction: { sourceSha: "sha-1" }, coverage });
assert.equal(validatePlans({ extracted: reading(pdf()), sourceSha: "sha-1" }).ok, true);
const v = validatePlans({ extracted: reading(pdf({ covered_pages: 49, uncovered: "50" })), sourceSha: "sha-1" });
assert.deepEqual(v.checks.filter((k) => !k.ok).map((k) => k.key), ["coverage"]);
assert.equal(v.fix, "read");

server.close();
console.log("source coverage: every PDF page, every workbook sheet, every CSV line and section recorded as inspected from what was actually read, tied to the document version, and required by validation - ok");

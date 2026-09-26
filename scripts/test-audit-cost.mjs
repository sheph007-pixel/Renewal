// The dual audit, cut down to what each job needs - and every plan still
// checked by both models. Against a stand-in for both auditors:
//  1. A 100-plan, 120-page PDF: ONE document reconciliation per model, then
//     four 25-plan field batches per model, each from a targeted packet of
//     the pages its plans are cited on; every plan audited exactly once by
//     each model; Verified-grade pass.
//  2. 159 plans: seven batches, every plan once, no missing or duplicate index.
//  3-5. Packets: only cited pages plus header context, a plan cited on pages
//     3, 20 and 52 gets all three, a page shared by plans is sent once.
//  6. Missing provenance: that batch reads the full source.
//  7-8. Resumable: a failed Claude batch 4 re-runs only batch 4; an OpenAI
//     failure never re-runs Claude.
//  9-11. Versioning: a new source SHA re-runs everything; a changed value
//     re-runs only its batch (both models); a renamed plan re-runs the
//     document reconciliation too.
//  12. A document plan count that differs from the database is never a pass,
//     whatever the batches say.
//  13. Every plan's every field is compared for BOTH models.
//  14. Full-source fallback (an auditor says a packet lacked context, or no
//     provenance at all) still reaches a correct pass.
//  15. The 1-hour cache is on the full-source blocks and the shared system
//     prompt (and the reader's), never on single-use packets.
//  16. Telemetry: operation, model, tokens, cache reads/writes, source sent.
//  17. What a client sees is unchanged (auditForClient).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { auditProposal, auditBatches, auditProgress, auditForClient, readingVersion, SOURCE_CACHE, _claudeSource } from "../server/proposal-audit.js";
import { pdfPacketPages, runs } from "../server/audit-packets.js";
import { withUsage, recordUsage, memoryUsage, clearMemoryUsage, anthropicUsage, openaiUsage, summarize, estimateCost } from "../server/ai-usage.js";
import { AUDIT_STANDARD } from "../server/plan-compare.js";

delete process.env.KENNION_FAKE_AI;

async function pdfOf(n) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < n; i++) pdf.addPage([200, 200]).drawText(`page ${i + 1}`);
  return Buffer.from(await pdf.save());
}

/**
 * A carrier-style layout: a summary section (10 plans a page), a benefit
 * section (2 plans a page) and a rate grid (5 plans a page), each plan cited
 * on one page of each.
 */
function reading(N, { summaryFrom = 3, benefitFrom = 20, rateFrom = 80, noSource = [] } = {}) {
  const plans = Array.from({ length: N }, (_, i) => ({
    name: `P${1000 + i}i80LX21B`,
    plan_code: `C${i}`,
    network: "Choice Plus",
    plan_type: "PPO",
    deductible: `$${1000 + i}`,
    oop_max: "$6,000",
    benefits: { doctor_visit: "$30", specialist: "$60", imaging: "20%", urgent_care: "$75", emergency_room: "$350", hospital: "20%", rx: "$10 / $40 / $80", coinsurance: "20%", hsa_eligible: "no" },
    rates: { EE: 500 + i, ES: 1000 + i, EC: 900 + i, FAM: 1500 + i },
    option_id: `UH${i + 1}`,
    source: noSource.includes(i)
      ? null
      : { identity: [summaryFrom + Math.floor(i / 10)], benefits: [benefitFrom + Math.floor(i / 2)], rates: [rateFrom + Math.floor(i / 5)], sheet: "", rows: "", appearances: 3, codes: [`C${i}`] },
  }));
  return { plans, extraction: { method: "mapped" }, coverage: { kind: "pdf", total_pages: 120, covered_pages: 120 }, reconciliation: { plan_appearances: N * 3, unique_plans: N, unique_ppo: N, unique_epo: 0, expected: N } };
}

/** What the document prints for plan i (the truth the stand-in auditors read). */
const printed = (x, i, over = {}) => {
  const p = x.plans[i];
  return { index: i, on_document: true, name: p.name, plan_code: p.plan_code, network: p.network, deductible: p.deductible, oop_max: p.oop_max, ...p.benefits, benefits_belong: true, ...p.rates, ...over };
};

/**
 * Both stand-in auditors. Records every call. A field batch answered from a
 * packet checks the packet really holds every cited page of every plan it is
 * asked about - otherwise it says so (insufficient_context), like a careful
 * auditor. `fail(call)` can throw to simulate an outage; `docCount` and
 * `truth` shape what the document says.
 */
function auditors(x, { fail = () => false, docCount = null, truth = (i) => printed(x, i), insufficient = () => false } = {}) {
  const calls = [];
  const transport = async ({ provider, kind, batch, indices, packet, payload }) => {
    const call = { provider, kind, batch: batch ?? null, indices, full: !!(packet && packet.full), pages: packet && packet.pages ? packet.pages : null, reason: (packet && packet.reason) || null };
    calls.push(call);
    if (fail(call)) throw new Error("429 rate limited");
    if (kind === "combined") {
      assert.match(payload, /BOTH the document-level reconciliation and the plan field audit/);
      const n = docCount ?? x.plans.length;
      return { verdict: "pass", plan_appearances: n * 3, plans_found_total: n, epo_excluded: 0, document_plan_count: n, duplicates_found: false, missing_indices: [], extra_plans: [], inconsistent_plans: [], all_pages_readable: true, unreadable_pages: "", notes: "", plan_confirmations: indices.map(truth) };
    }
    if (kind === "doc") {
      assert.match(payload, /DOCUMENT-LEVEL RECONCILIATION/);
      const n = docCount ?? x.plans.length;
      return { verdict: "pass", plan_appearances: n * 3, plans_found_total: n, epo_excluded: 0, document_plan_count: n, duplicates_found: false, missing_indices: [], extra_plans: [], inconsistent_plans: [], all_pages_readable: true, unreadable_pages: "", notes: "" };
    }
    assert.doesNotMatch(payload, /Count the plans on the document/, "a field batch never recounts the document");
    const told = JSON.parse(payload.split("The plans to find and read:\n")[1].split("\n\nRead every")[0]);
    for (const t of told) {
      assert.deepEqual(Object.keys(t).sort(), ["id", "index", "name", "network", "plan_code", "plan_type", "source_pages"], "locators only");
    }
    if (!call.full) {
      const holds = indices.every((i) => {
        const s = x.plans[i].source;
        return s && [...s.identity, ...s.benefits, ...s.rates].every((p) => call.pages.includes(p));
      });
      if (!holds || insufficient(call)) return { verdict: "pass", plan_confirmations: [], insufficient_context: true, notes: "The packet lacks a plan's page." };
    }
    return { verdict: "pass", plan_confirmations: indices.map(truth), insufficient_context: false, notes: "" };
  };
  return { calls, transport };
}

const by = (calls, provider, kind) => calls.filter((c) => c.provider === provider && c.kind === kind);
const store = () => {
  const jobs = {};
  return { jobs, saveJob: async (id, data) => void (jobs[id] = data) };
};
const run = (x, buffer, t, extra = {}) => auditProposal({ filename: "quote.pdf", mime: "application/pdf", buffer, extracted: x, sourceSha: "sha-1", transport: t.transport, ...extra });

const pdf120 = await pdfOf(120);

// 1. 100 plans.
let x = reading(100);
let t = auditors(x);
let s = store();
let a = await run(x, pdf120, t, s);
assert.equal(a.status, "pass", JSON.stringify(a.mismatches.slice(0, 3)));
for (const p of ["claude", "openai"]) {
  assert.equal(by(t.calls, p, "doc").length, 1, `${p}: one full-document reconciliation`);
  assert.ok(by(t.calls, p, "doc").every((c) => c.full), "the reconciliation reads the whole document");
  const b = by(t.calls, p, "batch");
  assert.equal(b.length, 4, `${p}: four field batches`);
  assert.ok(b.every((c) => !c.full), "every batch from a targeted packet");
  assert.deepEqual(b.map((c) => c.indices), auditBatches(100), "every plan exactly once, in order");
  assert.ok(b.every((c) => c.pages.length < 40), `packets are small: ${b.map((c) => c.pages.length)}`);
}
assert.ok(a.models.every((m) => m.confirmed === 100 && m.of === 100 && m.documentPlanCount === 100 && m.verdict === "pass"));
assert.equal(a.version, readingVersion(x));
assert.equal(Object.keys(s.jobs).length, 10, "every job saved: 2 documents + 8 batches");

// A small quote (one batch): ONE full-source call per model does both jobs -
// never a reconciliation plus a packet that would re-send most of it.
{
  const small = reading(6);
  const ts = auditors(small);
  const ss = store();
  const as = await run(small, pdf120, ts, ss);
  assert.equal(as.status, "pass");
  assert.deepEqual(ts.calls.map((c) => [c.provider, c.kind, c.full]).sort(), [["claude", "combined", true], ["openai", "combined", true]]);
  assert.ok(as.models.every((m) => m.confirmed === 6 && m.documentPlanCount === 6));
  const again = auditors(small);
  await run(small, pdf120, again, ss);
  assert.equal(again.calls.length, 0, "a finished audit of the same reading is never paid for twice");
}

// 2. 159 plans.
const pdf300 = await pdfOf(300);
const x159 = reading(159, { summaryFrom: 3, benefitFrom: 30, rateFrom: 120 });
t = auditors(x159);
a = await run(x159, pdf300, t);
assert.equal(a.status, "pass");
for (const p of ["claude", "openai"]) {
  const idx = by(t.calls, p, "batch").flatMap((c) => c.indices);
  assert.equal(by(t.calls, p, "batch").length, 7, "seven batches");
  assert.equal(by(t.calls, p, "doc").length, 1);
  assert.equal(idx.length, 159);
  assert.deepEqual([...new Set(idx)].sort((m, n) => m - n), Array.from({ length: 159 }, (_, i) => i), "no missing or duplicate index");
}

// 3-5. Packet contents.
const first = by(t.calls, "claude", "batch")[0];
const cited = [...new Set(x159.plans.slice(0, 25).flatMap((p) => [...p.source.identity, ...p.source.benefits, ...p.source.rates]))].sort((m, n) => m - n);
const context = [1, ...runs(cited).map(([f]) => f - 1).filter((p) => p > 0)];
assert.deepEqual(first.pages, [...new Set([...cited, ...context])].sort((m, n) => m - n), "cited pages plus the cover and each run's preceding page, nothing else");
assert.deepEqual(pdfPacketPages([{ source: { identity: [3], benefits: [20], rates: [52] } }], 120).cited, [3, 20, 52], "identity 3, benefits 20, rates 52: all three");
const shared = pdfPacketPages([{ source: { identity: [3], benefits: [20], rates: [52] } }, { source: { identity: [3], benefits: [20], rates: [52] } }], 120);
assert.deepEqual(shared.pages, [...new Set(shared.pages)], "a page two plans share is sent once");
assert.equal(shared.pages.filter((p) => p === 3).length, 1);

// 6. Missing provenance: that batch reads the full source; the others stay targeted.
x = reading(100, { noSource: [60] });
t = auditors(x);
a = await run(x, pdf120, t);
assert.equal(a.status, "pass");
const b3 = by(t.calls, "claude", "batch").find((c) => c.indices.includes(60));
assert.ok(b3.full && /without source pages/.test(b3.reason), "no provenance -> full source");
assert.ok(by(t.calls, "claude", "batch").filter((c) => !c.indices.includes(60)).every((c) => !c.full));

// 7. Claude batch 4 fails: jobs 1-3 are kept; the retry runs batch 4 only.
x = reading(100);
s = store();
let failed = false;
t = auditors(x, { fail: (c) => c.provider === "claude" && c.batch === 3 && !failed && (failed = true) });
a = await run(x, pdf120, t, s);
assert.equal(a.status, "pending", "a failed batch is never a pass");
assert.ok(/Batch 4 of 4/.test(a.models[0].notes));
assert.deepEqual(auditProgress(x, "sha-1", s.jobs).claude.next, "Claude batch 4 of 4", "the next missing step is named");
assert.equal(auditProgress(x, "sha-1", s.jobs).openai.next, null, "OpenAI finished");
t = auditors(x);
a = await run(x, pdf120, t, s);
assert.equal(a.status, "pass");
assert.deepEqual(t.calls.map((c) => [c.provider, c.kind, c.batch]), [["claude", "batch", 3]], "only Claude batch 4 ran again");
assert.ok(a.models.every((m) => m.confirmed === 100), "the reused batches still count every plan");

// 8. OpenAI fails: Claude's finished audit is never re-run.
s = store();
t = auditors(x, { fail: (c) => c.provider === "openai" && c.kind === "doc" });
a = await run(x, pdf120, t, s);
assert.equal(a.status, "pending");
assert.equal(a.models[0].verdict, "pass");
t = auditors(x);
a = await run(x, pdf120, t, s);
assert.equal(a.status, "pass");
assert.equal(by(t.calls, "claude", "doc").length + by(t.calls, "claude", "batch").length, 0, "no Claude call");
assert.equal(by(t.calls, "openai", "batch").length, 4);

// 9. A new source SHA: nothing saved counts.
t = auditors(x);
a = await auditProposal({ filename: "quote.pdf", mime: "application/pdf", buffer: pdf120, extracted: x, sourceSha: "sha-2", transport: t.transport, jobs: s.jobs });
assert.equal(t.calls.length, 10, "every job again against the new document");

// 10-11. A corrected value re-runs only its batch (both models); the document
// reconciliation still counts. A renamed plan re-runs the reconciliation too.
const x2 = structuredClone(x);
x2.plans[30].rates.EE = 777;
assert.notEqual(readingVersion(x2), readingVersion(x), "a new reading version");
t = auditors(x2);
a = await run(x2, pdf120, t, s);
assert.equal(a.status, "pass");
assert.deepEqual(t.calls.map((c) => [c.provider, c.kind, c.batch]).sort(), [["claude", "batch", 1], ["openai", "batch", 1]], "only batch 2 (plans 25-49) ran again, for each model");
assert.equal(a.version, readingVersion(x2), "the audit names the new reading");
const x3 = structuredClone(x2);
x3.plans[5].name = "P1005i80LX21B RENAMED";
t = auditors(x3);
await run(x3, pdf120, t, s);
assert.deepEqual(t.calls.map((c) => [c.provider, c.kind, c.batch]).sort(), [["claude", "batch", 0], ["claude", "doc", null], ["openai", "batch", 0], ["openai", "doc", null]], "a plan's identity changed: the reconciliation and its batch");

// 12. The document counts one plan more than the database: not a pass, whatever the batches say.
t = auditors(x, { docCount: 101 });
a = await run(x, pdf120, t);
assert.equal(a.status, "issues");
assert.equal(a.mismatches.filter((m) => m.field === "plan_count").length, 2, "held to the database by each model");
assert.ok(a.models.every((m) => m.confirmed === 100), "though every batch confirmed every plan");

// 13. One wrong copay on plan 77: each model's field audit catches it, in code.
t = auditors(x, { truth: (i) => printed(x, i, i === 77 ? { specialist: "$65" } : {}) });
a = await run(x, pdf120, t);
assert.equal(a.status, "issues");
assert.deepEqual(a.mismatches.map((m) => [m.index, m.field, m.by.replace(/ \(.*/, "")]).sort(), [[77, "benefit specialist", "ChatGPT"], [77, "benefit specialist", "Claude"]]);
assert.ok(a.models.every((m) => m.confirmed === 100 && m.of === 100), "every plan's fields compared for both models");

// 14. Fallbacks still reach a correct pass: an auditor says one packet lacked
//     context (that batch is read against the full source), and a reading
//     with no provenance at all is audited from the full source throughout.
t = auditors(x, { insufficient: (c) => c.provider === "openai" && c.batch === 2 });
a = await run(x, pdf120, t);
assert.equal(a.status, "pass");
const ob = by(t.calls, "openai", "batch").filter((c) => c.batch === 2);
assert.deepEqual(ob.map((c) => c.full), [false, true], "targeted, then the full source");
assert.equal(a.models[1].batches[2].source.full, true);
const bare = reading(60, { noSource: Array.from({ length: 60 }, (_, i) => i) });
t = auditors(bare);
a = await run(bare, pdf120, t);
assert.equal(a.status, "pass");
assert.ok(by(t.calls, "claude", "batch").every((c) => c.full));

// 15. The 1-hour cache: on full-source blocks and the shared system prompt; not on packets.
assert.deepEqual(SOURCE_CACHE, { type: "ephemeral", ttl: "1h" });
const full = _claudeSource("q.pdf", { kind: "pdf", buffer: pdf120 }, { full: true });
assert.deepEqual(full.cache_control, { type: "ephemeral", ttl: "1h" });
const packetBlock = _claudeSource("q.pdf", { kind: "pdf", buffer: pdf120 }, { full: false, kind: "pdf", buffer: pdf120, pages: [1, 2] });
assert.equal(packetBlock.cache_control, undefined, "a single-use packet is not written to the cache");
const src = readFileSync(new URL("../server/proposal-audit.js", import.meta.url), "utf8");
assert.match(src, /system: \[withCache\(\{ type: "text", text: AUDITOR_SYSTEM \}\)\]/, "the shared auditor system prompt is cached");
assert.match(src, /system: \[withCache\(\{ type: "text", text: CORRECTION_INSTRUCTIONS \}\)\]/);
assert.match(readFileSync(new URL("../server/ai.js", import.meta.url), "utf8"), /system: \[\{ type: "text", text: SYSTEM, cache_control: \{ type: "ephemeral", ttl: "1h" \} \}\]/);

// 16. Telemetry.
clearMemoryUsage();
const au = anthropicUsage({ usage: { input_tokens: 1200, output_tokens: 900, cache_read_input_tokens: 50000, cache_creation_input_tokens: 80000, cache_creation: { ephemeral_1h_input_tokens: 80000, ephemeral_5m_input_tokens: 0 } } });
assert.deepEqual([au.inputTokens, au.outputTokens, au.cacheReadTokens, au.cacheWriteTokens, au.cacheWrite1hTokens], [1200, 900, 50000, 80000, 80000]);
const ou = openaiUsage({ usage: { prompt_tokens: 10000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 8000 } } });
assert.deepEqual([ou.inputTokens, ou.cacheReadTokens, ou.outputTokens], [2000, 8000, 500]);
await withUsage({ proposalId: 42, groupName: "Acme", slot: "UHC Level Funded", sourceSha: "sha-1", readingVersion: "v1", auditStandard: AUDIT_STANDARD }, async () => {
  recordUsage({ purpose: "plan-audit-claude", provider: "anthropic", model: "claude-sonnet-5", servedModel: "claude-sonnet-5", batch: 2, plansInBatch: 25, source: { full: false, pages: [1, 2, 3], of: 120 }, usage: au, durationMs: 1234, retries: 1, ok: true });
  recordUsage({ purpose: "extraction", provider: "anthropic", model: "claude-sonnet-5", servedModel: "claude-opus-5", usage: au, durationMs: 10, ok: true });
});
const recs = memoryUsage();
assert.equal(recs.length, 2);
assert.deepEqual([recs[0].proposalId, recs[0].groupName, recs[0].slot, recs[0].sourceSha, recs[0].readingVersion, recs[0].auditStandard, recs[0].purpose, recs[0].batch, recs[0].plansInBatch, recs[0].retries, recs[0].cacheReadTokens, recs[0].cacheWrite1hTokens], [42, "Acme", "UHC Level Funded", "sha-1", "v1", AUDIT_STANDARD, "plan-audit-claude", 2, 25, 1, 50000, 80000]);
assert.equal(recs[0].costUsd, null, "no published price for Sonnet 5 here: no cost is guessed");
assert.equal(recs[1].servedModel, "claude-opus-5", "the model that actually served the call is recorded");
assert.equal(recs[1].costUsd, estimateCost("claude-opus-5", au));
assert.equal(estimateCost("claude-opus-5", { inputTokens: 1e6, outputTokens: 0 }), 5, "Opus 5: $5 per million input tokens");
const sum = summarize(recs);
assert.equal(sum.byModel["claude-opus-5"].calls, 1);
assert.equal(sum.byPurpose["plan-audit-claude"].cacheReadTokens, 50000);

// Gravie: a parser-read workbook's batch is sent its own sheet's header and
// plan rows (Excel row numbers kept, cells as the workbook holds them) - not
// the other rate sheets, and never the static Benefits Grid.
{
  const XLSX = await import("xlsx");
  const { parseGravieWorkbook, gravieExtracted } = await import("../server/gravie-parse.js");
  const { buildPacket } = await import("../server/audit-packets.js");
  const head = [["Gravie"], ["Group Name:", "Example Co"], ["Effective Date", 46388, null, "EE:", 10], ["Quote Number:", "Q1", null, "ES:", 2], ["Network:", "Cigna OAP", null, "EC:", 1], ["PBM:", "ESI", null, "F:", 3], [], [], ["Plan Name", "Plan Type", "Deductible", "OOPM", "Coinsurance", "Column1", "EE Rate", "ES Rate", "EC Rate", "F Rate"]];
  const rows = (tag, n) => Array.from({ length: n }, (_, i) => [`Gravie Copay $${1000 + i} ${tag}`.trim(), "Copay", `$${1000 + i}/$${2000 + i}`, "$6000/$12000", 0.2, 0, 400 + i, 800, 700, 1200]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...head, ...rows("", 40)]), "PPO");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...head, ...rows("EPO", 40)]), "EPO");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Gravie"], ["Plan Type", "Preventative"], ["Copay", "No Cost"]]), "Benefits Grid (static)");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const gx = gravieExtracted(parseGravieWorkbook(buf));
  assert.equal(gx.plans.length, 80);
  const { prepareForModel } = await import("../server/intake.js");
  const prepared = await prepareForModel({ filename: "gravie.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf });
  const batch0 = gx.plans.slice(0, 25).map((pl) => ({ name: pl.name, source_pages: { sheet: pl.source.sheet, rows: pl.source.rows } }));
  const pk = await buildPacket({ prepared, source: { buffer: buf, filename: "gravie.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, plans: batch0, exactRows: true });
  assert.equal(pk.full, false);
  assert.deepEqual(pk.sheets.map((sh) => sh.sheet), ["PPO"], "only the sheet these plans are on");
  assert.ok(!/Benefits Grid|EPO Rate|Gravie Copay \$1000 EPO/.test(pk.text), "not the EPO sheet, not the Benefits Grid");
  assert.match(pk.text, /^## Sheet: PPO/);
  assert.match(pk.text, /R9: "Plan Name", "Plan Type"/, "the column header row, by its Excel row number");
  assert.match(pk.text, /R10: "Gravie Copay \$1000", "Copay", "\$1000\/\$2000", "\$6000\/\$12000", 0\.2, 0, 400,/, "a plan row as the workbook holds it (0.2, not 20%)");
  assert.ok(!/R35:/.test(pk.text), "rows of plans in other batches are left out");
  assert.ok(pk.text.length < prepared.text.length / 2, `smaller than the workbook text: ${pk.text.length} vs ${prepared.text.length}`);
  // An AI-read workbook's own row citations are not trusted: the whole cited sheet goes instead.
  const whole = await buildPacket({ prepared, source: { buffer: buf, filename: "gravie.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, plans: batch0, exactRows: false });
  assert.match(whole.text, /R49:/, "every row of the cited sheet");
  assert.ok(!/## Sheet: EPO/.test(whole.text), "still only the cited sheet");
  // A CSV / text source read by a model: full source for field batches.
  const csv = await buildPacket({ prepared: { kind: "text", text: "a\nb\nc" }, source: { filename: "q.csv", mime: "text/csv" }, plans: [{ name: "x", source_pages: { rows: "rows 2-3" } }], exactRows: false });
  assert.equal(csv.full, true);
}

// 17. Client-facing: the same outcome and date, nothing more.
a = await run(x, pdf120, auditors(x));
assert.deepEqual(Object.keys(auditForClient(a, x)).sort(), ["completedAt", "status"]);
assert.equal(auditForClient(a, x).status, "pass");
assert.equal(auditForClient(a, x2), null, "an audit of another reading is no audit of this one");

// 18. A ChatGPT model switch: ChatGPT's half of the audit is done again by
//     the new model; Claude's saved jobs are used as they are, with no call.
{
  delete process.env.CHATGPT_MODEL;
  const xm = reading(30);
  const sm = store();
  await run(xm, pdf120, auditors(xm), sm);
  const openaiJobs = Object.entries(sm.jobs).filter(([k]) => k.startsWith("openai:"));
  assert.ok(openaiJobs.length >= 2 && openaiJobs.every(([, j]) => j.model === "gpt-5"), "a ChatGPT job records its model");
  assert.ok(Object.entries(sm.jobs).filter(([k]) => k.startsWith("claude:")).every(([, j]) => j.model === undefined));
  process.env.CHATGPT_MODEL = "gpt-6-astra";
  const prog = auditProgress(xm, "sha-1", sm.jobs);
  assert.equal(prog.claude.next, null, "Claude's saved audit still counts");
  assert.match(prog.openai.next, /OpenAI document reconciliation/, "ChatGPT's jobs by gpt-5 no longer count");
  const t2 = auditors(xm);
  const a2 = await run(xm, pdf120, t2, sm);
  assert.equal(t2.calls.filter((c) => c.provider === "claude").length, 0, "Claude is not asked again");
  assert.equal(t2.calls.filter((c) => c.provider === "openai").length, openaiJobs.length, "every ChatGPT job runs again");
  assert.equal(a2.status, "pass");
  assert.ok(Object.entries(sm.jobs).filter(([k]) => k.startsWith("openai:")).every(([, j]) => j.model === "gpt-6-astra"), "saved as the new model's jobs");
  assert.equal(auditProgress(xm, "sha-1", sm.jobs).openai.next, null);
  delete process.env.CHATGPT_MODEL;
}

console.log("audit cost: one document reconciliation per model, targeted field packets, every plan once per model, resumable and versioned jobs, full-source fallback, 1h cache, usage telemetry - ok");

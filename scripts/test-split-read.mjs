// A proposal whose reading does not fit in one answer is read in halves,
// down to single pages, and folded back into one - not failed with "longer
// than one reading can hold" on every retry, as Boss Logistics' UHC Level
// Funded quote was. A local stand-in for the Messages API answers
// max_tokens for any request spanning more than two pages, and one plan
// per page otherwise.
import assert from "node:assert/strict";
import http from "node:http";
import { PDFDocument } from "pdf-lib";

const PAGES = 5;
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const j = JSON.parse(body || "{}");
    const content = j.messages[0].content;
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const m = /This is pages (\d+)-(\d+) of a (\d+)-page proposal/.exec(text);
    const [first, last] = m ? [Number(m[1]), Number(m[2])] : [1, PAGES];
    const doc = content.find((c) => c.type === "document");
    const pages = (await PDFDocument.load(Buffer.from(doc.source.data, "base64"))).getPageCount();
    assert.equal(pages, last - first + 1, "the part sent is exactly the pages it says it is");
    seen.push(`${first}-${last}`);
    const tooLong = pages > 2;
    const reading = {
      carrier: "UnitedHealthcare",
      funding: "level funded",
      quotes_medical: true,
      quote_id: null,
      // Only the first page names the employer, as on a real quote.
      group_name_on_document: first === 1 ? "BOSS LOGISTICS" : null,
      matched_group: first === 1 ? "Boss Logistics, LLC" : null,
      confidence: first === 1 ? 0.95 : 0,
      effective_date: "2027-01-01",
      proposal_type: "renewal",
      enrolled_on_document: 12,
      plans: Array.from({ length: pages }, (_, i) => ({
        name: `Plan p${first + i}`,
        plan_code: `P${first + i}`,
        network: "Choice Plus",
        plan_type: "PPO",
        deductible: "$1,000",
        oop_max: "$5,000",
        benefits: { doctor_visit: "", specialist: "", imaging: "", urgent_care: "", hospital: "", rx: "" },
        rates: { EE: 500 + first + i, ES: 1000, EC: 900, FAM: 1500 },
        monthly_total: null,
      })),
      total_monthly: null,
      summary: `pages ${first}-${last}`,
      audit_flags: [],
    };
    // The headline plan is printed again on the last page: one plan, not two.
    if (last === PAGES) reading.plans.push({ ...reading.plans[0], name: "Plan p1", plan_code: "P1", rates: { EE: 501, ES: 1000, EC: 900, FAM: 1500 } });
    const out = tooLong ? JSON.stringify(reading).slice(0, 200) : JSON.stringify(reading);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: out } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: tooLong ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    ev("message_stop", {});
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY = "test";
delete process.env.KENNION_FAKE_AI;

const { analyzeProposal } = await import("../server/ai.js");
const pdf = await PDFDocument.create();
for (let i = 0; i < PAGES; i++) pdf.addPage([200, 200]).drawText(`page ${i + 1}`);
const buffer = Buffer.from(await pdf.save());

const out = await analyzeProposal({ filename: "BOSS LOGISTICS WC UHC LF GRX.pdf", prepared: { kind: "pdf", buffer }, context: null }, [{ name: "Boss Logistics, LLC", enrolled: 12, tpa: null }]);
assert.deepEqual(
  out.plans.map((p) => p.name),
  ["Plan p1", "Plan p2", "Plan p3", "Plan p4", "Plan p5"],
  "every page's plans, in order, and the repeat of the headline plan once",
);
assert.equal(out.matched_group, "Boss Logistics, LLC");
assert.equal(out.confidence, 0.95, "parts that name no employer do not drag the match down");
assert.ok(out.audit_flags.some((f) => /Read in \d+ parts/.test(f)));
assert.deepEqual(seen, ["1-5", "1-3", "1-2", "3-3", "4-5"], "halved until each part fits");

server.close();
console.log("split read: a proposal too long for one answer is read in parts and merged - ok");

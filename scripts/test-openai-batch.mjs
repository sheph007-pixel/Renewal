// Background ChatGPT work through the OpenAI Batch API (server/openai-batch.js),
// against a stand-in for /v1/files and /v1/batches: outside a batch scope a
// call is made directly; inside one, calls are written as JSONL - each line
// the exact Chat Completions body, its json_schema response_format intact -
// uploaded, started as one batch, the proposals marked with the batch id,
// and each caller handed its own answer when the batch ends; the answer
// goes on into plan-canonical.js and plan-validate.js like a direct one. The
// same request is sent once; a batch that cannot be made, or ends without
// an answer, falls back to a direct call; a batch open across a restart is
// followed again and its orphaned answers kept for the request asked again.
import assert from "node:assert/strict";
process.env.CHATGPT_API_KEY = "test-key";
process.env.KENNION_OPENAI_BATCH_WINDOW_MS = "20";
process.env.KENNION_OPENAI_BATCH_POLL_MS = "20";
const { withBatch } = await import("../server/claude-batch.js");
const { withUsage } = await import("../server/ai-usage.js");
const ob = await import("../server/openai-batch.js");
const { openaiMessage, _setOpenAIPoster } = await import("../server/ai-failover.js");
const { canonicalizePlans } = await import("../server/plan-canonical.js");
const { validatePlans } = await import("../server/plan-validate.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await wait(10);
  }
  throw new Error(`timed out: ${what}`);
};

// A stand-in for OpenAI's files and batches endpoints.
function fakeOpenAI({ answer, failCreate = false } = {}) {
  const files = new Map();
  const batches = new Map();
  const uploads = [];
  let n = 0;
  return {
    uploads,
    batches,
    async upload(jsonl) {
      const id = `file-in-${++n}`;
      files.set(id, jsonl);
      uploads.push(jsonl);
      return id;
    },
    async create(fileId) {
      if (failCreate) throw new Error("OpenAI batch: You exceeded your current quota");
      const id = `batch_${++n}`;
      batches.set(id, { id, status: "in_progress", input: fileId });
      return { id, status: "validating" };
    },
    async retrieve(id) {
      return batches.get(id);
    },
    async content(fileId) {
      return files.get(fileId);
    },
    // Finish a batch: answer every line with answer(body), or end it as `status` with no output.
    finish(id, status = "completed") {
      const b = batches.get(id);
      const lines = files.get(b.input).split("\n").map((l) => JSON.parse(l));
      if (status === "completed") {
        const out = `file-out-${id}`;
        files.set(out, lines.map((l) => JSON.stringify({ id: `r-${l.custom_id}`, custom_id: l.custom_id, response: { status_code: 200, body: answer(l.body) }, error: null })).join("\n"));
        Object.assign(b, { status, output_file_id: out, request_counts: { total: lines.length, completed: lines.length, failed: 0 } });
      } else if (status === "line-error") {
        const err = `file-err-${id}`;
        files.set(err, lines.map((l) => JSON.stringify({ id: `r-${l.custom_id}`, custom_id: l.custom_id, response: { status_code: 400, body: { error: { message: "This request shape is not supported in batch." } } }, error: null })).join("\n"));
        Object.assign(b, { status: "completed", error_file_id: err, request_counts: { total: lines.length, completed: 0, failed: lines.length } });
      } else Object.assign(b, { status, errors: { data: [{ message: "Enqueued token limit reached" }] }, request_counts: { total: lines.length, completed: 0, failed: lines.length } });
    },
  };
}

const plansFor = (body) => {
  const who = String(body.messages.at(-1).content).match(/for (\S+)/)[1];
  return { plans: [{ name: `Plan ${who}`, plan_code: `C-${who}`, network: "Choice Plus", plan_type: "PPO", deductible: "$1,000", oop_max: "$5,000", benefits: { doctor_visit: "$30", specialist: "$60", imaging: "", urgent_care: "$75", emergency_room: "$350", hospital: "20%", rx: "$10 / $40", coinsurance: "20%", hsa_eligible: "no" }, rates: { EE: 600, ES: 1200, EC: 1080, FAM: 1800 }, monthly_total: null }] };
};
const completion = (body) => ({ id: "cmpl", model: body.model, choices: [{ message: { content: JSON.stringify(plansFor(body)) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
const SCHEMA = { type: "object", required: ["plans"], properties: { plans: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } } };
const params = (who) => ({ max_tokens: 2000, output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content: `read the proposal for ${who}` }] });

let direct = 0;
_setOpenAIPoster((body) => (direct++, { ok: true, status: 200, json: completion(body) }));

// 1. Outside a batch scope: made directly, as before.
let fake = fakeOpenAI({ answer: completion });
await ob.configureOpenAIBatches({ transport: fake });
const m0 = await openaiMessage(params("upload"), { name: "proposal_reading" });
assert.equal(direct, 1, "an upload someone is watching is not batched");
assert.equal(fake.uploads.length, 0);
assert.equal(m0._batched, false);

// 2. In a batch scope: queued, uploaded as JSONL with the json_schema format, one batch, proposals marked.
direct = 0;
const store = ob.memoryStore();
ob._resetOpenAIBatches();
fake = fakeOpenAI({ answer: completion });
await ob.configureOpenAIBatches({ transport: fake, persist: store });
const run = withBatch(() =>
  Promise.all([
    withUsage({ proposalId: 11 }, () => openaiMessage(params("a"), { name: "proposal_reading" })),
    withUsage({ proposalId: 12 }, () => openaiMessage(params("b"), { name: "proposal_reading" })),
    withUsage({ proposalId: 11 }, () => openaiMessage(params("a"), { name: "proposal_reading" })), // the same request again
  ]),
);
await until(() => fake.batches.size === 1, "one batch started");
const lines = fake.uploads[0].split("\n").map((l) => JSON.parse(l));
assert.equal(lines.length, 2, "the same request is sent once");
for (const l of lines) {
  assert.equal(l.method, "POST");
  assert.equal(l.url, "/v1/chat/completions");
  assert.equal(l.body.response_format.type, "json_schema", "the explicit JSON Schema response_format rides in the batch");
  assert.equal(l.body.response_format.json_schema.strict, true);
  assert.deepEqual(l.body.response_format.json_schema.schema.required, ["plans"]);
}
const [batchId] = [...fake.batches.keys()];
assert.equal(store.marks.get("11"), batchId, "proposal 11 carries the batch id");
assert.equal(store.marks.get("12"), batchId);
assert.equal((await store.getOpen())[0].id, batchId, "the open batch is kept for a restart");
fake.finish(batchId);
const [a, b, a2] = await run;
assert.equal(direct, 0, "nothing made directly");
assert.equal(JSON.parse(a.content[0].text).plans[0].name, "Plan a");
assert.equal(JSON.parse(b.content[0].text).plans[0].name, "Plan b");
assert.deepEqual(a2, a, "both callers of the same request get its answer");
assert.equal(a._batched, true);
assert.equal(store.marks.size, 0, "the batch ended: the proposals no longer carry it");
assert.deepEqual(await store.getOpen(), []);

// 3. The batched answer goes on into the existing pipeline: canonical plans, then validation.
const canon = canonicalizePlans(JSON.parse(a.content[0].text).plans.map((pl) => ({ ...pl, source_pages: { identity: [1], benefits: [1], rates: [1] } })));
assert.equal(canon.plans.length, 1);
assert.equal(canon.plans[0].plan_code, "C-a");
const val = validatePlans({ extracted: { plans: canon.plans, reconciliation: canon.reconciliation, extraction: { sourceSha: "sha" } }, sourceSha: "sha" });
for (const key of ["unique", "codes", "names", "rates"]) assert.equal(val.checks.find((c) => c.key === key).ok, true, `validation "${key}" passes on the batched reading`);

// 4. A batch that ends without answers (failed, expired): each request is made directly instead.
direct = 0;
const run2 = withBatch(() => openaiMessage(params("c"), { name: "proposal_reading" }));
await until(() => fake.batches.size === 2, "second batch");
fake.finish([...fake.batches.keys()][1], "failed");
const c = await run2;
assert.equal(JSON.parse(c.content[0].text).plans[0].name, "Plan c", "answered directly after the batch failed");
assert.equal(direct, 1);

// 4b. A line the batch answered with an error (a request the Batch API refuses): made directly.
direct = 0;
const run3 = withBatch(() => openaiMessage(params("f"), { name: "proposal_reading" }));
await until(() => fake.batches.size === 3, "third batch");
fake.finish([...fake.batches.keys()][2], "line-error");
const f = await run3;
assert.equal(JSON.parse(f.content[0].text).plans[0].name, "Plan f", "answered directly, not failed");
assert.equal(direct, 1);

// 5. A batch that cannot be made (the spending limit): made directly - its own answer reaches the caller.
direct = 0;
ob._resetOpenAIBatches();
await ob.configureOpenAIBatches({ transport: fakeOpenAI({ answer: completion, failCreate: true }) });
const d = await withBatch(() => openaiMessage(params("d"), { name: "proposal_reading" }));
assert.equal(JSON.parse(d.content[0].text).plans[0].name, "Plan d");
assert.equal(direct, 1);

// 6. A restart: the open batch is followed again; its answer, with no one waiting, is kept and used once.
direct = 0;
ob._resetOpenAIBatches();
const persist = ob.memoryStore();
fake = fakeOpenAI({ answer: completion });
await ob.configureOpenAIBatches({ transport: fake, persist });
void withBatch(() => openaiMessage(params("e"), { name: "proposal_reading" })).catch(() => undefined); // the caller that restarts away
await until(() => fake.batches.size === 1, "batch before restart");
const open = await persist.getOpen();
ob._resetOpenAIBatches(); // the server restarts
fake.finish(open[0].id);
await persist.setOpen(open);
await ob.configureOpenAIBatches({ transport: fake, persist });
await until(async () => (await persist.getOpen()).length === 0, "followed after restart");
const e = await withBatch(() => openaiMessage(params("e"), { name: "proposal_reading" }));
assert.equal(JSON.parse(e.content[0].text).plans[0].name, "Plan e", "the kept answer is used");
assert.equal(direct, 0, "not paid for twice");
assert.equal(fake.uploads.length, 1, "no second batch");

_setOpenAIPoster(null);
ob._resetOpenAIBatches();
console.log("openai batch: background ChatGPT calls go as JSONL through /v1/files and /v1/batches with their json_schema format; proposals carry the batch id; answers reach each caller and the canonical/validation pipeline; failed batches fall back to direct calls; open batches survive a restart - ok");
process.exit(0);

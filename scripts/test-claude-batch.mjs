// Background Claude calls through the Message Batches API (server/claude-batch.js),
// against a stand-in for the batches endpoints: a call outside a batch scope
// streams as before; inside one, calls are gathered into one batch and each
// caller gets its own Message; the same request asked twice is sent once; a
// request that errors (the spending limit) rejects with the API's message; a
// batch still running across a restart is followed again and its result is
// kept for the request asked again - not paid for twice; batch calls are
// costed at half price.
import assert from "node:assert/strict";
process.env.KENNION_BATCH_WINDOW_MS = "20";
process.env.KENNION_BATCH_POLL_MS = "20";
const { claudeMessage, withBatch, configureBatches, memoryStore, batchState, _resetBatches, requestId } = await import("../server/claude-batch.js");
const { recordUsage, memoryUsage, clearMemoryUsage } = await import("../server/ai-usage.js");

const LIMIT = "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-10-01 at 00:00 UTC.";
function fakeClient() {
  const batches = new Map();
  let n = 0;
  const reply = (params) => ({ id: `msg_${params.messages[0].content}`, type: "message", role: "assistant", model: params.model, content: [{ type: "text", text: `answer to ${params.messages[0].content}` }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  const c = {
    created: [],
    streamed: 0,
    messages: {
      stream: (params) => ({ finalMessage: async () => (c.streamed++, reply(params)) }),
      batches: {
        create: async ({ requests }) => {
          const id = `msgbatch_${++n}`;
          batches.set(id, { requests, polls: 0 });
          c.created.push({ id, count: requests.length });
          return { id, processing_status: "in_progress" };
        },
        retrieve: async (id) => {
          const b = batches.get(id);
          b.polls++;
          return { id, processing_status: b.polls >= 2 ? "ended" : "in_progress", request_counts: { succeeded: b.requests.length } };
        },
        results: async (id) =>
          (async function* () {
            for (const r of batches.get(id).requests) {
              if (String(r.params.messages[0].content).includes("FAIL")) yield { custom_id: r.custom_id, result: { type: "errored", error: { type: "error", error: { type: "rate_limit_error", message: LIMIT } } } };
              else yield { custom_id: r.custom_id, result: { type: "succeeded", message: reply(r.params) } };
            }
          })(),
      },
    },
  };
  return c;
}
const params = (text) => ({ model: "claude-opus-5", max_tokens: 100, messages: [{ role: "user", content: text }] });
const text = (m) => m.content[0].text;

// Outside a batch scope: streamed now, as before.
_resetBatches();
let client = fakeClient();
assert.equal(text(await claudeMessage(client, params("hello"))), "answer to hello");
assert.equal(client.streamed, 1);
assert.equal(client.created.length, 0);

// Inside one: gathered into one batch; a repeated request is sent once.
_resetBatches();
client = fakeClient();
await configureBatches({ client: () => client, persist: memoryStore() });
const [a, b, a2] = await withBatch(() => Promise.all([claudeMessage(client, params("a")), claudeMessage(client, params("b")), claudeMessage(client, params("a"))]));
assert.deepEqual([text(a), text(b), text(a2)], ["answer to a", "answer to b", "answer to a"]);
assert.equal(client.streamed, 0, "nothing streamed");
assert.deepEqual(client.created.map((c) => c.count), [2], "one batch, the repeated request once");
assert.deepEqual(batchState().inFlight, [], "the batch is finished with");

// An errored request rejects with the API's own message (the spending limit is recognised by it).
await assert.rejects(withBatch(() => claudeMessage(client, params("FAIL me"))), /usage limits/);

// A restart while a batch runs: it is followed again, and its result is kept for the request asked again.
_resetBatches();
client = fakeClient();
const persist = memoryStore();
await configureBatches({ client: () => client, persist });
const lost = withBatch(() => claudeMessage(client, params("long read")));
await new Promise((r) => setTimeout(r, 40)); // sent, not yet ended
assert.equal(client.created.length, 1);
const open = await persist.getOpen();
assert.equal(open.length, 1, "the open batch is recorded");
lost.catch(() => undefined);
_resetBatches(); // the server restarts: every waiter is gone
await configureBatches({ client: () => client, persist }); // the same store, as the database would be
await new Promise((r) => setTimeout(r, 120)); // the old batch ends; its result is kept
assert.deepEqual(await persist.getOpen(), [], "nothing left open");
const again = await withBatch(() => claudeMessage(client, params("long read")));
assert.equal(text(again), "answer to long read");
assert.equal(client.created.length, 1, "asked again after the restart: the kept result, no second batch");
assert.equal(await persist.takeResult(requestId(params("long read"))), null, "a kept result is used once");

// Batch calls cost half.
clearMemoryUsage();
recordUsage({ purpose: "extraction", provider: "anthropic", model: "claude-opus-5", usage: { inputTokens: 1_000_000, outputTokens: 0 }, ok: true });
await withBatch(async () => recordUsage({ purpose: "extraction", provider: "anthropic", model: "claude-opus-5", usage: { inputTokens: 1_000_000, outputTokens: 0 }, ok: true }));
const [direct, batched] = memoryUsage().slice(-2);
assert.equal(direct.batched, false);
assert.equal(batched.batched, true);
assert.equal(batched.costUsd, direct.costUsd / 2);
_resetBatches();
console.log("claude batch: background calls gathered into Message Batches (one request per distinct call), each caller gets its own result, errors carry the API's message, a batch survives a restart without being paid twice, batch cost is half - ok");
process.exit(0);

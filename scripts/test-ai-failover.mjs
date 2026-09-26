// Reading and correcting keep going when one AI provider is down
// (server/ai-failover.js): a Claude request translates to Chat Completions
// (PDF, text and image blocks, the system prompt, a strict JSON schema) and
// the answer comes back Claude-shaped; Claude blocked, or failing on its
// spending limit, sends the call to ChatGPT; ChatGPT blocked leaves it with
// Claude; any other failure is not failed over.
import assert from "node:assert/strict";
process.env.CHATGPT_API_KEY = "test-key";
const { strictSchema, toOpenAI, fromOpenAI, withFailover, _setOpenAIPoster } = await import("../server/ai-failover.js");
const { providerBlock, recordUsage } = await import("../server/ai-usage.js");

// Strict schema: every object closed, every property required, optional ones nullable.
const s = strictSchema({ type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "integer" }, c: { type: "object", properties: { d: { anyOf: [{ type: "string" }, { type: "null" }] } } } } });
assert.deepEqual(s.required, ["a", "b", "c"]);
assert.equal(s.additionalProperties, false);
assert.deepEqual(s.properties.b, { anyOf: [{ type: "integer" }, { type: "null" }] }, "optional became nullable");
const c = s.properties.c.anyOf[0];
assert.deepEqual(s.properties.c.anyOf[1], { type: "null" }, "an optional object becomes nullable too");
assert.deepEqual(c.properties.d, { anyOf: [{ type: "string" }, { type: "null" }] }, "already nullable left as is");
assert.deepEqual(c.required, ["d"]);
assert.equal(c.additionalProperties, false, "nested objects are closed as well");

// A Claude request as Chat Completions.
const params = {
  model: "claude-sonnet-5",
  max_tokens: 128000,
  system: [{ type: "text", text: "You read proposals.", cache_control: { type: "ephemeral", ttl: "1h" } }],
  output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object", properties: { plans: { type: "array", items: { type: "string" } } }, required: ["plans"] } } },
  messages: [{ role: "user", content: [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "Acme UHC.pdf" },
    { type: "document", source: { type: "text", media_type: "text/plain", data: "Plan A, $500" }, title: "sheet.xlsx" },
    { type: "text", text: "Read it." },
  ] }],
};
const body = toOpenAI(params, "proposal_reading");
assert.equal(body.messages[0].role, "system");
assert.equal(body.messages[0].content, "You read proposals.");
assert.deepEqual(body.messages[1].content[0], { type: "file", file: { filename: "Acme UHC.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } });
assert.match(body.messages[1].content[1].text, /sheet\.xlsx.*\nPlan A, \$500/s);
assert.deepEqual(body.messages[1].content[2], { type: "text", text: "Read it." });
assert.equal(body.response_format.json_schema.strict, true);
assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
assert.equal(body.max_completion_tokens, 128000);
assert.equal(body.reasoning_effort, "high");

// The answer, Claude-shaped.
const ok = (text, finish = "stop") => ({ ok: true, status: 200, json: { id: "c1", model: "gpt-5-2025-08-07", choices: [{ message: { content: text }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } } });
const m = fromOpenAI(ok('{"plans":["A"]}').json);
assert.equal(m.content[0].text, '{"plans":["A"]}');
assert.equal(m.stop_reason, "end_turn");
assert.equal(m._provider, "openai");
assert.deepEqual([m.usage.input_tokens, m.usage.cache_read_input_tokens, m.usage.output_tokens], [60, 40, 20]);
assert.equal(fromOpenAI(ok("", "length").json).stop_reason, "max_tokens", "cut off = too long, as Claude's max_tokens");

// Failover.
let sent = 0;
_setOpenAIPoster(() => (sent++, ok('{"plans":["from chatgpt"]}')));
const claudeFine = async () => ({ content: [{ type: "text", text: '{"plans":["from claude"]}' }], stop_reason: "end_turn" });
assert.equal((await withFailover(claudeFine, params)).content[0].text, '{"plans":["from claude"]}', "Claude up: Claude answers");
assert.equal(sent, 0);
const LIMIT = "429 You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-10-01 at 00:00 UTC.";
const claudeAtLimit = async () => {
  throw new Error(LIMIT);
};
const r = await withFailover(claudeAtLimit, params, { name: "proposal_reading" });
assert.equal(r.content[0].text, '{"plans":["from chatgpt"]}', "Claude at its limit mid-call: ChatGPT answers the same request");
assert.equal(sent, 1);
assert.ok(providerBlock("anthropic"), "and Claude is held as blocked");
let claudeCalled = false;
await withFailover(async () => ((claudeCalled = true), claudeFine()), params);
assert.equal(claudeCalled, false, "Claude blocked: not asked at all");
assert.equal(sent, 2);
recordUsage({ purpose: "extraction", provider: "anthropic", ok: true }); // Claude back: its block lifts
assert.equal(providerBlock("anthropic"), null);
await assert.rejects(withFailover(async () => {
  throw new Error("overloaded_error");
}, params), /overloaded/, "a failure that is not a spending limit is not failed over");
// Claude at its limit and ChatGPT at its own: the call fails - the steward pauses.
_setOpenAIPoster(() => ({ ok: false, status: 429, json: { error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } } }));
await assert.rejects(withFailover(claudeAtLimit, params), /exceeded your current quota/);
assert.ok(providerBlock("openai"), "ChatGPT held as blocked");
_setOpenAIPoster(null);
console.log("ai failover: requests translate to ChatGPT and back, Claude at its spending limit sends reading and correcting to ChatGPT (and vice versa), other failures are not failed over - ok");

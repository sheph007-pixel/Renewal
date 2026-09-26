// CHATGPT_MODEL picks ChatGPT's model; when OpenAI refuses that model (an
// unknown name, no access), ChatGPT drops to gpt-5 for the rest of the run
// instead of failing every call. Other errors are not a model refusal.
import assert from "node:assert/strict";
process.env.CHATGPT_API_KEY = "test-key";
process.env.CHATGPT_MODEL = "gpt-6-astra";
const { openaiModel, openaiMessage, noteModelRejected, _setOpenAIPoster, _resetModelRejection } = await import("../server/ai-failover.js");

const ok = (model) => ({ ok: true, status: 200, json: { id: "x", model, choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
const params = { max_tokens: 1000, messages: [{ role: "user", content: "hi" }] };

assert.equal(openaiModel(), "gpt-6-astra", "the configured model is used");

// The configured model works: it stays.
const asked = [];
_setOpenAIPoster((body) => (asked.push(body.model), ok(body.model)));
assert.equal((await openaiMessage(params)).model, "gpt-6-astra");
assert.deepEqual(asked, ["gpt-6-astra"]);

// A 400 about the schema is not a model refusal.
assert.equal(noteModelRejected("gpt-6-astra", 400, { message: "Invalid schema for response_format 'x'" }), false);
assert.equal(noteModelRejected("gpt-6-astra", 429, { message: "Rate limit reached for model gpt-6-astra" }), false, "a rate limit is not a refusal");
assert.equal(openaiModel(), "gpt-6-astra");

// OpenAI refuses the model: the same call is asked again on gpt-5, and later calls use gpt-5.
asked.length = 0;
_setOpenAIPoster((body) => (asked.push(body.model), body.model === "gpt-6-astra" ? { ok: false, status: 404, json: { error: { message: "The model `gpt-6-astra` does not exist or you do not have access to it.", code: "model_not_found" } } } : ok(body.model)));
const m = await openaiMessage(params);
assert.equal(m.model, "gpt-5", "answered by the fallback");
assert.deepEqual(asked, ["gpt-6-astra", "gpt-5"]);
assert.equal(openaiModel(), "gpt-5", "the refusal is remembered");
asked.length = 0;
await openaiMessage(params);
assert.deepEqual(asked, ["gpt-5"], "no second try on the refused model");

// gpt-5 itself refused: nothing to fall back to - the error stands.
_resetModelRejection();
process.env.CHATGPT_MODEL = "gpt-5";
_setOpenAIPoster(() => ({ ok: false, status: 404, json: { error: { message: "The model `gpt-5` does not exist", code: "model_not_found" } } }));
await assert.rejects(openaiMessage(params), /does not exist/);
_setOpenAIPoster(null);
console.log("openai model fallback: CHATGPT_MODEL is used; a refused model drops to gpt-5 for the run; schema errors and rate limits are not refusals - ok");

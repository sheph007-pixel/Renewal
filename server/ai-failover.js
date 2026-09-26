// Reading and correcting keep going when one AI provider is down.
//
// The reader (source map, extraction) and the corrector are Claude calls;
// when Claude cannot answer - its account's spending limit is reached
// (server/ai-usage.js holds the block) - the same request goes to ChatGPT
// instead, translated to the Chat Completions API, and comes back in the
// shape the caller expects (a Claude-style Message: text content,
// stop_reason, usage), so nothing downstream changes. ChatGPT down and
// Claude up is the normal path. Both down: the steward pauses.
//
// The dual AUDIT never fails over: each model audits for itself, so a
// Verified box still has two independent checks; a blocked model's audit
// waits (proposal-audit.js).
import https from "node:https";
import { isQuotaError, providerBlock, noteProviderBlock } from "./ai-usage.js";

export const openaiKey = () => process.env.CHATGPT_API_KEY || process.env.ChatGPT || process.env.CHATGPT || process.env.OPENAI_API_KEY || "";
export const openaiModel = () => process.env.CHATGPT_MODEL || "gpt-5";
const OPENAI_MAX_OUTPUT = 128000;

let poster = null; // tests: a stand-in for the Chat Completions endpoint
/** Tests: answer ChatGPT calls with `fn(body)` -> { ok, status, json } (null restores the network). */
export const _setOpenAIPoster = (fn) => {
  poster = fn;
};

function postJson(url, headers, body, timeoutMs) {
  if (poster) return Promise.resolve(poster(body));
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = {};
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 60000)} minutes`)));
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * A JSON Schema as OpenAI's strict structured output wants it: every object
 * closed (additionalProperties false) with every property required - a
 * property the schema left optional becomes nullable, so its meaning holds.
 */
export function strictSchema(s) {
  if (Array.isArray(s)) return s.map(strictSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "properties" || k === "$defs" || k === "definitions") out[k] = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, strictSchema(ps)]));
    else if (k === "items" || k === "anyOf" || k === "oneOf" || k === "allOf" || k === "not") out[k] = strictSchema(v);
    else out[k] = v;
  }
  const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"));
  if (isObject && out.properties) {
    const had = new Set(out.required || []);
    for (const p of Object.keys(out.properties)) {
      if (!had.has(p)) {
        const ps = out.properties[p];
        const nullableAlready = ps && ((Array.isArray(ps.anyOf) && ps.anyOf.some((x) => x && x.type === "null")) || ps.type === "null" || (Array.isArray(ps.type) && ps.type.includes("null")));
        out.properties[p] = nullableAlready ? ps : { anyOf: [ps, { type: "null" }] };
      }
    }
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

const textOf = (system) => (typeof system === "string" ? system : Array.isArray(system) ? system.map((b) => b.text || "").join("\n\n") : "");

/** A Claude content block as an OpenAI message part. */
function partOf(block) {
  if (!block || typeof block !== "object") return { type: "text", text: String(block ?? "") };
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "document" && block.source) {
    const s = block.source;
    if (s.type === "base64" && /pdf/.test(s.media_type || "")) return { type: "file", file: { filename: `${(block.title || "document").replace(/\.pdf$/i, "")}.pdf`, file_data: `data:application/pdf;base64,${s.data}` } };
    if (s.type === "text") return { type: "text", text: `The document${block.title ? ` (${block.title})` : ""}:\n${s.data}` };
  }
  if (block.type === "image" && block.source && block.source.type === "base64") return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  throw new Error(`cannot send a ${block.type} block to ChatGPT`);
}

/** A Claude Messages request as a Chat Completions request. */
export function toOpenAI(params, name = "result") {
  const messages = [];
  const system = textOf(params.system);
  if (system) messages.push({ role: "system", content: system });
  for (const m of params.messages || []) {
    const content = typeof m.content === "string" ? m.content : m.content.map(partOf);
    messages.push({ role: m.role, content });
  }
  const body = { model: openaiModel(), messages, max_completion_tokens: Math.min(OPENAI_MAX_OUTPUT, params.max_tokens || OPENAI_MAX_OUTPUT) };
  const format = params.output_config && params.output_config.format;
  if (format && format.type === "json_schema" && format.schema) body.response_format = { type: "json_schema", json_schema: { name, strict: true, schema: strictSchema(format.schema) } };
  const effort = params.output_config && params.output_config.effort;
  if (effort) body.reasoning_effort = effort === "max" || effort === "xhigh" ? "high" : effort;
  return body;
}

/** A Chat Completions answer as a Claude-style Message. */
export function fromOpenAI(json) {
  const choice = (json.choices && json.choices[0]) || {};
  const msg = choice.message || {};
  const stop = msg.refusal ? "refusal" : choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "content_filter" ? "refusal" : "end_turn";
  const u = json.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    id: json.id,
    type: "message",
    role: "assistant",
    model: json.model || openaiModel(),
    content: [{ type: "text", text: String(msg.content || "") }],
    stop_reason: stop,
    usage: { input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached), output_tokens: u.completion_tokens || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
    _provider: "openai",
  };
}

/** The request, answered by ChatGPT. Throws with OpenAI's own message (a spending limit is recognised by it). */
export async function openaiMessage(params, { name = "result" } = {}) {
  if (!openaiKey()) throw new Error("ChatGPT is not configured (no OpenAI API key).");
  const body = toOpenAI(params, name);
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await postJson("https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${openaiKey()}` }, body, 30 * 60 * 1000);
      if (r.ok) return fromOpenAI(r.json);
      const e = new Error(`ChatGPT (${openaiModel()}): ${(r.json.error && (r.json.error.message || r.json.error.code)) || `HTTP ${r.status}`}${r.json.error && r.json.error.code ? ` [${r.json.error.code}]` : ""}`);
      e.status = r.status;
      throw e;
    } catch (e) {
      last = e;
      const retryable = !isQuotaError(e.message) && (!e.status || e.status === 429 || e.status >= 500);
      if (!retryable || attempt === 3) break;
      await new Promise((res) => setTimeout(res, poster ? 1 : 15_000 * attempt));
    }
  }
  if (isQuotaError(last && last.message)) noteProviderBlock("openai", last.message);
  throw last;
}

/**
 * A reading or correction call with failover: Claude (`claude()`, the
 * caller's own call - streamed or batched) unless Claude is blocked, then
 * ChatGPT with the same request; Claude failing on its spending limit
 * mid-call falls over to ChatGPT at once.
 */
export async function withFailover(claude, params, { name } = {}) {
  const canOpenAI = !!openaiKey() && !providerBlock("openai");
  if (providerBlock("anthropic") && canOpenAI) return openaiMessage(params, { name });
  try {
    return await claude();
  } catch (e) {
    if (!isQuotaError(e && e.message) || !canOpenAI) throw e;
    noteProviderBlock("anthropic", e.message);
    console.log(`ai failover: Claude is at its spending limit - ${name || "this call"} goes to ChatGPT`);
    return openaiMessage(params, { name });
  }
}

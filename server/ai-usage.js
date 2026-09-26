// API usage telemetry: one record per model call, so it is plain why one
// proposal cost $2 and another $40 - which proposal and version, what the
// call was for (extraction, source-map, document reconciliation, a plan
// audit batch, a correction, a full-source fallback), which model actually
// served it, how much source was sent (pages / sheets / rows / lines), the
// token counts (input, cache writes, cache reads, output), how long it
// took, the retries, and whether it worked.
//
// The proposal context (id, group, slot, source SHA, reading version, audit
// standard) rides an AsyncLocalStorage scope set by the server around each
// proposal job (withUsage), so deep call sites need not thread it through.
// Records go to a sink the server sets (Postgres kennion.ai_usage, else an
// in-memory list); telemetry never throws into the work it measures.
import { AsyncLocalStorage } from "node:async_hooks";
import { batching } from "./claude-batch.js";

const scope = new AsyncLocalStorage();

/** Run `fn` with this proposal context attached to every usage record made inside it. */
export const withUsage = (ctx, fn) => scope.run({ ...(scope.getStore() || {}), ...ctx }, fn);
export const usageContext = () => scope.getStore() || {};

/**
 * Per-million-token list prices, only where Anthropic's own model guide
 * states them (Claude Opus 5 $5/$25; Claude Fable 5.1 $10/$50 with $0.25
 * cache reads). Anything else - Claude Sonnet 5, Haiku, OpenAI - has no
 * built-in price and its cost is left null rather than guessed; set
 * KENNION_MODEL_PRICES (JSON: {"model": {"input": x, "output": y,
 * "cacheRead"?: z}}) to price it. Cache writes bill at 1.25x input (5-minute
 * TTL) and 2x (1-hour); cache reads at 0.1x unless the model says otherwise.
 */
const BUILT_IN_PRICES = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};
function prices() {
  let extra = {};
  try {
    extra = process.env.KENNION_MODEL_PRICES ? JSON.parse(process.env.KENNION_MODEL_PRICES) : {};
  } catch {
    extra = {};
  }
  return { ...BUILT_IN_PRICES, ...extra };
}

/** Estimated cost in USD, or null when the model has no known price. */
export function estimateCost(model, u) {
  const p = prices()[String(model || "").replace(/-\d{8}$/, "")];
  if (!p) return null;
  const M = 1e6;
  const read = p.cacheRead != null ? p.cacheRead : p.input * 0.1;
  const cost =
    ((u.inputTokens || 0) * p.input +
      (u.cacheWrite5mTokens || 0) * p.input * 1.25 +
      (u.cacheWrite1hTokens || 0) * p.input * 2 +
      (u.cacheReadTokens || 0) * read +
      (u.outputTokens || 0) * p.output) /
    M;
  return Math.round(cost * 10000) / 10000;
}

/** An Anthropic response's usage block, as token counts (cache writes split by TTL where the API says). */
export function anthropicUsage(response) {
  const u = (response && response.usage) || {};
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens ?? null;
  const w5m = cc.ephemeral_5m_input_tokens ?? null;
  const writes = u.cache_creation_input_tokens || 0;
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheWriteTokens: writes,
    cacheWrite1hTokens: w1h != null ? w1h : 0,
    cacheWrite5mTokens: w5m != null ? w5m : w1h != null ? Math.max(0, writes - w1h) : writes,
  };
}

/** An OpenAI chat-completions response's usage block, in the same shape (cached prompt tokens are reads). */
export function openaiUsage(json) {
  const u = (json && json.usage) || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    inputTokens: Math.max(0, (u.prompt_tokens || 0) - cached),
    outputTokens: u.completion_tokens || 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheWrite5mTokens: 0,
  };
}

/**
 * A provider's spending limit, as its error says: Anthropic's "your
 * organization has crossed its monthly API usage threshold ... You will
 * regain access on 2026-10-01 at 00:00 UTC", a credit balance too low, or
 * OpenAI's "insufficient_quota". Not a rate limit that clears in a minute:
 * nothing that calls that provider can succeed until someone raises the
 * limit or the date passes.
 */
const QUOTA_ERROR = /usage limits|monthly API usage threshold|credit balance is too low|insufficient_quota|exceeded your current quota|billing/i;
export const isQuotaError = (msg) => QUOTA_ERROR.test(String(msg || ""));
let quotaErrors = 0;
let quotaBlock = null; // { provider, at, until, message }
/** How many quota errors have been seen (a caller compares before and after a step). */
export const quotaErrorCount = () => quotaErrors;
/**
 * The current block, while one is in force. It is re-tested every
 * QUOTA_PROBE_MS: the next call is let through, and a success ends it (the
 * limit may be raised before the date the error names).
 */
const QUOTA_PROBE_MS = Number(process.env.KENNION_QUOTA_PROBE_MS || 30 * 60 * 1000);
export function aiQuotaBlock(now = Date.now()) {
  if (!quotaBlock) return null;
  if (quotaBlock.until && now >= new Date(quotaBlock.until).getTime()) return null;
  if (now - new Date(quotaBlock.at).getTime() >= QUOTA_PROBE_MS) return null;
  return quotaBlock;
}
/** The last block seen, in force or being re-tested (what the page shows). */
export const lastQuotaBlock = () => quotaBlock;
function noteQuota(r, error) {
  if (r.ok !== false && !error) {
    // A call to the blocked provider that worked: the limit is lifted.
    if (quotaBlock && r.provider === quotaBlock.provider) quotaBlock = null;
    return;
  }
  if (!isQuotaError(error)) return;
  quotaErrors++;
  const m = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}))?/i.exec(String(error));
  const until = m ? new Date(`${m[1]}T${m[2] || "00:00"}:00Z`).toISOString() : null;
  if (!quotaBlock) console.error(`ai usage: ${r.provider} spending limit reached${until ? ` until ${until}` : ""} - AI repairs pause until it is lifted`);
  quotaBlock = { provider: r.provider || "?", at: new Date().toISOString(), until, message: String(error).slice(0, 300) };
}

let sink = null;
const memory = [];
const MEMORY_MAX = 5000;
/** Where records go: an async (record) => void. Unset: kept in memory (tests, no database). */
export const setUsageSink = (fn) => {
  sink = fn;
};
/** Records kept in memory (always, the last MEMORY_MAX), newest last. */
export const memoryUsage = () => memory.slice();
export const clearMemoryUsage = () => {
  memory.length = 0;
};

/**
 * Record one model call. `r`: { purpose, provider, model (requested),
 * servedModel?, batch?, plansInBatch?, source? ({ full, pages, of, sheets,
 * lines, reason }), usage? (anthropicUsage / openaiUsage), durationMs,
 * retries, ok, error? }. The proposal context comes from withUsage.
 */
export function recordUsage(r) {
  try {
    const ctx = usageContext();
    const u = r.usage || {};
    const rec = {
      at: new Date().toISOString(),
      proposalId: ctx.proposalId ?? null,
      groupName: ctx.groupName ?? null,
      slot: ctx.slot ?? null,
      sourceSha: ctx.sourceSha ?? null,
      readingVersion: r.readingVersion ?? ctx.readingVersion ?? null,
      auditStandard: r.auditStandard ?? ctx.auditStandard ?? null,
      purpose: r.purpose,
      provider: r.provider,
      model: r.model || null,
      servedModel: r.servedModel || r.model || null,
      batch: Number.isInteger(r.batch) ? r.batch : null,
      plansInBatch: Number.isInteger(r.plansInBatch) ? r.plansInBatch : null,
      source: r.source || null,
      inputTokens: u.inputTokens || 0,
      cacheWriteTokens: u.cacheWriteTokens || 0,
      cacheWrite1hTokens: u.cacheWrite1hTokens || 0,
      cacheReadTokens: u.cacheReadTokens || 0,
      outputTokens: u.outputTokens || 0,
      durationMs: r.durationMs ?? null,
      retries: r.retries || 0,
      ok: r.ok !== false,
      error: r.error ? String(r.error).slice(0, 300) : null,
    };
    noteQuota(r, rec.error);
    // A Claude call made in a batch scope went through the Message Batches
    // API (server/claude-batch.js): billed at half the standard price.
    rec.batched = r.provider === "anthropic" && (r.batched ?? batching());
    const cost = estimateCost(rec.servedModel, { ...u, cacheWrite5mTokens: u.cacheWrite5mTokens || 0 });
    rec.costUsd = cost == null ? null : rec.batched ? Math.round(cost * 5000) / 10000 : cost;
    memory.push(rec);
    if (memory.length > MEMORY_MAX) memory.splice(0, memory.length - MEMORY_MAX);
    if (sink) Promise.resolve(sink(rec)).catch((e) => console.error("ai usage: could not record:", e.message));
    console.log(
      `ai usage: ${rec.purpose}${rec.batch != null ? ` #${rec.batch + 1}` : ""}${rec.batched ? " (batch)" : ""} ${rec.servedModel}${rec.servedModel !== rec.model ? ` (asked ${rec.model})` : ""}${rec.proposalId != null ? ` proposal ${rec.proposalId}` : ""}: in ${rec.inputTokens}, cache write ${rec.cacheWriteTokens}, cache read ${rec.cacheReadTokens}, out ${rec.outputTokens}${rec.source ? `, source ${describeSource(rec.source)}` : ""}${rec.costUsd != null ? `, ~$${rec.costUsd}` : ""}, ${rec.durationMs ?? "?"}ms${rec.ok ? "" : ` FAILED: ${rec.error}`}`,
    );
    return rec;
  } catch (e) {
    console.error("ai usage: could not record:", e.message);
    return null;
  }
}

/** "full 120 pages", "pages 3-5, 20 of 120", "sheet PPO rows 1-17, 18-42". */
export function describeSource(s) {
  if (!s) return "-";
  if (s.full) return `full${s.of ? ` ${s.of} ${s.unit || "pages"}` : ""}${s.reason ? ` (${s.reason})` : ""}`;
  if (s.pages) return `pages ${s.pages.length} of ${s.of ?? "?"}`;
  if (s.sheets) return s.sheets.map((x) => `${x.sheet} ${x.rows.length}/${x.of} rows`).join("; ");
  if (s.lines) return `lines ${s.lines.length} of ${s.of ?? "?"}`;
  return "-";
}

/** Totals over records, by purpose and by served model. */
export function summarize(records) {
  const add = (acc, k, r) => {
    const t = (acc[k] = acc[k] || { calls: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true, failed: 0 });
    t.calls++;
    t.inputTokens += r.inputTokens;
    t.cacheWriteTokens += r.cacheWriteTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.outputTokens += r.outputTokens;
    if (r.costUsd == null) t.costKnown = false;
    else t.costUsd = Math.round((t.costUsd + r.costUsd) * 10000) / 10000;
    if (!r.ok) t.failed++;
  };
  const byPurpose = {};
  const byModel = {};
  for (const r of records) {
    add(byPurpose, r.purpose, r);
    add(byModel, r.servedModel || r.model || "?", r);
  }
  return { byPurpose, byModel };
}

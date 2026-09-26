// Background ChatGPT work through the OpenAI Batch API, at half the price.
//
// The same split as the Claude side (server/claude-batch.js): inside a batch
// scope (withBatch - the steward's repairs, the boot audit sweep), a Chat
// Completions call is queued instead of sent. Calls gathered over the
// window go to OpenAI as one batch: the requests are written as JSONL -
// each line the exact Chat Completions body, response_format json_schema
// and all - uploaded through /v1/files (purpose "batch"), and started
// through /v1/batches. Each caller awaits its own answer, in the same shape
// a direct call gives ({ ok, status, json }), so the reading goes on through
// the existing pipeline (plan-canonical.js, plan-validate.js) unchanged.
// Outside a batch scope - an upload someone is watching - the call is made
// directly, as before.
//
// Tracking: the open batches are kept in kennion.settings
// ("openaiBatches.open") and followed again after a restart; each proposal
// with a request in a batch carries that batch's id in
// kennion.proposals.openai_batch_id until the batch ends. A result no one
// is left waiting for (the server restarted) is kept - used once - for the
// same request asked again, so nothing is paid for twice.
//
// A batch that cannot be made, or ends without an answer for a request
// (failed, expired, cancelled), never loses the request: it is made
// directly instead, and its own answer - an error included - goes back to
// the caller.
import crypto from "node:crypto";
import { batching } from "./claude-batch.js";
import { usageContext } from "./ai-usage.js";

const API = "https://api.openai.com/v1";
const WINDOW_MS = () => Number(process.env.KENNION_OPENAI_BATCH_WINDOW_MS || process.env.KENNION_BATCH_WINDOW_MS || 15_000);
const POLL_MS = () => Number(process.env.KENNION_OPENAI_BATCH_POLL_MS || 60_000);
const MAX_REQUESTS = 50_000;
const MAX_BYTES = 180 * 1024 * 1024; // under the 200 MB batch input file limit
const RUNNING = new Set(["validating", "in_progress", "finalizing", "cancelling"]);

/** Whether a ChatGPT call made here would go into a batch. */
export const openaiBatching = () => batching() && process.env.KENNION_OPENAI_BATCH !== "0" && !!transport;

let transport = null; // { upload(jsonl) -> file id, create(fileId, metadata) -> batch, retrieve(id) -> batch, content(fileId) -> text }
let store = memoryStore();
const queue = []; // { id, body, bytes, proposalId }
const waiters = new Map(); // custom_id -> { direct, list: [{ resolve, reject }] }
const pending = new Map(); // batch id -> { at, ids, proposals }
let flushTimer = null;
let pollTimer = null;

/** The /v1/files and /v1/batches endpoints over fetch. `key` returns the API key. */
export function fetchTransport(key) {
  const auth = () => ({ Authorization: `Bearer ${key()}` });
  const answer = async (r) => {
    const text = await r.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: file content */
    }
    if (!r.ok) {
      const e = new Error(`OpenAI batch: ${(json.error && (json.error.message || json.error.code)) || `HTTP ${r.status}`}`);
      e.status = r.status;
      throw e;
    }
    return { json, text };
  };
  return {
    async upload(jsonl) {
      const form = new FormData();
      form.append("purpose", "batch");
      form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "bensync-requests.jsonl");
      return (await answer(await fetch(`${API}/files`, { method: "POST", headers: auth(), body: form }))).json.id;
    },
    async create(inputFileId, metadata) {
      const body = JSON.stringify({ input_file_id: inputFileId, endpoint: "/v1/chat/completions", completion_window: "24h", metadata });
      return (await answer(await fetch(`${API}/batches`, { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body }))).json;
    },
    async retrieve(id) {
      return (await answer(await fetch(`${API}/batches/${id}`, { headers: auth() }))).json;
    },
    async content(fileId) {
      return (await answer(await fetch(`${API}/files/${fileId}/content`, { headers: auth() }))).text;
    },
  };
}

/** Open batches, kept results and proposal marks, in memory (tests, no database). */
export function memoryStore() {
  const results = new Map();
  const marks = new Map();
  let open = [];
  return {
    async getOpen() {
      return open;
    },
    async setOpen(list) {
      open = list;
    },
    async takeResult(id) {
      const r = results.get(id) || null;
      results.delete(id);
      return r;
    },
    async keepResult(id, batchId, result) {
      results.set(id, result);
    },
    async markProposals(ids, batchId) {
      for (const id of ids) marks.set(String(id), batchId);
    },
    async clearProposals(batchId) {
      for (const [id, b] of marks) if (b === batchId) marks.delete(id);
    },
    marks,
  };
}

/** The same on the app's database: settings, the kept-results table, kennion.proposals.openai_batch_id. */
export function dbStore(db) {
  return {
    async getOpen() {
      return (await db.getSetting("openaiBatches.open").catch(() => null)) || [];
    },
    async setOpen(list) {
      await db.setSetting("openaiBatches.open", list, "batch");
    },
    async takeResult(id) {
      return db.takeBatchResult(`openai:${id}`);
    },
    async keepResult(id, batchId, result) {
      await db.keepBatchResult(`openai:${id}`, batchId, result);
    },
    async markProposals(ids, batchId) {
      await db.markOpenAIBatch(ids, batchId);
    },
    async clearProposals(batchId) {
      await db.clearOpenAIBatch(batchId);
    },
  };
}

/**
 * Set up: `transport` (fetchTransport) and `persist` (dbStore). Batches left
 * open by a previous run are followed again.
 */
export async function configureOpenAIBatches({ transport: t, persist } = {}) {
  if (t) transport = t;
  if (persist) store = persist;
  for (const b of await store.getOpen().catch(() => [])) {
    if (b && b.id && !pending.has(b.id)) pending.set(b.id, { at: b.at, ids: b.ids || [], proposals: b.proposals || [] });
  }
  if (pending.size) {
    console.log(`openai batch: ${pending.size} batch(es) from before the restart are still followed`);
    schedulePoll();
  }
}

/** A request's id: the same request asked again gets the same id. */
export const requestId = (body) => crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 48);

/**
 * A Chat Completions call. In a batch scope it is queued for the next
 * batch; otherwise `direct()` - the caller's own synchronous POST - is made
 * now. Resolves { ok, status, json } either way (batched: true when it went
 * through a batch).
 */
export async function openaiPost(body, direct) {
  if (!openaiBatching()) return direct();
  const id = requestId(body);
  const kept = await store.takeResult(id).catch(() => null);
  if (kept) return kept;
  const proposalId = usageContext().proposalId ?? null;
  return new Promise((resolve, reject) => {
    const w = waiters.get(id);
    if (w) {
      w.list.push({ resolve, reject }); // the same request already queued or in flight
      return;
    }
    waiters.set(id, { direct, list: [{ resolve, reject }] });
    const line = JSON.stringify({ custom_id: id, method: "POST", url: "/v1/chat/completions", body });
    queue.push({ id, line, bytes: Buffer.byteLength(line) + 1, proposalId });
    const queuedBytes = queue.reduce((n, q) => n + q.bytes, 0);
    if (queue.length >= MAX_REQUESTS || queuedBytes >= MAX_BYTES) void flush();
    else if (!flushTimer) flushTimer = setTimeout(() => void flush(), WINDOW_MS());
  });
}

function deliver(id, result) {
  const w = waiters.get(id);
  if (!w) return false;
  waiters.delete(id);
  for (const x of w.list) x.resolve(result);
  return true;
}

/** Make a waiting request directly (its batch could not answer it); its own answer or error goes back. */
function runDirect(id, why) {
  const w = waiters.get(id);
  if (!w) return;
  waiters.delete(id);
  if (why) console.log(`openai batch: request ${id.slice(0, 12)} made directly (${why})`);
  Promise.resolve()
    .then(() => w.direct())
    .then(
      (r) => w.list.forEach((x) => x.resolve(r)),
      (e) => w.list.forEach((x) => x.reject(e)),
    );
}

async function saveOpen() {
  await store.setOpen([...pending.entries()].map(([id, b]) => ({ id, at: b.at, ids: b.ids, proposals: b.proposals }))).catch((e) => console.error("openai batch: could not save open batches:", e.message));
}

/** Send what is queued as one batch (or more, by size): upload the JSONL, start the batch. */
export async function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  while (queue.length) {
    const take = [];
    let bytes = 0;
    while (queue.length && take.length < MAX_REQUESTS && (take.length === 0 || bytes + queue[0].bytes < MAX_BYTES)) {
      const q = queue.shift();
      bytes += q.bytes;
      take.push(q);
    }
    try {
      const fileId = await transport.upload(take.map((q) => q.line).join("\n"));
      const batch = await transport.create(fileId, { source: "bensync" });
      const proposals = [...new Set(take.map((q) => q.proposalId).filter((p) => p != null))];
      pending.set(batch.id, { at: new Date().toISOString(), ids: take.map((q) => q.id), proposals });
      await saveOpen();
      await store.markProposals(proposals, batch.id).catch((e) => console.error("openai batch: could not mark proposals:", e.message));
      console.log(`openai batch: sent ${batch.id} with ${take.length} request(s), ${(bytes / 1e6).toFixed(1)} MB, for ${proposals.length} proposal(s)`);
      schedulePoll();
    } catch (e) {
      // The batch could not be made (a spending limit, a bad file): every
      // request in it is made directly - its own answer, an error included,
      // reaches its caller as a direct call's would.
      console.error(`openai batch: could not send ${take.length} request(s): ${e.message}`);
      for (const q of take) runDirect(q.id);
    }
  }
}

function schedulePoll() {
  if (pollTimer || !pending.size) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void poll().finally(schedulePoll);
  }, POLL_MS());
}

/** One JSONL result line as a direct call's answer. */
function resultOf(line) {
  if (line.response) {
    const code = Number(line.response.status_code) || 0;
    return { ok: code >= 200 && code < 300, status: code, json: line.response.body || {}, batched: true };
  }
  return { ok: false, status: 0, json: { error: line.error || { message: "The batch request failed." } }, batched: true };
}

const linesOf = (text) =>
  String(text || "")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** Check each batch in flight; hand out the answers of those that ended. */
export async function poll() {
  if (!transport) return;
  for (const [id, b] of [...pending.entries()]) {
    try {
      const batch = await transport.retrieve(id);
      if (RUNNING.has(batch.status)) continue;
      let delivered = 0;
      let kept = 0;
      for (const fileId of [batch.output_file_id, batch.error_file_id].filter(Boolean)) {
        for (const line of linesOf(await transport.content(fileId))) {
          const result = resultOf(line);
          // A request the batch could not answer is made directly below: the
          // direct answer is the authoritative one (a batch-only refusal
          // never costs the proposal an attempt; a real error comes back the same).
          if (!result.ok) continue;
          if (deliver(line.custom_id, result)) delivered++;
          else {
            // No one is waiting (the server restarted): keep it for the
            // request that will ask again, so it is not paid for twice.
            await store.keepResult(line.custom_id, id, result).catch(() => undefined);
            kept++;
          }
        }
      }
      // Anything still waiting on this batch got no answer from it (the
      // batch failed, expired or was cancelled): made directly instead.
      const why = batch.status === "completed" ? "no answer in the batch" : `batch ${batch.status}${batch.errors && batch.errors.data && batch.errors.data[0] ? `: ${batch.errors.data[0].message}` : ""}`;
      for (const cid of b.ids) runDirect(cid, why);
      pending.delete(id);
      await saveOpen();
      await store.clearProposals(id).catch(() => undefined);
      const c = batch.request_counts || {};
      console.log(`openai batch: ${id} ${batch.status} - ${c.completed ?? "?"} completed, ${c.failed ?? 0} failed of ${c.total ?? b.ids.length}; ${delivered} delivered${kept ? `, ${kept} kept for after a restart` : ""}`);
    } catch (e) {
      console.error(`openai batch: could not check ${id}: ${e.message}`);
    }
  }
}

/** For the page and tests: what is queued and in flight. */
export const openaiBatchState = () => ({ queued: queue.length, waiting: waiters.size, inFlight: [...pending.entries()].map(([id, b]) => ({ id, at: b.at, requests: b.ids.length, proposals: b.proposals })) });

/** Tests: forget everything. */
export function _resetOpenAIBatches() {
  if (flushTimer) clearTimeout(flushTimer);
  if (pollTimer) clearTimeout(pollTimer);
  flushTimer = null;
  pollTimer = null;
  queue.length = 0;
  waiters.clear();
  pending.clear();
  store = memoryStore();
  transport = null;
}

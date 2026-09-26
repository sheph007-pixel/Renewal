// Background Claude work through the Message Batches API, at half the price.
//
// Everything the steward does - re-reads, dual-audit steps, corrections - is
// work no one is waiting on. Inside a batch scope (withBatch), a Claude call
// is queued instead of sent: calls gathered over BATCH_WINDOW_MS go to
// Anthropic as one Message Batch, and each caller's promise resolves with
// its own Message when the batch ends (usually minutes; at most 24 hours).
// The caller's code is unchanged: `await claudeMessage(client, params)`
// returns a Message whichever way it went. Outside a batch scope - an
// upload someone is watching - the call streams as before.
//
// Nothing is paid for twice: a batch still running when the server restarts
// (a deploy) is picked up again from kennion.settings, and the results no
// one is left waiting for are kept (claude_batch_results); the same request
// asked again - the steward re-runs the step after the restart - takes its
// kept result instead of a new call. A kept result is used once.
//
// A batch request that errors (the account's spending limit included)
// rejects with the API's own message, so callers record it as before.
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();
/** Run `fn` with its Claude calls batched (when batching is on). */
export const withBatch = (fn) => scope.run({ batch: true }, fn);
/** Whether a Claude call made here would go into a batch. */
export const batching = () => !!(scope.getStore() && scope.getStore().batch) && process.env.KENNION_CLAUDE_BATCH !== "0";

const WINDOW_MS = () => Number(process.env.KENNION_BATCH_WINDOW_MS || 15_000);
const POLL_MS = () => Number(process.env.KENNION_BATCH_POLL_MS || 30_000);
const MAX_REQUESTS = 500;
const MAX_BYTES = 150 * 1024 * 1024; // under the 256 MB batch limit, with room

let clientFor = null; // () => an Anthropic client, set by configureBatches
let store = memoryStore();
const queue = []; // { id, params, bytes }
const waiters = new Map(); // custom_id -> [{ resolve, reject }]
const pending = new Map(); // batch id -> { at, ids }
let flushTimer = null;
let pollTimer = null;

/** Where the batch ids in flight and the orphaned results are kept. */
export function memoryStore() {
  const results = new Map();
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
  };
}

/** A store on the app's database (db.getSetting / setSetting and the results table). */
export function dbStore(db) {
  return {
    async getOpen() {
      return (await db.getSetting("claudeBatches.open").catch(() => null)) || [];
    },
    async setOpen(list) {
      await db.setSetting("claudeBatches.open", list, "batch");
    },
    async takeResult(id) {
      return db.takeBatchResult(id);
    },
    async keepResult(id, batchId, result) {
      await db.keepBatchResult(id, batchId, result);
    },
  };
}

/**
 * Set up: `client` makes the Anthropic client; `persist` keeps open batches
 * and orphaned results. Batches left open by a previous run are polled
 * again, and their results kept for the requests that will ask again.
 */
export async function configureBatches({ client, persist } = {}) {
  if (client) clientFor = client;
  if (persist) store = persist;
  for (const b of await store.getOpen().catch(() => [])) {
    if (b && b.id && !pending.has(b.id)) pending.set(b.id, { at: b.at, ids: b.ids || [] });
  }
  if (pending.size) {
    console.log(`claude batch: ${pending.size} batch(es) from before the restart are still followed`);
    schedulePoll();
  }
}

/** A request's id: the same request asked again gets the same id. */
export const requestId = (params) => crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 48);

/**
 * A Claude Message. In a batch scope it is queued for the next batch;
 * otherwise it is streamed now (`stream` - by default the stable endpoint's
 * stream().finalMessage() - is how).
 */
export async function claudeMessage(client, params, { stream } = {}) {
  if (!batching()) return stream ? stream() : client.messages.stream(params).finalMessage();
  if (!clientFor) clientFor = () => client;
  const id = requestId(params);
  const kept = await store.takeResult(id).catch(() => null);
  if (kept) return settle(kept);
  return new Promise((resolve, reject) => {
    const list = waiters.get(id);
    if (list) {
      list.push({ resolve, reject }); // the same request already queued or in flight
      return;
    }
    waiters.set(id, [{ resolve, reject }]);
    const bytes = Buffer.byteLength(JSON.stringify(params));
    queue.push({ id, params, bytes });
    const queuedBytes = queue.reduce((n, q) => n + q.bytes, 0);
    if (queue.length >= MAX_REQUESTS || queuedBytes >= MAX_BYTES) void flush();
    else if (!flushTimer) flushTimer = setTimeout(() => void flush(), WINDOW_MS());
  });
}

/** A batch result as the caller expects it: the Message, or the error thrown. */
function settle(result) {
  if (result.type === "succeeded") return result.message;
  if (result.type === "errored") {
    const e = result.error && (result.error.error || result.error);
    const err = new Error(`${(e && e.message) || "batch request errored"}${e && e.type ? ` (${e.type})` : ""}`);
    err.batchError = e || null;
    throw err;
  }
  throw new Error(result.type === "expired" ? "The batch request expired before it ran (24 hours) - it is asked again." : `batch request ${result.type}`);
}

function deliver(id, result) {
  const list = waiters.get(id);
  if (!list) return false;
  waiters.delete(id);
  for (const w of list) {
    try {
      w.resolve(settle(result));
    } catch (e) {
      w.reject(e);
    }
  }
  return true;
}

async function saveOpen() {
  await store.setOpen([...pending.entries()].map(([id, b]) => ({ id, at: b.at, ids: b.ids }))).catch((e) => console.error("claude batch: could not save open batches:", e.message));
}

/** Send what is queued as one batch (or more, by size). */
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
      const client = clientFor();
      const batch = await client.messages.batches.create({ requests: take.map((q) => ({ custom_id: q.id, params: q.params })) });
      pending.set(batch.id, { at: new Date().toISOString(), ids: take.map((q) => q.id) });
      await saveOpen();
      console.log(`claude batch: sent ${batch.id} with ${take.length} request(s), ${(bytes / 1e6).toFixed(1)} MB`);
      schedulePoll();
    } catch (e) {
      // The batch could not be made (the spending limit, a bad request):
      // every caller in it gets the error, as a direct call would have.
      console.error(`claude batch: could not send ${take.length} request(s): ${e.message}`);
      for (const q of take) {
        const list = waiters.get(q.id) || [];
        waiters.delete(q.id);
        for (const w of list) w.reject(e);
      }
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

/** Check each batch in flight; hand out the results of those that ended. */
export async function poll() {
  if (!clientFor) return;
  const client = clientFor();
  for (const [id, b] of [...pending.entries()]) {
    try {
      const batch = await client.messages.batches.retrieve(id);
      if (batch.processing_status !== "ended") continue;
      let delivered = 0;
      let kept = 0;
      for await (const r of await client.messages.batches.results(id)) {
        if (deliver(r.custom_id, r.result)) delivered++;
        else if (r.result && r.result.type === "succeeded") {
          // No one is waiting (the server restarted): keep it for the
          // request that will ask again, so it is not paid for twice.
          await store.keepResult(r.custom_id, id, r.result).catch(() => undefined);
          kept++;
        }
      }
      // Anything still waiting on this batch that got no result line.
      for (const cid of b.ids) deliver(cid, { type: "errored", error: { type: "api_error", message: "The batch ended without a result for this request." } });
      pending.delete(id);
      await saveOpen();
      const c = batch.request_counts || {};
      console.log(`claude batch: ${id} ended - ${c.succeeded ?? "?"} succeeded, ${c.errored ?? 0} errored, ${c.expired ?? 0} expired; ${delivered} delivered${kept ? `, ${kept} kept for after a restart` : ""}`);
    } catch (e) {
      console.error(`claude batch: could not check ${id}: ${e.message}`);
    }
  }
}

/** For the page and tests: what is queued and in flight. */
export const batchState = () => ({ queued: queue.length, waiting: waiters.size, inFlight: [...pending.entries()].map(([id, b]) => ({ id, at: b.at, requests: b.ids.length })) });

/** Tests: forget everything. */
export function _resetBatches() {
  if (flushTimer) clearTimeout(flushTimer);
  if (pollTimer) clearTimeout(pollTimer);
  flushTimer = null;
  pollTimer = null;
  queue.length = 0;
  waiters.clear();
  pending.clear();
  store = memoryStore();
  clientFor = null;
}

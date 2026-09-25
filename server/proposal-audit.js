// Proposal audit: two models from two different companies, Claude and
// ChatGPT, each independently read the carrier's own document and report,
// for EVERY stored plan, what the document prints: its exact name and plan
// code, network, deductible, out-of-pocket max, coinsurance, every
// client-facing benefit, HSA eligibility and all four tier rates. The
// auditors are told which plans to find (index, name, code, network, pages)
// but never the stored values, so they cannot copy them: SERVER CODE then
// compares each value read against the database (server/plan-compare.js) -
// a wrong copay is a finding whether or not the auditor thought to mention
// it. Each auditor also counts the plans on the document and lists any it
// prices that the portal lacks.
//
// The audit passes only when BOTH models ran, both returned every plan
// (every batch - see AUDIT_BATCH), every compared field agrees, both counts
// equal the database, and neither reported a problem. A model that is off,
// failed, or left a plan or a batch out leaves the audit pending - never a
// pass on one model's word. Each audit records the exact reading it checked
// (`version`), the document version (`sourceSha`) and the audit standard
// (`standard`), so a later change to any of them makes it stale on its own.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import https from "node:https";
import { prepareForModel } from "./intake.js";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { TIERS, canonicalPlans, matchCanonical, isEpoPlan, placementCore, exactName } from "./plan-canonical.js";
import { AUDIT_STANDARD, BENEFIT_FIELDS, comparePlan } from "./plan-compare.js";

/** The API's page ceiling for the 1M-context model this audits with. */
const MAX_PDF_PAGES = 600;

/**
 * Plans per audit request. A proposal with more stored plans is audited in
 * deterministic batches - plans 0-24, 25-49, ... by stored index - each
 * against the whole document, so no answer has to hold 17 fields for 145
 * plans at once. Every plan is in exactly one batch for each model; a
 * missing or failed batch leaves that model incomplete (pending).
 */
export const AUDIT_BATCH = 25;

const apiKey = () => process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE || "";
const fakeAi = () => process.env.KENNION_FAKE_AI === "1";
const chatgptKey = () => process.env.CHATGPT_API_KEY || process.env.ChatGPT || process.env.CHATGPT || process.env.OPENAI_API_KEY || "";
const CHATGPT_MODEL = () => process.env.CHATGPT_MODEL || "gpt-5";
/**
 * The audit agent's Claude half, and the correction agent: Claude Sonnet 5,
 * the same model family the extraction agent reads with - checking every
 * stored value against the page. ChatGPT is the other half of the audit on
 * purpose: a different model family catches what Claude might misread twice.
 */
const CLAUDE_MODEL = "claude-sonnet-5";

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

/**
 * How each value is to be read - the same guide for the auditors and the
 * corrector, so both read a field the same way and code can compare them.
 */
export const FIELD_GUIDE = `How to read each value (in-network, for this plan only, from this plan's own benefit or rate table - never from a neighbouring plan):
- name: the plan's name exactly as printed - nothing added, nothing dropped.
- plan_code: the carrier's plan or benefit code exactly as printed; null when the plan has none.
- network: the network the plan is priced on, as printed; null when the document names none for this plan.
- deductible, oop_max: the in-network amounts as printed, individual first and then family where both are printed (e.g. "$3,000 / $6,000").
- coinsurance: the member's in-network coinsurance as printed (e.g. "20%", "0%").
- doctor_visit (primary care office visit), specialist, imaging (labs, X-ray, MRI/CT), urgent_care, emergency_room, hospital (inpatient stay): the member's in-network cost as printed, short and verbatim (e.g. "$30 copay", "20% after deductible", "No charge").
- rx: the retail prescription cost by tier, in tier order, as printed (e.g. "$10 / $40 / $80"); leave mail order out.
- hsa_eligible: "yes" when the document says the plan is HSA-eligible / HSA-qualified, "no" when it says it is not.
- EE, ES, EC, FAM: the monthly rate per tier (employee only, employee + spouse, employee + children, family) as a plain number, e.g. 612.45.
Use null for any value the document does not state for this plan (for a rate: a tier the document does not price).`;

const CONFIRMATION = {
  type: "object",
  additionalProperties: false,
  required: ["index", "on_document", "name", "plan_code", "network", "deductible", "oop_max", ...BENEFIT_FIELDS, "benefits_belong", ...TIERS],
  properties: {
    index: { type: "integer" },
    on_document: { type: "boolean", description: "False when this plan is not on the document at all." },
    name: nullableString,
    plan_code: nullableString,
    network: nullableString,
    deductible: nullableString,
    oop_max: nullableString,
    ...Object.fromEntries(BENEFIT_FIELDS.map((k) => [k, nullableString])),
    benefits_belong: { type: "boolean", description: "True when the benefit values you read are unmistakably this plan's own (its own column or page), not a neighbouring plan's." },
    ...Object.fromEntries(TIERS.map((t) => [t, nullableNumber])),
  },
};

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "plan_appearances", "plans_found_total", "epo_excluded", "document_plan_count", "duplicates_found", "plan_confirmations", "mismatches", "notes"],
  properties: {
    plan_appearances: { type: "integer", description: "How many times medical plans appear on the document in total - one plan on four pages is four appearances." },
    plans_found_total: { type: "integer", description: "Every DISTINCT plan option the document prices, EPO plans included, across every page and grid. A plan printed on several pages counts once." },
    duplicates_found: { type: "boolean", description: "True if the list you were given holds the same carrier plan more than once." },
    epo_excluded: { type: "integer", description: "How many of those distinct plans are EPO plans. (The portal stores them like every other plan; it only hides them from clients.)" },
    document_plan_count: { type: "integer", description: "The plans the portal should hold: every distinct plan on the document, EPO included - equal to plans_found_total." },
    plan_confirmations: {
      type: "array",
      description: "One entry for EVERY plan in the list you were given, by its index: each value read off the document yourself, per the field guide.",
      items: CONFIRMATION,
    },
    verdict: { type: "string", enum: ["pass", "issues", "unreadable"], description: "pass when every listed plan was found and read; issues when a plan is missing from the document, a plan on the document is missing from the list, or the list holds a plan twice; unreadable when the document cannot be read." },
    mismatches: {
      type: "array",
      description: "Problems with the list itself: a plan the document prices that the list lacks (field extra_plan, its printed name in on_document), a plan listed twice (field duplicate_plan), or anything else worth a finding.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["plan", "field", "stored", "on_document"],
        properties: {
          plan: { type: "string", description: "The plan's name." },
          field: { type: "string" },
          stored: { type: "string" },
          on_document: { type: "string" },
        },
      },
    },
    notes: { type: "string", description: "One or two sentences: what was checked and anything worth a human look. Empty when clean." },
  },
};

const INSTRUCTIONS = `You are auditing a benefits portal's reading of a carrier's proposal against the proposal document itself - the document is the source of truth. You are given a numbered list of the plans the portal stored (each with its index, the portal's ID, the name and plan code it stored, its network, and the pages the portal says it is on) - but NOT the values the portal stored for them. Your job is to read those values off the document yourself. You audit on your own: no other auditor's result is given to you.

1. Count the plans on the document: every appearance (plan_appearances), every distinct plan option it prices across every page and grid (plans_found_total), how many of those are EPO plans (epo_excluded), and the plans the portal should hold (document_plan_count - every distinct plan, EPO included). A plan printed on several pages (a summary, a benefit page, a rate page) is ONE plan.

2. For EVERY plan in the list, by index, find it on the document by its plan code (or, where it has none, its printed name) and return what the document prints for it (plan_confirmations), following the field guide below. Read every value from that plan's own table - never copy the name you were given if the document prints it differently, and never take a value from a neighbouring plan. If a listed plan is not on the document, set on_document false.

3. In mismatches, list every plan the document prices that the list lacks (field extra_plan), and set duplicates_found (and list it, field duplicate_plan) if the list holds one carrier plan twice.

${FIELD_GUIDE}

Never guess: a value you cannot read is null. If pages are unreadable, say so in the notes; use verdict unreadable only when nothing can be checked.`;

const storedFor = (extracted) => {
  const plans = Array.isArray(extracted && extracted.plans) ? extracted.plans : [];
  return plans.map((pl) => ({
    id: pl.option_id || null,
    name: pl.name,
    plan_code: pl.plan_code || null,
    network: pl.network || null,
    plan_type: pl.plan_type || null,
    deductible: pl.deductible || null,
    oop_max: pl.oop_max || null,
    rates: pl.rates || null,
    benefits: pl.benefits || null,
    source_pages: pl.source ? { identity: pl.source.identity || [], benefits: pl.source.benefits || [], rates: pl.source.rates || [], sheet: pl.source.sheet || "", rows: pl.source.rows || "" } : null,
  }));
};
/** The same, without what the portal adds of its own (IDs, provenance) - the values a reading is made of, for its version hash. */
const valuesFor = (extracted) => storedFor(extracted).map(({ id, source_pages, ...v }) => v);

/**
 * What an auditor is told about a stored plan: enough to find it on the
 * document (index, ID, name, code, network, pages) - and none of the values
 * it is there to read, so it cannot copy them.
 */
const findersFor = (stored, indices) => indices.map((index) => {
  const pl = stored[index];
  return { index, id: pl.id, name: pl.name, plan_code: pl.plan_code, network: pl.network, plan_type: pl.plan_type, source_pages: pl.source_pages };
});

/**
 * The exact reading an audit checked: a hash of every stored plan's values.
 * An audit is only good for the reading it names - a correction or a re-read
 * changes the hash, and the old audit no longer counts.
 */
export function readingVersion(extracted) {
  return crypto.createHash("sha256").update(JSON.stringify({ plans: valuesFor(extracted), coverage: coverageSignature(extracted) })).digest("hex").slice(0, 16);
}

/**
 * The part of the source-coverage record an audit stands on: which file
 * version was covered and how completely. In the version hash, so an audit
 * is only good for a reading of this exact coverage; a re-read that covers
 * the source differently makes the old audit stale.
 */
const coverageSignature = (extracted) => {
  const c = extracted && extracted.coverage;
  if (!c) return null;
  return { kind: c.kind, sourceSha: c.sourceSha || null, pages: [c.total_pages ?? null, c.covered_pages ?? null], sheets: [c.total_sheets ?? null, c.inspected_sheets ?? null], lines: [c.total_lines ?? null, c.scanned_lines ?? null] };
};

/**
 * One model's answer for one batch, checked in code: every plan in the batch
 * must be confirmed, and every value it read is compared to the database
 * here (comparePlan) - a difference is a finding whether or not the model
 * reported it. `indices`: the stored plans this answer was asked for.
 */
export function shape(who, r, stored, indices = stored.map((_, i) => i)) {
  const modelVerdict = ["pass", "issues", "unreadable"].includes(r && r.verdict) ? r.verdict : "unreadable";
  const mismatches = Array.isArray(r && r.mismatches)
    ? r.mismatches.slice(0, 80).map((m) => ({ plan: String(m.plan || ""), field: String(m.field || ""), stored: String(m.stored ?? ""), onDocument: String(m.on_document ?? "") }))
    : [];
  const seen = new Set(mismatches.map((m) => `${m.plan}|${m.field}`.toLowerCase()));
  const conf = new Map((Array.isArray(r && r.plan_confirmations) ? r.plan_confirmations : []).filter((c) => c && Number.isInteger(c.index)).map((c) => [c.index, c]));
  let confirmed = 0;
  for (const i of indices) {
    const pl = stored[i];
    const c = conf.get(i);
    if (!pl || !c) continue;
    confirmed++;
    const at = { index: i, optionId: pl.id || null, planCode: pl.plan_code || null };
    if (c.on_document === false) {
      if (!seen.has(`${pl.name}|missing_plan`.toLowerCase())) mismatches.push({ plan: pl.name, ...at, field: "missing_plan", stored: "stored", onDocument: "not on document" });
      continue;
    }
    if (c.benefits_belong === false) mismatches.push({ plan: pl.name, ...at, field: "benefits", stored: "stored benefits", onDocument: "belong to another plan or differ from this plan's own" });
    for (const d of comparePlan(pl, c)) {
      const key = `${pl.name}|${d.field}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      mismatches.push({ plan: pl.name, ...at, ...d });
    }
  }
  if (r && r.duplicates_found === true && !mismatches.some((m) => m.field === "duplicate_plan")) mismatches.push({ plan: "(stored list)", field: "duplicate_plan", stored: "a plan stored twice", onDocument: "one plan" });
  const int = (v) => (Number.isInteger(v) ? v : null);
  const verdict = modelVerdict === "unreadable" ? "unreadable" : confirmed < indices.length ? "incomplete" : mismatches.length || modelVerdict === "issues" ? "issues" : "pass";
  return {
    model: who,
    verdict,
    planAppearances: int(r && r.plan_appearances),
    plansFoundTotal: int(r && r.plans_found_total),
    epoExcluded: int(r && r.epo_excluded),
    documentPlanCount: int(r && r.document_plan_count),
    confirmed,
    of: indices.length,
    mismatches,
    notes: String((r && r.notes) || "").slice(0, 1500) + (verdict === "incomplete" ? ` Returned ${confirmed} of ${indices.length} plans.` : ""),
  };
}

/**
 * One model's batches, combined. The model passes only when every batch
 * came back and passed: a batch that failed or is missing leaves the model
 * pending ("error" / "incomplete"), never a pass. The document counts are
 * the first batch's (each batch reads the whole document; the count is asked
 * once per answer but held to the database once).
 */
export function mergeBatches(who, parts, total) {
  const failed = parts.find((p) => p.verdict === "error" || p.verdict === "off");
  const confirmed = parts.reduce((n, p) => n + (p.confirmed || 0), 0);
  // A document-level finding (a plan the list lacks, a plan stored twice)
  // can come back from every batch - each reads the whole document - but it
  // is one finding.
  const seen = new Set();
  const mismatches = parts.flatMap((p) => p.mismatches || []).filter((m) => {
    const k = `${Number.isInteger(m.index) ? m.index : m.plan}|${m.field}|${m.onDocument}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const first = parts[0] || {};
  const verdict = failed
    ? failed.verdict
    : parts.some((p) => p.verdict === "unreadable")
      ? "unreadable"
      : confirmed < total || parts.some((p) => p.verdict === "incomplete")
        ? "incomplete"
        : mismatches.length || parts.some((p) => p.verdict === "issues")
          ? "issues"
          : "pass";
  return {
    model: who,
    verdict,
    planAppearances: first.planAppearances ?? null,
    plansFoundTotal: first.plansFoundTotal ?? null,
    epoExcluded: first.epoExcluded ?? null,
    documentPlanCount: first.documentPlanCount ?? null,
    confirmed,
    of: total,
    batches: parts.map((p) => ({ from: p.from, to: p.to, verdict: p.verdict, confirmed: p.confirmed ?? 0 })),
    mismatches,
    notes: parts.map((p) => p.notes).filter(Boolean).join(" ").slice(0, 3000),
  };
}

/** The stored plans' indices in audit batches: [0..24], [25..49], ... */
export const auditBatches = (n, size = AUDIT_BATCH) => Array.from({ length: Math.ceil(n / size) }, (_, b) => Array.from({ length: Math.min(size, n - b * size) }, (_, k) => b * size + k));

const auditPayload = (stored, indices, extracted, version, sourceSha, batch, batchCount) => {
  const x = extracted || {};
  return [
    `Proposal version: document ${sourceSha || "?"}, reading ${version}.`,
    `The portal's plan-count reconciliation: ${JSON.stringify(x.reconciliation || null)}`,
    "Every distinct plan on the document should be stored, EPO plans included (the portal decides separately which plans a client sees).",
    batchCount > 1
      ? `The portal stores ${stored.length} plans; they are audited in ${batchCount} batches. This is batch ${batch + 1} of ${batchCount}: plans ${indices[0]}-${indices[indices.length - 1]}. Return a plan_confirmation for every plan listed below (the others are audited separately), and still count the plans on the whole document.`
      : `The portal stores ${stored.length} plans.`,
    `The plans to find and read:\n${JSON.stringify(findersFor(stored, indices), null, 1)}`,
    "Read every listed plan's values off the document.",
  ].join("\n\n");
};

async function claudeCheck({ filename, prepared, stored, indices, payload }) {
  // Audits run several at a time against the same org-wide tokens-per-minute
  // budget the proposal reader shares - stretch the SDK's built-in backoff so
  // a burst retries instead of failing the audit outright.
  const client = apiKey() ? new Anthropic({ apiKey: apiKey(), maxRetries: 3, timeout: 10 * 60 * 1000 }) : new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  const content = [];
  // The document is the same for every batch: cached, so batches 2..n read
  // it from the prompt cache instead of paying for it again.
  if (prepared.kind === "pdf") {
    const { numpages } = await pdfParse(prepared.buffer).catch(() => ({ numpages: 0 }));
    if (numpages > MAX_PDF_PAGES) {
      throw new Error(`This proposal is ${numpages} pages - too long for the model to audit (limit ${MAX_PDF_PAGES}).`);
    }
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: prepared.buffer.toString("base64") }, title: filename, cache_control: { type: "ephemeral" } });
  }
  else if (prepared.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: prepared.mime, data: prepared.buffer.toString("base64") }, cache_control: { type: "ephemeral" } });
  else content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: prepared.text || "(empty)" }, title: filename, cache_control: { type: "ephemeral" } });
  content.push({ type: "text", text: payload });
  const response = await client.messages
    .stream({
      model: CLAUDE_MODEL,
      max_tokens: 64000,
      output_config: { effort: "high", format: { type: "json_schema", schema: RESULT_SCHEMA } },
      system: INSTRUCTIONS,
      messages: [{ role: "user", content }],
    })
    .finalMessage();
  if (response.stop_reason === "refusal") throw new Error("Claude declined the check.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's audit ran past one answer.");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return shape(`Claude (${CLAUDE_MODEL})`, JSON.parse(text), stored, indices);
}

/**
 * POST JSON with a long timeout. Node's fetch gives up on a response that
 * takes more than five minutes to start - which a large PDF audit on
 * ChatGPT can ("fetch failed" on Lewis Communications' 145-plan quote).
 */
function postJson(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let j = {};
        try {
          j = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: j, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 60000)} minutes`)));
    req.on("error", reject);
    req.end(data);
  });
}

async function chatgptCheck({ filename, prepared, stored, indices, payload }) {
  const parts = [];
  if (prepared.kind === "pdf") parts.push({ type: "file", file: { filename, file_data: `data:application/pdf;base64,${prepared.buffer.toString("base64")}` } });
  else if (prepared.kind === "image") parts.push({ type: "image_url", image_url: { url: `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}` } });
  else parts.push({ type: "text", text: `The document (${filename}):\n${prepared.text || "(empty)"}` });
  parts.push({ type: "text", text: payload });
  const body = {
    model: CHATGPT_MODEL(),
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: parts },
    ],
    response_format: { type: "json_schema", json_schema: { name: "proposal_audit", strict: true, schema: RESULT_SCHEMA } },
  };
  let last;
  // One more try on a network failure or a 429/5xx: a missing ChatGPT audit
  // holds the proposal back from green, so it is worth the second attempt.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await postJson("https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${chatgptKey()}` }, body, 20 * 60 * 1000);
      if (!r.ok) {
        last = new Error(`ChatGPT (${CHATGPT_MODEL()}): ${(r.json.error && r.json.error.message) || `HTTP ${r.status}`}`);
        if (r.status === 429 || r.status >= 500) continue;
        throw last;
      }
      const text = r.json.choices && r.json.choices[0] && r.json.choices[0].message ? String(r.json.choices[0].message.content || "") : "";
      if (!text) throw new Error("ChatGPT returned no text.");
      return shape(`ChatGPT (${CHATGPT_MODEL()})`, JSON.parse(text), stored, indices);
    } catch (e) {
      last = e;
      if (attempt === 2 || /HTTP 4\d\d|returned no text/.test(e.message)) break;
    }
  }
  throw last;
}

/** What the document would say if it said exactly what is stored: the canned auditor's answer (KENNION_FAKE_AI). */
const cannedRead = (pl, index) => ({
  index,
  on_document: true,
  name: pl.name,
  plan_code: pl.plan_code,
  network: pl.network,
  deductible: pl.deductible,
  oop_max: pl.oop_max,
  ...Object.fromEntries(BENEFIT_FIELDS.map((k) => [k, (pl.benefits && pl.benefits[k]) || null])),
  benefits_belong: true,
  ...Object.fromEntries(TIERS.map((t) => [t, pl.rates ? pl.rates[t] ?? null : null])),
});

/**
 * Run both audits and combine them. `status`:
 *   pass    - both models ran, both returned every plan in every batch,
 *             every compared field agrees with the database, both counts
 *             equal the database, and neither reported a problem;
 *   issues  - a finding (a value the document contradicts, a plan missing
 *             or extra, or a count that does not match the database);
 *   pending - no finding, but not both models' full word: one is off,
 *             failed, or left a plan or a batch out. Never counted as a pass.
 * `version` names the reading that was checked (see readingVersion);
 * `standard` the audit standard it was held to (plan-compare.js).
 * `read` (tests): a stand-in auditor, (who, payload, indices) => answer.
 */
export async function auditProposal({ filename, mime, buffer, extracted, sourceSha = null, read = null }) {
  const stored = storedFor(extracted);
  const completedAt = new Date().toISOString();
  const version = readingVersion(extracted);
  const storedCount = offeredCount(extracted);
  if (!stored.length) return { completedAt, status: "pending", models: [], mismatches: [], notes: "No plans stored to check.", version, standard: AUDIT_STANDARD, counts: { stored: 0 } };
  const batches = auditBatches(stored.length);
  const epo = canonicalPlans(extracted).filter(isEpoPlan).length;
  // One model, every batch in order (the cached document is reused batch to batch).
  const runModel = async (who, check) => {
    const parts = [];
    for (const [b, indices] of batches.entries()) {
      const payload = auditPayload(stored, indices, extracted, version, sourceSha, b, batches.length);
      const part = await check({ payload, indices }).catch((e) => ({ model: who, verdict: "error", confirmed: 0, mismatches: [], notes: `Batch ${b + 1} of ${batches.length}: ${e.message}` }));
      parts.push({ ...part, from: indices[0], to: indices[indices.length - 1] });
      // A failed batch fails the model: stop rather than spend the rest.
      if (part.verdict === "error") break;
    }
    return mergeBatches(who, parts, stored.length);
  };
  let models;
  if (read || fakeAi()) {
    const answer =
      read ||
      ((who, payload, indices) => ({ verdict: "pass", plan_appearances: storedCount, plans_found_total: storedCount, epo_excluded: epo, document_plan_count: storedCount, duplicates_found: false, plan_confirmations: indices.map((i) => cannedRead(stored[i], i)), mismatches: [], notes: "Canned audit (KENNION_FAKE_AI)." }));
    const canned = (who) => runModel(who, async ({ payload, indices }) => shape(who, await answer(who, payload, indices), stored, indices));
    models = await Promise.all([canned(read ? "Claude (test)" : "Claude (canned)"), canned(read ? "ChatGPT (test)" : "ChatGPT (canned)")]);
  } else {
    const prepared = await prepareForModel({ filename, mime, buffer });
    models = await Promise.all([
      apiKey() || process.env.ANTHROPIC_AUTH_TOKEN
        ? runModel(`Claude (${CLAUDE_MODEL})`, ({ payload, indices }) => claudeCheck({ filename, prepared, stored, indices, payload }))
        : Promise.resolve({ model: "Claude", verdict: "off", mismatches: [], notes: "No Anthropic key." }),
      chatgptKey()
        ? runModel(`ChatGPT (${CHATGPT_MODEL()})`, ({ payload, indices }) => chatgptCheck({ filename, prepared, stored, indices, payload }))
        : Promise.resolve({ model: "ChatGPT", verdict: "off", mismatches: [], notes: "No ChatGPT key." }),
    ]);
  }
  const mismatches = models.flatMap((m) => (m.mismatches || []).map((x) => ({ ...x, by: m.model })));
  // The plan count, held to the database by each model that gave one.
  for (const m of models) {
    if (m.documentPlanCount != null && m.documentPlanCount !== storedCount) {
      mismatches.push({ plan: "(whole document)", field: "plan_count", stored: String(storedCount), onDocument: `${m.documentPlanCount} (${m.plansFoundTotal ?? "?"} found, ${m.epoExcluded ?? "?"} of them EPO)`, by: m.model });
    }
  }
  const both = models.length === 2 && models.every((m) => m.verdict === "pass");
  const status = mismatches.length ? "issues" : both ? "pass" : "pending";
  const notes = models
    .filter((m) => m.notes)
    .map((m) => `${m.model}: ${m.notes}`)
    .join(" ");
  const counts = { stored: storedCount };
  for (const m of models) {
    const k = /^claude/i.test(m.model) ? "claude" : "chatgpt";
    counts[k] = { appearances: m.planAppearances ?? null, found: m.plansFoundTotal ?? null, epoExcluded: m.epoExcluded ?? null, expected: m.documentPlanCount ?? null };
  }
  return { completedAt, status, models, mismatches, notes, version, sourceSha, standard: AUDIT_STANDARD, batches: batches.length, counts, documentPlanCount: both && !mismatches.length ? storedCount : null };
}

/**
 * How many plans a reading stores: its canonical plans - every one, EPO
 * included - the figure the document's count is held to. Each canonical
 * entry is one carrier plan (canonicalizePlans + validatePlans); two are
 * never counted as one because their rates happen to agree.
 */
export function offeredCount(extracted) {
  return canonicalPlans(extracted).length;
}

// ---------------------------------------------------------------------------
// Correction: the step that turns a finding into a fix. Claude is handed the
// document, the stored plans and what the audit found, checks each finding
// against the page, and returns the corrected values, the plans the portal is
// missing and the ones it should not have. The server applies them and the
// two-model audit runs again - a correction is only ever trusted once both
// models agree with it.

const S = { type: "string" };
const NS = { anyOf: [{ type: "string" }, { type: "null" }] };
const NN = { anyOf: [{ type: "number" }, { type: "null" }] };
const PAGES = {
  type: "object",
  additionalProperties: false,
  required: ["identity", "benefits", "rates"],
  description: "Page positions within the file you were given (1 = its first page).",
  properties: { identity: { type: "array", items: { type: "integer" } }, benefits: { type: "array", items: { type: "integer" } }, rates: { type: "array", items: { type: "integer" } } },
};
const PLAN_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["name", "plan_code", "network", "plan_type", "deductible", "oop_max", "benefits", "rates", "monthly_total", "source_pages"],
  properties: {
    name: S,
    plan_code: NS,
    network: NS,
    plan_type: NS,
    deductible: NS,
    oop_max: NS,
    benefits: {
      type: "object",
      additionalProperties: false,
      required: BENEFIT_FIELDS_LIST(),
      properties: Object.fromEntries(BENEFIT_FIELDS_LIST().map((k) => [k, S])),
    },
    rates: { type: "object", additionalProperties: false, required: ["EE", "ES", "EC", "FAM"], properties: { EE: NN, ES: NN, EC: NN, FAM: NN } },
    monthly_total: NN,
    source_pages: PAGES,
  },
};
function BENEFIT_FIELDS_LIST() {
  return BENEFIT_FIELDS;
}

const CORRECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document_plan_count", "fixes", "add", "remove", "unpriced", "notes"],
  properties: {
    document_plan_count: { type: "integer", description: "Distinct plan options the document prices, EPO included, each plan counted once however many pages it is on." },
    fixes: {
      type: "array",
      description: "One entry per finding and per conflict you were given (and any other wrong value you notice), after checking it against the document.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "field", "verdict", "value", "source_page", "reason"],
        properties: {
          index: { type: "integer", description: "The stored plan's index in the list you were given." },
          field: { type: "string", enum: ["name", "plan_code", "network", "plan_type", "deductible", "oop_max", "EE", "ES", "EC", "FAM", ...BENEFIT_FIELDS_LIST()] },
          verdict: { type: "string", enum: ["fix", "stored_is_correct"], description: "fix when the document prints something else; stored_is_correct when the finding was wrong." },
          value: { type: "string", description: "The value exactly as the document prints it (a rate as a plain number, e.g. 612.45). Empty for stored_is_correct." },
          source_page: { type: "integer", description: "The page position (within the file you were given) you read the value from; 0 for a spreadsheet or text document." },
          reason: { type: "string", description: "One short sentence: what the document shows and why this is the plan's own value." },
        },
      },
    },
    add: { type: "array", description: "Every plan the document prices that the stored list is missing (EPO plans included), in full.", items: PLAN_ITEM },
    remove: { type: "array", description: "Indexes of stored plans that are not on the document at all, or are a repeat of another stored plan (the same carrier plan stored twice).", items: { type: "integer" } },
    unpriced: {
      type: "array",
      description: "Stored plans with an empty tier rate that the document genuinely does not price for that tier.",
      items: { type: "object", additionalProperties: false, required: ["index", "tier"], properties: { index: { type: "integer" }, tier: { type: "string", enum: TIERS } } },
    },
    notes: { type: "string" },
  },
};

const CORRECTION_INSTRUCTIONS = `You correct a benefits portal's stored reading of a carrier's proposal so that it matches the proposal document exactly - the document is the source of truth. You are given the document (or the pages of it that the findings concern), the stored plans as a numbered list with the pages each was read from, the findings two independent auditors reported, any conflicts between two appearances of the same plan, and the tier rates the portal is missing.

Each finding names the stored plan by its index (where it concerns one plan), the field, the stored value and what an auditor read on the document. Do not take a finding's proposed value on trust - the auditors can be wrong. For each finding and each conflict, find that exact plan on the document by its plan code and printed name, read the value from that plan's own benefit or rate table, and return a fix with the value exactly as printed (and the page you read it from), or stored_is_correct. Never take a value from a different plan, however similar it looks. Read each missing tier rate off the document: return it as a fix, or list it under unpriced when the document really does not price that tier for that plan. Add, in full, every plan the document prices that the stored list lacks - EPO plans included (the portal stores every plan and decides separately what a client sees) - with the pages it is on. Remove a stored plan only when it is not on the document at all or is the same carrier plan stored twice. A stored plan that IS on the document under a different printed name (a placement label added, a typo) is corrected with a fix on its name - never removed and added back. Count the distinct plan options the document prices, EPO included. Two stored plans with the same printed name but different plan codes are two plans when the document prints both codes - never merge them; if it does not, fix the one the document names differently. Never guess: a value you cannot read on the page is left alone.

${FIELD_GUIDE}`;

/** A PDF holding just these pages of `buffer`, in order. */
async function excerptPdf(buffer, pages) {
  const src = await PDFDocument.load(buffer);
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(src, pages.map((n) => n - 1));
  for (const pg of copied) doc.addPage(pg);
  return Buffer.from(await doc.save());
}

/**
 * Ask Claude to settle findings against the document. `pages`, when given,
 * are the original page numbers the findings concern (the affected plans'
 * source pages): only those pages are sent - a targeted correction, not the
 * whole 50-page PDF for one field. Without them (a missing plan, a count
 * problem, a duplicate - anything structural) the whole document is sent.
 * The answer's page positions are mapped back to original pages (`_pageMap`).
 */
export async function correctProposal({ filename, mime, buffer, extracted, mismatches, missingRates, conflicts = [], pages = null }) {
  if (fakeAi()) return { document_plan_count: offeredCount(extracted), fixes: [], add: [], remove: [], unpriced: [], notes: "Canned correction (KENNION_FAKE_AI).", _pageMap: null };
  const prepared = await prepareForModel({ filename, mime, buffer });
  const client = apiKey() ? new Anthropic({ apiKey: apiKey(), maxRetries: 3, timeout: 10 * 60 * 1000 }) : new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  const content = [];
  let pageMap = null;
  if (prepared.kind === "pdf") {
    let buf = prepared.buffer;
    if (Array.isArray(pages) && pages.length) {
      try {
        buf = await excerptPdf(prepared.buffer, pages);
        pageMap = pages;
      } catch {
        buf = prepared.buffer;
        pageMap = null;
      }
    }
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: filename });
  } else if (prepared.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: prepared.mime, data: prepared.buffer.toString("base64") } });
  else content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: prepared.text || "(empty)" }, title: filename });
  const numbered = storedFor(extracted).map((pl, index) => ({ index, ...pl }));
  content.push({
    type: "text",
    text: [
      pageMap ? `This file holds only pages ${pageMap.join(", ")} of the proposal - the pages the findings concern - in that order. Page positions in your answer are positions within this file.` : "This is the whole proposal.",
      `The stored plans:\n${JSON.stringify(numbered, null, 1)}`,
      `The auditors' findings:\n${JSON.stringify(mismatches || [], null, 1)}`,
      `Conflicts between two appearances of the same plan (settle each from the plan's own table):\n${JSON.stringify(conflicts || [], null, 1)}`,
      `Tier rates the portal is missing (index, tier):\n${JSON.stringify(missingRates || [])}`,
      "Correct the stored reading against the document.",
    ].join("\n\n"),
  });
  const response = await client.messages
    .stream({
      model: CLAUDE_MODEL,
      max_tokens: 128000,
      output_config: { effort: "high", format: { type: "json_schema", schema: CORRECTION_SCHEMA } },
      system: CORRECTION_INSTRUCTIONS,
      messages: [{ role: "user", content }],
    })
    .finalMessage();
  if (response.stop_reason === "refusal") throw new Error("Claude declined the correction.");
  if (response.stop_reason === "max_tokens") throw new Error("The correction was too long for one answer.");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const out = JSON.parse(text);
  if (!out || !Array.isArray(out.fixes)) throw new Error("Could not read the correction.");
  return { ...out, _pageMap: pageMap };
}

const moneyNumber = (v) => {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const mapPage = (p, pageMap) => (pageMap && Number.isInteger(p) && p >= 1 && p <= pageMap.length ? pageMap[p - 1] : Number.isInteger(p) && p > 0 ? p : null);

/**
 * Apply a correction to a reading. Pure: returns the new extracted and a log
 * of every change, each entry naming the proposal, the reading version it
 * was made against, the plan (BenSync ID, exact name, code), the field, the
 * previous and corrected values, the source page, the reason and the model.
 * A conflict between two appearances is cleared once the corrector has read
 * the value off the plan's own table (fixed or confirmed). Option IDs ride
 * with the plans they belong to; a removed plan's number is retired by the
 * numbering step as usual.
 */
export function applyCorrection(extracted, c, meta = {}) {
  const pageMap = c._pageMap || null;
  const plans = (Array.isArray(extracted && extracted.plans) ? extracted.plans : []).map((pl) => ({
    ...pl,
    rates: { ...(pl.rates || {}) },
    benefits: pl.benefits ? { ...pl.benefits } : pl.benefits,
    ...(Array.isArray(pl.conflicts) ? { conflicts: pl.conflicts.map((k) => ({ ...k })) } : {}),
  }));
  const at = new Date().toISOString();
  const log = [];
  const entry = (pl, field, from, to, page, reason) =>
    log.push({ at, proposalId: meta.proposalId ?? null, version: meta.version ?? null, optionId: pl.option_id || null, plan: pl.name, planCode: pl.plan_code || null, field, from: from ?? null, to, source: page ? `page ${page}` : pl.source && pl.source.sheet ? `${pl.source.sheet}${pl.source.rows ? ` ${pl.source.rows}` : ""}` : null, reason: reason || null, by: meta.by || null });
  const settle = (pl, field) => {
    if (!Array.isArray(pl.conflicts)) return;
    pl.conflicts = pl.conflicts.filter((k) => k.field !== field);
    if (!pl.conflicts.length) delete pl.conflicts;
  };
  for (const f of c.fixes || []) {
    const pl = plans[f.index];
    if (!pl) continue;
    const page = mapPage(f.source_page, pageMap);
    if (f.verdict !== "fix") {
      if (Array.isArray(pl.conflicts) && pl.conflicts.some((k) => k.field === f.field)) {
        settle(pl, f.field);
        entry(pl, f.field, "conflicting appearances", "stored value confirmed against the document", page, f.reason);
      }
      continue;
    }
    let from;
    let to;
    if (TIERS.includes(f.field)) {
      to = moneyNumber(f.value);
      if (to == null) continue;
      from = pl.rates[f.field] ?? null;
      pl.rates[f.field] = to;
      if (pl.unpriced) pl.unpriced = pl.unpriced.filter((t) => t !== f.field);
    } else if (BENEFIT_FIELDS.includes(f.field)) {
      from = pl.benefits ? pl.benefits[f.field] ?? "" : "";
      to = String(f.value);
      pl.benefits = { ...(pl.benefits || {}), [f.field]: to };
    } else {
      from = pl[f.field] ?? null;
      to = String(f.value);
      pl[f.field] = to;
    }
    settle(pl, f.field);
    if (String(from ?? "") !== String(to ?? "")) entry(pl, f.field, from, to, page, f.reason);
  }
  for (const u of c.unpriced || []) {
    const pl = plans[u.index];
    if (!pl || !TIERS.includes(u.tier) || pl.rates[u.tier] != null) continue;
    pl.unpriced = [...new Set([...(pl.unpriced || []), u.tier])];
    entry(pl, u.tier, null, "not priced on the document", null, "The document prints no rate for this tier.");
  }
  const drop = new Set((c.remove || []).filter((i) => Number.isInteger(i) && plans[i]));
  // A plan "removed" and "added" under the same carrier code is one plan
  // whose printed name was wrong: it is renamed in place and keeps its
  // BenSync ID - never taken off the grid and put back as a new plan.
  const codeOf = (pl) => String(pl.plan_code || "").trim().toUpperCase();
  const renamed = new Set();
  for (const a of c.add || []) {
    const code = a && codeOf(a);
    if (!code) continue;
    const i = [...drop].find((k) => codeOf(plans[k]) === code && !renamed.has(k));
    if (i == null) continue;
    const pl = plans[i];
    renamed.add(i);
    drop.delete(i);
    const sp = a.source_pages || {};
    const m = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((p) => mapPage(p, pageMap)).filter(Boolean))].sort((x, y) => x - y);
    for (const f of ["name", "network", "plan_type", "deductible", "oop_max"]) {
      if (a[f] != null && String(a[f]) !== String(pl[f] ?? "")) {
        entry(pl, f, pl[f] ?? null, a[f], null, "The plan is on the document under this value; corrected in place, not removed.");
        pl[f] = a[f];
      }
    }
    for (const t of TIERS) {
      if (a.rates && a.rates[t] != null && a.rates[t] !== pl.rates[t]) {
        entry(pl, t, pl.rates[t] ?? null, a.rates[t], null, "Read off the plan's own rate row.");
        pl.rates[t] = a.rates[t];
      }
    }
    if (a.benefits) pl.benefits = { ...(pl.benefits || {}), ...Object.fromEntries(Object.entries(a.benefits).filter(([, v]) => v !== "")) };
    if (sp.identity || sp.rates) pl.source = { ...(pl.source || {}), identity: m(sp.identity), benefits: m(sp.benefits), rates: m(sp.rates) };
  }
  for (const i of drop) entry(plans[i], "plan", "stored", "removed", null, "Not on the document, or the same carrier plan stored twice.");
  const kept = plans.filter((_, i) => !drop.has(i));
  for (const a of c.add || []) {
    if (!a || !String(a.name || "").trim()) continue;
    // A plan "added" that is already stored - by the same canonical
    // identity rules the reading was folded with - is not a second plan.
    if (matchCanonical(a, kept) >= 0) continue;
    // Nor is a stored plan under a placement label ("(alt grid base)").
    const core = placementCore(a.name);
    if (core && kept.some((k) => exactName(k.name).toLowerCase() === core.toLowerCase() && String(k.network || "").toLowerCase() === String(a.network || "").toLowerCase())) continue;
    const sp = a.source_pages || {};
    const m = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((p) => mapPage(p, pageMap)).filter(Boolean))].sort((x, y) => x - y);
    const { source_pages, ...plan } = a;
    const added = { ...plan, source: { identity: m(sp.identity), benefits: m(sp.benefits), rates: m(sp.rates), sheet: "", rows: "", appearances: 1, codes: a.plan_code ? [String(a.plan_code).trim().toUpperCase()] : [] } };
    kept.push(added);
    entry(added, "plan", "missing", "added from the document", added.source.rates[0] || added.source.identity[0] || null, "On the document but not stored.");
  }
  // Keep the reconciliation in step with the canonical list: every stored
  // plan is one unique carrier plan, EPO included, and all are expected.
  let reconciliation = extracted && extracted.reconciliation ? { ...extracted.reconciliation } : null;
  if (reconciliation) {
    const canon = canonicalPlans(kept);
    const epo = canon.filter(isEpoPlan).length;
    reconciliation = { ...reconciliation, unique_plans: canon.length, unique_ppo: canon.length - epo, unique_epo: epo, expected: canon.length };
    // The corrector's own count of the document (every distinct plan, EPO
    // included) replaces the reader's: a reader that listed one plan twice
    // no longer holds the count out of step once the source is re-counted.
    if (Number.isInteger(c.document_plan_count)) reconciliation.reader_unique_plans = c.document_plan_count;
  }
  return { extracted: { ...(extracted || {}), plans: kept, ...(reconciliation ? { reconciliation } : {}) }, log };
}

/**
 * What a client's page is told: the outcome and when - never the notes, never
 * which models. An audit of an earlier reading is no audit of this one.
 */
export function auditForClient(a, extracted) {
  if (!a || !a.status) return null;
  if (extracted !== undefined && a.version !== readingVersion(extracted)) return null;
  return { status: a.status, completedAt: a.completedAt };
}

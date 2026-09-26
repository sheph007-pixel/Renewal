// Proposal audit: two models from two different companies, Claude and
// ChatGPT, each independently read the carrier's own document and report,
// for EVERY stored plan, what the document prints: its exact name and plan
// code, network, deductible, out-of-pocket max, coinsurance, every
// client-facing benefit, HSA eligibility and all four tier rates. The
// auditors are told which plans to find (index, name, code, network, pages)
// but never the stored values, so they cannot copy them: SERVER CODE then
// compares each value read against the database (server/plan-compare.js) -
// a wrong copay is a finding whether or not the auditor thought to mention
// it.
//
// Each model's audit is two kinds of job. The DOCUMENT-LEVEL RECONCILIATION
// reads the complete source once per model per version: it counts the
// plans, lists stored plans not on the document and plans on the document
// not stored, a plan stored twice, a plan printed twice with different
// values, and unreadable pages. The PLAN FIELD AUDITS - one per batch of
// AUDIT_BATCH plans - read each plan's values from a targeted packet of the
// source (only the pages / sheet rows those plans are cited on, with header
// context), falling back to the full source whenever a packet cannot be
// shown to be complete. Every job is saved as it finishes, keyed to the
// exact source, audit standard and stored data it covers, so a retry, a
// restart or a correction re-runs only the jobs whose inputs changed.
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
import { claudeMessage } from "./claude-batch.js";
import { withFailover, openaiModel } from "./ai-failover.js";
import { AUDIT_STANDARD, COMPARE_VERSION, BENEFIT_FIELDS, comparePlan, sameBenefit, sameAmount, sameNetwork, sameName } from "./plan-compare.js";
import { buildPacket, describe as describePages } from "./audit-packets.js";
import { recordUsage, anthropicUsage, openaiUsage, providerBlock } from "./ai-usage.js";

/** The API's page ceiling for the 1M-context model this audits with. */
const MAX_PDF_PAGES = 600;

/**
 * Plans per field-audit request. A proposal with more stored plans is
 * audited in deterministic batches - plans 0-24, 25-49, ... by stored index
 * - each against a targeted packet of the source (or the full source when a
 * packet cannot be shown complete), so no answer has to hold 17 fields for
 * 145 plans at once. Every plan is in exactly one batch for each model; a
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

/**
 * How each value is to be read - the same guide for the auditors and the
 * corrector, so both read a field the same way and code can compare them.
 */
export const FIELD_GUIDE = `How to read each value (in-network, for this plan only, from this plan's own benefit or rate table - never from a neighbouring plan):
- name: the plan's name exactly as printed - nothing added, nothing dropped.
- plan_code: the carrier's plan or benefit code, or the plan ID the document prints for the plan however long, exactly as printed; empty when the plan has none.
- network: the network the plan is priced on, as printed; null when the document names none for this plan.
- deductible, oop_max: the in-network amounts as printed, individual first and then family where both are printed (e.g. "$3,000 / $6,000").
- coinsurance: the member's in-network coinsurance as printed (e.g. "20%", "0%").
- doctor_visit (primary care office visit), specialist, imaging (advanced imaging - MRI, CT, PET - as a Summary of Benefits prints it; labs and X-ray are not imaging), urgent_care, emergency_room, hospital (inpatient stay): the member's in-network cost as printed, short and verbatim (e.g. "$30 copay", "20% after deductible", "No charge").
- rx: the retail prescription cost by tier, in tier order, as printed - every tier the document prints, a specialty tier included (e.g. "$10 / $40 / $80 / 20% after deductible"); leave mail order out.
- hsa_eligible: "yes" when the document says the plan is HSA-eligible / HSA-qualified, "no" when it says it is not.
- EE, ES, EC, FAM: the monthly rate per tier (employee only, employee + spouse, employee + children, family) as a plain number, e.g. 612.45.
Use an empty string for any text value the document does not state for this plan, and null for a rate the document does not price for that tier.`;

// Text values are plain strings, empty where the document does not state
// the value: Anthropic's structured output allows at most 16 union-typed
// (nullable) parameters in a schema, and 18 nullable fields here made every
// Claude audit fail with a 400. The four rates stay nullable numbers (4
// unions); shape() reads an empty string as "not stated" (null).
const statedText = { type: "string", description: "As printed; an empty string when the document does not state it for this plan." };
export const SCHEMA_UNION_LIMIT = 16;
const CONFIRMATION = {
  type: "object",
  additionalProperties: false,
  required: ["index", "on_document", "name", "plan_code", "network", "deductible", "oop_max", ...BENEFIT_FIELDS, "benefits_belong", ...TIERS],
  properties: {
    index: { type: "integer" },
    on_document: { type: "boolean", description: "False when this plan is not on the document at all." },
    name: statedText,
    plan_code: statedText,
    network: statedText,
    deductible: statedText,
    oop_max: statedText,
    ...Object.fromEntries(BENEFIT_FIELDS.map((k) => [k, statedText])),
    benefits_belong: { type: "boolean", description: "True when the benefit values you read are unmistakably this plan's own (its own column or page), not a neighbouring plan's." },
    ...Object.fromEntries(TIERS.map((t) => [t, nullableNumber])),
  },
};

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
/** How many union-typed (anyOf / type-array) parameters a JSON schema holds, nested ones included. */
export function unionParams(schema) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (Array.isArray(node.anyOf) || Array.isArray(node.type)) n++;
    for (const v of Object.values(node)) walk(v);
  };
  walk(schema);
  return n;
}
export const AUDIT_SCHEMAS = () => ({ document: DOC_SCHEMA, field: FIELD_SCHEMA, combined: COMBINED_SCHEMA, correction: CORRECTION_SCHEMA });

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
export function shape(who, r, stored, indices = stored.map((_, i) => i), compareOpts = {}) {
  const modelVerdict = ["pass", "issues", "unreadable"].includes(r && r.verdict) ? r.verdict : "unreadable";
  const mismatches = Array.isArray(r && r.mismatches)
    ? r.mismatches.slice(0, 80).map((m) => ({ plan: String(m.plan || ""), field: String(m.field || ""), stored: String(m.stored ?? ""), onDocument: String(m.on_document ?? "") }))
    : [];
  const seen = new Set(mismatches.map((m) => `${m.plan}|${m.field}`.toLowerCase()));
  // An empty string is the schema's "not stated" (see CONFIRMATION): read as null.
  const unblank = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "string" && v.trim() === "" ? null : v]));
  const conf = new Map((Array.isArray(r && r.plan_confirmations) ? r.plan_confirmations : []).filter((c) => c && Number.isInteger(c.index)).map((c) => [c.index, unblank(c)]));
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
    for (const d of comparePlan(pl, c, compareOpts)) {
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
 * The document-level reconciliation audit's answer: the complete source,
 * read once per model per version. Counts, the stored plans it cannot find,
 * the plans it finds that are not stored, a plan stored twice, a plan the
 * document prints twice with different values, and whether every page could
 * be read. No plan's field values: those are the field batches' job.
 */
const DOC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "plan_appearances", "plans_found_total", "epo_excluded", "document_plan_count", "duplicates_found", "missing_indices", "extra_plans", "inconsistent_plans", "all_pages_readable", "unreadable_pages", "notes"],
  properties: {
    verdict: { type: "string", enum: ["pass", "issues", "unreadable"], description: "pass when every listed plan is on the document, the document prices no plan the list lacks, and the list holds no plan twice; issues otherwise; unreadable when the document cannot be read." },
    plan_appearances: { type: "integer", description: "How many times medical plans appear on the document in total - one plan on four pages is four appearances." },
    plans_found_total: { type: "integer", description: "Every DISTINCT plan option the document prices, EPO plans included, across every page, sheet and grid. A plan printed on several pages counts once." },
    epo_excluded: { type: "integer", description: "How many of those distinct plans are EPO plans (stored like every other plan)." },
    document_plan_count: { type: "integer", description: "The plans the portal should hold: every distinct plan on the document, EPO included - equal to plans_found_total." },
    duplicates_found: { type: "boolean", description: "True if the list you were given holds the same carrier plan more than once." },
    missing_indices: { type: "array", items: { type: "integer" }, description: "The index of every listed plan that is NOT on the document at all." },
    extra_plans: {
      type: "array",
      description: "Every plan the document prices that the list lacks.",
      items: { type: "object", additionalProperties: false, required: ["name", "plan_code", "page"], properties: { name: { type: "string" }, plan_code: { type: "string", description: "Empty when none is printed." }, page: { type: "string", description: "Where it is printed (page, sheet/row or line)." } } },
    },
    inconsistent_plans: {
      type: "array",
      description: "A listed plan the document prints more than once with DIFFERENT values for the same field (e.g. two rates for EE).",
      items: { type: "object", additionalProperties: false, required: ["index", "field", "values"], properties: { index: { type: "integer" }, field: { type: "string" }, values: { type: "string", description: "The differing values and where each is printed." } } },
    },
    all_pages_readable: { type: "boolean", description: "True when every page / sheet / section of the document could be read." },
    unreadable_pages: { type: "string", description: "Which pages or sections could not be read; empty when all could." },
    notes: { type: "string", description: "One or two sentences: what was checked and anything worth a human look. Empty when clean." },
  },
};

/** A plan field batch's answer: only these plans' values, as the cited source shows them. */
const FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "plan_confirmations", "insufficient_context", "notes"],
  properties: {
    verdict: { type: "string", enum: ["pass", "issues", "unreadable"], description: "pass when every listed plan was found and read; issues when a listed plan could not be found; unreadable when the source cannot be read." },
    plan_confirmations: { type: "array", description: "One entry for EVERY plan in the list you were given, by its index: each value read off the source yourself, per the field guide.", items: CONFIRMATION },
    insufficient_context: { type: "boolean", description: "True when the source you were given does not hold everything needed to read every listed plan's values with certainty (a plan, its rate row, its benefit column, or a table header is missing). Never guess instead." },
    notes: { type: "string", description: "One sentence on anything worth a human look. Empty when clean." },
  },
};

/**
 * A proposal that fits in one batch: the document reconciliation and the
 * field audit in ONE call against the full source - the full source is read
 * exactly once either way, and a separate packet would only add pages.
 */
const COMBINED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...DOC_SCHEMA.required, "plan_confirmations"],
  properties: { ...DOC_SCHEMA.properties, plan_confirmations: FIELD_SCHEMA.properties.plan_confirmations },
};

/**
 * One system prompt for every auditor call (document reconciliation and field
 * batches alike): kept byte-identical and cached, and it says nothing about
 * any one proposal. What to do in this call is in the user turn.
 */
const AUDITOR_SYSTEM = `You audit a benefits portal's reading of a carrier's proposal against the proposal document itself - the document is the source of truth. You are given the plans the portal stored as a numbered list (each with its index, the portal's ID, the name and plan code it stored, its network, and where the portal says it is printed) - but NOT the values the portal stored for them: you read values off the document yourself. You audit on your own: no other auditor's result is given to you. Every distinct plan on the document should be stored, EPO plans included (the portal decides separately which plans a client sees).

${FIELD_GUIDE}

Never guess: a value you cannot read is left empty (a rate: null). If pages are unreadable, say so.`;

const DOC_TASK = `This call is the DOCUMENT-LEVEL RECONCILIATION. You have the complete proposal. Do not read field values. Instead:
1. Count the plans on the document: every appearance (plan_appearances), every distinct plan option it prices across every page, sheet and grid (plans_found_total), how many of those are EPO plans (epo_excluded), and the plans the portal should hold (document_plan_count - every distinct plan, EPO included). A plan printed on several pages is ONE plan.
2. For each listed plan, find it by its plan code (or, where it has none, its printed name); list the index of every listed plan the document does not price at all (missing_indices).
3. List every plan the document prices that the list lacks (extra_plans), and set duplicates_found if the list holds one carrier plan twice.
4. List any listed plan the document prints more than once with different values for the same field (inconsistent_plans). The same design priced on two networks (a narrow-network sheet beside a PPO sheet, say) is two plans, not an inconsistency.
5. Say whether every page / sheet / section could be read.`;

const COMBINED_TASK = () => `This call is BOTH the document-level reconciliation and the plan field audit (every stored plan fits in one batch). You have the complete proposal.

${DOC_TASK}

Then: ${FIELD_TASK}`;

const FIELD_TASK = `This call is a PLAN FIELD AUDIT. For EVERY plan in the list, by index, find it by its plan code (or, where it has none, its printed name) and return what the source prints for it (plan_confirmations), following the field guide. Read every value from that plan's own table - never copy the name you were given if the source prints it differently, and never take a value from a neighbouring plan. Do not count or reconcile the whole document: that is done separately. If a listed plan is not in the source you were given, set on_document false.`;

const PACKET_TASK = (note) => `The source you were given is a PACKET of the proposal: ${note} It holds the places the portal says these plans are printed, plus the headers around them. If anything needed to read a listed plan's values with certainty is not in this packet - the plan itself, its rate row, its benefit column, or a table header - set insufficient_context true instead of guessing; the plans will then be read against the whole proposal.`;

/** Bumped when the document job's question changes: an older answer no longer counts. */
export const DOC_JOB_VERSION = 3; // 2: plan IDs are plan codes; a design on two networks is two plans. 3: imaging is MRI/CT/PET
/** Bumped when field packets are built differently: every batch is read again. */
export const PACKET_VERSION = 3; // 2: rx reads every tier (specialty included); plan IDs are plan codes. 3: imaging is MRI/CT/PET

const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/**
 * What the document-level reconciliation depends on: the exact source
 * document, the audit standard, which plans are stored (their identity -
 * name, code, network - and count, not their values), and the reading's
 * source-coverage record. A correction to one benefit or rate leaves this
 * key - and the answer - valid; a plan added, removed or renamed, a re-read
 * or a new file does not.
 */
export function docJobKey(extracted, sourceSha) {
  const stored = storedFor(extracted);
  return hash({ s: sourceSha || null, std: AUDIT_STANDARD, v: DOC_JOB_VERSION, plans: stored.map((p) => [p.name, p.plan_code, p.network]), cov: coverageSignature(extracted) });
}

/**
 * What one field batch depends on: the exact source document, the audit
 * standard, how packets are built, and - for each plan in it, by index -
 * every stored value and its provenance (the BenSync ID aside, which is
 * only a label). A correction to one plan changes only its batch's key.
 */
export function batchJobKey(stored, indices, sourceSha) {
  return hash({ s: sourceSha || null, std: AUDIT_STANDARD, v: PACKET_VERSION, plans: indices.map((i) => { const { id, ...rest } = stored[i] || {}; return [i, rest]; }) });
}

/** Which jobs a model's audit consists of, and the key each must match to count. */
/** A one-batch proposal's single combined job depends on both. */
export const combinedKey = (docKey, batchKey) => hash({ combined: [docKey, batchKey] });

export function auditPlan(extracted, sourceSha) {
  const stored = storedFor(extracted);
  const batches = auditBatches(stored.length);
  return { stored, batches, docKey: docJobKey(extracted, sourceSha), batchKeys: batches.map((b) => batchJobKey(stored, b, sourceSha)) };
}

/**
 * Where a proposal's audit stands, job by job, for each model: which saved
 * jobs still count (their key matches the reading now) and the next one
 * missing - "Claude document reconciliation", "OpenAI batch 5 of 7" - so the
 * steward resumes exactly there after a failure or a restart.
 */
export function auditProgress(extracted, sourceSha, jobs = {}) {
  const { batches, docKey, batchKeys } = auditPlan(extracted, sourceSha);
  const single = batches.length === 1;
  const out = {};
  for (const [p, label] of [["claude", "Claude"], ["openai", "OpenAI"]]) {
    const doc = jobs[`${p}:doc`];
    const docOk = !!(doc && doc.key === (single ? combinedKey(docKey, batchKeys[0]) : docKey));
    const done = batchKeys.map((k, b) => (single ? docOk : !!(jobs[`${p}:batch:${b}`] && jobs[`${p}:batch:${b}`].key === k)));
    const nextBatch = done.indexOf(false);
    out[p] = {
      document: docOk,
      batchesDone: done.filter(Boolean).length,
      batches: batches.length,
      next: !docOk ? `${label} document reconciliation` : nextBatch >= 0 ? `${label} batch ${nextBatch + 1} of ${batches.length}` : null,
    };
  }
  return out;
}

const docPayload = (stored, version, sourceSha, x, combined = false) =>
  [
    combined ? COMBINED_TASK() : DOC_TASK,
    `Proposal version: document ${sourceSha || "?"}, reading ${version}.`,
    `The portal's plan-count reconciliation: ${JSON.stringify((x && x.reconciliation) || null)}`,
    `The portal stores ${stored.length} plans. The list (locators only):\n${JSON.stringify(findersFor(stored, stored.map((_, i) => i)), null, 1)}`,
    ...(combined ? ["Return a plan_confirmation for every plan in the list, read off the document."] : []),
  ].join("\n\n");

const fieldPayload = (stored, indices, version, sourceSha, b, n, packetNote) =>
  [
    FIELD_TASK,
    packetNote ? PACKET_TASK(packetNote) : "You have the complete proposal.",
    `Proposal version: document ${sourceSha || "?"}, reading ${version}.`,
    n > 1 ? `Batch ${b + 1} of ${n}: plans ${indices[0]}-${indices[indices.length - 1]} of the ${stored.length} stored. Return a plan_confirmation for every plan listed below.` : `The portal stores ${stored.length} plans.`,
    `The plans to find and read:\n${JSON.stringify(findersFor(stored, indices), null, 1)}`,
    "Read every listed plan's values off the source.",
  ].join("\n\n");

/** The document-level answer, checked in code into a model part: counts and document-level findings. */
export function shapeDoc(who, r, stored) {
  const verdict = ["pass", "issues", "unreadable"].includes(r && r.verdict) ? r.verdict : "unreadable";
  const int = (v) => (Number.isInteger(v) ? v : null);
  const mismatches = [];
  for (const i of Array.isArray(r && r.missing_indices) ? r.missing_indices : []) {
    const pl = stored[i];
    if (pl) mismatches.push({ plan: pl.name, index: i, optionId: pl.id || null, planCode: pl.plan_code || null, field: "missing_plan", stored: "stored", onDocument: "not on document" });
  }
  for (const e of Array.isArray(r && r.extra_plans) ? r.extra_plans.slice(0, 80) : []) mismatches.push({ plan: String(e.name || ""), field: "extra_plan", stored: "not stored", onDocument: `${e.name}${e.plan_code ? ` [${e.plan_code}]` : ""}${e.page ? ` (${e.page})` : ""}` });
  if (r && r.duplicates_found === true) mismatches.push({ plan: "(stored list)", field: "duplicate_plan", stored: "a plan stored twice", onDocument: "one plan" });
  for (const k of Array.isArray(r && r.inconsistent_plans) ? r.inconsistent_plans.slice(0, 40) : []) {
    const pl = stored[k.index];
    mismatches.push({ plan: pl ? pl.name : `(index ${k.index})`, ...(pl ? { index: k.index, optionId: pl.id || null, planCode: pl.plan_code || null } : {}), field: "inconsistent_on_document", stored: String(k.field || ""), onDocument: String(k.values || "") });
  }
  if (r && r.all_pages_readable === false) mismatches.push({ plan: "(whole document)", field: "unreadable_pages", stored: "", onDocument: String(r.unreadable_pages || "some pages could not be read") });
  return {
    model: who,
    verdict: verdict === "unreadable" ? "unreadable" : mismatches.length || verdict === "issues" ? "issues" : "pass",
    planAppearances: int(r && r.plan_appearances),
    plansFoundTotal: int(r && r.plans_found_total),
    epoExcluded: int(r && r.epo_excluded),
    documentPlanCount: int(r && r.document_plan_count),
    mismatches,
    notes: String((r && r.notes) || "").slice(0, 1500),
  };
}

/**
 * One model's audit: its document reconciliation and every field batch,
 * combined. Passes only when the document job passed, every batch came back
 * and passed, and every plan was confirmed. The document counts are the
 * document job's own - the only call that read the whole source to count.
 */
export function composeModel(who, doc, parts, total) {
  const confirmed = parts.reduce((n, p) => n + (p.confirmed || 0), 0);
  const seen = new Set();
  const mismatches = [...((doc && doc.mismatches) || []), ...parts.flatMap((p) => p.mismatches || [])].filter((m) => {
    const k = `${Number.isInteger(m.index) ? m.index : m.plan}|${m.field}|${m.onDocument}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const failed = [doc, ...parts].find((p) => !p || p.verdict === "error" || p.verdict === "off");
  const verdict = failed
    ? (failed && failed.verdict) || "error"
    : [doc, ...parts].some((p) => p.verdict === "unreadable")
      ? "unreadable"
      : confirmed < total || parts.some((p) => p.verdict === "incomplete")
        ? "incomplete"
        : mismatches.length || [doc, ...parts].some((p) => p.verdict === "issues")
          ? "issues"
          : "pass";
  return {
    model: who,
    verdict,
    planAppearances: doc ? doc.planAppearances ?? null : null,
    plansFoundTotal: doc ? doc.plansFoundTotal ?? null : null,
    epoExcluded: doc ? doc.epoExcluded ?? null : null,
    documentPlanCount: doc ? doc.documentPlanCount ?? null : null,
    confirmed,
    of: total,
    document: doc ? { verdict: doc.verdict, reused: !!doc.reused } : null,
    batches: parts.map((p) => ({ from: p.from, to: p.to, verdict: p.verdict, confirmed: p.confirmed ?? 0, source: p.source || null, reused: !!p.reused })),
    mismatches,
    notes: [doc && doc.notes, ...parts.map((p) => p.notes)].filter(Boolean).join(" ").slice(0, 3000),
  };
}

const anthropicClient = () => (apiKey() ? new Anthropic({ apiKey: apiKey(), maxRetries: 3, timeout: 10 * 60 * 1000 }) : new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 }));

/**
 * The cache marker on a full-source block and the shared system prompt: the
 * 1-hour TTL (Anthropic prompt caching, `{ type: "ephemeral", ttl: "1h" }`),
 * so a full source re-read within the hour - a full-source fallback batch, a
 * retry, a correction, the other half of a resumed audit - is a cache read.
 * A 1-hour write bills at 2x input (5-minute: 1.25x) and a read at 0.1x, so
 * it pays off once the same source is read three or more times in the hour;
 * KENNION_SOURCE_CACHE_TTL=5m or =off changes it if usage telemetry shows
 * full sources are mostly read once.
 */
const cacheTtl = String(process.env.KENNION_SOURCE_CACHE_TTL || "1h").toLowerCase();
export const SOURCE_CACHE = cacheTtl === "off" ? undefined : cacheTtl === "5m" ? { type: "ephemeral" } : { type: "ephemeral", ttl: "1h" };
const withCache = (block) => (SOURCE_CACHE ? { ...block, cache_control: SOURCE_CACHE } : block);

/**
 * The source block(s) for one call. Full: the whole document, cached for an
 * hour - the same bytes are read by the document job, any full-source
 * fallback batch, a retry and a correction within the hour. A packet is not
 * cached: each packet is read once, and a cache write would only add cost.
 */
function claudeSource(filename, prepared, packet) {
  if (packet && !packet.full) {
    if (packet.kind === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: packet.buffer.toString("base64") }, title: `${filename} (pages ${packetDescribe(packet)})` };
    return { type: "document", source: { type: "text", media_type: "text/plain", data: packet.text || "(empty)" }, title: `${filename} (packet)` };
  }
  if (prepared.kind === "pdf") return withCache({ type: "document", source: { type: "base64", media_type: "application/pdf", data: prepared.buffer.toString("base64") }, title: filename });
  if (prepared.kind === "image") return withCache({ type: "image", source: { type: "base64", media_type: prepared.mime, data: prepared.buffer.toString("base64") } });
  return withCache({ type: "document", source: { type: "text", media_type: "text/plain", data: prepared.text || "(empty)" }, title: filename });
}
/** For tests: the Anthropic source block a call would send. */
export const _claudeSource = (...args) => claudeSource(...args);
const packetDescribe = (packet) => (packet.pages ? describePages(packet.pages) : "");

/** What a call sent, for telemetry: full (and why) or which pages / sheets / lines. */
const sourceSent = (prepared, packet, numpages) => {
  if (!packet || packet.full) return { full: true, of: prepared.kind === "pdf" ? numpages || null : null, unit: prepared.kind === "pdf" ? "pages" : prepared.kind, reason: packet && packet.reason ? packet.reason : null };
  if (packet.kind === "pdf") return { full: false, pages: packet.pages, of: packet.of, cited: packet.cited, context: packet.context };
  if (packet.sheets) return { full: false, sheets: packet.sheets };
  return { full: false, lines: packet.lines, of: packet.of };
};

/** A connection or service failure (not the request's fault): worth the same call again. */
const transient = (e) => !!e && (e.status === 429 || e.status >= 500 || /terminated|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|overloaded|fetch failed/i.test(`${e.message || ""} ${(e.cause && (e.cause.code || e.cause.message)) || ""}`));

async function callClaude({ purpose, schema, block, text, meta }) {
  const client = anthropicClient();
  const started = Date.now();
  let retries = 0;
  for (;;) {
    try {
      const response = await claudeMessage(client, {
        model: CLAUDE_MODEL,
        max_tokens: 64000,
        output_config: { effort: "high", format: { type: "json_schema", schema } },
        system: [withCache({ type: "text", text: AUDITOR_SYSTEM })],
        messages: [{ role: "user", content: [block, { type: "text", text }] }],
      });
      recordUsage({ purpose, provider: "anthropic", model: CLAUDE_MODEL, servedModel: response.model, usage: anthropicUsage(response), durationMs: Date.now() - started, retries, ok: response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens", error: response.stop_reason === "refusal" || response.stop_reason === "max_tokens" ? response.stop_reason : null, ...meta });
      if (response.stop_reason === "refusal") throw new Error("Claude declined the check.");
      if (response.stop_reason === "max_tokens") throw new Error("Claude's audit ran past one answer.");
      return JSON.parse(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    } catch (e) {
      if (transient(e) && retries < 2) {
        retries++;
        await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * retries));
        continue;
      }
      if (!/declined|ran past/.test(e.message)) recordUsage({ purpose, provider: "anthropic", model: CLAUDE_MODEL, durationMs: Date.now() - started, retries, ok: false, error: e.message, ...meta });
      throw e;
    }
  }
}
const RETRY_PAUSE_MS = Number(process.env.KENNION_AUDIT_RETRY_PAUSE_MS || 15000);

async function callOpenAI({ purpose, schema, name, filename, prepared, packet, text, meta }) {
  const parts = [];
  if (packet && !packet.full) {
    if (packet.kind === "pdf") parts.push({ type: "file", file: { filename: `${filename} (pages ${packetDescribe(packet)}).pdf`, file_data: `data:application/pdf;base64,${packet.buffer.toString("base64")}` } });
    else parts.push({ type: "text", text: `The source packet (${filename}):\n${packet.text || "(empty)"}` });
  } else if (prepared.kind === "pdf") parts.push({ type: "file", file: { filename, file_data: `data:application/pdf;base64,${prepared.buffer.toString("base64")}` } });
  else if (prepared.kind === "image") parts.push({ type: "image_url", image_url: { url: `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}` } });
  else parts.push({ type: "text", text: `The document (${filename}):\n${prepared.text || "(empty)"}` });
  parts.push({ type: "text", text });
  const body = {
    model: CHATGPT_MODEL(),
    messages: [
      { role: "system", content: AUDITOR_SYSTEM },
      { role: "user", content: parts },
    ],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
  };
  const started = Date.now();
  let last;
  let retries = 0;
  // Up to three tries on a network failure or a 429/5xx: a missing OpenAI
  // audit holds the proposal back from Verified, so it is worth retrying -
  // this one call only; every job already done stays done.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await postJson("https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${chatgptKey()}` }, body, 20 * 60 * 1000);
      if (!r.ok) {
        last = new Error(`ChatGPT (${CHATGPT_MODEL()}): ${(r.json.error && r.json.error.message) || `HTTP ${r.status}`}`);
        last.status = r.status;
        if (r.status === 429 || r.status >= 500) {
          retries++;
          await new Promise((res) => setTimeout(res, RETRY_PAUSE_MS * attempt));
          continue;
        }
        throw last;
      }
      recordUsage({ purpose, provider: "openai", model: CHATGPT_MODEL(), servedModel: r.json.model || CHATGPT_MODEL(), usage: openaiUsage(r.json), durationMs: Date.now() - started, retries, ok: true, ...meta });
      const out = r.json.choices && r.json.choices[0] && r.json.choices[0].message ? String(r.json.choices[0].message.content || "") : "";
      if (!out) throw new Error("ChatGPT returned no text.");
      return JSON.parse(out);
    } catch (e) {
      last = e;
      if (attempt === 3 || /HTTP 4\d\d|returned no text/.test(e.message) || (e.status && e.status < 500 && e.status !== 429)) break;
      retries++;
    }
  }
  recordUsage({ purpose, provider: "openai", model: CHATGPT_MODEL(), durationMs: Date.now() - started, retries, ok: false, error: last && last.message, ...meta });
  throw last;
}

/**
 * Run both models' audits, job by job, and combine them. Per model:
 *   1. the DOCUMENT-LEVEL RECONCILIATION - the complete source, once: the
 *      plan count, stored plans not on the document, plans on the document
 *      not stored, a plan stored twice, a plan printed twice with different
 *      values, unreadable pages;
 *   2. one PLAN FIELD AUDIT per batch of AUDIT_BATCH plans - every stored
 *      plan in exactly one batch - read against a TARGETED PACKET of the
 *      source (the pages / sheet rows its plans are cited on, plus header
 *      context; server/audit-packets.js), or the full source when a packet
 *      cannot be shown to be complete or the auditor says it lacked context.
 * Every job's answer is saved as it completes (`saveJob`) under a key tied
 * to the exact source SHA, audit standard and the stored data it covers;
 * `jobs` (saved earlier) whose key still matches are reused, never re-run.
 * A job that fails stops that model; the next run resumes at that job.
 *
 * `status`: pass - both models' document jobs and every batch passed, every
 * plan was confirmed by both, every compared field agrees, both counts equal
 * the database; issues - a finding; pending - anything less. Never a pass on
 * one model's word.
 *
 * Test hooks: `transport({ who, provider, kind: "doc"|"batch", indices,
 * packet, payload })` answers a job; `read(who, payload, indices)` is the
 * older combined-answer hook (counts + confirmations in one answer).
 */
export async function auditProposal({ filename, mime, buffer, extracted, sourceSha = null, read = null, transport = null, jobs = {}, saveJob = null }) {
  const completedAt = new Date().toISOString();
  const version = readingVersion(extracted);
  const storedCount = offeredCount(extracted);
  const { stored, batches, docKey, batchKeys } = auditPlan(extracted, sourceSha);
  if (!stored.length) return { completedAt, status: "pending", models: [], mismatches: [], notes: "No plans stored to check.", version, standard: AUDIT_STANDARD, counts: { stored: 0 } };
  const epo = canonicalPlans(extracted).filter(isEpoPlan).length;
  const exactRows = !!(extracted && extracted.extraction && extracted.extraction.method === "parser");
  // A Gravie rate workbook's rows state each plan's deductible, out-of-pocket
  // max and coinsurance; its other benefits are Gravie's static Benefits
  // Grid, the same for every group - supplemental and attributed, never the
  // plan's own record - so they are not compared against it.
  const gravieParsed = !!(extracted && ((extracted.coverage && extracted.coverage.parser === "gravie") || (extracted.extraction && extracted.extraction.method === "parser" && /gravie/i.test(String(extracted.carrier || "")))));
  const compareOpts = gravieParsed ? { benefitFields: ["coinsurance"], networkFromSheet: true } : {};
  const saved = { ...(jobs || {}) };
  const save = async (id, value) => {
    saved[id] = value;
    if (saveJob) await saveJob(id, value);
  };

  // What answers a job: a test hook, the canned auditor, or the two APIs.
  let answer;
  let prepared = null;
  let numpages = null;
  const canned = !transport && !read && fakeAi();
  // Packets are built from the real file whenever there is one - under a
  // test transport too, so tests exercise exactly the pages that would be sent.
  const prepareSource = async () => {
    prepared = await prepareForModel({ filename, mime, buffer });
    if (prepared.kind === "pdf") {
      numpages = await countPages(prepared.buffer);
      if (numpages > MAX_PDF_PAGES) throw new Error(`This proposal is ${numpages} pages - too long for the model to audit (limit ${MAX_PDF_PAGES}).`);
    }
  };
  if (transport) {
    if (buffer && buffer.length) await prepareSource();
    answer = transport;
  }
  else if (read || canned) {
    const combined =
      read ||
      ((who, payload, indices) => ({ verdict: "pass", plan_appearances: storedCount, plans_found_total: storedCount, epo_excluded: epo, document_plan_count: storedCount, duplicates_found: false, plan_confirmations: indices.map((i) => cannedRead(stored[i], i)), mismatches: [], notes: "Canned audit (KENNION_FAKE_AI)." }));
    answer = async ({ who, kind, indices, payload }) => {
      const r = await combined(who, payload, kind === "doc" ? [] : indices);
      if (kind === "combined") return { ...r, missing_indices: [], extra_plans: (r.mismatches || []).filter((m) => m.field === "extra_plan").map((m) => ({ name: m.on_document || m.plan, plan_code: "", page: "" })), inconsistent_plans: [], all_pages_readable: r.verdict !== "unreadable", unreadable_pages: "" };
      if (kind === "batch") return { verdict: r.verdict === "unreadable" ? "unreadable" : "pass", plan_confirmations: r.plan_confirmations || [], insufficient_context: false, notes: r.notes || "" };
      // The older hook answers counts and document-level findings in one reply.
      const extra = (r.mismatches || []).filter((m) => m.field === "extra_plan").map((m) => ({ name: m.on_document || m.plan, plan_code: "", page: "" }));
      return { verdict: r.verdict, plan_appearances: r.plan_appearances, plans_found_total: r.plans_found_total, epo_excluded: r.epo_excluded, document_plan_count: r.document_plan_count, duplicates_found: !!r.duplicates_found, missing_indices: [], extra_plans: extra, inconsistent_plans: [], all_pages_readable: r.verdict !== "unreadable", unreadable_pages: "", notes: r.notes || "" };
    };
  } else {
    await prepareSource();
    answer = async ({ provider, kind, indices, packet, payload, batch }) => {
      const meta = { batch: kind === "batch" ? batch : null, plansInBatch: kind === "batch" ? indices.length : stored.length, source: sourceSent(prepared, packet, numpages), readingVersion: version, auditStandard: AUDIT_STANDARD };
      const purpose = kind === "doc" ? `document-reconciliation-${provider}` : kind === "combined" ? `document-and-field-audit-${provider}` : packet && packet.full ? `fallback-full-read-${provider}` : `plan-audit-${provider}`;
      const schema = kind === "doc" ? DOC_SCHEMA : kind === "combined" ? COMBINED_SCHEMA : FIELD_SCHEMA;
      if (provider === "claude") return callClaude({ purpose, schema, block: claudeSource(filename, prepared, packet), text: payload, meta });
      return callOpenAI({ purpose, schema, name: kind === "doc" ? "document_reconciliation" : kind === "combined" ? "proposal_audit" : "plan_field_audit", filename, prepared, packet, text: payload, meta });
    };
  }

  const packetFor = async (indices) => {
    if (!prepared) return { full: true, reason: "no source file to cut" };
    return buildPacket({ prepared, source: { buffer, mime, filename }, plans: indices.map((i) => stored[i]), numpages, exactRows });
  };

  const runModel = async (provider, who) => {
    // A provider at its spending limit does not audit (and is not asked):
    // its part waits, its saved jobs stay, and the next run resumes there.
    // The audit never fails over - Verified needs both independent checks.
    if (!transport && !read && !canned && providerBlock(provider === "claude" ? "anthropic" : "openai")) {
      return composeModel(who, { model: who, verdict: "error", mismatches: [], notes: `${provider === "claude" ? "Claude" : "ChatGPT"} is at its spending limit - its audit waits until it is back.` }, [], stored.length);
    }
    // A proposal that fits in one batch: one call does both jobs.
    if (batches.length === 1) {
      const indices = batches[0];
      const key = combinedKey(docKey, batchKeys[0]);
      const prev = saved[`${provider}:doc`];
      const range = { from: indices[0], to: indices[indices.length - 1] };
      if (prev && prev.key === key) return composeModel(who, { ...shapeDoc(who, prev.answer, stored), reused: true }, [{ ...shape(who, prev.answer, stored, indices, compareOpts), ...range, source: { full: true }, reused: true }], stored.length);
      try {
        const r = await answer({ who, provider, kind: "combined", batch: 0, indices, packet: { full: true }, payload: docPayload(stored, version, sourceSha, extracted, true) });
        await save(`${provider}:doc`, { key, combined: true, readingVersion: version, sourceSha, standard: AUDIT_STANDARD, at: new Date().toISOString(), answer: r, source: { full: true } });
        return composeModel(who, shapeDoc(who, r, stored), [{ ...shape(who, r, stored, indices, compareOpts), ...range, source: { full: true } }], stored.length);
      } catch (e) {
        return composeModel(who, { model: who, verdict: "error", mismatches: [], notes: `Audit: ${e.message}` }, [], stored.length);
      }
    }
    // 1. The document-level reconciliation.
    let docPart;
    const prevDoc = saved[`${provider}:doc`];
    if (prevDoc && prevDoc.key === docKey) docPart = { ...shapeDoc(who, prevDoc.answer, stored), reused: true };
    else {
      try {
        const r = await answer({ who, provider, kind: "doc", indices: stored.map((_, i) => i), packet: { full: true }, payload: docPayload(stored, version, sourceSha, extracted) });
        await save(`${provider}:doc`, { key: docKey, readingVersion: version, sourceSha, standard: AUDIT_STANDARD, at: new Date().toISOString(), answer: r });
        docPart = shapeDoc(who, r, stored);
      } catch (e) {
        return composeModel(who, { model: who, verdict: "error", mismatches: [], notes: `Document reconciliation: ${e.message}` }, [], stored.length);
      }
    }
    // 2. Every field batch, each from its targeted packet.
    const parts = [];
    for (const [b, indices] of batches.entries()) {
      const id = `${provider}:batch:${b}`;
      const prev = saved[id];
      const range = { from: indices[0], to: indices[indices.length - 1] };
      if (prev && prev.key === batchKeys[b]) {
        parts.push({ ...shape(who, prev.answer, stored, indices, compareOpts), ...range, source: prev.source || null, reused: true });
        continue;
      }
      try {
        let packet = await packetFor(indices);
        let r = await answer({ who, provider, kind: "batch", batch: b, indices, packet, payload: fieldPayload(stored, indices, version, sourceSha, b, batches.length, packet.full ? null : packet.note || `pages ${packetDescribe(packet)} of the ${packet.of}-page proposal, in that order (original page numbers).`) });
        let part = shape(who, r, stored, indices, compareOpts);
        // A packet that did not hold everything - the auditor says so, or a
        // listed plan was not found in it, or a plan came back unconfirmed -
        // is never taken as a finding: the batch is read against the whole
        // source instead. Accuracy first.
        const short = !packet.full && (r.insufficient_context === true || part.confirmed < indices.length || (r.plan_confirmations || []).some((c) => c && (c.on_document === false || c.benefits_belong === false)));
        if (short) {
          packet = { full: true, reason: r.insufficient_context ? "the auditor said the packet lacked context" : "a plan was not found in the packet" };
          r = await answer({ who, provider, kind: "batch", batch: b, indices, packet, payload: fieldPayload(stored, indices, version, sourceSha, b, batches.length, null) });
          part = shape(who, r, stored, indices, compareOpts);
        }
        const source = packet.full ? { full: true, reason: packet.reason || null } : { full: false, pages: packet.pages || null, sheets: packet.sheets || null, lines: packet.lines || null };
        await save(id, { key: batchKeys[b], indices, readingVersion: version, sourceSha, standard: AUDIT_STANDARD, at: new Date().toISOString(), answer: r, source });
        parts.push({ ...part, ...range, source });
      } catch (e) {
        parts.push({ model: who, verdict: "error", confirmed: 0, mismatches: [], notes: `Batch ${b + 1} of ${batches.length}: ${e.message}`, ...range });
        // A failed job stops this model; every job done so far is saved and
        // the next run starts at this one.
        break;
      }
    }
    return composeModel(who, docPart, parts, stored.length);
  };

  const claudeOn = transport || read || canned || apiKey() || process.env.ANTHROPIC_AUTH_TOKEN;
  const openaiOn = transport || read || canned || chatgptKey();
  const label = (p) => (transport || read ? `${p === "claude" ? "Claude" : "ChatGPT"} (test)` : canned ? `${p === "claude" ? "Claude" : "ChatGPT"} (canned)` : p === "claude" ? `Claude (${CLAUDE_MODEL})` : `ChatGPT (${CHATGPT_MODEL()})`);
  const models = await Promise.all([
    claudeOn ? runModel("claude", label("claude")) : Promise.resolve({ model: "Claude", verdict: "off", mismatches: [], notes: "No Anthropic key." }),
    openaiOn ? runModel("openai", label("openai")) : Promise.resolve({ model: "ChatGPT", verdict: "off", mismatches: [], notes: "No ChatGPT key." }),
  ]);
  const mismatches = models.flatMap((m) => (m.mismatches || []).map((x) => ({ ...x, by: m.model })));
  // The plan count, held to the database by each model's document job.
  for (const m of models) {
    if (m.documentPlanCount != null && m.documentPlanCount !== storedCount) {
      mismatches.push({ plan: "(whole document)", field: "plan_count", stored: String(storedCount), onDocument: `${m.documentPlanCount} (${m.plansFoundTotal ?? "?"} found, ${m.epoExcluded ?? "?"} of them EPO)`, by: m.model });
    }
  }
  const both = models.length === 2 && models.every((m) => m.verdict === "pass");
  const status = mismatches.length ? "issues" : both ? "pass" : "pending";
  const notes = models.filter((m) => m.notes).map((m) => `${m.model}: ${m.notes}`).join(" ");
  const counts = { stored: storedCount };
  for (const m of models) {
    const k = /^claude/i.test(m.model) ? "claude" : "chatgpt";
    counts[k] = { appearances: m.planAppearances ?? null, found: m.plansFoundTotal ?? null, epoExcluded: m.epoExcluded ?? null, expected: m.documentPlanCount ?? null };
  }
  return { completedAt, status, models, mismatches, notes, version, sourceSha, standard: AUDIT_STANDARD, compare: COMPARE_VERSION, batches: batches.length, counts, documentPlanCount: both && !mismatches.length ? storedCount : null, jobs: saved };
}

/** Pages in a PDF: pdf-parse, else pdf-lib (an encrypted carrier quote pdf-parse cannot open). */
async function countPages(buf) {
  const viaParse = await pdfParse(buf).then((r) => r.numpages || 0).catch(() => 0);
  if (viaParse) return viaParse;
  return PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false }).then((d) => d.getPageCount()).catch(() => 0);
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

/**
 * Ask Claude to settle findings against the document. `targetIndices`, when
 * given, are the stored plans the findings concern: only the source those
 * plans are cited on is sent (a targeted packet - PDF pages with header
 * context, or a parser-read workbook's sheet rows; server/audit-packets.js),
 * not the whole proposal for one field. `pages` (older callers) names PDF
 * pages directly. Without either - a missing plan, a count problem, a
 * duplicate, anything structural - or when a packet cannot be shown to be
 * complete, the whole document is sent. The answer's page positions are
 * mapped back to original pages (`_pageMap`).
 */
export async function correctProposal({ filename, mime, buffer, extracted, mismatches, missingRates, conflicts = [], pages = null, targetIndices = null }) {
  if (fakeAi()) return { document_plan_count: offeredCount(extracted), fixes: [], add: [], remove: [], unpriced: [], notes: "Canned correction (KENNION_FAKE_AI).", _pageMap: null, _source: { full: true, reason: "canned" } };
  const prepared = await prepareForModel({ filename, mime, buffer });
  const client = anthropicClient();
  const stored = storedFor(extracted);
  const numbered = stored.map((pl, index) => ({ index, ...pl }));
  let packet = { full: true, reason: "structural findings need the whole document" };
  const numpages = prepared.kind === "pdf" ? await countPages(prepared.buffer) : null;
  if (Array.isArray(targetIndices) && targetIndices.length) {
    packet = await buildPacket({ prepared, source: { buffer, mime, filename }, plans: targetIndices.map((i) => stored[i]).filter(Boolean), numpages, exactRows: !!(extracted && extracted.extraction && extracted.extraction.method === "parser") });
  } else if (prepared.kind === "pdf" && Array.isArray(pages) && pages.length) {
    try {
      const { excerptPdf } = await import("./audit-packets.js");
      packet = { full: false, kind: "pdf", buffer: await excerptPdf(prepared.buffer, pages), pages, of: numpages };
    } catch (e) {
      packet = { full: true, reason: `the PDF cannot be cut into pages (${e.message.slice(0, 60)})` };
    }
  }
  const pageMap = !packet.full && packet.kind === "pdf" ? packet.pages : null;
  const content = [
    claudeSource(filename, prepared, packet),
    {
      type: "text",
      text: [
        pageMap ? `This file holds only pages ${pageMap.join(", ")} of the proposal - the pages the findings concern, with their headers - in that order. Page positions in your answer are positions within this file.` : !packet.full ? `This is a packet of the proposal: ${packet.note}` : "This is the whole proposal.",
        `The stored plans:\n${JSON.stringify(numbered, null, 1)}`,
        `The auditors' findings:\n${JSON.stringify(mismatches || [], null, 1)}`,
        `Conflicts between two appearances of the same plan (settle each from the plan's own table):\n${JSON.stringify(conflicts || [], null, 1)}`,
        `Tier rates the portal is missing (index, tier):\n${JSON.stringify(missingRates || [])}`,
        "Correct the stored reading against the document.",
      ].join("\n\n"),
    },
  ];
  const started = Date.now();
  const meta = { plansInBatch: Array.isArray(targetIndices) ? targetIndices.length : stored.length, source: sourceSent(prepared, packet, numpages) };
  let response;
  const correctionParams = {
    model: CLAUDE_MODEL,
    max_tokens: 128000,
    output_config: { effort: "high", format: { type: "json_schema", schema: CORRECTION_SCHEMA } },
    system: [withCache({ type: "text", text: CORRECTION_INSTRUCTIONS })],
    messages: [{ role: "user", content }],
  };
  try {
    // Claude, or ChatGPT with the same request when Claude is at its
    // spending limit (server/ai-failover.js): corrections never stop for one provider.
    response = await withFailover(() => claudeMessage(client, correctionParams), correctionParams, { name: "proposal_correction" });
  } catch (e) {
    const viaOpenAI = /ChatGPT/.test(e.message || "");
    recordUsage({ purpose: "correction", provider: viaOpenAI ? "openai" : "anthropic", model: viaOpenAI ? openaiModel() : CLAUDE_MODEL, durationMs: Date.now() - started, ok: false, error: e.message, ...meta });
    throw e;
  }
  const viaOpenAI = response._provider === "openai";
  recordUsage({ purpose: "correction", provider: viaOpenAI ? "openai" : "anthropic", model: viaOpenAI ? openaiModel() : CLAUDE_MODEL, servedModel: response.model, usage: anthropicUsage(response), durationMs: Date.now() - started, ok: response.stop_reason === "end_turn", error: response.stop_reason !== "end_turn" ? response.stop_reason : null, ...meta });
  if (response.stop_reason === "refusal") throw new Error(`${viaOpenAI ? "ChatGPT" : "Claude"} declined the correction.`);
  if (response.stop_reason === "max_tokens") throw new Error("The correction was too long for one answer.");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const out = JSON.parse(text);
  if (!out || !Array.isArray(out.fixes)) throw new Error("Could not read the correction.");
  return { ...out, _pageMap: pageMap, _source: meta.source, _by: viaOpenAI ? `ChatGPT (${openaiModel()})` : `Claude (${CLAUDE_MODEL})` };
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
    // A "fix" with nothing in it is not a reading: the corrector could not
    // read a value, and the stored one stays. A plan's name, code or network
    // is never blanked by a correction.
    if (f.value == null || !String(f.value).trim()) continue;
    // A "fix" that says what is already stored in other words ("$10/$35/$70"
    // for "$10/$35/$70, 3.0 MO") changes nothing the audit compares: the
    // stored wording stays, so a correction never flips a value back and
    // forth between two renderings of the same figures.
    const stored = BENEFIT_FIELDS.includes(f.field) ? pl.benefits && pl.benefits[f.field] : TIERS.includes(f.field) ? null : pl[f.field];
    const sameAlready =
      stored != null &&
      String(stored).trim() !== "" &&
      (BENEFIT_FIELDS.includes(f.field) && f.field !== "hsa_eligible" ? sameBenefit(stored, f.value, f.field) : f.field === "network" ? sameNetwork(stored, f.value) : f.field === "deductible" || f.field === "oop_max" ? sameAmount(stored, f.value) : f.field === "name" ? sameName(stored, f.value, pl.plan_code) : false);
    if (sameAlready) {
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
      if (a[f] != null && String(a[f]).trim() && String(a[f]) !== String(pl[f] ?? "")) {
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

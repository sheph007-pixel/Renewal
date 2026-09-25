// Proposal audit: two models from two different companies, Claude and
// ChatGPT, each independently read the carrier's own document and check every
// plan the portal stored from it. Each auditor must:
//   - count the plans on the document: every option found, the EPO plans
//     left out on purpose (Kennion offers PPO only), and the PPO plans that
//     remain - the number the database and the grid are held to;
//   - read all four tier rates off the document for every stored plan,
//     itself - the server compares them to the database in code, so a rate
//     an auditor did not happen to notice is still checked;
//   - report every other value the document contradicts.
// The audit passes only when BOTH models ran, both confirmed every plan's
// rates, both counts equal the database, and neither has a finding. A model
// that is off, failed or skipped a plan leaves the audit pending - never a
// pass on one model's word. Each audit records the exact reading it checked
// (`version`), so a later change to the plans makes it stale on its own.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import https from "node:https";
import { prepareForModel } from "./intake.js";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/** The API's page ceiling for the 1M-context model this audits with. */
const MAX_PDF_PAGES = 600;

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

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "plan_appearances", "plans_found_total", "epo_excluded", "document_plan_count", "duplicates_found", "rate_confirmations", "mismatches", "notes"],
  properties: {
    plan_appearances: { type: "integer", description: "How many times medical plans appear on the document in total - one plan on four pages is four appearances." },
    plans_found_total: { type: "integer", description: "Every DISTINCT plan option the document prices, EPO plans included, across every page and grid. A plan printed on several pages counts once." },
    duplicates_found: { type: "boolean", description: "True if the stored list holds the same carrier plan more than once." },
    epo_excluded: { type: "integer", description: "How many of those are EPO plans (Kennion offers PPO only, so these are left out of the portal on purpose)." },
    document_plan_count: { type: "integer", description: "plans_found_total minus epo_excluded: the plans the portal should hold." },
    rate_confirmations: {
      type: "array",
      description: "One entry for EVERY stored plan, by its index: whether it is on the document; whether the stored name and plan code are exactly as printed; whether the stored benefit values are this plan's own (not another plan's); and its four monthly tier rates read off the document yourself (not copied from the stored values) from this plan's own rate row. null for a tier the document does not price.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "on_document", "name_exact", "code_exact", "benefits_belong", "EE", "ES", "EC", "FAM"],
        properties: {
          index: { type: "integer" },
          on_document: { type: "boolean" },
          name_exact: { type: "boolean" },
          code_exact: { type: "boolean", description: "True also when neither the document nor the stored plan has a code." },
          benefits_belong: { type: "boolean" },
          EE: nullableNumber,
          ES: nullableNumber,
          EC: nullableNumber,
          FAM: nullableNumber,
        },
      },
    },
    verdict: { type: "string", enum: ["pass", "issues", "unreadable"], description: "pass when every stored value matches the document; issues when any does not; unreadable when the document cannot be checked." },
    mismatches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["plan", "field", "stored", "on_document"],
        properties: {
          plan: { type: "string", description: "The stored plan's name." },
          field: { type: "string", description: "Which value: name, plan_code, network, deductible, oop_max, rate EE, rate ES, rate EC, rate FAM, benefit <name>, or missing_plan / extra_plan." },
          stored: { type: "string", description: "What the portal has." },
          on_document: { type: "string", description: "What the document prints, or 'not on document'." },
        },
      },
    },
    notes: { type: "string", description: "One or two sentences: what was checked and anything worth a human look. Empty when clean." },
  },
};

const INSTRUCTIONS = `You are auditing a benefits portal's stored reading of a carrier's proposal against the proposal document itself - the document is the source of truth. The stored plans are given as a numbered JSON list: for each, its index, the portal's own ID, the exact name, plan code, network, plan type, deductible, out-of-pocket maximum, the monthly composite rates by tier (EE employee only, ES employee + spouse, EC employee + children, FAM family), the benefit figures the portal shows to the employer, and the pages the portal says each came from. You also get the portal's plan-count reconciliation and the EPO plans it left out on purpose. You audit on your own: no other auditor's result is given to you.

1. Count the plans on the document: every appearance (plan_appearances), every distinct plan option it prices across every page and grid (plans_found_total), how many of those are EPO plans (epo_excluded), and the rest (document_plan_count). A plan printed on several pages is one plan. The EPO plans listed as excluded are left out on purpose - they are not missing.

2. For EVERY stored plan, by index, find it on the document and confirm it (rate_confirmations): is the stored name exactly as printed, is the plan code exactly as printed, are the stored benefit values this plan's own, and read its four tier rates off the page yourself from this plan's own rate row - do not copy the stored rates. If a stored plan is not on the document, set on_document false. Use null only for a tier the document does not price for that plan. Set duplicates_found if the stored list holds one carrier plan twice.

3. Check every other stored value against the document. A value matches when it is the same figure or the same wording allowing for formatting ($1,500 vs 1500; "Choice Plus" vs "UHC Choice Plus"). Report a mismatch for each stored value the document contradicts. Kennion offers PPO plans only, so an EPO plan printed on the document is left out of the portal on purpose: never report one as extra_plan, and never expect one to be stored. The portal is meant to store every non-EPO option the document prices: report each one it is missing (field extra_plan, the plan's printed name in on_document, "not stored" in stored).

Names: the stored name should be the plan's name exactly as printed. A stored name that is the printed name with a placement label appended by the portal - "(headline option 2)", "(PPO alternate 32)" - is not a mismatch; mention it in the notes. Any other difference in the name is a mismatch. Ignore values the portal stores as null or empty, apart from rates. Never guess: if a page is unreadable say so in the notes and use verdict unreadable only when nothing can be checked.`;

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
 * The exact reading an audit checked: a hash of every stored plan's values.
 * An audit is only good for the reading it names - a correction or a re-read
 * changes the hash, and the old audit no longer counts.
 */
export function readingVersion(extracted) {
  return crypto.createHash("sha256").update(JSON.stringify(valuesFor(extracted))).digest("hex").slice(0, 16);
}

const RATE_TIERS = ["EE", "ES", "EC", "FAM"];
const sameRate = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);

/**
 * One model's answer, checked in code: every stored plan must have a rate
 * confirmation, and each confirmed rate is compared to the database here -
 * a difference is a finding whether or not the model reported it.
 */
export function shape(who, r, stored) {
  const modelVerdict = ["pass", "issues", "unreadable"].includes(r && r.verdict) ? r.verdict : "unreadable";
  const mismatches = Array.isArray(r && r.mismatches)
    ? r.mismatches.slice(0, 80).map((m) => ({ plan: String(m.plan || ""), field: String(m.field || ""), stored: String(m.stored ?? ""), onDocument: String(m.on_document ?? "") }))
    : [];
  const seen = new Set(mismatches.map((m) => `${m.plan}|${m.field}`.toLowerCase()));
  const conf = new Map((Array.isArray(r && r.rate_confirmations) ? r.rate_confirmations : []).filter((c) => Number.isInteger(c.index)).map((c) => [c.index, c]));
  let confirmed = 0;
  stored.forEach((pl, i) => {
    const c = conf.get(i);
    if (!c) return;
    confirmed++;
    if (c.on_document === false) {
      if (!seen.has(`${pl.name}|missing_plan`.toLowerCase())) mismatches.push({ plan: pl.name, field: "missing_plan", stored: "stored", onDocument: "not on document" });
      return;
    }
    // Identity and pairing, confirmed plan by plan: a "no" is a finding
    // whether or not the auditor also listed it.
    const flag = (ok, field, stored, onDoc) => {
      if (ok !== false) return;
      const key = `${pl.name}|${field}`.toLowerCase();
      if ([...seen].some((k) => k.startsWith(`${pl.name}|`.toLowerCase()) && k.includes(field.split(" ")[0]))) return;
      seen.add(key);
      mismatches.push({ plan: pl.name, field, stored, onDocument: onDoc });
    };
    flag(c.name_exact, "name", pl.name, "not exactly as printed");
    flag(c.code_exact, "plan_code", pl.plan_code || "", "not exactly as printed");
    flag(c.benefits_belong, "benefits", "stored benefits", "belong to another plan or differ from this plan's own");
    for (const t of RATE_TIERS) {
      const st = pl.rates ? pl.rates[t] : null;
      if (sameRate(c[t], st)) continue;
      const key = `${pl.name}|rate ${t}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      mismatches.push({ plan: pl.name, field: `rate ${t}`, stored: st == null ? "" : String(st), onDocument: c[t] == null ? "not priced" : String(c[t]) });
    }
  });
  if (r && r.duplicates_found === true) mismatches.push({ plan: "(stored list)", field: "duplicate_plan", stored: "a plan stored twice", onDocument: "one plan" });
  const int = (v) => (Number.isInteger(v) ? v : null);
  const verdict = modelVerdict === "unreadable" ? "unreadable" : confirmed < stored.length ? "incomplete" : mismatches.length || modelVerdict === "issues" ? "issues" : "pass";
  return {
    model: who,
    verdict,
    planAppearances: int(r && r.plan_appearances),
    plansFoundTotal: int(r && r.plans_found_total),
    epoExcluded: int(r && r.epo_excluded),
    documentPlanCount: int(r && r.document_plan_count),
    confirmed,
    of: stored.length,
    mismatches,
    notes: String((r && r.notes) || "").slice(0, 1500) + (verdict === "incomplete" ? ` Confirmed the rates of ${confirmed} of ${stored.length} plans.` : ""),
  };
}

const auditPayload = (stored, extracted, version, sourceSha) => {
  const x = extracted || {};
  return [
    `Proposal version: document ${sourceSha || "?"}, reading ${version}.`,
    `The portal's plan-count reconciliation: ${JSON.stringify(x.reconciliation || null)}`,
    `EPO plans left out on purpose (Kennion offers PPO only; not missing): ${JSON.stringify((x.excluded || []).map((e) => ({ name: e.name, plan_code: e.plan_code, pages: e.source ? [...new Set([...(e.source.identity || []), ...(e.source.rates || [])])] : [] })))}`,
    `The stored plans:\n${JSON.stringify(stored.map((pl, index) => ({ index, ...pl })), null, 1)}`,
    "Audit every stored plan against the document.",
  ].join("\n\n");
};

async function claudeCheck({ filename, prepared, stored, payload }) {
  // Audits run several at a time against the same org-wide tokens-per-minute
  // budget the proposal reader shares - stretch the SDK's built-in backoff so
  // a burst retries instead of failing the audit outright.
  const client = apiKey() ? new Anthropic({ apiKey: apiKey(), maxRetries: 3, timeout: 10 * 60 * 1000 }) : new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  const content = [];
  if (prepared.kind === "pdf") {
    const { numpages } = await pdfParse(prepared.buffer).catch(() => ({ numpages: 0 }));
    if (numpages > MAX_PDF_PAGES) {
      throw new Error(`This proposal is ${numpages} pages - too long for the model to audit (limit ${MAX_PDF_PAGES}).`);
    }
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: prepared.buffer.toString("base64") }, title: filename });
  }
  else if (prepared.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: prepared.mime, data: prepared.buffer.toString("base64") } });
  else content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: prepared.text || "(empty)" }, title: filename });
  content.push({ type: "text", text: payload });
  // Streamed with room to spare: every plan's four rates come back now, and a
  // 145-plan quote's findings ran past the old 8,000-token ceiling.
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
  return shape(`Claude (${CLAUDE_MODEL})`, JSON.parse(text), stored);
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

async function chatgptCheck({ filename, prepared, stored, payload }) {
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
      return shape(`ChatGPT (${CHATGPT_MODEL()})`, JSON.parse(text), stored);
    } catch (e) {
      last = e;
      if (attempt === 2 || /HTTP 4\d\d|returned no text/.test(e.message)) break;
    }
  }
  throw last;
}

/**
 * Run both audits and combine them. `status`:
 *   pass    - both models ran, both confirmed every plan's rates, both
 *             counts equal the database, and neither has a finding;
 *   issues  - a finding (a value the document contradicts, a plan missing
 *             or extra, or a count that does not match the database);
 *   pending - no finding, but not both models' full word: one is off,
 *             failed, or skipped a plan. Never counted as a pass.
 * `version` names the reading that was checked (see readingVersion).
 */
export async function auditProposal({ filename, mime, buffer, extracted, sourceSha = null }) {
  const stored = storedFor(extracted);
  const completedAt = new Date().toISOString();
  const version = readingVersion(extracted);
  const payload = auditPayload(stored, extracted, version, sourceSha);
  const storedCount = offeredCount(extracted);
  if (!stored.length) return { completedAt, status: "pending", models: [], mismatches: [], notes: "No plans stored to check.", version, counts: { stored: 0 } };
  let models;
  if (fakeAi()) {
    const epo = Array.isArray(extracted && extracted.excluded) ? extracted.excluded.length : 0;
    const canned = (name) => shape(name, { verdict: "pass", plan_appearances: storedCount + epo, plans_found_total: storedCount + epo, epo_excluded: epo, document_plan_count: storedCount, duplicates_found: false, rate_confirmations: stored.map((pl, index) => ({ index, on_document: true, name_exact: true, code_exact: true, benefits_belong: true, ...(pl.rates || {}) })), mismatches: [], notes: "Canned audit (KENNION_FAKE_AI)." }, stored);
    models = [canned("Claude (canned)"), canned("ChatGPT (canned)")];
  } else {
    const prepared = await prepareForModel({ filename, mime, buffer });
    models = await Promise.all([
      apiKey() || process.env.ANTHROPIC_AUTH_TOKEN
        ? claudeCheck({ filename, prepared, stored, payload }).catch((e) => ({ model: `Claude (${CLAUDE_MODEL})`, verdict: "error", mismatches: [], notes: e.message }))
        : Promise.resolve({ model: "Claude", verdict: "off", mismatches: [], notes: "No Anthropic key." }),
      chatgptKey()
        ? chatgptCheck({ filename, prepared, stored, payload }).catch((e) => ({ model: `ChatGPT (${CHATGPT_MODEL()})`, verdict: "error", mismatches: [], notes: e.message }))
        : Promise.resolve({ model: "ChatGPT", verdict: "off", mismatches: [], notes: "No ChatGPT key." }),
    ]);
  }
  const mismatches = models.flatMap((m) => (m.mismatches || []).map((x) => ({ ...x, by: m.model })));
  // The plan count, held to the database by each model that gave one.
  for (const m of models) {
    if (m.documentPlanCount != null && m.documentPlanCount !== storedCount) {
      mismatches.push({ plan: "(whole document)", field: "plan_count", stored: String(storedCount), onDocument: `${m.documentPlanCount} (${m.plansFoundTotal ?? "?"} found, ${m.epoExcluded ?? "?"} EPO excluded)`, by: m.model });
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
  return { completedAt, status, models, mismatches, notes, version, sourceSha, counts, documentPlanCount: both && !mismatches.length ? storedCount : null };
}

const TIERS = ["EE", "ES", "EC", "FAM"];
const isEpo = (pl) => /\bEPO\b/i.test(`${pl.network || ""} ${pl.plan_type || pl.planType || ""} ${pl.name || ""}`);
const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
/** The key two stored plans share when they are the same plan printed twice: name and the four rates. */
export const planKey = (pl) => `${normName(pl.name)}|${TIERS.map((t) => (pl.rates && pl.rates[t] != null ? pl.rates[t] : "")).join(",")}`;
/** How many distinct offered (non-EPO) plans a reading stores - the figure the document's count is held to. */
export function offeredCount(extracted) {
  const plans = Array.isArray(extracted && extracted.plans) ? extracted.plans : [];
  const keys = new Set();
  for (const pl of plans) {
    if (!pl || isEpo(pl) || !String(pl.name || "").trim()) continue;
    keys.add(planKey(pl));
  }
  return keys.size;
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
  return ["doctor_visit", "specialist", "imaging", "urgent_care", "emergency_room", "hospital", "rx", "coinsurance", "hsa_eligible"];
}

const CORRECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document_plan_count", "fixes", "add", "remove", "unpriced", "notes"],
  properties: {
    document_plan_count: { type: "integer", description: "Distinct non-EPO plan options the document prices, each plan counted once however many pages it is on." },
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
    add: { type: "array", description: "Every non-EPO plan the document prices that the stored list is missing, in full.", items: PLAN_ITEM },
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

Do not take a finding's proposed value on trust - the auditors can be wrong. For each finding and each conflict, find that exact plan on the document by its printed name and plan code, read the value from that plan's own benefit or rate table, and return a fix with the value exactly as printed (and the page you read it from), or stored_is_correct. Never take a value from a different plan, however similar it looks. Read each missing tier rate off the document: return it as a fix, or list it under unpriced when the document really does not price that tier for that plan. Add, in full, every non-EPO plan the document prices that the stored list lacks (Kennion offers PPO plans only: never add an EPO plan), with the pages it is on. Remove a stored plan only when it is not on the document at all or is the same carrier plan stored twice. A stored plan that IS on the document under a different printed name (a placement label added, a typo) is corrected with a fix on its name - never removed and added back. Count the distinct non-EPO plan options the document prices. Never guess: a value you cannot read on the page is left alone.`;

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

const BENEFIT_FIELDS = BENEFIT_FIELDS_LIST();
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
  const have = new Set(kept.map((pl) => `${String(pl.plan_code || "").trim().toUpperCase()}|${normName(pl.name)}`));
  for (const a of c.add || []) {
    if (!a || !String(a.name || "").trim() || isEpo(a)) continue;
    if (codeOf(a) && kept.some((pl) => codeOf(pl) === codeOf(a))) continue;
    const key = `${String(a.plan_code || "").trim().toUpperCase()}|${normName(a.name)}`;
    if (have.has(key)) continue;
    const sp = a.source_pages || {};
    const m = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((p) => mapPage(p, pageMap)).filter(Boolean))].sort((x, y) => x - y);
    const { source_pages, ...plan } = a;
    const added = { ...plan, source: { identity: m(sp.identity), benefits: m(sp.benefits), rates: m(sp.rates), sheet: "", rows: "", appearances: 1, codes: a.plan_code ? [String(a.plan_code).trim().toUpperCase()] : [] } };
    kept.push(added);
    have.add(key);
    entry(added, "plan", "missing", "added from the document", added.source.rates[0] || added.source.identity[0] || null, "On the document but not stored.");
  }
  // Keep the reconciliation in step: the plans stored now are the plans expected.
  let reconciliation = extracted && extracted.reconciliation ? { ...extracted.reconciliation } : null;
  if (reconciliation) {
    if (drop.size || kept.length !== plans.length) reconciliation = { ...reconciliation, unique_ppo: kept.length, expected: kept.length, unique_plans: kept.length + (reconciliation.unique_epo || 0) };
    // The corrector's own count of the document replaces the reader's: a
    // reader that listed one plan twice (merged, correctly, into one) no
    // longer holds the count out of step once the source has been re-counted.
    if (Number.isInteger(c.document_plan_count)) reconciliation.reader_unique_plans = c.document_plan_count + (reconciliation.unique_epo || 0);
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

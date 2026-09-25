// Proposal audit: two models, Claude and ChatGPT, each independently read
// the carrier's own document and check every plan the portal stored from it - 
// name, code, network, deductible, out-of-pocket max, the four tier rates - 
// against what is printed. Both must find nothing wrong for the audit to
// pass. It runs once when a proposal is read (and again on demand), and the
// result rides with the proposal so the client's plan cards can say the
// figures were checked and when; the document itself stays with staff.
import Anthropic from "@anthropic-ai/sdk";
import { prepareForModel } from "./intake.js";
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

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "document_plan_count", "mismatches", "notes"],
  properties: {
    document_plan_count: {
      type: "integer",
      description:
        "How many distinct plan options the document prices, counted across every page - headline, alternate, illustrative and benchmark grids alike - leaving out EPO plans (Kennion offers PPO only). A plan printed twice at the same rates (in a summary and again on its own page) counts once.",
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

const INSTRUCTIONS = `You are auditing a benefits portal's stored reading of a carrier's proposal against the proposal document itself. The stored plans are given as JSON: for each, the name, plan code, network, plan type, deductible, out-of-pocket maximum, the monthly composite rates by tier (EE employee only, ES employee + spouse, EC employee + children, FAM family) and the benefit figures the portal shows to the employer.

Names: the stored name should be the plan's name exactly as printed. A stored name that is the printed name with a placement label appended by the portal - "(headline option 2)", "(PPO alternate 32)", "(Essential PDL alternate 30)" - is not a mismatch; mention it in the notes as "name carries a placement label" so staff can re-read the proposal for the exact name. Any other difference in the name is a mismatch.

First count the distinct plan options the document prices (document_plan_count): every page, every grid, EPO plans left out, a plan printed twice at the same rates counted once.

Check every stored plan against the document, value by value. A value matches when it is the same figure or the same wording allowing for formatting ($1,500 vs 1500; "Choice Plus" vs "UHC Choice Plus"). Report a mismatch for each stored value that the document contradicts, and for a stored plan you cannot find on the document at all (field missing_plan). Kennion offers PPO plans only, so an EPO plan printed on the document is left out of the portal on purpose: never report one as extra_plan, and never expect one to be stored. The portal is meant to store every non-EPO option the document prices: report each one it is missing (field extra_plan, the plan's printed name in on_document, "not stored" in stored). Ignore values the portal stores as null or empty. Never guess: if a page is unreadable say so in the notes and use verdict unreadable only when nothing can be checked.`;

const storedFor = (extracted) => {
  const plans = Array.isArray(extracted && extracted.plans) ? extracted.plans : [];
  return plans.map((pl) => ({
    name: pl.name,
    plan_code: pl.plan_code || null,
    network: pl.network || null,
    plan_type: pl.plan_type || null,
    deductible: pl.deductible || null,
    oop_max: pl.oop_max || null,
    rates: pl.rates || null,
    benefits: pl.benefits || null,
  }));
};

const shape = (who, r) => ({
  model: who,
  verdict: ["pass", "issues", "unreadable"].includes(r && r.verdict) ? r.verdict : "unreadable",
  documentPlanCount: Number.isInteger(r && r.document_plan_count) ? r.document_plan_count : null,
  mismatches: Array.isArray(r && r.mismatches)
    ? r.mismatches.slice(0, 60).map((m) => ({ plan: String(m.plan || ""), field: String(m.field || ""), stored: String(m.stored ?? ""), onDocument: String(m.on_document ?? "") }))
    : [],
  notes: String((r && r.notes) || "").slice(0, 1500),
});

async function claudeCheck({ filename, prepared, stored }) {
  // Audits run several at a time (AUDIT_PARALLEL) against the same org-wide
  // tokens-per-minute budget the proposal reader shares - stretch the SDK's
  // built-in backoff so a burst retries instead of failing the audit
  // outright, but bound each attempt so a stalled connection can't tie up
  // one of those slots for the SDK's default 10 minutes per retry.
  const client = apiKey() ? new Anthropic({ apiKey: apiKey(), maxRetries: 3, timeout: 6 * 60 * 1000 }) : new Anthropic({ maxRetries: 3, timeout: 6 * 60 * 1000 });
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
  content.push({ type: "text", text: `The stored plans:\n${JSON.stringify(stored, null, 1)}\n\nCheck them against the document.` });
  // Streamed with room to spare: a 145-plan quote's findings ran past the
  // old 8,000-token ceiling and came back as cut-off JSON ("Unexpected end
  // of JSON input" on Lewis Communications' fully insured quote).
  const response = await client.messages
    .stream({
      model: CLAUDE_MODEL,
      max_tokens: 32000,
      output_config: { effort: "high", format: { type: "json_schema", schema: RESULT_SCHEMA } },
      system: INSTRUCTIONS,
      messages: [{ role: "user", content }],
    })
    .finalMessage();
  if (response.stop_reason === "refusal") throw new Error("Claude declined the check.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's findings ran past one answer.");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return shape(`Claude (${CLAUDE_MODEL})`, JSON.parse(text));
}

async function chatgptCheck({ filename, prepared, stored }) {
  const parts = [];
  if (prepared.kind === "pdf") parts.push({ type: "file", file: { filename, file_data: `data:application/pdf;base64,${prepared.buffer.toString("base64")}` } });
  else if (prepared.kind === "image") parts.push({ type: "image_url", image_url: { url: `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}` } });
  else parts.push({ type: "text", text: `The document (${filename}):\n${prepared.text || "(empty)"}` });
  parts.push({ type: "text", text: `The stored plans:\n${JSON.stringify(stored, null, 1)}\n\nCheck them against the document.` });
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatgptKey()}` },
    body: JSON.stringify({
      model: CHATGPT_MODEL(),
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: parts },
      ],
      response_format: { type: "json_schema", json_schema: { name: "proposal_audit", strict: true, schema: RESULT_SCHEMA } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ChatGPT (${CHATGPT_MODEL()}): ${(j.error && j.error.message) || r.statusText}`);
  const text = j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || "") : "";
  if (!text) throw new Error("ChatGPT returned no text.");
  return shape(`ChatGPT (${CHATGPT_MODEL()})`, JSON.parse(text));
}

/**
 * Run both checks and combine them. `status`: pass when every model that ran
 * found nothing wrong and at least one ran; issues when any mismatch was
 * found; unreadable when nothing could be checked. A model that is not
 * configured or that failed is recorded as such, never counted as a pass.
 */
export async function auditProposal({ filename, mime, buffer, extracted }) {
  const stored = storedFor(extracted);
  const completedAt = new Date().toISOString();
  if (!stored.length) return { completedAt, status: "unreadable", models: [], mismatches: [], notes: "No plans stored to check." };
  if (fakeAi()) {
    const models = [
      { model: "Claude (canned)", verdict: "pass", mismatches: [], notes: "Canned audit (KENNION_FAKE_AI)." },
      { model: "ChatGPT (canned)", verdict: "pass", mismatches: [], notes: "Canned audit (KENNION_FAKE_AI)." },
    ];
    return { completedAt, status: "pass", models, mismatches: [], notes: "", documentPlanCount: offeredCount(extracted) };
  }
  const prepared = await prepareForModel({ filename, mime, buffer });
  const runs = [];
  if (apiKey() || process.env.ANTHROPIC_AUTH_TOKEN) runs.push(claudeCheck({ filename, prepared, stored }).catch((e) => ({ model: `Claude (${CLAUDE_MODEL})`, verdict: "error", mismatches: [], notes: e.message })));
  else runs.push(Promise.resolve({ model: "Claude", verdict: "off", mismatches: [], notes: "No Anthropic key." }));
  if (chatgptKey()) runs.push(chatgptCheck({ filename, prepared, stored }).catch((e) => ({ model: `ChatGPT (${CHATGPT_MODEL()})`, verdict: "error", mismatches: [], notes: e.message })));
  else runs.push(Promise.resolve({ model: "ChatGPT", verdict: "off", mismatches: [], notes: "No ChatGPT key." }));
  const models = await Promise.all(runs);
  const ran = models.filter((m) => m.verdict === "pass" || m.verdict === "issues");
  const mismatches = models.flatMap((m) => m.mismatches.map((x) => ({ ...x, by: m.model })));
  // The plan count: Claude's, the model this portal reads with; ChatGPT's
  // when Claude's is missing. Two counts that differ are a finding of their
  // own, for the correction step to settle against the document.
  const counts = ran.map((m) => m.documentPlanCount).filter((n) => n != null);
  const documentPlanCount = counts.length ? counts[0] : null;
  if (counts.length > 1 && counts.some((n) => n !== counts[0])) {
    mismatches.push({ plan: "(whole document)", field: "plan_count", stored: String(offeredCount(extracted)), onDocument: ran.map((m) => `${m.model.replace(/\s*\(.*\)$/, "")} counts ${m.documentPlanCount}`).join(", "), by: "both" });
  }
  const status = mismatches.length ? "issues" : ran.length ? "pass" : "unreadable";
  const notes = models
    .filter((m) => m.notes)
    .map((m) => `${m.model}: ${m.notes}`)
    .join(" ");
  return { completedAt, status, models, mismatches, notes, documentPlanCount };
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

const PLAN_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["name", "plan_code", "network", "plan_type", "deductible", "oop_max", "benefits", "rates", "monthly_total"],
  properties: {
    name: { type: "string" },
    plan_code: { anyOf: [{ type: "string" }, { type: "null" }] },
    network: { anyOf: [{ type: "string" }, { type: "null" }] },
    plan_type: { anyOf: [{ type: "string" }, { type: "null" }] },
    deductible: { anyOf: [{ type: "string" }, { type: "null" }] },
    oop_max: { anyOf: [{ type: "string" }, { type: "null" }] },
    benefits: {
      type: "object",
      additionalProperties: false,
      required: ["doctor_visit", "specialist", "imaging", "urgent_care", "hospital", "rx"],
      properties: { doctor_visit: { type: "string" }, specialist: { type: "string" }, imaging: { type: "string" }, urgent_care: { type: "string" }, hospital: { type: "string" }, rx: { type: "string" } },
    },
    rates: {
      type: "object",
      additionalProperties: false,
      required: ["EE", "ES", "EC", "FAM"],
      properties: { EE: { anyOf: [{ type: "number" }, { type: "null" }] }, ES: { anyOf: [{ type: "number" }, { type: "null" }] }, EC: { anyOf: [{ type: "number" }, { type: "null" }] }, FAM: { anyOf: [{ type: "number" }, { type: "null" }] } },
    },
    monthly_total: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
};

const CORRECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document_plan_count", "fixes", "add", "remove", "unpriced", "notes"],
  properties: {
    document_plan_count: { type: "integer", description: "Distinct non-EPO plan options the document prices, each printed-twice plan counted once." },
    fixes: {
      type: "array",
      description: "One entry per finding you were given (and any other wrong value you notice), after checking it against the document.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "field", "verdict", "value"],
        properties: {
          index: { type: "integer", description: "The stored plan's index in the list you were given." },
          field: { type: "string", enum: ["name", "plan_code", "network", "plan_type", "deductible", "oop_max", "EE", "ES", "EC", "FAM", "doctor_visit", "specialist", "imaging", "urgent_care", "hospital", "rx"] },
          verdict: { type: "string", enum: ["fix", "stored_is_correct"], description: "fix when the document prints something else; stored_is_correct when the finding was wrong." },
          value: { type: "string", description: "The value exactly as the document prints it (a rate as a plain number, e.g. 612.45). Empty for stored_is_correct." },
        },
      },
    },
    add: { type: "array", description: "Every non-EPO plan the document prices that the stored list is missing, in full.", items: PLAN_ITEM },
    remove: { type: "array", description: "Indexes of stored plans that are not on the document at all, or are an exact repeat of another stored plan.", items: { type: "integer" } },
    unpriced: {
      type: "array",
      description: "Stored plans with an empty tier rate that the document genuinely does not price for that tier.",
      items: { type: "object", additionalProperties: false, required: ["index", "tier"], properties: { index: { type: "integer" }, tier: { type: "string", enum: TIERS } } },
    },
    notes: { type: "string" },
  },
};

const CORRECTION_INSTRUCTIONS = `You correct a benefits portal's stored reading of a carrier's proposal so that it matches the proposal document exactly. You are given the document, the stored plans as a numbered list, the findings two independent auditors reported, and the tier rates the portal is missing.

Check every finding against the document yourself - the auditors can be wrong. For each, return a fix with the value exactly as printed, or stored_is_correct. Read each missing tier rate off the document: return it as a fix, or list it under unpriced when the document really does not price that tier for that plan. Add, in full, every non-EPO plan the document prices that the stored list lacks (Kennion offers PPO plans only: never add an EPO plan). Remove a stored plan only when it is not on the document at all or is an exact repeat of another stored plan. Count the distinct non-EPO plan options the document prices. Never guess: a value you cannot read on the page is left alone.`;

/**
 * Ask Claude to settle an audit's findings against the document. Returns the
 * structured correction; `applyCorrection` turns it into a new reading.
 */
export async function correctProposal({ filename, mime, buffer, extracted, mismatches, missingRates }) {
  if (fakeAi()) return { document_plan_count: offeredCount(extracted), fixes: [], add: [], remove: [], unpriced: [], notes: "Canned correction (KENNION_FAKE_AI)." };
  const prepared = await prepareForModel({ filename, mime, buffer });
  const client = apiKey() ? new Anthropic({ apiKey: apiKey(), maxRetries: 3, timeout: 10 * 60 * 1000 }) : new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  const content = [];
  if (prepared.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: prepared.buffer.toString("base64") }, title: filename });
  else if (prepared.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: prepared.mime, data: prepared.buffer.toString("base64") } });
  else content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: prepared.text || "(empty)" }, title: filename });
  const numbered = storedFor(extracted).map((pl, index) => ({ index, ...pl }));
  content.push({
    type: "text",
    text: `The stored plans:\n${JSON.stringify(numbered, null, 1)}\n\nThe auditors' findings:\n${JSON.stringify(mismatches || [], null, 1)}\n\nTier rates the portal is missing (index, tier):\n${JSON.stringify(missingRates || [])}\n\nCorrect the stored reading against the document.`,
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
  return out;
}

const BENEFIT_FIELDS = ["doctor_visit", "specialist", "imaging", "urgent_care", "hospital", "rx"];
const moneyNumber = (v) => {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Apply a correction to a reading. Pure: returns the new extracted and a log
 * of every change (plan, field, from, to), so what the AI changed is always
 * on the row. Option IDs ride with the plans they belong to; a removed plan's
 * number is retired by the numbering step as usual.
 */
export function applyCorrection(extracted, c) {
  const plans = (Array.isArray(extracted && extracted.plans) ? extracted.plans : []).map((pl) => ({ ...pl, rates: { ...(pl.rates || {}) }, benefits: pl.benefits ? { ...pl.benefits } : pl.benefits }));
  const log = [];
  for (const f of c.fixes || []) {
    if (f.verdict !== "fix") continue;
    const pl = plans[f.index];
    if (!pl) continue;
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
    if (String(from ?? "") !== String(to ?? "")) log.push({ plan: pl.name, field: f.field, from: from ?? null, to });
  }
  for (const u of c.unpriced || []) {
    const pl = plans[u.index];
    if (!pl || !TIERS.includes(u.tier) || pl.rates[u.tier] != null) continue;
    pl.unpriced = [...new Set([...(pl.unpriced || []), u.tier])];
    log.push({ plan: pl.name, field: u.tier, from: null, to: "not priced on the document" });
  }
  const drop = new Set((c.remove || []).filter((i) => Number.isInteger(i) && plans[i]));
  for (const i of drop) log.push({ plan: plans[i].name, field: "plan", from: "stored", to: "removed - not on the document" });
  const kept = plans.filter((_, i) => !drop.has(i));
  const have = new Set(kept.map(planKey));
  for (const a of c.add || []) {
    if (!a || !String(a.name || "").trim() || isEpo(a) || have.has(planKey(a))) continue;
    kept.push({ ...a });
    have.add(planKey(a));
    log.push({ plan: a.name, field: "plan", from: "missing", to: "added from the document" });
  }
  return { extracted: { ...(extracted || {}), plans: kept }, log };
}

/** What a client's page is told: the outcome and when - never the notes, never which models. */
export function auditForClient(a) {
  if (!a || !a.status) return null;
  return { status: a.status, completedAt: a.completedAt };
}

// Proposal audit: two models, Claude and ChatGPT, each independently read
// the carrier's own document and check every plan the portal stored from it - 
// name, code, network, deductible, out-of-pocket max, the four tier rates - 
// against what is printed. Both must find nothing wrong for the audit to
// pass. It runs once when a proposal is read (and again on demand), and the
// result rides with the proposal so the client's plan cards can say the
// figures were checked and when; the document itself stays with staff.
import Anthropic from "@anthropic-ai/sdk";
import { prepareForModel } from "./intake.js";

const apiKey = () => process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE || "";
const fakeAi = () => process.env.KENNION_FAKE_AI === "1";
const chatgptKey = () => process.env.CHATGPT_API_KEY || process.env.ChatGPT || process.env.CHATGPT || process.env.OPENAI_API_KEY || "";
const CHATGPT_MODEL = () => process.env.CHATGPT_MODEL || "gpt-5";
const CLAUDE_MODEL = "claude-opus-5";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "mismatches", "notes"],
  properties: {
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

Check every stored plan against the document, value by value. A value matches when it is the same figure or the same wording allowing for formatting ($1,500 vs 1500; "Choice Plus" vs "UHC Choice Plus"). Report a mismatch for each stored value that the document contradicts, and for a stored plan you cannot find on the document at all (field missing_plan). Kennion offers PPO plans only, so an EPO plan printed on the document is left out of the portal on purpose: never report one as extra_plan, and never expect one to be stored. Do not report any other plan the document has that the portal does not store unless the portal claims to have every option (field extra_plan, at most three examples). Ignore values the portal stores as null or empty. Never guess: if a page is unreadable say so in the notes and use verdict unreadable only when nothing can be checked.`;

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
  mismatches: Array.isArray(r && r.mismatches)
    ? r.mismatches.slice(0, 60).map((m) => ({ plan: String(m.plan || ""), field: String(m.field || ""), stored: String(m.stored ?? ""), onDocument: String(m.on_document ?? "") }))
    : [],
  notes: String((r && r.notes) || "").slice(0, 1500),
});

async function claudeCheck({ filename, prepared, stored }) {
  const client = apiKey() ? new Anthropic({ apiKey: apiKey() }) : new Anthropic();
  const content = [];
  if (prepared.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: prepared.buffer.toString("base64") }, title: filename });
  else if (prepared.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: prepared.mime, data: prepared.buffer.toString("base64") } });
  else content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: prepared.text || "(empty)" }, title: filename });
  content.push({ type: "text", text: `The stored plans:\n${JSON.stringify(stored, null, 1)}\n\nCheck them against the document.` });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    output_config: { effort: "high", format: { type: "json_schema", schema: RESULT_SCHEMA } },
    system: INSTRUCTIONS,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined the check.");
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
    return { completedAt, status: "pass", models, mismatches: [], notes: "" };
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
  const status = mismatches.length ? "issues" : ran.length ? "pass" : "unreadable";
  const notes = models
    .filter((m) => m.notes)
    .map((m) => `${m.model}: ${m.notes}`)
    .join(" ");
  return { completedAt, status, models, mismatches, notes };
}

/** What a client's page is told: the outcome and when - never the notes, never which models. */
export function auditForClient(a) {
  if (!a || !a.status) return null;
  return { status: a.status, completedAt: a.completedAt };
}

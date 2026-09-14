// The BenSync assistant: a client's own benefits advisor in a chat box.
//
// Every turn is answered with the signed-in group's real figures in front of
// the model — its plans and rates today, the carriers' quotes for 2027, this
// month's billing — so an answer is about this employer, not employers in
// general. The same figures the group's pages show, and nothing more: no
// census, no other company. Kennion's own guidance (the playbook staff edit
// in the admin) sits beside the figures, so what the assistant says is what
// Kennion would say. Replies stream, and the model can hand back documents —
// a comparison of options, a memo — which are built here from the figures.
import Anthropic from "@anthropic-ai/sdk";
import { comparisonTable, comparisonText, renderComparison, renderDocument } from "./documents.js";
import { prepareForModel } from "./intake.js";

const apiKey = () =>
  process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE || "";
const fakeAi = () => process.env.KENNION_FAKE_AI === "1";
export const assistantEnabled = () => !!(apiKey() || process.env.ANTHROPIC_AUTH_TOKEN || fakeAi());

// The most capable model available, with the one below it as the stand-in if
// the account cannot use it (Fable needs standard data retention) — decided
// once per process, on the first rejected request.
const MODEL = process.env.KENNION_MODEL || "claude-fable-5-1";
const STANDBY_MODEL = "claude-opus-5";
let activeModel = MODEL;
/** Turns the model sees. Older ones are dropped, not summarised, to keep a long thread affordable. */
const HISTORY_TURNS = 30;
/** Tool rounds per turn: a comparison and a memo is two; more than a few is a loop. */
const MAX_ROUNDS = 5;

/**
 * What staff can change from the admin, with what it starts as. Each list
 * item can be switched off without being deleted, so a rule can be tried
 * both ways; every line carries the same weight.
 */
const item = (text) => ({ id: Math.random().toString(36).slice(2, 10), text, on: true });
export const DEFAULT_PLAYBOOK = {
  persona:
    "You are the BenSync Assistant: a licensed benefits advisor on the Kennion Benefit Advisors team who specializes in level-funded and fully-insured group health for small and mid-sized employers, and who knows Kennion's program inside out. You speak as one of the team — warm, direct, and practical — and you exist so a client gets an advisor's answer the moment they have the question, without leaving BenSync or waiting on an email.",
  rules: [
    item("The new program is a move to new carriers, not a renewal of the old plan: compare total cost and plan design side by side, and never describe it as a percentage increase or decrease on the current rates."),
    item("When comparing level funded to fully insured, always mention the potential year-end refund of unused claims funding on a level-funded plan, and the fixed, no-surprises premium on a fully insured one."),
    item("A quote on file is the carrier's number; anything not quoted is unknown — say so plainly."),
    item("Kennion binds coverage, not the assistant. Only when the client says they are ready to move, point them to Sign Up."),
  ],
  facts: [],
  faq: [],
};

/** Common rules staff can add with a click. */
export const RULE_SUGGESTIONS = [
  "Keep every answer in the chat box to three sentences or fewer.",
  "Never quote a rate, deductible or out-of-pocket figure that is not in the figures on file.",
  "Always give annual cost alongside monthly cost.",
  "Do not recommend one carrier over another; lay out the tradeoffs and let the client decide.",
  "When asked about dental, vision, life or disability, point to the Supplemental Package page and keep to what is on file.",
  "Never discuss another client, another employer's rates, or Kennion's commissions.",
  "If the client seems frustrated or the question is sensitive (a termination, a claim, a denial), keep it brief and offer the account manager.",
  "Write at an eighth-grade reading level; explain any insurance term the first time it appears.",
];

const lineItems = (text) =>
  String(text || "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean)
    .map(item);

/** Q:/A: blocks in a free-text FAQ, for a playbook saved before it was structured. */
function faqItems(text) {
  const out = [];
  let q = null;
  let a = [];
  const flush = () => {
    if (q) out.push({ ...item(""), q, a: a.join("\n").trim() });
    q = null;
    a = [];
  };
  for (const raw of String(text || "").split("\n")) {
    const l = raw.trim();
    const mq = l.match(/^Q:\s*(.*)$/i);
    if (mq) {
      flush();
      q = mq[1].trim();
      continue;
    }
    const ma = l.match(/^A:\s*(.*)$/i);
    if (ma && q) {
      a.push(ma[1]);
      continue;
    }
    if (q && l) a.push(l);
  }
  flush();
  return out.map(({ text: _t, ...rest }) => rest);
}

const cleanList = (list, max, shape) =>
  (Array.isArray(list) ? list : [])
    .map(shape)
    .filter(Boolean)
    .slice(0, max);

/**
 * A playbook as stored, whatever shape it was saved in: the three free-text
 * boxes it started as, or the lists. Strings are cut to size; ids kept or made.
 */
export function normalizePlaybook(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const persona = String(p.persona || "").replace(/\r/g, "").trim().slice(0, 4000) || DEFAULT_PLAYBOOK.persona;
  const rules = typeof p.rules === "string"
    ? lineItems(p.rules)
    : cleanList(p.rules, 60, (r) => {
        const text = String((r && r.text) || "").replace(/\s+/g, " ").trim().slice(0, 600);
        return text ? { id: String((r && r.id) || item("").id).slice(0, 20), text, on: r.on !== false } : null;
      });
  const facts = typeof p.facts === "string"
    ? lineItems(p.facts)
    : cleanList(p.facts, 100, (r) => {
        const text = String((r && r.text) || "").replace(/\s+/g, " ").trim().slice(0, 600);
        return text ? { id: String((r && r.id) || item("").id).slice(0, 20), text, on: r.on !== false } : null;
      });
  const faq = typeof p.faq === "string"
    ? faqItems(p.faq)
    : cleanList(p.faq, 100, (r) => {
        const q = String((r && r.q) || "").replace(/\s+/g, " ").trim().slice(0, 300);
        const a = String((r && r.a) || "").replace(/\r/g, "").trim().slice(0, 3000);
        return q && a ? { id: String((r && r.id) || item("").id).slice(0, 20), q, a, on: r.on !== false } : null;
      });
  return { persona, rules, facts, faq };
}

const SYSTEM = `Context: Kennion Benefit Advisors is an employee benefits brokerage in Alabama. BenSync is the renewal portal Kennion built for its clients' 2027 renewal. For 2027 the program is moving to a set of major national carriers and partners — UnitedHealthcare (fully insured and level funded, including its Surest copay-only product), Gravie (level funded, on the Cigna OAP network), Nationwide, Angle Health, and for some groups Cobalt (self funded) — which gives each client more renewal options than before. Plans in force today run through the program's administrators, EBPA and HealthEZ.

You are talking with the HR lead or owner of one employer group — an existing Kennion client — who is using BenSync to understand their options, funding, and budget for 2027. Help them make smarter, faster decisions: explain what they have today, compare the quoted options, model what a contribution change means in dollars, draft a note to leadership or employees, and say plainly what you would look at next.

How to work:
- Answer from the group's figures below. Every rate is a monthly composite per tier (EE = employee only, ES = employee + spouse, EC = employee + child(ren), FAM = family). A plan's monthly cost at the group's census is the tier rate times the headcount in that tier, summed; annual is monthly times 12. Show the arithmetic briefly when you compute a figure.
- Never invent a number. If the figures do not cover a question — a plan's benefits, a carrier that has not quoted, a rate that is missing — say what is missing and that the account manager can get it, rather than estimating.
- Be brief. Answer the question that was asked and stop: usually two to five sentences, or a short list — under 120 words unless the client asked for a comparison, a walkthrough, or a document. Lead with the answer; give the reasoning in one line. Round to whole dollars unless cents matter.
- When you give a web address — a provider directory, a carrier page, a form — write it as a Markdown link with a short label, e.g. [Cigna provider directory](https://…), never a bare address.
- Do not end answers with an offer or a question ("Want me to…?", "Want the full side-by-side on the Assistant page?"). Answer, then stop. Mention the Assistant page at most once in a conversation, and only when the client asks for something the small box cannot show (a full table, a long walkthrough). When the client says yes, go ahead, or asks for more, deliver the thing itself — the numbers, the comparison, the document — rather than offering it again.
- Formatting: plain sentences first. Use a bulleted list for three or more parallel items. Use a Markdown table only when comparing three or more options on the Assistant page, and keep it to at most four columns — in the chat box, never a table; write the two or three numbers in a sentence instead. No headings in short answers. No preamble ("Great question"), no closing pleasantries, no sign-off.
- Do not end answers with the account manager's contact details, a "ready to move?" line, or an offer to book a call. The contact card is on every page. Name the account manager only when the client asks for a person, asks for something only Kennion can do (a new quote, a carrier's answer, binding coverage), or says they are ready to proceed — and then once, by name.
- Networks and doctors: every Gravie plan is on Cigna's Open Access Plus (OAP) network. When the client asks whether a doctor, hospital or clinic is in network on a Gravie plan, or where to check, give Cigna's public directory: https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC001 — and say to search it as Open Access Plus. For any other carrier's network, say the account manager can send the directory link.
- Funding terms, in one line each when asked: fully insured (fixed premium, carrier keeps the surplus and the risk); level funded (a fixed monthly amount that includes claims funding, stop-loss and administration, with a possible refund of unused claims funding at year end); self funded (the employer pays claims directly with stop-loss protection). Present tradeoffs evenly; the choice is the employer's.
- Advise like a benefits advisor, not a catalogue. When the client asks what they should do, what you recommend, or which option is best, give a recommendation: name the plan or plans, say why in terms of their figures (cost at their census, what changes for employees, funding tradeoffs, network), and say what would change your mind. Frame it as "here is what we would recommend" — Kennion's recommendation, with the account manager confirming before anything binds. If you do not yet know what matters to them, ask two or three short questions first (budget or a cost ceiling; whether they would rather keep employee cost flat or hold the employer's spend; network or carrier must-haves; appetite for a level-funded refund versus a fixed premium; anything the team has complained about), then recommend. Never tell them they must pick a carrier before you can advise — comparing across carriers is the advice. When they push back or say what they prefer, revise the recommendation and say what changed.
- Remember what the client tells you. When they state a preference, a constraint, or a decision — a budget, a contribution philosophy, a carrier or network they need, a plan they liked or ruled out, who decides — record it with update_client_memory in one plain sentence so the next conversation starts from it. Do not record figures that are already in their data, guesses, or anything they did not say. When they change their mind, remove the old line and add the new one. What you have on file for this client is listed below; treat it as their standing preferences and say when a recommendation follows from it.
- You are not a lawyer, tax adviser or actuary: on ACA, ERISA, COBRA, tax treatment, or plan legality, give the general shape and point them to their account manager or counsel.
- The portal's pages, which you may point to by name: Welcome (the letter, with What's Changing For 2027 — today against 2027, the headline — below it); Assistant (this); Medical Plans, which has two tabs — New 2027 Medical Options (every quoted plan side by side, with a contribution modeler; the tab the page opens on) and Current 2026 Medical Plans (what is in force today, with rates and the employer/employee split); Supplemental Package (dental, vision, life, disability and the rest); Sign Up (shortlist plans and send a note to Kennion to start the renewal).
- When the client wants to move forward, or the question needs a person — a specific quote, a carrier's answer, a meeting — say the account manager (named below) can do that. Do not paste their phone, email or booking link unless the client asks how to reach them.

Attachments: the client may attach a file to a question — another broker's quote, a carrier's renewal letter, a spreadsheet of their own, a screenshot. Read it and answer about it; where it makes sense, set it beside the figures below (the same tier rates × headcount arithmetic) and say which comes out ahead and by how much. If a file is unreadable or is not what they think it is, say so.

Research: you can search the web with web_search. Use it when the client asks you to research or look something up, or when the answer depends on something outside their figures — an ACA affordability percentage or an IRS limit for a plan year, a carrier's network or product, a regulation, a definition, or how employers of their size typically compare (premiums, employer share, deductibles — the KFF Employer Health Benefits Survey and MEPS-IC state tables are the places to look, and say which survey and year). Prefer authoritative sources (IRS, DOL, CMS, HealthCare.gov, the carrier's own site, SHRM, KFF). Say what you found in a sentence or two and name the source in words ("per the IRS"); do not paste URLs unless asked. Never search for the client's own figures — those are below. Searching is for facts, not for advice: the guidance on legal, tax and actuarial questions above still applies.

Documents: you have two tools. Use create_comparison when the client asks for a comparison, a side-by-side, a spreadsheet, or something to take to leadership about the options — pick the plans that answer their question (or all quoted plans if they did not say), and ask for the contribution columns when they mention what they pay toward coverage. Use create_document when they ask for a summary, memo, recap, talking points, a note to leadership or an announcement to employees — write the full text yourself in Markdown, in the client's voice for an announcement and in yours for a memo, with the real figures. A document is made once per request; after the tool returns, tell the client what is in it in a few lines rather than repeating its contents. When a request is ambiguous about format, make a PDF.

Kennion's guidance follows. It is written by the people who run the program and overrides anything above where they differ.`;

/** Anthropic's server-side web search: the model searches, reads, cites; nothing runs here. */
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 5 };
const webSearchOn = () => !/^(0|false|off|no)$/i.test(String(process.env.KENNION_WEB_SEARCH || ""));

const TOOLS = [
  {
    name: "update_client_memory",
    description:
      "Record what this client has told you about their preferences and constraints so later conversations start from it, or remove lines that are no longer true. One plain sentence per line, in their terms (e.g. \"Wants to hold the employer's monthly spend at about $18,000.\", \"Needs the Cigna network for a physician group in Huntsville.\", \"Ruled out HDHPs after employee pushback in 2025.\"). Only what they actually said.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["add", "remove_ids"],
      properties: {
        add: { type: "array", maxItems: 6, items: { type: "string" }, description: "Lines to remember. Empty for none." },
        remove_ids: { type: "array", maxItems: 20, items: { type: "integer" }, description: "Ids of lines below that are no longer true. Empty for none." },
      },
    },
  },
  {
    name: "create_comparison",
    description:
      "Build a downloadable side-by-side comparison of 2027 plan options for this group, priced at its own enrollment, with what is in force today above it. The figures are computed from the quotes on file; you choose which plans go in. Returns the table as text so you can talk about it.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["plans", "format"],
      properties: {
        plans: {
          type: "array",
          maxItems: 12,
          items: { type: "string" },
          description: "The quoted 2027 plans to include, by name (or plan code) exactly as they appear in the figures. Empty means every quoted plan.",
        },
        include_current: { type: "boolean", description: "Put the plans in force today at the top for reference. Default true." },
        contribution: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["EE", "ES", "EC", "FAM"],
              properties: { EE: { type: "number" }, ES: { type: "number" }, EC: { type: "number" }, FAM: { type: "number" } },
            },
            { type: "null" },
          ],
          description: "The employer's monthly contribution per tier, to add employer/employee split columns. Null for none.",
        },
        format: { type: "string", enum: ["pdf", "xlsx"], description: "PDF to read, Excel to work with." },
        title: { anyOf: [{ type: "string" }, { type: "null" }], description: "A title for the document, or null for the default." },
      },
    },
  },
  {
    name: "create_document",
    description:
      "Turn text you have written into a downloadable, branded document: an executive summary, a memo to leadership, a recap of where the renewal stands, talking points, or an announcement to employees. Write the whole body in Markdown (headings, bullets, bold, simple tables).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body_markdown", "format"],
      properties: {
        title: { type: "string", description: "The document's title, e.g. \"2027 Renewal — Summary for Leadership\"." },
        body_markdown: { type: "string", description: "The full text of the document in Markdown. Use the group's real figures." },
        format: { type: "string", enum: ["pdf", "docx"], description: "PDF to send as is, Word to edit." },
      },
    },
  },
];

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money0 = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-US"));
const TIER_KEYS = ["EE", "ES", "EC", "FAM"];
const TIER_CENSUS = { EE: "Employee", ES: "Employee + Spouse", EC: "Employee + Child(ren)", FAM: "Employee + Family" };

/**
 * The group's figures as text the model can read — the same allow-listed
 * view its own pages get (see clientGroupView), so what the assistant knows
 * is exactly what the client can already see.
 */
export function describeGroup({ group, proposals, funding, manager, splits, signup, renewal }) {
  const g = group;
  const out = [];
  out.push(`# ${g.name}`);
  const facts = [
    `Administrator (TPA) today: ${g.tpa || "unknown"}`,
    `Enrolled in medical: ${g.enrolled ?? "—"} employees; covered lives: ${g.lives ?? "—"}`,
    // The only headcount on file is who is enrolled. Employee Navigator's
    // roster count (everyone not marked terminated) was once passed here as
    // "active employees"; it counts part-time, ineligible and never-closed
    // records and ran to many times the enrolled figure, so it is kept for
    // staff on the Data Check and never told to a client.
    `Headcount: BenSync holds only who is enrolled. It has no verified count of the company's total or benefit-eligible employees. If asked how many employees the company has, say that figure is not on file here and the account manager can confirm it from the census; never quote or estimate one.`,
    g.tiers ? `Enrollment by tier: ${TIER_KEYS.map((k) => `${k} ${g.tiers[k] ?? 0}`).join(", ")}` : null,
    g.pyStart || g.pyEnd ? `Current plan year: ${g.pyStart || "?"} to ${g.pyEnd || "?"}; the 2027 renewal is effective January 1, 2027` : null,
    g.monthly != null ? `Total medical premium today: ${money(g.monthly)} per month (${money0(g.annual ?? g.monthly * 12)} per year)` : null,
    g.supplementalMonthly ? `Supplemental (non-medical) premium today: ${money(g.supplementalMonthly)} per month` : null,
    renewal ? `Renewal status with Kennion: ${renewal}` : null,
  ].filter(Boolean);
  out.push(facts.map((f) => `- ${f}`).join("\n"));

  const plans = g.plans || [];
  if (plans.length) {
    out.push(`\n## Medical plans in force today (2026)`);
    for (const p of plans) {
      const rates = (g.rates || {})[p.plan] || {};
      const counts = (g.planTiers || {})[p.plan] || {};
      const tierLine = TIER_KEYS.map((k) => {
        const r = rates[TIER_CENSUS[k]];
        return `${k}: ${r != null ? money(r) : "not billed"} × ${counts[k] ?? 0}`;
      }).join("; ");
      out.push(`- ${p.plan} (${p.tpa || g.tpa || "TPA ?"}): ${p.enrolled} enrolled, ${money(p.monthly)}/month. Tier rates × enrolled — ${tierLine}`);
      const sp = splits && splits[g.name] && splits[g.name].plans && splits[g.name].plans[p.plan];
      if (sp) {
        const parts = TIER_KEYS.map((k) => {
          const s = sp[TIER_CENSUS[k]];
          if (!s || !s.total) return null;
          return `${k} employer ${money(s.er)} / employee ${money(s.ee)}`;
        }).filter(Boolean);
        if (parts.length) out.push(`  Employer/employee split today (from Employee Navigator): ${parts.join("; ")}`);
      }
    }
  }
  if (Array.isArray(g.lines) && g.lines.length) {
    out.push(`\n## Supplemental benefits in force`);
    for (const l of g.lines) out.push(`- ${l.benefit}: ${l.carrier} ${l.plan} — ${l.enrolled} enrolled, ${money(l.monthly)}/month`);
  }

  if (funding) {
    out.push(`\n## This month's billing (${funding.month || "latest"})`);
    out.push(`- Medical: ${funding.participants} participants, ${money(funding.monthly)} monthly premium, ${money(funding.billed)} billed${funding.adjustments ? ` (adjustments ${money(funding.adjustments)})` : ""}${funding.otherMonthly ? `; other products ${money(funding.otherMonthly)}` : ""}`);
  }

  const props = proposals || [];
  out.push(`\n## Carrier quotes on file for 2027`);
  if (!props.length) {
    out.push(`None yet. Quotes from the 2027 carriers are still coming in; the account manager can say when to expect them.`);
  }
  for (const pr of props) {
    const head = [pr.carrier || pr.slot, pr.funding ? `${pr.funding}` : null, pr.effectiveDate ? `effective ${pr.effectiveDate}` : null, pr.enrolledOnDocument != null ? `priced on ${pr.enrolledOnDocument} enrolled` : null].filter(Boolean).join(", ");
    out.push(`\n### ${pr.slot} — ${head}`);
    if (pr.summary) out.push(pr.summary);
    const list = pr.plans || [];
    const shown = list.slice(0, 40);
    for (const pl of shown) {
      const rates = TIER_KEYS.map((k) => `${k} ${pl.rates && pl.rates[k] != null ? money(pl.rates[k]) : "—"}`).join(", ");
      const b = pl.benefits || {};
      const bens = [
        b.doctorVisit ? `PCP ${b.doctorVisit}` : null,
        b.specialist ? `specialist ${b.specialist}` : null,
        b.urgentCare ? `urgent care ${b.urgentCare}` : null,
        b.imaging ? `imaging ${b.imaging}` : null,
        b.hospital ? `hospital ${b.hospital}` : null,
        b.rx ? `Rx ${b.rx}` : null,
      ].filter(Boolean).join("; ");
      out.push(
        `- ${pl.name}${pl.planCode ? ` [${pl.planCode}]` : ""}${pl.planType ? ` (${pl.planType})` : ""}${pl.network ? `, ${pl.network} network` : ""}: deductible ${pl.deductible || "—"}, out-of-pocket max ${pl.oopMax || "—"}; rates ${rates}${pl.monthlyTotal != null ? `; monthly at the group's census ${money(pl.monthlyTotal)}` : ""}${bens ? `; benefits — ${bens}` : ""}`,
      );
    }
    if (list.length > shown.length) out.push(`- …and ${list.length - shown.length} more options on this quote (see New 2027 Medical Options).`);
  }

  if (signup) {
    out.push(`\n## Sign Up`);
    out.push(`The client shortlisted ${signup.plans.length} plan(s) on ${String(signup.submittedAt).slice(0, 10)}: ${signup.plans.join("; ")}${signup.note ? `. Note: "${signup.note}"` : ""}`);
  }

  if (manager && manager.name) {
    out.push(`\n## Account manager at Kennion`);
    out.push(`${manager.name}${manager.title ? `, ${manager.title}` : ""}${manager.phone ? ` — ${manager.phone}` : ""}${manager.email ? ` — ${manager.email}` : ""}${manager.calendly ? ` — book a call: ${manager.calendly}` : ""}`);
  }
  return out.join("\n");
}

/** Kennion's guidance as one system block: who the assistant is, the rules, the facts, the house answers. */
function playbookText(playbook) {
  const p = normalizePlaybook(playbook);
  const on = (list) => list.filter((x) => x.on !== false);
  const parts = [`## Who you are\n${p.persona}`];
  const rules = on(p.rules);
  if (rules.length) parts.push(`## Rules from Kennion — follow every one of these; they all carry equal weight\n${rules.map((r) => `- ${r.text}`).join("\n")}`);
  const facts = on(p.facts);
  if (facts.length) parts.push(`## Facts about the program — true unless the client's figures say otherwise\n${facts.map((r) => `- ${r.text}`).join("\n")}`);
  const faq = on(p.faq);
  if (faq.length) parts.push(`## House answers — when a question matches one of these, answer the way it says, in these words\n${faq.map((r) => `Q: ${r.q}\nA: ${r.a}`).join("\n\n")}`);
  return parts.join("\n\n");
}

const PAGE_NAMES = {
  home: "Welcome",
  assistant: "Assistant",
  current: "Your 2026 Medical Plans",
  options: "New 2027 Medical Options",
  supplemental: "Supplemental Package",
  signup: "Sign Up",
  admin: "the Kennion admin (a staff member trying the assistant as this group)",
};

/** A thread's title, from its first question: the gist, not the whole thing. */
export function titleFor(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "New conversation";
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:.!?-]+$/, "") + "…";
}

/**
 * Run one tool call. `data` is what the documents need (the group view and
 * its proposals); `keep` stores the bytes and returns the file record.
 * Returns what the model is told.
 */
async function runTool(name, input, { data, keep, onStatus, saveMemory }) {
  const g = data.group;
  if (name === "update_client_memory") {
    const add = (Array.isArray(input.add) ? input.add : []).map((t) => String(t).replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean);
    const removeIds = (Array.isArray(input.remove_ids) ? input.remove_ids : []).map(Number).filter(Number.isInteger);
    if (!saveMemory || (!add.length && !removeIds.length)) return "Nothing changed.";
    onStatus("Noting that…");
    const list = await saveMemory({ add, removeIds });
    return `Noted. What is on file for this client now:\n${memoryText(list) || "(nothing)"}`;
  }
  if (name === "create_comparison") {
    onStatus("Building the comparison…");
    let plans = Array.isArray(input.plans) ? input.plans : [];
    if (!plans.length) plans = (data.proposals || []).flatMap((pr) => (pr.plans || []).map((pl) => pl.name)).slice(0, 12);
    const table = comparisonTable({ group: g, proposals: data.proposals, plans, includeCurrent: input.include_current !== false, contribution: input.contribution || null });
    const format = input.format === "xlsx" ? "xlsx" : "pdf";
    const doc = await renderComparison({ format, title: input.title || null, group: g, table });
    const file = await keep(doc);
    return `Created ${file.filename} (${format.toUpperCase()}, ${table.rows.length} rows). The client can download it from this message. Its contents:\n${comparisonText(table)}`;
  }
  if (name === "create_document") {
    onStatus("Writing the document…");
    const format = input.format === "docx" ? "docx" : "pdf";
    const doc = await renderDocument({ format, title: String(input.title || "Summary").slice(0, 120), markdown: String(input.body_markdown || ""), group: g });
    const file = await keep(doc);
    return `Created ${file.filename} (${format.toUpperCase()}). The client can download it from this message.`;
  }
  return `Unknown tool ${name}.`;
}

/** The client's standing preferences as the model reads them, one numbered line each. */
const memoryText = (list) => (list || []).map((m) => `${m.id}. ${m.text}`).join("\n");

/** The local stand-in: no key, no network; a document when the question sounds like it wants one. */
async function fakeReply(question, ctx) {
  const q = String(question || "");
  const pieces = [];
  if (/\b(remember|prefer|we want|our budget)\b/i.test(q) && ctx.saveMemory) {
    await ctx.saveMemory({ add: [q.replace(/^please\s+remember\s+(that\s+)?/i, "").trim().slice(0, 300)], removeIds: [] });
    pieces.push("Noted, I'll keep that in mind. ");
  }
  if (/compar|side.by.side|spreadsheet/i.test(q)) {
    const table = comparisonTable({ group: ctx.data.group, proposals: ctx.data.proposals, plans: [], includeCurrent: true });
    const file = await ctx.keep(await renderComparison({ format: /excel|xlsx|spreadsheet/i.test(q) ? "xlsx" : "pdf", group: ctx.data.group, table }));
    pieces.push(`Here is a comparison of what is on file — ${file.filename}. `);
  }
  if (/summar|memo|announce|document|recap|talking points/i.test(q)) {
    const file = await ctx.keep(await renderDocument({ format: /word|docx/i.test(q) ? "docx" : "pdf", title: "Renewal summary", markdown: `# Where ${ctx.data.group.name}'s renewal stands\n\n- ${ctx.data.group.enrolled} enrolled today\n- Canned summary (KENNION_FAKE_AI)`, group: ctx.data.group }));
    pieces.push(`I wrote it up — ${file.filename}. `);
  }
  if (ctx.attachments && ctx.attachments.length) pieces.push(`I read ${ctx.attachments.map((f) => f.filename).join(", ")}. `);
  pieces.push(`Canned reply (KENNION_FAKE_AI). You asked: "${q}". In a deployment this is answered with the group's own plans, rates and quotes in front of the model.`);
  return pieces.join("");
}

/**
 * Answer the newest turn. `data` holds the group's view (`group`, `proposals`
 * and the rest describeGroup takes); `history` is every stored turn in order,
 * the last being the user's new question; `page` is where in the portal they
 * asked from; `playbook` is Kennion's guidance. `onText` gets each streamed
 * piece, `onStatus` a line to show while a document is built, `keep` stores
 * a document and returns its record. Resolves to { text, files }.
 */
/** Attachments on user turns older than this many attachment-bearing turns are named, not re-read. */
const ATTACHMENT_TURNS = 3;

/** One attachment as content blocks the model reads: the file itself for a PDF or image, its text otherwise. */
async function attachmentBlocks(f) {
  const p = await prepareForModel({ filename: f.filename, mime: f.mime, buffer: f.data });
  if (p.kind === "pdf") return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.buffer.toString("base64") }, title: f.filename }];
  if (p.kind === "image") return [{ type: "image", source: { type: "base64", media_type: p.mime, data: p.buffer.toString("base64") } }];
  return [{ type: "document", source: { type: "text", media_type: "text/plain", data: p.text || "(empty)" }, title: f.filename }];
}

export async function replyTo({ data, history, page, compact = false, playbook, memory = [], saveMemory, onText, onStatus = () => undefined, keep, readFile }) {
  const turns = history.slice(-HISTORY_TURNS);
  while (turns.length && turns[0].role !== "user") turns.shift();
  const last = turns[turns.length - 1];
  const files = [];
  const keepFile = async (doc) => {
    const rec = await keep(doc);
    files.push(rec);
    return rec;
  };

  if (fakeAi()) {
    const text = await fakeReply(last ? last.content : "", { data, keep: keepFile, attachments: last && last.files, saveMemory });
    let full = "";
    for (const word of text.split(" ")) {
      full += word + " ";
      onText(word + " ");
    }
    return { text: full.trim(), files };
  }
  if (!assistantEnabled()) throw new Error("The assistant is off: no ANTHROPIC_API_KEY is set.");
  const client = apiKey() ? new Anthropic({ apiKey: apiKey() }) : new Anthropic();

  // The client's attachments ride along on the turns that carried them — the
  // newest few in full, older ones by name, so a long thread stays affordable.
  const withFiles = turns.map((m, i) => (m.role === "user" && Array.isArray(m.files) && m.files.length ? i : -1)).filter((i) => i >= 0);
  const readInFull = new Set(withFiles.slice(-ATTACHMENT_TURNS));
  const messages = [];
  for (let i = 0; i < turns.length; i++) {
    const m = turns[i];
    if (m.role === "assistant") {
      // Earlier answers that carried documents read back with a note of what was made.
      const extra = Array.isArray(m.files) && m.files.length ? `\n\n(Documents attached to this answer: ${m.files.map((f) => f.filename).join(", ")})` : "";
      messages.push({ role: "assistant", content: m.content + extra });
      continue;
    }
    let text = m.content;
    if (i === turns.length - 1 && page && PAGE_NAMES[page]) {
      const where = compact
        ? `(Asked in the small chat box on ${PAGE_NAMES[page]}: answer in a few sentences, no table, no headings.)`
        : `(Asked from ${PAGE_NAMES[page]}.)`;
      text = `${where}\n\n${text}`;
    }
    const files = Array.isArray(m.files) ? m.files : [];
    if (!files.length) {
      messages.push({ role: "user", content: text });
      continue;
    }
    const blocks = [];
    if (readInFull.has(i) && readFile) {
      for (const f of files) {
        const rec = await readFile(f.id);
        if (!rec) continue;
        try {
          blocks.push(...(await attachmentBlocks(rec)));
        } catch (e) {
          blocks.push({ type: "text", text: `(The attachment "${f.filename}" could not be read: ${e.message})` });
        }
      }
      blocks.push({ type: "text", text: `(Attached: ${files.map((f) => f.filename).join(", ")})\n\n${text}` });
    } else {
      blocks.push({ type: "text", text: `(Attached earlier in this conversation: ${files.map((f) => f.filename).join(", ")})\n\n${text}` });
    }
    messages.push({ role: "user", content: blocks });
  }

  const params = {
    model: activeModel,
    max_tokens: 8000,
    // The instructions never change, Kennion's guidance changes rarely and
    // the group's figures change rarely, so all three sit in front of cache
    // marks; only the turns vary.
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: playbookText(playbook), cache_control: { type: "ephemeral" } },
      { type: "text", text: `Here are the client's figures. Use them.\n\n${describeGroup(data)}`, cache_control: { type: "ephemeral" } },
      { type: "text", text: `What this client has told you before (their standing preferences; ids for update_client_memory):\n${memoryText(memory) || "(nothing yet)"}` },
    ],
    tools: webSearchOn() ? [...TOOLS, WEB_SEARCH] : TOOLS,
    output_config: { effort: "medium" },
  };

  let full = "";
  // What the model says after a tool call starts on its own paragraph.
  let breakBefore = false;
  const emit = (t) => {
    if (breakBefore && full && !full.endsWith("\n\n")) {
      full += "\n\n";
      onText("\n\n");
    }
    breakBefore = false;
    full += t;
    onText(t);
  };
  // A web search happens on Anthropic's side mid-turn; the client sees a line while it runs.
  const watch = (stream) => {
    stream.on("text", emit);
    stream.on("streamEvent", (ev) => {
      if (ev.type !== "content_block_start") return;
      const t = ev.content_block && ev.content_block.type;
      if (t === "server_tool_use") onStatus("Searching the web…");
      else if (t === "text") onStatus("");
    });
  };
  const beta = client.beta && client.beta.messages && typeof client.beta.messages.stream === "function";
  let useBeta = beta;
  const call = async () => {
    for (;;) {
      try {
        if (useBeta) {
          const stream = client.beta.messages.stream({ ...params, model: activeModel, messages, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
          watch(stream);
          return await stream.finalMessage();
        }
        const stream = client.messages.stream({ ...params, model: activeModel, messages });
        watch(stream);
        return await stream.finalMessage();
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) || full) throw e;
        // The account cannot use the first-choice model: fall back for good.
        if (activeModel !== STANDBY_MODEL && /model|retention/i.test(e.message)) {
          console.warn(`assistant: ${activeModel} rejected (${e.message}); using ${STANDBY_MODEL} from now on`);
          activeModel = STANDBY_MODEL;
          continue;
        }
        if (useBeta) {
          console.warn("beta fallback request rejected, retrying without it:", e.message);
          useBeta = false;
          continue;
        }
        throw e;
      }
    }
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await call();
    if (response.stop_reason === "refusal") throw new Error("The assistant declined to answer that one.");
    // A long web search can pause the turn; sending the content back resumes it.
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason !== "tool_use") break;
    // Thinking blocks ride along unchanged: the model needs them back to continue.
    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      let text;
      try {
        text = await runTool(block.name, block.input || {}, { data, keep: keepFile, onStatus, saveMemory });
      } catch (e) {
        console.error(`assistant tool ${block.name}:`, e.message);
        text = `The document could not be made: ${e.message}. Tell the client, briefly, and offer to try again.`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: text });
    }
    messages.push({ role: "user", content: results });
    breakBefore = true;
    onStatus("");
  }
  return { text: full.trim(), files };
}

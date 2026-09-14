// The BenSync assistant: a client's own benefits advisor in a chat box.
//
// Every turn is answered with the signed-in group's real figures in front of
// the model — its plans and rates today, the carriers' quotes for 2027, this
// month's billing — so an answer is about this employer, not employers in
// general. The same figures the group's pages show, and nothing more: no
// census, no other company. Replies stream, since a comparison across a
// dozen plan options runs long.
import Anthropic from "@anthropic-ai/sdk";

const apiKey = () =>
  process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE || "";
const fakeAi = () => process.env.KENNION_FAKE_AI === "1";
export const assistantEnabled = () => !!(apiKey() || process.env.ANTHROPIC_AUTH_TOKEN || fakeAi());

const MODEL = "claude-opus-5";
/** Turns the model sees. Older ones are dropped, not summarised, to keep a long thread affordable. */
const HISTORY_TURNS = 30;

const SYSTEM = `You are the BenSync Assistant, part of the Kennion Benefit Advisors team. Kennion is an employee benefits brokerage in Alabama. BenSync is the renewal portal Kennion built for its clients' 2027 renewal: for 2027 the program is moving to a set of major national carriers and partners — UnitedHealthcare (fully insured and level funded, including its Surest copay-only product), Gravie (level funded, on the Cigna OAP network), Nationwide, Angle Health, and for some groups Cobalt (self funded) — which gives each client more renewal options than before. Plans in force today run through the program's administrators, EBPA and HealthEZ.

You are talking with the HR lead or owner of one employer group — an existing Kennion client — who is using BenSync to understand their options, funding, and budget for 2027. Help them make smarter, faster decisions: explain what they have today, compare the quoted options, model what a contribution change means in dollars, draft a note to leadership or employees, and say plainly what you would look at next.

How to work:
- Answer from the group's figures below. Every rate is a monthly composite per tier (EE = employee only, ES = employee + spouse, EC = employee + child(ren), FAM = family). A plan's monthly cost at the group's census is the tier rate times the headcount in that tier, summed; annual is monthly times 12. Show the arithmetic briefly when you compute a figure.
- Never invent a number. If the figures do not cover a question — a plan's benefits, a carrier that has not quoted, a rate that is missing — say what is missing and that the account manager can get it, rather than estimating.
- Be concise and concrete. Lead with the answer, then the reasoning. Use Markdown: short paragraphs, bulleted lists, and a table when comparing plans or tiers. Round dollars sensibly. No preamble, no closing pleasantries.
- Funding terms, in one line each when asked: fully insured (fixed premium, carrier keeps the surplus and the risk); level funded (a fixed monthly amount that includes claims funding, stop-loss and administration, with a possible refund of unused claims funding at year end); self funded (the employer pays claims directly with stop-loss protection). Present tradeoffs evenly; the choice is the employer's.
- You are not a lawyer, tax adviser or actuary: on ACA, ERISA, COBRA, tax treatment, or plan legality, give the general shape and point them to their account manager or counsel.
- The portal's pages, which you may point to by name: Welcome; What's Changing For 2027 (today against 2027, the headline); Your 2026 Medical Plans (what is in force today, with rates and the employer/employee split); New 2027 Medical Options (every quoted plan side by side, with a contribution modeler); Supplemental Package (dental, vision, life, disability and the rest); Sign Up (shortlist plans and send a note to Kennion to start the renewal).
- When the client wants to move forward, or the question needs a person — a specific quote, a carrier's answer, a meeting — hand them to their account manager by name, with the phone and email given below.`;

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
    g.medicalEligible != null ? `Active employees on the census: ${g.medicalEligible}` : null,
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

const PAGE_NAMES = {
  home: "Welcome",
  assistant: "Assistant",
  changes: "What's Changing For 2027",
  current: "Your 2026 Medical Plans",
  options: "New 2027 Medical Options",
  supplemental: "Supplemental Package",
  signup: "Sign Up",
};

/** A thread's title, from its first question: the gist, not the whole thing. */
export function titleFor(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "New conversation";
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:.!?-]+$/, "") + "…";
}

async function* fakeReply(question) {
  const text = `Canned reply (KENNION_FAKE_AI). You asked: "${question}". In a deployment this is answered with the group's own plans, rates and quotes in front of the model.`;
  for (const word of text.split(" ")) {
    yield word + " ";
  }
}

/**
 * Answer the newest turn. `context` is the group description; `history` is
 * every stored turn in order, the last being the user's new question; `page`
 * is where in the portal they asked from. `onText` gets each streamed piece.
 * Resolves to the full reply.
 */
export async function replyTo({ context, history, page, onText }) {
  const turns = history.slice(-HISTORY_TURNS);
  if (turns.length && turns[0].role !== "user") turns.shift();
  const last = turns[turns.length - 1];
  if (fakeAi()) {
    let full = "";
    for await (const piece of fakeReply(last ? last.content : "")) {
      full += piece;
      onText(piece);
    }
    return full.trim();
  }
  if (!assistantEnabled()) throw new Error("The assistant is off: no ANTHROPIC_API_KEY is set.");
  const client = apiKey() ? new Anthropic({ apiKey: apiKey() }) : new Anthropic();

  const messages = turns.map((m, i) => {
    if (m.role === "user" && i === turns.length - 1 && page && PAGE_NAMES[page]) {
      return { role: "user", content: `(Asked from the "${PAGE_NAMES[page]}" page.)\n\n${m.content}` };
    }
    return { role: m.role, content: m.content };
  });

  const params = {
    model: MODEL,
    max_tokens: 4000,
    // The instructions never change and the group's figures change rarely,
    // so both sit in front of the cache mark; only the turns vary.
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: `Here are the client's figures. Use them.\n\n${context}`, cache_control: { type: "ephemeral" } },
    ],
    output_config: { effort: "medium" },
    messages,
  };

  let full = "";
  const emit = (t) => {
    full += t;
    onText(t);
  };
  const run = async (stream) => {
    stream.on("text", emit);
    return stream.finalMessage();
  };

  let response;
  const beta = client.beta && client.beta.messages && typeof client.beta.messages.stream === "function";
  if (beta) {
    try {
      response = await run(client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }));
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError) || full) throw e;
      console.warn("beta fallback request rejected, retrying without it:", e.message);
    }
  }
  if (!response) response = await run(client.messages.stream(params));

  if (response.stop_reason === "refusal") {
    throw new Error("The assistant declined to answer that one.");
  }
  return full.trim();
}

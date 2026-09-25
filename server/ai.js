// Reads a carrier proposal and says which group it belongs to.
//
// A proposal from UnitedHealthcare, Gravie, Nationwide, Angle, Cobalt or anyone else arrives
// as a PDF. Claude reads the document itself - no text extraction step to lose
// a scanned page - and returns the carrier, the company named on the paper,
// the plans and tier rates, and the roster group it matches with a confidence.
// Nothing here is authoritative: the staff can reassign any proposal, and the
// extracted figures are stored for review, not pushed into the rate tables.
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { PDFDocument } from "pdf-lib";
import { canonicalizePlans } from "./plan-canonical.js";

/**
 * The extraction agent: every proposal, short or long, PDF or workbook, is
 * read by Claude Sonnet 5 at high effort - the model for reading dense rate
 * grids off a document into exact structured data. Its 1M context takes a
 * carrier's whole book in one reading (100 pages of rate grids weighed 255K
 * tokens in practice), and its 128K output holds a quote with well over a
 * hundred plans. Haiku used to take the short ones; accuracy is the point
 * here, not the cheapest read.
 */
const PROPOSAL_MODEL = "claude-sonnet-5";

/**
 * Pages per reading on the long model. The API would take 600, but context
 * runs out first: at the ~2.5K tokens a page of rate grids weighs, 600 pages
 * is about 1.5M tokens against a 1M window. 300 leaves room for the output
 * and for a document denser than the one this was measured on.
 */
const MAX_PDF_PAGES = 300;

/** Thrown by readOnce when the model's answer ran past max_tokens. */
class TooLongError extends Error {}


/**
 * Fold the readings of a split proposal into one. Every plan from every part
 * is kept, in order; the header facts come from the first part that states
 * one, since a carrier prints them on the opening pages.
 */
function mergeReadings(readings) {
  const firstSet = (key, blank) => {
    for (const r of readings) {
      const v = r[key];
      if (v !== null && v !== undefined && v !== blank) return v;
    }
    return readings[0]?.[key] ?? null;
  };
  return {
    ...readings[0],
    carrier: firstSet("carrier", "Unknown"),
    funding: firstSet("funding", "unknown"),
    proposal_type: firstSet("proposal_type", "unknown"),
    quotes_medical: readings.some((r) => r.quotes_medical === true),
    quote_id: firstSet("quote_id"),
    group_name_on_document: firstSet("group_name_on_document"),
    matched_group: firstSet("matched_group"),
    // The least sure part governs: a match the whole document does not support
    // should not read as certain because its first pages did. A part that
    // names no group at all - the back half of a rate book, with no employer
    // on it - has no say; two parts naming different groups is no match.
    confidence: (() => {
      const named = readings.filter((r) => r.matched_group);
      if (!named.length) return Math.min(...readings.map((r) => Number(r.confidence) || 0));
      if (new Set(named.map((r) => r.matched_group)).size > 1) return 0;
      return Math.min(...named.map((r) => Number(r.confidence) || 0));
    })(),
    effective_date: firstSet("effective_date"),
    enrolled_on_document: firstSet("enrolled_on_document"),
    total_monthly: firstSet("total_monthly"),
    // Every appearance from every part, each still knowing which part (and so
    // which pages) it came from; canonicalizePlans folds them by identity.
    plans: readings.flatMap((r) => (Array.isArray(r.plans) ? r.plans.map((pl) => ({ ...pl, _pageMap: r._pageMap || null })) : [])),
    summary: readings.map((r) => r.summary).filter(Boolean).join(" "),
    audit_flags: [
      `Read in ${readings.length} parts: the document is longer than one reading holds.`,
      ...new Set(readings.flatMap((r) => (Array.isArray(r.audit_flags) ? r.audit_flags : []))),
    ],
  };
}

/**
 * The API key. The SDK reads ANTHROPIC_API_KEY on its own; CLAUDE and
 * CLAUDE_API_KEY are accepted too, since that is how the key was first added
 * to Railway and renaming a secret is a chore nobody should have to do.
 */
const apiKey = () =>
  process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE || "";

/** Set when the deployment has an Anthropic credential to call with. */
export const aiEnabled = () => !!(apiKey() || process.env.ANTHROPIC_AUTH_TOKEN || fakeAi());

/**
 * Local end-to-end runs only (KENNION_FAKE_AI=1): no key, no network. A text
 * upload whose body is a JSON extraction is returned as the reading, so the
 * whole path after the model - filing, slots, the group's Options page - can
 * be exercised. Never set in a deployment.
 */
const fakeAi = () => process.env.KENNION_FAKE_AI === "1";
function fakeReading(file) {
  const p = file.prepared || {};
  const text = p.text || (p.buffer ? p.buffer.toString("utf8") : "");
  try {
    const j = JSON.parse(text);
    return {
      carrier: "Unknown",
      funding: "unknown",
      group_name_on_document: null,
      matched_group: null,
      confidence: 0,
      effective_date: null,
      proposal_type: "unknown",
      enrolled_on_document: null,
      plans: [],
      total_monthly: null,
      summary: "Canned reading (KENNION_FAKE_AI).",
      audit_flags: [],
      ...j,
    };
  } catch {
    return { carrier: "Unknown", funding: "unknown", quotes_medical: false, group_name_on_document: null, matched_group: null, confidence: 0, effective_date: null, proposal_type: "unknown", enrolled_on_document: null, plans: [], total_monthly: null, summary: "Canned reading: not JSON.", audit_flags: ["unreadable"] };
  }
}

const MODEL = "claude-opus-5";

const nullable = (t) => ({ anyOf: [{ type: t }, { type: "null" }] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "carrier",
    "funding",
    "quotes_medical",
    "quote_id",
    "group_name_on_document",
    "matched_group",
    "confidence",
    "effective_date",
    "proposal_type",
    "enrolled_on_document",
    "plans",
    "plan_appearances",
    "unique_plans_found",
    "unique_epo_found",
    "total_monthly",
    "summary",
    "audit_flags",
  ],
  properties: {
    carrier: {
      type: "string",
      description:
        "The carrier or vendor issuing the proposal, e.g. UnitedHealthcare, Surest, Gravie, Nationwide, Angle Health, Cobalt, Optimyl Health, EBPA, HealthEZ, BCBS of Alabama. 'Unknown' if it cannot be told.",
    },
    funding: {
      type: "string",
      description:
        "How the quoted plan is funded: 'fully insured', 'level funded', 'self funded', or 'unknown'. UnitedHealthcare quotes are usually one of the first two - say which.",
    },
    quotes_medical: {
      type: "boolean",
      description:
        "True when the document quotes medical / health plan rates. False for an ancillary-only proposal - dental, vision, life, disability, accident or similar with no medical coverage quoted.",
    },
    group_name_on_document: {
      ...nullable("string"),
      description: "The employer / group name exactly as printed on the proposal, or null.",
    },
    matched_group: {
      ...nullable("string"),
      description:
        "The roster group this proposal is for - copied EXACTLY from the roster list - or null if no roster group clearly matches.",
    },
    confidence: {
      type: "number",
      description:
        "0 to 1. How sure the match is. 0.9+ only when the name on the document is unmistakably the roster group.",
    },
    quote_id: {
      ...nullable("string"),
      description:
        "The carrier's own identifier for this proposal - quote ID, proposal number, case or group number as printed on it. Null if none is shown.",
    },
    effective_date: {
      ...nullable("string"),
      description: "Proposed effective date as printed (ISO yyyy-mm-dd if possible), or null.",
    },
    proposal_type: {
      type: "string",
      description: "renewal, new business, alternative quote, or unknown.",
    },
    enrolled_on_document: {
      ...nullable("integer"),
      description: "Number of enrolled employees the proposal is priced on, if stated.",
    },
    plans: {
      type: "array",
      description:
        "Every DISTINCT medical plan option quoted - each unique plan exactly once, however many pages it appears on - with monthly composite rates by tier where given. A carrier quote often runs to dozens of options over many pages - list them all, in the order they first appear. EPO plans included.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "plan_code", "network", "plan_type", "deductible", "oop_max", "benefits", "rates", "monthly_total", "source_pages", "source_sheet", "source_rows"],
        properties: {
          name: {
            type: "string",
            description:
              "The plan's name exactly as printed on the document - the carrier's own wording, character for character, nothing added. Never append where it sat on the quote (no \"(headline option 2)\", \"(PPO alternate 32)\"); if the document prints an alternate's label as part of the name, keep it as printed. When the same design is priced twice under different drug lists or networks, the printed distinguishing words are part of the name.",
          },
          plan_code: {
            ...nullable("string"),
            description:
              "The carrier's code for this plan where one is printed - a benefit or plan code such as \"P1000B22\" or \"MP34/MP92\". Null when the plan is named but not coded. Optimyl Health's proposal names no such code - it prints only a \"Plan Number\" row (1, 2, 3, 4) across its Proposal Summary table: for an Optimyl plan, set plan_code to \"OPTIMYL PLAN \" followed by that plan's own number, e.g. \"OPTIMYL PLAN 1\", \"OPTIMYL PLAN 4\" - this must read from the Plan Number row exactly, never invented or reordered. (The \"OPTIMYL PLAN \" prefix is Kennion's fixed form of that printed number, the one code rule of its kind.)",
          },
          network: {
            ...nullable("string"),
            description:
              "The network the plan is priced on, exactly as the document prints it (Choice, Choice Plus, INS-Choice, Options PPO, Cigna Open Access Plus…). Null when the document names no network - never filled from what the carrier usually uses.",
          },
          plan_type: { ...nullable("string"), description: "The plan type or design family exactly as the document prints it for this plan (\"PPO\", \"HDHP\", \"Traditional\"). Null when the document does not print one - never inferred from the name, the network or the deductible." },
          deductible: { ...nullable("string"), description: "The in-network deductible as printed, individual first and then family where both are printed (\"$3,000 / $6,000\")." },
          oop_max: { ...nullable("string"), description: "The in-network out-of-pocket maximum as printed, individual first and then family where both are printed." },
          source_pages: {
            type: "object",
            additionalProperties: false,
            required: ["identity", "benefits", "rates"],
            description:
              "Where this plan is on the PDF you were given, as page positions within that file (1 = its first page): identity = every page that shows this plan's name or code; benefits = the pages its benefit values are read from; rates = the pages its four tier rates are read from. Empty arrays for a spreadsheet or text document.",
            properties: {
              identity: { type: "array", items: { type: "integer" } },
              benefits: { type: "array", items: { type: "integer" } },
              rates: { type: "array", items: { type: "integer" } },
            },
          },
          source_sheet: { type: "string", description: "For a spreadsheet: the sheet this plan is read from (the '## Sheet:' heading). Empty for a PDF." },
          source_rows: { type: "string", description: "For a spreadsheet or text document: the rows or section this plan is read from, e.g. 'rows 12-14'. Empty for a PDF." },
          benefits: {
            type: "object",
            additionalProperties: false,
            required: ["doctor_visit", "specialist", "imaging", "urgent_care", "emergency_room", "hospital", "rx", "coinsurance", "hsa_eligible"],
            description:
              "The in-network member cost for each service as printed on the benefit summary for this plan, short and verbatim (\"$30 copay\", \"20% after deductible\", \"$10 / $40 / $80\"). An empty string where the document does not say.",
            // Plain strings, empty where unknown: the API caps a schema at 16 nullable fields.
            properties: {
              doctor_visit: { type: "string", description: "Primary care office visit." },
              emergency_room: { type: "string", description: "Emergency room visit." },
              coinsurance: { type: "string", description: "The plan's in-network coinsurance, e.g. \"20%\" or \"0%\"." },
              hsa_eligible: { type: "string", description: "\"yes\" only when the document itself states the plan is HSA-eligible or HSA-qualified, \"no\" only when it states it is not, empty when it does not say. Never infer it from the plan's name, type, deductible or an \"HDHP\" label." },
              specialist: { type: "string", description: "Specialist office visit." },
              imaging: { type: "string", description: "Labs, X-ray and advanced imaging (MRI, CT)." },
              urgent_care: { type: "string" },
              hospital: { type: "string", description: "Inpatient hospital stay." },
              rx: { type: "string", description: "Retail prescription drug copays or coinsurance by tier, in tier order (\"$10 / $40 / $80\"); mail order left out." },
            },
          },
          rates: {
            type: "object",
            additionalProperties: false,
            required: ["EE", "ES", "EC", "FAM"],
            properties: {
              EE: nullable("number"),
              ES: nullable("number"),
              EC: nullable("number"),
              FAM: nullable("number"),
            },
          },
          monthly_total: nullable("number"),
        },
      },
    },
    total_monthly: {
      ...nullable("number"),
      description: "Total monthly premium for the proposal at the quoted enrollment, if stated.",
    },
    plan_appearances: {
      type: "integer",
      description: "How many times medical plans appear in what you read, counting every appearance (overview, comparison table, benefit page, rate page, appendix) - the same plan shown on four pages is four appearances.",
    },
    unique_plans_found: {
      type: "integer",
      description: "How many DISTINCT medical plans those appearances are, EPO plans included. Equals the length of plans.",
    },
    unique_epo_found: { type: "integer", description: "How many of the distinct plans are EPO plans." },
    summary: {
      type: "string",
      description: "One or two sentences a benefits advisor would want: what was quoted and anything unusual.",
    },
    audit_flags: {
      type: "array",
      items: { type: "string" },
      description:
        "Short notes on anything that needs a human look: name does not match cleanly, enrollment differs from the roster, rates missing, dates odd, pages unreadable.",
    },
  },
};

const SYSTEM = `You read insurance carrier proposals for Kennion Benefit Advisors, a benefits brokerage in Alabama. Each proposal is a quote for one employer group's medical plan, sent by a carrier such as UnitedHealthcare (including Surest), Gravie, Nationwide, Angle Health, Cobalt, Optimyl Health, EBPA, HealthEZ or BCBS of Alabama.

Your job: identify the carrier, read off the plans and tier rates, and decide which group on Kennion's roster the proposal is for. Match by the employer name on the document against the roster names. Treat legal-form words (LLC, Inc., Co., Corporation, Holdings) and punctuation loosely, but do not match on a shared common word alone - "Birmingham Steel" is not "Birmingham-Toledo". When two roster groups could both fit, pick neither and say so in the flags. Copy the matched roster name exactly as listed. Say whether the quote is fully insured or level funded. UnitedHealthcare sends one of each for a group, in separate documents, and Kennion tracks them as separate proposals, so decide from the document in front of you and say which - a UHC quote whose funding you cannot tell is worth an audit flag. A quote runs to many pages and often dozens of plan options: read every page and list every option, including the alternate, illustrative and benchmark grids that follow the headline plans - they are quotable options and Kennion prices from them. Give each one the name exactly as printed - the carrier's wording, nothing added, no placement labels of your own - and the plan or benefit code printed on it, the network it is priced on where the quote distinguishes them, and its own tier rates. Two plans that differ only by network or by deductible are two plans. Never summarise a grid as "and other options"; list them. Surest is a UnitedHealthcare product, not a separate carrier: report a Surest quote with carrier "UnitedHealthcare" and say which funding it is, so it files under the group's UnitedHealthcare proposal. Kennion tracks seven medical proposals per group - UnitedHealthcare fully insured, UnitedHealthcare level funded, Gravie, Nationwide, Angle Health, Cobalt (a self-funded quote) and Optimyl Health (a self-funded, reference-based-pricing quote) - so set quotes_medical false for an ancillary-only document (dental, vision, life, disability) even when it comes from one of those carriers. Rates are monthly composite amounts per tier: EE (employee only), ES (employee + spouse), EC (employee + children), FAM (family). Leave a value null rather than guessing: never fill a plan's value from another plan, from what the carrier usually offers, or from what the plan's name suggests - only what the document states for that plan. Optimyl Health always quotes the same 4 standard plans - its Proposal Summary table numbers them 1 through 4 in a "Plan Number" row and nothing else names or codes them - so for an Optimyl proposal set each plan's plan_code from that row exactly as the schema says ("OPTIMYL PLAN 1" .. "OPTIMYL PLAN 4"); list exactly the plans the document prints (normally those 4), never one it does not.

One plan, one entry. A proposal shows the same plan many times - an overview page, a comparison table, a detailed benefit page, a rate page, an appendix. Those are appearances of ONE plan: list it once, and record every page it appears on in source_pages (identity, benefits, rates), counting all of them in plan_appearances. Never list a plan twice because it is printed twice, and never merge two plans because they look alike: a different plan code, network or printed name is a different plan. Keep each plan's benefits and its four rates together: pair a rate row with a plan by the plan name and code printed with it, the section heading and the table it sits in - not by row order alone - and never give one plan the benefits or rates of another. Copy every name and code exactly as printed; never shorten, rename, normalise or invent one. If two appearances of the same plan show different values, report the one on the page that is the plan's own benefit or rate table and add an audit flag naming both pages. List EPO plans too, with EPO in the network or plan type as printed: every plan on the proposal is stored, and Kennion decides separately which ones a client sees.`;

/**
 * Read one proposal. `file` is { filename, prepared, context } where `prepared`
 * came from intake.prepareForModel and `context` is the email it arrived in,
 * if any. `roster` is [{ name, enrolled, tpa }] for every live group. Returns
 * the extraction, or throws with a message the admin screen can show.
 */
export async function analyzeProposal(file, roster) {
  if (fakeAi()) {
    // Canned readings go through the same canonical fold as real ones; a
    // canned plan with no pages of its own is placed on page 1.
    const r = fakeReading(file);
    r.plans = (r.plans || []).map((pl) => ({ ...pl, source_pages: pl.source_pages || { identity: [1], benefits: [1], rates: [1] }, source_sheet: pl.source_sheet || "(canned)", source_rows: pl.source_rows || "row 1" }));
    return { ...fold([r], { method: "fake", pages: 1 }), coverage: fullCoverage(file.prepared) };
  }
  if (!aiEnabled()) throw new Error("AI matching is off: no ANTHROPIC_API_KEY is set.");
  // A proposal read shares the org's tokens-per-minute budget with every
  // other caller. The server already caps how many run at once (see
  // withReadSlot in index.js), but a burst can still catch a 429 waiting for
  // a slot to free up - a couple of retries is worth it rather than failing
  // the read and making staff click Re-Read by hand. The SDK's own default
  // (10 minutes) is long enough that a single stalled attempt - a connection
  // that opens but never finishes - can tie up a read slot for the better
  // part of an hour once retries stack up; a firmer per-attempt timeout caps
  // that, and the retry count is bounded to match.
  const client = apiKey() ? new Anthropic({ apiKey: apiKey(), maxRetries: 3, timeout: 6 * 60 * 1000 }) : new Anthropic({ maxRetries: 3, timeout: 6 * 60 * 1000 });

  const rosterText = roster
    .map((g) => `- ${g.name} (${g.enrolled} enrolled, ${g.tpa || "TPA unknown"})`)
    .join("\n");

  const ctx = file.context;
  const emailNote = ctx
    ? `\n\nThis file arrived as an attachment to an email, which is useful context for the match (the subject or body often names the group):\nFrom: ${ctx.from || "?"}\nSubject: ${ctx.subject || "?"}\nDate: ${ctx.date || "?"}\nBody:\n${ctx.body || "(empty)"}`
    : "";
  const ask = (partNote = "") =>
    `The file is named "${file.filename}".${emailNote}${partNote}\n\nKennion's roster - the only groups a proposal can be matched to:\n${rosterText}\n\nRead the proposal and fill in the structured result.`;

  const p = file.prepared;
  const stage = typeof file.onStage === "function" ? file.onStage : () => undefined;
  const model = PROPOSAL_MODEL;
  const pdfContent = (buf, note) => [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
      title: file.filename,
    },
    { type: "text", text: ask(note) },
  ];
  const excerptNote = (pageMap, total) =>
    `\n\nThis file is an excerpt of a ${total}-page proposal: its pages are the original pages ${describePages(pageMap)}, in that order. List only the plans printed in this excerpt; other excerpts are read separately and merged with yours by exact plan name and code. Report source_pages as positions within THIS file (1 = its first page).`;
  const windowNote = (pages, total) =>
    `\n\nThis is the whole ${total}-page proposal, but read ONLY pages ${describePages(pages)}: list only the plans printed on those pages, with the benefits and rates printed on those pages. The other pages are read separately and merged with yours by exact plan name and code. Report source_pages as page numbers of this document (1 = its first page).`;
  /**
   * Read a set of the document's pages (original page numbers, in order).
   * All of them: the document itself. Some: an excerpt PDF holding just
   * those pages - or, when the PDF cannot be cut (an encrypted carrier
   * quote, which pdf-lib will not rewrite), the whole document with an
   * instruction to read only those pages. Every page a plan is read from is
   * recorded as its original page number. When the answer would not fit in
   * one reading, the set is cut in half and each half read - down to a
   * single page - and the halves' appearances are folded back together by
   * exact plan identity, so a plan whose benefits sit in one half and its
   * rates in the other is still one plan with both.
   */
  // What was actually read, for the coverage record: every page a deep read
  // came back from, every line of a text source a read came back from.
  const deep = new Set();
  const scanned = new Set();
  const readPages = async (pages, total, depth = 0) => {
    const whole = pages.length === total && pages.every((n, i) => n === i + 1);
    let content;
    let pageMap = null;
    if (whole) content = pdfContent(p.buffer, "");
    else {
      const excerpt = await excerptPdf(p.buffer, pages).catch(() => null);
      if (excerpt) {
        content = pdfContent(excerpt, excerptNote(pages, total));
        pageMap = pages;
      } else content = pdfContent(p.buffer, windowNote(pages, total));
    }
    try {
      const r = await readOnce(client, model, content);
      r._pageMap = pageMap;
      for (const n of pages) deep.add(n);
      return [r];
    } catch (e) {
      if (!(e instanceof TooLongError)) throw e;
      if (pages.length <= 1 || depth >= 8) throw new Error(`Page ${pages[0]} alone is longer than one reading can hold.`);
      const mid = Math.ceil(pages.length / 2);
      console.log(`${file.filename}: pages ${describePages(pages)} too long for one reading, reading in 2 parts`);
      return [...(await readPages(pages.slice(0, mid), total, depth + 1)), ...(await readPages(pages.slice(mid), total, depth + 1))];
    }
  };
  /**
   * The same for a text document (a flattened spreadsheet, a CSV, an email
   * body): halve it by lines. `lines` are { n, text } - n the line's number
   * in the source (null for a sheet heading repeated into a second half) - so
   * every line a read came back from is recorded as scanned.
   */
  const readText = async (lines, part = "", depth = 0) => {
    const text = lines.map((l) => l.text).join("\n");
    const content = [
      { type: "document", source: { type: "text", media_type: "text/plain", data: text || "(empty)" }, title: file.filename },
      { type: "text", text: ask(`${part}${SECTIONS_NOTE}`) },
    ];
    try {
      const r = await readOnce(client, model, content);
      for (const l of lines) if (l.n != null) scanned.add(l.n);
      return [r];
    } catch (e) {
      if (!(e instanceof TooLongError)) throw e;
      if (lines.length < 2 || depth >= 6) throw new Error("Part of this document is longer than one reading can hold, even read in pieces.");
      const mid = Math.ceil(lines.length / 2);
      const first = lines.slice(0, mid);
      const second = lines.slice(mid);
      // Each half keeps the sheet heading it sits under, so a plan's sheet
      // is still named in the half that holds its rows.
      const lastHeading = [...first].reverse().find((l) => /^## Sheet:/.test(l.text));
      if (lastHeading && !/^## Sheet:/.test((second[0] || {}).text || "")) second.unshift({ n: null, text: lastHeading.text });
      const num = (ls) => ls.filter((l) => l.n != null).map((l) => l.n);
      const note = (ls) => `\n\nThis is lines ${Math.min(...num(ls))}-${Math.max(...num(ls))} of the document, read in parts. List only the plans in these lines; the other parts are read separately and merged with yours by exact plan name and code.`;
      return [...(await readText(first, note(first), depth + 1)), ...(await readText(second, note(second), depth + 1))];
    }
  };

  if (p.kind === "pdf") {
    // How many pages: pdf-parse, else pdf-lib (which counts an encrypted
    // carrier quote that pdf-parse cannot open), else the map's own count.
    let numpages = await countPdfPages(p.buffer);
    let map = null;
    const wantMap = !numpages || (numpages > MAP_MIN_PAGES && numpages <= MAX_PDF_PAGES);

    // A long proposal is mapped first: which pages carry plan names, benefits
    // and rates, and which are ancillary or boilerplate. The map only steers
    // the reading; it is never taken as plan data. The relevant pages are read
    // and merged by exact plan identity; if that cannot reconstruct the
    // proposal with confidence, the whole document is read.
    if (wantMap) {
      stage("MAPPING");
      map = await mapDocument(client, p.buffer, file.filename, numpages).catch((e) => {
        console.warn(`${file.filename}: mapping failed (${e.message}); reading the whole document`);
        return null;
      });
      if (!numpages && map && Number.isInteger(map.page_count) && map.page_count > 0) numpages = map.page_count;
    }
    stage("EXTRACTING");
    if (!numpages) {
      // Nothing could count the pages: one reading of the whole document.
      console.warn(`${file.filename}: page count unknown; reading the whole document in one pass`);
      return { ...fold([await readOnce(client, model, pdfContent(p.buffer, ""))], { method: "full", pages: null }), coverage: pdfCoverage(null, map, deep) };
    }
    const all = Array.from({ length: numpages }, (_, i) => i + 1);
    const relevant = map && numpages > MAP_MIN_PAGES ? relevantPages(map, numpages) : [];
    if (map && relevant.length && relevant.length < numpages) {
      const readings = [];
      for (let i = 0; i < relevant.length; i += RELEVANT_BATCH) readings.push(...(await readPages(relevant.slice(i, i + RELEVANT_BATCH), numpages)));
      const out = fold(readings, { method: "mapped", pages: numpages, relevantPages: relevant, map: mapSummary(map) });
      const doubt = mappedDoubt(out, map);
      if (!doubt) return { ...out, coverage: pdfCoverage(numpages, map, deep) };
      console.log(`${file.filename}: relevant-page reading not confident (${doubt}); reading the whole document`);
    }

    // The whole document. A long one is read in windows of RELEVANT_BATCH
    // pages from the start, rather than all at once and halved on failure:
    // a reading that runs past one answer is only found out after the model
    // has written the whole answer (about 15 minutes for a 300-page quote),
    // so starting whole and halving spent an hour on failures before the
    // first plan landed (Adobe HVAC's 300-page UHC quote). Windows that are
    // still too long are halved as before; every window's appearances fold
    // together by exact plan identity.
    const readings = [];
    if (numpages > RELEVANT_BATCH) {
      for (let i = 0; i < numpages; i += RELEVANT_BATCH) readings.push(...(await readPages(all.slice(i, i + RELEVANT_BATCH), numpages)));
    } else readings.push(...(await readPages(all, numpages)));
    return { ...fold(readings, { method: readings.length > 1 ? "split" : "full", pages: numpages }), coverage: pdfCoverage(numpages, map, deep) };
  }
  stage("EXTRACTING");
  if (p.kind === "image") {
    const out = fold(
      [
        await readOnce(client, model, [
          { type: "image", source: { type: "base64", media_type: p.mime, data: p.buffer.toString("base64") } },
          { type: "text", text: ask() },
        ]),
      ],
      { method: "full", pages: 1 },
    );
    return { ...out, coverage: { kind: "image", total_pages: 1, mapped_pages: 0, deep_read_pages: 1, covered_pages: 1, uncovered: "" } };
  }
  // Text: a CSV, a spreadsheet or Word file already flattened, or an email body.
  const note = p.truncated ? [`The document was longer than ${p.text.length} characters and was cut off before it was read - plans past that point are missing.`] : [];
  const out = fold(await readText(String(p.text || "").split("\n").map((text, i) => ({ n: i + 1, text }))), { method: "text", pages: null });
  if (note.length) out.audit_flags = [...note, ...(out.audit_flags || [])];
  return { ...out, coverage: textCoverage(p.coverage, scanned) };
}

/** Told on every text read: a CSV or workbook can hold several tables. */
const SECTIONS_NOTE = "\n\nThis document may hold several sheets, sections or tables (a heading or header row can repeat part-way down): read every one to the end - do not stop after the first plan table.";

/**
 * The coverage record of a PDF reading - what was inspected, from what was
 * actually done: the pages the map listed, the pages a deep read came back
 * from, and any page neither saw. A page is covered when the map inspected
 * it or a deep read read it; the reading can only be Verified when every
 * page is covered (server/plan-validate.js, "Source coverage").
 */
function pdfCoverage(numpages, map, deep) {
  const total = Number.isInteger(numpages) && numpages > 0 ? numpages : null;
  const mapped = new Set(map && Array.isArray(map.pages) ? map.pages.map((pg) => pg.page).filter((n) => Number.isInteger(n) && n >= 1 && (!total || n <= total)) : []);
  const covered = new Set([...mapped, ...deep]);
  const uncovered = total ? Array.from({ length: total }, (_, i) => i + 1).filter((n) => !covered.has(n)) : [];
  return {
    kind: "pdf",
    total_pages: total,
    mapped_pages: mapped.size,
    deep_read_pages: deep.size,
    deep_read: describePages([...deep].sort((a, b) => a - b)),
    covered_pages: total ? total - uncovered.length : covered.size,
    uncovered: describePages(uncovered),
  };
}

/**
 * The coverage record of a text reading (a workbook flattened by sheet, a
 * CSV, an email body): the source's total lines, the lines a read came back
 * from, each sheet inspected (every one of its lines read, or found empty
 * when the workbook was opened) and each section read.
 */
function textCoverage(cov = {}, scanned) {
  const total = Number.isInteger(cov.total_lines) ? cov.total_lines : scanned.size;
  const allRead = (from, to) => {
    for (let n = from; n <= to; n++) if (!scanned.has(n)) return false;
    return true;
  };
  const out = { kind: cov.kind || "text", ...(cov.format ? { format: cov.format } : {}), total_lines: total, scanned_lines: scanned.size, total_chars: cov.total_chars ?? null };
  if (Array.isArray(cov.sheets)) {
    const sheets = cov.sheets.map((sh) => ({ name: sh.name, rows: sh.rows, status: sh.empty ? "empty" : allRead(sh.lineFrom, sh.lineTo) ? "read" : "not read" }));
    Object.assign(out, { total_sheets: cov.total_sheets ?? sheets.length, inspected_sheets: sheets.filter((sh) => sh.status !== "not read").length, sheets });
  }
  if (Array.isArray(cov.sections)) Object.assign(out, { total_sections: cov.sections.length, sections_read: cov.sections.filter((sc) => allRead(sc.from, sc.to)).length });
  return out;
}

/** The canned reader's coverage (KENNION_FAKE_AI): the whole source, as a real read of it would record. */
function fullCoverage(prepared) {
  const p = prepared || {};
  if (p.kind === "pdf" || p.kind === "image") return { kind: p.kind, total_pages: 1, mapped_pages: 0, deep_read_pages: 1, deep_read: "1", covered_pages: 1, uncovered: "" };
  const lines = String(p.text || "").split("\n").length;
  return textCoverage(p.coverage || { total_lines: lines }, new Set(Array.from({ length: (p.coverage && p.coverage.total_lines) || lines }, (_, i) => i + 1)));
}

/** Pages past which a PDF is mapped before it is read. */
const MAP_MIN_PAGES = 20;
/** Most pages one excerpt carries when a mapped proposal is read in sections. */
const RELEVANT_BATCH = 40;

/** "3-5, 9, 12-14" for a list of page numbers. */
function describePages(pages) {
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return out.join(", ");
}

/**
 * The page count of a PDF: pdf-parse, else pdf-lib with encryption ignored -
 * carriers often send owner-password-encrypted quotes that open without a
 * password but that pdf-parse cannot read ("bad XRef entry"). 0 when neither
 * can say.
 */
async function countPdfPages(buffer) {
  const viaParse = await pdfParse(buffer).then((r) => r.numpages || 0).catch(() => 0);
  if (viaParse) return viaParse;
  return PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false })
    .then((d) => d.getPageCount())
    .catch(() => 0);
}

/** A PDF holding just these pages of `buffer`, in order. Throws for a PDF pdf-lib cannot rewrite (encrypted). */
async function excerptPdf(buffer, pages) {
  const src = await PDFDocument.load(buffer);
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(src, pages.map((n) => n - 1));
  for (const pg of copied) doc.addPage(pg);
  return Buffer.from(await doc.save());
}

/**
 * Fold one or more readings into one result whose plans are canonical: every
 * appearance merged by exact identity (EPO plans included - every plan is stored), and the
 * count reconciliation on the result. `extraction` records how it was read.
 */
function fold(readings, extraction) {
  const base = readings.length === 1 ? { ...readings[0], plans: (readings[0].plans || []).map((pl) => ({ ...pl, _pageMap: readings[0]._pageMap || null })) } : mergeReadings(readings);
  const one = readings.length === 1 ? readings[0] : null;
  const appearancesReported = readings.every((r) => Number.isInteger(r.plan_appearances)) ? readings.reduce((n, r) => n + r.plan_appearances, 0) : null;
  const canon = canonicalizePlans(base.plans || [], {
    reportedAppearances: appearancesReported,
    // A part's own unique count cannot be summed across parts (a plan can
    // appear in two); only a single reading's count is compared.
    reportedUnique: one && Number.isInteger(one.unique_plans_found) ? one.unique_plans_found : null,
    reportedEpo: one && Number.isInteger(one.unique_epo_found) ? one.unique_epo_found : null,
  });
  const out = { ...base, plans: canon.plans, reconciliation: canon.reconciliation, extraction: { ...extraction, model: PROPOSAL_MODEL, parts: readings.length, at: new Date().toISOString() } };
  delete out._pageMap;
  delete out.plan_appearances;
  delete out.unique_plans_found;
  delete out.unique_epo_found;
  return out;
}

const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["carrier", "effective_date", "page_count", "document_type", "pages", "approx_unique_ppo", "approx_unique_epo", "notes"],
  properties: {
    carrier: { type: "string" },
    effective_date: { type: "string", description: "As printed, or empty." },
    page_count: { type: "integer" },
    document_type: { type: "string", enum: ["digital", "scanned", "mixed"] },
    pages: {
      type: "array",
      description: "Every page of the document, in order, with what it carries.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "kinds"],
        properties: {
          page: { type: "integer" },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["plan_identity", "benefit_summary", "benefit_detail", "rates", "ancillary", "cover_or_boilerplate", "other"] },
          },
        },
      },
    },
    approx_unique_ppo: { type: "integer", description: "Roughly how many distinct non-EPO medical plans the document quotes." },
    approx_unique_epo: { type: "integer", description: "Roughly how many distinct EPO medical plans it quotes." },
    notes: { type: "string" },
  },
};

const MAP_SYSTEM = `You map a carrier's medical proposal so it can be read in sections. For every page, say what it carries: plan_identity (plan names or codes are listed), benefit_summary or benefit_detail (medical benefit values - deductibles, copays, coinsurance, prescriptions), rates (medical tier rates), ancillary (dental, vision, life, disability), cover_or_boilerplate (cover, disclosures, instructions, census, underwriting terms), or other. A page can carry several. When in doubt whether a page has medical plan names, benefits or rates, include it - a page left out is never read. Estimate how many distinct PPO and EPO medical plans the document quotes. You are only navigating; you do not read out plan data.`;

/** Map a long PDF: which pages carry medical plan identities, benefits and rates. */
async function mapDocument(client, buffer, filename, numpages) {
  const response = await client.messages
    .stream({
      model: PROPOSAL_MODEL,
      max_tokens: 32000,
      system: MAP_SYSTEM,
      output_config: { effort: "medium", format: rawJsonSchemaFormat(MAP_SCHEMA) },
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") }, title: filename },
            { type: "text", text: numpages ? `This proposal has ${numpages} pages. Map every page.` : "Map every page of this proposal, and give its page count." },
          ],
        },
      ],
    })
    .finalMessage();
  if (response.stop_reason !== "end_turn") throw new Error(`map ended ${response.stop_reason}`);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const map = JSON.parse(text);
  if (!Array.isArray(map.pages) || !map.pages.length) throw new Error("the map lists no pages");
  return map;
}

const MEDICAL_KINDS = new Set(["plan_identity", "benefit_summary", "benefit_detail", "rates"]);
/** The pages worth reading, in order - every page the map says carries medical plan data. */
function relevantPages(map, numpages) {
  const listed = new Set(map.pages.map((pg) => pg.page));
  // A page the map skipped entirely is read, not dropped.
  const unmapped = Array.from({ length: numpages }, (_, i) => i + 1).filter((n) => !listed.has(n));
  const medical = map.pages.filter((pg) => Number.isInteger(pg.page) && pg.page >= 1 && pg.page <= numpages && (pg.kinds || []).some((k) => MEDICAL_KINDS.has(k))).map((pg) => pg.page);
  return [...new Set([...medical, ...unmapped])].sort((a, b) => a - b);
}
const mapSummary = (map) => ({ documentType: map.document_type, approxPpo: map.approx_unique_ppo, approxEpo: map.approx_unique_epo, carrier: map.carrier });

/**
 * Why a relevant-page reading cannot be trusted to stand for the document -
 * or null when it can. A plan with no rate or no benefit read (its other half
 * sat in a section the merge could not pair), fewer plans than the map saw,
 * or nothing at all sends the reading back to the whole document.
 */
function mappedDoubt(out, map) {
  const plans = out.plans || [];
  if (!plans.length) return "no plans";
  const unpaired = (out.plans || []).filter((pl) => !["EE", "ES", "EC", "FAM"].some((t) => pl.rates && pl.rates[t] != null) || !(pl.deductible || pl.oop_max));
  if (unpaired.length) return `${unpaired.length} plan(s) without both benefits and rates`;
  const seen = (Number(map.approx_unique_ppo) || 0) + (Number(map.approx_unique_epo) || 0);
  if (seen && plans.length < seen) return `${plans.length} plans read, the map saw about ${seen}`;
  return null;
}

/**
 * The schema for output_config.format, without the SDK helper's own `.parse`
 * callback. With `.parse` present, `.finalMessage()` auto-parses the reply
 * and, on invalid JSON, THROWS instead of resolving - which loses the
 * response entirely, `stop_reason` included. That mattered here: several
 * live "Failed to parse structured output: ... Unterminated string" failures
 * turned out to be ordinary max_tokens truncations (the same handful of
 * documents failed at a similar cutoff point on every attempt, retries
 * included) wearing a misleading error, because the thrown parse error hid
 * the very stop_reason that would have named the real cause. Dropping
 * `.parse` makes `.finalMessage()` always resolve with the raw message, so
 * the stop_reason check below runs first and a genuinely oversized document
 * gets the accurate "too long" error instead of a cryptic parse failure that
 * a retry could never fix.
 */
const rawJsonSchemaFormat = (schema) => {
  const { parse, ...format } = jsonSchemaOutputFormat(schema);
  return format;
};

/** One reading: the model call, and the structured result out of it. */
async function readOnce(client, model, content) {
  const params = {
    model,
    // A carrier quote can list dozens of plans over many pages, and every one
    // of them is written out here: Sonnet 5's full 128K of output (streamed),
    // so only a truly enormous book has to be read in parts.
    max_tokens: 128000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    // Reading rate grids off scanned pages is the intelligence-sensitive part.
    output_config: { effort: "high", format: rawJsonSchemaFormat(SCHEMA) },
    messages: [{ role: "user", content }],
  };

  const MAX_PARSE_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt++) {
    // Streamed, because a long document at this output ceiling would otherwise
    // sit past the HTTP timeout. Server-side refusal fallback on the beta
    // endpoint; if that request is refused as malformed (an org without the
    // beta, say), the same call on the stable endpoint is identical minus it.
    let response;
    const beta = client.beta && client.beta.messages && typeof client.beta.messages.stream === "function";
    if (beta) {
      try {
        response = await client.beta.messages
          .stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
          .finalMessage();
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        console.warn("beta fallback request rejected, retrying without it:", e.message);
      }
    }
    if (!response) response = await client.messages.stream(params).finalMessage();

    if (response.stop_reason === "refusal") {
      throw new Error("The model declined to read this document.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new TooLongError("This proposal is longer than one reading can hold - the result would be cut off mid-plan.");
    }
    // The output format constrains the reply to JSON matching the schema, so the
    // text blocks concatenate to the object.
    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    let out;
    try {
      out = JSON.parse(text);
    } catch (e) {
      // Not a length problem (stop_reason wasn't max_tokens above) - a genuine
      // one-off malformed generation, worth a fresh reading before giving up.
      if (attempt < MAX_PARSE_ATTEMPTS) {
        console.warn(`structured output was not valid JSON, reading again (attempt ${attempt + 1}/${MAX_PARSE_ATTEMPTS}):`, e.message);
        continue;
      }
      throw new Error("Could not read a structured result from the document.");
    }
    if (!out || typeof out !== "object") {
      throw new Error("Could not read a structured result from the document.");
    }
    return out;
  }
}


/**
 * Explain a reconciliation: Employee Navigator's carrier stats report against
 * what the import produced, with what the import left out and why. Aggregates
 * only - no member data leaves the server. Returns plain text for the screen.
 */
/**
 * Claude's read of the whole audit - the carrier reconciliation and the
 * billing check together - written for a benefits advisor. Aggregates only.
 */
export async function explainAudit(payload) {
  if (fakeAi()) return "Canned audit read (KENNION_FAKE_AI).";
  if (!aiEnabled()) throw new Error("AI is off: no ANTHROPIC_API_KEY is set.");
  const client = apiKey() ? new Anthropic({ apiKey: apiKey() }) : new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    system:
      "You are a benefits data analyst auditing a brokerage's renewal portal, which holds a snapshot in time built from three Employee Navigator files: the XML export (every company's enrollments and premiums), the Carrier Stats report (Employee Navigator's own count and plan cost per carrier, counting every line a carrier writes, distinct employees, every company including archived ones), and the month's funding workbook (what each group was actually billed by the two captives, EBPA and HealthEZ, per participant per product - Blue Cross of Alabama plans are billed elsewhere and are outside the workbook, so the billing check compares captive medical only). The payload has: where the month's whole medical billing sits (billing.coverage: `live` = invoices filed under a group the portal shows, `archived` = filed under a company archived or out of the program, `unfiled` = invoices with no group yet) - the Groups page tile counts live groups on the XML basis, so it sits below the workbook's total by the archived and unfiled parts, and that is expected, not a discrepancy; per carrier, the report's figure against the portal's on the same basis, with the difference; per group, the XML's enrolled and medical premium against the month's billed participants and premium; the import diagnostics (what the parser left out and why, medical and other lines, and company records it could not use); and the invoices not filed under any group. Write for a benefits advisor in plain language, no code, under 350 words: first a one-sentence overall verdict on whether the snapshot can be trusted for client renewals; then, for each carrier off by more than about 1% and for the groups whose billing differs from the XML, the most likely cause, citing the specific bucket or group and the numbers; then what, if anything, a person should do. Where a gap is explained by a known cause (companies not in the export, a group that has left, a plan renewed since the export), say so plainly rather than raising alarm.",
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Claude's read of the data check: which groups to look at first and why,
 * from the per-group findings (aggregates and group names only - the checks
 * themselves are arithmetic done on the server; the model explains, it does
 * not decide a number).
 */
const DATA_CHECK_SYSTEM =
  "You are a benefits data analyst reviewing a brokerage's renewal portal, group by group. The portal holds a snapshot built from three Employee Navigator files - the XML export (each company's enrollments, tier rates and premiums), the Carrier Stats report (Employee Navigator's own totals per carrier) and the month's funding workbook (what each group was actually billed, per plan and tier). Every group has been run through arithmetic checks on the server; you are given only the findings that were not clean: per group, which checks warned or failed and the exact wording, plus the outcome of re-reading the stored XML against what the portal holds, and the cross-file verdict by carrier. Every number in the payload is computed, not estimated - do not recompute or second-guess them; explain them. Write for a benefits advisor in plain language, no code, under 350 words: one sentence on whether the data is fit for clients today; then the groups to look at first, in order, each with the most likely cause and the one thing to do (re-import, set the size category, file an invoice, ask the TPA about a rate); then anything that is expected rather than wrong - a roster count that is Employee Navigator's Active status rather than an eligible headcount, a one-person timing difference between the export and the month's billing - said plainly so nobody chases it.";

export async function explainDataCheck(payload) {
  if (fakeAi()) return "Canned data check read (KENNION_FAKE_AI).";
  if (!aiEnabled()) throw new Error("AI is off: no ANTHROPIC_API_KEY is set.");
  const client = apiKey() ? new Anthropic({ apiKey: apiKey() }) : new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    system: DATA_CHECK_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * The second opinion: the same findings read by ChatGPT, independently of
 * Claude, so two models that agree on what to look at first are worth more
 * than one. The key is the `ChatGPT` variable on Railway (or
 * OPENAI_API_KEY); the model can be pinned with CHATGPT_MODEL. Plain HTTPS
 * to OpenAI's chat completions endpoint - no SDK to carry for one call.
 * Same payload, same rules: aggregates and group names only, and the model
 * explains the arithmetic, it never decides a figure.
 */
const chatgptKey = () => process.env.CHATGPT_API_KEY || process.env.ChatGPT || process.env.CHATGPT || process.env.OPENAI_API_KEY || "";
const CHATGPT_MODEL = () => process.env.CHATGPT_MODEL || "gpt-5";
export const chatgptEnabled = () => !!chatgptKey() || fakeAi();

export async function secondReadDataCheck(payload) {
  if (fakeAi()) return "Canned second read (KENNION_FAKE_AI).";
  if (!chatgptKey()) throw new Error("ChatGPT is off: no ChatGPT (or OPENAI_API_KEY) variable is set.");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatgptKey()}` },
    body: JSON.stringify({
      model: CHATGPT_MODEL(),
      messages: [
        { role: "system", content: DATA_CHECK_SYSTEM },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ChatGPT (${CHATGPT_MODEL()}): ${(j.error && j.error.message) || r.statusText}`);
  const text = j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || "").trim() : "";
  if (!text) throw new Error("ChatGPT returned no text.");
  return text;
}

export async function explainReconciliation(payload) {
  if (fakeAi()) return "Canned explanation (KENNION_FAKE_AI).";
  if (!aiEnabled()) throw new Error("AI is off: no ANTHROPIC_API_KEY is set.");
  const client = apiKey() ? new Anthropic({ apiKey: apiKey() }) : new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    system:
      "You are a benefits data analyst helping a brokerage reconcile its own import of an Employee Navigator XML export against Employee Navigator's Carrier Stats report. The report's 'Enrolled Employees' and 'Plan Costs' per carrier are the reference. The import's rules: an employee is skipped when their employment status says terminated/inactive/deceased; a medical enrollment counts when its EndDate is nil, absent or in the future; waived elections are skipped; an enrollment with no PlanCost adds nothing to premium. The diagnostics say how many enrollments each rule left out, by carrier program, with the premium they carried. Write for a benefits advisor: plain language, no code. For each carrier that differs by more than about 1%, say what most likely explains the difference, citing the specific exclusion bucket and numbers, and whether a rule should change to match Employee Navigator's counting - be concrete about which rule. If the gap cannot be explained by the buckets, say what to look at next. Keep it under 300 words.",
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// How much source the dual audit sends, before and after targeted packets.
//
//   node scripts/audit-cost-estimate.mjs            representative proposals
//   DATABASE_URL=... node scripts/audit-cost-estimate.mjs --db
//                                                   every current proposal on
//                                                   file, from its real page
//                                                   count and stored provenance
//
// OLD: every 25-plan batch was sent the whole source, per model:
//        pages x batches.
// NEW: one document reconciliation reads the whole source, per model, and
//      each batch reads only its packet: pages + sum(packet pages). A
//      proposal that fits in one batch is one combined full-source call.
// Pages are exact (server/audit-packets.js builds the packets). Tokens are
// an estimate at TOKENS_PER_PAGE per PDF page (Anthropic bills a PDF page as
// its text plus an image of the page - roughly 1,500-3,000 tokens; set
// KENNION_TOKENS_PER_PAGE to change it). No dollar figure is printed: the
// saving is in the pages and tokens.
import { pdfPacketPages } from "../server/audit-packets.js";
import { auditBatches } from "../server/proposal-audit.js";

const TOKENS_PER_PAGE = Number(process.env.KENNION_TOKENS_PER_PAGE || 2000);

/** Pages sent per model, old and new, for one proposal. */
export function estimate({ pages, plans }) {
  const batches = auditBatches(plans.length);
  const old = pages * batches.length;
  // One batch: the reconciliation and the field audit are one full-source call.
  if (batches.length === 1) return { pages, plans: plans.length, batches: 1, oldPages: old, newPages: pages, fullBatches: 0, reduction: 0 };
  let packetPages = 0;
  let fullBatches = 0;
  for (const b of batches) {
    const pick = pdfPacketPages(b.map((i) => plans[i]), pages);
    if (pick.full) {
      packetPages += pages;
      fullBatches++;
    } else packetPages += pick.pages.length;
  }
  const now = pages + packetPages;
  return { pages, plans: plans.length, batches: batches.length, oldPages: old, newPages: now, fullBatches, reduction: old ? Math.round((1 - now / old) * 1000) / 10 : 0 };
}

/**
 * A carrier-style proposal: a cover, a summary section listing ~10 plans a
 * page, one benefit page per 2 plans, a rate grid of ~5 plans a page, and
 * boilerplate (underwriting notes, disclosures, ancillary) filling the rest.
 */
export function synthetic(nPlans, nPages) {
  const summary = 3;
  const benefits = summary + Math.ceil(nPlans / 10) + 1;
  const rates = benefits + Math.ceil(nPlans / 2) + 1;
  const plans = Array.from({ length: nPlans }, (_, i) => ({ source: { identity: [summary + Math.floor(i / 10)], benefits: [benefits + Math.floor(i / 2)], rates: [rates + Math.floor(i / 5)] } }));
  const needed = rates + Math.ceil(nPlans / 5);
  return { pages: Math.max(nPages, needed + 2), plans };
}

const fmt = (n) => n.toLocaleString("en-US");
function table(rows) {
  const head = ["proposal", "pages", "plans", "batches", "old pages", "new pages", "old tokens*", "new tokens*", "reduction"];
  const out = [head, ...rows.map((r) => [r.name, r.pages, r.plans, r.batches, fmt(r.oldPages), fmt(r.newPages), fmt(r.oldPages * TOKENS_PER_PAGE), fmt(r.newPages * TOKENS_PER_PAGE), `${r.reduction}%`])];
  const w = head.map((_, c) => Math.max(...out.map((r) => String(r[c]).length)));
  return out.map((r) => r.map((v, c) => String(v).padEnd(w[c])).join("  ")).join("\n");
}

const REPRESENTATIVE = [
  { name: "small quote (6 plans)", plans: 6, pages: 12 },
  { name: "25-plan quote", plans: 25, pages: 40 },
  { name: "50-plan quote", plans: 50, pages: 60 },
  { name: "100-plan quote", plans: 100, pages: 120 },
  { name: "159-plan quote", plans: 159, pages: 300 },
];

async function fromDatabase() {
  const { createDb } = await import("../server/db.js");
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const db = createDb(process.env.DATABASE_URL);
  if (!db) throw new Error("DATABASE_URL is not set.");
  const rows = (await db.listProposals()).filter((r) => r.group_name && !r.superseded_by && /pdf/i.test(r.mime || "") && r.extracted && Array.isArray(r.extracted.plans) && r.extracted.plans.length);
  const out = [];
  for (const r of rows) {
    const f = await db.getProposalFile(r.id);
    const pages = f ? await pdfParse(f.data).then((p) => p.numpages).catch(() => 0) : 0;
    if (!pages) continue;
    out.push({ name: `#${r.id} ${r.group_name} / ${r.slot}`.slice(0, 60), ...estimate({ pages, plans: r.extracted.plans }) });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = process.argv.includes("--db") ? await fromDatabase() : REPRESENTATIVE.map((p) => ({ name: p.name, ...estimate(synthetic(p.plans, p.pages)) }));
  console.log(`Source sent to ONE auditor model (double for both); * tokens at ${TOKENS_PER_PAGE} per page.\n`);
  console.log(table(rows));
  const fullNote = rows.filter((r) => r.fullBatches).map((r) => `${r.name}: ${r.fullBatches} batch(es) full-source`);
  if (fullNote.length) console.log(`\nBatches that fell back to the full source: ${fullNote.join("; ")}`);
}

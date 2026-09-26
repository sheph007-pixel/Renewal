// Server for the Kennion 2027 renewal portal.
//
// The census carries employee names, ages, ZIPs and premiums for 1,318 people,
// so it is never served as a static file. It is loaded here and handed out one
// group at a time, only in exchange for that group's access code. Rate
// Administration gets a separate, PII-free projection.
import express from "express";
import compression from "compression";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { PassThrough, Readable } from "node:stream";
import { newSecret, verifyTotp, otpauthUrl, newRecoveryCodes, hashCode, spendRecovery } from "./totp.js";
import { parseEnStream, premiumBreakdown, classifyPlans, newDiagnostics, mergeDiagnostics } from "./en-parse.js";
import { createDb } from "./db.js";
import { assignCodes, sizeFor, normalizeName } from "./group-id.js";
import { groupSlug } from "./slug.js";
import { eligibilityOf } from "./eligibility.js";
import { auditForClient, auditProposal, correctProposal, applyCorrection, readingVersion, auditProgress } from "./proposal-audit.js";
import { withUsage, setUsageSink, memoryUsage, summarize, aiQuotaBlock, lastQuotaBlock, quotaErrorCount } from "./ai-usage.js";
import { AUDIT_STANDARD as PLAN_AUDIT_STANDARD, COMPARE_VERSION, optimylNumber, optimylLabel, labelSharedNames } from "./plan-compare.js";
import { aiEnabled, analyzeProposal, explainReconciliation, explainAudit, explainDataCheck, chatgptEnabled, secondReadDataCheck } from "./ai.js";
import { DEFAULT_PLAYBOOK, RULE_SUGGESTIONS, assistantEnabled, describeGroup, normalizePlaybook, replyTo, titleFor } from "./assistant.js";
import { comparisonTable, renderChangesReport, renderComparison, renderPicksReport, renderPlanCardPdf, renderPlanSheet, renderSignupConfirmation } from "./documents.js";
import { auditData, compareToExport } from "./data-audit.js";
import { expandUpload, prepareForModel, classify, SUPPORTED } from "./intake.js";
import JSZip from "jszip";
import pg from "pg";
import { s3Store, runBackup, pruneBackups, listBackups } from "./backup.js";
import { configureBatches, dbStore as batchDbStore, withBatch, batching, batchState } from "./claude-batch.js";
import Anthropic from "@anthropic-ai/sdk";
import { parseInvoicePdf, groupFromInvoiceFilename, matchInvoiceName } from "./invoice-parse.js";
import { parseGravieWorkbook, gravieExtracted, gravieQuoteRows, gravieDrift } from "./gravie-parse.js";
import { parseCatalogueWorkbook, catalogueIndex, applyCatalogue, catalogueKey } from "./plan-catalogue.js";
import { applyBenefitsGrid } from "./standard-designs.js";
import { loadPlanDocumentFiles, parseSimpleDocFilename } from "./plan-documents.js";
import { categorizeResource } from "./resources.js";
import { medicalFromDocument, isAncillaryRow } from "./proposal-kind.js";
import { matchRosterGroup, groupNamedIn } from "./proposal-match.js";
import { verifyProposals } from "./proposal-verify.js";
import { validatePlans } from "./plan-validate.js";
import { hiddenReason } from "./plan-visibility.js";
import { identityKey, isBlankPlan, exactName, normCode, foldPlacementDuplicates, isEpoPlan as isEpoCanon } from "./plan-canonical.js";
import { logInboxKey, logPresignedUploads, ingestInbox } from "./inbox.js";
import { parseCarrierStats } from "./carrier-stats.js";
import { runAudit, auditFingerprint } from "./audit.js";
import { parseFunding, assignInvoices, summariseFunding, bandTier } from "./funding.js";
import { readAuditWorkbook, TIERS as RATE_TIERS, PROGRAM_TPAS } from "./rates-audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "dist", "public");
const indexHtml = path.join(publicDir, "index.html");

if (!fs.existsSync(indexHtml)) {
  console.error(`Build output missing at ${indexHtml}. Run \`npm run build\` first.`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "kennion.json"), "utf8"));

/**
 * Imported groups are written here, layered over the shipped census.
 *
 * Railway's container filesystem is ephemeral, so point DATA_DIR at a mounted
 * volume to make imports survive a redeploy. Without one, an import lasts until
 * the next deploy and the admin screen says so.
 */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const IMPORTS_FILE = path.join(DATA_DIR, "imported-groups.json");
const DURABLE = !!process.env.DATA_DIR;

function loadImports() {
  try {
    return JSON.parse(fs.readFileSync(IMPORTS_FILE, "utf8"));
  } catch {
    return { groups: {}, splits: {} };
  }
}
let imported = loadImports();

/**
 * Postgres, when DATABASE_URL is set, is the source of truth for everything a
 * human enters: imported groups, their splits, and hand-keyed rates. The JSON
 * file remains as the fallback for a deployment without a database.
 */
const db = createDb(process.env.DATABASE_URL);
// Every model call's usage record goes to Postgres (kennion.ai_usage) as well
// as the in-memory list (server/ai-usage.js).
if (db) setUsageSink((r) => db.recordAiUsage(r));
let overrides = {};
/** Staff-set company IDs and ALE buckets, keyed by group name. */
let meta = {};
/** When each group's data last came in from an export. */
let importedAt = {};
let recentImports = [];

function saveImports() {
  if (db) return; // Postgres holds it; no file to write.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(IMPORTS_FILE, JSON.stringify(imported, null, 2));
}

/** What each group has submitted on its own Sign Up page, without a database. */
const SIGNUPS_FILE = path.join(DATA_DIR, "group-signups.json");
function loadSignups() {
  try {
    return JSON.parse(fs.readFileSync(SIGNUPS_FILE, "utf8"));
  } catch {
    return [];
  }
}
/** Every submission, newest first, kept when there is no database. */
let signups = loadSignups();
function saveSignups() {
  if (db) return; // Postgres holds it; no file to write.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SIGNUPS_FILE, JSON.stringify(signups, null, 2));
}

/** Overrides for one group, in the `group||plan||tier` shape the client uses. */
function overridesFor(name) {
  const out = {};
  const prefix = name + "||";
  for (const [k, v] of Object.entries(overrides)) if (k.startsWith(prefix)) out[k] = v;
  return out;
}

// The census export carries a grand-total row alongside the real groups; it has
// no plans, members or rates and is not a client - filtered in rebuild().

/** Superseded scheme, still accepted so codes already sent out keep working. */
function legacyCodeFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100000;
  const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4).padEnd(4, "X");
  return "KEN-" + letters + "-" + String(h).padStart(5, "0").slice(0, 4);
}

/**
 * Groups placed through an outside broker rather than directly by Kennion.
 * The label is what matters to the portal; the broker's name is deliberately
 * not recorded. Staff can change any group's label in Rate Administration,
 * and a set label wins over this list.
 */
const OUTSIDE_BROKER_GROUPS = new Set(
  [
    "ARC Realty, LLC",
    "Ashley Mac's Holdings, LLC",
    "Electrical Repair Service Co., Inc.",
    "Innova Zones, LLC",
    "MesaPay, LLC",
    "Parker's Heating and Air Conditioning, Inc.",
    "R.E. Garrison Corporate",
  ].map(normalizeName),
);
const defaultBroker = (name) =>
  OUTSIDE_BROKER_GROUPS.has(normalizeName(name)) ? "outside" : "kennion";

/**
 * Which account manager looks after each group, from Kennion's own list. The
 * list names companies its own way, so the match is on the normalised name
 * with a single-candidate prefix fallback - the same rule an import uses. A
 * manager set by hand wins over this.
 */
const MANAGER_LIST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "account-managers.json"), "utf8"),
);
export const MANAGERS = MANAGER_LIST.managers;
const MANAGER_BY_NAME = new Map(MANAGER_LIST.list.map((r) => [normalizeName(r.group), r.manager]));

/**
 * Standardized benefit summaries, read from each carrier's own plan-summary
 * PDF: Guardian dental, VSP vision and Guardian supplemental (accident,
 * cancer, critical illness, disability, hospital gap, voluntary life) - the
 * standing lineup, not tied to a plan year - plus the group's prior (2026)
 * "Old Medical" options, kept for reference now that 2027 medical is new.
 * One entry per plan/product, each with a `summary` of headline figures and
 * a `lines` array transcribing every benefit row. See describeGroup() in
 * assistant.js for how the assistant reads this.
 */
const BENEFIT_SUMMARIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "benefit-summaries.json"), "utf8"),
);

/**
 * The Supplemental Package rate grid - dental, vision, life, accident,
 * critical illness, cancer, hospital indemnity and short term disability,
 * with their monthly rates by tier. The same file client/src/lib/supplemental.ts
 * reads for the Supplemental Package page, so the assistant's own numbers
 * can never drift from what a client sees there. Every group gets this
 * identical lineup at these identical rates - unlike Medical, which is
 * quoted per group, nothing here is ever a per-group unknown.
 */
const SUPPLEMENTAL_RATES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "supplemental-rates.json"), "utf8"),
);

/**
 * The account manager a client may see: name, direct line, email and booking
 * link, and nothing else. A group with no manager on the list falls back to the
 * office, so the card on a client's page is never empty.
 */
function managerContact(key) {
  const c = (MANAGER_LIST.contacts || {})[key];
  return c ? { ...c } : { ...(MANAGER_LIST.fallback || {}) };
}
/** The licensed broker every client's team card and summary name, or null when the list has none. */
function brokerContact() {
  const b = MANAGER_LIST.broker;
  return b && b.name ? { ...b } : null;
}
/** A church (SIC 8661, Religious Organizations) is fully insured with UHC only - never level funded. */
function isChurch(g) {
  return !!g && (g.sic === "8661" || /church/i.test(g.name || ""));
}

/**
 * The slots that apply to one group, in the "carrier this group is being
 * shopped at" sense the Welcome page and the Proposals admin grid use to
 * say a review is complete. A church never gets a UHC Level Funded slot at
 * all - UHC Fully Insured is its only UHC option.
 */
function slotsForGroup(g) {
  return SLOTS.filter((sl) => !(sl === "UHC Level Funded" && isChurch(g)));
}

/**
 * A group's permanent link token: random and unguessable, so the address can
 * be bookmarked and shared without a code being typed, and guessing a company
 * name gets nobody in. Minted once and kept; resetting it kills the old link.
 */
const newLinkToken = () => crypto.randomBytes(16).toString("base64url");

function defaultManager(name) {
  const k = normalizeName(name);
  if (!k) return null;
  const exact = MANAGER_BY_NAME.get(k);
  if (exact) return exact;
  const hits = [...MANAGER_BY_NAME.entries()].filter(([n]) => n.startsWith(k) || k.startsWith(n));
  return hits.length === 1 ? hits[0][1] : null;
}

let groups = [];
let byCode = new Map();
/** Permanent link token -> group, for the /g/<token> address. */
let byToken = new Map();
/** Address slug (company + code) -> group, for the short /<slug>/<tab> address. */
let bySlug = new Map();
let adminGroups = [];
/** Proposals filed under each group, so the Groups page can show coverage. */
let proposalCounts = {};
/** The newest client invoice filed under each group - month, when, whether it tied out. */
let invoiceByGroup = {};
/**
 * Each group's current proposals - the newest assigned one per slot, with
 * what Claude read off it (plans and tier rates) - keyed by group name. This
 * is what a group's 2027 Options page prices from; no file bytes, no flags.
 */
let currentProposals = {};
/**
 * Every carrier's standard plan designs - the catalogue a carrier quotes the
 * same designs from to every group - and the same keyed by carrier and plan
 * code. Loaded at boot from the workbooks in server/data/plan-docs and the
 * database; a quoted plan whose name is a catalogue code takes its benefits
 * from here. See server/plan-catalogue.js.
 */
let planCatalogue = [];
let planCatalogueIndex = new Map();
/** Designs staff uploaded while no database is connected: kept for the process's life only. */
let uploadedCatalogue = [];
/** The catalogues shipped with the code: file, carrier, plan year. Seeded into the database once. */
const CATALOGUE_FILES = [
  { file: "AngleHealthStandardPlanBenefits.xlsx", carrier: "Angle Health", planYear: 2027 },
  { file: "OptimylHealthStandardPlanBenefits.xlsx", carrier: "Optimyl Health", planYear: 2027 },
];

/**
 * How many plans a Carrier/TPA lets a group offer its employees, by
 * enrolled headcount. Seeded into `kennion.carrier_plan_limits` once; a row
 * there always wins, so a limit can be corrected without a deploy. Kept in
 * sync with the CARRIER_PLAN_LIMITS constant in client/src/lib/model.ts,
 * which shows the same limits on the group's own pages and the disclaimers
 * page without a round trip.
 */
const CARRIER_PLAN_LIMIT_SEED = [
  {
    carrier: "Optimyl Health",
    tiers: [
      { min: 2, max: 24, maxPlans: 2 },
      { min: 25, max: 50, maxPlans: 3 },
      { min: 51, max: null, maxPlans: 4 },
    ],
  },
  {
    carrier: "UnitedHealthcare",
    tiers: [
      { min: 2, max: 50, maxPlans: 2 },
      { min: 51, max: null, maxPlans: 3, maxWithUnderwriting: 4 },
    ],
  },
  {
    carrier: "Gravie",
    tiers: [
      { min: 2, max: 50, maxPlans: 3 },
      { min: 51, max: null, maxPlans: 4 },
    ],
  },
];
/** carrier -> its tiers, loaded at boot (the database's rows, once seeded, win over the seed above). */
let carrierPlanLimits = new Map(CARRIER_PLAN_LIMIT_SEED.map((d) => [d.carrier, d.tiers]));

/** Seed `kennion.carrier_plan_limits` from CARRIER_PLAN_LIMIT_SEED where a carrier has no row yet, then load every carrier's tiers into memory. */
async function loadCarrierPlanLimits() {
  const byCarrier = new Map(CARRIER_PLAN_LIMIT_SEED.map((d) => [d.carrier, d.tiers]));
  if (db) {
    try {
      let stored = await db.listCarrierPlanLimits();
      const have = new Set(stored.map((d) => d.carrier));
      const seed = CARRIER_PLAN_LIMIT_SEED.filter((d) => !have.has(d.carrier));
      if (seed.length) {
        await db.upsertCarrierPlanLimits(seed, "system");
        stored = await db.listCarrierPlanLimits();
      }
      for (const d of stored) byCarrier.set(d.carrier, d.tiers);
    } catch (e) {
      console.error("carrier plan limits:", e.message);
    }
  }
  carrierPlanLimits = byCarrier;
  console.log(`carrier plan limits: ${byCarrier.size} carrier(s) - ${[...byCarrier.keys()].join(", ")}`);
}

/** The tier covering this many enrolled, for a carrier with a limit on file; null for a carrier with none, or a count none of its tiers cover. */
function planLimitFor(carrier, enrolled) {
  const tiers = carrierPlanLimits.get(carrier);
  if (!tiers) return null;
  const n = Number(enrolled);
  return tiers.find((t) => n >= t.min && (t.max == null || n <= t.max)) || null;
}

/** The shipped catalogues, read from disk; a file that fails to read is logged and skipped. */
function shippedCatalogue() {
  const out = [];
  for (const f of CATALOGUE_FILES) {
    try {
      out.push(...parseCatalogueWorkbook(fs.readFileSync(path.join(__dirname, "data", "plan-docs", f.file)), { carrier: f.carrier, planYear: f.planYear, source: f.file }));
    } catch (e) {
      console.error(`plan catalogue: ${f.file}:`, e.message);
    }
  }
  return out;
}

/**
 * Load the catalogue: the shipped workbooks, then the database's rows on top
 * (a carrier with no rows yet is seeded from its workbook). Rebuilds the
 * index; the proposals pick the designs up on their next rebuild.
 */
async function loadPlanCatalogue() {
  const shipped = shippedCatalogue();
  let designs = shipped;
  if (!db) {
    const byKey = new Map(shipped.map((d) => [`${d.carrier}|${d.planYear}|${d.planCode}`, d]));
    for (const d of uploadedCatalogue) byKey.set(`${d.carrier}|${d.planYear}|${d.planCode}`, d);
    designs = [...byKey.values()];
  } else {
    try {
      let stored = await db.listCarrierDesigns();
      const have = new Set(stored.map((d) => `${d.carrier}|${d.planYear}`));
      const seed = shipped.filter((d) => !have.has(`${d.carrier}|${d.planYear}`));
      if (seed.length) {
        await db.upsertCarrierDesigns(seed, "system");
        console.log(`plan catalogue: seeded ${seed.length} design(s) from ${[...new Set(seed.map((d) => d.source))].join(", ")}`);
        stored = await db.listCarrierDesigns();
      }
      const byKey = new Map(shipped.map((d) => [`${d.carrier}|${d.planYear}|${d.planCode}`, d]));
      for (const d of stored) byKey.set(`${d.carrier}|${d.planYear}|${d.planCode}`, d);
      designs = [...byKey.values()];
    } catch (e) {
      console.error("plan catalogue:", e.message);
    }
  }
  for (const d of designs) {
    d.documents = {
      sbc: planDocuments.has(planDocKey(d.carrier, d.planYear, d.planCode, "SBC")),
      sob: planDocuments.has(planDocKey(d.carrier, d.planYear, d.planCode, "SOB")),
    };
  }
  planCatalogue = designs;
  planCatalogueIndex = catalogueIndex(designs);
  const per = {};
  for (const d of designs) per[d.carrier] = (per[d.carrier] || 0) + 1;
  console.log(`plan catalogue: ${designs.length} standard design(s) - ${Object.entries(per).map(([c, n]) => `${c} ${n}`).join(", ") || "none"}`);
}

/**
 * The shipped SBC/SOB PDFs, by carrier: the actual documents behind each
 * standard design in CATALOGUE_FILES above for Angle Health, and Gravie's
 * SBC library - Gravie has no catalogue of its own (its designs come off
 * each group's own proposal, not a shared workbook), so these are stored the
 * same way but never gain a `documents` flag on a catalogue design the way
 * Angle Health's do. Gravie's set was deduplicated once by year (2027
 * preferred, 2026 kept only where no 2027 SBC exists for that plan) and
 * renamed to carry no id token, so it reads with parseSimpleDocFilename
 * rather than Angle Health's id-bearing parseDocFilename.
 */
const PLAN_DOCUMENT_DIRS = [
  { dir: path.join(__dirname, "data", "plan-docs", "angle-health-sbc-sob"), carrier: "Angle Health", planYear: 2027 },
  { dir: path.join(__dirname, "data", "plan-docs", "gravie-sbc"), carrier: "Gravie", planYear: 2027, parse: parseSimpleDocFilename },
];
const planDocKey = (carrier, planYear, planCode, docType) => `${carrier}|${planYear}|${catalogueKey(planCode)}|${docType}`;
/** plan doc key -> metadata (no bytes): what loadPlanCatalogue checks to flag a design's documents. */
let planDocuments = new Map();
/** plan doc key -> { mime, data, filename }: shipped copies, served when there is no database or no row there yet. */
let planDocumentFallback = new Map();

/**
 * Load every carrier's SBC/SOB PDFs: the shipped files, then the database's
 * rows on top (a design with no rows yet is seeded from its shipped file).
 * Run before loadPlanCatalogue so a design's `documents` flag is accurate as
 * soon as the catalogue loads.
 */
async function loadPlanDocuments() {
  const shipped = PLAN_DOCUMENT_DIRS.flatMap((d) => loadPlanDocumentFiles(d.dir, d));
  planDocumentFallback = new Map(shipped.map((d) => [planDocKey(d.carrier, d.planYear, d.planCode, d.docType), { mime: d.mime, data: d.data, filename: d.filename }]));
  let meta = shipped.map(({ data: _d, ...m }) => ({ ...m, updatedAt: null, updatedBy: null }));
  if (db) {
    try {
      let stored = await db.listPlanDocuments();
      const have = new Set(stored.map((d) => planDocKey(d.carrier, d.planYear, d.planCode, d.docType)));
      const seed = shipped.filter((d) => !have.has(planDocKey(d.carrier, d.planYear, d.planCode, d.docType)));
      if (seed.length) {
        await db.upsertPlanDocuments(seed, "system");
        console.log(`plan documents: seeded ${seed.length} document(s) from ${[...new Set(seed.map((d) => d.source))].join(", ")}`);
        stored = await db.listPlanDocuments();
      }
      meta = stored;
    } catch (e) {
      console.error("plan documents:", e.message);
    }
  }
  planDocuments = new Map(meta.map((d) => [planDocKey(d.carrier, d.planYear, d.planCode, d.docType), d]));
  console.log(`plan documents: ${planDocuments.size} on file (${shipped.length} shipped)`);
}
/** The latest Employee Navigator carrier stats report, for reconciliation. */
let carrierStats = null;
/**
 * The latest monthly funding workbook: `lines` stays here on the server (it
 * names people); `view` is what the screens get.
 */
let funding = null;
const fundingView = (f) =>
  f
    ? {
        month: f.month,
        filename: f.filename,
        fileStamp: f.fileStamp,
        uploadedAt: f.uploadedAt,
        uploadedBy: f.uploadedBy,
        byInvoice: f.byInvoice,
        summary: f.summary,
        totals: fundingTotals(f),
      }
    : null;
function fundingTotals(f) {
  const invoices = Object.keys(f.byInvoice).length;
  const unassigned = Object.values(f.byInvoice).filter((a) => !a.group).length;
  const medical = f.lines.filter((l) => l.medical);
  const current = medical.filter((l) => l.kind === "current");
  const sum = (arr) => Math.round(arr.reduce((n, l) => n + l.rate, 0) * 100) / 100;
  const assigned = Object.values(f.summary);
  return {
    lines: f.lines.length,
    medicalLines: current.length,
    /** The month's own medical billing, every invoice, filed or not. */
    medicalMonthly: sum(current),
    /** Retro adds and credits on top of it. */
    adjustments: sum(medical.filter((l) => l.kind !== "current")),
    retroLines: medical.filter((l) => l.kind === "retro").length,
    creditLines: medical.filter((l) => l.kind === "credit").length,
    otherMonthly: sum(f.lines.filter((l) => !l.medical)),
    /** Distinct people billed medical this month, every invoice. */
    participantsAll: new Set(current.map((l) => `${l.invoice}|${l.familyId || l.participant}`)).size,
    /** …and on the invoices filed under a group. */
    participants: assigned.reduce((n, g) => n + g.medical.participants, 0),
    assignedMedicalMonthly: Math.round(assigned.reduce((n, g) => n + g.medical.monthly, 0) * 100) / 100,
    invoices,
    assigned: invoices - unassigned,
    unassigned,
  };
}

// The date almost every group's elections take effect. A group on its own
// cycle gets its own `effectiveDate` in group_meta instead (see setMeta);
// this is only the fallback everyone else reads.
const DEFAULT_EFFECTIVE_DATE = "2027-01-01";
/** "2027-01-01" -> "January 1, 2027", parsed as UTC so the server's own timezone never shifts the day. */
const fmtEffectiveDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The Welcome page's copy, written once for every group of a status - one
 * set for Existing clients, one for New - on the admin Welcome Page tab and
 * kept in kennion.settings under WELCOME_KEY. Only the words live here; what
 * is dynamic (the group's name and effective date, its team, where each step
 * links, when it last submitted) still comes from the group. A field staff
 * have not saved falls back to these defaults, so a field added later reads
 * sensibly before anyone has written it.
 */
const WELCOME_KEY = "welcomeCopy";
const WELCOME_STATUSES = ["existing", "new"];
const WELCOME_SHARED = {
  headline: "",
  steps: [
    { title: "Compare Your\nMedical Plan Options", body: "Review the medical options Kennion obtained for your group." },
    { title: "Explore Your\nSupplemental Benefits", body: "Review your dental, vision, life and other supplemental options." },
    { title: "Build Your\nBenefits Strategy", body: "Work with Kennion and the AI Assistant to compare plans and model contributions." },
    { title: "Confirm Your\nGroup Selections", body: "Confirm the plans and benefits you want to offer." },
  ],
  closingHeading: "We Handle The Rest",
  closingBody:
    "Once your selections are finalized, Kennion coordinates Employee Navigator setup, carrier implementation, employee communications, open enrollment, and first-month premium setup.\n\nYour support continues year-round, with a dedicated team to help employees navigate their benefits and lighten HR’s workload.",
  closingTagline: "The right benefits for your team. Support every step of the way.",
  teamNote: "Questions along the way? Your Kennion team is here throughout the process.",
  footer:
    "Noted rates and benefits are obtained from carrier's available information not specifically provided for this tool, and are for discussion only. All rates are determined by the carrier and are not final until the group is enrolled with the carrier.",
};
const DEFAULT_WELCOME = {
  existing: {
    ...WELCOME_SHARED,
    intro:
      "As you prepare for your upcoming renewal, you will notice our medical program has evolved. Kennion's recent growth has unlocked new partnerships with major national Carriers and TPAs. Rather than a standard renewal, we shopped the market to bring these upgraded options directly to your group. We have paired your trusted Kennion team with intelligent technology to simplify complexity, improve decision-making, and ensure you find the best fit for your employees.",
  },
  // A New group's intro starts blank; staff write it as they bring groups on.
  new: { ...WELCOME_SHARED, intro: "" },
};
/** What staff have saved, by status. Whatever is missing reads from DEFAULT_WELCOME. */
let welcomeCopy = { existing: {}, new: {} };
async function loadWelcomeCopy() {
  if (!db) return;
  try {
    const stored = await db.getSetting(WELCOME_KEY);
    if (stored && typeof stored === "object") welcomeCopy = { existing: stored.existing || {}, new: stored.new || {} };
  } catch (e) {
    console.error("could not read the Welcome page copy:", e.message);
  }
}
/** The Welcome copy a group of this status reads: what staff saved, over the defaults. */
function welcomeFor(status) {
  const key = WELCOME_STATUSES.includes(status) ? status : "existing";
  const saved = welcomeCopy[key] || {};
  const base = DEFAULT_WELCOME[key];
  const out = {};
  for (const k of Object.keys(base)) out[k] = saved[k] !== undefined ? saved[k] : base[k];
  return out;
}
const WELCOME_LIMITS = { headline: 200, intro: 4000, closingHeading: 200, closingBody: 4000, closingTagline: 400, teamNote: 400, footer: 2000 };
/** Staff's form, cleaned: only known fields, strings trimmed, four steps. An error string when it will not do. */
function cleanWelcome(input) {
  if (!input || typeof input !== "object") return "Nothing to save.";
  const text = (v) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim();
  const out = {};
  for (const [k, max] of Object.entries(WELCOME_LIMITS)) {
    out[k] = text(input[k]);
    if (out[k].length > max) return `Keep the ${k} under ${max} characters.`;
  }
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (steps.length !== 4) return "How It Works needs exactly four steps.";
  out.steps = steps.map((st) => ({ title: text(st && st.title).slice(0, 120), body: text(st && st.body).slice(0, 600) }));
  if (out.steps.some((st) => !st.title)) return "Every How It Works step needs a title.";
  return out;
}

function rebuild() {
  const base = data.groups.filter((g) => (g.plans || []).length > 0);
  const merged = new Map(base.map((g) => [g.name, g]));
  // An imported group replaces the census row of the same name outright.
  for (const [name, g] of Object.entries(imported.groups || {})) merged.set(name, g);

  groups = [...merged.values()];

  // Derive a code for every group, then let any staff-assigned one win. Derived
  // codes are computed over the whole roster so they stay collision-free.
  const derived = assignCodes(groups.map((g) => g.name));

  // Old year-based codes (XXXX2027 format) are discarded. Every group gets a
  // new evergreen code from the derived set, even if it had an old code stored.
  // This ensures codes are unique and work year-to-year without change.
  const oldYearFormat = /^[A-Z]{4}\d{4}$/;
  const codesNeedingUpdate = new Set();
  Object.entries(meta).forEach(([name, m]) => {
    if (m && m.companyId && oldYearFormat.test(m.companyId)) {
      codesNeedingUpdate.add(name);
      // Delete the old code so it falls through to derived
      delete m.companyId;
    }
  });

  // Persist the deletion asynchronously so old codes are cleared from database
  if (codesNeedingUpdate.size > 0) {
    Promise.all(
      Array.from(codesNeedingUpdate).map((name) =>
        db ? db.setMeta(name, "companyId", null, "migration: discard old codes") : Promise.resolve()
      )
    ).catch((e) => console.error("Code update failed:", e.message));
  }

  const claimed = new Set(
    Object.values(meta).map((m) => m && m.companyId).filter(Boolean),
  );

  byCode = new Map();
  byToken = new Map();
  bySlug = new Map();
  groups.forEach((g) => {
    const m = meta[g.name] || {};
    // Hand-edited details win over whatever the export supplied, so a
    // correction survives the next import.
    Object.entries(m.fields || {}).forEach(([k, v]) => {
      if (v != null && v !== "") g[k] = v;
    });
    g.archived = !!m.archived;
    // Program eligibility: EBPA, HealthEZ or BCBS of Alabama, with enrollment.
    const el = eligibilityOf(g);
    g.eligible = el.eligible;
    g.programs = el.programs;
    g.carriersSeen = el.carriers;
    let code = m.companyId || derived.get(g.name);
    // A derived code must not shadow one a human assigned to another group.
    if (!m.companyId && claimed.has(code)) code = code.slice(0, 3) + "9" + code.slice(4);
    g.code = code;
    g.sizeCategory = m.sizeCategory || sizeFor(g.enrolled);
    g.broker = m.broker || defaultBroker(g.name);
    g.manager = m.manager || defaultManager(g.name);
    g.linkToken = m.linkToken || null;
    g.slug = groupSlug(g.name, code);
    // Renewal tracking: every group starts Open.
    g.renewal = m.renewal || "open";
    // Every group on file today came from an Employee Navigator import, so
    // Existing is the safe default; staff flip a group to New by hand.
    g.groupStatus = m.groupStatus || "existing";
    g.effectiveDate = m.effectiveDate || DEFAULT_EFFECTIVE_DATE;
    // How the name and date read on the group's own pages - copy only, set
    // on the admin Welcome Page tab. The official values above are untouched.
    g.displayName = m.displayName || null;
    g.effectiveDateLabel = m.effectiveDateLabel || null;
    // Archived, or not on a program carrier: the row stays for staff, but the
    // code is refused at sign-in.
    if (!g.archived && g.eligible) {
      byCode.set(code.toUpperCase(), g);
      byCode.set(legacyCodeFor(g.name).toUpperCase(), g);
      if (g.linkToken) byToken.set(g.linkToken, g);
      bySlug.set(g.slug, g);
    }
  });

  // Rows that are almost certainly the same client under two spellings. These
  // predate normalised matching; flagging them lets staff archive the stale one.
  const byNorm = new Map();
  groups.forEach((g) => {
    const k = normalizeName(g.name);
    byNorm.set(k, [...(byNorm.get(k) || []), g.name]);
  });

  adminGroups = groups.map((g) => ({
    name: g.name,
    code: g.code,
    sizeCategory: g.sizeCategory,
    sizeIsSet: !!(meta[g.name] || {}).sizeCategory,
    codeIsSet: !!(meta[g.name] || {}).companyId,
    broker: g.broker,
    brokerIsSet: !!(meta[g.name] || {}).broker,
    manager: g.manager || null,
    linkToken: g.linkToken || null,
    /** The proposal slots this group has. */
    slots: slotsForGroup(g),
    renewal: g.renewal,
    groupStatus: g.groupStatus,
    effectiveDate: g.effectiveDate,
    displayName: g.displayName,
    effectiveDateLabel: g.effectiveDateLabel,
    proposals: proposalCounts[g.name] || 0,
    invoice: invoiceByGroup[g.name] || null,
    address1: g.address1 || null,
    city: g.city || null,
    state: g.state || null,
    zip: g.zip || null,
    sic: g.sic || null,
    sicDesc: g.sicDesc || null,
    taxId: g.taxId || null,
    phone: g.phone || null,
    contacts: g.contacts || [],
    tpa: g.tpa,
    enrolled: g.enrolled,
    lives: g.lives,
    plans: classifyPlans(g),
    carrierHeads: g.carrierHeads || null,
    /** Set (an ISO time) when an import found no record of a census-only company and archived it. */
    notInExport: g.notInExport || null,
    ancillaryOnly: !!g.ancillaryOnly,
    /** This month's billing for the group, from the funding workbook. */
    funding: (funding && funding.summary[g.name]) || null,
    rates: g.rates,
    // Group health (EBPA + HealthEZ medical), all medical, supplemental lines
    // and the total. Census rows and older imports carry no `lines`, so their
    // supplemental is 0 and linesLoaded is false until the export is re-read.
    ...premiumBreakdown(g),
    lines: Array.isArray(g.lines) ? g.lines : [],
    imported: !!(imported.groups || {})[g.name],
    importedAt: importedAt[g.name] || null,
    archived: !!g.archived,
    eligible: !!g.eligible,
    programs: g.programs || [],
    carriersSeen: g.carriersSeen || [],
    corporationType: g.corporationType || null,
    situsState: g.situsState || null,
    enName: g.enName || null,
    duplicateOf: (byNorm.get(normalizeName(g.name)) || []).filter((n) => n !== g.name),
    editedFields: Object.keys((meta[g.name] || {}).fields || {}),
    pyStart: g.pyStart || null,
    pyEnd: g.pyEnd || null,
    members: undefined,
  }));
  // Any group without a link token gets one, once, and it is kept.
  void mintMissingTokens();
}

/**
 * Give every live group a permanent link token, once. Runs after a rebuild and
 * writes through to the database, so the address a client bookmarks survives a
 * deploy and an import.
 */
let mintingTokens = false;
async function mintMissingTokens() {
  if (mintingTokens) return;
  const want = groups.filter((g) => !g.linkToken && !g.archived && g.eligible);
  if (!want.length) return;
  mintingTokens = true;
  try {
    for (const g of want) {
      const token = newLinkToken();
      meta[g.name] = { ...(meta[g.name] || {}), linkToken: token };
      g.linkToken = token;
      byToken.set(token, g);
      if (db) await db.setMeta(g.name, "linkToken", token, "system");
    }
    rebuild();
  } catch (e) {
    console.error("could not mint link tokens:", e.message);
  } finally {
    mintingTokens = false;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The employer/employee split, built fresh from each member's own cost - 
 * not the value frozen on the group at the time of its last import. Once a
 * member carries employerCost/employeeCost (every import from here on),
 * a fix to how the split is derived applies immediately to every group
 * already in the database, the same way Eligible now does, with nothing
 * further to re-upload.
 */
function splitFromMembers(g) {
  const agg = {};
  for (const m of g.members || []) {
    if (m.employerCost == null || m.employeeCost == null || m.premium == null || !m.tier || !m.plan) continue;
    const planAgg = (agg[m.plan] = agg[m.plan] || {});
    const a = (planAgg[m.tier] = planAgg[m.tier] || { totalSum: 0, erSum: 0, eeSum: 0, n: 0 });
    a.totalSum += m.premium;
    a.erSum += m.employerCost;
    a.eeSum += m.employeeCost;
    a.n++;
  }
  const plans = Object.fromEntries(
    Object.entries(agg).map(([plan, tiers]) => [
      plan,
      Object.fromEntries(
        Object.entries(tiers).map(([tier, a]) => [
          tier,
          { total: round2(a.totalSum / a.n), er: round2(a.erSum / a.n), ee: round2(a.eeSum / a.n) },
        ]),
      ),
    ]),
  );
  if (!Object.keys(plans).length) return null;
  return {
    source: "Employee Navigator XML import - employer/employee cost as configured in payroll, averaged across everyone on a plan and tier",
    plans,
  };
}

const splitFor = (g) =>
  splitFromMembers(g) || (imported.splits || {})[g.name] || data.splits[g.name] || null;

/** A group's most recent Sign Up submission, or null if it has never sent one. */
async function latestSignup(name) {
  if (db) {
    const rows = await db.listSignups(name);
    return rows[0] || null;
  }
  return signups.find((s) => s.group_name === name) || null;
}

/** A signup row as the client reads it - a plain shortlist send, or the guided wizard's full renewal election. */
function shapeSignup(signup) {
  if (!signup) return null;
  return {
    plans: signup.plans,
    note: signup.note,
    submittedAt: signup.submitted_at,
    kind: signup.kind === "renewal" ? "renewal" : "shortlist",
    carrier: signup.carrier || null,
    // Dental/vision started as one plan (a bare string); a jsonb array is
    // what every row now holds, but this reads either so an old row - or
    // the in-memory fallback's plain JSON file - still displays.
    dental: Array.isArray(signup.dental) ? signup.dental : signup.dental ? [signup.dental] : [],
    vision: Array.isArray(signup.vision) ? signup.vision : signup.vision ? [signup.vision] : [],
    employerLife: signup.employer_life || null,
    signerName: signup.signer_name || null,
    signerTitle: signup.signer_title || null,
  };
}

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "hunter@kennion.com").trim().toLowerCase();

/**
 * Staff sign-in code. This repository is public, so a code written in it is
 * not a secret: any value that has ever been published here is refused.
 *
 * The code is kept in the database as a scrypt hash, not in an environment
 * variable, for two reasons: it survives a restart without anyone having to
 * configure the host, and it can be changed from inside the app. The first
 * time a database has no code, one strong code is minted and printed once in
 * the log - after that it stays put until it is changed from the Import tab.
 *
 * Setting ADMIN_CODE in the environment still wins, for anyone who would
 * rather manage it there.
 */
const PUBLISHED_CODES = new Set(["87878787", "12345678", "password", "changeme"]);
const envAdminCode = String(process.env.ADMIN_CODE || "").trim();
const envCodeUsable = !!envAdminCode && !PUBLISHED_CODES.has(envAdminCode.toLowerCase());

/** The credential in force: a code we hold in clear, or a hash to check against. */
let adminCred = null;

/** scrypt with a fresh salt, in the format `scrypt$<salt>$<key>`. */
function hashSecret(code) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(code), salt, 32, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`);
    });
  });
}

/** Check a code against a stored hash, in constant time for the comparison. */
function matchesHash(code, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return resolve(false);
    const salt = Buffer.from(parts[1], "base64url");
    const want = Buffer.from(parts[2], "base64url");
    crypto.scrypt(String(code), salt, want.length, (err, key) => {
      if (err) return resolve(false);
      resolve(key.length === want.length && crypto.timingSafeEqual(key, want));
    });
  });
}

/** Is this the staff sign-in code? Always does the work, right or wrong. */
async function checkAdminCode(code) {
  await adminCodeReady;
  if (!adminCred) return false;
  if (adminCred.kind === "plain") return sameSecret(code, adminCred.value);
  return matchesHash(code, adminCred.value);
}

/** The shipped first-code hash, or null when the file is absent or unreadable. */
function seedCodeHash() {
  try {
    const raw = fs.readFileSync(new URL("./data/admin-seed.json", import.meta.url), "utf8");
    const hash = String(JSON.parse(raw).hash || "");
    return /^scrypt\$[\w-]+\$[\w-]+$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

function announceCode(code) {
  const kept = db ? "It is kept, so it survives every restart from now on." : "This run only - there is no database to keep it in.";
  console.warn(
    [
      "",
      "  ┌───────────────────────────────────────────────────────────────┐",
      "  │  No staff sign-in code was set, so one has been made:         │",
      `  │      ${code.padEnd(57)}│`,
      `  │  ${kept.padEnd(61)}│`,
      "  │  Sign in with it, then change it under Two-Factor Sign-In     │",
      "  │  on the Import tab. You never need to touch the host.         │",
      "  └───────────────────────────────────────────────────────────────┘",
      "",
    ].join("\n"),
  );
}

/**
 * Settle on a credential before the first sign-in is answered. Every sign-in
 * awaits this, so there is no window where the code is not yet known. It is
 * run from boot, after the schema is in place, because on the very first
 * deploy the table it reads is created by that migration.
 */
let markAdminCodeReady;
const adminCodeReady = new Promise((r) => (markAdminCodeReady = r));

async function settleAdminCode() {
  if (envCodeUsable) {
    adminCred = { kind: "plain", value: envAdminCode };
    console.log("staff sign-in code: taken from ADMIN_CODE");
    return;
  }
  if (envAdminCode) {
    console.warn("ADMIN_CODE is a code published in this public repository. Refusing it.");
  }
  if (db) {
    try {
      const stored = await db.staffCodeHash(ADMIN_EMAIL);
      if (stored) {
        adminCred = { kind: "hash", value: stored };
        console.log("staff sign-in code: the one set from inside the app");
        return;
      }
    } catch (e) {
      console.error("could not read the stored sign-in code:", e.message);
    }
  }
  // A hash shipped with the code, so a fresh database has a way in that does
  // not depend on anyone reading a deploy log. It cannot be reversed into a
  // code, and it stops being used the moment a code is set from the app.
  const seeded = seedCodeHash();
  if (seeded) {
    adminCred = { kind: "hash", value: seeded };
    if (db) {
      try {
        await db.saveStaffCodeHash(ADMIN_EMAIL, seeded);
      } catch (e) {
        console.error("could not keep the seeded sign-in code:", e.message);
      }
    }
    console.log("staff sign-in code: the shipped first code. Change it under Sign-In Code on the Import tab.");
    return;
  }
  const minted = crypto.randomBytes(9).toString("base64url");
  adminCred = { kind: "plain", value: minted };
  if (db) {
    try {
      const hash = await hashSecret(minted);
      await db.saveStaffCodeHash(ADMIN_EMAIL, hash);
      adminCred = { kind: "hash", value: hash };
    } catch (e) {
      console.error("could not keep the minted sign-in code:", e.message);
    }
  }
  announceCode(minted);
}

/**
 * Two-factor enrolment. Kept in the database so it survives a deploy; in
 * memory when there is none, which is enough for a local run.
 */
const memStaffAuth = new Map();
const staffAuthStore = {
  async get(email) {
    if (db) return db.staffAuth(email);
    return memStaffAuth.get(email) || null;
  },
  async save(email, rec) {
    if (db) return db.saveStaffAuth(email, rec);
    memStaffAuth.set(email, {
      email,
      totp_secret: rec.totpSecret || null,
      confirmed_at: rec.confirmedAt || null,
      recovery: rec.recovery || [],
    });
  },
};

/**
 * A sign-in that has passed the code but still owes a second factor. Short
 * lived and single use, so the first factor cannot be replayed later.
 */
const pending2fa = new Map();
const PENDING_MS = 5 * 60 * 1000;
function mintPending(email) {
  const id = crypto.randomBytes(18).toString("base64url");
  pending2fa.set(id, { email, exp: Date.now() + PENDING_MS });
  for (const [k, v] of pending2fa) if (v.exp < Date.now()) pending2fa.delete(k);
  return id;
}

/** Compare two secrets without leaking their length or contents through timing. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    // Still do the work, so a wrong length is not faster than a wrong value.
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}
/**
 * Staff sessions. Import endpoints must not accept the admin code on every
 * call, so signing in mints a short-lived bearer token held in memory.
 * Single-instance by design; a restart signs staff out, which is acceptable
 * for an internal rate desk.
 */
const sessions = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000;

function mintSession(email) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { exp: Date.now() + SESSION_MS, email });
  return token;
}
function requireStaff(req, res, next) {
  const t = (req.get("authorization") || "").replace(/^Bearer /i, "").trim();
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) {
    sessions.delete(t);
    return res.status(401).json({ error: "sign in again" });
  }
  req.staffEmail = s.email;
  next();
}

const app = express();
app.disable("x-powered-by");
// Railway terminates TLS, so the caller's address arrives in the forwarded
// header; trusting one hop makes req.ip the client rather than the proxy.
app.set("trust proxy", 1);
app.use(compression());

/**
 * Headers every response carries. A group's address holds its token, so the
 * referrer is kept off outbound requests entirely - otherwise a click on any
 * external link would hand the token to whoever it went to. The rest are the
 * ordinary defences: no framing, no MIME sniffing, HSTS once TLS is on.
 */
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  if (req.secure || req.get("x-forwarded-proto") === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  // Nothing on a signed-in page belongs in a shared cache or a proxy.
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

/** What a staff session sees: the PII-free rate projection and its bookkeeping. */
/**
 * The audit runs itself: after every upload and at boot, the computed result
 * is refreshed, and once all three files are in Claude reads it - once per
 * combination of uploads, the read kept in the database.
 */
let audit = null;
let auditReadInFlight = null;
async function refreshAudit() {
  const lastImport = recentImports[0] || null;
  const result = runAudit({ groups: adminGroups, carrierStats, funding, lastImport });
  const fingerprint = auditFingerprint({ carrierStats, funding, lastImport });
  const prior = audit && audit.fingerprint === fingerprint ? audit : null;
  let read = prior ? prior.read : null;
  let readAt = prior ? prior.readAt : null;
  if (!prior && db) {
    try {
      const saved = await db.getAudit(fingerprint);
      if (saved && saved.read) {
        read = saved.read;
        readAt = saved.createdAt;
      }
    } catch (e) {
      console.error("could not load the audit:", e.message);
    }
  }
  audit = { ...result, fingerprint, read, readAt, reading: false };
  if (db) {
    try {
      await db.saveAudit(fingerprint, result, read);
    } catch (e) {
      console.error("could not save the audit:", e.message);
    }
  }
  // The per-group data check runs on the same occasions - boot and every
  // upload - and its result is kept beside the snapshot audit in Postgres,
  // one row per state of the data, so what was found and when is never lost.
  await keepDataCheck();
  if (result.complete && !read && aiEnabled() && auditReadInFlight !== fingerprint) {
    auditReadInFlight = fingerprint;
    audit.reading = true;
    const payload = {
      files: result.files,
      portal: result.portal,
      carriers: result.carriers.map((c) => ({ carrier: c.carrier, report: c.report, portal: c.portal, diff: c.diff, pct: c.pct, ok: c.ok })),
      billing: result.billing && {
        month: result.billing.month,
        groups: result.billing.groups,
        matches: result.billing.matches,
        unassignedInvoices: result.billing.unassigned,
        differ: result.billing.rows.filter((r) => r.ok === false || r.noBilling),
      },
      unfiledInvoices: funding ? Object.entries(funding.byInvoice).filter(([, a]) => !a.group).map(([inv, a]) => ({ invoice: inv, orgs: a.orgs, lines: a.total })) : [],
      diagnostics: lastImport ? lastImport.diagnostics : null,
    };
    explainAudit(payload)
      .then(async (text) => {
        if (audit && audit.fingerprint === fingerprint) {
          audit.read = text;
          audit.readAt = new Date().toISOString();
          audit.reading = false;
        }
        if (db) await db.saveAudit(fingerprint, result, text);
      })
      .catch((e) => {
        console.error("audit read failed:", e.message);
        if (audit && audit.fingerprint === fingerprint) {
          audit.reading = false;
          audit.readError = e.message;
        }
      })
      .finally(() => {
        if (auditReadInFlight === fingerprint) auditReadInFlight = null;
      });
  }
  return audit;
}

function adminPayload() {
  return {
    kind: "admin",
    ai: aiEnabled(),
    audit,
    carrierStats,
    funding: fundingView(funding),
    managers: MANAGERS,
    ratesLock: ratesLock || { locked: false },
    durable: !!db || DURABLE,
    storage: db ? "postgres" : DURABLE ? "volume" : "ephemeral",
    overrides,
    imports: recentImports,
    meta: data.meta,
    groups: adminGroups,
    planDesigns: data.planDesigns,
  };
}

/**
 * Sign-in throttle. A code is four letters from the company name plus the plan
 * year, so it is guessable by anyone who knows the client list; without this,
 * codes could simply be enumerated. Counted per caller and per code tried, in
 * memory - one server, and a restart only ever forgives.
 */
/**
 * A group's session is a cookie, so its address can be short - the company
 * and its code, `/johnson-storage-moving-jsmh2027/options` - with no token in
 * the bar. The cookie holds the group's link token signed with a secret kept
 * in settings (or made per process without a database); HttpOnly, so no
 * script reads it, SameSite=Lax, so no other site sends it, and it dies with
 * the link token when a new link is minted.
 */
const GROUP_COOKIE = "kennion_group";
const GROUP_COOKIE_DAYS = 30;
let groupCookieSecret = crypto.randomBytes(32).toString("base64url");
async function loadGroupCookieSecret() {
  if (!db) return;
  try {
    let secret = await db.getSetting("groupCookieSecret");
    if (!secret || typeof secret !== "string") {
      secret = groupCookieSecret;
      await db.setSetting("groupCookieSecret", secret, "system");
    }
    groupCookieSecret = secret;
  } catch (e) {
    console.error("could not read the session secret; group sessions will not survive a deploy:", e.message);
  }
}
const signToken = (token) => crypto.createHmac("sha256", groupCookieSecret).update(token).digest("base64url");
function readCookies(req) {
  const out = {};
  String(req.get("cookie") || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
/** The group whose session cookie the request carries, if it is intact and still valid. */
function groupFromCookie(req) {
  const raw = readCookies(req)[GROUP_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const token = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const want = signToken(token);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return byToken.get(token) || null;
}
const isSecure = (req) => req.secure || req.get("x-forwarded-proto") === "https";
function setGroupCookie(req, res, g) {
  if (!g.linkToken) return;
  const attrs = [
    `${GROUP_COOKIE}=${g.linkToken}.${signToken(g.linkToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${GROUP_COOKIE_DAYS * 24 * 3600}`,
  ];
  if (isSecure(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}
function clearGroupCookie(req, res) {
  const attrs = [`${GROUP_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

/**
 * The group a client request speaks for: a permanent-link token, an access
 * code, or - with neither - the session cookie. Only a token or a code is a
 * guess worth counting against the caller.
 */
function groupFromRequest(req) {
  const body = req.body || {};
  const token = String(body.token || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (token) return { g: byToken.get(token) || null, guessed: true };
  if (code) return { g: byCode.get(code) || null, guessed: true };
  return { g: groupForPage(req), guessed: false };
}

/**
 * The group a page is showing, for every request that page makes. The page
 * names its own group in a header with that group's own credential (its
 * permanent-link token or its access code), and that wins over the cookie:
 * the cookie is one per browser, so a staff member with two groups open in
 * two tabs would otherwise have the second tab's sign-in answer the first
 * tab's questions with the wrong group's figures. A header that names no
 * real group is refused outright rather than falling back to the cookie.
 */
function groupForPage(req) {
  const token = String(req.get("x-kennion-group-token") || "").trim();
  const code = String(req.get("x-kennion-group-code") || "").trim().toUpperCase();
  if (token) return byToken.get(token) || null;
  if (code) return byCode.get(code) || null;
  return groupFromCookie(req);
}

const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
const SIGNIN_MAX_FAILS = 10;
const signinFails = new Map();
function signinKey(req) {
  const fwd = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
  return fwd || req.ip || "unknown";
}
function throttled(key) {
  const now = Date.now();
  const hits = (signinFails.get(key) || []).filter((t) => now - t < SIGNIN_WINDOW_MS);
  if (hits.length) signinFails.set(key, hits);
  else signinFails.delete(key);
  return hits.length >= SIGNIN_MAX_FAILS;
}
function noteFail(key) {
  const now = Date.now();
  const hits = (signinFails.get(key) || []).filter((t) => now - t < SIGNIN_WINDOW_MS);
  hits.push(now);
  signinFails.set(key, hits);
  // Keep the map from growing without bound on a long-running server.
  if (signinFails.size > 5000) {
    for (const [k, v] of signinFails) if (!v.some((t) => now - t < SIGNIN_WINDOW_MS)) signinFails.delete(k);
  }
}
const clearFails = (key) => signinFails.delete(key);

app.post("/api/signin", async (req, res) => {
  const body = req.body || {};
  const caller = signinKey(req);
  if (throttled(caller)) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  }

  // Staff sign-in: email + code. One generic failure for either field, so a
  // wrong guess reveals nothing about which half was right.
  if (body.email != null) {
    const email = String(body.email).trim().toLowerCase();
    const code = String(body.code || "").trim();
    // Both halves are always checked, so a wrong email is not faster than a
    // wrong code.
    const rightEmail = sameSecret(email, ADMIN_EMAIL);
    const rightCode = await checkAdminCode(code);
    if (!rightEmail || !rightCode) {
      noteFail(caller);
      console.warn(`staff sign-in refused for ${email || "(no email)"} from ${caller}`);
      return res.status(401).json({ error: "invalid credentials" });
    }
    // The code is right; if two-factor is set up, it is not enough on its own.
    try {
      const auth = await staffAuthStore.get(email);
      if (auth && auth.totp_secret && auth.confirmed_at) {
        console.log(`staff first factor accepted, second factor owed: ${email} from ${caller}`);
        return res.json({ kind: "staff-2fa", pending: mintPending(email) });
      }
      clearFails(caller);
      console.log(`staff signed in: ${email} from ${caller} (no second factor set up)`);
      return res.json({ ...adminPayload(), token: mintSession(email), twoFactor: "not-set-up" });
    } catch (e) {
      console.error("could not read two-factor enrolment:", e.message);
      return res.status(500).json({ error: "Could not check two-factor enrolment." });
    }
  }

  // A group's permanent link carries a token instead of a code; a browser
  // that already signed in carries neither, just the session cookie.
  const { g, guessed } = groupFromRequest(req);
  if (!g) {
    if (!guessed) return res.status(401).json({ error: "no session" });
    noteFail(caller);
    return res.status(404).json({ error: "no such group" });
  }
  clearFails(caller);
  setGroupCookie(req, res, g);

  const signup = await latestSignup(g.name);
  const invoice = await latestInvoiceFor(g.name).catch(() => null);

  return res.json({
    kind: "group",
    meta: data.meta,
    group: clientGroupView(g),
    planDesigns: data.planDesigns,
    // The carrier menu and this group's own quoted rows. No other company's
    // name, enrollment, premium or notes travels in a group's payload.
    uhc: clientUhc(g),
    // Only this group's contribution split, when Employee Navigator has one.
    splits: splitFor(g) ? { [g.name]: splitFor(g) } : {},
    overrides: overridesFor(g.name),
    // The carrier proposals on file for this group - plans and tier rates as
    // read off the documents - and this month's billing, counts and rates only.
    proposals: clientAvailablePlans(g.name),
    slots: slotsForGroup(g),
    funding: fundingSnapshot(g.name),
    // This month's invoice, if one is filed: enough to offer the link, not the file.
    invoice: invoice
      ? {
          month: (invoice.context && invoice.context.month) || null,
          filename: invoice.filename,
          uploadedAt: invoice.uploaded_at,
          // The Charge Summary's product rows - product, tier and headcount, no
          // names - so the client's page can say what else is in force.
          products: Array.isArray(invoice.extracted && invoice.extracted.products)
            ? invoice.extracted.products.map((r) => ({ product: r.product, coverage: r.coverage, count: r.count ?? null }))
            : [],
        }
      : null,
    linkToken: g.linkToken || null,
    slug: g.slug,
    // Whether the assistant can answer: the chat box only shows when it can.
    assistant: assistantEnabled(),
    // Who to call. The manager key itself is Kennion's bookkeeping; only the
    // contact details travel to the client.
    accountManager: managerContact(g.manager),
    // The licensed broker on every client's team card, beside the manager.
    broker: brokerContact(),
    // The group's most recent submission, if it has ever sent one, so the
    // Sign Up page can say so instead of showing a blank form again.
    signup: shapeSignup(signup),
  });
});

/**
 * Short-code sign-in: app.kennion.com/ADOB47 sets the cookie and serves the SPA at that address.
 * The code is evergreen and never changes year-to-year. Throttled like other
 * sign-ins to prevent brute-force guessing.
 */
// Express 5's path syntax has no inline patterns ("/:code(...)" throws at
// boot), so the short-link route is a regular expression: four letters and
// two digits, any case, captured as params[0].
app.get(/^\/([A-Za-z]{4}\d{2})$/, (req, res, next) => {
  const code = String(req.params[0]).trim().toUpperCase();

  // If the cookie is already set to a valid group, skip signin and serve the SPA.
  const existingGroup = groupFromCookie(req);
  if (existingGroup) return next();

  const caller = signinKey(req);

  if (throttled(caller)) {
    return res.status(429).redirect("/");
  }

  const g = byCode.get(code);
  if (!g) {
    noteFail(caller);
    return res.redirect("/");
  }

  clearFails(caller);
  setGroupCookie(req, res, g);
  // Fall through to the SPA to serve the page at this short-code address.
  // Do not redirect; the browser stays at the canonical short-code URL.
  return next();
});

/**
 * A group's own invoice, the PDF itself, opened in a new tab from Your 2026
 * Medical Plans. The session cookie is the only credential accepted, so the
 * address carries nothing secret and can be a plain link.
 */
/**
 * The group's own invoice. The link names the group (its access code, the
 * same credential that signed it in) rather than trusting the cookie alone:
 * a staff member with several groups open, or a cookie left from an earlier
 * sign-in, must never be handed another group's invoice. Before serving, the
 * file's own name is matched back to the roster: if it names a different
 * company than the row it is filed under, it is refused and logged.
 */
app.get("/api/group/invoice", async (req, res) => {
  const code = String(req.query.code || "").trim().toUpperCase();
  let g = null;
  if (code) {
    const caller = signinKey(req);
    if (throttled(caller)) return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
    g = byCode.get(code) || null;
    if (!g) {
      noteFail(caller);
      return res.status(404).json({ error: "no such group" });
    }
    clearFails(caller);
  } else {
    g = groupFromCookie(req);
  }
  if (!g) return res.status(401).json({ error: "no session" });
  const inv = await latestInvoiceFor(g.name).catch(() => null);
  if (inv) {
    const named = invoiceGroupFromFilename(inv.filename);
    if (named && named !== g.name) {
      console.error(`invoice #${inv.id} is filed under ${g.name} but its file names ${named}; refused`);
      return res.status(409).json({ error: "This invoice is filed under the wrong group. Kennion has been notified." });
    }
  }
  const f = inv ? await proposalStore.getProposalFile(inv.id).catch(() => null) : null;
  if (!f) return res.status(404).json({ error: "No invoice on file." });
  res.setHeader("Content-Type", f.mime || "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${f.filename.replace(/"/g, "")}"`);
  res.send(f.data);
});

/** End a group's cookie session. */
app.post("/api/signout", (req, res) => {
  clearGroupCookie(req, res);
  res.json({ ok: true });
});

/**
 * A group's own Sign Up page: which of the 2027 options it shortlisted, and
 * any note, submitted back to Kennion. No staff token - the same code or
 * token that gets a group its data is what lets it submit, same as sign-in - 
 * so it shares that endpoint's rate limit against guessing.
 *
 * Submitting also moves a group's renewal from Open to Sent, the one status
 * change a client rather than staff can make, and only that one step: a
 * group already marked Renewed or Non-renewed is not moved backwards by a
 * second submission.
 */
/**
 * A support ticket from the portal: priority, requester email, subject,
 * description and one optional attachment. Stored, then emailed to Kennion
 * through Resend (the RESEND / Resend key on the service). A failed email is
 * recorded on the row and logged; the client still sees the ticket accepted.
 */
const SUPPORT_TO = (process.env.SUPPORT_TO || "hunter@kennion.com,support@kennion.com").split(",").map((x) => x.trim()).filter(Boolean);
// site.kennion.com is the domain verified in Resend; kennion.com itself is not.
const SUPPORT_FROM = process.env.SUPPORT_FROM || "BenSync Support <support@site.kennion.com>";
const RESEND_KEY = process.env.RESEND_API_KEY || process.env.Resend || process.env.RESEND || "";
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function sendSupportEmail(t, g) {
  if (!RESEND_KEY) throw new Error("no Resend key on the service");
  const lines = [
    ["Group", g.name],
    ["Priority", t.priority],
    ["Requester", t.requester],
    ["Manager", typeof g.manager === "string" ? g.manager : (g.manager && g.manager.name) || "-"],
  ];
  const html = `<div style="font:14px/1.5 'Google Sans Flex',-apple-system,Segoe UI,Roboto,sans-serif;color:#222">
    <h2 style="margin:0 0 12px;font-size:17px">Support ticket ${ticketRef(t.id)} · ${escapeHtml(g.name)}</h2>
    <table style="border-collapse:collapse;margin-bottom:14px">${lines.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${k}</td><td style="padding:2px 0"><b>${escapeHtml(v)}</b></td></tr>`).join("")}</table>
    <div style="font-weight:600;margin-bottom:4px">${escapeHtml(t.subject)}</div>
    <div style="white-space:pre-wrap;border-left:3px solid #1F8A5B;padding-left:12px">${escapeHtml(t.description)}</div>
    <p style="margin-top:18px;color:#888;font-size:12px">Sent from the BenSync client portal · ${ticketRef(t.id)}</p>
  </div>`;
  const body = {
    from: SUPPORT_FROM,
    to: SUPPORT_TO,
    reply_to: t.requester,
    subject: `[${ticketRef(t.id)} · ${t.priority}] ${g.name}: ${t.subject}`,
    html,
    text: `Support ticket ${ticketRef(t.id)}\nGroup: ${g.name}\nPriority: ${t.priority}\nRequester: ${t.requester}\n\n${t.subject}\n\n${t.description}`,
  };
  if (t.file) body.attachments = [{ filename: t.file.name, content: t.file.base64 }];
  const send = async (b) => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Resend ${r.status}: ${text.slice(0, 300)}`);
  };
  try {
    await send(body);
  } catch (e) {
    // Until kennion.com is verified in Resend, its built-in sender still
    // delivers to the account owner: the ticket reaches Hunter either way.
    if (!/not verified/i.test(e.message)) throw e;
    console.error("support email: kennion.com is not verified in Resend; sending from onboarding@resend.dev to", SUPPORT_TO[0]);
    await send({ ...body, from: "BenSync Support <onboarding@resend.dev>", to: [SUPPORT_TO[0]] });
  }
}

/**
 * The guided Sign Up wizard's completed election, emailed to Kennion the
 * moment a group renews - same Resend path and recipients as a support
 * ticket, so the whole team sees it land without anyone checking a screen.
 */
async function sendRenewalEmail(e, g) {
  if (!RESEND_KEY) throw new Error("no Resend key on the service");
  const verb = g.groupStatus === "new" ? "enrolled" : "renewed";
  const effective = fmtEffectiveDate(g.effectiveDate || DEFAULT_EFFECTIVE_DATE);
  const lines = [
    ["Group", g.name],
    ["Carrier/TPA", e.carrier || "-"],
    ["Medical plan(s)", e.plans.join(", ") || "-"],
    ["Dental", e.dental.join(", ") || "-"],
    ["Vision", e.vision.join(", ") || "-"],
    ["Employer Paid Life", e.employerLife || "-"],
    ["Signed by", `${e.signerName}${e.signerTitle ? `, ${e.signerTitle}` : ""}`],
    ["Signer email", e.signerEmail || "-"],
    ["Signer phone", e.signerPhone || "-"],
  ];
  const html = `<div style="font:14px/1.5 'Google Sans Flex',-apple-system,Segoe UI,Roboto,sans-serif;color:#222">
    <h2 style="margin:0 0 12px;font-size:17px">${escapeHtml(g.name)} has ${verb} - effective ${effective}</h2>
    <table style="border-collapse:collapse;margin-bottom:14px">${lines.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${k}</td><td style="padding:2px 0"><b>${escapeHtml(v)}</b></td></tr>`).join("")}</table>
    ${e.note ? `<div style="font-weight:600;margin-bottom:4px">Note from the group</div><div style="white-space:pre-wrap;border-left:3px solid #1F8A5B;padding-left:12px">${escapeHtml(e.note)}</div>` : ""}
    <p style="margin-top:18px;color:#888;font-size:12px">Submitted from the BenSync client portal · ${new Date(e.submittedAt).toLocaleString("en-US")}</p>
  </div>`;
  const text = `${g.name} has ${verb} - effective ${effective}\n\n${lines.map(([k, v]) => `${k}: ${v}`).join("\n")}${e.note ? `\n\nNote from the group:\n${e.note}` : ""}`;
  const body = { from: SUPPORT_FROM, to: SUPPORT_TO, reply_to: e.signerEmail || undefined, subject: `${g.name} has ${verb} - effective ${effective}`, html, text };
  const send = async (b) => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`Resend ${r.status}: ${t.slice(0, 300)}`);
  };
  try {
    await send(body);
  } catch (e2) {
    if (!/not verified/i.test(e2.message)) throw e2;
    await send({ ...body, from: "BenSync Support <onboarding@resend.dev>", to: [SUPPORT_TO[0]] });
  }
}

/** The reference a client sees: BS-1001 rather than a bare row number. */
const ticketRef = (id) => `BS-${1000 + Number(id)}`;

let supportTickets = [];
app.post("/api/group/support", express.json({ limit: "12mb" }), async (req, res) => {
  const body = req.body || {};
  const caller = signinKey(req);
  if (throttled(caller)) return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  const { g, guessed } = groupFromRequest(req);
  if (!g) {
    if (!guessed) return res.status(401).json({ error: "no session" });
    noteFail(caller);
    return res.status(404).json({ error: "no such group" });
  }
  const priority = PRIORITIES.includes(body.priority) ? body.priority : "Low";
  const requester = String(body.requester || "").trim().slice(0, 200);
  const subject = String(body.subject || "").trim().slice(0, 200);
  const description = String(body.description || "").trim().slice(0, 20000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requester)) return res.status(400).json({ error: "Enter the email address we should reply to." });
  if (!subject) return res.status(400).json({ error: "Give the ticket a subject." });
  if (!description) return res.status(400).json({ error: "Describe what you need." });
  let file = null;
  if (body.file && typeof body.file === "object" && typeof body.file.base64 === "string" && body.file.base64) {
    const name = String(body.file.name || "attachment").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    if (body.file.base64.length > 8 * 1024 * 1024 * 1.4) return res.status(413).json({ error: "Attachments up to 8 MB." });
    file = { name, base64: body.file.base64 };
  }
  let record;
  try {
    if (db) record = await db.addSupportTicket({ groupName: g.name, priority, requester, subject, description, attachment: file ? file.name : null });
    else {
      record = { id: supportTickets.length + 1, group_name: g.name, priority, requester, subject, submitted_at: new Date().toISOString() };
      supportTickets = [record, ...supportTickets];
    }
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  let emailed = true;
  try {
    await sendSupportEmail({ ...record, description, file }, g);
    if (db) await db.markSupportTicketEmailed(record.id, null);
  } catch (e) {
    emailed = false;
    console.error(`support ticket #${record.id} (${g.name}) stored but not emailed:`, e.message);
    if (db) await db.markSupportTicketEmailed(record.id, e.message).catch(() => {});
  }
  console.log(`support ticket #${record.id}: ${g.name} - ${priority} - ${subject}${emailed ? "" : " (email failed)"}`);
  res.json({ ok: true, id: record.id, ref: ticketRef(record.id), emailed });
});

/**
 * One carrier, one funding type: a group's 2027 plans all come from one
 * carrier, and with UnitedHealthcare all fully insured or all level funded
 * (never Gravie and UHC together, never UHC fully insured beside UHC level
 * funded). Each shortlisted plan ("UH3 · P4000i8021B", or a bare name) is
 * placed by the proposal it is on or the menu; the distinct carrier +
 * funding pairs are returned when there is more than one, else null. A
 * plan that cannot be placed does not count against the shortlist.
 */
const SLOT_BASIS = { "UHC Fully Insured": ["UnitedHealthcare", "Fully Insured"], "UHC Level Funded": ["UnitedHealthcare", "Level Funded"], Gravie: ["Gravie", "Level Funded"], Nationwide: ["Nationwide", "Level Funded"], Angle: ["Angle Health", "Level Funded"], Optimyl: ["Optimyl Health", "Self Funded"] };
/** Every distinct [carrier, funding] a shortlist resolves to, so signupMix can flag a mix and the plan-count limit below can read off the one carrier. */
function planBases(g, plans) {
  const key = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const byName = new Map();
  for (const pr of currentProposals[g.name] || []) {
    const basis = SLOT_BASIS[pr.slot];
    if (!basis) continue;
    for (const pl of pr.plans || []) {
      const funding = /fully/i.test(pl.planType || "") ? "Fully Insured" : /self/i.test(pl.planType || "") ? "Self Funded" : basis[1];
      byName.set(key(pl.name), [basis[0], funding]);
      if (pl.optionId) byName.set(key(pl.optionId), [basis[0], funding]);
    }
  }
  for (const m of (data.uhc || {}).menu || []) if (!byName.has(key(m.plan))) byName.set(key(m.plan), ["UnitedHealthcare", "Level Funded"]);
  byName.set(key("Surest Copay Plan"), ["UnitedHealthcare", "Level Funded"]);
  const bases = new Map();
  for (const raw of plans) {
    const m = /^([A-Z]{2}\d+)\s*·\s*(.+)$/.exec(raw);
    const basis = (m && (byName.get(key(m[1])) || byName.get(key(m[2])))) || byName.get(key(raw));
    if (basis) bases.set(`${basis[0]} ${basis[1]}`, basis);
  }
  return [...bases.values()];
}
function signupMix(g, plans) {
  const bases = planBases(g, plans);
  return bases.length > 1 ? bases.map(([c, f]) => `${c} ${f}`) : null;
}

app.post("/api/group/signup", express.json({ limit: "16kb" }), async (req, res) => {
  const body = req.body || {};
  const caller = signinKey(req);
  if (throttled(caller)) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  }
  const { g, guessed } = groupFromRequest(req);
  if (!g) {
    if (!guessed) return res.status(401).json({ error: "no session" });
    noteFail(caller);
    return res.status(404).json({ error: "no such group" });
  }
  clearFails(caller);

  const plans = Array.isArray(body.plans)
    ? [...new Set(body.plans.map((p) => String(p || "").trim()).filter(Boolean))].slice(0, 50).map((p) => p.slice(0, 200))
    : [];
  if (!plans.length) return res.status(400).json({ error: "Select at least one plan." });
  const mixed = signupMix(g, plans);
  if (mixed) return res.status(400).json({ error: `One carrier, one funding type: a group's 2027 plans all come from one carrier, and with UnitedHealthcare all fully insured or all level funded. This shortlist mixes ${mixed.join(" and ")}.` });
  const [basis] = planBases(g, plans);
  const tier = basis && planLimitFor(basis[0], g.enrolled);
  if (tier) {
    const cap = tier.maxWithUnderwriting ?? tier.maxPlans;
    if (plans.length > cap) {
      const uw = tier.maxWithUnderwriting ? ", even with underwriting approval" : "";
      return res.status(400).json({ error: `${basis[0]} allows up to ${cap} plan${cap === 1 ? "" : "s"} for a group this size (${g.enrolled} enrolled)${uw}. This shortlist has ${plans.length} - remove ${plans.length - cap} to send it.` });
    }
  }
  const note = String(body.note || "").trim().slice(0, 4000) || null;

  let record;
  try {
    if (db) {
      record = await db.addSignup(g.name, plans, note);
    } else {
      record = { id: signups.length + 1, group_name: g.name, plans, note, submitted_at: new Date().toISOString() };
      signups = [record, ...signups];
      saveSignups();
    }
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }

  // Open -> Sent, and nothing else: a group already marked Renewed or
  // Non-renewed keeps that status.
  if (!g.renewal || g.renewal === "open") {
    meta[g.name] = { ...(meta[g.name] || {}), renewal: "sent" };
    try {
      if (db) await db.setMeta(g.name, "renewal", "sent", `${g.name} (client sign-up)`);
    } catch (e) {
      console.error("could not record renewal status from sign-up:", e.message);
    }
    rebuild();
  }

  console.log(`sign-up received: ${g.name} - ${plans.length} plan(s)`);
  res.json({ ok: true, submittedAt: record.submitted_at });
});

/**
 * The guided Sign Up wizard's full election: medical carrier/plans, dental,
 * vision, the employer-paid life tier, and who signed for the group. Marks
 * the group Renewed outright (a shortlist send only ever reaches "sent" -
 * this is a completed election with a name and email attached to it) and
 * emails Kennion the same way a support ticket does.
 */
app.post("/api/group/renew", express.json({ limit: "16kb" }), async (req, res) => {
  const body = req.body || {};
  const caller = signinKey(req);
  if (throttled(caller)) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  }
  const { g, guessed } = groupFromRequest(req);
  if (!g) {
    if (!guessed) return res.status(401).json({ error: "no session" });
    noteFail(caller);
    return res.status(404).json({ error: "no such group" });
  }
  clearFails(caller);

  const plans = Array.isArray(body.plans)
    ? [...new Set(body.plans.map((p) => String(p || "").trim()).filter(Boolean))].slice(0, 50).map((p) => p.slice(0, 200))
    : [];
  if (!plans.length) return res.status(400).json({ error: "Select at least one medical plan." });
  const mixed = signupMix(g, plans);
  if (mixed) return res.status(400).json({ error: `One carrier, one funding type: a group's 2027 plans all come from one carrier, and with UnitedHealthcare all fully insured or all level funded. This selection mixes ${mixed.join(" and ")}.` });
  const [basis] = planBases(g, plans);
  const tier = basis && planLimitFor(basis[0], g.enrolled);
  if (tier) {
    const cap = tier.maxWithUnderwriting ?? tier.maxPlans;
    if (plans.length > cap) {
      const uw = tier.maxWithUnderwriting ? ", even with underwriting approval" : "";
      return res.status(400).json({ error: `${basis[0]} allows up to ${cap} plan${cap === 1 ? "" : "s"} for a group this size (${g.enrolled} enrolled)${uw}. This selection has ${plans.length} - remove ${plans.length - cap}.` });
    }
  }
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  // Up to 3 plans, or a single waive line - never both, the client already
  // enforces that, this just refuses anything larger than what it could send.
  const strList = (v, max) =>
    Array.isArray(v) ? [...new Set(v.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 3).map((x) => x.slice(0, max)) : [];
  const dental = strList(body.dental, 200);
  const vision = strList(body.vision, 200);
  const employerLife = str(body.employerLife, 100);
  const signerName = str(body.signerName, 200);
  const signerTitle = str(body.signerTitle, 200);
  const signerEmail = str(body.signerEmail, 200);
  const signerPhone = str(body.signerPhone, 60);
  const note = str(body.note, 4000);
  if (!dental.length) return res.status(400).json({ error: "Choose up to 3 dental options, or waive it." });
  if (!vision.length) return res.status(400).json({ error: "Choose up to 3 vision options, or waive it." });
  if (!employerLife) return res.status(400).json({ error: "Choose an Employer Paid Life option, or decline it." });
  if (!signerName) return res.status(400).json({ error: "Enter your name." });
  if (!signerTitle) return res.status(400).json({ error: "Enter your title." });
  if (!signerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!signerPhone || signerPhone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Enter a valid phone number." });
  if (!note) return res.status(400).json({ error: "Let your account manager know if there's anything to flag before 2027." });
  if (!body.attest) return res.status(400).json({ error: "Confirm you're authorized to make these elections for the group." });

  const carrier = basis ? basis[0] : null;
  const election = { plans, note, carrier, dental, vision, employerLife, signerName, signerTitle, signerEmail, signerPhone, signerIp: caller };

  let record;
  try {
    if (db) {
      record = await db.addRenewalElection(g.name, election);
    } else {
      record = {
        id: signups.length + 1,
        group_name: g.name,
        kind: "renewal",
        plans,
        note,
        carrier,
        dental,
        vision,
        employer_life: employerLife,
        signer_name: signerName,
        signer_title: signerTitle,
        signer_email: signerEmail,
        signer_phone: signerPhone,
        submitted_at: new Date().toISOString(),
      };
      signups = [record, ...signups];
      saveSignups();
    }
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }

  // A renewal election marks the group Renewed outright, whatever it was before.
  meta[g.name] = { ...(meta[g.name] || {}), renewal: "renewed" };
  try {
    if (db) await db.setMeta(g.name, "renewal", "renewed", `${g.name} (client sign-up)`);
  } catch (e) {
    console.error("could not record renewal status from sign-up:", e.message);
  }
  rebuild();

  let emailed = true;
  try {
    await sendRenewalEmail({ ...election, submittedAt: record.submitted_at }, g);
  } catch (e) {
    emailed = false;
    console.error(`renewal election for ${g.name} stored but not emailed:`, e.message);
  }

  console.log(`renewal election received: ${g.name} - ${carrier || "?"} - ${plans.length} plan(s), dental: ${dental.join(", ")}, vision: ${vision.join(", ")}, employer life: ${employerLife}, signed by ${signerName}${emailed ? "" : " (email failed)"}`);
  res.json({ ok: true, emailed, signup: shapeSignup(record) });
});

/**
 * The assistant. A group's conversations are its own: every client route
 * reads the session cookie and scopes to that group, the way the invoice
 * link does. Staff see every conversation from the admin, can try the
 * assistant as any group (those threads are kept apart from the client's),
 * and edit the playbook the assistant answers by. Without a database it all
 * lives in memory until the next deploy, which is enough to try it;
 * Postgres keeps it.
 */
function memoryChatStore() {
  const threads = new Map();
  const messages = new Map();
  const files = new Map();
  const memory = new Map();
  /** The assistant's plan picks per group, as the Medical Plans page shows them. */
  const recommendations = new Map();
  let nextThread = 1;
  let nextMessage = 1;
  let nextFile = 1;
  let nextMemory = 1;
  const own = (groupName, id, staff) => {
    const t = threads.get(Number(id));
    return t && t.groupName === groupName && t.staff === !!staff ? t : null;
  };
  const list = (t) => ({ ...t, messages: (messages.get(t.id) || []).length, preview: ((messages.get(t.id) || []).find((m) => m.role === "user") || {}).content || null });
  // A file is the group's when it hangs on one of its own conversations, or
  // it put the file in its Documents tab itself.
  const owned = (f, groupName) => {
    if (f.threadId != null) {
      const t = threads.get(f.threadId);
      return !!t && t.groupName === groupName && !t.staff;
    }
    return f.kept && f.groupName === groupName;
  };
  const shapeFile = (f) => {
    const t = f.threadId != null ? threads.get(f.threadId) : null;
    return { id: f.id, threadId: f.threadId, threadTitle: t ? t.title : null, filename: f.filename, mime: f.mime, size: f.size, role: f.role, createdAt: new Date(f.createdAt).toISOString() };
  };
  const byActivity = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.id - a.id);
  return {
    async listThreads(groupName) {
      return [...threads.values()]
        .filter((t) => t.groupName === groupName && !t.staff)
        .sort(byActivity)
        .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
    },
    async createThread(groupName, title, staff = false) {
      const now = new Date().toISOString();
      const t = { id: nextThread++, groupName, title: title || null, staff: !!staff, flaggedAt: null, flagNote: null, createdAt: now, updatedAt: now };
      threads.set(t.id, t);
      messages.set(t.id, []);
      return { id: t.id, title: t.title, staff: t.staff, createdAt: now, updatedAt: now };
    },
    async getThread(groupName, id, staff = false) {
      const t = own(groupName, id, staff);
      return t ? { id: t.id, title: t.title, staff: t.staff, createdAt: t.createdAt, updatedAt: t.updatedAt } : null;
    },
    async renameThread(groupName, id, title) {
      const t = own(groupName, id, false);
      if (!t) return null;
      t.title = title;
      return { id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt };
    },
    async deleteThread(groupName, id) {
      const t = own(groupName, id, false);
      if (!t) return false;
      threads.delete(t.id);
      messages.delete(t.id);
      for (const [fid, f] of files) if (f.threadId === t.id) files.delete(fid);
      return true;
    },
    async listMessages(threadId) {
      return [...(messages.get(Number(threadId)) || [])];
    },
    async addMessage(threadId, role, content, page, fs) {
      const m = { id: nextMessage++, role, content, page: page || null, files: fs || [], createdAt: new Date().toISOString() };
      messages.get(Number(threadId)).push(m);
      threads.get(Number(threadId)).updatedAt = m.createdAt;
      return m;
    },
    async addFile(threadId, filename, mime, data) {
      const f = { id: nextFile++, threadId: Number(threadId), groupName: null, role: "assistant", filename, mime, size: data.length, data, createdAt: Date.now(), kept: false };
      files.set(f.id, f);
      return { id: f.id, filename, mime, size: f.size };
    },
    async addPendingFile(groupName, filename, mime, data) {
      const f = { id: nextFile++, threadId: null, groupName, role: "user", filename, mime, size: data.length, data, createdAt: Date.now(), kept: false };
      files.set(f.id, f);
      return { id: f.id, filename, mime, size: f.size };
    },
    async addKeptFile(groupName, filename, mime, data) {
      const f = { id: nextFile++, threadId: null, groupName, role: "user", filename, mime, size: data.length, data, createdAt: Date.now(), kept: true };
      files.set(f.id, f);
      return shapeFile(f);
    },
    async listFiles(groupName) {
      return [...files.values()]
        .filter((f) => owned(f, groupName))
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
        .map(shapeFile);
    },
    async deleteFile(groupName, id) {
      const f = files.get(Number(id));
      if (!f || !(owned(f, groupName) || (f.threadId == null && f.groupName === groupName))) return false;
      files.delete(f.id);
      for (const m of messages.get(f.threadId) || []) m.files = (m.files || []).filter((x) => x.id !== f.id);
      return true;
    },
    async claimFiles(ids, groupName, threadId) {
      const out = [];
      for (const id of ids) {
        const f = files.get(Number(id));
        if (!f || f.threadId != null || f.groupName !== groupName) continue;
        f.threadId = Number(threadId);
        out.push({ id: f.id, filename: f.filename, mime: f.mime, size: f.size });
      }
      return out;
    },
    async sweepPendingFiles() {
      let n = 0;
      for (const [id, f] of files) if (f.threadId == null && !f.kept && Date.now() - f.createdAt > 86_400_000) files.delete(id) && n++;
      return n;
    },
    async listMemory(groupName) {
      return (memory.get(groupName) || []).map((m) => ({ ...m }));
    },
    async updateMemory(groupName, { add = [], removeIds = [], source = "client" } = {}) {
      let list = (memory.get(groupName) || []).filter((m) => !removeIds.includes(m.id));
      for (const text of add) if (!list.some((m) => m.text.toLowerCase() === text.toLowerCase())) list.push({ id: nextMemory++, text, source, createdAt: new Date().toISOString() });
      list = list.slice(-40);
      memory.set(groupName, list);
      return list.map((m) => ({ ...m }));
    },
    async getRecommendations(groupName) {
      const r = recommendations.get(groupName);
      return r ? { ...r } : null;
    },
    async setRecommendations(groupName, threadId, body) {
      recommendations.set(groupName, { ...body, threadId: threadId == null ? null : Number(threadId), createdAt: new Date().toISOString() });
      return this.getRecommendations(groupName);
    },
    async getFile(id) {
      const f = files.get(Number(id));
      if (!f) return null;
      const t = f.threadId != null ? threads.get(f.threadId) : null;
      return { ...f, groupName: t ? t.groupName : f.groupName, staff: t ? t.staff : false };
    },
    async adminListThreads({ group, q, flagged, limit = 500 } = {}) {
      const needle = (q || "").toLowerCase();
      return [...threads.values()]
        .filter((t) => !group || t.groupName === group)
        .filter((t) => !flagged || t.flaggedAt)
        .filter((t) => !needle || `${t.title || ""} ${t.groupName}`.toLowerCase().includes(needle) || (messages.get(t.id) || []).some((m) => m.content.toLowerCase().includes(needle)))
        .sort(byActivity)
        .slice(0, limit)
        .map(list);
    },
    async adminThread(id) {
      const t = threads.get(Number(id));
      return t ? { ...t } : null;
    },
    async flagThread(id, flagged, note) {
      const t = threads.get(Number(id));
      if (!t) return null;
      t.flaggedAt = flagged ? new Date().toISOString() : null;
      t.flagNote = flagged ? note || null : null;
      return { ...t };
    },
    async adminDeleteThread(id) {
      const t = threads.get(Number(id));
      if (!t) return false;
      threads.delete(t.id);
      messages.delete(t.id);
      for (const [fid, f] of files) if (f.threadId === t.id) files.delete(fid);
      return true;
    },
  };
}
const chatStore = db || memoryChatStore();
/** Threads with a reply in flight, so two sends on one thread do not interleave. */
const chatBusy = new Set();

/**
 * Kennion's guidance to the assistant - who it is, the rules, the house
 * answers - edited from the admin. Kept in settings with the last twenty
 * versions, so a change can be seen and undone.
 */
const PLAYBOOK_KEY = "assistant.playbook";
let playbook = { ...normalizePlaybook(DEFAULT_PLAYBOOK), updatedAt: null, updatedBy: null, history: [] };
async function loadPlaybook() {
  if (!db) return;
  try {
    const saved = await db.getSetting(PLAYBOOK_KEY);
    // A playbook saved as three text boxes reads in as lists.
    if (saved && typeof saved === "object") playbook = { ...normalizePlaybook(saved), updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null, history: (saved.history || []).map((h) => ({ ...normalizePlaybook(h), updatedAt: h.updatedAt || null, updatedBy: h.updatedBy || null })) };
  } catch (e) {
    console.error("could not load the assistant playbook:", e.message);
  }
}
const playbookView = () => ({
  persona: playbook.persona,
  rules: playbook.rules,
  facts: playbook.facts,
  faq: playbook.faq,
  defaults: normalizePlaybook(DEFAULT_PLAYBOOK),
  suggestions: RULE_SUGGESTIONS,
  updatedAt: playbook.updatedAt,
  updatedBy: playbook.updatedBy,
  history: (playbook.history || []).map((h) => ({ updatedAt: h.updatedAt, updatedBy: h.updatedBy, persona: h.persona, rules: h.rules, facts: h.facts, faq: h.faq })),
});

const CHAT_MESSAGE_MAX = 4000;
const threadId = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Everything the assistant is told about a group - the same view its pages get. */
async function assistantData(g) {
  const signup = await latestSignup(g.name);
  return {
    group: clientGroupView(g),
    proposals: clientAvailablePlans(g.name),
    funding: fundingSnapshot(g.name),
    manager: managerContact(g.manager),
    splits: splitFor(g) ? { [g.name]: splitFor(g) } : {},
    signup: shapeSignup(signup),
    renewal: g.renewal,
    planDesigns: data.planDesigns,
    census: censusProfile(g),
    benefitSummaries: BENEFIT_SUMMARIES,
    supplementalRates: SUPPLEMENTAL_RATES,
  };
}

/**
 * The group's people as aggregates only - average and range of employee
 * ages, how many are under 30 or 55 and over, how many carry a spouse or
 * children - so the assistant can say which plans suit the workforce.
 * Never a name, never one person's age: the census itself stays with staff.
 */
function censusProfile(g) {
  const members = Array.isArray(g.members) ? g.members : [];
  const ages = members.map((m) => Number(m.age)).filter((a) => Number.isFinite(a) && a > 0);
  if (!ages.length) return null;
  const sorted = [...ages].sort((a, b) => a - b);
  const mean = ages.reduce((s, a) => s + a, 0) / ages.length;
  const sd = Math.sqrt(ages.reduce((s, a) => s + (a - mean) ** 2, 0) / ages.length);
  const median = sorted[Math.floor(sorted.length / 2)];
  const band = (lo, hi) => ages.filter((a) => a >= lo && a <= hi).length;
  const spouses = members.filter((m) => Array.isArray(m.spAges) && m.spAges.length).length;
  const withChildren = members.filter((m) => Array.isArray(m.chAges) && m.chAges.length).length;
  const children = members.reduce((s, m) => s + (Array.isArray(m.chAges) ? m.chAges.length : 0), 0);
  const spread = sd < 8 ? "narrow" : sd < 13 ? "moderate" : "wide";
  return {
    employees: ages.length,
    average: Math.round(mean),
    median,
    youngest: sorted[0],
    oldest: sorted[sorted.length - 1],
    spread,
    bands: { under30: band(0, 29), from30to44: band(30, 44), from45to54: band(45, 54), from55: band(55, 200) },
    spouses,
    withChildren,
    children,
  };
}

/**
 * One turn, streamed as server-sent events: `thread` {id, title} first, then
 * `text` {text} as the answer arrives, `status` {text} while a document is
 * built, `file` {file} for each document made, `done` {message} with the
 * stored answer, or `error` {error}. The question is stored before the
 * model is asked; the answer once it is complete.
 */
async function streamTurn({ g, thread, content, page, compact = false, attachments = [], res }) {
  if (chatBusy.has(thread.id)) return res.status(409).json({ error: "Wait for the current answer to finish." });
  chatBusy.add(thread.id);
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // no-transform keeps the compression middleware from buffering the stream.
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };
  try {
    send("thread", { id: thread.id, title: thread.title });
    const attached = await chatStore.claimFiles(attachments, g.name, thread.id);
    const question = await chatStore.addMessage(thread.id, "user", content, page, attached);
    if (attached.length) send("question", { message: question });
    const history = await chatStore.listMessages(thread.id);
    const data = await assistantData(g);
    const memory = await chatStore.listMemory(g.name);
    const { text, files } = await replyTo({
      data,
      history,
      page,
      compact,
      playbook,
      memory,
      saveMemory: async (change) => {
        const list = await chatStore.updateMemory(g.name, { ...change, source: thread.staff ? "staff" : "client" });
        send("memory", { memory: list });
        return list;
      },
      // Plan picks go to the client's Medical Plans page - from the client's
      // own conversations only; a staff trial publishes nothing.
      savePicks: thread.staff
        ? null
        : async (record) => {
            const rec = await chatStore.setRecommendations(g.name, thread.id, record);
            send("recommendations", { recommendations: rec });
            return rec;
          },
      readFile: async (id) => {
        const f = await chatStore.getFile(id);
        return f && f.threadId === thread.id ? f : null;
      },
      onText: (t) => send("text", { text: t }),
      onStatus: (t) => send("status", { text: t }),
      keep: async (doc) => {
        const file = await chatStore.addFile(thread.id, doc.filename, doc.mime, doc.data);
        send("file", { file });
        return file;
      },
    });
    const message = await chatStore.addMessage(thread.id, "assistant", text, page, files);
    send("done", { message });
  } catch (e) {
    console.error(`assistant: ${g.name}:`, e.message);
    send("error", { error: e.message || "The assistant could not answer that. Try again." });
  } finally {
    chatBusy.delete(thread.id);
    res.end();
  }
}

/** Serve a document the assistant made, with the same headers whoever asks. */
function sendChatFile(res, f) {
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Length", String(f.size));
  res.setHeader("Content-Disposition", `attachment; filename="${f.filename.replace(/["\\]/g, "")}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.send(f.data);
}

app.get("/api/chat/threads", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  res.json({ threads: await chatStore.listThreads(g.name) });
});

/** The assistant's plan picks for the group, as the Medical Plans page shows them; null before it has given any. */
app.get("/api/chat/recommendations", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  res.json({ recommendations: await chatStore.getRecommendations(g.name) });
});

/**
 * What the Medical Plans grid is showing, as a file to keep: the AI Picks
 * view as the picks report (census, each pick's reason, the bills side by
 * side); any other view as a comparison of the plans showing. `plans` are
 * option IDs (or names); `contribution` the employer amount per tier the
 * page has applied, so the split matches the screen.
 */
const EXPORT_TITLES = { picks: "AI Picks", favorites: "Favorites", compare: "Comparison", all: "Plans" };
app.post("/api/group/export", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const body = req.body || {};
  const view = EXPORT_TITLES[body.view] ? body.view : "all";
  const contribution = {};
  let any = false;
  for (const k of ["EE", "ES", "EC", "FAM"]) {
    const v = Number(body.contribution && body.contribution[k]);
    if (Number.isFinite(v) && v >= 0) {
      contribution[k] = v;
      any = true;
    }
  }
  const group = clientGroupView(g);
  const proposals = clientAvailablePlans(g.name);
  let file;
  try {
    if (body.format === "changes") {
      // What's Changing For 2027: the group's 2026 plans beside its 2027
      // options, built from what is on file right now. Nothing from the page.
      file = await renderChangesReport({
        group,
        proposals,
        slots: slotsForGroup(g),
        manager: managerContact(g.manager),
        broker: brokerContact(),
        signup: await latestSignup(g.name).catch(() => null),
        assistant: assistantEnabled(),
      });
    } else if (body.format === "signup") {
      // A receipt of the group's most recent Sign Up submission - carrier,
      // plans, dental/vision, employer life, note and who signed - nothing
      // computed, just what is on file.
      const raw = await latestSignup(g.name).catch(() => null);
      const signup = shapeSignup(raw);
      if (!signup) return res.status(404).json({ error: "No election on file yet." });
      file = await renderSignupConfirmation({ group, signup, manager: managerContact(g.manager), broker: brokerContact() });
    } else if (body.format === "plan") {
      // One plan's card, as the page shows it; checked for shape and size.
      const c = body.card && typeof body.card === "object" ? body.card : null;
      const str = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
      const numv = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      if (!c || !str(c.title)) return res.status(400).json({ error: "Nothing to export: no plan." });
      const card = {
        title: str(c.title, 120),
        subtitle: str(c.subtitle, 200),
        carrier: str(c.carrier, 80),
        funding: str(c.funding, 40),
        type: str(c.type, 60),
        headline: { average: numv(c.headline && c.headline.average), companyPays: numv(c.headline && c.headline.companyPays), basis: str(c.headline && c.headline.basis, 40) },
        benefits: (Array.isArray(c.benefits) ? c.benefits.slice(0, 20) : []).map((b) => [str(b && b[0], 40) || "", str(b && b[1], 300) || "-", /^https?:\/\//.test(String(b && b[2] || "")) ? str(b[2], 300) : null]),
        tiers: (Array.isArray(c.tiers) ? c.tiers.slice(0, 6) : []).map((t) => ({ label: str(t && t.label, 40) || "", count: numv(t && t.count) || 0, rate: numv(t && t.rate), er: numv(t && t.er), ee: numv(t && t.ee) })),
        totals: { er: numv(c.totals && c.totals.er), ee: numv(c.totals && c.totals.ee), premium: numv(c.totals && c.totals.premium), enrolled: numv(c.totals && c.totals.enrolled) },
        audit: str(c.audit, 120),
      };
      file = await renderPlanCardPdf({ group, card });
    } else if (body.format === "xlsx") {
      // The workbook: the page sends the card's columns and rows; checked for shape and size, nothing else.
      const columns = Array.isArray(body.columns) ? body.columns.slice(0, 80).map((c) => String(c == null ? "" : c).slice(0, 80)) : [];
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 800) : [];
      if (!columns.length || !rows.length) return res.status(400).json({ error: "Nothing to export: no plans." });
      const cell = (v) => (v == null ? null : typeof v === "number" && Number.isFinite(v) ? v : String(v).slice(0, 400));
      const clean = rows.map((r) => (Array.isArray(r) ? columns.map((_, i) => cell(r[i])) : columns.map(() => null)));
      file = renderPlanSheet({ group, columns, rows: clean, contribution: any ? contribution : null });
    } else if (view === "picks") {
      const rec = await chatStore.getRecommendations(g.name);
      if (!rec || !Array.isArray(rec.picks) || !rec.picks.length) return res.status(404).json({ error: "No AI Picks yet - press AI Picks first." });
      file = await renderPicksReport({ group, proposals, recommendations: rec, contribution: any ? contribution : null });
    } else {
      const plans = (Array.isArray(body.plans) ? body.plans : []).map((x) => String(x || "").trim().slice(0, 120)).filter(Boolean).slice(0, 400);
      if (!plans.length) return res.status(400).json({ error: "Nothing to export: no plans showing." });
      // New options against each other: no rows for the plans in force today and no "vs today" column.
      const table = comparisonTable({ group, proposals, plans, includeCurrent: false, contribution: any ? contribution : null });
      table.todayTotal = null;
      for (const r of table.rows) r.vsToday = null;
      file = await renderComparison({ format: "pdf", title: `2027 Medical Options - ${EXPORT_TITLES[view]}`, group, table });
    }
  } catch (e) {
    console.error("export:", e);
    return res.status(500).json({ error: "Could not build that file." });
  }
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/"/g, "")}"`);
  res.send(file.data);
});

/**
 * The census every rate on the page is priced on, for the group's own HR
 * lead: each employee's name, age, coverage tier, plan and dependants' ages
 * from the enrollment data on file. Nothing else about anyone (no dates of
 * birth, no gender, no ZIP, no costs). As JSON for the Census page, or
 * `?format=csv` as a file. Read only: a correction goes through Kennion,
 * whose import is the source of truth.
 */
const CENSUS_TIER = { EE: "Employee", ES: "Employee+Spouse", EC: "Employee+Children", FAM: "Employee+Family" };
/** One row per person, the employee then their dependants, in the Employee Navigator census's own columns. */
const censusRows = (g) => {
  const members = (Array.isArray(g.members) ? g.members : []).slice().sort((a, b) => String(a.last || "").localeCompare(String(b.last || "")) || String(a.first || "").localeCompare(String(b.first || "")));
  const rows = [];
  for (const m of members) {
    const tierKey = tierKeyOfCensus(m.tier);
    const tier = tierKey ? CENSUS_TIER[tierKey] : m.tier || null;
    rows.push({ first: m.first || "", last: m.last || "", relationship: "employee", gender: m.gender || null, dob: m.dob || null, age: Number.isFinite(Number(m.age)) ? Number(m.age) : null, zip: m.zip || null, tier });
    const deps = Array.isArray(m.deps) ? m.deps : null;
    if (deps) {
      for (const d of deps) rows.push({ first: d.first || "", last: d.last || m.last || "", relationship: String(d.rel || "dependent").toLowerCase(), gender: d.gender || null, dob: d.dob || null, age: null, zip: m.zip || null, tier });
    } else {
      // Imported before dependants were kept by name: ages only, until the stored export fills them in.
      for (const a of Array.isArray(m.spAges) ? m.spAges : []) rows.push({ first: "", last: m.last || "", relationship: "spouse", gender: null, dob: null, age: a, zip: m.zip || null, tier });
      for (const a of Array.isArray(m.chAges) ? m.chAges : []) rows.push({ first: "", last: m.last || "", relationship: "child", gender: null, dob: null, age: a, zip: m.zip || null, tier });
    }
  }
  return rows;
};
app.get("/api/group/census", (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const rows = censusRows(g);
  if (String(req.query.format || "") === "csv") {
    const cell = (v) => {
      const t = v == null ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const usDate = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "");
    const head = ["First Name", "Last Name", "Relationship", "Gender", "Date of Birth", "Zip Code", "Tier"];
    const lines = [head, ...rows.map((r) => [r.first, r.last, r.relationship, r.gender, usDate(r.dob), r.zip, r.tier])].map((r) => r.map(cell).join(","));
    const safe = String(g.name || "group").replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safe} - Census.csv"`);
    return res.send("\ufeff" + lines.join("\r\n"));
  }
  res.json({ enrolled: rows.filter((r) => r.relationship === "employee").length, rows });
});

/** What the assistant remembers about the group; the client can drop any line. */
app.get("/api/chat/memory", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  res.json({ memory: await chatStore.listMemory(g.name) });
});
/** The client adds a line of its own: one plain sentence, kept like the ones the assistant records. */
app.post("/api/chat/memory", express.json({ limit: "4kb" }), async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const text = String((req.body || {}).text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: "Write what to remember." });
  res.json({ memory: await chatStore.updateMemory(g.name, { add: [text], source: "client" }) });
});
app.delete("/api/chat/memory/:id", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "No such note." });
  res.json({ memory: await chatStore.updateMemory(g.name, { removeIds: [id] }) });
});
app.get("/api/admin/chat/memory", requireStaff, async (req, res) => {
  const group = String(req.query.group || "");
  if (!group) return res.status(400).json({ error: "group is required" });
  res.json({ memory: await chatStore.listMemory(group) });
});
app.post("/api/admin/chat/memory", requireStaff, express.json({ limit: "16kb" }), async (req, res) => {
  const body = req.body || {};
  const group = String(body.group || "");
  if (!group) return res.status(400).json({ error: "group is required" });
  const add = Array.isArray(body.add) ? body.add.map((t) => String(t).replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean) : [];
  const removeIds = Array.isArray(body.removeIds) ? body.removeIds.map(Number).filter(Number.isInteger) : [];
  res.json({ memory: await chatStore.updateMemory(group, { add, removeIds, source: "staff" }) });
});

app.get("/api/chat/threads/:id", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const id = threadId(req.params.id);
  const thread = id && (await chatStore.getThread(g.name, id));
  if (!thread) return res.status(404).json({ error: "No such conversation." });
  res.json({ thread, messages: await chatStore.listMessages(id) });
});

app.post("/api/chat/threads/:id", express.json({ limit: "4kb" }), async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const id = threadId(req.params.id);
  const title = String((req.body || {}).title || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!id || !title) return res.status(400).json({ error: "A title is needed." });
  const thread = await chatStore.renameThread(g.name, id, title);
  if (!thread) return res.status(404).json({ error: "No such conversation." });
  res.json({ thread });
});

app.delete("/api/chat/threads/:id", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const id = threadId(req.params.id);
  if (!id || !(await chatStore.deleteThread(g.name, id))) return res.status(404).json({ error: "No such conversation." });
  res.json({ ok: true });
});

/**
 * The group's Documents tab: every file the assistant made in its
 * conversations, every file the client attached to a question, and what
 * the client put here itself - one place, to download or remove.
 */
app.get("/api/chat/files", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  res.json({ files: await chatStore.listFiles(g.name) });
});
app.delete("/api/chat/files/:id", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const id = threadId(req.params.id);
  if (!id || !(await chatStore.deleteFile(g.name, id))) return res.status(404).json({ error: "No such file." });
  res.json({ ok: true });
});
/** A document the assistant made for this group, by the session cookie alone. */
app.get("/api/chat/files/:id", async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const f = threadId(req.params.id) && (await chatStore.getFile(Number(req.params.id)));
  if (!f || f.groupName !== g.name || f.staff) return res.status(404).json({ error: "No such file." });
  sendChatFile(res, f);
});

/**
 * A file the client wants to show the assistant - another broker's quote, a
 * spreadsheet, a screenshot. Uploaded on its own first (the body is the file,
 * the name in the query), held for the group, and claimed by the message
 * that sends it. The same kinds the proposal reader takes.
 */
const CHAT_ATTACHMENT_MAX = 15 * 1024 * 1024;
app.post("/api/chat/attachments", express.raw({ type: () => true, limit: CHAT_ATTACHMENT_MAX }), async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const filename = String(req.query.filename || "").replace(/[\\/]/g, "_").trim().slice(0, 200) || "attachment";
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file received." });
  const c = classify(filename, String(req.get("content-type") || ""));
  if (c.type === "unsupported" || c.type === "email" || c.type === "msg") {
    return res.status(400).json({ error: `"${filename}" is not a type the assistant reads. Attach a PDF, image, Excel, Word, CSV or text file.` });
  }
  const file = await chatStore.addPendingFile(g.name, filename, c.mime, req.body);
  res.json({ file });
});
/** A file the client keeps in its Documents tab, outside any conversation: the same kinds. */
app.post("/api/chat/files", express.raw({ type: () => true, limit: CHAT_ATTACHMENT_MAX }), async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const filename = String(req.query.filename || "").replace(/[\\/]/g, "_").trim().slice(0, 200) || "document";
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file received." });
  const c = classify(filename, String(req.get("content-type") || ""));
  if (c.type === "unsupported" || c.type === "email" || c.type === "msg") {
    return res.status(400).json({ error: `"${filename}" is not a kind the portal keeps. Add a PDF, image, Excel, Word, CSV or text file.` });
  }
  res.json({ file: await chatStore.addKeptFile(g.name, filename, c.mime, req.body) });
});

app.post("/api/chat/send", express.json({ limit: "32kb" }), async (req, res) => {
  const g = groupForPage(req);
  if (!g) return res.status(401).json({ error: "no session" });
  if (!assistantEnabled()) return res.status(503).json({ error: "The assistant is not available right now." });
  const body = req.body || {};
  const content = String(body.content || "").trim();
  if (!content) return res.status(400).json({ error: "Type a question first." });
  if (content.length > CHAT_MESSAGE_MAX) return res.status(400).json({ error: `Keep a message under ${CHAT_MESSAGE_MAX} characters.` });
  const page = /^[a-z]{1,20}$/.test(String(body.page || "")) ? body.page : null;

  let thread;
  if (body.threadId != null && body.threadId !== "") {
    const id = threadId(body.threadId);
    thread = id && (await chatStore.getThread(g.name, id));
    if (!thread) return res.status(404).json({ error: "No such conversation." });
  } else {
    // A page can name the conversation it starts (Plan recommendations), so
    // the same button finds it again instead of starting over.
    const title = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    thread = await chatStore.createThread(g.name, title || titleFor(content));
  }
  const attachments = Array.isArray(body.attachments) ? body.attachments.map(threadId).filter(Boolean).slice(0, 5) : [];
  await streamTurn({ g, thread, content, page, compact: body.compact === true, attachments, res });
});

// ---- The admin's side of the assistant ---------------------------------

app.get("/api/admin/chat/threads", requireStaff, async (req, res) => {
  const group = String(req.query.group || "").trim() || null;
  const q = String(req.query.q || "").trim().slice(0, 200) || null;
  const flagged = req.query.flagged === "1";
  const threads = await chatStore.adminListThreads({ group, q, flagged });
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  res.json({
    threads,
    stats: {
      threads: threads.length,
      messages: threads.reduce((n, t) => n + (t.messages || 0), 0),
      groups: new Set(threads.filter((t) => !t.staff).map((t) => t.groupName)).size,
      thisWeek: threads.filter((t) => new Date(t.updatedAt).getTime() > weekAgo).length,
      flagged: threads.filter((t) => t.flaggedAt).length,
    },
  });
});

app.get("/api/admin/chat/threads/:id", requireStaff, async (req, res) => {
  const id = threadId(req.params.id);
  const thread = id && (await chatStore.adminThread(id));
  if (!thread) return res.status(404).json({ error: "No such conversation." });
  res.json({ thread, messages: await chatStore.listMessages(id) });
});

app.post("/api/admin/chat/threads/:id/flag", requireStaff, express.json({ limit: "8kb" }), async (req, res) => {
  const id = threadId(req.params.id);
  const body = req.body || {};
  const thread = id && (await chatStore.flagThread(id, !!body.flagged, String(body.note || "").trim().slice(0, 2000)));
  if (!thread) return res.status(404).json({ error: "No such conversation." });
  res.json({ thread });
});

app.delete("/api/admin/chat/threads/:id", requireStaff, async (req, res) => {
  const id = threadId(req.params.id);
  if (!id || !(await chatStore.adminDeleteThread(id))) return res.status(404).json({ error: "No such conversation." });
  res.json({ ok: true });
});

app.get("/api/admin/chat/files/:id", requireStaff, async (req, res) => {
  const f = threadId(req.params.id) && (await chatStore.getFile(Number(req.params.id)));
  if (!f) return res.status(404).json({ error: "No such file." });
  sendChatFile(res, f);
});

/** Try the assistant as a group. The thread is kept, marked staff, and never shown to the client. */
app.post("/api/admin/chat/send", requireStaff, express.json({ limit: "32kb" }), async (req, res) => {
  if (!assistantEnabled()) return res.status(503).json({ error: "The assistant is not available: no ANTHROPIC_API_KEY is set." });
  const body = req.body || {};
  const g = groups.find((x) => x.name === String(body.group || ""));
  if (!g) return res.status(404).json({ error: "No such group." });
  const content = String(body.content || "").trim();
  if (!content) return res.status(400).json({ error: "Type a question first." });
  if (content.length > CHAT_MESSAGE_MAX) return res.status(400).json({ error: `Keep a message under ${CHAT_MESSAGE_MAX} characters.` });
  let thread;
  if (body.threadId != null && body.threadId !== "") {
    const id = threadId(body.threadId);
    thread = id && (await chatStore.getThread(g.name, id, true));
    if (!thread) return res.status(404).json({ error: "No such conversation." });
  } else {
    thread = await chatStore.createThread(g.name, `${titleFor(content)}`, true);
  }
  await streamTurn({ g, thread, content, page: "admin", res });
});

app.get("/api/admin/assistant/playbook", requireStaff, (_req, res) => res.json(playbookView()));

app.post("/api/admin/assistant/playbook", requireStaff, express.json({ limit: "256kb" }), async (req, res) => {
  const next = {
    ...normalizePlaybook(req.body || {}),
    updatedAt: new Date().toISOString(),
    updatedBy: req.staffEmail || null,
    history: [
      { persona: playbook.persona, rules: playbook.rules, facts: playbook.facts, faq: playbook.faq, updatedAt: playbook.updatedAt, updatedBy: playbook.updatedBy },
      ...(playbook.history || []),
    ].slice(0, 20),
  };
  try {
    if (db) await db.setSetting(PLAYBOOK_KEY, next, req.staffEmail || null);
    playbook = next;
    res.json(playbookView());
  } catch (e) {
    res.status(500).json({ error: "Could not save: " + e.message });
  }
});

/**
 * What a signed-in group is allowed to see of itself: everything but the
 * census. The per-plan tier counts the pages price from are computed here, so
 * no employee record - name, age, ZIP, dependants - ever leaves the server.
 */
/**
 * The only fields an employer's own pages read. An allow-list, not a
 * deny-list: a field added to a group later is not shipped to a client until
 * someone puts it here on purpose. Kennion's own bookkeeping - who brokers the
 * group, which manager holds it, where its renewal stands, its SIC and
 * division codes - stays on the admin side.
 */
const CLIENT_GROUP_FIELDS = [
  "name",
  "code",
  "linkToken",
  "tpa",
  "enrolled",
  // The ALE bucket staff set (or the default from enrolled), for the Group
  // Size badge. The Employee Navigator roster count that used to travel here
  // as `medicalEligible` counts everyone not marked terminated - part-time,
  // ineligible, never closed - and is a staff figure now (see data-audit.js).
  "sizeCategory",
  "lives",
  "tiers",
  "planTiers",
  "monthly",
  "annual",
  "plans",
  "rates",
  "pyStart",
  "pyEnd",
  // Whether the group is renewing prior coverage or enrolling for the first
  // time, and the date its elections take effect - the two things that vary
  // group to group around Sign Up, everything else there (the AI, the plan
  // grid, dental/vision/supplemental) reads the same regardless.
  "groupStatus",
  "effectiveDate",
  // How the name and effective date read on the group's pages, when staff
  // have written something other than the official values.
  "displayName",
  "effectiveDateLabel",
  // Dental, vision, life, disability … - the same shape the Groups page
  // shows staff, with no member detail: benefit, carrier, plan, enrolled,
  // monthly. Present only once an Employee Navigator export has been read
  // for supplemental lines; `linesLoaded` below says whether it has.
  "lines",
];

function clientGroupView(g) {
  const { members } = g;
  const planTiers = {};
  const tiers = { EE: 0, ES: 0, EC: 0, FAM: 0 };
  for (const m of members || []) {
    const t = tierKeyOfCensus(m.tier);
    if (!t) continue;
    tiers[t]++;
    const p = (planTiers[m.plan] = planTiers[m.plan] || { EE: 0, ES: 0, EC: 0, FAM: 0 });
    p[t]++;
  }
  const out = {};
  for (const k of CLIENT_GROUP_FIELDS) if (g[k] !== undefined) out[k] = g[k];
  out.tiers = members ? tiers : g.tiers;
  out.planTiers = planTiers;
  // The Welcome page's words for this group's status, as staff last saved them.
  out.welcome = welcomeFor(g.groupStatus);
  // The census as aggregates - the same profile the assistant is briefed
  // with - so the page can show what the picks were weighed on. No name and
  // no one person's age.
  out.census = censusProfile(g);
  // Whether supplemental has ever been read for this group, and what it
  // comes to - the same figures the Groups page shows staff.
  const breakdown = premiumBreakdown(g);
  out.linesLoaded = breakdown.linesLoaded;
  out.supplementalMonthly = breakdown.supplementalMonthly;
  return out;
}

/** "Employee + Spouse" → "ES". The census wording the export uses. */
function tierKeyOfCensus(census) {
  const s = String(census || "").toLowerCase();
  if (/family/.test(s)) return "FAM";
  if (/child/.test(s)) return "EC";
  if (/spouse|partner/.test(s)) return "ES";
  if (/employee|only|single/.test(s)) return "EE";
  return null;
}

/**
 * The 2027 market data a single group may see: the carrier menu and the
 * current-to-UHC plan mapping, which name no company, and this group's own
 * quoted rows. Other companies' quotes, premiums and notes stay on the server.
 * `refEE` is the one cross-group number the pricing needs - an average EE rate
 * used to scale a group UHC has not underwritten - reduced to a scalar so no
 * other company's rows travel with it.
 */
function clientUhc(g) {
  const u = data.uhc || {};
  const det = u.detail || {};
  let mine = det[g.name] || det[g.name.replace(/,? (Inc|LLC)\.?$/i, "")] || null;
  const refName = Object.keys(det)[0];
  const refRows = refName ? (det[refName] || []).filter((r) => r.tier === "EE" && r.currentRate) : [];
  const refEE = refRows.length ? refRows.reduce((a, r) => a + r.currentRate, 0) / refRows.length : null;
  let menu = u.menu || [];
  let mapping = u.mapping || [];
  if (ppoOnly()) {
    // PPO only: the EPO menu plans go; a current plan mapped to an EPO is
    // mapped to its PPO twin instead (same deductible, out-of-pocket and
    // coinsurance - UHC codes them E… and P…), and a group's quoted rate on
    // an EPO is left out rather than shown under the twin's name.
    const byPlan = new Map(menu.map((m) => [m.plan, m]));
    menu = menu.filter((m) => !isEpoMenu(m));
    const twinOf = (code) => {
      const e = byPlan.get(code);
      if (!e || !isEpoMenu(e)) return code;
      const p = byPlan.get(code.replace(/^E/, "P"));
      if (p && !isEpoMenu(p)) return p.plan;
      const alike = menu.find((m) => m.ded === e.ded && m.oop === e.oop && m.coins === e.coins);
      return alike ? alike.plan : code;
    };
    mapping = mapping.map((m) => {
      const uhcPlan = twinOf(m.uhcPlan);
      return uhcPlan === m.uhcPlan ? m : { ...m, uhcPlan, type: "PPO" };
    });
    if (mine) mine = mine.filter((r) => !r.uhcPlan || !isEpoMenu(byPlan.get(r.uhcPlan) || {}));
  }
  return {
    menu,
    mapping,
    detail: mine ? { [g.name]: mine } : {},
    summary: {},
    refEE,
  };
}

/**
 * Which proposal slots each group's client is shown: "<group>||<slot>" ->
 * { clientEnabled, updatedBy, updatedAt }, kept in
 * kennion.proposal_slot_visibility - apart from the proposal rows, so a
 * re-read or a newer upload in the slot never changes it. No entry = ON.
 */
const slotVisibility = new Map();
async function loadSlotVisibility() {
  if (!db) return;
  try {
    for (const r of await db.listSlotVisibility()) slotVisibility.set(`${r.groupName}||${r.slot}`, r);
  } catch (e) {
    console.error("could not read proposal-slot visibility:", e.message);
  }
}
/** Is this proposal slot ON for the group's client? ON unless Kennion turned it OFF. */
const slotEnabled = (groupName, slot) => {
  const v = slotVisibility.get(`${groupName}||${slot}`);
  return v ? v.clientEnabled !== false : true;
};

const isDtq = (groupName, slot) => {
  const v = slotVisibility.get(`${groupName}||${slot}`);
  return v ? v.dtq === true : false;
};

/**
 * Whether a client is shown only Verified proposals. On by default: the
 * client sees a proposal once the whole check has passed. Set
 * KENNION_CLIENT_VERIFIED_ONLY=0 to show proposals still being verified
 * (marked pending) - for a book still mid-way through its first pass.
 */
const clientVerifiedOnly = () => process.env.KENNION_CLIENT_VERIFIED_ONLY !== "0";

/**
 * THE client plan universe for a group - the one resolver the Medical Plans
 * grid, plan cards, comparison, pricing, documents, Sign Up and the AI
 * Assistant all read (every client payload carries `proposals` from here):
 *   1. the group's current proposals (never one in a retired slot - Cobalt,
 *      Nationwide, the Angle Scorecard), Verified ones only (see clientVerifiedOnly);
 *   2. less the proposal slots Kennion turned OFF for this group;
 *   3. every canonical plan of every remaining proposal - all of them, with
 *      their exact stored values. Nothing is hidden by network, plan type,
 *      deductible, rate or any other attribute, and nothing is
 *      de-duplicated again: each canonical record is one carrier plan.
 * (An advanced per-plan exception in server/plan-visibility.js would mark a
 * plan `hidden`; there are none.)
 */
function clientAvailablePlans(name) {
  const list = (currentProposals[name] || []).filter((p) => !retiredSlot(p.slot) && slotEnabled(name, p.slot));
  const withStatus = list
    .map((p) => {
      const v = verifiedProposals.get(p.id);
      return { ...p, verified: !!v, audit: v ? { status: "pass", completedAt: v } : p.audit ? { status: "pending", completedAt: p.audit.completedAt } : null };
    })
    .filter((p) => p.verified || !clientVerifiedOnly());
  return withStatus.map((p) => ({ ...p, plans: (p.plans || []).filter((pl) => !pl.hidden).map(({ hidden, ...pl }) => pl) }));
}
/** The same universe, flat: every plan a group's client can see, with its slot. */
const clientPlanList = (name) => clientAvailablePlans(name).flatMap((p) => p.plans.map((pl) => ({ ...pl, slot: p.slot, proposalId: p.id })));
/** Proposal id -> when its dual audit completed, for every proposal the check currently calls Verified. */
const verifiedProposals = new Map();

/** The newest client invoice filed under a group, without its bytes; null if none. */
/** The roster group an invoice file's own name points to, or null when it names none. */
function invoiceGroupFromFilename(filename) {
  const short = groupFromInvoiceFilename(String(filename || ""));
  if (!short) return null;
  return matchInvoiceName(short, groups.map((x) => x.name), normalizeName);
}

/**
 * Every invoice on file, checked: the company named on the file must be the
 * group the row is filed under. Mismatches are logged at boot and the row is
 * marked, so the Groups page and the client route both know. Never fatal.
 */
async function auditInvoices() {
  const rows = await proposalStore.listProposals();
  let bad = 0;
  for (const r of rows) {
    if (r.kind !== "invoice" || !r.group_name) continue;
    const named = invoiceGroupFromFilename(r.filename);
    const mismatch = !!(named && named !== r.group_name);
    const flagged = !!(r.context && r.context.mismatch);
    if (mismatch) {
      bad++;
      console.error(`invoice audit: #${r.id} "${r.filename}" is filed under ${r.group_name} but names ${named}`);
    }
    if (mismatch !== flagged) {
      await proposalStore.updateProposal(r.id, { context: { ...(r.context || {}), mismatch: mismatch ? named : undefined } }).catch(() => {});
    }
  }
  console.log(`invoice audit: ${rows.filter((r) => r.kind === "invoice").length} invoice(s) checked, ${bad} filed under the wrong group`);
}

async function latestInvoiceFor(name) {
  const rows = await proposalStore.listProposals();
  return rows.find((r) => r.kind === "invoice" && r.group_name === name) || null;
}

/** A group's slice of the month's billing for its own pages: counts and rates, no people. */
function fundingSnapshot(name) {
  const f = funding && funding.summary[name];
  if (!f) return null;
  const byPlan = {};
  for (const [plan, p] of Object.entries(f.medical.byPlan)) {
    byPlan[plan] = { monthly: p.monthly, byTier: Object.fromEntries(Object.entries(p.byTier).map(([t, x]) => [t, { n: x.n, rate: x.rate }])) };
  }
  return {
    month: funding.month,
    participants: f.medical.participants,
    monthly: f.medical.monthly,
    adjustments: f.medical.adjustments,
    billed: f.medical.billed,
    otherMonthly: f.other.monthly,
    byPlan,
  };
}

/**
 * Re-enter a staff session the browser still holds a token for - a reload, or
 * a link to an admin page opened in the same tab. The token is checked the same
 * way every admin call checks it; an expired one gets a 401 and the sign-in form.
 */
app.get("/api/admin/session", requireStaff, (_req, res) => res.json(adminPayload()));

/**
 * Read an upload. The request body is streamed straight into the parser rather
 * than buffered, because a full Data API export runs to hundreds of megabytes
 * and holding one in memory is what broke the first version of this.
 */
async function readUpload(req) {
  return parseEnStream(req);
}

/**
 * Same as `readUpload`, but also keeps the file - gzip-compressed, so a
 * ~100MB export lands in the database at a fraction of its size - for the
 * import this actually applies. XML compresses well, and it's streamed
 * through the compressor alongside parsing rather than buffered whole, so
 * this carries none of the memory cost the streaming parser was built to
 * avoid. Once this is in the database, no import ever needs the original
 * file handed back to it again - the source Postgres already trusts, not a
 * copy anyone has to keep track of.
 */
async function readUploadWithRaw(req) {
  const forParsing = new PassThrough();
  const gzip = zlib.createGzip();
  req.pipe(forParsing);
  req.pipe(gzip);
  const compressedChunks = [];
  gzip.on("data", (c) => compressedChunks.push(c));
  const rawGzip = new Promise((resolve, reject) => {
    gzip.on("end", () => resolve(Buffer.concat(compressedChunks)));
    gzip.on("error", reject);
  });
  const parsed = await parseEnStream(forParsing);
  return { ...parsed, rawGzip: await rawGzip };
}

/**
 * The existing group an imported company corresponds to. Exact name first, then
 * the normalised form, so "Aesto Health, LLC" updates "Aesto Health" instead of
 * landing beside it as a second copy of the same client.
 */
function matchExisting(name) {
  const exact = groups.find((x) => x.name === name);
  if (exact) return exact;
  const key = normalizeName(name);
  return groups.find((x) => normalizeName(x.name) === key) || null;
}

/**
 * The group an invoice file belongs to. The exact roster name first; failing
 * that, the short name Employee Navigator puts on an invoice is matched to the
 * one roster name it can only mean (see matchInvoiceName).
 */
function matchInvoiceGroup(name) {
  const exact = matchExisting(name);
  if (exact) return exact;
  const hit = matchInvoiceName(name, groups.map((x) => x.name), normalizeName);
  return hit ? groups.find((x) => x.name === hit) || null : null;
}

const summarise = (parsed) => {
  const g = parsed.group;
  const current = matchExisting(g.name);
  return {
    name: g.name,
    enIdentifier: g.enIdentifier,
    tpa: g.tpa,
    pyStart: g.pyStart,
    pyEnd: g.pyEnd,
    enrolled: g.enrolled,
    lives: g.lives,
    monthly: g.monthly,
    plans: g.plans,
    hasSplit: !!parsed.split,
    stats: parsed.stats,
    isNew: !current,
    ancillaryOnly: !!g.ancillaryOnly,
    matchedName: current && current.name !== g.name ? current.name : null,
    current: current && {
      enrolled: current.enrolled,
      lives: current.lives,
      monthly: (current.plans || []).reduce((s, p) => s + (p.monthly || 0), 0),
      plans: (current.plans || []).length,
    },
  };
};

/**
 * Employee Navigator's Carrier Stats report - the second file, uploaded with
 * each XML export. Stored, and shown against the import carrier by carrier.
 */
app.post(
  "/api/admin/carrier-stats",
  requireStaff,
  express.raw({ type: () => true, limit: "10mb" }),
  async (req, res) => {
    const filename = String(req.query.filename || "carrier_stats_report.xls").slice(0, 200);
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "No file received." });
    }
    try {
      await ingestCarrierStats(req.body, filename, req.staffEmail || null);
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    res.json({ ok: true, stats: carrierStats, audit });
  },
);

/** Parse a carrier stats workbook, keep the file and its rows, refresh the audit. */
async function ingestCarrierStats(buf, filename, by) {
  let parsed;
  try {
    parsed = parseCarrierStats(buf, filename);
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: 400 });
  }
  const rec = { ...parsed, filename, uploadedBy: by, rawGzip: zlib.gzipSync(buf) };
  try {
    carrierStats = db
      ? await db.saveCarrierStats(rec)
      : { filename, reportDate: parsed.reportDate, rows: parsed.rows, total: parsed.total, uploadedAt: new Date().toISOString(), uploadedBy: by };
  } catch (e) {
    throw new Error("Could not save the report: " + e.message);
  }
  await refreshAudit();
  return { reportDate: parsed.reportDate, rows: parsed.rows.length };
}

/** Every company's diagnostics added up into one picture of the file. */
function rollupDiagnostics(companies) {
  const all = newDiagnostics();
  for (const c of companies) mergeDiagnostics(all, c.stats && c.stats.diagnostics);
  return all;
}

/**
 * Ask Claude what explains the gap between the carrier stats report and the
 * import. Only aggregates go out: the report rows, per-carrier portal totals
 * the screen computed, and the last import's diagnostics.
 */
app.post("/api/admin/reconcile/explain", requireStaff, express.json({ limit: "256kb" }), async (req, res) => {
  if (!carrierStats) return res.status(400).json({ error: "Upload the carrier stats report first." });
  const diagnostics = (recentImports[0] && recentImports[0].diagnostics) || null;
  const payload = {
    report: { reportDate: carrierStats.reportDate, rows: carrierStats.rows, total: carrierStats.total },
    portal: req.body && req.body.portal ? req.body.portal : null,
    lastImport: recentImports[0]
      ? { filename: recentImports[0].filename, when: recentImports[0].uploaded_at, diagnostics }
      : null,
  };
  try {
    const text = await explainReconciliation(payload);
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** The audit as it stands; `?read=1` asks Claude again when the last read failed. */
app.get("/api/admin/audit", requireStaff, async (req, res) => {
  if (String(req.query.read || "") === "1" && audit && !audit.read && !audit.reading) {
    audit.readError = null;
    auditReadInFlight = null;
    await refreshAudit();
  }
  res.json({ audit });
});

/**
 * The data check: every group against itself and against every file the
 * portal holds about it (server/data-audit.js). Computed on request from
 * what is in memory - it is cheap - so it is always about the data as it
 * stands, including a rate keyed in a minute ago.
 */
function dataAuditBundles() {
  const byName = new Map(adminGroups.map((a) => [a.name, a]));
  const latestImportAt = recentImports[0] ? recentImports[0].uploaded_at : null;
  return groups.map((g) => ({
    g,
    admin: byName.get(g.name) || {},
    split: splitFor(g),
    proposals: clientAvailablePlans(g.name),
    billing: (funding && funding.summary[g.name]) || null,
    fundingMonth: funding ? funding.month : null,
    // The assigned manager by name; none means the assistant gets the fallback contact.
    manager: g.manager ? managerContact(g.manager).name || null : null,
    latestImportAt,
  }));
}

/**
 * The stored export, re-read. The gzip kept with the last import is parsed
 * again and every company set against the group the portal holds, so drift
 * between the file Employee Navigator gave us and what clients are served
 * is caught - a re-import that skipped a company, a partial apply, an edit
 * by hand. Kept in settings so the result survives a deploy; the tab says
 * which export it was run against and whether a newer one has landed.
 */
const XML_VERIFY_KEY = "dataCheck.xmlVerify";
let xmlVerify = null;
let xmlVerifying = false;
async function loadXmlVerify() {
  if (!db) return;
  try {
    const saved = await db.getSetting(XML_VERIFY_KEY);
    if (saved && typeof saved === "object") xmlVerify = saved;
  } catch (e) {
    console.error("could not load the stored-export check:", e.message);
  }
}
/** The last import's export, read again from the gzip kept in the database. */
async function readStoredExport() {
  const last = recentImports[0];
  if (!db) throw new Error("No database: the export is not stored, so there is nothing to re-read.");
  if (!last || !last.id) throw new Error("No Employee Navigator export has been imported yet.");
  const rec = await db.importRaw(last.id);
  if (!rec || !rec.raw_gzip) throw new Error("The last import was made before exports were kept; import the file again and it will be.");
  const { companies, failures } = await parseEnStream(Readable.from([rec.raw_gzip]).pipe(zlib.createGunzip()));
  return { last, rec, companies, failures };
}

/**
 * Fields a later parser learned to keep, filled in for groups imported
 * before it did - from the export already in the database, so nobody has
 * to upload the file again. Today: each plan's full Employee Navigator
 * name (`enName`). Runs in the background at boot; the payload is updated
 * in place, keeping when and by whom the group was imported.
 */
// A member is filled once the export has been asked for its census fields (censusFilled), not merely once the keys exist:
// an earlier fill that found nothing must not stop a later one.
const membersWantCensus = (g) => (g.members || []).some((m) => !m.censusFilled);
async function backfillFromStoredExport() {
  if (!db) return;
  const wanting = groups.filter((g) => (g.plans || []).some((p) => !p.enName) || membersWantCensus(g));
  if (!wanting.length) return;
  const { companies } = await readStoredExport();
  let filled = 0;
  let census = 0;
  let matched = 0;
  let unmatched = 0;
  for (const c of companies) {
    const g = matchExisting(c.group.name);
    if (!g) continue;
    let changed = false;
    if ((g.plans || []).some((p) => !p.enName)) {
      const names = new Map((c.group.plans || []).map((p) => [p.plan, p.enName]));
      for (const p of g.plans || []) {
        const full = names.get(p.plan);
        if (full && !p.enName) {
          p.enName = full;
          changed = true;
        }
      }
    }
    // The census fields (date of birth, dependants by name): matched by
    // name and age, since that is what both sides hold.
    if (membersWantCensus(g)) {
      const key = (m) => `${String(m.last || "").trim().toLowerCase()}|${String(m.first || "").trim().toLowerCase()}|${m.age ?? ""}`;
      const fresh = new Map((c.group.members || []).map((m) => [key(m), m]));
      for (const m of g.members || []) {
        if (m.censusFilled) continue;
        const f = fresh.get(key(m));
        if (!f || f.dob === undefined) {
          unmatched++;
          continue;
        }
        m.dob = f.dob ?? null;
        m.deps = Array.isArray(f.deps) ? f.deps : [];
        m.censusFilled = true;
        matched++;
        changed = true;
      }
      census++;
    }
    if (!changed) continue;
    await db.updateGroupPayload(g.name, g);
    filled++;
  }
  if (filled) rebuild();
  console.log(`stored export: ${filled} group(s) updated; census fields: ${matched} member(s) filled, ${unmatched} not found in the export, across ${census} group(s)`);
}

async function verifyStoredXml(by) {
  const { last, rec, companies, failures } = await readStoredExport();
  const result = compareToExport(companies, groups, matchExisting);
  xmlVerify = {
    importId: last.id,
    filename: last.filename,
    uploadedAt: last.uploaded_at,
    ranAt: new Date().toISOString(),
    ranBy: by || null,
    rawSize: rec.raw_size || null,
    ...result,
    rejected: failures.map((f) => ({ name: f.name, reason: f.reason })),
  };
  try {
    await db.setSetting(XML_VERIFY_KEY, xmlVerify, by || null);
  } catch (e) {
    console.error("could not keep the stored-export check:", e.message);
  }
  return xmlVerify;
}
const xmlVerifyView = () => {
  if (!xmlVerify) return null;
  const last = recentImports[0];
  return { ...xmlVerify, stale: !!(last && String(last.uploaded_at) !== String(xmlVerify.uploadedAt)), running: xmlVerifying };
};

/**
 * Claude's read of the data check - once per state of the data (the three
 * uploads, the stored-export check and the findings), kept in the audits
 * table under its own fingerprint so nobody presses anything twice.
 */
/** One read per reader - Claude, and ChatGPT as the second opinion - each kept under its own fingerprint. */
const dataReads = { claude: null, chatgpt: null };
const dataCheckFingerprint = (audit, who = "claude") =>
  [
    who === "chatgpt" ? "datacheck-gpt-v1" : "datacheck-v1",
    recentImports[0] ? recentImports[0].uploaded_at : "-",
    carrierStats ? carrierStats.uploadedAt : "-",
    funding ? funding.uploadedAt : "-",
    xmlVerify ? xmlVerify.ranAt : "-",
    audit.counts.ok,
    audit.counts.warn,
    audit.counts.fail,
    audit.rows.filter((r) => r.status !== "ok" && r.status !== "skip").map((r) => `${r.name}:${r.checks.filter((c) => c.level === "warn" || c.level === "fail").map((c) => c.key).join(",")}`).join(";"),
  ].join("|");
async function dataReadFor(audit, who = "claude") {
  const fingerprint = dataCheckFingerprint(audit, who);
  const have = dataReads[who];
  if (have && have.fingerprint === fingerprint) return have;
  if (db) {
    try {
      const saved = await db.getAudit(fingerprint);
      if (saved && saved.read) {
        dataReads[who] = { fingerprint, text: saved.read, at: saved.createdAt };
        return dataReads[who];
      }
    } catch (e) {
      console.error("could not load the data check read:", e.message);
    }
  }
  return null;
}
const dataReadView = (read) => (read ? { text: read.text, at: read.at } : null);

/**
 * Run the data check and keep its result in the audits table under the
 * fingerprint of the data it describes: the same state is one row, updated
 * in place; a change to any file or finding is a new row. Never fatal.
 */
async function keepDataCheck() {
  let audit;
  try {
    audit = auditData(dataAuditBundles());
  } catch (e) {
    console.error("data check:", e.message);
    return null;
  }
  if (db) {
    try {
      await db.saveAudit(dataCheckFingerprint(audit), { kind: "datacheck", generated: audit.generated, headline: audit.headline, counts: audit.counts, byCheck: audit.byCheck, groups: audit.rows.map((r) => ({ name: r.name, status: r.status, flagged: r.checks.filter((c) => c.level === "warn" || c.level === "fail").map((c) => `${c.label}: ${c.detail}`) })) }, null);
    } catch (e) {
      console.error("could not keep the data check:", e.message);
    }
  }
  return audit;
}

app.get("/api/admin/data-audit", requireStaff, async (_req, res) => {
  const audit = (await keepDataCheck()) || auditData(dataAuditBundles());
  const read = await dataReadFor(audit, "claude");
  const second = await dataReadFor(audit, "chatgpt");
  res.json({ audit, xml: xmlVerifyView(), read: dataReadView(read), secondRead: dataReadView(second), chatgpt: chatgptEnabled(), snapshot: auditSnapshotView() });
});

/** The cross-file verdict the Import tab shows, for the same page. */
function auditSnapshotView() {
  return audit ? { generated: audit.generated, complete: audit.complete, verdict: audit.verdict, files: audit.files } : null;
}

app.post("/api/admin/data-audit/verify-xml", requireStaff, async (req, res) => {
  if (xmlVerifying) return res.status(409).json({ error: "The export is being re-read now; try again in a moment." });
  xmlVerifying = true;
  try {
    const result = await verifyStoredXml(req.staffEmail || null);
    res.json({ xml: { ...result, stale: false, running: false } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    xmlVerifying = false;
  }
});

/** `?by=chatgpt` asks the second reader; anything else asks Claude. Each read is kept for this state of the data. */
app.post("/api/admin/data-audit/read", requireStaff, async (req, res) => {
  const who = String(req.query.by || "") === "chatgpt" ? "chatgpt" : "claude";
  if (who === "claude" && !aiEnabled()) return res.status(400).json({ error: "AI is off on this server (no API key)." });
  if (who === "chatgpt" && !chatgptEnabled()) return res.status(400).json({ error: "ChatGPT is off on this server: no ChatGPT (or OPENAI_API_KEY) variable is set." });
  const audit = auditData(dataAuditBundles());
  const cached = await dataReadFor(audit, who);
  if (cached) return res.json({ read: dataReadView(cached) });
  const fingerprint = dataCheckFingerprint(audit, who);
  const payload = {
    headline: audit.headline,
    counts: audit.counts,
    byCheck: audit.byCheck,
    groups: audit.rows
      .filter((r) => r.status === "warn" || r.status === "fail")
      .map((r) => ({ name: r.name, status: r.status, enrolled: r.figures.enrolled, monthly: r.figures.monthly, roster: r.figures.roster, findings: r.checks.filter((c) => c.level !== "ok").map((c) => ({ check: c.label, level: c.level, detail: c.detail })) })),
    storedExport: xmlVerify ? { filename: xmlVerify.filename, uploadedAt: xmlVerify.uploadedAt, companies: xmlVerify.companies, matched: xmlVerify.matched, differ: xmlVerify.differ, missingFromPortal: xmlVerify.missingFromPortal, notInFile: xmlVerify.notInFile, stale: xmlVerifyView().stale } : null,
    threeFiles: auditSnapshotView(),
  };
  try {
    const text = who === "chatgpt" ? await secondReadDataCheck(payload) : await explainDataCheck(payload);
    dataReads[who] = { fingerprint, text, at: new Date().toISOString() };
    if (db) await db.saveAudit(fingerprint, { kind: who === "chatgpt" ? "datacheck-second" : "datacheck", counts: audit.counts, headline: audit.headline }, text).catch((e) => console.error("could not keep the data check read:", e.message));
    res.json({ read: dataReadView(dataReads[who]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * One group in full: its checks, and the briefing the assistant is handed
 * word for word - the same describeGroup() text every answer is written
 * from - so staff can read exactly what a client's assistant knows.
 */
app.get("/api/admin/data-audit/:name", requireStaff, async (req, res) => {
  const g = matchExisting(String(req.params.name || ""));
  if (!g) return res.status(404).json({ error: "No such group." });
  const bundle = dataAuditBundles().find((b) => b.g.name === g.name);
  const [row] = auditData([bundle]).rows;
  try {
    const briefing = describeGroup(await assistantData(g));
    res.json({ group: row, briefing });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * The month's funding workbook from Employee Navigator. Every invoice is filed
 * under the group most of its billed people belong to (their names against
 * the groups' members), summarised per group, and kept - names and all - on
 * the server only.
 */
async function storeFunding(rec) {
  if (db) {
    const row = await db.saveFunding(rec);
    return { ...rec, id: row.id, uploadedAt: row.uploaded_at };
  }
  return { ...rec, id: Date.now(), uploadedAt: new Date().toISOString() };
}

app.post(
  "/api/admin/funding",
  requireStaff,
  express.raw({ type: () => true, limit: "40mb" }),
  async (req, res) => {
    const filename = String(req.query.filename || "funding.xlsx").slice(0, 200);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file received." });
    let parsed;
    try {
      parsed = parseFunding(req.body, filename);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const { byInvoice } = assignInvoices(parsed.lines, groups);
    // A group the staff filed an invoice under last time keeps it.
    if (funding) {
      for (const [inv, a] of Object.entries(funding.byInvoice)) {
        if (a.by === "staff" && byInvoice[inv]) byInvoice[inv] = { ...byInvoice[inv], group: a.group, by: "staff" };
      }
    }
    const summary = summariseFunding(parsed.lines, byInvoice, xmlPlansByGroup());
    try {
      funding = await storeFunding({
        month: parsed.month,
        filename,
        fileStamp: parsed.fileStamp,
        lines: parsed.lines,
        byInvoice,
        summary,
        uploadedBy: req.staffEmail || null,
        rawGzip: zlib.gzipSync(req.body),
      });
    } catch (e) {
      return res.status(500).json({ error: "Could not save the workbook: " + e.message });
    }
    // The month's billed rates go straight onto the groups' plans, so what a
    // client sees is what is being billed; nothing to press.
    let rates = { applied: 0, skipped: 0, groups: 0 };
    try {
      rates = await applyBilledRates(Object.keys(funding.summary), req.staffEmail || "funding");
    } catch (e) {
      console.error("could not apply billed rates:", e.message);
    }
    rebuild();
    await refreshAudit();
    res.json({ ok: true, funding: fundingView(funding), groups: adminGroups, rates, overrides, audit });
  },
);

/** Each group's XML plan names, for matching billed products to plans. */
const xmlPlansByGroup = () => Object.fromEntries(groups.map((g) => [g.name, (g.plans || []).map((p) => p.plan)]));

/**
 * Set tier rates from billing: for each plan and tier the workbook bills,
 * where the XML has no billed rate for that tier or a different one, write a
 * hand-keyed override with the billed amount. Plans the group's XML does not
 * carry are skipped - a billed plan the census has never seen is a question,
 * not a rate - and so is a rate known only from a prorated line.
 */
async function applyBilledRates(targets, by) {
  let applied = 0;
  let skipped = 0;
  const touched = new Set();
  for (const name of targets) {
    const f = funding.summary[name];
    const g = groups.find((x) => x.name === name);
    if (!f || !g) continue;
    const xmlPlans = new Set((g.plans || []).map((p) => p.plan));
    for (const [plan, p] of Object.entries(f.medical.byPlan)) {
      if (!xmlPlans.has(plan)) {
        skipped++;
        continue;
      }
      for (const [tier, t] of Object.entries(p.byTier)) {
        if (t.rate == null || t.rate <= 0 || t.rateProrated || !bandTier(tier)) continue;
        const billed = ((g.rates || {})[plan] || {})[tier];
        const key = `${name}||${plan}||${tier}`;
        const current = overrides[key] != null ? Number(overrides[key]) : billed;
        if (current != null && Math.abs(current - t.rate) <= 0.01) continue;
        overrides[key] = String(t.rate);
        if (db) await db.setOverride(name, plan, tier, t.rate, by);
        applied++;
        touched.add(name);
      }
    }
  }
  return { applied, skipped, groups: touched.size };
}

/** File an invoice under a group by hand (or take it out of one). */
app.post("/api/admin/funding/assign", requireStaff, express.json({ limit: "16kb" }), async (req, res) => {
  if (!funding) return res.status(400).json({ error: "Upload the funding workbook first." });
  const { invoice, group } = req.body || {};
  const inv = String(invoice || "");
  if (!funding.byInvoice[inv]) return res.status(404).json({ error: "No such invoice in the workbook." });
  const clean = group == null || group === "" ? null : String(group);
  if (clean && !groups.some((g) => g.name === clean)) return res.status(404).json({ error: "No such group." });
  funding.byInvoice[inv] = { ...funding.byInvoice[inv], group: clean, by: clean ? "staff" : null };
  funding.summary = summariseFunding(funding.lines, funding.byInvoice, xmlPlansByGroup());
  try {
    if (db) await db.updateFunding(funding.id, funding.byInvoice, funding.summary);
    if (clean) await applyBilledRates([clean], req.staffEmail || "funding");
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  rebuild();
  await refreshAudit();
  res.json({ ok: true, funding: fundingView(funding), groups: adminGroups, overrides, audit });
});

/** Re-run the billed-rate write for one group or all - after a hand filing, say. */
app.post("/api/admin/funding/apply-rates", requireStaff, express.json({ limit: "16kb" }), async (req, res) => {
  if (!funding) return res.status(400).json({ error: "Upload the funding workbook first." });
  const { group, all } = req.body || {};
  const targets = all ? Object.keys(funding.summary) : group ? [String(group)] : [];
  if (!targets.length) return res.status(400).json({ error: "Say which group, or all." });
  try {
    const r = await applyBilledRates(targets, req.staffEmail || "funding");
    res.json({ ok: true, ...r, overrides });
  } catch (e) {
    res.status(500).json({ error: "Could not save: " + e.message });
  }
});

/**
 * Everything needed to reconcile the import against the carrier stats report,
 * as one small file - aggregates only, no member records - so it can be
 * handed to someone (or to Claude in a chat) who cannot reach this server.
 */
app.get("/api/admin/reconcile/export", requireStaff, (_req, res) => {
  // Every group, archived and not-in-program included: Employee Navigator's
  // report knows nothing of either, so the comparison must not drop them.
  const live = groups.filter((g) => !g.archived && g.eligible);
  const perGroup = groups.map((g) => {
    const b = premiumBreakdown(g);
    return {
      name: g.name,
      archived: !!g.archived,
      eligible: !!g.eligible,
      ancillaryOnly: !!g.ancillaryOnly,
      carrierHeads: g.carrierHeads || null,
      tpa: g.tpa || null,
      enrolled: g.enrolled,
      lives: g.lives,
      programs: g.programs || [],
      carriersSeen: g.carriersSeen || [],
      importedAt: importedAt[g.name] || null,
      plans: classifyPlans(g).map((p) => ({
        plan: p.plan,
        tpa: p.tpa || "",
        program: p.program,
        groupHealth: p.groupHealth,
        assumed: p.assumed,
        enrolled: p.enrolled,
        monthly: p.monthly,
      })),
      lines: (g.lines || []).map((l) => ({ benefit: l.benefit, carrier: l.carrier, plan: l.plan, enrolled: l.enrolled, monthly: l.monthly })),
      ...b,
    };
  });
  const byProgram = {};
  perGroup.filter((g) => !g.archived && g.eligible).forEach((g) =>
    g.plans.forEach((p) => {
      const k = p.assumed ? "assumed" : p.program || "unknown";
      const t = (byProgram[k] = byProgram[k] || { groups: new Set(), plans: 0, enrolled: 0, monthly: 0, carriers: new Set() });
      t.groups.add(g.name);
      t.plans++;
      t.enrolled += p.enrolled || 0;
      t.monthly += p.monthly || 0;
      t.carriers.add(p.tpa || "(blank)");
    }),
  );
  res.setHeader("Content-Disposition", `attachment; filename="kennion-reconciliation-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    generated: new Date().toISOString(),
    storage: db ? "postgres" : DURABLE ? "volume" : "ephemeral",
    carrierStats,
    lastImport: recentImports[0] || null,
    // The month's funding workbook, totals only: enough to see the billing
    // side of the reconciliation without any participant line.
    funding: funding
      ? { month: funding.month, filename: funding.filename, fileStamp: funding.fileStamp, uploadedAt: funding.uploadedAt, totals: fundingTotals(funding), unassigned: Object.entries(funding.byInvoice).filter(([, a]) => !a.group).map(([inv, a]) => ({ invoice: inv, orgs: a.orgs, lines: a.total })) }
      : null,
    importHistory: recentImports.map((r) => ({ filename: r.filename, uploaded_at: r.uploaded_at, companies_found: r.companies_found, companies_applied: r.companies_applied })),
    portalByProgram: Object.fromEntries(
      Object.entries(byProgram).map(([k, t]) => [k, { groups: t.groups.size, plans: t.plans, enrolled: t.enrolled, monthly: Math.round(t.monthly * 100) / 100, carriers: [...t.carriers].sort() }]),
    ),
    roster: { live: live.length, archived: groups.filter((g) => g.archived).length, notInProgram: groups.filter((g) => !g.archived && !g.eligible).length },
    groups: perGroup,
  });
});

/** Preview: parse and report what would change. Saves nothing. */
app.post("/api/admin/import/preview", requireStaff, async (req, res) => {
  try {
    const { companies, failures } = await readUpload(req);
    // Totals straight from the file, by program, so what was read can be
    // checked against Employee Navigator's own numbers before anything is saved.
    const programs = {};
    const unmapped = {};
    for (const c of companies) {
      for (const p of classifyPlans(c.group)) {
        const key = p.assumed ? "assumed" : p.program || "unknown";
        const t = (programs[key] = programs[key] || { key, groups: new Set(), enrolled: 0, monthly: 0, carriers: new Set() });
        t.groups.add(c.group.name);
        t.enrolled += p.enrolled || 0;
        t.monthly += p.monthly || 0;
        t.carriers.add((p.tpa || "").trim() || "(blank)");
      }
      for (const [lvl, n] of Object.entries(c.stats?.unmappedLevels || {})) unmapped[lvl] = (unmapped[lvl] || 0) + n;
    }
    res.json({
      companies: companies.map(summarise),
      failures,
      diagnostics: rollupDiagnostics(companies),
      totalEnrolled: companies.reduce((n, c) => n + c.group.enrolled, 0),
      totalMonthly: Math.round(companies.reduce((n, c) => n + (c.group.monthly || 0), 0) * 100) / 100,
      programs: Object.values(programs).map((t) => ({
        ...t,
        groups: t.groups.size,
        carriers: [...t.carriers].sort(),
        monthly: Math.round(t.monthly * 100) / 100,
      })),
      unmappedLevels: unmapped,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * A census row for a company a full export no longer carries - or carries
 * with nothing current - is a company that has left: archive it, once, and
 * say why. Staff can restore it and later imports leave that alone.
 */
async function archiveLeavers(exported) {
  const at = new Date().toISOString();
  for (const g of data.groups) {
    if (!(g.plans || []).length || imported.groups[g.name] || exported.has(g.name)) continue;
    const m = meta[g.name] || {};
    if ((m.fields || {}).notInExport || m.archived) continue;
    meta[g.name] = { ...m, archived: true, fields: { ...(m.fields || {}), notInExport: at } };
    try {
      if (db) {
        await db.setField(g.name, "notInExport", at, "import");
        await db.setMeta(g.name, "archived", true, "import");
      }
    } catch (e) {
      console.error(`could not archive ${g.name}:`, e.message);
    }
  }
}

/** Apply. `only` (a list of company names) limits which are written. */
app.post("/api/admin/import", requireStaff, async (req, res) => {
  const only = String(req.query.only || "").trim();
  const wanted = only ? new Set(only.split("\n").filter(Boolean)) : null;
  try {
    const { companies, failures, rawGzip } = await readUploadWithRaw(req);
    imported.groups = imported.groups || {};
    imported.splits = imported.splits || {};
    const applied = [];
    for (const parsed of companies) {
      const g = parsed.group;
      if (wanted && !wanted.has(g.name)) continue;

      const prior = matchExisting(g.name);
      // The export has the SIC code but not its description, so carry that
      // across from the census rather than losing it on import.
      if (prior && prior.sicDesc && !g.sicDesc) g.sicDesc = prior.sicDesc;

      // Keep the existing group's name as the key. Access codes, hand-keyed
      // rates and ALE buckets are all filed under it, and adopting the
      // export's spelling would orphan every one of them.
      const key = prior ? prior.name : g.name;
      if (prior && prior.name !== g.name) g.enName = g.name;
      g.name = key;

      // Every count that went into medicalEligible - and everything else the
      // parser tallied but had no field for - kept on the group itself, not
      // just rolled into this one import's batch-wide total, so a later
      // question about this company doesn't require re-uploading the file.
      g.diagnostics = parsed.stats.diagnostics;

      imported.groups[key] = g;
      if (parsed.split) imported.splits[key] = parsed.split;
      if (db) await db.saveGroup(g, parsed.split, req.staffEmail || null);
      applied.push({ name: key, enrolled: g.enrolled, monthly: g.monthly });
    }
    if (!applied.length) return res.status(400).json({ error: "Nothing selected to import." });
    saveImports();

    const diagnostics = rollupDiagnostics(companies);
    // Company records the parser could not use are part of the record too - 
    // a carrier's stats may count them when the portal does not.
    diagnostics.rejected = failures.map((f) => ({ name: f.name, reason: f.reason }));

    // Only a full export can say a company has left: one carrying at least
    // half the roster. A single-company export touches nothing else.
    if (companies.length + failures.length >= groups.length / 2) {
      await archiveLeavers(new Set(companies.map((c) => c.group.name)));
    }
    if (db) {
      const at = await db.logImport(
        String(req.query.filename || "").slice(0, 200) || null,
        req.staffEmail || null,
        companies.length + failures.length,
        applied.length,
        applied.map((a) => a.name),
        diagnostics,
        rawGzip,
      );
      applied.forEach((a) => {
        importedAt[a.name] = at;
      });
      recentImports = await db.recentImports();
    } else {
      // No database: keep the history in memory so the screen can still show
      // what the last import did and what it left out.
      const at = new Date().toISOString();
      applied.forEach((a) => {
        importedAt[a.name] = at;
      });
      recentImports = [
        {
          filename: String(req.query.filename || "").slice(0, 200) || null,
          uploaded_at: at,
          uploaded_by: req.staffEmail || null,
          companies_found: companies.length + failures.length,
          companies_applied: applied.length,
          diagnostics,
        },
        ...recentImports,
      ].slice(0, 8);
    }
    rebuild();
    await refreshAudit();

    res.json({
      ok: true,
      audit,
      durable: !!db || DURABLE,
      storage: db ? "postgres" : DURABLE ? "volume" : "ephemeral",
      imports: recentImports,
      applied,
      skipped: failures,
      groups: adminGroups,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * The second step of a staff sign-in: the six digits from the authenticator,
 * or one of the recovery codes. The pending ticket is single use.
 */
app.post("/api/signin/2fa", express.json({ limit: "4kb" }), async (req, res) => {
  const caller = signinKey(req);
  if (throttled(caller)) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  }
  const { pending, code } = req.body || {};
  const t = pending2fa.get(String(pending || ""));
  if (!t || t.exp < Date.now()) {
    pending2fa.delete(String(pending || ""));
    return res.status(401).json({ error: "That sign-in expired. Start again." });
  }
  const auth = await staffAuthStore.get(t.email);
  if (!auth || !auth.totp_secret) return res.status(401).json({ error: "Two-factor is not set up." });

  const given = String(code || "");
  let ok = verifyTotp(auth.totp_secret, given);
  let recovery = auth.recovery || [];
  if (!ok) {
    // A recovery code, for a lost phone. It is spent whether or not the rest
    // of the sign-in goes on to succeed.
    const left = spendRecovery(recovery, given);
    if (left) {
      ok = true;
      recovery = left;
      await staffAuthStore.save(t.email, {
        totpSecret: auth.totp_secret,
        confirmedAt: auth.confirmed_at,
        recovery,
      });
      console.warn(`staff used a recovery code: ${t.email} from ${caller}, ${recovery.length} left`);
    }
  }
  if (!ok) {
    noteFail(caller);
    console.warn(`second factor refused: ${t.email} from ${caller}`);
    return res.status(401).json({ error: "That code is not right." });
  }
  pending2fa.delete(String(pending));
  clearFails(caller);
  console.log(`staff signed in with two factors: ${t.email} from ${caller}`);
  res.json({ ...adminPayload(), token: mintSession(t.email), recoveryLeft: recovery.length });
});

/**
 * Start enrolling this session's staff member in two-factor: a fresh secret to
 * scan, kept unconfirmed until they type a code from it. Re-enrolling replaces
 * whatever was there, so a lost phone is recoverable from a signed-in session.
 */
app.post("/api/admin/2fa/start", requireStaff, async (req, res) => {
  const secret = newSecret();
  await staffAuthStore.save(req.staffEmail, { totpSecret: secret, confirmedAt: null, recovery: [] });
  res.json({ secret, otpauth: otpauthUrl(secret, req.staffEmail) });
});

/** Confirm enrolment with a code from the app, and hand back the recovery codes once. */
app.post("/api/admin/2fa/confirm", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  const auth = await staffAuthStore.get(req.staffEmail);
  if (!auth || !auth.totp_secret) return res.status(400).json({ error: "Start the setup first." });
  if (!verifyTotp(auth.totp_secret, (req.body || {}).code)) {
    return res.status(400).json({ error: "That code is not right - check the app and try again." });
  }
  const codes = newRecoveryCodes();
  await staffAuthStore.save(req.staffEmail, {
    totpSecret: auth.totp_secret,
    confirmedAt: new Date().toISOString(),
    recovery: codes.map(hashCode),
  });
  console.log(`two-factor confirmed for ${req.staffEmail}`);
  res.json({ ok: true, recovery: codes });
});

/** Turn two-factor off. Only from a session that is already signed in. */
app.post("/api/admin/2fa/off", requireStaff, async (req, res) => {
  await staffAuthStore.save(req.staffEmail, { totpSecret: null, confirmedAt: null, recovery: [] });
  console.warn(`two-factor turned off for ${req.staffEmail}`);
  res.json({ ok: true });
});

/** Whether this session's staff member has two-factor on, for the screen. */
app.get("/api/admin/2fa", requireStaff, async (req, res) => {
  const auth = await staffAuthStore.get(req.staffEmail);
  res.json({
    on: !!(auth && auth.totp_secret && auth.confirmed_at),
    started: !!(auth && auth.totp_secret && !auth.confirmed_at),
    recoveryLeft: auth ? (auth.recovery || []).length : 0,
  });
});

/**
 * Change the sign-in code from inside the app. Needs the code in force, so a
 * session someone walked away from cannot be used to lock its owner out, and
 * the current second factor when one is set up.
 */
app.post("/api/admin/code", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  const caller = signinKey(req);
  if (throttled(caller)) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  }
  const body = req.body || {};
  const current = String(body.current || "").trim();
  const next = String(body.next || "").trim();

  if (!(await checkAdminCode(current))) {
    noteFail(caller);
    console.warn(`sign-in code change refused, wrong current code, from ${caller}`);
    return res.status(401).json({ error: "That is not the current code." });
  }

  const auth = await staffAuthStore.get(req.staffEmail);
  if (auth && auth.totp_secret && auth.confirmed_at) {
    const otp = String(body.totp || "").trim();
    if (!verifyTotp(auth.totp_secret, otp)) {
      noteFail(caller);
      return res.status(401).json({ error: "That code from your authenticator app is not right." });
    }
  }

  if (PUBLISHED_CODES.has(next.toLowerCase())) {
    return res.status(400).json({ error: "That code has been published. Choose another." });
  }
  if (next.length < 10) {
    return res.status(400).json({ error: "Use at least ten characters." });
  }
  if (!db) {
    return res.status(503).json({ error: "There is no database to keep the code in." });
  }

  try {
    const hash = await hashSecret(next);
    await db.saveStaffCodeHash(ADMIN_EMAIL, hash);
    adminCred = { kind: "hash", value: hash };
  } catch (e) {
    console.error("could not save the new sign-in code:", e.message);
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  clearFails(caller);
  console.warn(`staff sign-in code changed by ${req.staffEmail} from ${caller}`);
  res.json({ ok: true, envOverride: envCodeUsable });
});

/** Where the sign-in code comes from, so the screen can say so. */
app.get("/api/admin/code", requireStaff, (req, res) => {
  res.json({ source: envCodeUsable ? "env" : db ? "app" : "memory", changeable: !envCodeUsable && !!db });
});

/** Mint a fresh link token for one group: the old address stops working. */
app.post("/api/admin/group-link/reset", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  const group = String((req.body || {}).group || "");
  const g = groups.find((x) => x.name === group);
  if (!g) return res.status(404).json({ error: "no such group" });
  const token = newLinkToken();
  meta[group] = { ...(meta[group] || {}), linkToken: token };
  try {
    if (db) await db.setMeta(group, "linkToken", token, req.staffEmail || null);
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  rebuild();
  res.json({ ok: true, linkToken: token, groups: adminGroups });
});

/** Set a group's access code or ALE bucket. */
/** Company details a human may correct. Name is excluded on purpose: it is the
 *  key an import matches on, so renaming would orphan the group. */
const EDITABLE_FIELDS = new Set([
  "address1", "city", "state", "zip", "sic", "sicDesc",
  "taxId", "phone", "corporationType", "situsState",
]);

app.post("/api/admin/group-meta", requireStaff, express.json({ limit: "16kb" }), async (req, res) => {
  const { group, field, value } = req.body || {};
  const isCompanyField = EDITABLE_FIELDS.has(field);
  if (!group || !(["companyId", "sizeCategory", "broker", "renewal", "archived", "manager", "groupStatus", "effectiveDate", "displayName", "effectiveDateLabel"].includes(field) || isCompanyField)) {
    return res.status(400).json({ error: "group and a valid field are required" });
  }
  if (!groups.some((g) => g.name === group)) {
    return res.status(404).json({ error: "no such group" });
  }

  if (isCompanyField) {
    const v = value == null ? null : String(value).trim();
    meta[group] = { ...(meta[group] || {}), fields: { ...((meta[group] || {}).fields || {}), [field]: v } };
    try {
      if (db) await db.setField(group, field, v, req.staffEmail || null);
    } catch (e) {
      return res.status(500).json({ error: "Could not save: " + e.message });
    }
    rebuild();
    return res.json({ ok: true, groups: adminGroups });
  }

  if (field === "archived") {
    meta[group] = { ...(meta[group] || {}), archived: !!value };
    try {
      if (db) await db.setMeta(group, "archived", !!value, req.staffEmail || null);
    } catch (e) {
      return res.status(500).json({ error: "Could not save: " + e.message });
    }
    rebuild();
    return res.json({ ok: true, groups: adminGroups });
  }

  let clean = value == null || value === "" ? null : String(value).trim();

  if (field === "companyId" && clean) {
    clean = clean.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length < 4) return res.status(400).json({ error: "Code must be at least 4 characters." });
    const holder = byCode.get(clean);
    if (holder && holder.name !== group) {
      return res.status(409).json({ error: `${clean} is already used by ${holder.name}.` });
    }
  }
  if (field === "sizeCategory" && clean && !["2-50", "51+"].includes(clean)) {
    return res.status(400).json({ error: "Size must be 2-50 or 51+." });
  }
  if (field === "broker" && clean && !["kennion", "outside"].includes(clean)) {
    return res.status(400).json({ error: "Broker must be kennion or outside." });
  }
  if (field === "manager" && clean && !Object.keys(MANAGERS).includes(clean)) {
    return res.status(400).json({ error: `Manager must be one of: ${Object.keys(MANAGERS).join(", ")}.` });
  }
  if (field === "renewal" && clean && !["open", "sent", "renewed", "non-renewed"].includes(clean)) {
    return res.status(400).json({ error: "Renewal must be open, sent, renewed or non-renewed." });
  }
  if (field === "groupStatus" && clean && !["new", "existing"].includes(clean)) {
    return res.status(400).json({ error: "Group status must be new or existing." });
  }
  if (field === "effectiveDate" && clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return res.status(400).json({ error: "Effective date must be YYYY-MM-DD." });
  }
  if (field === "displayName" && clean && clean.length > 200) {
    return res.status(400).json({ error: "Keep the name shown under 200 characters." });
  }
  if (field === "effectiveDateLabel" && clean && clean.length > 80) {
    return res.status(400).json({ error: "Keep the effective date shown under 80 characters." });
  }

  meta[group] = { ...(meta[group] || {}), [field]: clean };
  try {
    if (db) await db.setMeta(group, field, clean, req.staffEmail || null);
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  rebuild();
  res.json({ ok: true, groups: adminGroups });
});

/** Persist one hand-keyed rate. Shared across the team, not per-browser. */
/**
 * Locking the rates.
 *
 * Once the account managers have audited the book and their corrections are
 * in, the rates are the answer. Locking says so: no override, by hand or by
 * workbook, lands while the lock is on. It is a deliberate act with a name and
 * a time against it, and it can be lifted the same way.
 */
let ratesLock = null;
async function loadRatesLock() {
  if (!db) return;
  try {
    ratesLock = await db.getSetting("ratesLock");
  } catch (e) {
    console.error("could not read the rates lock:", e.message);
  }
}
const ratesLocked = () => !!(ratesLock && ratesLock.locked);

/**
 * What a client is shown of the market. No network rule: every quoted plan
 * is shown, EPO and narrow-network plans included - they are attributes the
 * client filters on, not reasons to remove an option. (The old "PPO only"
 * rule, which dropped EPO menu plans and mapped current plans to PPO twins,
 * is gone; marketRules.networks is now "all".)
 */
const DEFAULT_MARKET_RULES = { networks: "all" };
let marketRules = { ...DEFAULT_MARKET_RULES };
async function loadMarketRules() {
  if (!db) return;
  try {
    const stored = await db.getSetting("marketRules");
    // The retired "ppo-only" value is not carried forward.
    marketRules = { ...DEFAULT_MARKET_RULES, ...(stored && typeof stored === "object" ? stored : {}), networks: "all" };
    if (!stored || stored.networks !== "all") await db.setSetting("marketRules", marketRules, "system");
  } catch (e) {
    console.error("could not read the market rules:", e.message);
  }
}
/** Retired: nothing is filtered by network any more. */
const ppoOnly = () => false;
/** A proposal plan that is an EPO: says so in its network, its type, or its name. */
const isEpoPlan = (pl) =>
  /\bEPO\b/i.test(`${pl.network || ""} ${pl.plan_type || pl.planType || ""} ${pl.name || ""}`);
/** A UnitedHealthcare menu plan that is an EPO. */
const isEpoMenu = (m) => String(m.type || "").toUpperCase() === "EPO";

/**
 * Carrier logos. Staff upload each carrier's official file once (PNG, JPEG
 * or SVG, under 2 MB); the client's pages show it wherever the carrier is
 * named, and a carrier without one gets a lettered badge instead. The
 * images are branding, so they are served without a session.
 */
const CARRIERS = ["UnitedHealthcare", "Gravie", "Nationwide", "Angle Health", "Cobalt", "Optimyl Health", "HealthEZ", "EBPA", "BCBS of Alabama", "Guardian", "VSP"];
const carrierSlug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const carrierFromSlug = (slug) => CARRIERS.find((c) => carrierSlug(c) === slug) || null;
const memCarrierLogos = new Map();
const logoStore = {
  async list() {
    if (db) return db.listCarrierLogos();
    return [...memCarrierLogos.values()].map(({ data: _d, ...r }) => r);
  },
  async get(carrier) {
    if (db) return db.getCarrierLogo(carrier);
    return memCarrierLogos.get(carrier) || null;
  },
  async set(carrier, mime, data, by) {
    if (db) return db.setCarrierLogo(carrier, mime, data, by);
    memCarrierLogos.set(carrier, { carrier, mime, data, updatedAt: new Date().toISOString() });
  },
  async remove(carrier) {
    if (db) return db.deleteCarrierLogo(carrier);
    return memCarrierLogos.delete(carrier);
  },
};
const LOGO_MIMES = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp" };


app.get("/api/carriers/logos", async (_req, res) => {
  const have = await logoStore.list();
  res.setHeader("Cache-Control", "no-cache");
  res.json({ carriers: CARRIERS.map((c) => ({ carrier: c, slug: carrierSlug(c), logo: have.some((h) => h.carrier === c) })) });
});

app.get("/api/carriers/:slug/logo", async (req, res) => {
  const carrier = carrierFromSlug(req.params.slug);
  const logo = carrier && (await logoStore.get(carrier));
  if (!logo) return res.status(404).json({ error: "No logo on file." });
  res.setHeader("Content-Type", logo.mime);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(logo.data);
});

app.post("/api/admin/carriers/:slug/logo", requireStaff, express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
  const carrier = carrierFromSlug(req.params.slug);
  if (!carrier) return res.status(404).json({ error: "Not a carrier this portal knows." });
  const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!LOGO_MIMES[mime]) return res.status(400).json({ error: "Upload a PNG, JPEG, SVG or WebP." });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file received." });
  if (mime === "image/svg+xml" && /<script|on\w+\s*=|javascript:/i.test(req.body.toString("utf8"))) return res.status(400).json({ error: "That SVG carries script, which a logo must not." });
  await logoStore.set(carrier, mime, req.body, req.staffEmail || null);
  res.json({ ok: true, carrier, slug: carrierSlug(carrier) });
});

app.delete("/api/admin/carriers/:slug/logo", requireStaff, async (req, res) => {
  const carrier = carrierFromSlug(req.params.slug);
  if (!carrier || !(await logoStore.remove(carrier))) return res.status(404).json({ error: "No logo on file." });
  res.json({ ok: true });
});

/** The 15 current plan designs, as stored: every benefit line per plan name. */
app.get("/api/admin/plan-designs", requireStaff, async (_req, res) => {
  const stored = db ? await db.listPlanDesigns().catch(() => []) : [];
  if (stored.length) return res.json({ designs: stored, from: "database" });
  res.json({ designs: Object.entries(data.planDesigns || {}).map(([planName, benefits]) => ({ planName, planYear: 2026, tpa: null, benefits, source: "server/data/kennion.json" })), from: "file" });
});

/** Correct one plan's benefits by hand; the assistant and the pages read the new values on the next boot. */
app.post("/api/admin/plan-designs/:name", requireStaff, express.json({ limit: "32kb" }), async (req, res) => {
  const planName = String(req.params.name || "").trim();
  const benefits = req.body && typeof req.body.benefits === "object" && req.body.benefits ? req.body.benefits : null;
  if (!planName || !benefits) return res.status(400).json({ error: "A plan name and its benefits are required." });
  const clean = Object.fromEntries(Object.entries(benefits).map(([k, v]) => [String(k).slice(0, 80), String(v ?? "").slice(0, 200)]));
  data.planDesigns = { ...(data.planDesigns || {}), [planName]: clean };
  if (db) await db.upsertPlanDesigns([{ planName, planYear: 2026, tpa: req.body.tpa || null, benefits: clean, source: "edited by staff" }], req.staffEmail || "staff");
  res.json({ planName, benefits: clean });
});

/** Every carrier's standard plan designs: one summary per carrier and year, and every design. */
app.get("/api/admin/plan-catalogue", requireStaff, (_req, res) => {
  const carriers = new Map();
  for (const d of planCatalogue) {
    const k = `${d.carrier}|${d.planYear}`;
    const c = carriers.get(k) || { carrier: d.carrier, planYear: d.planYear, count: 0, sources: new Set(), updatedAt: null };
    c.count++;
    if (d.source) c.sources.add(d.source);
    if (d.updatedAt && (!c.updatedAt || d.updatedAt > c.updatedAt)) c.updatedAt = d.updatedAt;
    carriers.set(k, c);
  }
  res.json({
    carriers: [...carriers.values()].map((c) => ({ ...c, sources: [...c.sources] })),
    designs: planCatalogue,
    durable: !!db,
  });
});

/**
 * Load a carrier's catalogue workbook (the two-sheet shape in
 * server/plan-catalogue.js). Designs are added by plan code, replacing any
 * already there under the same code; the rest of the carrier's catalogue
 * stays. Every group's proposals from that carrier carry the designs at once.
 */
app.post("/api/admin/plan-catalogue/:slug", requireStaff, express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
  const carrier = carrierFromSlug(req.params.slug);
  if (!carrier) return res.status(404).json({ error: "No such carrier." });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file received." });
  const planYear = Number(req.query.year) || 2027;
  const source = String(req.query.filename || "").slice(0, 200) || null;
  try {
    const designs = parseCatalogueWorkbook(req.body, { carrier, planYear, source });
    if (db) await db.upsertCarrierDesigns(designs, req.staffEmail || "staff");
    else uploadedCatalogue.push(...designs);
    await loadPlanCatalogue();
    await proposalsChanged();
    const total = planCatalogue.filter((d) => d.carrier === carrier && d.planYear === planYear).length;
    console.log(`plan catalogue: ${designs.length} ${carrier} design(s) loaded by ${req.staffEmail || "staff"}; ${total} on file`);
    res.json({ carrier, planYear, loaded: designs.length, total, codes: designs.map((d) => d.planCode) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** A plan code as it appears in a URL: "ANG TRAD 5000 7000" -> "ang-trad-5000-7000", and back. */
const planCodeSlug = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
const planCodeFromSlug = (slug) => String(slug || "").toUpperCase().replace(/-/g, " ").trim();

/**
 * A carrier's SBC or SOB for one standard design - the actual PDF, not the
 * figures read off it. Served without a session, like the plan catalogue's
 * figures themselves: the same document for every group quoted that design.
 */
app.get("/api/carriers/:slug/plan-documents/:planSlug/:docType", async (req, res) => {
  const carrier = carrierFromSlug(req.params.slug);
  const docType = String(req.params.docType || "").toUpperCase();
  if (!carrier || (docType !== "SBC" && docType !== "SOB")) return res.status(404).json({ error: "No such document." });
  const planYear = Number(req.query.year) || 2027;
  const planCode = planCodeFromSlug(req.params.planSlug);
  const key = planDocKey(carrier, planYear, planCode, docType);
  let doc = db ? await db.getPlanDocument(carrier, planYear, planCode, docType).catch(() => null) : null;
  if (!doc) {
    const fb = planDocumentFallback.get(key);
    if (fb) doc = fb;
  }
  if (!doc) return res.status(404).json({ error: "No document on file for that plan." });
  res.setHeader("Content-Type", doc.mime || "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${String(doc.filename || `${planCode} ${docType}.pdf`).replace(/[\r\n"]/g, "")}"`);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(doc.data);
});

/** Every plan document on file, metadata only, for staff to review what is loaded. */
app.get("/api/admin/plan-documents", requireStaff, async (_req, res) => {
  res.json({ documents: [...planDocuments.values()], durable: !!db });
});

/** Staff replaces or adds one design's SBC or SOB by hand, without a deploy; a row in the database always wins over the shipped file. */
app.post("/api/admin/plan-documents/:slug/:planSlug/:docType", requireStaff, express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
  const carrier = carrierFromSlug(req.params.slug);
  const docType = String(req.params.docType || "").toUpperCase();
  if (!carrier || (docType !== "SBC" && docType !== "SOB")) return res.status(404).json({ error: "No such document." });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file received." });
  const contentType = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType && contentType !== "application/pdf") return res.status(400).json({ error: "Upload a PDF." });
  const planYear = Number(req.query.year) || 2027;
  const planCode = planCodeFromSlug(req.params.planSlug);
  const filename = String(req.query.filename || `${planCode} ${docType}.pdf`).slice(0, 200);
  if (!db) return res.status(400).json({ error: "No database is configured, so an uploaded document cannot be kept." });
  await db.upsertPlanDocuments([{ carrier, planYear, planCode, docType, filename, mime: "application/pdf", data: req.body, source: "uploaded by staff" }], req.staffEmail || "staff");
  await loadPlanDocuments();
  await loadPlanCatalogue();
  res.json({ ok: true, carrier, planCode, docType });
});

/**
 * Marketing material for the Resources page - broker decks, one-pagers,
 * FAQs - not a plan document or a proposal. Staff upload a file; Claude
 * reads it and files it under a vendor immediately, no review step, so it
 * is live on the shared Resources page (the same page every group sees) as
 * soon as it is read. Staff can still fix a wrong guess, or take it down.
 */
const memResources = [];
let memResourceNextId = 1;
const resourceStore = {
  async list() {
    if (db) return db.listMarketingResources();
    return memResources.map(({ data: _d, ...r }) => r);
  },
  async get(id) {
    if (db) return db.getMarketingResource(id);
    return memResources.find((r) => r.id === id) || null;
  },
  async add({ carrier, title, summary, filename, mime, size, data, uploadedBy }) {
    if (db) return db.addMarketingResource({ carrier, title, summary, filename, mime, size, data, uploadedBy });
    const id = memResourceNextId++;
    const uploadedAt = new Date().toISOString();
    memResources.unshift({ id, carrier, title, summary, filename, mime, size, data, uploadedBy, uploadedAt, updatedBy: null, updatedAt: uploadedAt });
    return { id, uploadedAt };
  },
  async update(id, fields, by) {
    if (db) return db.updateMarketingResource(id, fields, by);
    const r = memResources.find((x) => x.id === id);
    if (!r) return false;
    if (fields.carrier) r.carrier = fields.carrier;
    if (fields.title) r.title = fields.title;
    r.updatedBy = by || null;
    r.updatedAt = new Date().toISOString();
    return true;
  },
  async remove(id) {
    if (db) return db.deleteMarketingResource(id);
    const i = memResources.findIndex((x) => x.id === id);
    if (i === -1) return false;
    memResources.splice(i, 1);
    return true;
  },
};

/**
 * Marketing material shipped with the code, read once by hand rather than
 * through the AI upload route (there is no admin session to upload through
 * at boot). Seeded into kennion.marketing_resources where a resource of
 * that carrier and filename is not already on file - staff editing a title,
 * moving a resource to another vendor, or removing one outright all stick,
 * since the seed only ever fills a gap, never overwrites.
 */
const RESOURCE_SEED = [
  { carrier: "Gravie", dir: "gravie", file: "Gravie_Pay_Member_FAQ.pdf", title: "Gravie Pay Member FAQ", summary: "How Gravie Pay lets a member split a medical expense into no-interest monthly payments through Paytient." },
  { carrier: "Gravie", dir: "gravie", file: "Gravie_Mobile_App_Flyer.pdf", title: "The Gravie Mobile App", summary: "What members and their dependents can do in the Gravie app to find and manage care." },
  { carrier: "Gravie", dir: "gravie", file: "Gravie_Level_Funded_Health_Plans_Flyer.pdf", title: "Gravie Level-Funded Health Plans", summary: "Predictable costs, flexible plan designs and national coverage on Gravie's level-funded plans." },
  { carrier: "Gravie", dir: "gravie", file: "Gravie_Member_Testimonials.pdf", title: "What Members Love About Gravie", summary: "Member testimonials and satisfaction highlights from Gravie's health plans." },
  { carrier: "Gravie", dir: "gravie", file: "Gravie_Provider_Guidance_Cigna.pdf", title: "Talking To Providers About Your Gravie Plan", summary: "How to explain a Gravie/Cigna plan to a provider's office, and where to get help if a provider has questions." },
  { carrier: "Gravie", dir: "gravie", file: "Gravie_Level_Funded_Broker_Ebook.pdf", title: "Level-Funded eBook", summary: "Gravie's broker-facing overview of level-funded health plans and its approach to small and midsize business benefits." },
  { carrier: "Gravie", dir: "gravie", file: "Who_Is_Gravie_Overview.pdf", title: "Who Is Gravie?", summary: "An overview of Gravie's approach to group health plans and ICHRAs for small and midsize employers." },
  // Guardian and VSP benefit summaries - the standing supplemental/dental/vision lineup, the
  // same for every group as part of the Kennion Program, not tied to a plan year.
  { carrier: "Guardian", dir: "guardian", file: "Accident_Insurance.pdf", title: "Accident Insurance Benefit Summary", summary: "Cash benefits paid directly to you for injuries, treatments and services from a covered accident." },
  { carrier: "Guardian", dir: "guardian", file: "Cancer_Insurance.pdf", title: "Cancer Insurance Benefit Summary", summary: "Lump-sum cash payments for procedures, screenings and treatments related to a covered cancer diagnosis." },
  { carrier: "Guardian", dir: "guardian", file: "Critical_Illness_Insurance.pdf", title: "Critical Illness Insurance Benefit Summary", summary: "A cash benefit for a range of covered serious illnesses such as cancer, stroke and heart attack." },
  { carrier: "Guardian", dir: "guardian", file: "Hospital_Indemnity_Insurance.pdf", title: "Hospital Indemnity Insurance Benefit Summary", summary: "Cash benefits for hospital admission, confinement, surgery and related care." },
  { carrier: "Guardian", dir: "guardian", file: "Voluntary_Life_Insurance.pdf", title: "Voluntary Life Insurance Benefit Summary", summary: "Employee, spouse and child life coverage amounts, guarantee issue and portability." },
  { carrier: "Guardian", dir: "guardian", file: "Voluntary_Disability_Insurance.pdf", title: "Voluntary Disability Insurance Benefit Summary", summary: "Short-term disability income protection - benefit amount, elimination period and duration." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Basic.pdf", title: "Basic Dental Benefit Summary", summary: "Guardian's Basic Dental plan - coverage levels, deductible and annual maximum." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Value.pdf", title: "Value Dental Benefit Summary", summary: "Guardian's Value Dental plan - coverage levels, deductible and annual maximum." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Value_with_Ortho.pdf", title: "Value Dental with Ortho Benefit Summary", summary: "Guardian's Value Dental plan with orthodontia coverage added." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Choice.pdf", title: "Choice Dental Benefit Summary", summary: "Guardian's Choice Dental plan - coverage levels, deductible and annual maximum." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Complete.pdf", title: "Complete Dental Benefit Summary", summary: "Guardian's Complete Dental plan - coverage levels, deductible and annual maximum." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Complete_with_Ortho.pdf", title: "Complete Dental with Ortho Benefit Summary", summary: "Guardian's Complete Dental plan with orthodontia coverage added." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Advantage_with_Ortho.pdf", title: "Advantage Dental with Ortho Benefit Summary", summary: "Guardian's Advantage Dental plan with orthodontia coverage added." },
  { carrier: "VSP", dir: "vsp", file: "Vision_Value.pdf", title: "Value Vision Benefit Summary", summary: "VSP's Value Vision plan - exam, lens and frame allowance, and frequency." },
  { carrier: "VSP", dir: "vsp", file: "Vision_Base.pdf", title: "Base Vision Benefit Summary", summary: "VSP's Base Vision plan - exam, lens and frame allowance, and frequency." },
  { carrier: "VSP", dir: "vsp", file: "Vision_Standard.pdf", title: "Standard Vision Benefit Summary", summary: "VSP's Standard Vision plan - exam, lens and frame allowance, and frequency." },
  { carrier: "VSP", dir: "vsp", file: "Vision_Premium.pdf", title: "Premium Vision Benefit Summary", summary: "VSP's Premium Vision plan - exam, lens and frame allowance, and frequency." },
  // Full legal Certificates, Guardian's own enrollment-system printouts, and
  // the group's original (Dec 2022) per-option enrollment paperwork - kept on
  // file alongside the benefit-summary one-pagers above for complete records.
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Guardian_1.pdf", title: "Guardian Group Policy Certificate 1", summary: "Full legal certificate of coverage for the Guardian supplemental lines." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Guardian_2.pdf", title: "Guardian Group Policy Certificate 2", summary: "Full legal certificate of coverage for the Guardian supplemental lines." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Guardian_3.pdf", title: "Guardian Group Policy Certificate 3", summary: "Full legal certificate of coverage for the Guardian supplemental lines." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Group_Life_Policy.pdf", title: "Group Life Policy Certificate", summary: "Full legal certificate of coverage for Guardian voluntary life/AD&D." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Critical_Illness.pdf", title: "Critical Illness Certificate", summary: "Full legal certificate of coverage for Guardian Critical Illness." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_STD.pdf", title: "Short Term Disability Certificate", summary: "Full legal certificate of coverage for Guardian Voluntary Disability." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Dental_Advantage_with_Ortho.pdf", title: "Advantage Dental with Ortho Certificate", summary: "Full legal certificate of coverage for Advantage Dental with Ortho." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Dental_Basic.pdf", title: "Basic Dental Certificate", summary: "Full legal certificate of coverage for Basic Dental." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Dental_Choice.pdf", title: "Choice Dental Certificate", summary: "Full legal certificate of coverage for Choice Dental." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Dental_Complete.pdf", title: "Complete Dental Certificate", summary: "Full legal certificate of coverage for Complete Dental." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Dental_Complete_with_Ortho.pdf", title: "Complete Dental with Ortho Certificate", summary: "Full legal certificate of coverage for Complete Dental with Ortho." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Dental_Value.pdf", title: "Value Dental Certificate", summary: "Full legal certificate of coverage for Value Dental." },
  { carrier: "Guardian", dir: "guardian", file: "Certificate_Dental_Value_with_Ortho.pdf", title: "Value Dental with Ortho Certificate", summary: "Full legal certificate of coverage for Value Dental with Ortho." },
  { carrier: "Guardian", dir: "guardian", file: "Enrollment_Summary_Class_0001.pdf", title: "Guardian Enrollment Summary - Class 0001", summary: "Guardian's own enrollment-system benefit summary for employees electing $5,000-$25,000 in basic life coverage: Critical Illness, Accident, Cancer and Hospital Indemnity." },
  { carrier: "Guardian", dir: "guardian", file: "Enrollment_Summary_Class_0002.pdf", title: "Guardian Enrollment Summary - Class 0002", summary: "Guardian's own enrollment-system benefit summary for employees electing $30,000 in basic life coverage: Critical Illness, Accident, Cancer and Hospital Indemnity." },
  { carrier: "Guardian", dir: "guardian", file: "Enrollment_Summary_Class_0003.pdf", title: "Guardian Enrollment Summary - Class 0003", summary: "Guardian's own enrollment-system benefit summary for employees electing $50,000-$100,000 in life coverage: Critical Illness, Accident, Cancer and Hospital Indemnity." },
  { carrier: "Guardian", dir: "guardian", file: "Accident_Enrollment_Option_A.pdf", title: "Accident Insurance - Enrollment Paperwork", summary: "Original group enrollment documentation for Accident Insurance." },
  { carrier: "Guardian", dir: "guardian", file: "Cancer_Enrollment_Option_A.pdf", title: "Cancer Insurance - Enrollment Paperwork", summary: "Original group enrollment documentation for Cancer Insurance." },
  { carrier: "Guardian", dir: "guardian", file: "Critical_Illness_Enrollment.pdf", title: "Critical Illness Insurance - Enrollment Paperwork", summary: "Original group enrollment documentation for Critical Illness Insurance." },
  { carrier: "Guardian", dir: "guardian", file: "STD_Enrollment.pdf", title: "Voluntary Disability - Enrollment Paperwork", summary: "Original group enrollment documentation for Voluntary Short Term Disability." },
  { carrier: "Guardian", dir: "guardian", file: "Life_Enrollment_Basic_and_Voluntary.pdf", title: "Basic and Voluntary Life - Enrollment Paperwork", summary: "Original group enrollment documentation for Basic and Voluntary Life insurance." },
  { carrier: "Guardian", dir: "guardian", file: "Life_Enrollment_10000.pdf", title: "Voluntary Life $10,000 - Enrollment Paperwork", summary: "Original group enrollment documentation for the $10,000 Voluntary Life option." },
  { carrier: "Guardian", dir: "guardian", file: "Life_Enrollment_25000.pdf", title: "Voluntary Life $25,000 - Enrollment Paperwork", summary: "Original group enrollment documentation for the $25,000 Voluntary Life option." },
  { carrier: "Guardian", dir: "guardian", file: "Life_Enrollment_30000.pdf", title: "Voluntary Life $30,000 - Enrollment Paperwork", summary: "Original group enrollment documentation for the $30,000 Voluntary Life option." },
  { carrier: "Guardian", dir: "guardian", file: "Hospital_Indemnity_Enrollment_500.pdf", title: "Hospital Indemnity $500 Plan - Enrollment Paperwork", summary: "Original group enrollment documentation for the $500 Hospital Indemnity plan." },
  { carrier: "Guardian", dir: "guardian", file: "Hospital_Indemnity_Enrollment_1000.pdf", title: "Hospital Indemnity $1,000 Plan - Enrollment Paperwork", summary: "Original group enrollment documentation for the $1,000 Hospital Indemnity plan." },
  { carrier: "Guardian", dir: "guardian", file: "Hospital_Indemnity_Enrollment_2000.pdf", title: "Hospital Indemnity $2,000 Plan - Enrollment Paperwork", summary: "Original group enrollment documentation for the $2,000 Hospital Indemnity plan." },
  { carrier: "Guardian", dir: "guardian", file: "Hospital_Indemnity_Enrollment_3000.pdf", title: "Hospital Indemnity $3,000 Plan - Enrollment Paperwork", summary: "Original group enrollment documentation for the $3,000 Hospital Indemnity plan." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Enrollment_Class_0007.pdf", title: "Dental - Class 0007 Enrollment Paperwork", summary: "Original group enrollment documentation for Dental, Class 0007." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Enrollment_Base_Opt1_Texas.pdf", title: "Dental Base, Option 1 (Texas) - Enrollment Paperwork", summary: "Original group enrollment documentation for the Base Dental plan, Option 1, Texas." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Enrollment_Complete_Opt2_Texas.pdf", title: "Complete Dental, Option 2 (Texas) - Enrollment Paperwork", summary: "Original group enrollment documentation for the Complete Dental plan, Option 2, Texas." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Enrollment_Value_Opt2_Texas.pdf", title: "Value Dental, Option 2 (Texas) - Enrollment Paperwork", summary: "Original group enrollment documentation for the Value Dental plan, Option 2, Texas." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Enrollment_Value_Ortho_Opt4_Texas.pdf", title: "Value Dental with Ortho, Option 4 (Texas) - Enrollment Paperwork", summary: "Original group enrollment documentation for Value Dental with Ortho, Option 4, Texas." },
  { carrier: "Guardian", dir: "guardian", file: "Dental_Enrollment_Complete_Ortho_Opt6_Texas.pdf", title: "Complete Dental with Ortho, Option 6 (Texas) - Enrollment Paperwork", summary: "Original group enrollment documentation for Complete Dental with Ortho, Option 6, Texas." },
  { carrier: "VSP", dir: "vsp", file: "Certificate_Vision.pdf", title: "Vision Certificate", summary: "Full legal certificate of coverage for VSP vision insurance." },
  { carrier: "VSP", dir: "vsp", file: "Contract_2020.pdf", title: "VSP Contract (2020)", summary: "VSP's group vision contract on file, effective January 1, 2020." },
  { carrier: "VSP", dir: "vsp", file: "Evidence_of_Coverage_2020.doc", title: "VSP Evidence of Coverage (2020)", summary: "VSP's evidence of coverage document on file, effective January 1, 2020." },
];
async function loadMarketingResources() {
  const have = new Set((await resourceStore.list()).map((r) => `${r.carrier}|${r.filename}`));
  let seeded = 0;
  for (const r of RESOURCE_SEED) {
    if (have.has(`${r.carrier}|${r.file}`)) continue;
    let data;
    try {
      data = fs.readFileSync(path.join(__dirname, "data", "resources", r.dir, r.file));
    } catch (e) {
      console.error(`resource seed: ${r.file}:`, e.message);
      continue;
    }
    const mime = /\.docx?$/i.test(r.file) ? "application/msword" : "application/pdf";
    await resourceStore.add({ carrier: r.carrier, title: r.title, summary: r.summary || null, filename: r.file, mime, size: data.length, data, uploadedBy: "system" });
    seeded++;
  }
  if (seeded) console.log(`resources: seeded ${seeded} marketing resource(s)`);
}

/** Every resource on file, metadata only - the Resources page groups these by carrier itself. Public: this page is the same for every group, no session needed. */
app.get("/api/resources", async (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.json({ resources: await resourceStore.list() });
});

/**
 * The standardized dental/vision/supplemental/legacy-medical benefit
 * summaries, read by the assistant's own context (describeGroup) and by the
 * Supplemental Package page's per-row detail popup. Public and the same for
 * every group, like the rate grid it accompanies - no session needed.
 */
app.get("/api/benefit-summaries", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.json({ benefitSummaries: BENEFIT_SUMMARIES });
});

/** One resource's actual file. */
app.get("/api/resources/:id/file", async (req, res) => {
  const id = Number(req.params.id);
  const r = id && (await resourceStore.get(id));
  if (!r) return res.status(404).json({ error: "No such resource." });
  res.setHeader("Content-Type", r.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${String(r.filename || "resource").replace(/[\r\n"]/g, "")}"`);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(r.data);
});

/**
 * Staff uploads one piece of marketing material, or a .zip of several;
 * Claude reads each one and files it under a vendor immediately. A zip is
 * opened with the same reader a proposal upload uses - folders, macOS junk
 * and anything unsupported inside it are left out rather than failing the
 * whole upload - and every file it yields is read and filed on its own.
 * 60mb, matching every other batch-zip upload here (invoices, proposals):
 * a handful of full-size PDF decks zipped together clears 20mb easily.
 */
app.post("/api/admin/resources", requireStaff, express.raw({ type: () => true, limit: "60mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file received." });
  const filename = String(req.query.filename || "resource").slice(0, 200);
  const mime = String(req.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
  try {
    const { items, skipped } = await expandUpload({ buffer: req.body, mime, filename });
    if (!items.length) return res.status(400).json({ error: `"${filename}" has nothing this reads. Upload ${SUPPORTED}.` });

    const filed = [];
    const failed = [...(skipped || [])];
    for (const it of items) {
      try {
        const prepared = await prepareForModel(it);
        const read = await categorizeResource({ filename: it.filename, prepared });
        const carrier = CARRIERS.find((c) => c.toLowerCase() === String(read.carrier || "").toLowerCase()) || "Other";
        const title = String(read.title || it.filename).slice(0, 200);
        const summary = read.summary ? String(read.summary).slice(0, 400) : null;
        const { id, uploadedAt } = await resourceStore.add({ carrier, title, summary, filename: it.filename, mime: it.mime, size: it.buffer.length, data: it.buffer, uploadedBy: req.staffEmail || null });
        console.log(`resource ${id}: "${title}" filed under ${carrier} by ${req.staffEmail || "staff"}`);
        filed.push({ id, carrier, title, summary, filename: it.filename, mime: it.mime, size: it.buffer.length, uploadedAt });
      } catch (e) {
        failed.push(`${it.filename}: ${e.message}`);
      }
    }
    if (!filed.length) return res.status(422).json({ error: failed[0] || "Nothing could be filed." });
    res.json({ resources: filed, failed });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** Staff corrects a wrong AI guess: carrier and/or title. The file itself is not replaceable here - delete and re-upload for that. */
app.patch("/api/admin/resources/:id", requireStaff, express.json({ limit: "8kb" }), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(404).json({ error: "No such resource." });
  const carrier = req.body && typeof req.body.carrier === "string" ? req.body.carrier.trim().slice(0, 80) : null;
  const title = req.body && typeof req.body.title === "string" ? req.body.title.trim().slice(0, 200) : null;
  if (!carrier && !title) return res.status(400).json({ error: "Nothing to change." });
  const ok = await resourceStore.update(id, { carrier, title }, req.staffEmail || null);
  if (!ok) return res.status(404).json({ error: "No such resource." });
  res.json({ ok: true });
});

app.delete("/api/admin/resources/:id", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  if (!id || !(await resourceStore.remove(id))) return res.status(404).json({ error: "No such resource." });
  res.json({ ok: true });
});

app.get("/api/admin/market-rules", requireStaff, (req, res) => {
  res.json(marketRules);
});

app.post("/api/admin/market-rules", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  const networks = String((req.body || {}).networks || "");
  if (networks !== "all") return res.status(400).json({ error: "Every quoted plan is shown; the only client control is a proposal slot ON or OFF per group." });
  const next = { ...marketRules, networks, by: req.staffEmail || null, at: new Date().toISOString() };
  try {
    if (db) await db.setSetting("marketRules", next, req.staffEmail || null);
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  marketRules = next;
  console.warn(`market rules: networks=${networks} by ${req.staffEmail}`);
  res.json(next);
});

/** The Welcome page copy for both statuses, and the defaults a reset goes back to. */
app.get("/api/admin/welcome-copy", requireStaff, (req, res) => {
  res.json({ copy: { existing: welcomeFor("existing"), new: welcomeFor("new") }, defaults: DEFAULT_WELCOME, savedAt: welcomeCopy.at || null, savedBy: welcomeCopy.by || null });
});

/**
 * Save one status's Welcome copy - every group of that status reads it on its
 * next page load. `reset: true` drops what staff saved, back to the defaults.
 */
app.post("/api/admin/welcome-copy", requireStaff, express.json({ limit: "64kb" }), async (req, res) => {
  const { status, copy, reset } = req.body || {};
  if (!WELCOME_STATUSES.includes(status)) return res.status(400).json({ error: "status must be existing or new" });
  let entry = {};
  if (!reset) {
    const cleaned = cleanWelcome(copy);
    if (typeof cleaned === "string") return res.status(400).json({ error: cleaned });
    entry = cleaned;
  }
  const next = { ...welcomeCopy, [status]: entry, by: req.staffEmail || null, at: new Date().toISOString() };
  try {
    if (db) await db.setSetting(WELCOME_KEY, next, req.staffEmail || null);
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  welcomeCopy = next;
  res.json({ copy: { existing: welcomeFor("existing"), new: welcomeFor("new") }, defaults: DEFAULT_WELCOME, savedAt: next.at, savedBy: next.by });
});

app.get("/api/admin/rates-lock", requireStaff, (req, res) => {
  res.json(ratesLock || { locked: false });
});

/**
 * The rate the workbook showed for one cell.
 *
 * This must match what the screen and the workbook display, derivation
 * included: nearly half the tiers have no billed rate and are shown as the
 * employee rate at the program factors. Comparing against the billed rate
 * alone would read every one of those, returned untouched, as a correction.
 *
 * `undefined` means there is no such group and plan, which the reader reports
 * rather than inventing a row for.
 */
function shownRate(group, plan, censusTier) {
  const g = groups.find((x) => x.name === group);
  if (!g) return undefined;
  // Only the program's own administrators are rate-administered here, so a
  // workbook cannot write a rate for a plan this page would never have shown.
  const p = (g.plans || []).find((x) => x.plan === plan);
  if (!p) return undefined;
  const tpa = String(p.tpa || g.tpa || "").trim().toLowerCase();
  if (!PROGRAM_TPAS.some((t) => t.toLowerCase() === tpa)) return undefined;

  const billed = (g.rates || {})[plan] || {};
  const at = (census) => {
    const ov = overrides[`${group}||${plan}||${census}`];
    if (ov != null && String(ov) !== "") return Number(ov);
    return billed[census] == null ? null : Number(billed[census]);
  };

  const own = at(censusTier);
  if (own != null) return own;

  // Same base as the screen: the employee rate if there is one, else the
  // average of the bases each known tier implies.
  const tier = RATE_TIERS.find((t) => t.census === censusTier);
  if (!tier) return null;
  const ee = at("Employee");
  let base = ee;
  if (base == null) {
    const implied = RATE_TIERS.map((t) => {
      const v = at(t.census);
      return v == null ? null : v / t.factor;
    }).filter((v) => v != null);
    if (!implied.length) return null;
    base = implied.reduce((a, b) => a + b, 0) / implied.length;
  }
  return +(base * tier.factor).toFixed(2);
}

/**
 * The audit workbook, filled in and sent back.
 *
 * Reading and applying are separate on purpose: the first call says what would
 * change and what could not be read, and nothing is written until a second
 * call asks for it. A workbook that comes back with a hundred corrections is
 * worth looking at before it lands on the rates.
 */
app.post(
  "/api/admin/rates-workbook",
  requireStaff,
  express.raw({ type: () => true, limit: "20mb" }),
  async (req, res) => {
    const apply = String(req.query.apply || "") === "1";
    const filename = String(req.query.filename || "audit.xlsx").slice(0, 200);
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "No file received." });
    }
    if (apply && ratesLocked()) {
      return res.status(423).json({ error: "The rates are locked. Unlock them to apply corrections." });
    }

    let read;
    try {
      read = readAuditWorkbook(req.body, shownRate);
    } catch (e) {
      return res.status(400).json({ error: "Could not read that workbook: " + e.message });
    }
    if (!read.sheetsRead) {
      return res.status(400).json({
        error:
          "No rate sheet in that file. It needs Group and Plan columns and at least one tier column - send back the workbook this page produced.",
      });
    }

    if (!apply) {
      return res.json({ ...read, filename, applied: false });
    }

    const failed = [];
    let applied = 0;
    for (const c of read.changes) {
      const key = `${c.group}||${c.plan}||${c.censusTier}`;
      try {
        if (db) await db.setOverride(c.group, c.plan, c.censusTier, c.rate, req.staffEmail || null);
        overrides[key] = String(c.rate);
        applied++;
      } catch (e) {
        failed.push({ ...c, reason: e.message });
      }
    }
    console.log(`rates audit applied: ${applied} of ${read.changes.length} from ${filename} by ${req.staffEmail}`);
    await refreshAudit();
    res.json({ ...read, filename, applied: true, appliedCount: applied, failed, overrides });
  },
);

app.post("/api/admin/rates-lock", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  const locked = !!(req.body || {}).locked;
  const next = locked
    ? { locked: true, by: req.staffEmail || null, at: new Date().toISOString() }
    : { locked: false, by: req.staffEmail || null, at: new Date().toISOString() };
  try {
    if (db) await db.setSetting("ratesLock", next, req.staffEmail || null);
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  ratesLock = next;
  console.warn(`rates ${locked ? "locked" : "unlocked"} by ${req.staffEmail}`);
  res.json(next);
});

app.post("/api/admin/override", requireStaff, express.json({ limit: "16kb" }), async (req, res) => {
  if (ratesLocked()) {
    return res.status(423).json({ error: "The rates are locked. Unlock them to make a change." });
  }
  const { group, plan, censusTier, rate } = req.body || {};
  if (!group || !plan || !censusTier) {
    return res.status(400).json({ error: "group, plan and censusTier are required" });
  }
  const key = `${group}||${plan}||${censusTier}`;
  const clean = rate === "" || rate == null ? null : Number(String(rate).replace(/[^0-9.]/g, ""));
  if (clean != null && !isFinite(clean)) return res.status(400).json({ error: "rate must be a number" });

  if (clean == null) delete overrides[key];
  else overrides[key] = String(clean);

  try {
    if (db) await db.setOverride(group, plan, censusTier, clean, req.staffEmail || null);
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  res.json({ ok: true, key, rate: clean });
});

/**
 * Carrier proposals.
 *
 * Each uploaded file is stored whole (Postgres when configured, memory
 * otherwise - the screen says which) and then read by Claude in the
 * background: carrier, the group named on the paper, plans and tier rates, and
 * the roster group it matches with a confidence. A confident match is assigned
 * outright; a weaker one is suggested for review; no match leaves the proposal
 * in the queue for staff to assign by hand. Any assignment can be changed.
 */
const memProposals = [];
let memNextId = 1;
// Local end-to-end runs only: with no database, KENNION_SEED_PROPOSALS names
// a JSON file of proposal rows (group_name, slot, carrier, extracted) to
// start from, so a test can put quoted plans in front of the assistant.
if (!db && process.env.KENNION_SEED_PROPOSALS) {
  try {
    for (const r of JSON.parse(fs.readFileSync(process.env.KENNION_SEED_PROPOSALS, "utf8"))) {
      memProposals.push({ mime: "application/pdf", size: 0, data: null, summary: null, confidence: null, error: null, uploaded_by: null, parent_id: null, context: null, superseded_by: null, kind: "file", status: "assigned", filename: `${r.slot}.pdf`, uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r, id: memNextId++ });
    }
    console.log(`proposals: ${memProposals.length} seeded from ${process.env.KENNION_SEED_PROPOSALS}`);
  } catch (e) {
    console.error("could not seed proposals:", e.message);
  }
}
function stripBytes(row) {
  const { data, ...rest } = row;
  return rest;
}
const proposalStore = db
  ? db
  : {
      async addProposal(p) {
        const row = {
          id: memNextId++,
          group_name: p.group_name || null,
          carrier: p.carrier || null,
          filename: p.filename,
          mime: p.mime,
          size: p.size,
          data: p.data,
          extracted: null,
          summary: null,
          confidence: null,
          status: p.status || "analyzing",
          assigned_by: p.assigned_by || null,
          error: null,
          uploaded_by: p.uploaded_by || null,
          uploaded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          kind: p.kind || "file",
          parent_id: p.parent_id || null,
          context: p.context || null,
          slot: p.slot || null,
          superseded_by: null,
          source_sha: p.data ? crypto.createHash("sha256").update(p.data).digest("hex") : null,
          stage: "UPLOADED",
          stage_reason: null,
        };
        memProposals.unshift(row);
        return stripBytes(row);
      },
      async listProposals() {
        return memProposals.map(stripBytes);
      },
      async updateProposal(id, fields) {
        const row = memProposals.find((r) => r.id === id);
        if (!row) return null;
        Object.assign(row, fields, { updated_at: new Date().toISOString() });
        return stripBytes(row);
      },
      async getProposalFile(id) {
        const row = memProposals.find((r) => r.id === id);
        return row ? { filename: row.filename, mime: row.mime, data: row.data } : null;
      },
      async deleteProposal(id) {
        const i = memProposals.findIndex((r) => r.id === id);
        if (i < 0) return false;
        const gone = new Set();
        for (let j = memProposals.length - 1; j >= 0; j--) {
          if (memProposals[j].id === id || memProposals[j].parent_id === id) gone.add(memProposals.splice(j, 1)[0].id);
        }
        // Every row read from the proposal goes with it.
        for (const [k, q] of memQuotes) if (gone.has(q.proposalId)) memQuotes.delete(k);
        for (const g of gone) memAuditJobs.delete(g);
        return true;
      },
    };

/**
 * The medical proposals a group can hold, one per slot, and nothing else. A
 * newer one in a slot replaces the older, which is kept. Surest is a
 * UnitedHealthcare product, so a Surest quote is that group's UHC proposal;
 * an ancillary-only document (dental, vision, life) fills no slot at all.
 */
const SLOTS = ["UHC Fully Insured", "UHC Level Funded", "Gravie", "Angle", "Optimyl"];

/**
 * Slots no longer offered: Cobalt, Nationwide and the Angle Health Scorecard
 * (a companion document, not a rate quote). A proposal already filed under
 * one keeps it - stored, never deleted - but it is not on the grid, not
 * checked, not counted and never served to a client. A new Nationwide quote
 * or Angle scorecard fills no slot.
 */
const RETIRED_SLOTS = ["Cobalt", "Nationwide", "Angle Scorecard"];
const retiredSlot = (slot) => RETIRED_SLOTS.includes(slot);

/**
 * Option IDs: every plan a client can be offered gets a short, stable handle
 * - UH3, GR1 - a carrier prefix and a number, numbered per group in the
 * order the carrier lists its plans. UnitedHealthcare's two proposals share
 * one sequence. A number is never reused: a re-read or a newer proposal in
 * the same slot hands each surviving plan its old number (matched by plan
 * code, else by exact name) and gives new plans the next free ones.
 *
 * Every stored plan is numbered, EPO included. The plans a client is shown
 * (server/plan-visibility.js) are numbered first, then the hidden ones, so
 * Gravie's 67 PPO designs read GR1-GR67 and its 67 EPO twins GR68-GR134. A
 * number once given is kept. A number held twice in a group (the two
 * UnitedHealthcare slots once restarted at UH1 separately) is repaired by
 * renumbering the whole prefix once.
 */
const OPTION_PREFIX = { "UHC Fully Insured": "UH", "UHC Level Funded": "UH", Gravie: "GR", Nationwide: "NW", Angle: "AN", Optimyl: "OP" };

/**
 * Optimyl is the one carrier whose plan code already is its number - every
 * proposal prints the same 4 plans, numbered 1-4 in a "Plan Number" row, and
 * server/ai.js records that as plan_code "OPTIMYL PLAN <n>". So its option
 * id is read straight off that number rather than handed out by the
 * sequence below: re-reading the same 4 plans, any number of times, always
 * comes back OP1-OP4 - never OP5, OP9, growing with every re-read - with no
 * donor-matching needed because there is nothing to match, only to read.
 */
function fixedOptionNumber(prefix, planCode) {
  if (prefix !== "OP") return null;
  const m = /OPTIMYL\s*PLAN\s*(\d+)/i.exec(String(planCode || ""));
  return m ? Number(m[1]) : null;
}

/**
 * One proposal per slot per group: when a newer proposal replaces an older
 * one, the older one is deleted rather than kept as "superseded". The
 * numbers its plans held are remembered here - {group: {prefix: [n…]}} - 
 * so a retired number is never handed out again after the row is gone.
 */
const RETIRED_KEY = "optionIds.retired";
let retiredOptionIds = null;
async function loadRetired() {
  if (retiredOptionIds) return retiredOptionIds;
  retiredOptionIds = (db && (await db.getSetting(RETIRED_KEY).catch(() => null))) || {};
  return retiredOptionIds;
}
async function retireOptionIds(group, plans) {
  const all = await loadRetired();
  const mine = (all[group] = all[group] || {});
  let changed = false;
  for (const pl of plans || []) {
    const m = OPTION_ID.exec(String(pl.option_id || ""));
    if (!m) continue;
    const list = (mine[m[1]] = mine[m[1]] || []);
    if (!list.includes(Number(m[2]))) {
      list.push(Number(m[2]));
      changed = true;
    }
  }
  if (changed && db) await db.setSetting(RETIRED_KEY, all, "system");
}
async function releaseRetired(group, prefix) {
  const all = await loadRetired();
  if (all[group] && all[group][prefix]) {
    delete all[group][prefix];
    if (db) await db.setSetting(RETIRED_KEY, all, "system");
  }
}
const OPTION_ID = /^(UH|GR|NW|AN|OP)(\d+)$/;

/**
 * For one day UnitedHealthcare's menu was numbered too (optionIds.menu in
 * settings), and a proposal plan that was a menu plan took the menu's
 * number - so a group's UHC plans could read UH47, UH54. Only proposals
 * are numbered now: a group still listed there has its UH sequence
 * renumbered once, compactly, in proposal order, and the entry is cleared.
 */
const MENU_KEY = "optionIds.menu";
let menuOptionIds = null;
async function loadMenuIds() {
  if (menuOptionIds) return menuOptionIds;
  menuOptionIds = (db && (await db.getSetting(MENU_KEY).catch(() => null))) || {};
  return menuOptionIds;
}
const optKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const optName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

async function assignOptionIds(rows, bySlot) {
  // Every number already handed out in a group, from every row it has ever
  // had - current, superseded, or unfiled - so none is handed out twice.
  const takenByGroup = new Map();
  for (const r of rows) {
    if (!r.group_name || !r.extracted || !Array.isArray(r.extracted.plans)) continue;
    const taken = takenByGroup.get(r.group_name) || new Map();
    // The numbers a re-read is handing back to its surviving plans
    // (previous_plan_ids) are taken too: a plan new on this reading must
    // never be given one of them.
    const prev = Array.isArray(r.extracted.previous_plan_ids) ? r.extracted.previous_plan_ids : [];
    for (const pl of [...r.extracted.plans, ...prev]) {
      const m = OPTION_ID.exec(String(pl.option_id || ""));
      if (!m) continue;
      const set = taken.get(m[1]) || new Set();
      set.add(Number(m[2]));
      taken.set(m[1], set);
    }
    takenByGroup.set(r.group_name, taken);
  }
  // Numbers held by proposals since deleted stay taken.
  const retired = await loadRetired();
  for (const [group, byPrefix] of Object.entries(retired)) {
    const taken = takenByGroup.get(group) || new Map();
    for (const [prefix, nums] of Object.entries(byPrefix || {})) {
      const set = taken.get(prefix) || new Set();
      for (const n of nums) set.add(Number(n));
      taken.set(prefix, set);
    }
    takenByGroup.set(group, taken);
  }
  // Groups numbered while the menu was: their UH sequence is redone once.
  const menu = await loadMenuIds();
  const groups = new Set([...bySlot.keys()].map((k) => k.split("||")[0]));
  for (const group of groups) {
    const taken = takenByGroup.get(group) || new Map();
    // Which slots are renumbered from scratch: one flagged for it
    // (x.renumber), and every slot of a prefix that holds a number twice - the sequence was
    // once reset per slot, so UnitedHealthcare's two proposals could both
    // start at UH1. Their numbers are released together, before any slot
    // is numbered, while the numbers of the prefix's untouched slots stay
    // taken; releasing per slot would start each at 1 and collide.
    const legacySlots = new Set();
    const heldBy = new Map(); // option id -> slots holding it
    for (const slot of SLOTS) {
      const prefix = OPTION_PREFIX[slot];
      const list = bySlot.get(`${group}||${slot}`);
      if (!prefix || !list) continue;
      const x = list[0].extracted || {};
      const plans = Array.isArray(x.plans) ? x.plans : [];
      // Every stored plan - EPO included - holds a number now, so only an
      // explicit request (x.renumber) marks a slot for renumbering.
      if (x.renumber === true) legacySlots.add(slot);
      if (menu[group] && prefix === "UH") legacySlots.add(slot);
      for (const pl of plans) {
        if (!OPTION_ID.test(String(pl.option_id || ""))) continue;
        const held = heldBy.get(pl.option_id) || [];
        held.push(slot);
        heldBy.set(pl.option_id, held);
      }
    }
    for (const [id, held] of heldBy) {
      if (held.length < 2) continue;
      const prefix = OPTION_ID.exec(id)[1];
      for (const slot of SLOTS) if (OPTION_PREFIX[slot] === prefix && bySlot.has(`${group}||${slot}`)) legacySlots.add(slot);
    }
    for (const prefix of new Set([...legacySlots].map((s) => OPTION_PREFIX[s]))) {
      const keep = new Set();
      for (const slot of SLOTS) {
        if (OPTION_PREFIX[slot] !== prefix || legacySlots.has(slot)) continue;
        const list = bySlot.get(`${group}||${slot}`);
        const plans = list && list[0].extracted && Array.isArray(list[0].extracted.plans) ? list[0].extracted.plans : [];
        for (const pl of plans) {
          const m = OPTION_ID.exec(String(pl.option_id || ""));
          if (m && m[1] === prefix) keep.add(Number(m[2]));
        }
      }
      taken.set(prefix, keep);
      await releaseRetired(group, prefix);
    }
    const nextFree = (prefix) => {
      const set = taken.get(prefix) || new Set();
      let n = 1;
      // Never a number a plan in the group already holds or has just claimed.
      while (set.has(n) || held.has(`${prefix}${n}`)) n++;
      set.add(n);
      taken.set(prefix, set);
      return n;
    };
    // Every number on a plan in this group, as the slots are numbered, so a
    // donor's number is claimed once across the slots that share a prefix.
    const held = new Set();
    for (const slot of SLOTS) {
      if (legacySlots.has(slot)) continue;
      const list = bySlot.get(`${group}||${slot}`);
      for (const pl of (list && list[0].extracted && Array.isArray(list[0].extracted.plans) ? list[0].extracted.plans : [])) if (pl.option_id) held.add(pl.option_id);
    }
    for (const slot of SLOTS) {
      const prefix = OPTION_PREFIX[slot];
      const list = bySlot.get(`${group}||${slot}`);
      if (!prefix || !list) continue;
      const cur = list[0];
      const x = cur.extracted || {};
      let plans = Array.isArray(x.plans) ? x.plans : [];
      if (!plans.length) continue;
      const before = JSON.stringify(plans.map((pl) => pl.option_id || null));
      // Every stored plan is numbered - the ones a client is shown and the
      // ones the visibility rules hide (EPO) alike. A slot marked for
      // renumbering starts again from 1, and the numbers its older readings
      // held are released.
      const legacy = legacySlots.has(slot);
      const stripped = false;
      for (const old of list.slice(1)) {
        const op = old.extracted && Array.isArray(old.extracted.plans) ? old.extracted.plans : [];
        const numbered = legacy && op.some((pl) => String(pl.option_id || "").startsWith(prefix));
        if (!numbered) continue;
        const kept = op.map((pl) => ({ ...pl, option_id: null }));
        const cleared = { ...old.extracted, plans: kept };
        old.extracted = cleared;
        await proposalStore.updateProposal(old.id, { extracted: cleared });
      }
      if (legacy) for (const pl of plans) pl.option_id = null;
      if (!plans.length) {
        if (stripped) {
          cur.extracted = { ...x, plans };
          await proposalStore.updateProposal(cur.id, { extracted: cur.extracted });
        }
        continue;
      }
      // Who can hand a number down: the row's own reading before a re-read,
      // then the proposals this one replaced, newest first.
      const donors = (legacy ? [] : [...(Array.isArray(x.previous_plan_ids) ? x.previous_plan_ids : []), ...list.slice(1).flatMap((r) => (r.extracted && Array.isArray(r.extracted.plans) ? r.extracted.plans : []))]).filter((d) => OPTION_ID.test(String(d.option_id || "")) && String(d.option_id).startsWith(prefix));
      const used = new Set();
      // Plans the client is shown are numbered first, so their IDs run
      // compactly (GR1-GR67); hidden plans take the numbers after them.
      const offered = [...plans.filter((pl) => !hiddenReason(pl)), ...plans.filter((pl) => hiddenReason(pl))];
      // An id under another carrier's prefix (the proposal was moved to a
      // different slot by staff) is renumbered.
      for (const pl of offered) if (pl.option_id && !String(pl.option_id).startsWith(prefix)) pl.option_id = null;
      for (const pl of offered) if (pl.option_id) used.add(pl.option_id);
      // Optimyl's plans are numbered, not matched: read straight off plan_code.
      for (const pl of offered) {
        if (pl.option_id) continue;
        const fixed = fixedOptionNumber(prefix, pl.plan_code);
        if (fixed == null) continue;
        pl.option_id = `${prefix}${fixed}`;
        used.add(pl.option_id);
        held.add(pl.option_id);
      }
      const claim = (pl, match) => {
        const d = donors.find((c) => !used.has(c.option_id) && !held.has(c.option_id) && match(c));
        if (!d) return;
        pl.option_id = d.option_id;
        used.add(d.option_id);
        held.add(d.option_id);
      };
      for (const pl of offered) if (!pl.option_id && optKey(pl.plan_code)) claim(pl, (c) => optKey(c.plan_code) === optKey(pl.plan_code));
      for (const pl of offered) if (!pl.option_id) claim(pl, (c) => optName(c.name) === optName(pl.name));
      for (const pl of offered) {
        if (pl.option_id) continue;
        pl.option_id = `${prefix}${nextFree(prefix)}`;
        held.add(pl.option_id);
      }
      const after = JSON.stringify(plans.map((pl) => pl.option_id || null));
      if (after !== before || stripped || x.previous_plan_ids || x.renumber) {
        const next = { ...x, plans };
        delete next.previous_plan_ids;
        delete next.renumber;
        cur.extracted = next;
        await proposalStore.updateProposal(cur.id, { extracted: next });
      }
    }
  }
  // The one-time renumbering above is done; the menu's numbers are gone for good.
  if (Object.keys(menu).length) {
    menuOptionIds = {};
    if (db) await db.setSetting(MENU_KEY, {}, "system");
  }
}
function slotFor(carrier, funding, quotesMedical, filename) {
  const c = String(carrier || "").toLowerCase();
  // Angle Health's Health Scorecard is not a rate quote and must never land
  // in the "Angle" slot, where a newer upload replaces (and deletes) the
  // older one: a scorecard there would delete the group's real proposal. Its
  // filename says what it is even when the reader does not mark it
  // ancillary, so this is checked first. It fills no slot.
  if (/scorecard/i.test(filename || "") && /angle/.test(c)) return null;
  if (quotesMedical === false) return null;
  const f = String(funding || "").toLowerCase();
  if (/united|uhc|surest|optum/.test(c)) {
    if (/level/.test(f)) return "UHC Level Funded";
    if (/fully/.test(f)) return "UHC Fully Insured";
    return null; // UnitedHealthcare, funding unclear - leave for staff to say
  }
  if (/gravie/.test(c)) return "Gravie";
  if (/angle/.test(c)) return "Angle";
  if (/optimyl/.test(c)) return "Optimyl";
  return null; // not a tracked carrier: kept on file, but it fills no slot
}

/**
 * A slot guessed from the filename alone - carriers this predictable send a
 * batch named the same way every time ("<Group> WS UHC LF.pdf"), and waiting
 * on the AI read to say so left a whole batch sitting in "Other Carriers"
 * with "Carrier unknown" for as long as the read took (or failed outright),
 * even though the filename already said exactly where it belonged. Applied
 * only when the file name is unambiguous; the read still runs and still
 * fills in the real plan and rate data, and a pre-set slot is never
 * second-guessed by it (the same rule a manual grid upload already gets -
 * see slotFor's callers).
 */
function guessSlotFromFilename(filename) {
  const f = String(filename || "");
  if (/scorecard/i.test(f) && /angle/i.test(f)) return null; // a companion document, never the Angle quote's slot
  if (/gravie/i.test(f)) return "Gravie";
  if (/nationwide/i.test(f)) return null; // Nationwide is no longer a slot
  if (/optimyl/i.test(f)) return "Optimyl";
  if (/\bangle\b/i.test(f)) return "Angle";
  // Of every carrier this app tracks, only UnitedHealthcare splits a slot by
  // funding - "fully insured" and "level funded" name that split and nothing
  // else, so either wording identifies UHC on its own, even when the file
  // never spells out "UHC" or "United" - live example: "TPI Global
  // Solutions, Inc. Ex MPE Fully Ins Med 3.pdf".
  if (/\blf\b|level.?fund/i.test(f)) return "UHC Level Funded";
  if (/\bfi\b|fully.?ins/i.test(f)) return "UHC Fully Insured";
  return null; // UnitedHealthcare may be named, but the funding isn't
}

/**
 * Whether a proposal quotes no medical at all - dental, vision, life,
 * disability. Claude says so directly on anything read since the field was
 * added; for an older reading the document itself is the evidence: a file or
 * summary that calls itself ancillary, or one that names only ancillary
 * products and quoted no plan with a rate.
 */
/** A proposal whose read finished with plans to show. */
const hasReading = (r) => !!(r.extracted && Array.isArray(r.extracted.plans) && r.extracted.plans.length);

/**
 * After any change: recount proposals per group for the Groups page, and
 * settle supersession - within a group and slot, the newest assigned proposal
 * is current and older ones are marked as replaced by it. Nothing is deleted.
 */
async function proposalsChanged() {
  try {
    let rows = await proposalStore.listProposals();
    // A slot that is no longer one of the four - a Surest or "Other" filed
    // before the list was cut back - is re-derived from what was read.
    let remapped = false;
    for (const r of rows) {
      // Read before Claude was asked whether a document quotes medical: the
      // document itself usually says, so decide once and keep the answer.
      if (r.extracted && typeof r.extracted.quotes_medical !== "boolean") {
        const medical = medicalFromDocument(r);
        if (medical != null) {
          r.extracted = { ...r.extracted, quotes_medical: medical };
          await proposalStore.updateProposal(r.id, { extracted: r.extracted });
          remapped = true;
        }
      }
      // A proposal filed under a retired slot keeps it, as it is (see
      // RETIRED_SLOTS): stored for the record, off the grid.
      if (retiredSlot(r.slot)) continue;
      // An ancillary proposal fills no slot, whichever slot an older reading
      // gave it: the slots are group health.
      if (r.slot && isAncillaryRow(r)) {
        await proposalStore.updateProposal(r.id, { slot: null });
        remapped = true;
        continue;
      }
      // Filed under a group but still slotless - most often a document too
      // long for one AI reading to finish (it will never get a slot from the
      // read, however many times it is tried) - gets the same filename guess
      // a fresh upload now gets immediately (see guessSlotFromFilename). Only
      // for a row already on the roster under a group, and never one that
      // read as ancillary: that slotlessness is correct as it stands.
      if (!r.slot && r.status === "assigned" && r.group_name && !isAncillaryRow(r)) {
        let guessedSlot = guessSlotFromFilename(r.filename);
        if (guessedSlot === "UHC Level Funded" && isChurch(groups.find((g) => g.name === r.group_name))) guessedSlot = null;
        if (guessedSlot) {
          await proposalStore.updateProposal(r.id, { slot: guessedSlot });
          remapped = true;
          continue;
        }
      }
      // A reading from before this was enforced may have stored a stray
      // blank plan (no name, no code, no rate), or, for Optimyl, an exact
      // duplicate plan_code twice. Clean both up here too, so a proposal
      // already on file is fixed without waiting on staff to press Re-read.
      if (Array.isArray(r.extracted && r.extracted.plans)) {
        let plans = r.extracted.plans.filter((pl) => !isBlankPlan(pl));
        let renamed = false;
        if (/optimyl/i.test(r.carrier || (r.extracted && r.extracted.carrier) || "")) {
          const seen = new Set();
          plans = plans.filter((pl) => {
            const code = pl.plan_code || "";
            if (!/^OPTIMYL PLAN /i.test(code)) return true;
            if (seen.has(code)) return false;
            seen.add(code);
            return true;
          });
          // Its document prints a plan number and no name: each plan is
          // stored under the fixed label for its number, never a made-up name.
          plans = plans.map((pl) => {
            const n = optimylNumber(pl.plan_code);
            if (n == null || pl.name === optimylLabel(n)) return pl;
            renamed = true;
            return { ...pl, name: optimylLabel(n) };
          });
        }
        // One printed name on several plan codes: each plan carries Kennion's
        // label, its code then that name (plan-compare.js labelSharedNames).
        const labelled = labelSharedNames(plans);
        if (labelled.some((pl, i) => pl !== plans[i])) {
          plans = labelled;
          renamed = true;
        }
        if (renamed || plans.length !== r.extracted.plans.length) {
          r.extracted = { ...r.extracted, plans };
          await proposalStore.updateProposal(r.id, { extracted: r.extracted });
          remapped = true;
        }
      }
      if (!r.slot || SLOTS.includes(r.slot)) continue;
      const x = r.extracted || {};
      const slot = slotFor(r.carrier || x.carrier, x.funding, x.quotes_medical, r.filename);
      await proposalStore.updateProposal(r.id, { slot });
      remapped = true;
    }
    if (remapped) rows = await proposalStore.listProposals();
    const counts = {};
    const invoices = {};
    const bySlot = new Map();
    rows.forEach((r) => {
      if (r.status === "container" || !r.group_name) return;
      // An invoice is filed under its group but is not a proposal; the Groups
      // page shows it in its own column. Rows come newest first.
      if (r.kind === "invoice") {
        if (!invoices[r.group_name]) {
          const x = r.extracted || {};
          invoices[r.group_name] = {
            id: r.id,
            month: (r.context && r.context.month) || null,
            filename: r.filename,
            uploadedAt: r.uploaded_at,
            reconciles: typeof x.reconciles === "boolean" ? x.reconciles : null,
            error: r.context && r.context.mismatch ? `Filed under the wrong group: the file names ${r.context.mismatch}.` : r.error || null,
          };
        }
        return;
      }
      counts[r.group_name] = (counts[r.group_name] || 0) + 1;
      if (r.status !== "assigned" || !r.slot) return;
      const k = `${r.group_name}||${r.slot}`;
      bySlot.set(k, [...(bySlot.get(k) || []), r]);
    });
    const want = new Map(); // id -> superseded_by it should have
    rows.forEach((r) => want.set(r.id, null));
    for (const list of bySlot.values()) {
      list.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at) || b.id - a.id);
      // A newer upload whose read is still running, or failed, never
      // replaces a proposal that was read: it waits beside it, unsuperseded,
      // and takes over (deleting the old one) only once it has plans of its
      // own. Before this, a re-upload of Boss Logistics' UHC Level Funded
      // quote that failed to read deleted the good reading it was replacing
      // and left the group with no UHC Level Funded plans at all.
      const ready = list.findIndex(hasReading);
      if (ready > 0) list.splice(0, ready);
      const current = list[0];
      list.slice(1).forEach((r) => want.set(r.id, current.id));
    }
    for (const r of rows) {
      const should = want.get(r.id);
      if ((r.superseded_by || null) !== should) await proposalStore.updateProposal(r.id, { superseded_by: should });
    }
    await assignOptionIds(rows, bySlot);
    // One proposal per slot: the ones a newer upload replaced have handed
    // down their numbers above; now they go, numbers remembered as retired.
    for (const list of bySlot.values()) {
      for (const old of list.slice(1)) {
        await retireOptionIds(old.group_name, old.extracted && old.extracted.plans);
        await proposalStore.deleteProposal(old.id);
        counts[old.group_name] = Math.max(0, (counts[old.group_name] || 1) - 1);
        console.log(`proposal ${old.id} (${old.filename}) replaced by ${list[0].id} in ${old.group_name} / ${old.slot}; deleted`);
      }
      list.length = 1;
    }
    const current = {};
    for (const list of bySlot.values()) {
      const r = list[0];
      const x = r.extracted || {};
      // A plan that is one of the carrier's standard designs carries that
      // design beside it, labelled (plan-catalogue.js, standard-designs.js):
      // supplemental, never written over what the proposal states.
      const carrierName = (SLOT_BASIS[r.slot] && SLOT_BASIS[r.slot][0]) || r.carrier || x.carrier || null;
      (current[r.group_name] = current[r.group_name] || []).push(applyBenefitsGrid(applyCatalogue({
        id: r.id,
        slot: r.slot,
        carrier: r.carrier || x.carrier || null,
        funding: x.funding || null,
        effectiveDate: x.effective_date || null,
        proposalType: x.proposal_type || null,
        enrolledOnDocument: x.enrolled_on_document ?? null,
        plans: Array.isArray(x.plans)
          ? x.plans.map((pl) => ({
              optionId: pl.option_id || null,
              // The canonical carrier identity (plan-canonical.js identityKey),
              // computed from the stored record: what the grid and the check
              // tell two plans apart by - never name and rates.
              identity: identityKey(pl),
              name: pl.name,
              planCode: pl.plan_code || null,
              // The exact network the proposal prices the plan on (the grid
              // shortens it for display itself): served values = stored values.
              network: pl.network || null,
              planType: pl.plan_type || null,
              deductible: pl.deductible || null,
              oopMax: pl.oop_max || null,
              benefits: planBenefits(pl.benefits),
              rates: pl.rates || { EE: null, ES: null, EC: null, FAM: null },
              // Stored, audited, but not shown to the client - and why (plan-visibility.js).
              hidden: hiddenReason(pl),
              // Tiers the document itself does not price, confirmed by the steward.
              unpriced: Array.isArray(pl.unpriced) && pl.unpriced.length ? pl.unpriced : null,
              monthlyTotal: pl.monthly_total ?? null,
              // Where on the proposal the plan was read (pages, or sheet and
              // rows) and any source cells kept before normalization.
              source: pl.source
                ? { pages: { identity: pl.source.identity || [], benefits: pl.source.benefits || [], rates: pl.source.rates || [] }, sheet: pl.source.sheet || null, rows: pl.source.rows || null }
                : null,
              raw: pl.raw || null,
            }))
          : [],
        totalMonthly: x.total_monthly ?? null,
        summary: r.summary || null,
        filename: r.filename,
        uploadedAt: r.uploaded_at,
        audit: auditForClient(r.audit, r.extracted),
      }, planCatalogueIndex, carrierName), carrierName));
    }
    currentProposals = current;
    proposalCounts = counts;
    invoiceByGroup = invoices;
    rebuild();
    // Something changed: let the steward look at the check again.
    scheduleSteward();
  } catch (e) {
    console.error("could not settle proposals:", e.message);
  }
}

const liveRoster = () =>
  groups
    .filter((g) => !g.archived && g.eligible)
    .map((g) => ({ name: g.name, enrolled: g.enrolled, tpa: g.tpa }));

/** Cheap fallback when there is no AI: does the filename, or the email it came in, name a roster group? */
function matchByFilename(filename, context) {
  return groupNamedIn(
    [filename.replace(/\.[a-z0-9]+$/i, ""), context?.subject || "", context?.body || ""].join(" \n "),
    liveRoster(),
  );
}

/**
 * Read the file, match it, and write the outcome back. Runs in the background.
 * `file` is { filename, mime, buffer, context? } - context being the email it
 * came out of, if any.
 */
/** The six benefit rows a plan card shows, as the reader found them; null where the reader predates them. */
function planBenefits(b) {
  if (!b || typeof b !== "object") return null;
  const str = (v) => (v == null || v === "" ? null : String(v).slice(0, 120));
  const hsa = str(b.hsa_eligible);
  return {
    doctorVisit: str(b.doctor_visit),
    specialist: str(b.specialist),
    imaging: str(b.imaging),
    urgentCare: str(b.urgent_care),
    er: str(b.emergency_room),
    hospital: str(b.hospital),
    rx: str(b.rx),
    coinsurance: str(b.coinsurance),
    hsaEligible: hsa == null ? null : /^y/i.test(hsa) ? true : /^n/i.test(hsa) ? false : null,
  };
}

/** A proposal read before the reader asked for per-plan benefits: its cards show only deductible and OOP max. */
function lacksBenefits(r) {
  const x = r.extracted;
  if (!x || x.quotes_medical !== true || !Array.isArray(x.plans) || !x.plans.length) return false;
  return x.plans.some((pl) => pl && typeof pl === "object" && !("benefits" in pl));
}

/**
 * Re-read, once, every medical proposal whose extraction predates the
 * per-plan benefits question, so existing cards fill in without a click.
 * Gravie workbooks are parsed, not read, and are skipped. Logged, never fatal.
 */
/**
 * A read that was in flight when the server last stopped: nothing survives
 * a restart, so any row still "analyzing" at boot is orphaned. Pick each
 * one back up (the file is stored) and, failing that, let staff assign it.
 */
/**
 * Work a batch of rows a couple at a time - up to READ_PARALLEL concurrent
 * runAnalysis calls - instead of one at a time. A plain sequential loop
 * meant one slow or stuck document (a huge scan still generating output, a
 * connection that never completes) blocked every row behind it; live
 * example: a 46-row resume sat at 0 done for 10+ minutes because the very
 * first row hadn't finished. Splitting the batch across a small worker pool
 * means a stuck row only ties up one of the two slots - the rest keep moving.
 */
async function processRowsInParallel(rows, work) {
  const queue = [...rows];
  const workers = Array.from({ length: Math.max(1, Math.min(READ_PARALLEL, queue.length)) }, async () => {
    while (queue.length) await work(queue.shift());
  });
  await Promise.all(workers);
}

async function resumeOrphanedReads() {
  const rows = await proposalStore.listProposals();
  const stuck = rows.filter((r) => r.status === "analyzing");
  if (!stuck.length) return;
  console.log(`proposals: resuming ${stuck.length} read(s) interrupted by the last restart`);
  await processRowsInParallel(stuck, async (r) => {
    const f = await proposalStore.getProposalFile(r.id).catch(() => null);
    if (!f) {
      await proposalStore.updateProposal(r.id, { status: r.group_name ? "assigned" : "unassigned", error: "The file could not be read back after a restart." });
      return;
    }
    await runAnalysis(r.id, { buffer: f.data, mime: f.mime, filename: f.filename, context: r.context || null }, !!r.group_name);
  });
  await proposalsChanged();
}

async function backfillPlanBenefits() {
  if (!aiEnabled()) return;
  await resumeOrphanedReads();
  const rows = await proposalStore.listProposals();
  const want = rows.filter((r) => r.status !== "container" && r.slot !== "Gravie" && r.kind !== "invoice" && lacksBenefits(r));
  if (!want.length) return;
  console.log(`proposals: re-reading ${want.length} proposal(s) for per-plan benefits`);
  await processRowsInParallel(want, async (r) => {
    const f = await proposalStore.getProposalFile(r.id).catch(() => null);
    if (!f) return;
    // A re-read for benefits never moves a proposal off its group.
    const keep = !!r.group_name;
    await proposalStore.updateProposal(r.id, { status: "analyzing", error: null });
    await runAnalysis(r.id, { buffer: f.data, mime: f.mime, filename: f.filename, context: r.context || null }, keep);
  });
  await proposalsChanged();
  console.log(`proposals: benefits re-read done for ${want.length} proposal(s)`);
}

/** Proposals with an audit running, so two clicks do not run it twice. */
const auditing = new Set();

/**
 * Completed audit jobs, per proposal (kennion.proposal_audit_jobs; in memory
 * without a database): each model's document reconciliation and each field
 * batch, keyed to the exact source, standard and stored data it covers. An
 * audit resumes at the first job missing - after a 429, a restart or a
 * deploy - and a correction re-runs only the jobs its change touches.
 */
const memAuditJobs = new Map();
const auditJobs = {
  async list(id) {
    if (db) return db.listAuditJobs(id);
    return { ...(memAuditJobs.get(id) || {}) };
  },
  async save(id, job, data) {
    if (db) return db.saveAuditJob(id, job, data);
    memAuditJobs.set(id, { ...(memAuditJobs.get(id) || {}), [job]: data });
  },
};

/** The proposal context every usage record made for this row carries. */
const usageScope = (row) => ({
  proposalId: row.id,
  groupName: row.group_name || null,
  slot: row.slot || null,
  sourceSha: row.source_sha || null,
  readingVersion: row.extracted ? readingVersion(row.extracted) : null,
  auditStandard: PLAN_AUDIT_STANDARD,
});

/**
 * Check a proposal's stored reading against its document with both models
 * and keep the result on the row. Resumes from the jobs already done (see
 * auditJobs): only missing or stale jobs call a model. Never throws: a
 * failure is recorded on the row so the admin can see it and run it again.
 * Returns { progressed } - whether any new job completed this time.
 */
async function runProposalAudit(id) {
  if (auditing.has(id)) return { progressed: false };
  auditing.add(id);
  let progressed = false;
  try {
    const row = (await proposalStore.listProposals()).find((r) => r.id === id);
    const f = row && (await proposalStore.getProposalFile(id).catch(() => null));
    if (!row || !f) return { progressed };
    // Both audits are of one exact reading of one exact document; a result
    // that comes back after either has changed is discarded, never written.
    const startVersion = readingVersion(row.extracted || {});
    const startSha = row.source_sha || null;
    await setStage(id, "AUDITING");
    const jobs = await auditJobs.list(id).catch(() => ({}));
    const before = auditProgress(row.extracted || {}, startSha, jobs);
    console.log(`proposal ${id} audit: resuming - ${before.claude.next || "Claude complete"}, ${before.openai.next || "OpenAI complete"}`);
    const audit = await withUsage(usageScope(row), () =>
      auditProposal({
        filename: f.filename,
        mime: f.mime,
        buffer: f.data,
        extracted: row.extracted || {},
        sourceSha: startSha,
        jobs,
        // Each job is kept the moment it completes - before the next one runs.
        saveJob: async (job, data) => {
          progressed = true;
          await auditJobs.save(id, job, data);
        },
      }),
    );
    const now = (await proposalStore.listProposals()).find((r) => r.id === id);
    if (!now || (now.source_sha || null) !== startSha || readingVersion(now.extracted || {}) !== startVersion) {
      console.log(`proposal ${id} audit of an earlier version discarded`);
      return { progressed };
    }
    const { jobs: _jobs, ...kept } = audit;
    await proposalStore.updateProposal(id, { audit: kept });
    const reused = audit.models.reduce((n, m) => n + (m.document && m.document.reused ? 1 : 0) + (m.batches || []).filter((b) => b.reused).length, 0);
    const targeted = audit.models.reduce((n, m) => n + (m.batches || []).filter((b) => b.source && !b.source.full).length, 0);
    const byField = Object.entries(audit.mismatches.reduce((acc, m) => ((acc[m.field] = (acc[m.field] || 0) + 1), acc), {}))
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    // A few examples, so a rule that judges two renderings of one value
    // differently shows in the log (stored vs what the document prints).
    const examples = audit.mismatches
      .slice(0, 3)
      .map((m) => `${m.optionId || m.plan} ${m.field}: "${String(m.stored).slice(0, 60)}" vs "${String(m.onDocument).slice(0, 60)}" (${m.by || "?"})`)
      .join("; ");
    console.log(`proposal ${id} audit: ${audit.status}${audit.mismatches.length ? ` (${audit.mismatches.length} findings: ${byField}; e.g. ${examples})` : ""} - ${audit.models.map((m) => `${m.model.replace(/\s*\(.*\)$/, "")} ${m.verdict}`).join(", ")}; ${reused} job(s) reused, ${targeted} batch(es) from targeted packets`);
  } catch (e) {
    console.error(`proposal ${id} audit failed:`, e.message);
    await proposalStore.updateProposal(id, { audit: { completedAt: new Date().toISOString(), status: "unreadable", models: [], mismatches: [], notes: `The audit failed: ${e.message}` } }).catch(() => undefined);
  } finally {
    auditing.delete(id);
    await proposalsChanged().catch(() => undefined);
  }
  return { progressed };
}

/** Audit a batch a few at a time: both APIs take parallel calls, and one at a time made 70 proposals an afternoon's work. */
const AUDIT_PARALLEL = Number(process.env.KENNION_AUDIT_PARALLEL || 4);
/** Background Claude work goes through the Message Batches API (server/claude-batch.js): no per-minute limit to protect, so more runs at once. */
const BATCH_PARALLEL = Number(process.env.KENNION_BATCH_PARALLEL || 12);
async function auditInParallel(ids) {
  const queue = [...ids];
  const workers = Array.from({ length: Math.max(1, Math.min(batching() ? BATCH_PARALLEL : AUDIT_PARALLEL, queue.length)) }, async () => {
    while (queue.length) await runProposalAudit(queue.shift());
  });
  await Promise.all(workers);
}

/**
 * How many proposal reads run against the model at once, across every
 * caller - a fresh upload, a batch email, resumeOrphanedReads,
 * backfillPlanBenefits. Uploads fire runAnalysis unawaited per file, so a
 * batch of many documents (an email with several attachments, a handful of
 * files dropped on the grid one after another) used to send that many large
 * PDF reads to the API in the same instant, which is enough on its own to
 * blow past the org's shared tokens-per-minute limit and fail every one of
 * them with a 429 - as happened live with 8 UHC Level Funded renewals
 * uploaded together. Capping it here queues the rest instead.
 */
const READ_PARALLEL = Number(process.env.KENNION_READ_PARALLEL || 2);
let readSlotsInUse = 0;
const readWaiters = [];
function withReadSlot(fn) {
  // A batched read is queued at Anthropic, not streamed: it takes no slot.
  if (batching()) return Promise.resolve().then(fn);
  return new Promise((resolve, reject) => {
    const run = () => {
      readSlotsInUse++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          readSlotsInUse--;
          const next = readWaiters.shift();
          if (next) next();
        });
    };
    if (readSlotsInUse < READ_PARALLEL) run();
    else readWaiters.push(run);
  });
}

async function runAnalysis(id, file, keepAssignment) {
  try {
    if (!aiEnabled()) {
      const guess = keepAssignment ? null : matchByFilename(file.filename, file.context);
      await proposalStore.updateProposal(id, {
        status: keepAssignment ? "assigned" : guess ? "suggested" : "unassigned",
        ...(guess ? { group_name: guess, confidence: 0.5, assigned_by: "filename" } : {}),
        summary: "AI reading is off (no ANTHROPIC_API_KEY). Assign the group by hand.",
        error: null,
      });
      await proposalsChanged();
      return;
    }
    const roster = liveRoster();
    const prepared = await prepareForModel(file);
    // The version of the document this reading is of. A result that comes
    // back after the row's document has changed is discarded, never applied.
    const before = (await proposalStore.listProposals()).find((r) => r.id === id);
    const startSha = (before && before.source_sha) || (file.buffer ? crypto.createHash("sha256").update(file.buffer).digest("hex") : null);
    const out = await withReadSlot(() =>
      withUsage({ proposalId: id, groupName: (before && before.group_name) || null, slot: (before && before.slot) || null, sourceSha: startSha, readingVersion: null, auditStandard: null }, () =>
        analyzeProposal({ filename: file.filename, prepared, context: file.context || null, onStage: (st) => void setStage(id, st) }, roster),
      ),
    );
    out.extraction = { ...(out.extraction || {}), sourceSha: startSha };
    // The coverage record is of this version of the document, and no other.
    if (out.coverage) out.coverage = { ...out.coverage, sourceSha: startSha };
    const after = (await proposalStore.listProposals()).find((r) => r.id === id);
    if (!after) return;
    if (after.source_sha && startSha && after.source_sha !== startSha) {
      console.log(`proposal ${id}: reading of an earlier version of the document discarded`);
      return;
    }
    const flags = Array.isArray(out.audit_flags) ? [...out.audit_flags] : [];
    // The reader copies the roster name when it can; when it mirrors the
    // paper's spelling instead, or names no roster group at all, the employer
    // name it read and the file name still have to point at one group.
    const found = matchRosterGroup(out, roster, file.filename, file.context || null);
    const matched = found ? roster.find((g) => g.name === found.name) || null : null;
    let conf = Math.max(0, Math.min(1, Number(out.confidence) || 0));
    // A group the reader did not name itself is a suggestion for staff to
    // confirm, never an assignment, however sure the reader was of a name
    // that is not on the roster.
    if (found && found.how !== "exact" && found.how !== "normalized") conf = Math.min(Math.max(conf, 0.5), 0.84);
    console.log(
      `proposal ${id} read: ${out.carrier || "carrier ?"}; on the document "${out.group_name_on_document || "?"}"; ` +
        `reader matched ${out.matched_group ? `"${out.matched_group}"` : "nothing"} at ${Number(out.confidence) || 0}; ` +
        `roster: ${found ? `${found.name} (${found.how})` : "no match"}`,
    );

    const current = (await proposalStore.listProposals()).find((r) => r.id === id);
    // Audit against what we know: enrollment on the paper vs the roster.
    const compareName = keepAssignment && current ? current.group_name : matched && matched.name;
    const compare = roster.find((g) => g.name === compareName) || null;
    if (compare && out.enrolled_on_document != null && compare.enrolled) {
      const diff = Math.abs(out.enrolled_on_document - compare.enrolled) / compare.enrolled;
      if (diff > 0.2) {
        flags.push(
          `Priced on ${out.enrolled_on_document} enrolled; the roster has ${compare.enrolled} for ${compare.name}.`,
        );
      }
    }

    const priorPlans = (current && current.extracted && current.extracted.plans) || [];
    // A reading occasionally trails a blank entry - no name, no plan code,
    // no rate, nothing - an artifact of the model, never a real plan. Never
    // stored, whatever the carrier.
    if (Array.isArray(out.plans)) out.plans = out.plans.filter((pl) => !isBlankPlan(pl));
    // Every unique plan is stored, EPO included (the visibility rules decide
    // what a client sees); each keeps the BenSync number it held before.
    // Optimyl always quotes the same 4 standard plans, numbered by plan_code
    // ("OPTIMYL PLAN 1".."OPTIMYL PLAN 4"). A misread sometimes doubles one
    // of them onto two rows - collapse an exact repeat of that plan_code
    // down to one entry - and anything still left over 4 is flagged for
    // staff rather than stored silently.
    if (Array.isArray(out.plans) && /optimyl/i.test(out.carrier || "")) {
      const seen = new Set();
      out.plans = out.plans
        .filter((pl) => {
          const code = pl.plan_code || "";
          if (!/^OPTIMYL PLAN /i.test(code)) return true;
          if (seen.has(code)) return false;
          seen.add(code);
          return true;
        })
        .map((pl) => (optimylNumber(pl.plan_code) != null ? { ...pl, name: optimylLabel(optimylNumber(pl.plan_code)) } : pl));
    }
    if (Array.isArray(out.plans)) out.plans = labelSharedNames(out.plans);
    if (Array.isArray(out.plans) && /optimyl/i.test(out.carrier || "")) {
      if (out.plans.length !== 4) {
        flags.push(`Optimyl always quotes exactly 4 plans; this reading found ${out.plans.length} - re-check the document.`);
      }
    }
    const fields = {
      carrier: out.carrier || null,
      // The option IDs the plans carried before this reading ride along, so
      // the numbering step can hand each surviving plan its old number.
      extracted: {
        ...out,
        audit_flags: flags,
        previous_plan_ids: priorPlans.filter((p) => p.option_id).map((p) => ({ option_id: p.option_id, plan_code: p.plan_code || null, name: p.name })),
      },
      summary: out.summary || null,
      confidence: conf,
      error: null,
      stage: "EXTRACTED",
      stage_reason: null,
    };
    // The slot comes from what was read, unless staff already set one.
    if (!current || !current.slot) fields.slot = slotFor(out.carrier, out.funding, out.quotes_medical, file.filename);
    // Kennion tracks six medical carriers. A document that fills no slot
    // because it is ancillary (dental, vision, life, disability - no medical
    // rates) or because the carrier is not one Kennion shops (a TPA's
    // billing paperwork, a stray vendor flyer) is never worth keeping on
    // file: delete it outright rather than storing it in a bucket nobody
    // reviews. A tracked carrier whose slot just needs a human call - UHC
    // with funding unclear - keeps its row for staff to assign.
    //
    // Only a document's first-ever read is judged this way. A re-read (the
    // per-row button, the bulk "re-read every proposal", or the benefits
    // backfill that runs at boot) never discards a row that already made it
    // onto the roster under the old rules - staff filed those on purpose,
    // and a re-read is not the moment to second-guess that. A slot set
    // before this read ran - by hand on the grid, or guessed from the file
    // name at upload - counts the same as one the read just derived: either
    // way the row already belongs somewhere, so it is never discarded.
    if (!fields.slot && !(current && current.slot) && !(current && current.extracted)) {
      const carrierTracked = /united|uhc|surest|optum|gravie|nationwide|angle|optimyl/i.test(String(out.carrier || ""));
      if (out.quotes_medical === false || !carrierTracked) {
        const ok = await proposalStore.deleteProposal(id).catch(() => false);
        console.log(`proposal ${id} discarded: ${out.quotes_medical === false ? "ancillary" : "untracked carrier"} (${out.carrier || "carrier ?"})${ok ? "" : " - delete failed"}`);
        await proposalsChanged();
        return;
      }
    }
    // Staff may assign a group while the read is still running; that choice stands.
    const staffAssigned = !!(current && current.group_name && current.assigned_by && current.assigned_by !== "ai" && current.assigned_by !== "filename");
    if (keepAssignment || staffAssigned) {
      // Uploaded straight onto a company page: the human already chose the
      // group. Note a disagreement rather than overriding them.
      if (matched && current && current.group_name && matched.name !== current.group_name) {
        fields.extracted.audit_flags.push(
          `The document appears to be for ${matched.name}, not ${current.group_name}.`,
        );
      }
      fields.status = "assigned";
    } else if (matched && conf >= 0.85) {
      Object.assign(fields, { group_name: matched.name, status: "assigned", assigned_by: "ai" });
    } else if (matched && conf >= 0.5) {
      Object.assign(fields, { group_name: matched.name, status: "suggested", assigned_by: "ai" });
    } else {
      Object.assign(fields, { group_name: null, status: "unassigned", assigned_by: null });
    }
    await proposalStore.updateProposal(id, { ...fields, audit: null });
    // A fresh reading is audited once it has been numbered and passes the
    // deterministic checks - the steward's next pass sees to both.
  } catch (e) {
    console.error(`proposal ${id} analysis failed:`, e.message);
    // A failed read leaves a proposal where it was filed; only one that was
    // never filed stays unassigned.
    const prev = (await proposalStore.listProposals().catch(() => [])).find((r) => r.id === id);
    await proposalStore.updateProposal(id, {
      status: keepAssignment || (prev && prev.group_name) ? "assigned" : "unassigned",
      error: e.message,
      stage: "EXTRACTING",
      stage_reason: `The read failed: ${e.message}`,
    });
  }
  await proposalsChanged();
}

/** Hash, once, the source document of every proposal stored before the hash was kept. */
async function backfillSourceSha() {
  const rows = (await proposalStore.listProposals()).filter((r) => !r.source_sha && r.kind !== "invoice" && r.status !== "container");
  let n = 0;
  for (const r of rows) {
    const f = await proposalStore.getProposalFile(r.id).catch(() => null);
    if (!f || !f.data) continue;
    await proposalStore.updateProposal(r.id, { source_sha: crypto.createHash("sha256").update(f.data).digest("hex") });
    n++;
  }
  if (n) console.log(`proposals: recorded the source document hash of ${n} proposal(s)`);
}

/** Record where a proposal is in processing (see stageOf in proposal-verify.js). */
async function setStage(id, stage, reason = null) {
  await proposalStore.updateProposal(id, { stage, stage_reason: reason }).catch(() => undefined);
}

/**
 * Upload one file - a proposal, or an email carrying proposals. Raw body;
 * filename and optional group in the query. An email is stored as its own row
 * and each usable attachment becomes a proposal of its own, read with the
 * email's subject, sender and body as context.
 */
app.post(
  "/api/admin/proposals",
  requireStaff,
  express.raw({ type: () => true, limit: "40mb" }),
  async (req, res) => {
    const filename = String(req.query.filename || "proposal.pdf").slice(0, 200);
    const mime = (req.get("content-type") || "").split(";")[0].trim() || "application/octet-stream";
    const group = String(req.query.group || "").trim();
    // Uploaded straight into one of a group's four slots, from the grid.
    const slot = String(req.query.slot || "").trim();
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "No file received." });
    }
    if (group && !groups.some((g) => g.name === group)) {
      return res.status(404).json({ error: "No such group." });
    }
    if (slot && !SLOTS.includes(slot)) {
      return res.status(400).json({ error: `Slot must be one of: ${SLOTS.join(", ")}.` });
    }
    if (slot === "UHC Level Funded" && isChurch(groups.find((g) => g.name === group))) {
      return res.status(400).json({ error: "Churches are fully insured with UHC only - use UHC Fully Insured." });
    }
    if (slot && !group) {
      return res.status(400).json({ error: "A slot needs a group." });
    }
    let expanded;
    try {
      expanded = await expandUpload({ buffer: req.body, mime, filename });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const by = req.staffEmail || null;
    const base = {
      group_name: group || null,
      assigned_by: group ? by || "staff" : null,
      uploaded_by: by,
      slot: slot || null,
    };
    try {
      const created = [];
      let parent = null;
      if (expanded.email) {
        // The email itself: a container when it has attachments, otherwise
        // the proposal is its body and it is read like any other file.
        parent = await proposalStore.addProposal({
          ...base,
          filename: expanded.email.filename,
          mime: expanded.email.mime,
          size: req.body.length,
          data: req.body,
          kind: "email",
          context: expanded.email.context,
          status: expanded.bodyOnly ? "analyzing" : "container",
        });
        created.push(parent);
        if (expanded.bodyOnly) {
          void runAnalysis(parent.id, { buffer: req.body, mime: expanded.email.mime, filename: expanded.email.filename }, !!group);
        }
      }
      for (const item of expanded.items) {
        // A batch upload (an email's attachments, several files at once)
        // rarely comes in with a group or slot query param - those are for a
        // single file dropped straight onto the grid. Everything else waited
        // on the AI read to say where it belonged, which meant a slow or
        // failed read left the file sitting in "Other Carriers" the whole
        // time even when the file name already gave it away. Guess from the
        // name first; the read still runs, still fills in the real data, and
        // corrects a wrong guess (a mismatch is flagged, never silent).
        const guessedGroup = base.group_name ? null : matchByFilename(item.filename, item.context || null);
        const itemGroup = base.group_name || guessedGroup;
        const groupRow = itemGroup ? groups.find((g) => g.name === itemGroup) : null;
        let guessedSlot = base.slot ? null : guessSlotFromFilename(item.filename);
        if (guessedSlot === "UHC Level Funded" && isChurch(groupRow)) guessedSlot = null;
        const itemFields = {
          ...base,
          group_name: itemGroup || null,
          assigned_by: base.assigned_by || (guessedGroup ? "filename" : null),
          slot: base.slot || guessedSlot,
        };
        const row = await proposalStore.addProposal({
          ...itemFields,
          filename: item.filename,
          mime: item.mime,
          size: item.buffer.length,
          data: item.buffer,
          kind: item.kind,
          parent_id: parent ? parent.id : null,
          context: item.context || null,
          status: itemFields.group_name ? "assigned" : "analyzing",
        });
        created.push(row);
        // Read it after replying; the screen polls until it is done. A group
        // this call itself is sure of (given explicitly) always stands; one
        // guessed from the filename stands too unless the read confidently
        // says otherwise - runAnalysis flags the disagreement either way.
        void runAnalysis(row.id, { buffer: item.buffer, mime: item.mime, filename: item.filename, context: item.context || null }, !!itemFields.group_name);
      }
      await proposalsChanged();
      res.json({
        ok: true,
        proposals: created,
        proposal: created[created.length - 1],
        skipped: expanded.skipped || [],
        ai: aiEnabled(),
        durable: !!db,
      });
    } catch (e) {
      res.status(500).json({ error: "Could not store the file: " + e.message });
    }
  },
);

/**
 * A month's client invoices, all at once: a zip with one PDF per group,
 * named "<Group Name> <Month> Invoice.pdf" (Employee Navigator's own naming).
 * Stored the same way a single proposal file is - group, filename, bytes,
 * kind "invoice" - but never queued for AI analysis: an invoice isn't a
 * carrier quote to extract plan terms from, just a record to keep and
 * hand back. Anything not inside a per-group PDF (a combined summary, a
 * roster CSV) or whose name doesn't match a live group by name is skipped
 * and reported back rather than guessed at.
 */
app.post(
  "/api/admin/invoices/batch",
  requireStaff,
  express.raw({ type: () => true, limit: "60mb" }),
  async (req, res) => {
    const month = String(req.query.month || "").trim();
    if (!month) return res.status(400).json({ error: "A month is required, e.g. 2026-09." });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "No file received." });
    }
    try {
      res.json({ ok: true, ...(await ingestInvoiceZip(req.body, month, req.staffEmail || null)) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  },
);

/**
 * A zip of Employee Navigator client invoices, one PDF per group: each is
 * matched to its group by filename, its header and Charge Summary pulled out,
 * and both the PDF and the extracted facts stored against the group.
 */
async function ingestInvoiceZip(buf, month, by) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw Object.assign(new Error("Not a valid zip file: " + e.message), { status: 400 });
  }
  const stored = [];
  const unmatched = [];
  const skipped = [];
  const check = [];
  // What is already filed, so the same batch run twice files nothing twice.
  const onFile = new Set(
    (await proposalStore.listProposals())
      .filter((r) => r.kind === "invoice" && r.group_name)
      .map((r) => `${r.group_name}||${r.filename}||${(r.context && r.context.month) || ""}`),
  );
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const base = entry.name.split("/").pop() || "";
    if (!/\.pdf$/i.test(base)) continue;
    // The per-group files live one folder in; the two combined PDFs sit
    // at the top of the zip and carry no single group's name to match.
    const name = groupFromInvoiceFilename(base);
    if (!name) continue;
    const g = matchInvoiceGroup(name);
    if (!g) {
      unmatched.push(base);
      continue;
    }
    if (onFile.has(`${g.name}||${base}||${month}`)) {
      skipped.push(g.name);
      continue;
    }
    const pdf = Buffer.from(await entry.async("nodebuffer"));
    let extracted = null;
    let error = null;
    try {
      extracted = await parseInvoicePdf(pdf);
    } catch (e) {
      error = e.message;
    }
    const row = await proposalStore.addProposal({
      group_name: g.name,
      filename: base,
      mime: "application/pdf",
      size: pdf.length,
      data: pdf,
      kind: "invoice",
      context: { month },
      status: error ? "error" : "stored",
      uploaded_by: by,
    });
    if (extracted) await proposalStore.updateProposal(row.id, { extracted });
    else if (error) await proposalStore.updateProposal(row.id, { error });
    stored.push({ group: g.name, id: row.id });
    if (!extracted || !extracted.reconciles) check.push(g.name);
  }
  await proposalsChanged();
  return { month, stored: stored.length, groups: stored.map((s) => s.group), unmatched, skipped: skipped.length, check };
}

/**
 * Carrier quotes as rows - kennion.carrier_quotes and carrier_quote_plans - 
 * one quote per carrier and group, every priced plan under it. Without a
 * database they live in memory for the life of the process.
 */
const memQuotes = new Map();
const quoteStore = db
  ? db
  : {
      async replaceCarrierQuote(q, plans) {
        const id = memQuotes.size + 1;
        memQuotes.set(`${q.carrier}||${q.groupName}`, { id, ...q, planCount: plans.length, uploadedAt: new Date().toISOString(), plans });
        return id;
      },
      async listCarrierQuotes(carrier) {
        return [...memQuotes.values()].filter((q) => !carrier || q.carrier === carrier).map(({ plans, ...q }) => q);
      },
      async carrierQuote(carrier, groupName) {
        return memQuotes.get(`${carrier}||${groupName}`) || null;
      },
      async deleteCarrierQuote(carrier, groupName) {
        memQuotes.delete(`${carrier}||${groupName}`);
      },
    };

/** File one parsed Gravie workbook as rows for its group. */
async function storeGravieQuote(g, parsed, filename, proposalId, by) {
  return quoteStore.replaceCarrierQuote(
    {
      carrier: "Gravie",
      groupName: g.name,
      quoteNumber: parsed.quoteNumber || null,
      effectiveDate: parsed.effectiveDate || null,
      generated: parsed.generated || null,
      // The network exactly as the workbook's header prints it.
      network: parsed.network || null,
      tiers: parsed.tiers || {},
      filename,
      proposalId,
      uploadedBy: by || null,
    },
    gravieQuoteRows(parsed),
  );
}

/**
 * Every Gravie workbook already on file, re-read with the current parser:
 * the proposal's plan list is brought to the EPO and PPO sheets only, and the
 * quote is written as rows if it is not there yet or has changed. Runs at
 * boot, so a parser fix reaches every stored workbook without an upload.
 */
/**
 * Every current proposal's stored plans, checked for the same carrier plan
 * stored twice under a reader-added placement label ("P100i10025B" and
 * "P100i10025B (alt grid base)", identical values). Each copy is folded into
 * the plan it copies (plan-canonical.js foldPlacementDuplicates): the copy's
 * BenSync ID is retired, the fold is logged on the reading's corrections, and
 * the counts follow. The changed reading is audited again. Deterministic, no
 * AI; runs at boot and after every settle, so no group keeps such a copy.
 */
async function foldStoredPlacementDuplicates() {
  const rows = (await proposalStore.listProposals()).filter((r) => r.group_name && !r.superseded_by && r.extracted && Array.isArray(r.extracted.plans) && r.extracted.plans.length > 1);
  let changed = 0;
  for (const r of rows) {
    try {
      const { plans, folded } = foldPlacementDuplicates(r.extracted.plans);
      if (!folded.length) continue;
      const x = r.extracted;
      const epo = plans.filter((pl) => !isBlankPlan(pl) && isEpoCanon(pl)).length;
      const n = plans.filter((pl) => !isBlankPlan(pl)).length;
      const reconciliation = x.reconciliation ? { ...x.reconciliation, unique_plans: n, unique_ppo: n - epo, unique_epo: epo, expected: n } : x.reconciliation;
      const at = new Date().toISOString();
      const corrections = [
        ...(Array.isArray(x.corrections) ? x.corrections : []),
        ...folded.map((f) => ({ plan: f.plan.name, option_id: f.plan.option_id || null, field: "plan", from: "stored twice", to: `folded into "${f.into.name}"${f.into.option_id ? ` (${f.into.option_id})` : ""}`, page: null, reason: "The same carrier plan under a placement label the reader added; every value the two state is the same.", model: "rule", at })),
      ];
      await proposalStore.updateProposal(r.id, { extracted: { ...x, plans, reconciliation, corrections } });
      await retireOptionIds(r.group_name, folded.map((f) => f.plan));
      changed++;
      console.log(`duplicates: #${r.id} ${r.group_name} / ${r.slot}: folded ${folded.map((f) => `${f.plan.option_id || "?"} "${f.plan.name}" into ${f.into.option_id || "?"}`).join("; ")}`);
    } catch (e) {
      console.error(`duplicates: could not fold #${r.id}:`, e.message);
    }
  }
  return changed;
}

async function settleGravieQuotes() {
  const rows = (await proposalStore.listProposals()).filter(
    (r) => r.context && r.context.source === "gravie-workbook" && r.group_name && !r.superseded_by,
  );
  let reread = 0;
  let written = 0;
  const have = new Map((await quoteStore.listCarrierQuotes("Gravie")).map((q) => [q.groupName, q]));
  for (const r of rows) {
    try {
      const plans = (r.extracted && r.extracted.plans) || [];
      // Also stale: a reading without per-plan provenance (sheet and row) or
      // not tied to the version of the workbook on file.
      const ext = (r.extracted && r.extracted.extraction) || null;
      const stale = !plans.length || plans.some((pl) => !pl.source) || !ext || ext.parser !== GRAVIE_PARSER || (r.source_sha && ext.sourceSha !== r.source_sha);
      const f = await proposalStore.getProposalFile(r.id);
      if (!f) continue;
      const parsed = parseGravieWorkbook(f.data);
      // Also stale: a reading that no longer says what the workbook's cells
      // say - a model's correction changed a name, network or rate the
      // parser read exactly (Johnson Storage's networks were overwritten with
      // the header line naming both networks). The workbook is the source.
      const drifted = !stale && gravieDrift(plans, gravieExtracted(parsed).plans || []);
      if (drifted) console.log(`gravie: #${r.id} ${r.group_name}: the stored reading differs from its workbook (${drifted}); parsed again`);
      const quote = have.get(r.group_name);
      const wanted = quote && String(quote.proposalId) === String(r.id) && quote.planCount === plans.length && !stale && !drifted;
      if (!stale && !drifted && wanted) continue;
      if (stale || drifted) {
        const extracted = gravieReading(parsed, r.group_name, r.source_sha, plans);
        await proposalStore.updateProposal(r.id, { extracted, summary: extracted.summary });
        reread++;
      }
      await storeGravieQuote({ name: r.group_name }, parsed, r.filename, r.id, r.uploaded_by);
      written++;
    } catch (e) {
      console.error(`gravie: could not settle ${r.filename}:`, e.message);
    }
  }
  // A quote whose workbook is no longer the group's current Gravie proposal
  // (deleted, or replaced by a file that is not a workbook) goes: the rows
  // match the proposals on file, nothing else.
  // (Postgres hands a bigint back as text, so ids are compared as text.)
  const live = new Set(rows.map((r) => String(r.id)));
  let dropped = 0;
  for (const q of have.values()) {
    if (live.has(String(q.proposalId))) continue;
    await quoteStore.deleteCarrierQuote("Gravie", q.groupName);
    dropped++;
  }
  const total = (await quoteStore.listCarrierQuotes("Gravie")).length;
  if (dropped) console.log(`gravie: dropped ${dropped} quote(s) whose workbook is no longer on file`);
  if (reread || written) console.log(`gravie: re-read ${reread} workbook(s), wrote ${written} quote(s); ${total} Gravie quote(s) stored as rows`);
  if (reread) await proposalsChanged();
  return { reread, written, total };
}

/**
 * A Gravie workbook's reading: the parser's plans (canonical, with sheet and
 * row provenance), tied to the workbook version it was parsed from, and -
 * on a re-parse - the numbers its plans held, so every design keeps its ID.
 */
/** The Gravie parser's version: a workbook parsed by an older one is parsed again at boot. v2 reads the EPO sheet too; v3 records every sheet (source coverage); v4 reads the Narrow Network (Cigna LocalPlus) sheet too. */
const GRAVIE_PARSER = "gravie-v5";
function gravieReading(parsed, groupName, sourceSha, priorPlans) {
  const x = gravieExtracted(parsed);
  return {
    ...x,
    matched_group: groupName,
    extraction: { ...(x.extraction || {}), sourceSha: sourceSha || null, parser: GRAVIE_PARSER },
    ...(x.coverage ? { coverage: { ...x.coverage, sourceSha: sourceSha || null } } : {}),
    ...(priorPlans && priorPlans.length ? { previous_plan_ids: priorPlans.filter((p) => p.option_id).map((p) => ({ option_id: p.option_id, plan_code: p.plan_code || null, name: p.name })) } : {}),
  };
}

/**
 * A zip of Gravie rate workbooks, one per group: each is parsed, matched to
 * its group by the name in the sheet header, and filed as that group's Gravie
 * proposal - assigned, in the Gravie slot, with every priced plan in the
 * extracted shape the Options page reads - so the quote prices on the client's
 * pages the moment it lands. A workbook whose quote number is already on file
 * for the group is skipped, so a batch can be run again.
 */
async function ingestGravieZip(buf, by) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw Object.assign(new Error("Not a valid zip file: " + e.message), { status: 400 });
  }
  const stored = [];
  const unmatched = [];
  const skipped = [];
  const failed = [];
  const onFile = new Set(
    (await proposalStore.listProposals())
      .filter((r) => r.slot === "Gravie" && r.group_name && r.context && r.context.quoteNumber)
      .map((r) => `${r.group_name}||${r.context.quoteNumber}`),
  );
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const base = entry.name.split("/").pop() || "";
    if (!/\.xlsx$/i.test(base) || base.startsWith("._")) continue;
    const bytes = Buffer.from(await entry.async("nodebuffer"));
    let parsed;
    try {
      parsed = parseGravieWorkbook(bytes);
    } catch (e) {
      failed.push(`${base}: ${e.message}`);
      continue;
    }
    const g = matchInvoiceGroup(parsed.group);
    if (!g) {
      unmatched.push(`${base} (${parsed.group})`);
      continue;
    }
    if (parsed.quoteNumber && onFile.has(`${g.name}||${parsed.quoteNumber}`)) {
      skipped.push(g.name);
      continue;
    }
    const row = await proposalStore.addProposal({
      group_name: g.name,
      carrier: "Gravie",
      filename: base,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: bytes.length,
      data: bytes,
      kind: "file",
      context: { source: "gravie-workbook", quoteNumber: parsed.quoteNumber || null, generated: parsed.generated || null },
      status: "assigned",
      assigned_by: by || "gravie-workbook",
      uploaded_by: by,
    });
    const extracted = gravieReading(parsed, g.name, row.source_sha, []);
    await proposalStore.updateProposal(row.id, {
      extracted,
      summary: extracted.summary,
      confidence: 1,
      slot: "Gravie",
      stage: "EXTRACTED",
    });
    await storeGravieQuote(g, parsed, base, row.id, by);
    stored.push({ group: g.name, id: row.id, plans: extracted.plans.length });
  }
  await proposalsChanged();
  return { stored: stored.length, groups: stored.map((s) => `${s.group} (${s.plans})`), unmatched, skipped: skipped.length, failed };
}

/**
 * A zip dropped in the inbox: invoice PDFs go to the invoice ingest, Gravie
 * rate workbooks to the Gravie one, and both can share a zip.
 */
async function ingestZip(buf, month, by) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.values(zip.files).filter((e) => !e.dir).map((e) => e.name.split("/").pop() || "");
  const out = {};
  if (names.some((n) => /\.pdf$/i.test(n))) out.invoices = await ingestInvoiceZip(buf, month, by);
  if (names.some((n) => /\.xlsx$/i.test(n) && !n.startsWith("._"))) out.gravie = await ingestGravieZip(buf, by);
  return out;
}

app.post(
  "/api/admin/proposals/gravie-batch",
  requireStaff,
  express.raw({ type: () => true, limit: "60mb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "No file received." });
    }
    try {
      res.json({ ok: true, ...(await ingestGravieZip(req.body, req.staffEmail || null)) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  },
);

/** Every carrier quote stored as rows, one per carrier and group, without the plans. */
app.get("/api/admin/quotes", requireStaff, async (req, res) => {
  try {
    const carrier = String(req.query.carrier || "").trim() || null;
    res.json({ quotes: await quoteStore.listCarrierQuotes(carrier), durable: !!db });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** One group's quote from a carrier, every plan with its four tier rates. */
app.get("/api/admin/quotes/:carrier/:group", requireStaff, async (req, res) => {
  try {
    const q = await quoteStore.carrierQuote(String(req.params.carrier), String(req.params.group));
    if (!q) return res.status(404).json({ error: "No such quote." });
    res.json(q);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/proposals", requireStaff, async (req, res) => {
  try {
    // Invoices share this table but belong to the Funding tab, not here -
    // its own endpoint (/api/admin/invoices/batch) is how the app actually
    // shows them; nothing on the Proposals page ever expects one.
    let rows = (await proposalStore.listProposals()).filter((r) => r.kind !== "invoice");
    const group = String(req.query.group || "").trim();
    if (group) rows = rows.filter((r) => r.group_name === group);
    res.json({ proposals: rows, ai: aiEnabled(), durable: !!db });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/proposals/:id/file", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  const f = await proposalStore.getProposalFile(id).catch(() => null);
  if (!f) return res.status(404).json({ error: "No such proposal." });
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition", `inline; filename="${f.filename.replace(/"/g, "")}"`);
  res.send(f.data);
});

/** Audit every current proposal that has never been audited (or, with all=1, every current one). */
app.post("/api/admin/proposals/audit", requireStaff, async (req, res) => {
  const all = String(req.query.all || "") === "1";
  const rows = (await proposalStore.listProposals()).filter((r) => r.status === "assigned" && r.slot && !r.superseded_by && r.extracted && Array.isArray(r.extracted.plans) && r.extracted.plans.length);
  const todo = rows.filter((r) => all || !r.audit);
  (async () => {
    await auditInParallel(todo.map((r) => r.id));
  })();
  res.json({ queued: todo.length });
});

/** Proposals being read again by a fix, so the check shows them busy and a second click does not double up. */
const rereading = new Set();
/** Proposals being corrected against their document right now. */
const correcting = new Set();

/**
 * The four-step check - on file, scanned, database, grid - for every live
 * group and slot (server/proposal-verify.js). Arithmetic over what is stored,
 * so it runs in milliseconds; the Proposals grid colours each box from it,
 * and the steward below repairs whatever it finds.
 */
function proposalVerification(rows) {
  const live = groups.filter((g) => !g.archived && g.eligible);
  const check = (rs) => verifyProposals({
    groups: live.map((g) => ({ name: g.name, slots: slotsForGroup(g), tiers: clientGroupView(g).tiers || {} })),
    rows: rs,
    // Everything stored for the group, each plan marked with whether the
    // client is shown it; the check compares the client's share to the rules.
    served: (name) => (currentProposals[name] || []).filter((p) => !retiredSlot(p.slot)),
    isEpoPlan,
    isBlankPlan,
    slotEnabled,
    isDtq,
    reading: rereading,
    auditing,
    correcting,
    readingVersion,
    gaveUp: (id) => (stewardState && stewardState[id] && stewardState[id].gaveUp) || null,
  });
  const v = check(rows);
  // Which proposals a client may see as Verified. A newer upload waiting
  // beside the proposal in force (still reading, or failed to read) holds the
  // box back on the admin grid until the steward sorts it out - but it does
  // not un-verify the proposal in force, whose plans stay on the client's
  // grid: the in-force proposals are checked again without the waiting ones.
  const waiting = new Set(v.groups.flatMap((g) => g.cells).flatMap((c) => (c.waiting || []).map((w) => w.id)));
  const inForce = waiting.size ? check(rows.filter((r) => !waiting.has(r.id))) : v;
  verifiedProposals.clear();
  for (const g of inForce.groups) {
    for (const c of g.cells) {
      if (c.state !== "verified" || c.proposalId == null) continue;
      const r = rows.find((rr) => rr.id === c.proposalId);
      verifiedProposals.set(c.proposalId, (r && r.audit && r.audit.completedAt) || new Date().toISOString());
    }
  }
  return v;
}

/**
 * Persist each proposal's processing stage (and, for NEEDS_REVIEW, why) as
 * the check sees it, so the database says where every proposal stands. A
 * proposal with a job in flight keeps the stage that job set.
 */
async function syncStages(v, rows) {
  for (const g of v.groups) {
    for (const c of g.cells) {
      if (c.state === "missing" || !c.stage || c.state === "working") continue;
      const id = c.proposalId ?? c.fixId;
      const r = rows.find((rr) => rr.id === id);
      if (!r) continue;
      const reason = c.stage === "NEEDS_REVIEW" || c.stage === "VERIFIED" ? (c.stage === "VERIFIED" ? null : c.stageReason) : c.stageReason;
      if (r.stage === c.stage && (r.stage_reason || null) === (reason || null)) continue;
      await proposalStore.updateProposal(id, { stage: c.stage, stage_reason: reason ? String(reason).slice(0, 1000) : null }).catch(() => undefined);
    }
  }
}

/** One line for the book, and one per box that is not verified - the check, readable in the deploy log. */
async function logProposalCheck() {
  await loadSteward();
  const v = proposalVerification(await proposalStore.listProposals());
  const t = v.totals;
  console.log(`proposal check: ${t.verified} of ${t.filed} Verified, ${t.working} in progress, ${t.failing} queued, ${t.stuck} NEEDS_REVIEW (by step: ${Object.entries(t.byStep).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none"})`);
  for (const g of v.groups) {
    for (const c of g.cells) {
      if (c.state === "verified" || c.state === "missing") continue;
      const st = c.failedAt ? c.steps[c.failedAt] : null;
      console.log(`proposal check: ${g.group} / ${c.slot} #${c.proposalId ?? c.fixId}: ${c.state} at ${c.failedAt || "?"} (${c.fix || "-"}) - ${c.stuck || (st ? st.note : "")}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The steward: the AI that works the check. Every box that fails a step names
// its repair; the steward carries it out, then checks again, until the box is
// green or it has run out of honest things to try:
//   read     - read the document again (in parts when it is long)
//   audit    - count the plans on the document and check every stored value
//   correct  - have Claude settle the audit's findings against the page:
//              fix wrong values, add missing plans, fill missing rates,
//              drop what is not on the document - then audit again
//   refresh  - rebuild what the group's page is served
// Limits per proposal: two reads, two audits that could not run, three
// corrections per reading (then one fresh read and three more). A box still
// failing after that is marked for a person, with why. What the AI changed is
// logged on the row (extracted.corrections). Runs at boot, after any change
// to the proposals, and every ten minutes.

const STEWARD_KEY = "proposals.steward";
let stewardState = null;
/**
 * Bumped when a change to the reader or the check makes earlier give-ups
 * worth another try: on the first load after a deploy that carries a new
 * epoch, every box the steward gave up on is tried again from scratch.
 * (2026-09-25b: encrypted carrier PDFs - Boss Logistics, Adobe HVAC, Taz
 * Panama City - can now be counted and read in page windows. 2026-09-25c:
 * every plan is stored, EPO included; attempts count when they finish.
 * 2026-09-25d: source coverage is required - every reading without a
 * coverage record is read once more, so each gets a fresh set of attempts.
 * 2026-09-25e: every Claude audit had failed on a schema the API refused
 * (18 nullable fields, limit 16); attempts spent on that are given back.)
 */
const STEWARD_EPOCH = "2026-09-26a"; // f: attempts spent on the Anthropic monthly-limit errors are given back
async function loadSteward() {
  if (stewardState) return stewardState;
  stewardState = (db && (await db.getSetting(STEWARD_KEY).catch(() => null))) || {};
  if (stewardState.__epoch !== STEWARD_EPOCH) {
    const n = Object.keys(stewardState).filter((k) => k !== "__epoch").length;
    stewardState = { __epoch: STEWARD_EPOCH };
    if (db) await db.setSetting(STEWARD_KEY, stewardState, "steward").catch(() => undefined);
    if (n) console.log(`steward: new epoch ${STEWARD_EPOCH} - ${n} proposal(s) get a fresh round of repairs`);
  }
  return stewardState;
}
async function saveSteward() {
  if (db && stewardState) await db.setSetting(STEWARD_KEY, stewardState, "steward").catch((e) => console.error("steward: could not save:", e.message));
}
const stewardEntry = (id) => (stewardState[id] = stewardState[id] || { reads: 0, audits: 0, corrections: 0, refresh: 0, gaveUp: null });

/** Read a proposal's document again, keeping it where it is filed. */
async function stewardRead(row) {
  const f = await proposalStore.getProposalFile(row.id).catch(() => null);
  if (!f) return false;
  rereading.add(row.id);
  try {
    await runAnalysis(row.id, { buffer: f.data, mime: f.mime, filename: f.filename, context: row.context || null }, true);
  } finally {
    rereading.delete(row.id);
  }
  return true;
}

/**
 * Settle an audit's findings against the document, apply the corrections and
 * audit again. When the corrector changes nothing - every finding was the
 * auditor's mistake - and the counts agree, the third reading settles it.
 */
async function runProposalCorrection(id) {
  if (correcting.has(id)) return;
  correcting.add(id);
  let reaudit = false;
  try {
    const row = (await proposalStore.listProposals()).find((r) => r.id === id);
    const f = row && (await proposalStore.getProposalFile(id).catch(() => null));
    if (!row || !f || !row.extracted) return;
    await setStage(id, "CORRECTING");
    const x = row.extracted;
    const startVersion = readingVersion(x);
    const plans = Array.isArray(x.plans) ? x.plans : [];
    const textSource = !/pdf|image/i.test(String(row.mime || ""));
    const missingRates = [];
    plans.forEach((pl, index) => {
      for (const t of ["EE", "ES", "EC", "FAM"]) {
        // All four tiers: a plan's rate set is complete, or the carrier's
        // document is confirmed not to price that tier.
        if ((!pl.rates || pl.rates[t] == null) && !(Array.isArray(pl.unpriced) && pl.unpriced.includes(t))) missingRates.push({ index, tier: t });
      }
    });
    // What to settle: the current audit's findings, what deterministic
    // validation found, and any conflict between two appearances of a plan.
    const auditCurrent = row.audit && row.audit.version === startVersion;
    const findings = auditCurrent ? (row.audit.mismatches || []).map((m) => ({ ...(Number.isInteger(m.index) ? { index: m.index } : {}), plan: m.plan, ...(m.planCode ? { plan_code: m.planCode } : {}), field: m.field, stored: m.stored, on_document: m.onDocument, by: m.by })) : [];
    const val = validatePlans({ extracted: x, sourceSha: row.source_sha, textSource });
    for (const c of val.checks) if (!c.ok && (c.fix === "correct" || c.fix === "review")) findings.push({ plan: "(deterministic validation)", field: c.key, stored: "", on_document: c.note, by: "validation" });
    const conflicts = plans.flatMap((pl, index) => (Array.isArray(pl.conflicts) ? pl.conflicts : []).map((k) => ({ index, plan: pl.name, plan_code: pl.plan_code || null, field: k.field, values: k.values })));
    // Targeted: when every finding is about a value on a named plan whose
    // pages are known, only those pages go to the corrector. A missing,
    // extra or duplicated plan, or a count problem, needs the whole document.
    const structural =
      findings.some((m) => /missing_plan|extra_plan|plan_count|duplicate/.test(m.field) || (m.plan && !m.plan.startsWith("(") && !plans.some((pl) => pl.name === m.plan))) ||
      val.checks.some((c) => !c.ok && ["unique", "codes", "names", "reconciliation", "plans"].includes(c.key));
    // The plans the findings concern: their cited source (PDF pages with
    // header context, a parser-read workbook's rows) is the packet the
    // corrector reads; server/audit-packets.js falls back to the whole
    // document whenever that packet cannot be shown to be complete.
    let targetIndices = null;
    if (!structural) {
      const affected = plans.map((pl, index) => index).filter((index) => findings.some((m) => (Number.isInteger(m.index) ? m.index === index : m.plan === plans[index].name)) || conflicts.some((k) => k.index === index) || missingRates.some((mr) => mr.index === index));
      if (affected.length) targetIndices = affected;
    }
    const c = await withReadSlot(() => withUsage(usageScope(row), () => correctProposal({ filename: f.filename, mime: f.mime, buffer: f.data, extracted: x, mismatches: findings, missingRates, conflicts, targetIndices })));
    const pages = c._pageMap || null;
    const sent = c._source && !c._source.full ? (pages ? `pages ${pages.join(",")}` : "a targeted packet") : "whole document";
    // Stale guard: the reading or the document changed while the corrector
    // worked - its answer is about a version that is gone.
    const now = (await proposalStore.listProposals()).find((r) => r.id === id);
    if (!now || now.source_sha !== row.source_sha || readingVersion(now.extracted || {}) !== startVersion) {
      console.log(`proposal ${id} correction of an earlier version discarded`);
      return;
    }
    const { extracted, log } = applyCorrection(x, c, { proposalId: id, version: startVersion, by: `Claude (claude-sonnet-5) correction, ${sent}` });
    extracted.corrections = [...(x.corrections || []), ...log].slice(-300);
    // Whatever the corrector concluded - even "the auditors were wrong,
    // nothing to change" - only a fresh audit by both models can turn the
    // box green. The corrector never settles a finding on its own word.
    await proposalStore.updateProposal(id, { extracted, audit: null });
    console.log(`proposal ${id} corrected against the document (${sent}): ${log.length} change(s)${log.length ? ` - ${log.slice(0, 5).map((l) => `${l.optionId || l.plan} ${l.field}: ${l.from ?? "-"} -> ${l.to}`).join("; ")}${log.length > 5 ? "…" : ""}` : ""}`);
    // Re-audit only a reading that now passes the deterministic checks
    // (IDs aside - they are handed out on the next settle).
    const recheck = validatePlans({ extracted, sourceSha: row.source_sha, textSource });
    reaudit = recheck.checks.every((k) => k.ok || k.key === "ids");
  } catch (e) {
    console.error(`proposal ${id} correction failed:`, e.message);
  } finally {
    correcting.delete(id);
  }
  if (reaudit) await runProposalAudit(id);
  else await proposalsChanged();
}

/** Carry out one box's repair, within the limits. */
/**
 * Carry out one box's repair. A step that ran into a provider's spending
 * limit (server/ai-usage.js) proved nothing about the proposal: the attempt
 * it used is given back, so a box is never marked unreadable or given up on
 * because the account was out of credit.
 */
async function stewardRepair(cell, tiers) {
  const st = stewardEntry(cell.fixId);
  const before = { ...st };
  const quotaBefore = quotaErrorCount();
  try {
    await stewardRepairStep(cell, tiers, st);
  } finally {
    if (quotaErrorCount() > quotaBefore) {
      for (const k of Object.keys(st)) delete st[k];
      Object.assign(st, before);
      await saveSteward();
      console.log(`steward: #${cell.fixId}: stopped by the AI spending limit - attempt not counted`);
    }
  }
}

async function stewardRepairStep(cell, tiers, st) {
  const row = (await proposalStore.listProposals()).find((r) => r.id === cell.fixId);
  if (!row) return;
  const workbook = !!(row.context && row.context.source === "gravie-workbook");
  const giveUp = async (why) => {
    st.gaveUp = why;
    await saveSteward();
    console.log(`steward: #${row.id} ${row.group_name} / ${row.slot}: ${why}`);
  };
  const read = async () => {
    if (workbook) {
      // A Gravie workbook is parsed by code: parse it again, deterministically.
      if (st.reads >= 2) return giveUp("The Gravie workbook could not be parsed into plans - upload the workbook again.");
      st.reads++;
      await saveSteward();
      const f = await proposalStore.getProposalFile(row.id).catch(() => null);
      if (!f) return giveUp("The Gravie workbook is not on file.");
      try {
        const parsed = parseGravieWorkbook(f.data);
        const extracted = gravieReading(parsed, row.group_name, row.source_sha, (row.extracted && row.extracted.plans) || []);
        await proposalStore.updateProposal(row.id, { extracted, summary: extracted.summary, audit: null, stage: "EXTRACTED", error: null });
        console.log(`steward: #${row.id} ${row.group_name} / Gravie: workbook parsed again (${extracted.plans.length} plans)`);
      } catch (e) {
        await proposalStore.updateProposal(row.id, { error: e.message });
      }
      return proposalsChanged();
    }
    if (st.reads >= 2) {
      const newer = cell.proposalId != null && row.id !== cell.proposalId;
      const why =
        cell.failedAt === "extraction"
          ? `${newer ? `The newer upload ${row.filename} would not read into plans` : "The document would not read into plans"} in ${st.reads} tries - it may not be a rate quote (a case summary, say). ${newer ? "The proposal on file stays in force; upload the quote itself to replace it." : "Upload the quote itself."}`
          : `Read ${st.reads} times and still: ${cell.steps[cell.failedAt] ? cell.steps[cell.failedAt].note : "not verified"}`;
      return giveUp(why);
    }
    // An attempt is counted when it finishes, not when it starts: a read cut
    // off by a restart (a deploy) is not a try, and is simply run again.
    console.log(`steward: #${row.id} ${row.group_name} / ${row.slot}: reading again (${st.reads + 1}/2)`);
    await stewardRead(row);
    st.reads++;
    st.audits = 0;
    st.corrections = 0;
    await saveSteward();
  };
  if (cell.fix === "read") return read();
  if (cell.fix === "audit") {
    if (st.audits >= 3) return giveUp(`Both auditors could not complete in ${st.audits} tries: ${(row.audit && row.audit.notes) || "no result"}`);
    console.log(`steward: #${row.id} ${row.group_name} / ${row.slot}: dual audit against the document (${st.audits + 1}/3)`);
    const res = await runProposalAudit(row.id);
    // A run that completed at least one job made progress (the next run
    // resumes after it): only a run that completed nothing uses an attempt.
    if (!(res && res.progressed)) st.audits++;
    return saveSteward();
  }
  if (cell.fix === "correct") {
    if (st.corrections >= 3) {
      if (!workbook && st.reads < 2) return read();
      return giveUp(`Still differs from the document after ${st.corrections} corrections and a fresh read: ${cell.steps[cell.failedAt] ? cell.steps[cell.failedAt].note : ""}`);
    }
    console.log(`steward: #${row.id} ${row.group_name} / ${row.slot}: correcting against the document (${st.corrections + 1}/3)`);
    await runProposalCorrection(row.id);
    st.corrections++;
    return saveSteward();
  }
  if (cell.fix === "review" && !((cell.steps.validation && cell.steps.validation.checks) || []).some((k) => k.key === "names" && !k.ok)) {
    // A source a code parser cannot fully account for (a workbook sheet no
    // rule covers): nothing an AI repair can settle - a person looks.
    return giveUp(cell.steps[cell.failedAt] ? cell.steps[cell.failedAt].note : "The source could not be fully accounted for.");
  }
  if (cell.fix === "review") {
    // The carrier's document prints one plan name for two plan codes. One
    // correction first - a misread name is fixed against the source; if the
    // document really does print it twice, a person decides: the box goes to
    // NEEDS_REVIEW with the names and codes, and "Confirm shared name"
    // (POST /api/admin/proposals/:id/confirm-shared-names) records the answer.
    if ((st.nameChecks || 0) >= 1) return giveUp(cell.steps[cell.failedAt] ? cell.steps[cell.failedAt].note : "The same plan name is on two plan codes.");
    st.nameChecks = (st.nameChecks || 0) + 1;
    await saveSteward();
    console.log(`steward: #${row.id} ${row.group_name} / ${row.slot}: one plan name on two plan codes - checking the names against the document`);
    return runProposalCorrection(row.id);
  }
  if (cell.fix === "refresh") {
    if (st.refresh >= 2) return giveUp(`The group's grid does not match the database after a rebuild: ${cell.steps[cell.failedAt] ? cell.steps[cell.failedAt].note : ""}`);
    st.refresh++;
    await saveSteward();
    return proposalsChanged();
  }
}

/** Groups worked at once. Reads and corrections still share READ_PARALLEL slots; audits run beside them. */
const STEWARD_PARALLEL = Math.max(1, Number(process.env.KENNION_STEWARD_PARALLEL || (process.env.KENNION_CLAUDE_BATCH === "0" ? 4 : 12)));
let stewardRunning = false;
let stewardAgain = false;
let stewardTimer = null;
/** Ask for a pass soon; many changes in a row make one pass. */
function scheduleSteward(ms = 3000) {
  if (!aiEnabled() || process.env.KENNION_STEWARD === "0") return;
  if (stewardTimer) return;
  stewardTimer = setTimeout(() => {
    stewardTimer = null;
    void stewardPass().catch((e) => console.error("steward:", e.message));
  }, ms);
}

async function stewardPass() {
  if (stewardRunning) {
    stewardAgain = true;
    return;
  }
  stewardRunning = true;
  try {
    do {
      stewardAgain = false;
      await loadSteward();
      // A plan stored twice under a reader-added placement label is folded by
      // rule before anything is sent to a model.
      if (await foldStoredPlacementDuplicates()) await proposalsChanged();
      const rowsNow = await proposalStore.listProposals();
      const v = proposalVerification(rowsNow);
      await syncStages(v, rowsNow);
      // A box that is green again starts fresh the next time it changes.
      let cleaned = false;
      for (const g of v.groups) {
        for (const c of g.cells) {
          if (c.state === "verified" && c.proposalId != null && stewardState[c.proposalId]) {
            delete stewardState[c.proposalId];
            cleaned = true;
          }
        }
      }
      if (cleaned) await saveSteward();
      const tiersOf = new Map(groups.map((g) => [g.name, clientGroupView(g).tiers || {}]));
      // Group by group: each group's boxes are worked together, two groups
      // at a time, and each group reports where it stands when it is done.
      // A group with a box that has nothing usable on the grid at all (no
      // reading in force) goes first; then every other group in book order.
      const empty = (c) => c.failedAt === "extraction" && c.proposalId == null ? 0 : c.failedAt === "extraction" && c.fixId === c.proposalId && !(c.counts && c.counts.stored) ? 0 : 1;
      // Then the quickest repairs first: a grid refresh or an audit of a
      // reading already on file turns a box green in minutes; a fresh read
      // of a long document takes an hour. The slow ones still get their turn.
      const COST = { refresh: 0, audit: 1, review: 2, correct: 2, read: 3 };
      const cost = (c) => (COST[c.fix] ?? 2);
      const order = (a, b) => empty(a) - empty(b) || cost(a) - cost(b);
      const byGroup = v.groups
        .map((g) => ({ g, jobs: g.cells.filter((c) => c.state === "fail" && c.fix && c.fixId != null).sort(order) }))
        .filter((x) => x.jobs.length)
        .sort((a, b) => order(a.jobs[0], b.jobs[0]));
      if (!byGroup.length) break;
      // A provider's spending limit is in force: every repair would fail
      // and prove nothing. Wait; a probe every half hour tries again.
      const block = aiQuotaBlock();
      if (block) {
        console.log(`steward: paused - ${block.provider} spending limit reached${block.until ? ` (the provider says until ${block.until})` : ""}; ${byGroup.reduce((n, x) => n + x.jobs.length, 0)} box(es) wait`);
        setTimeout(() => scheduleSteward(0), 31 * 60 * 1000);
        break;
      }
      console.log(`steward: ${byGroup.reduce((n, x) => n + x.jobs.length, 0)} box(es) to fix across ${byGroup.length} group(s)`);
      const queue = [...byGroup];
      await Promise.all(
        Array.from({ length: Math.min(STEWARD_PARALLEL, queue.length) }, async () => {
          while (queue.length) {
            const { g, jobs } = queue.shift();
            for (const c of jobs) {
              if (aiQuotaBlock()) break;
              // The steward's Claude calls go into Message Batches: half price.
              await withBatch(() => stewardRepair(c, tiersOf.get(g.group))).catch((e) => console.error(`steward: #${c.fixId}:`, e.message));
            }
            if (aiQuotaBlock()) {
              queue.length = 0;
              break;
            }
            const now = proposalVerification(await proposalStore.listProposals()).groups.find((x) => x.group === g.group);
            if (now) console.log(`steward: ${g.group}: ${now.verified} of ${now.filed} verified${now.cells.filter((c) => c.state === "verified").length ? ` (${now.cells.filter((c) => c.state === "verified").map((c) => `${c.slot} ${c.plans}`).join(", ")})` : ""}`);
          }
        }),
      );
      stewardAgain = true;
    } while (stewardAgain);
  } finally {
    stewardRunning = false;
  }
  await logProposalCheck().catch(() => undefined);
}

app.get("/api/admin/proposals/verify", requireStaff, async (req, res) => {
  try {
    await loadSteward();
    const block = aiQuotaBlock() || lastQuotaBlock();
    res.json({ ...proposalVerification(await proposalStore.listProposals()), steward: { running: stewardRunning, enabled: aiEnabled() && process.env.KENNION_STEWARD !== "0", paused: block ? { provider: block.provider, until: block.until, since: block.at } : null, batches: batchState() } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Run the steward now, and give every box it gave up on one more round. */
app.post("/api/admin/proposals/fix", requireStaff, async (req, res) => {
  await loadSteward();
  for (const k of Object.keys(stewardState)) if (k !== "__epoch") delete stewardState[k];
  await saveSteward();
  scheduleSteward(0);
  res.json({ ok: true });
});

/**
 * Proposal slots ON / OFF for a group's client. GET lists every setting
 * Kennion has made (a slot not listed is ON); POST sets one:
 * { group, slot, clientEnabled }. OFF hides every plan of that slot from the
 * client's grid, cards, documents and assistant, and changes nothing about
 * how the proposal is stored, validated or audited.
 */
/**
 * API usage: every model call recorded (server/ai-usage.js), for one proposal
 * (?proposal=ID) or since a time (?since=ISO), with totals by purpose and by
 * the model that actually served each call - why one proposal cost more than
 * another is in the rows.
 */
app.get("/api/admin/ai-usage", requireStaff, async (req, res) => {
  const proposalId = req.query.proposal != null ? Number(req.query.proposal) : null;
  const since = req.query.since ? String(req.query.since) : null;
  let records;
  if (db) records = await db.listAiUsage({ proposalId, since, limit: req.query.limit });
  else records = memoryUsage().filter((r) => (proposalId == null || r.proposalId === proposalId) && (!since || r.at >= since)).reverse();
  res.json({ records, ...summarize(records) });
});

/** Where a proposal's dual audit stands, job by job: which saved jobs still count and what runs next. */
app.get("/api/admin/proposals/:id/audit-progress", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  const row = (await proposalStore.listProposals()).find((r) => r.id === id);
  if (!row) return res.status(404).json({ error: "No such proposal." });
  const jobs = await auditJobs.list(id).catch(() => ({}));
  res.json({ proposalId: id, progress: auditProgress(row.extracted || {}, row.source_sha || null, jobs), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, { key: v.key, at: v.at, source: v.source || null, readingVersion: v.readingVersion || null }])) });
});

app.get("/api/admin/proposal-slots", requireStaff, (req, res) => {
  res.json({ slots: [...slotVisibility.values()] });
});
app.post("/api/admin/proposal-slots", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  const b = req.body || {};
  const groupName = String(b.group || "");
  const slot = String(b.slot || "");
  if (!groups.some((g) => g.name === groupName)) return res.status(404).json({ error: "No such group." });
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: "No such proposal slot." });

  // Handle DTQ (Decline to Quote)
  if (b.dtq !== undefined) {
    try {
      if (db) await db.setSlotDTQ(groupName, slot, b.dtq, req.staffEmail || null);
    } catch (e) {
      return res.status(500).json({ error: "Could not save: " + e.message });
    }
    // Update in-memory cache
    const existing = slotVisibility.get(`${groupName}||${slot}`) || { groupName, slot, clientEnabled: true, updatedBy: null, updatedAt: new Date().toISOString() };
    slotVisibility.set(`${groupName}||${slot}`, { ...existing, dtq: b.dtq, updatedBy: req.staffEmail || null, updatedAt: new Date().toISOString() });
    console.log(`proposal slot ${groupName} / ${slot}: ${b.dtq ? "marked DTQ" : "removed DTQ"} (${req.staffEmail || "staff"})`);
    await proposalsChanged();
    res.json({ ok: true, dtq: b.dtq });
    return;
  }

  // Handle client visibility
  if (typeof b.clientEnabled !== "boolean") return res.status(400).json({ error: "clientEnabled must be true or false." });
  const row = { groupName, slot, clientEnabled: b.clientEnabled, updatedBy: req.staffEmail || null, updatedAt: new Date().toISOString() };
  try {
    if (db) await db.setSlotVisibility(groupName, slot, b.clientEnabled, req.staffEmail || null);
  } catch (e) {
    return res.status(500).json({ error: "Could not save: " + e.message });
  }
  slotVisibility.set(`${groupName}||${slot}`, row);
  console.log(`proposal slot ${groupName} / ${slot}: client ${b.clientEnabled ? "ON" : "OFF"} (${req.staffEmail || "staff"})`);
  await proposalsChanged();
  res.json({ ok: true, slot: row });
});

/**
 * A person confirms that the carrier really does print one plan name for
 * several different plan codes (validation's "Plan names unique" check
 * flags it and the steward will not decide it alone). Recorded on the
 * reading with the exact codes, by whom and when; a later change to those
 * codes flags it again. The plans stay separate records with their own IDs.
 */
app.post("/api/admin/proposals/:id/confirm-shared-names", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  const row = (await proposalStore.listProposals()).find((r) => r.id === id);
  if (!row || !row.extracted) return res.status(404).json({ error: "No such proposal." });
  const plans = Array.isArray(row.extracted.plans) ? row.extracted.plans : [];
  const byName = new Map();
  for (const pl of plans) {
    const k = `${exactName(pl.name).toLowerCase()}|${String(pl.network || "").replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (exactName(pl.name) && normCode(pl.plan_code)) byName.set(k, [...(byName.get(k) || []), pl]);
  }
  const shared = [...byName.values()].filter((g) => g.length > 1 && new Set(g.map((pl) => normCode(pl.plan_code))).size === g.length);
  if (!shared.length) return res.status(400).json({ error: "No plan name on this proposal is shared by different plan codes." });
  const at = new Date().toISOString();
  const confirmed = shared.map((g) => ({ name: g[0].name, codes: g.map((pl) => pl.plan_code), by: req.staffEmail || null, at }));
  await proposalStore.updateProposal(id, { extracted: { ...row.extracted, shared_names_confirmed: confirmed } });
  await loadSteward();
  if (stewardState[id]) stewardState[id].gaveUp = null;
  await saveSteward();
  console.log(`proposal ${id}: shared plan name(s) confirmed by ${req.staffEmail || "staff"} - ${confirmed.map((c) => `"${c.name}" (${c.codes.join(", ")})`).join("; ")}`);
  await proposalsChanged();
  res.json({ ok: true, confirmed });
});

/** Assign, reassign, confirm, or relabel a proposal. */
/**
 * Re-read every proposal whose extraction predates the current questions - 
 * anything with no `quotes_medical` on it. One click after a schema change,
 * rather than pressing Re-read on each row. `all=1` re-reads everything.
 */
app.post("/api/admin/proposals/reanalyze", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  if (!aiEnabled()) return res.status(400).json({ error: "AI reading is off, so there is nothing to re-read with." });
  const all = !!(req.body || {}).all;
  const rows = await proposalStore.listProposals();
  const want = rows.filter(
    (r) => r.status !== "container" && (all || !r.extracted || typeof r.extracted.quotes_medical !== "boolean" || lacksBenefits(r)),
  );
  for (const r of want) {
    const f = await proposalStore.getProposalFile(r.id).catch(() => null);
    if (!f) continue;
    const keep = !!(r.group_name && r.assigned_by && r.assigned_by !== "ai" && r.assigned_by !== "filename");
    await proposalStore.updateProposal(r.id, { status: "analyzing", error: null });
    void runAnalysis(r.id, { buffer: f.data, mime: f.mime, filename: f.filename, context: r.context || null }, keep);
  }
  await proposalsChanged();
  res.json({ ok: true, reading: want.length });
});

app.post("/api/admin/proposals/:id", requireStaff, express.json({ limit: "16kb" }), async (req, res) => {
  const id = Number(req.params.id);
  const { group, carrier, confirm, slot, renumber } = req.body || {};
  const fields = {};
  let current = null;
  // A slot's option IDs drifted out of the clean 1.. sequence - repeated
  // re-reads that never matched a prior plan, most often - so staff can ask
  // for a fresh, compact renumber: the whole prefix in this group is
  // released and handed out again from 1, the same repair an EPO twin's
  // numbers already get automatically.
  if (renumber === true) {
    current = (await proposalStore.listProposals()).find((r) => r.id === id);
    if (!current) return res.status(404).json({ error: "No such proposal." });
    fields.extracted = { ...(current.extracted || {}), renumber: true };
  }
  if (slot !== undefined) {
    if (slot != null && slot !== "" && !SLOTS.includes(slot)) {
      return res.status(400).json({ error: `Slot must be one of: ${SLOTS.join(", ")}.` });
    }
    fields.slot = slot == null || slot === "" ? null : slot;
  }
  if (group !== undefined) {
    const clean = group == null || group === "" ? null : String(group);
    if (clean && !groups.some((g) => g.name === clean)) {
      return res.status(404).json({ error: "No such group." });
    }
    fields.group_name = clean;
    fields.status = clean ? "assigned" : "unassigned";
    fields.assigned_by = clean ? req.staffEmail || "staff" : null;
  }
  // Churches never get a UHC Level Funded slot, whether the slot or the
  // group is the field changing on this call.
  if (slot !== undefined || group !== undefined) {
    if (!current) current = (await proposalStore.listProposals()).find((r) => r.id === id);
    const finalSlot = fields.slot !== undefined ? fields.slot : current && current.slot;
    const finalGroup = fields.group_name !== undefined ? fields.group_name : current && current.group_name;
    if (finalSlot === "UHC Level Funded" && finalGroup && isChurch(groups.find((g) => g.name === finalGroup))) {
      return res.status(400).json({ error: "Churches are fully insured with UHC only - use UHC Fully Insured." });
    }
  }
  if (confirm) {
    fields.status = "assigned";
    fields.assigned_by = req.staffEmail || "staff";
  }
  if (carrier !== undefined) fields.carrier = carrier == null ? null : String(carrier).slice(0, 80);
  try {
    const row = await proposalStore.updateProposal(id, fields);
    if (!row) return res.status(404).json({ error: "No such proposal." });
    await proposalsChanged();
    res.json({ ok: true, proposal: row });
  } catch (e) {
    res.status(500).json({ error: "Could not save: " + e.message });
  }
});

/** Read the document again - after the roster changed, or a key was added. */
app.post("/api/admin/proposals/:id/analyze", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  const f = await proposalStore.getProposalFile(id).catch(() => null);
  if (!f) return res.status(404).json({ error: "No such proposal." });
  const current = (await proposalStore.listProposals()).find((r) => r.id === id);
  if (current && current.status === "container") {
    return res.status(400).json({ error: "Re-read the attachments, not the email itself." });
  }
  const keep = !!(current && current.group_name && current.assigned_by && current.assigned_by !== "ai" && current.assigned_by !== "filename");
  await proposalStore.updateProposal(id, { status: "analyzing", error: null });
  void runAnalysis(id, { buffer: f.data, mime: f.mime, filename: f.filename, context: current?.context || null }, keep);
  res.json({ ok: true });
});

/** Run the two-model audit on one proposal again. */
app.post("/api/admin/proposals/:id/audit", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  const row = (await proposalStore.listProposals()).find((r) => r.id === id);
  if (!row) return res.status(404).json({ error: "No such proposal." });
  if (!row.extracted || !Array.isArray(row.extracted.plans) || !row.extracted.plans.length) return res.status(400).json({ error: "Nothing read from this proposal yet; re-read it first." });
  void runProposalAudit(id);
  res.json({ ok: true });
});

app.delete("/api/admin/proposals/:id", requireStaff, async (req, res) => {
  const ok = await proposalStore.deleteProposal(Number(req.params.id)).catch(() => false);
  if (!ok) return res.status(404).json({ error: "No such proposal." });
  await proposalsChanged();
  res.json({ ok: true });
});

app.use(
  "/assets",
  express.static(path.join(publicDir, "assets"), { maxAge: "1y", immutable: true }),
);
app.use(
  express.static(publicDir, {
    index: false,
    maxAge: "1h",
    // A direct request for the shell gets the same rule as the fallback.
    setHeaders: (res, file) => {
      if (file === indexHtml) res.setHeader("Cache-Control", "no-store");
    },
  }),
);

// The nightly database backups (see backupIfDue below): list them, or run one now.
app.get("/api/admin/backups", requireStaff, async (req, res) => {
  try {
    res.json({ enabled: !!backupStore, running: backupRunning, last: db ? await db.getSetting("backup.last") : null, lastError: db ? await db.getSetting("backup.error") : null, backups: backupStore ? await listBackups(backupStore) : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/admin/backups", requireStaff, async (req, res) => {
  if (!backupStore) return res.status(400).json({ error: "Backups are off: no storage bucket is configured." });
  if (backupRunning) return res.status(409).json({ error: "A backup is already running." });
  const m = await backupIfDue(true);
  if (!m) return res.status(500).json({ error: "The backup failed - see the server log." });
  res.json({ stamp: m.stamp, tables: m.tables.length, rows: m.rows, bytes: m.bytes });
});

// An API path no route claimed is a mistake, not a page. Falling through to
// the app answered a mistyped endpoint with 200 and a lump of HTML, so the
// caller got a JSON parse error instead of being told what was wrong.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} /api${req.path}` });
});

// SPA fallback - the portal owns every non-API route. The page shell is never
// cached: its script names change with every build, so a browser or proxy
// holding yesterday's shell would keep loading yesterday's app after a deploy.
app.use((_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(indexHtml, { cacheControl: false });
});

// Errors on API routes must stay JSON; the default handler returns an HTML
// stack trace, which the client could only report as "could not read that file".
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const msg =
    status === 413
      ? "That file is larger than the server accepts."
      : err.message || "Server error";
  if (req.path.startsWith("/api/")) return res.status(status).json({ error: msg });
  return res.status(status).type("text/plain").send(msg);
});

const port = Number(process.env.PORT) || 5000;
async function boot() {
  if (db) {
    try {
      await db.init();
      const state = await db.load();
      imported = { groups: state.groups, splits: state.splits };
      overrides = state.overrides;
      meta = state.meta || {};
      importedAt = state.importedAt || {};
      recentImports = await db.recentImports();
      carrierStats = await db.latestCarrierStats();
      const fr = await db.latestFunding();
      if (fr) {
        funding = { id: fr.id, month: fr.month, filename: fr.filename, fileStamp: fr.file_stamp, lines: fr.lines, byInvoice: fr.by_invoice, summary: fr.summary, uploadedBy: fr.uploaded_by, uploadedAt: fr.uploaded_at };
      }
      const st = await db.stats();
      console.log(`postgres connected - ${st.groups} imported groups, ${st.overrides} rate overrides, ${st.quotes} carrier quotes`);
    } catch (e) {
      // A database that is configured but unreachable must not take the site
      // down; fall back to the shipped census and say so loudly.
      console.error("postgres unavailable, serving the shipped census only:", e.message);
    }
  }
  // After the schema, so the first deploy of the code table can read it, and
  // before anything is served, so no sign-in is answered without a credential.
  try {
    await settleAdminCode();
  } catch (e) {
    console.error("could not settle the sign-in code:", e.message);
  }
  markAdminCodeReady();
  await loadRatesLock();
  await loadMarketRules();
  await loadSlotVisibility();
  await loadWelcomeCopy();
  await loadGroupCookieSecret();
  await loadPlaybook();
  await loadXmlVerify();
  chatStore.sweepPendingFiles().catch((e) => console.error("chat attachments sweep:", e.message));
  // The 15 current plan designs live in the database too, one row per plan
  // name, so they can be read and kept there; the JSON is the seed and the
  // fallback. Rows already in the database win over the JSON.
  if (db) {
    (async () => {
      const stored = await db.listPlanDesigns();
      if (!stored.length) {
        const seed = Object.entries(data.planDesigns || {}).map(([planName, benefits]) => ({ planName, planYear: 2026, tpa: null, benefits, source: "KennionHealthPlansComparison.xlsx" }));
        await db.upsertPlanDesigns(seed, "system");
        console.log(`plan designs: seeded ${seed.length} current plans into the database`);
      } else {
        data.planDesigns = Object.fromEntries(stored.map((d) => [d.planName, d.benefits]));
        console.log(`plan designs: ${stored.length} current plans loaded from the database`);
      }
    })().catch((e) => console.error("plan designs:", e.message));
  }
  // Proposals read before the audit existed get checked now, one at a time,
  // so every plan a client can open carries a verdict.
  if (aiEnabled() && process.env.KENNION_FAKE_AI !== "1") {
    (async () => {
      // First, and quickly: an audit composed under older comparison rules
      // is composed again from its saved answers - every job is reused, no
      // model is called - before any long audit can hold it up.
      const current = (await proposalStore.listProposals().catch(() => [])).filter(
        (r) => r.status === "assigned" && r.slot && !r.superseded_by && r.audit && r.audit.version && r.extracted && r.audit.version === readingVersion(r.extracted) && (r.audit.compare || 1) !== COMPARE_VERSION,
      );
      const recompose = [];
      for (const r of current) {
        const p = auditProgress(r.extracted, r.source_sha || null, await auditJobs.list(r.id).catch(() => ({})));
        if (!p.claude.next && !p.openai.next) recompose.push(r.id);
      }
      if (recompose.length) console.log(`proposal audit: ${recompose.length} audit(s) composed again under comparison rules v${COMPARE_VERSION} from their saved answers (no model calls)`);
      await withBatch(() => auditInParallel(recompose));
      const rows = (await proposalStore.listProposals().catch(() => [])).filter((r) => r.status === "assigned" && r.slot && !r.superseded_by && !r.audit && r.extracted && Array.isArray(r.extracted.plans) && r.extracted.plans.length);
      if (rows.length) console.log(`proposal audit: ${rows.length} current proposal(s) not yet checked; running`);
      await withBatch(() => auditInParallel(rows.map((r) => r.id)));
    })().catch((e) => console.error("proposal audit sweep:", e.message));
  }
  rebuild();
  // An import that covered the roster before this rule existed still says
  // who has left: every census-only group it did not touch.
  const last = recentImports[0];
  if (last && last.companies_applied >= groups.length / 2) {
    await archiveLeavers(new Set(Object.keys(imported.groups || {})));
    rebuild();
  }
  // The carriers' standard designs first, so the proposals built next carry them.
  // Documents before the catalogue, so each design's documents flag is right
  // from its first load rather than only after a second loadPlanCatalogue().
  await loadPlanDocuments();
  await loadPlanCatalogue();
  await loadCarrierPlanLimits();
  await loadMarketingResources();
  // Every proposal's source document gets its version hash, once; each
  // extraction and audit is then tied to it.
  await backfillSourceSha().catch((e) => console.error("proposals: source hash:", e.message));
  await proposalsChanged();
  await refreshAudit();
  // Gravie workbooks already on file, re-read with the current parser and
  // written as rows where they are not yet. Logged, never fatal.
  try {
    await settleGravieQuotes();
  } catch (e) {
    console.error("gravie:", e.message);
  }
  try {
    if (await foldStoredPlacementDuplicates()) await proposalsChanged();
  } catch (e) {
    console.error("duplicates:", e.message);
  }
  try {
    await auditInvoices();
  } catch (e) {
    console.error("invoice audit:", e.message);
  }
  // The four-step check, logged, so the state of every box is in the deploy
  // log. Read-only; never blocks boot.
  void logProposalCheck().catch((e) => console.error("proposals: check:", e.message));
  // The steward works whatever the check found, and looks again every ten
  // minutes in case anything slipped past the change hooks.
  scheduleSteward(20000);
  setInterval(() => scheduleSteward(0), 10 * 60 * 1000).unref();
  // Proposals read before the reader asked for per-plan benefits, re-read in
  // the background so the plan cards fill in. Never blocks boot.
  void backfillPlanBenefits().catch((e) => console.error("proposals: benefits re-read:", e.message));
  // Groups imported before the parser kept each plan's full Employee Navigator
  // name get it from the export already in the database. Never blocks boot.
  void backfillFromStoredExport().catch((e) => console.error("stored export: backfill:", e.message));
  // The inbox: first the key pair a file can be sealed to (made on the first
  // boot, kept in settings, its public half in every deploy log), then any
  // files placed in the bucket or at a URL, once every group is known to
  // match against. Logged, never fatal.
  if (db) {
    try {
      await logInboxKey();
      await logPresignedUploads();
      await ingestInbox({
        zip: (buf) => ingestZip(buf, process.env.INBOX_MONTH || new Date().toISOString().slice(0, 7), "inbox"),
        xls: (buf, name) => ingestCarrierStats(buf, name, "inbox"),
        xlsx: (buf, name) => ingestCarrierStats(buf, name, "inbox"),
      });
    } catch (e) {
      console.error("inbox:", e.message);
    }
  }
}

// Background Claude work (the steward, the boot audit sweep) goes through
// the Message Batches API at half the price; batches still open from before
// a restart are followed again (server/claude-batch.js).
{
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE || "";
  if (key) await configureBatches({ client: () => new Anthropic({ apiKey: key, maxRetries: 3, timeout: 10 * 60 * 1000 }), persist: db ? batchDbStore(db) : undefined }).catch((e) => console.error("claude batch:", e.message));
}

await boot();

// Nightly backup of the whole database to the storage bucket (server/backup.js):
// the Railway plan keeps no volume backups. At boot when the newest backup is
// more than a day old, then once a night after BACKUP_HOUR_UTC; the newest
// BACKUP_KEEP_DAYS are kept. KENNION_BACKUP=0 turns it off.
const BACKUP_HOUR_UTC = Number(process.env.KENNION_BACKUP_HOUR_UTC || 8); // 3am Central
const backupStore = db && process.env.KENNION_BACKUP !== "0" ? s3Store() : null;
let backupRunning = false;
async function backupIfDue(force = false) {
  if (!backupStore || backupRunning) return null;
  const today = new Date().toISOString().slice(0, 10);
  const last = await db.getSetting("backup.last").catch(() => null);
  const ageHours = last && last.at ? (Date.now() - new Date(last.at).getTime()) / 36e5 : Infinity;
  const due = force || ageHours > 30 || (last && last.stamp !== today && new Date().getUTCHours() >= BACKUP_HOUR_UTC);
  if (!due) return null;
  backupRunning = true;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false } });
  try {
    const m = await runBackup({ pool, store: backupStore, stamp: today });
    await db.setSetting("backup.last", { at: m.at, stamp: m.stamp, tables: m.tables.length, rows: m.rows, bytes: m.bytes, seconds: m.seconds }, "backup");
    await pruneBackups(backupStore);
    return m;
  } catch (e) {
    console.error("backup: failed:", e.message);
    await db.setSetting("backup.error", { at: new Date().toISOString(), error: e.message }, "backup").catch(() => undefined);
    return null;
  } finally {
    backupRunning = false;
    await pool.end().catch(() => undefined);
  }
}
if (backupStore) {
  setTimeout(() => void backupIfDue(), 60_000);
  setInterval(() => void backupIfDue(), 60 * 60 * 1000);
} else if (db) {
  console.log("backup: off - no storage bucket configured (S3_BUCKET) or KENNION_BACKUP=0");
}
app.listen(port, "0.0.0.0", () => {
  const n = Object.keys(imported.groups || {}).length;
  const store = db ? "postgres" : DURABLE ? "volume" : "ephemeral disk";
  console.log(
    `Kennion renewal portal listening on :${port} - ${groups.length} groups, ` +
      `${n} imported, storage: ${store}`,
  );
});

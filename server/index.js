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
import { parseEnStream, premiumBreakdown, classifyPlans, newDiagnostics, mergeDiagnostics } from "./en-parse.js";
import { createDb } from "./db.js";
import { assignCodes, sizeFor, normalizeName } from "./group-id.js";
import { eligibilityOf } from "./eligibility.js";
import { aiEnabled, analyzeProposal, explainReconciliation, explainAudit } from "./ai.js";
import { expandUpload, prepareForModel } from "./intake.js";
import { parseCarrierStats } from "./carrier-stats.js";
import { runAudit, auditFingerprint } from "./audit.js";
import { parseFunding, assignInvoices, summariseFunding, bandTier } from "./funding.js";

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

/** Overrides for one group, in the `group||plan||tier` shape the client uses. */
function overridesFor(name) {
  const out = {};
  const prefix = name + "||";
  for (const [k, v] of Object.entries(overrides)) if (k.startsWith(prefix)) out[k] = v;
  return out;
}

// The census export carries a grand-total row alongside the real groups; it has
// no plans, members or rates and is not a client — filtered in rebuild().

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
 * with a single-candidate prefix fallback — the same rule an import uses. A
 * manager set by hand wins over this.
 */
const MANAGER_LIST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "account-managers.json"), "utf8"),
);
export const MANAGERS = MANAGER_LIST.managers;
const MANAGER_BY_NAME = new Map(MANAGER_LIST.list.map((r) => [normalizeName(r.group), r.manager]));
/**
 * Cobalt quotes a self-funded plan for a handful of groups, not the whole
 * book, so its slot only applies to those — plus any group that already has a
 * Cobalt proposal on file, so nothing uploaded is ever hidden.
 */
const COBALT_GROUPS = new Set(
  JSON.parse(fs.readFileSync(path.join(__dirname, "data", "cobalt-groups.json"), "utf8")).list.map(normalizeName),
);
function cobaltApplies(name) {
  const k = normalizeName(name);
  if (!k) return false;
  if (COBALT_GROUPS.has(k)) return true;
  // The list names companies its own way ("Forestry Enviro"), so a single
  // candidate either way round counts, the same rule an import uses.
  const hits = [...COBALT_GROUPS].filter((n) => n.startsWith(k) || k.startsWith(n));
  return hits.length === 1;
}

/** The slots that apply to one group: every carrier but Cobalt, which is by arrangement. */
function slotsForGroup(name) {
  const hasCobalt = Object.values(proposalSlotsByGroup[name] || {}).length > 0;
  return SLOTS.filter((sl) => sl !== "Cobalt" || cobaltApplies(name) || hasCobalt);
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
let adminGroups = [];
/** Proposals filed under each group, so the Groups page can show coverage. */
let proposalCounts = {};
/**
 * Each group's current proposals — the newest assigned one per slot, with
 * what Claude read off it (plans and tier rates) — keyed by group name. This
 * is what a group's 2027 Options page prices from; no file bytes, no flags.
 */
let currentProposals = {};
/** group -> { slot: true } for slots that already hold a proposal, so a slot in use is never hidden. */
let proposalSlotsByGroup = {};
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

function rebuild() {
  const base = data.groups.filter((g) => (g.plans || []).length > 0);
  const merged = new Map(base.map((g) => [g.name, g]));
  // An imported group replaces the census row of the same name outright.
  for (const [name, g] of Object.entries(imported.groups || {})) merged.set(name, g);

  groups = [...merged.values()];

  // Derive a code for every group, then let any staff-assigned one win. Derived
  // codes are computed over the whole roster so they stay collision-free.
  const derived = assignCodes(groups.map((g) => g.name));
  const claimed = new Set(
    Object.values(meta).map((m) => m && m.companyId).filter(Boolean),
  );

  byCode = new Map();
  byToken = new Map();
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
    // Renewal tracking: every group starts Open.
    g.renewal = m.renewal || "open";
    // Archived, or not on a program carrier: the row stays for staff, but the
    // code is refused at sign-in.
    if (!g.archived && g.eligible) {
      byCode.set(code.toUpperCase(), g);
      byCode.set(legacyCodeFor(g.name).toUpperCase(), g);
      if (g.linkToken) byToken.set(g.linkToken, g);
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
    /** The proposal slots this group has: Cobalt only where it is quoted. */
    slots: slotsForGroup(g.name),
    renewal: g.renewal,
    proposals: proposalCounts[g.name] || 0,
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

const splitFor = (name) =>
  (imported.splits || {})[name] || data.splits[name] || null;

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "hunter@kennion.com").trim().toLowerCase();
const ADMIN_CODE = String(process.env.ADMIN_CODE || "87878787").trim();
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
app.use(compression());
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

/** What a staff session sees: the PII-free rate projection and its bookkeeping. */
/**
 * The audit runs itself: after every upload and at boot, the computed result
 * is refreshed, and once all three files are in Claude reads it — once per
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
    durable: !!db || DURABLE,
    storage: db ? "postgres" : DURABLE ? "volume" : "ephemeral",
    overrides,
    imports: recentImports,
    meta: data.meta,
    groups: adminGroups,
    planDesigns: data.planDesigns,
  };
}

app.post("/api/signin", (req, res) => {
  const body = req.body || {};

  // Staff sign-in: email + code. One generic failure for either field, so a
  // wrong guess reveals nothing about which half was right.
  if (body.email != null) {
    const email = String(body.email).trim().toLowerCase();
    const code = String(body.code || "").trim();
    if (email !== ADMIN_EMAIL || code !== ADMIN_CODE) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    return res.json({ ...adminPayload(), token: mintSession(email) });
  }

  // A group's permanent link carries a token instead of a code.
  const token = String(body.token || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!token && !code) return res.status(400).json({ error: "code required" });

  const g = token ? byToken.get(token) : byCode.get(code);
  if (!g) return res.status(404).json({ error: "no such group" });

  return res.json({
    kind: "group",
    meta: data.meta,
    group: g,
    planDesigns: data.planDesigns,
    // Carrier menu and quoted rates: no personal data, and the 2027 pricing
    // needs the reference rows to scale un-quoted plans.
    uhc: data.uhc,
    // Only this group's contribution split, when Employee Navigator has one.
    splits: splitFor(g.name) ? { [g.name]: splitFor(g.name) } : {},
    overrides: overridesFor(g.name),
    // The carrier proposals on file for this group — plans and tier rates as
    // read off the documents — and this month's billing, counts and rates only.
    proposals: currentProposals[g.name] || [],
    slots: slotsForGroup(g.name),
    funding: fundingSnapshot(g.name),
    linkToken: g.linkToken || null,
  });
});

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
 * Re-enter a staff session the browser still holds a token for — a reload, or
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
 * Employee Navigator's Carrier Stats report — the second file, uploaded with
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
    let parsed;
    try {
      parsed = parseCarrierStats(req.body, filename);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const rec = { ...parsed, filename, uploadedBy: req.staffEmail || null };
    try {
      carrierStats = db
        ? await db.saveCarrierStats(rec)
        : { filename, reportDate: parsed.reportDate, rows: parsed.rows, total: parsed.total, uploadedAt: new Date().toISOString(), uploadedBy: rec.uploadedBy };
    } catch (e) {
      return res.status(500).json({ error: "Could not save the report: " + e.message });
    }
    await refreshAudit();
    res.json({ ok: true, stats: carrierStats, audit });
  },
);

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
 * The month's funding workbook from Employee Navigator. Every invoice is filed
 * under the group most of its billed people belong to (their names against
 * the groups' members), summarised per group, and kept — names and all — on
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
 * carry are skipped — a billed plan the census has never seen is a question,
 * not a rate — and so is a rate known only from a prorated line.
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

/** Re-run the billed-rate write for one group or all — after a hand filing, say. */
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
 * as one small file — aggregates only, no member records — so it can be
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
 * A census row for a company a full export no longer carries — or carries
 * with nothing current — is a company that has left: archive it, once, and
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
    const { companies, failures } = await readUpload(req);
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

      imported.groups[key] = g;
      if (parsed.split) imported.splits[key] = parsed.split;
      if (db) await db.saveGroup(g, parsed.split, req.staffEmail || null);
      applied.push({ name: key, enrolled: g.enrolled, monthly: g.monthly });
    }
    if (!applied.length) return res.status(400).json({ error: "Nothing selected to import." });
    saveImports();

    const diagnostics = rollupDiagnostics(companies);
    // Company records the parser could not use are part of the record too —
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
  if (!group || !(["companyId", "sizeCategory", "broker", "renewal", "archived", "manager"].includes(field) || isCompanyField)) {
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
app.post("/api/admin/override", requireStaff, express.json({ limit: "16kb" }), async (req, res) => {
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
 * otherwise — the screen says which) and then read by Claude in the
 * background: carrier, the group named on the paper, plans and tier rates, and
 * the roster group it matches with a confidence. A confident match is assigned
 * outright; a weaker one is suggested for review; no match leaves the proposal
 * in the queue for staff to assign by hand. Any assignment can be changed.
 */
const memProposals = [];
let memNextId = 1;
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
        for (let j = memProposals.length - 1; j >= 0; j--) {
          if (memProposals[j].id === id || memProposals[j].parent_id === id) memProposals.splice(j, 1);
        }
        return true;
      },
    };

/**
 * The medical proposals a group can hold, one per slot, and nothing else. A
 * newer one in a slot replaces the older, which is kept. Surest is a
 * UnitedHealthcare product, so a Surest quote is that group's UHC proposal;
 * an ancillary-only document (dental, vision, life) fills no slot at all.
 */
const SLOTS = ["UHC Fully Insured", "UHC Level Funded", "Gravie", "Nationwide", "Angle", "Cobalt"];
function slotFor(carrier, funding, quotesMedical) {
  if (quotesMedical === false) return null;
  const c = String(carrier || "").toLowerCase();
  const f = String(funding || "").toLowerCase();
  if (/united|uhc|surest|optum/.test(c)) {
    if (/level/.test(f)) return "UHC Level Funded";
    if (/fully/.test(f)) return "UHC Fully Insured";
    return null; // UnitedHealthcare, funding unclear — leave for staff to say
  }
  if (/gravie/.test(c)) return "Gravie";
  if (/nationwide/.test(c)) return "Nationwide";
  if (/angle/.test(c)) return "Angle";
  if (/cobalt/.test(c)) return "Cobalt";
  return null; // not a tracked carrier: kept on file, but it fills no slot
}

/**
 * Whether a proposal quotes no medical at all — dental, vision, life,
 * disability. Claude says so directly on anything read since the field was
 * added; for an older reading the document itself is the evidence: a file or
 * summary that calls itself ancillary, or one that names only ancillary
 * products and quoted no plan with a rate.
 */
function isAncillaryRow(row) {
  const x = row.extracted || {};
  if (typeof x.quotes_medical === "boolean") return !x.quotes_medical;
  if (!row.extracted) return false;
  const text = `${row.filename || ""} ${row.summary || ""} ${x.proposal_type || ""}`;
  if (/\bancillar(y|ies)\b/i.test(text)) return true;
  const rated = (x.plans || []).some((pl) => Object.values(pl.rates || {}).some((v) => v != null));
  return !rated && /\b(dental|vision|life|ad&d|disability|std|ltd|accident|critical illness|hospital indemnity)\b/i.test(text);
}

/**
 * After any change: recount proposals per group for the Groups page, and
 * settle supersession — within a group and slot, the newest assigned proposal
 * is current and older ones are marked as replaced by it. Nothing is deleted.
 */
async function proposalsChanged() {
  try {
    let rows = await proposalStore.listProposals();
    // A slot that is no longer one of the four — a Surest or "Other" filed
    // before the list was cut back — is re-derived from what was read.
    let remapped = false;
    for (const r of rows) {
      // An ancillary proposal fills no slot, whichever slot an older reading
      // gave it: the four are group health.
      if (r.slot && isAncillaryRow(r)) {
        await proposalStore.updateProposal(r.id, { slot: null });
        remapped = true;
        continue;
      }
      if (!r.slot || SLOTS.includes(r.slot)) continue;
      const x = r.extracted || {};
      const slot = slotFor(r.carrier || x.carrier, x.funding, x.quotes_medical);
      await proposalStore.updateProposal(r.id, { slot });
      remapped = true;
    }
    if (remapped) rows = await proposalStore.listProposals();
    const counts = {};
    const bySlot = new Map();
    rows.forEach((r) => {
      if (r.status === "container" || !r.group_name) return;
      counts[r.group_name] = (counts[r.group_name] || 0) + 1;
      if (r.status !== "assigned" || !r.slot) return;
      const k = `${r.group_name}||${r.slot}`;
      bySlot.set(k, [...(bySlot.get(k) || []), r]);
    });
    const want = new Map(); // id -> superseded_by it should have
    rows.forEach((r) => want.set(r.id, null));
    for (const list of bySlot.values()) {
      list.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at) || b.id - a.id);
      const current = list[0];
      list.slice(1).forEach((r) => want.set(r.id, current.id));
    }
    for (const r of rows) {
      const should = want.get(r.id);
      if ((r.superseded_by || null) !== should) await proposalStore.updateProposal(r.id, { superseded_by: should });
    }
    const current = {};
    for (const list of bySlot.values()) {
      const r = list[0];
      const x = r.extracted || {};
      (current[r.group_name] = current[r.group_name] || []).push({
        id: r.id,
        slot: r.slot,
        carrier: r.carrier || x.carrier || null,
        funding: x.funding || null,
        effectiveDate: x.effective_date || null,
        proposalType: x.proposal_type || null,
        enrolledOnDocument: x.enrolled_on_document ?? null,
        plans: Array.isArray(x.plans)
          ? x.plans.map((pl) => ({
              name: pl.name,
              planCode: pl.plan_code || null,
              network: pl.network || null,
              planType: pl.plan_type || null,
              deductible: pl.deductible || null,
              oopMax: pl.oop_max || null,
              rates: pl.rates || { EE: null, ES: null, EC: null, FAM: null },
              monthlyTotal: pl.monthly_total ?? null,
            }))
          : [],
        totalMonthly: x.total_monthly ?? null,
        summary: r.summary || null,
        filename: r.filename,
        uploadedAt: r.uploaded_at,
      });
    }
    currentProposals = current;
    proposalSlotsByGroup = Object.fromEntries(
      Object.entries(current).map(([g, list]) => [g, Object.fromEntries(list.filter((p) => p.slot === "Cobalt").map((p) => [p.slot, true]))]),
    );
    proposalCounts = counts;
    rebuild();
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
  const hay = normalizeName(
    [filename.replace(/\.[a-z0-9]+$/i, ""), context?.subject || "", context?.body || ""].join(" "),
  );
  const hits = liveRoster().filter((g) => {
    const n = normalizeName(g.name);
    return n.length >= 4 && hay.includes(n);
  });
  return hits.length === 1 ? hits[0].name : null;
}

/**
 * Read the file, match it, and write the outcome back. Runs in the background.
 * `file` is { filename, mime, buffer, context? } — context being the email it
 * came out of, if any.
 */
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
    const out = await analyzeProposal({ filename: file.filename, prepared, context: file.context || null }, roster);
    const flags = Array.isArray(out.audit_flags) ? [...out.audit_flags] : [];
    const matched = roster.find((g) => g.name === out.matched_group) || null;
    const conf = Math.max(0, Math.min(1, Number(out.confidence) || 0));

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

    const fields = {
      carrier: out.carrier || null,
      extracted: { ...out, audit_flags: flags },
      summary: out.summary || null,
      confidence: conf,
      error: null,
    };
    // The slot comes from what was read, unless staff already set one.
    if (!current || !current.slot) fields.slot = slotFor(out.carrier, out.funding, out.quotes_medical);
    if (keepAssignment) {
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
    await proposalStore.updateProposal(id, fields);
  } catch (e) {
    console.error(`proposal ${id} analysis failed:`, e.message);
    await proposalStore.updateProposal(id, {
      status: keepAssignment ? "assigned" : "unassigned",
      error: e.message,
    });
  }
  await proposalsChanged();
}

/**
 * Upload one file — a proposal, or an email carrying proposals. Raw body;
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
        const row = await proposalStore.addProposal({
          ...base,
          filename: item.filename,
          mime: item.mime,
          size: item.buffer.length,
          data: item.buffer,
          kind: item.kind,
          parent_id: parent ? parent.id : null,
          context: item.context || null,
          status: "analyzing",
        });
        created.push(row);
        // Read it after replying; the screen polls until it is done.
        void runAnalysis(row.id, { buffer: item.buffer, mime: item.mime, filename: item.filename, context: item.context || null }, !!group);
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

app.get("/api/admin/proposals", requireStaff, async (req, res) => {
  try {
    let rows = await proposalStore.listProposals();
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

/** Assign, reassign, confirm, or relabel a proposal. */
/**
 * Re-read every proposal whose extraction predates the current questions —
 * anything with no `quotes_medical` on it. One click after a schema change,
 * rather than pressing Re-read on each row. `all=1` re-reads everything.
 */
app.post("/api/admin/proposals/reanalyze", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  if (!aiEnabled()) return res.status(400).json({ error: "AI reading is off, so there is nothing to re-read with." });
  const all = !!(req.body || {}).all;
  const rows = await proposalStore.listProposals();
  const want = rows.filter(
    (r) => r.status !== "container" && (all || !r.extracted || typeof r.extracted.quotes_medical !== "boolean"),
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
  const { group, carrier, confirm, slot } = req.body || {};
  const fields = {};
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

/** Read the document again — after the roster changed, or a key was added. */
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
app.use(express.static(publicDir, { index: false, maxAge: "1h" }));

// SPA fallback — the portal owns every non-API route.
app.use((_req, res) => res.sendFile(indexHtml));

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
      console.log(`postgres connected — ${st.groups} imported groups, ${st.overrides} rate overrides`);
    } catch (e) {
      // A database that is configured but unreachable must not take the site
      // down; fall back to the shipped census and say so loudly.
      console.error("postgres unavailable, serving the shipped census only:", e.message);
    }
  }
  rebuild();
  // An import that covered the roster before this rule existed still says
  // who has left: every census-only group it did not touch.
  const last = recentImports[0];
  if (last && last.companies_applied >= groups.length / 2) {
    await archiveLeavers(new Set(Object.keys(imported.groups || {})));
    rebuild();
  }
  await proposalsChanged();
  await refreshAudit();
}

await boot();

app.listen(port, "0.0.0.0", () => {
  const n = Object.keys(imported.groups || {}).length;
  const store = db ? "postgres" : DURABLE ? "volume" : "ephemeral disk";
  console.log(
    `Kennion renewal portal listening on :${port} — ${groups.length} groups, ` +
      `${n} imported, storage: ${store}`,
  );
});

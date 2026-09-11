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
import { PassThrough } from "node:stream";
import { newSecret, verifyTotp, otpauthUrl, newRecoveryCodes, hashCode, spendRecovery } from "./totp.js";
import { parseEnStream, premiumBreakdown, classifyPlans, newDiagnostics, mergeDiagnostics } from "./en-parse.js";
import { createDb } from "./db.js";
import { assignCodes, sizeFor, normalizeName } from "./group-id.js";
import { groupSlug } from "./slug.js";
import { eligibilityOf } from "./eligibility.js";
import { aiEnabled, analyzeProposal, explainReconciliation, explainAudit } from "./ai.js";
import { expandUpload, prepareForModel } from "./intake.js";
import JSZip from "jszip";
import { parseInvoicePdf, groupFromInvoiceFilename, matchInvoiceName } from "./invoice-parse.js";
import { parseGravieWorkbook, gravieExtracted, gravieQuoteRows } from "./gravie-parse.js";
import { medicalFromDocument, isAncillaryRow } from "./proposal-kind.js";
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
 * The account manager a client may see: name, direct line, email and booking
 * link, and nothing else. A group with no manager on the list falls back to the
 * office, so the card on a client's page is never empty.
 */
function managerContact(key) {
  const c = (MANAGER_LIST.contacts || {})[key];
  return c ? { ...c } : { ...(MANAGER_LIST.fallback || {}) };
}
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
/** Address slug (company + code) -> group, for the short /<slug>/<tab> address. */
let bySlug = new Map();
let adminGroups = [];
/** Proposals filed under each group, so the Groups page can show coverage. */
let proposalCounts = {};
/** The newest client invoice filed under each group — month, when, whether it tied out. */
let invoiceByGroup = {};
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
    /** The proposal slots this group has: Cobalt only where it is quoted. */
    slots: slotsForGroup(g.name),
    renewal: g.renewal,
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
 * The employer/employee split, built fresh from each member's own cost —
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
    source: "Employee Navigator XML import — employer/employee cost as configured in payroll, averaged across everyone on a plan and tier",
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

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "hunter@kennion.com").trim().toLowerCase();

/**
 * Staff sign-in code. This repository is public, so a code written in it is
 * not a secret: any value that has ever been published here is refused.
 *
 * The code is kept in the database as a scrypt hash, not in an environment
 * variable, for two reasons: it survives a restart without anyone having to
 * configure the host, and it can be changed from inside the app. The first
 * time a database has no code, one strong code is minted and printed once in
 * the log — after that it stays put until it is changed from the Import tab.
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
  const kept = db ? "It is kept, so it survives every restart from now on." : "This run only — there is no database to keep it in.";
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
 * referrer is kept off outbound requests entirely — otherwise a click on any
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
 * memory — one server, and a restart only ever forgives.
 */
/**
 * A group's session is a cookie, so its address can be short — the company
 * and its code, `/johnson-storage-moving-jsmh2027/options` — with no token in
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
 * code, or — with neither — the session cookie. Only a token or a code is a
 * guess worth counting against the caller.
 */
function groupFromRequest(req) {
  const body = req.body || {};
  const token = String(body.token || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (token) return { g: byToken.get(token) || null, guessed: true };
  if (code) return { g: byCode.get(code) || null, guessed: true };
  return { g: groupFromCookie(req), guessed: false };
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
    // The carrier proposals on file for this group — plans and tier rates as
    // read off the documents — and this month's billing, counts and rates only.
    proposals: clientProposals(g.name),
    slots: slotsForGroup(g.name),
    funding: fundingSnapshot(g.name),
    // This month's invoice, if one is filed: enough to offer the link, not the file.
    invoice: invoice
      ? {
          month: (invoice.context && invoice.context.month) || null,
          filename: invoice.filename,
          uploadedAt: invoice.uploaded_at,
          // The Charge Summary's product rows — product, tier and headcount, no
          // names — so the client's page can say what else is in force.
          products: Array.isArray(invoice.extracted && invoice.extracted.products)
            ? invoice.extracted.products.map((r) => ({ product: r.product, coverage: r.coverage, count: r.count ?? null }))
            : [],
        }
      : null,
    linkToken: g.linkToken || null,
    slug: g.slug,
    // Who to call. The manager key itself is Kennion's bookkeeping; only the
    // contact details travel to the client.
    accountManager: managerContact(g.manager),
    // The group's most recent submission, if it has ever sent one, so the
    // Sign Up page can say so instead of showing a blank form again.
    signup: signup ? { plans: signup.plans, note: signup.note, submittedAt: signup.submitted_at } : null,
  });
});

/**
 * A group's own invoice, the PDF itself, opened in a new tab from Your 2026
 * Medical Plans. The session cookie is the only credential accepted, so the
 * address carries nothing secret and can be a plain link.
 */
app.get("/api/group/invoice", async (req, res) => {
  const g = groupFromCookie(req);
  if (!g) return res.status(401).json({ error: "no session" });
  const inv = await latestInvoiceFor(g.name).catch(() => null);
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
 * any note, submitted back to Kennion. No staff token — the same code or
 * token that gets a group its data is what lets it submit, same as sign-in —
 * so it shares that endpoint's rate limit against guessing.
 *
 * Submitting also moves a group's renewal from Open to Sent, the one status
 * change a client rather than staff can make, and only that one step: a
 * group already marked Renewed or Non-renewed is not moved backwards by a
 * second submission.
 */
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

  console.log(`sign-up received: ${g.name} — ${plans.length} plan(s)`);
  res.json({ ok: true, submittedAt: record.submitted_at });
});

/**
 * What a signed-in group is allowed to see of itself: everything but the
 * census. The per-plan tier counts the pages price from are computed here, so
 * no employee record — name, age, ZIP, dependants — ever leaves the server.
 */
/**
 * The only fields an employer's own pages read. An allow-list, not a
 * deny-list: a field added to a group later is not shipped to a client until
 * someone puts it here on purpose. Kennion's own bookkeeping — who brokers the
 * group, which manager holds it, where its renewal stands, its SIC and
 * division codes — stays on the admin side.
 */
const CLIENT_GROUP_FIELDS = [
  "name",
  "code",
  "linkToken",
  "tpa",
  "enrolled",
  "medicalEligible",
  "lives",
  "tiers",
  "planTiers",
  "monthly",
  "annual",
  "plans",
  "rates",
  "pyStart",
  "pyEnd",
  // Dental, vision, life, disability … — the same shape the Groups page
  // shows staff, with no member detail: benefit, carrier, plan, enrolled,
  // monthly. Present only once an Employee Navigator export has been read
  // for supplemental lines; `linesLoaded` below says whether it has.
  "lines",
];

/**
 * Active (non-terminated) headcount from a group's stored import
 * diagnostics — the same figure `medicalEligible` is meant to be, but read
 * fresh off data already on the group rather than whatever value was
 * computed at import time. That matters because the definition changed
 * after some groups were imported: their stored `medicalEligible` is
 * stale, but the raw counts it should have been built from are already
 * sitting in `diagnostics` from that same import, so there is no need to
 * re-upload anything to correct it.
 */
function activeEmployeeCount(diagnostics) {
  const employees = diagnostics && diagnostics.employees;
  if (!employees || typeof employees.total !== "number") return null;
  const skipped = Object.values(employees.skipped || {}).reduce((n, x) => n + x, 0);
  return employees.total - skipped;
}

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
  const active = activeEmployeeCount(g.diagnostics);
  if (active != null) out.medicalEligible = active;
  // Whether supplemental has ever been read for this group, and what it
  // comes to — the same figures the Groups page shows staff.
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
 * `refEE` is the one cross-group number the pricing needs — an average EE rate
 * used to scale a group UHC has not underwritten — reduced to a scalar so no
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
    // coinsurance — UHC codes them E… and P…), and a group's quoted rate on
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

/** A group's current proposals as a client sees them: PPO only when the rule says so. */
function clientProposals(name) {
  const list = currentProposals[name] || [];
  if (!ppoOnly()) return list;
  return list.map((p) => ({ ...p, plans: (p.plans || []).filter((pl) => !isEpoPlan(pl)) }));
}

/** The newest client invoice filed under a group, without its bytes; null if none. */
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
 * Same as `readUpload`, but also keeps the file — gzip-compressed, so a
 * ~100MB export lands in the database at a fraction of its size — for the
 * import this actually applies. XML compresses well, and it's streamed
 * through the compressor alongside parsing rather than buffered whole, so
 * this carries none of the memory cost the streaming parser was built to
 * avoid. Once this is in the database, no import ever needs the original
 * file handed back to it again — the source Postgres already trusts, not a
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

      // Every count that went into medicalEligible — and everything else the
      // parser tallied but had no field for — kept on the group itself, not
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
    return res.status(400).json({ error: "That code is not right — check the app and try again." });
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
 * What a client is shown of the market. One rule today: **PPO only** — an
 * EPO twin of a PPO plan (UnitedHealthcare's E-coded menu plans, Gravie's
 * "EPO" sheet) is priced a few dollars under it and adds a choice without
 * adding a decision, so it is kept out of every client page. The rule is a
 * portal-wide setting, kept in kennion.settings under marketRules, and the
 * stored quotes keep every plan; this only decides what is served.
 */
const DEFAULT_MARKET_RULES = { networks: "ppo-only" };
let marketRules = { ...DEFAULT_MARKET_RULES };
async function loadMarketRules() {
  if (!db) return;
  try {
    const stored = await db.getSetting("marketRules");
    if (stored && typeof stored === "object") marketRules = { ...DEFAULT_MARKET_RULES, ...stored };
    else await db.setSetting("marketRules", marketRules, "system");
  } catch (e) {
    console.error("could not read the market rules:", e.message);
  }
}
const ppoOnly = () => marketRules.networks === "ppo-only";
/** A proposal plan that is an EPO: says so in its network, its type, or its name. */
const isEpoPlan = (pl) =>
  /\bEPO\b/i.test(`${pl.network || ""} ${pl.plan_type || pl.planType || ""} ${pl.name || ""}`);
/** A UnitedHealthcare menu plan that is an EPO. */
const isEpoMenu = (m) => String(m.type || "").toUpperCase() === "EPO";

app.get("/api/admin/market-rules", requireStaff, (req, res) => {
  res.json(marketRules);
});

app.post("/api/admin/market-rules", requireStaff, express.json({ limit: "4kb" }), async (req, res) => {
  const networks = String((req.body || {}).networks || "");
  if (!["ppo-only", "all"].includes(networks)) return res.status(400).json({ error: "networks must be ppo-only or all" });
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
          "No rate sheet in that file. It needs Group and Plan columns and at least one tier column — send back the workbook this page produced.",
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
            error: r.error || null,
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
              benefits: planBenefits(pl.benefits),
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
    invoiceByGroup = invoices;
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
/** The six benefit rows a plan card shows, as the reader found them; null where the reader predates them. */
function planBenefits(b) {
  if (!b || typeof b !== "object") return null;
  const str = (v) => (v == null || v === "" ? null : String(v).slice(0, 120));
  return { doctorVisit: str(b.doctor_visit), specialist: str(b.specialist), imaging: str(b.imaging), urgentCare: str(b.urgent_care), hospital: str(b.hospital), rx: str(b.rx) };
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
async function resumeOrphanedReads() {
  const rows = await proposalStore.listProposals();
  const stuck = rows.filter((r) => r.status === "analyzing");
  if (!stuck.length) return;
  console.log(`proposals: resuming ${stuck.length} read(s) interrupted by the last restart`);
  for (const r of stuck) {
    const f = await proposalStore.getProposalFile(r.id).catch(() => null);
    if (!f) {
      await proposalStore.updateProposal(r.id, { status: r.group_name ? "assigned" : "unassigned", error: "The file could not be read back after a restart." });
      continue;
    }
    await runAnalysis(r.id, { buffer: f.data, mime: f.mime, filename: f.filename, context: r.context || null }, !!r.group_name);
  }
  await proposalsChanged();
}

async function backfillPlanBenefits() {
  if (!aiEnabled()) return;
  await resumeOrphanedReads();
  const rows = await proposalStore.listProposals();
  const want = rows.filter((r) => r.status !== "container" && r.slot !== "Gravie" && r.kind !== "invoice" && lacksBenefits(r));
  if (!want.length) return;
  console.log(`proposals: re-reading ${want.length} proposal(s) for per-plan benefits`);
  for (const r of want) {
    const f = await proposalStore.getProposalFile(r.id).catch(() => null);
    if (!f) continue;
    // A re-read for benefits never moves a proposal off its group.
    const keep = !!r.group_name;
    await proposalStore.updateProposal(r.id, { status: "analyzing", error: null });
    await runAnalysis(r.id, { buffer: f.data, mime: f.mime, filename: f.filename, context: r.context || null }, keep);
  }
  await proposalsChanged();
  console.log(`proposals: benefits re-read done for ${want.length} proposal(s)`);
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
    await proposalStore.updateProposal(id, fields);
  } catch (e) {
    console.error(`proposal ${id} analysis failed:`, e.message);
    // A failed read leaves a proposal where it was filed; only one that was
    // never filed stays unassigned.
    const prev = (await proposalStore.listProposals().catch(() => [])).find((r) => r.id === id);
    await proposalStore.updateProposal(id, {
      status: keepAssignment || (prev && prev.group_name) ? "assigned" : "unassigned",
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

/**
 * A month's client invoices, all at once: a zip with one PDF per group,
 * named "<Group Name> <Month> Invoice.pdf" (Employee Navigator's own naming).
 * Stored the same way a single proposal file is — group, filename, bytes,
 * kind "invoice" — but never queued for AI analysis: an invoice isn't a
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
 * Carrier quotes as rows — kennion.carrier_quotes and carrier_quote_plans —
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
      network: "Cigna Open Access Plus",
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
      const stale = plans.some((pl) => /LocalPlus|Narrow/i.test(pl.network || "")) || !plans.length;
      const quote = have.get(r.group_name);
      const wanted = quote && quote.proposalId === r.id && quote.planCount === plans.length && !stale;
      if (!stale && wanted) continue;
      const f = await proposalStore.getProposalFile(r.id);
      if (!f) continue;
      const parsed = parseGravieWorkbook(f.data);
      if (stale) {
        const extracted = { ...gravieExtracted(parsed), matched_group: r.group_name };
        await proposalStore.updateProposal(r.id, { extracted, summary: extracted.summary });
        reread++;
      }
      await storeGravieQuote({ name: r.group_name }, parsed, r.filename, r.id, r.uploaded_by);
      written++;
    } catch (e) {
      console.error(`gravie: could not settle ${r.filename}:`, e.message);
    }
  }
  const total = (await quoteStore.listCarrierQuotes("Gravie")).length;
  if (reread || written) console.log(`gravie: re-read ${reread} workbook(s), wrote ${written} quote(s); ${total} Gravie quote(s) stored as rows`);
  if (reread) await proposalsChanged();
  return { reread, written, total };
}

/**
 * A zip of Gravie rate workbooks, one per group: each is parsed, matched to
 * its group by the name in the sheet header, and filed as that group's Gravie
 * proposal — assigned, in the Gravie slot, with every priced plan in the
 * extracted shape the Options page reads — so the quote prices on the client's
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
    const extracted = { ...gravieExtracted(parsed), matched_group: g.name };
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
    await proposalStore.updateProposal(row.id, {
      extracted,
      summary: extracted.summary,
      confidence: 1,
      slot: "Gravie",
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

// An API path no route claimed is a mistake, not a page. Falling through to
// the app answered a mistyped endpoint with 200 and a lump of HTML, so the
// caller got a JSON parse error instead of being told what was wrong.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} /api${req.path}` });
});

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
      console.log(`postgres connected — ${st.groups} imported groups, ${st.overrides} rate overrides, ${st.quotes} carrier quotes`);
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
  await loadGroupCookieSecret();
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
  // Gravie workbooks already on file, re-read with the current parser and
  // written as rows where they are not yet. Logged, never fatal.
  try {
    await settleGravieQuotes();
  } catch (e) {
    console.error("gravie:", e.message);
  }
  // Proposals read before the reader asked for per-plan benefits, re-read in
  // the background so the plan cards fill in. Never blocks boot.
  void backfillPlanBenefits().catch((e) => console.error("proposals: benefits re-read:", e.message));
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

await boot();

app.listen(port, "0.0.0.0", () => {
  const n = Object.keys(imported.groups || {}).length;
  const store = db ? "postgres" : DURABLE ? "volume" : "ephemeral disk";
  console.log(
    `Kennion renewal portal listening on :${port} — ${groups.length} groups, ` +
      `${n} imported, storage: ${store}`,
  );
});

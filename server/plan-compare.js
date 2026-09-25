// Field-by-field comparison of a stored plan against what an auditor read off
// the carrier's document - done in code, so a wrong deductible, copay or rate
// is a finding whether or not the auditor thought to mention it.
//
// Normalization here is for COMPARISON ONLY. Nothing in this module rewrites
// a stored value: the canonical record keeps the carrier's exact printed name
// and wording, and these functions only decide whether two renderings of the
// same figure agree ("$1,500" and "1500", "25 %" and "25%", "No charge" and
// "$0", an en dash and a hyphen).
//
// Pure code: no model call, deterministic.

import { TIERS, normCode } from "./plan-canonical.js";

/**
 * The audit standard: bumped when what an audit checks grows. An audit of an
 * older standard is treated like an audit of an older reading - pending a
 * fresh one - so every Verified box has been checked field by field.
 * 1: four tier rates per plan, compared in code.
 * 2: identity, network, deductible, out-of-pocket max, coinsurance, every
 *    client-facing benefit and HSA eligibility too, all compared in code.
 */
export const AUDIT_STANDARD = 2;

/**
 * The comparison rules' own version: bumped when a rule below changes how two
 * renderings are judged (not what is checked). An audit composed under an
 * older version is composed again from its saved answers - no model call -
 * so a rule fix reaches every box at once.
 * 1: figures in order; words exactly.
 * 2: rx ignores the mail-order part (the reading rule says leave it out);
 *    word-only values compare their distinct cost-sharing terms with
 *    inpatient / outpatient labels aside ("D&C" = "OP D&C, IP D&C"); network
 *    "+" is "plus" (so "Choice +" = "Choice Plus", never "Choice") and the
 *    carriers' abbreviations INS / NATL read as words.
 * 3: word-only parts drop their service labels ("Lab/X-Ray Ded+Coins" and
 *    "D&C (X-ray & Lab)" are "D&C"; "Ded+Coins" is "D&C"); a Gravie rate
 *    workbook read by the parser is compared on what its rate rows state -
 *    the static Benefits Grid is supplemental, never the plan's own record.
 * 4: parts each labelled with their service may be listed in either order
 *    ("$500 (MRI/CT); $40 (Lab/X-Ray)" = "$40 (Lab/X-Ray) / $500 (MRI, CT
 *    Scan)"): each part is matched to one with the same figures and a
 *    service word in common, so a figure moved to another service is caught.
 *    Prescription tiers stay in tier order.
 */
export const COMPARE_VERSION = 4;

/** The benefit fields BenSync stores (plan.benefits), in the order they are shown. */
export const BENEFIT_FIELDS = ["doctor_visit", "specialist", "imaging", "urgent_care", "emergency_room", "hospital", "rx", "coinsurance", "hsa_eligible"];

/** Every field an auditor returns for a plan and code compares. */
export const AUDITED_FIELDS = ["name", "plan_code", "network", "deductible", "oop_max", ...BENEFIT_FIELDS, ...TIERS];

const blank = (v) => v == null || String(v).trim() === "" || /^(n\/?a|not applicable|not stated|-+)$/i.test(String(v).trim());

// Built from code points so this file holds no dash or curly-quote
// characters itself (scripts/test-no-em-dash.mjs).
const range = (a, b) => String.fromCharCode(...Array.from({ length: b - a + 1 }, (_, i) => a + i));
const DASHES = new RegExp(`[${range(0x2010, 0x2015)}${String.fromCharCode(0x2212)}]`, "g");
const SINGLE_QUOTES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019)}]`, "g");
const DOUBLE_QUOTES = new RegExp(`[${String.fromCharCode(0x201c, 0x201d)}]`, "g");

/** Unicode dashes, quotes and spacing folded; case folded. */
const fold = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** A plan name as printed, for comparison: whitespace, dashes and case folded - nothing else. */
export const nameForCompare = (s) => fold(s);

/**
 * The figures a benefit value states, in order: "$1,500" -> ["1500"],
 * "20% after deductible" -> ["20%"], "$10 / $40 / $80" -> ["10","40","80"],
 * "No charge" -> ["0"], "Not covered" -> ["NC"]. Tier labels and day-supply
 * counts are not figures ("Tier 1: $10", "30-day supply").
 */
export function figures(v) {
  let s = fold(v);
  s = s.replace(/(?<![a-z])(no charge|no cost|nothing|free|none|covered in full|paid in full|covered at 100%|100% covered|plan pays 100%)(?![a-z])/g, " $0 ");
  s = s.replace(/(?<![a-z])not covered(?![a-z])/g, " NC ");
  s = s.replace(/\btier\s*\d+\b/g, " ").replace(/\b\d+\s*-?\s*days?\b/g, " ");
  const out = [];
  const re = /NC|(\d[\d,]*(?:\.\d+)?)\s*(%)?/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0] === "NC") {
      out.push("NC");
      continue;
    }
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(`${Number(n.toFixed(2))}${m[2] ? "%" : ""}`);
  }
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The retail part of a prescription value: the reading rule is "the retail
 * cost by tier, in tier order; leave mail order out", so a mail-order
 * multiplier or clause ("2.5 MO", "3x mail order", "Mail order: $25/$100")
 * is not one of its figures.
 */
export function retailRx(v) {
  return fold(v)
    .replace(/\d+(?:\.\d+)?\s*x?\s*(?:mo|mail[- ]?order)\b/g, " ")
    .replace(/mail[- ]?order\b[^;]*/g, " ");
}

/** Plain cost-sharing wording, one term per listed part: "D&C", "Deductible and coinsurance" -> "dc". */
const COST_TERMS = [
  [/\b(?:d\s*&\s*c|ded(?:uctible)?\s*(?:&|and|\/|\+)\s*coins(?:urance)?)\b/g, " dc "],
];
const SETTING_LABEL = /^(?:ip|op|inpatient|outpatient|in-patient|out-patient|facility|professional)\b\s*:?\s*/;
const wordTerms = (v) => {
  let s = fold(v);
  for (const [re, to] of COST_TERMS) s = s.replace(re, to);
  s = s.replace(/\([^)]*\)/g, " "); // a service label in brackets: "(X-ray & Lab)"
  // A part that states deductible-and-coinsurance is that, whatever service
  // label it carries ("Lab/X-Ray Ded+Coins"); any other part keeps its words.
  const term = (part) => (/(?:^|\s)dc(?:\s|$)/.test(part) ? "dc" : part.replace(SETTING_LABEL, "").replace(/[^a-z0-9]+/g, ""));
  return [...new Set(s.split(/[,;]/).map((part) => term(part.trim())).filter(Boolean))].sort();
};

const LABEL_FILLER = new Set(["scan", "scans", "and", "the", "services", "service", "per", "visit"]);
/** "$500 (MRI/CT); $40 (Lab/X-Ray)" -> [{ figs: ["500"], words: ["mri","ct"] }, ...]; null unless every part carries a label and a figure. */
function labelledParts(v) {
  const parts = fold(v)
    .split(/;|\s\/\s/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const out = [];
  for (const p of parts) {
    const labels = [...p.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(" ");
    const figs = figures(p.replace(/\([^)]*\)/g, " "));
    const words = labels.split(/[^a-z0-9]+/).filter((w) => w && !LABEL_FILLER.has(w));
    if (!words.length || !figs.length) return null;
    out.push({ figs, words });
  }
  return out;
}
function sameLabelledParts(a, b) {
  const pa = labelledParts(a);
  const pb = labelledParts(b);
  if (!pa || !pb || pa.length !== pb.length) return false;
  const used = new Set();
  return pa.every((x) => {
    const j = pb.findIndex((y, k) => !used.has(k) && sameList(x.figs, y.figs) && x.words.some((w) => y.words.includes(w)));
    if (j < 0) return false;
    used.add(j);
    return true;
  });
}

/**
 * Two benefit wordings agree when they state the same figures in the same
 * order, or - with no figures on either side - the same cost-sharing terms
 * (the setting labels a carrier prints per part aside). `field` "rx" compares
 * the retail part only.
 */
export function sameBenefit(a, b, field = null) {
  const pa = field === "rx" ? retailRx(a) : a;
  const pb = field === "rx" ? retailRx(b) : b;
  const fa = figures(pa);
  const fb = figures(pb);
  // Parts each labelled with their service on both sides: matched by service,
  // in any order (and a swapped figure is caught). Otherwise figures in order.
  if (field !== "rx" && labelledParts(pa) && labelledParts(pb)) return sameLabelledParts(pa, pb);
  if (fa.length || fb.length) return sameList(fa, fb);
  return sameList(wordTerms(pa), wordTerms(pb));
}

/**
 * Deductible / out-of-pocket max: the in-network individual figure must
 * agree, and the family figure too when both sides state one.
 */
export function sameAmount(a, b) {
  const fa = figures(a);
  const fb = figures(b);
  if (!fa.length || !fb.length) return fold(a).replace(/[^a-z0-9]+/g, "") === fold(b).replace(/[^a-z0-9]+/g, "");
  const n = Math.min(2, fa.length, fb.length);
  return sameList(fa.slice(0, n), fb.slice(0, n));
}

const yesNo = (v) => {
  const s = fold(v);
  if (/^(yes|y|true|eligible|hsa[- ]?(eligible|qualified|compatible)|qualified)\b/.test(s)) return "yes";
  if (/^(no|n|false|not)\b/.test(s)) return "no";
  return s;
};

const NETWORK_FILLER = new Set(["uhc", "unitedhealthcare", "united", "healthcare", "health", "care", "cigna", "network", "the", "in", "of"]);
const PLAN_TYPES = new Set(["ppo", "epo", "hmo", "pos"]);
const NETWORK_ABBREVIATIONS = { ins: "insurance", natl: "national", nat: "national" };
const networkWords = (v) =>
  fold(v)
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((w) => NETWORK_ABBREVIATIONS[w] || w)
    .join(" ")
    .split(" ")
    .filter((w) => w && !NETWORK_FILLER.has(w));

/**
 * Two network names agree when they are the same network apart from the
 * carrier's name and the word "network" ("Choice Plus" = "UHC Choice Plus
 * Network"). A plan-type suffix ("(PPO)") may be missing on one side, but
 * if both state one it must agree. "Choice" is never "Choice Plus".
 */
export function sameNetwork(a, b) {
  const wa = networkWords(a);
  const wb = networkWords(b);
  const ta = wa.filter((w) => PLAN_TYPES.has(w));
  const tb = wb.filter((w) => PLAN_TYPES.has(w));
  if (ta.length && tb.length && !sameList([...ta].sort(), [...tb].sort())) return false;
  const na = wa.filter((w) => !PLAN_TYPES.has(w));
  const nb = wb.filter((w) => !PLAN_TYPES.has(w));
  return sameList([...new Set(na)].sort(), [...new Set(nb)].sort());
}

const sameRate = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);

/**
 * Compare one stored plan with what an auditor read for it off the document
 * (`read`: { name, plan_code, network, deductible, oop_max, <benefit fields>,
 * EE, ES, EC, FAM }). Returns the fields that disagree, each with the stored
 * value and what the document prints. The rules:
 *  - name, plan code: exact as printed (spacing, dashes and case aside);
 *    no code on either side agrees.
 *  - rates: to the cent; null means the document does not price that tier.
 *  - deductible, out-of-pocket max: the individual figure (and family where
 *    both state it); one side blank and the other not is a disagreement.
 *  - network, benefits, coinsurance, HSA eligibility: compared when the
 *    document states them for the plan; a value the document states that the
 *    database lacks is a disagreement (the client would see a blank).
 */
export function comparePlan(stored, read, { benefitFields = BENEFIT_FIELDS } = {}) {
  const out = [];
  const diff = (field, st, doc) => out.push({ field, stored: st == null ? "" : String(st), onDocument: doc == null || String(doc) === "" ? "not stated" : String(doc) });
  if (nameForCompare(stored.name) !== nameForCompare(read.name)) diff("name", stored.name, read.name);
  if (normCode(stored.plan_code) !== normCode(read.plan_code)) diff("plan_code", stored.plan_code, read.plan_code);
  if (!blank(read.network) && !blank(stored.network) && !sameNetwork(stored.network, read.network)) diff("network", stored.network, read.network);
  for (const f of ["deductible", "oop_max"]) {
    const st = stored[f];
    const doc = read[f];
    if (blank(st) && blank(doc)) continue;
    if (blank(st) || blank(doc) || !sameAmount(st, doc)) diff(f, st, doc);
  }
  const benefits = stored.benefits || {};
  for (const f of benefitFields) {
    const doc = read[f];
    if (blank(doc)) continue;
    const st = benefits[f];
    const ok = f === "hsa_eligible" ? !blank(st) && yesNo(st) === yesNo(doc) : !blank(st) && sameBenefit(st, doc, f);
    if (!ok) diff(`benefit ${f}`, st, doc);
  }
  const rates = stored.rates || {};
  for (const t of TIERS) {
    const doc = read[t] ?? null;
    const st = rates[t] ?? null;
    if (!sameRate(doc, st)) out.push({ field: `rate ${t}`, stored: st == null ? "" : String(st), onDocument: doc == null ? "not priced" : String(doc) });
  }
  return out;
}

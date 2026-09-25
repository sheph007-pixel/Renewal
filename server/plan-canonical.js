// One unique carrier plan = one canonical BenSync plan record.
//
// A carrier proposal shows the same plan many times: an overview page, a
// comparison table, a detailed benefit page, a rate page, an appendix. Every
// one of those is an APPEARANCE of one plan. The reader returns appearances
// (with the pages each came from); this module folds them into canonical plan
// records by exact carrier identity and never by resemblance:
//
//   identity = the carrier's plan code, exactly (case and spacing aside), or
//              - only when no code is printed - the exact printed name on the
//              same network.
//
// An appearance with no code is attached to a coded plan only when exactly one
// coded plan carries that exact printed name (and network): otherwise it keeps
// its own identity. Two different codes are never the same plan; two similar
// names are never the same plan.
//
// Repeated appearances add evidence - their pages join the plan's provenance.
// They never add a plan. When two appearances of one plan disagree on a
// material value (a rate, the deductible, a copay...), nothing is chosen
// silently: the first value is kept and the disagreement is recorded on the
// plan (`conflicts`), which fails validation until the correction step has
// settled it against the source.
//
// EPO plans are identified here and moved to `excluded` with the reason, so
// the reconciliation can say "19 unique plans: 16 PPO, 3 EPO excluded".
//
// Pure code: no model call, deterministic, and the same answer every time.

export const TIERS = ["EE", "ES", "EC", "FAM"];
export const BENEFIT_KEYS = ["doctor_visit", "specialist", "imaging", "urgent_care", "emergency_room", "hospital", "rx", "coinsurance", "hsa_eligible"];
/** The values that make two appearances of one plan disagree, when both state them. */
const MATERIAL = ["name", "network", "deductible", "oop_max", ...TIERS, ...BENEFIT_KEYS];

/** The carrier's plan code, compared exactly apart from case and spacing. */
export const normCode = (c) => String(c || "").trim().replace(/\s+/g, " ").toUpperCase();
/** The printed name, exactly - whitespace collapsed, nothing else touched. */
export const exactName = (n) => String(n || "").replace(/\s+/g, " ").trim();
const normNet = (n) => String(n || "").replace(/\s+/g, " ").trim().toLowerCase();
const normVal = (v) => (v == null ? "" : typeof v === "number" ? v.toFixed(2) : String(v).replace(/\s+/g, " ").trim().toLowerCase());

export const isEpoPlan = (pl) => /\bEPO\b/i.test(`${pl.network || ""} ${pl.plan_type || pl.planType || ""} ${pl.name || ""}`);

/** A plan's identity key: its code when printed, else its exact name on its network. */
export function identityKey(pl) {
  const code = normCode(pl.plan_code);
  return code ? `code:${code}` : `name:${exactName(pl.name).toLowerCase()}|${normNet(pl.network)}`;
}

const valueOf = (pl, f) => (TIERS.includes(f) ? (pl.rates ? pl.rates[f] : null) : BENEFIT_KEYS.includes(f) ? (pl.benefits ? pl.benefits[f] : null) : pl[f]);
const isBlank = (v) => v == null || String(v).trim() === "";
const uniqSorted = (a) => [...new Set(a.filter((n) => Number.isInteger(n) && n > 0))].sort((x, y) => x - y);

/**
 * The pages one appearance came from, as ORIGINAL document page numbers.
 * The reader reports positions within the file it was given (an excerpt of
 * the relevant pages, or one part of a split); `pageMap[i]` is the original
 * page number of position i+1. Without a map, positions are original pages.
 */
function pagesOf(pl, pageMap) {
  const sp = pl.source_pages || {};
  const map = (arr) => (Array.isArray(arr) ? arr : []).map((p) => (pageMap && Number.isInteger(p) && p >= 1 && p <= pageMap.length ? pageMap[p - 1] : p));
  return { identity: map(sp.identity), benefits: map(sp.benefits), rates: map(sp.rates) };
}

/**
 * Fold appearances into canonical plans. `appearances`: the reader's plans,
 * each optionally carrying `source_pages {identity, benefits, rates}` (positions
 * in the file read), `source_sheet`, `source_rows`, and `_pageMap` (see
 * pagesOf) set by the caller for the part it came from. `reportedAppearances`
 * is the reader's own count of plan appearances in the document.
 * Returns { plans, excluded, reconciliation }.
 */
export function canonicalizePlans(appearances, { reportedAppearances = null, reportedUnique = null, reportedEpo = null } = {}) {
  const list = (Array.isArray(appearances) ? appearances : []).filter((pl) => pl && (exactName(pl.name) || normCode(pl.plan_code)));
  // Pass 1: every coded appearance sets up its plan.
  const byKey = new Map();
  const order = [];
  const add = (key, pl) => {
    const pages = pagesOf(pl, pl._pageMap);
    let c = byKey.get(key);
    if (!c) {
      c = {
        name: exactName(pl.name),
        plan_code: pl.plan_code ? String(pl.plan_code).trim() : null,
        network: pl.network || null,
        plan_type: pl.plan_type || null,
        deductible: pl.deductible || null,
        oop_max: pl.oop_max || null,
        benefits: { ...(pl.benefits || {}) },
        rates: { EE: null, ES: null, EC: null, FAM: null, ...(pl.rates || {}) },
        monthly_total: pl.monthly_total ?? null,
        ...(pl.option_id ? { option_id: pl.option_id } : {}),
        ...(Array.isArray(pl.unpriced) && pl.unpriced.length ? { unpriced: pl.unpriced } : {}),
        source: { identity: [], benefits: [], rates: [], sheet: "", rows: "", appearances: 0, codes: [] },
        conflicts: [],
      };
      byKey.set(key, c);
      order.push(key);
    } else {
      // A further appearance: fill what the plan does not have yet, and
      // record - never resolve - any material value it states differently.
      for (const f of MATERIAL) {
        const have = valueOf(c, f);
        const got = valueOf(pl, f);
        if (isBlank(got)) continue;
        if (isBlank(have)) {
          if (TIERS.includes(f)) c.rates[f] = got;
          else if (BENEFIT_KEYS.includes(f)) c.benefits[f] = got;
          else c[f] = f === "name" ? exactName(got) : got;
          continue;
        }
        if (normVal(have) === normVal(got)) continue;
        let k = c.conflicts.find((x) => x.field === f);
        if (!k) {
          k = { field: f, values: [{ value: have, pages: [...c.source.identity, ...c.source.benefits, ...c.source.rates] }] };
          c.conflicts.push(k);
        }
        if (!k.values.some((v) => normVal(v.value) === normVal(got))) k.values.push({ value: got, pages: [...pages.identity, ...pages.benefits, ...pages.rates] });
      }
      if (!c.plan_type && pl.plan_type) c.plan_type = pl.plan_type;
      if (c.monthly_total == null && pl.monthly_total != null) c.monthly_total = pl.monthly_total;
      if (!c.option_id && pl.option_id) c.option_id = pl.option_id;
    }
    c.source.identity.push(...pages.identity);
    c.source.benefits.push(...pages.benefits);
    c.source.rates.push(...pages.rates);
    if (pl.source_sheet && !c.source.sheet.split("; ").includes(String(pl.source_sheet))) c.source.sheet = [c.source.sheet, String(pl.source_sheet)].filter(Boolean).join("; ");
    if (pl.source_rows) c.source.rows = [c.source.rows, String(pl.source_rows)].filter(Boolean).join("; ");
    c.source.appearances++;
    if (normCode(pl.plan_code)) c.source.codes.push(normCode(pl.plan_code));
  };
  const uncoded = [];
  for (const pl of list) {
    if (normCode(pl.plan_code)) add(identityKey(pl), pl);
    else uncoded.push(pl);
  }
  // Pass 2: an appearance with no code joins a coded plan only when exactly
  // one coded plan carries that exact printed name on a compatible network.
  for (const pl of uncoded) {
    const name = exactName(pl.name).toLowerCase();
    const net = normNet(pl.network);
    const hits = order.filter((k) => {
      const c = byKey.get(k);
      return k.startsWith("code:") && c.name.toLowerCase() === name && (!net || !normNet(c.network) || normNet(c.network) === net);
    });
    add(hits.length === 1 ? hits[0] : identityKey(pl), pl);
  }
  const all = order.map((k) => {
    const c = byKey.get(k);
    c.source.identity = uniqSorted(c.source.identity);
    c.source.benefits = uniqSorted(c.source.benefits);
    c.source.rates = uniqSorted(c.source.rates);
    c.source.codes = [...new Set(c.source.codes)];
    if (!c.conflicts.length) delete c.conflicts;
    return c;
  });
  // An excluded plan keeps any BenSync number an older reading gave it, so the
  // numbering step can tell a slot was numbered under the old rule.
  const excluded = all.filter(isEpoPlan).map((c) => ({ name: c.name, plan_code: c.plan_code, network: c.network, source: c.source, reason: "EPO - Kennion offers PPO plans only", ...(c.option_id ? { option_id: c.option_id } : {}) }));
  const plans = all.filter((c) => !isEpoPlan(c));
  return {
    plans,
    excluded,
    reconciliation: {
      plan_appearances: Number.isInteger(reportedAppearances) ? reportedAppearances : list.length,
      appearances_read: list.length,
      unique_plans: all.length,
      unique_ppo: plans.length,
      unique_epo: excluded.length,
      excluded: excluded.length,
      expected: plans.length,
      reader_unique_plans: Number.isInteger(reportedUnique) ? reportedUnique : null,
      reader_unique_epo: Number.isInteger(reportedEpo) ? reportedEpo : null,
    },
  };
}

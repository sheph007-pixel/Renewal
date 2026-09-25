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
// Every unique plan is kept - PPO and EPO alike - and counted in the
// reconciliation ("31 appearances -> 19 unique plans: 16 PPO, 3 EPO"). Which
// of them a client is shown is decided separately (server/plan-visibility.js);
// nothing is dropped here.
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

/** A reading's stray blank entry - no name, no plan code, no rate, nothing - an artifact of the model, never a plan. */
export const isBlankPlan = (pl) =>
  !pl ||
  (!exactName(pl.name) &&
    !normCode(pl.plan_code) &&
    pl.monthly_total == null &&
    !Object.values(pl.rates || {}).some((v) => v != null));

/**
 * The canonical plans of a reading: `extracted.plans` less any blank entry.
 * Once a reading has been canonicalized and validated, each entry IS one
 * unique carrier plan, so this list's length is the plan count everywhere
 * (reconciliation, audit, grid) - never re-deduplicated on a weaker key.
 */
/**
 * A placement label the reader added to a printed name - "(alt grid base)",
 * "(headline option 2)", "(PPO alternate 32)", "[page 14]": where the plan
 * sits on the quote, never what the carrier calls it. The reader is told not
 * to add them; when one slips through, the plan is still the same carrier
 * plan as the unlabelled one.
 */
const PLACEMENT_LABEL = /\s*[\(\[]\s*(?:[\w/&+-]+\s+){0,2}(?:alt|alternate|alternative|grid|base|headline|option|opt|illustrative|benchmark|page|pg|row|column|table|appendix|summary|overview)\b[^\)\]]*[\)\]]\s*$/i;

/** The printed name without a reader-added placement label; null when the name carries none. */
export function placementCore(name) {
  const n = exactName(name);
  if (!PLACEMENT_LABEL.test(n)) return null;
  const core = n.replace(PLACEMENT_LABEL, "").trim();
  return core || null;
}

/** A name with any trailing bracketed text removed: what two near-identical names are compared on. */
export const bracketCore = (name) => exactName(name).replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/, "").trim().toLowerCase();

export const canonicalPlans = (x) => (Array.isArray(x) ? x : Array.isArray(x && x.plans) ? x.plans : []).filter((pl) => !isBlankPlan(pl));

/** A plan's identity key: its code when printed, else its exact name on its network. */
export function identityKey(pl) {
  const code = normCode(pl.plan_code);
  return code ? `code:${code}` : `name:${exactName(pl.name).toLowerCase()}|${normNet(pl.network)}`;
}

/**
 * The canonical plan (index in `plans`) an appearance belongs to, by the same
 * rules canonicalizePlans merges on: the same identity key; or, for an
 * appearance with no code, the one coded plan carrying that exact printed
 * name on a compatible network. -1 when it is a plan of its own.
 */
export function matchCanonical(pl, plans) {
  const key = identityKey(pl);
  const same = plans.findIndex((c) => c && identityKey(c) === key);
  if (same >= 0) return same;
  if (normCode(pl.plan_code)) return -1;
  const name = exactName(pl.name).toLowerCase();
  const net = normNet(pl.network);
  const hits = plans.map((c, i) => [c, i]).filter(([c]) => c && normCode(c.plan_code) && exactName(c.name).toLowerCase() === name && (!net || !normNet(c.network) || normNet(c.network) === net));
  return hits.length === 1 ? hits[0][1] : -1;
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
 * Returns { plans, reconciliation } - every unique plan, EPO included.
 */
export function canonicalizePlans(appearances, { reportedAppearances = null, reportedUnique = null, reportedEpo = null } = {}) {
  let list = (Array.isArray(appearances) ? appearances : []).filter((pl) => pl && (exactName(pl.name) || normCode(pl.plan_code)));
  // A reader-added placement label ("P100i10025B (alt grid base)") on an
  // appearance whose unlabelled name is also on the list (same network, no
  // different code) is another appearance of that plan, under its printed
  // name. Any value the two state differently is still recorded as a
  // conflict below and settled against the source.
  const names = new Set(list.map((pl) => `${exactName(pl.name).toLowerCase()}|${normNet(pl.network)}`));
  let relabelled = 0;
  list = list.map((pl) => {
    const core = placementCore(pl.name);
    if (!core || !names.has(`${core.toLowerCase()}|${normNet(pl.network)}`)) return pl;
    const twin = list.find((o) => exactName(o.name).toLowerCase() === core.toLowerCase() && normNet(o.network) === normNet(pl.network));
    if (twin && normCode(pl.plan_code) && normCode(twin.plan_code) && normCode(pl.plan_code) !== normCode(twin.plan_code)) return pl;
    relabelled++;
    return { ...pl, name: exactName(twin ? twin.name : core), ...(twin && !normCode(pl.plan_code) && normCode(twin.plan_code) ? { plan_code: twin.plan_code } : {}) };
  });
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
        // The source cells before normalization (a parser's raw values), kept for provenance.
        ...(pl.raw && typeof pl.raw === "object" ? { raw: { ...pl.raw } } : {}),
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
    const compatible = (c) => !net || !normNet(c.network) || normNet(c.network) === net;
    let hits = order.filter((k) => {
      const c = byKey.get(k);
      return k.startsWith("code:") && c.name.toLowerCase() === name && compatible(c);
    });
    // Or whose printed name IS a coded plan's code ("P100i10025B" printed as
    // the name on one page, as the code of "Choice Plus P100i10025B" on another).
    if (!hits.length) hits = order.filter((k) => k === `code:${normCode(pl.name)}` && compatible(byKey.get(k)));
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
  const epo = all.filter(isEpoPlan).length;
  return {
    plans: all,
    reconciliation: {
      plan_appearances: Number.isInteger(reportedAppearances) ? reportedAppearances : list.length,
      appearances_read: list.length,
      unique_plans: all.length,
      unique_ppo: all.length - epo,
      unique_epo: epo,
      // Every unique plan is stored: the expected count is all of them.
      expected: all.length,
      reader_unique_plans: Number.isInteger(reportedUnique) ? reportedUnique : null,
      reader_unique_epo: Number.isInteger(reportedEpo) ? reportedEpo : null,
      ...(relabelled ? { placement_labels_folded: relabelled } : {}),
    },
  };
}

/**
 * A stored plan list (already canonical) with every reader-labelled copy of a
 * plan folded into the plan it copies: "P100i10025B (alt grid base)" into
 * "P100i10025B" - same network, no different code, and every value both
 * state the same (rates, deductible, OOP max, benefits). The kept plan keeps
 * its BenSync ID and gains the copy's pages and any value only the copy
 * stated. A labelled copy that states anything differently is left alone for
 * validation to send back to the source. Returns { plans, folded: [{ plan,
 * into }] }.
 */
export function foldPlacementDuplicates(plans) {
  const list = (Array.isArray(plans) ? plans : []).map((pl) => pl);
  const folded = [];
  const gone = new Set();
  for (let i = 0; i < list.length; i++) {
    const pl = list[i];
    if (!pl || gone.has(i)) continue;
    const core = placementCore(pl.name);
    if (!core) continue;
    const j = list.findIndex((c, k) =>
      k !== i && c && !gone.has(k) &&
      exactName(c.name).toLowerCase() === core.toLowerCase() &&
      normNet(c.network) === normNet(pl.network) &&
      !(normCode(pl.plan_code) && normCode(c.plan_code) && normCode(pl.plan_code) !== normCode(c.plan_code)) &&
      MATERIAL.filter((f) => f !== "name").every((f) => {
        const a = valueOf(c, f);
        const b = valueOf(pl, f);
        return isBlank(a) || isBlank(b) || normVal(a) === normVal(b);
      }),
    );
    if (j < 0) continue;
    const keep = list[j];
    const merged = { ...keep, rates: { ...(keep.rates || {}) }, benefits: { ...(keep.benefits || {}) } };
    for (const f of MATERIAL) {
      if (f === "name") continue;
      const have = valueOf(merged, f);
      const got = valueOf(pl, f);
      if (!isBlank(have) || isBlank(got)) continue;
      if (TIERS.includes(f)) merged.rates[f] = got;
      else if (BENEFIT_KEYS.includes(f)) merged.benefits[f] = got;
      else merged[f] = got;
    }
    if (!normCode(merged.plan_code) && normCode(pl.plan_code)) merged.plan_code = pl.plan_code;
    const a = keep.source || {};
    const b = pl.source || {};
    merged.source = {
      ...a,
      identity: uniqSorted([...(a.identity || []), ...(b.identity || [])]),
      benefits: uniqSorted([...(a.benefits || []), ...(b.benefits || [])]),
      rates: uniqSorted([...(a.rates || []), ...(b.rates || [])]),
      appearances: (a.appearances || 1) + (b.appearances || 1),
    };
    list[j] = merged;
    gone.add(i);
    folded.push({ plan: pl, into: merged });
  }
  return { plans: list.filter((_, i) => !gone.has(i)), folded };
}

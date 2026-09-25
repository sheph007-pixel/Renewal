// Deterministic validation of a proposal's canonical plans - everything code
// can check without a model, run before either AI audit. A proposal that
// fails any of these is not audited until it is fixed: there is no point
// asking two models to confirm a reading that already has a duplicate plan,
// a missing rate or a rate set whose provenance points at another plan.
//
// Each check returns { key, label, ok, note, fix } where `fix` is the repair
// the steward should run: "read" (extract again from the source), "correct"
// (settle against the source, targeted), or "refresh" (rebuild what is
// served). No arithmetic, count matching, uniqueness or version checking is
// left to AI.

import { TIERS, identityKey, normCode, exactName, isEpoPlan } from "./plan-canonical.js";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `extracted`: the proposal's stored reading. `sourceSha`: the row's source
 * document hash. `groupOptionIds`: every option ID on the group's other
 * current proposals (a number held twice in a group fails). `textSource`:
 * the document is a spreadsheet / text (provenance is sheet and rows, not
 * pages).
 */
export function validatePlans({ extracted, sourceSha, groupOptionIds = [], textSource = false }) {
  const x = extracted || {};
  const plans = (Array.isArray(x.plans) ? x.plans : []).filter((pl) => pl && (exactName(pl.name) || normCode(pl.plan_code)));
  const checks = [];
  const check = (key, label, failures, fix, okNote) => checks.push({ key, label, ok: !failures.length, note: failures.length ? failures.slice(0, 4).join(" ") + (failures.length > 4 ? ` (+${failures.length - 4} more)` : "") : okNote || "", fix: failures.length ? fix : null });

  // Current version: the reading was extracted from the document on file now.
  const ext = x.extraction || {};
  check("version", "Current version", [
    ...(!sourceSha ? ["The source document's hash is not recorded yet."] : []),
    ...(sourceSha && !ext.sourceSha ? ["The reading does not record which version of the document it was extracted from."] : []),
    ...(sourceSha && ext.sourceSha && ext.sourceSha !== sourceSha ? ["The reading was extracted from a different version of the document."] : []),
  ], "read", "The reading is of the document on file now.");

  check("plans", "Plans present", plans.length ? [] : ["No plans stored."], "read", plural(plans.length, "plan"));

  // No duplicates: identity, code, name, internal ID.
  const seen = new Map();
  const dupIdentity = [];
  for (const pl of plans) {
    const k = identityKey(pl);
    if (seen.has(k)) dupIdentity.push(`"${pl.name}"${pl.plan_code ? ` [${pl.plan_code}]` : ""} is stored twice.`);
    seen.set(k, true);
  }
  check("unique", "No duplicate plans", dupIdentity, "correct", "Every plan is stored once.");

  const codes = new Map();
  const dupCodes = [];
  for (const pl of plans) {
    const c = normCode(pl.plan_code);
    if (!c) continue;
    if (codes.has(c)) dupCodes.push(`Plan code ${pl.plan_code} is on two plans.`);
    codes.set(c, true);
  }
  // The same exact name twice is a duplicate unless a distinct plan code (or
  // network) tells the two apart - a code the carrier printed, not a guess.
  const names = new Map();
  for (const pl of plans) {
    const k = `${exactName(pl.name).toLowerCase()}|${String(pl.network || "").trim().toLowerCase()}`;
    const prev = names.get(k);
    if (prev && (!normCode(pl.plan_code) || !normCode(prev.plan_code))) dupCodes.push(`"${pl.name}" appears twice with nothing printed to tell them apart.`);
    names.set(k, pl);
  }
  check("codes", "Exact names and codes unique", dupCodes, "correct", "No plan code or name is shared.");

  const ids = new Map();
  const idProblems = [];
  const others = new Set(groupOptionIds);
  for (const pl of plans) {
    if (!pl.option_id) {
      idProblems.push(`"${pl.name}" has no BenSync ID yet.`);
      continue;
    }
    if (ids.has(pl.option_id)) idProblems.push(`${pl.option_id} is on two plans.`);
    if (others.has(pl.option_id)) idProblems.push(`${pl.option_id} is also on another of the group's proposals.`);
    ids.set(pl.option_id, true);
  }
  check("ids", "BenSync IDs unique", idProblems, "refresh", "Every plan has its own ID.");

  // Required fields, and four numeric tier rates that belong to the plan.
  const missing = [];
  for (const pl of plans) {
    const need = [];
    if (!exactName(pl.name)) need.push("name");
    if (!pl.deductible) need.push("deductible");
    if (!pl.oop_max) need.push("out-of-pocket max");
    if (need.length) missing.push(`"${pl.name || pl.plan_code}" is missing ${need.join(", ")}.`);
  }
  check("fields", "Required fields present", missing, "correct", "Name, deductible and out-of-pocket max on every plan.");

  const rateProblems = [];
  for (const pl of plans) {
    const r = pl.rates || {};
    const unpriced = Array.isArray(pl.unpriced) ? pl.unpriced : [];
    const bad = TIERS.filter((t) => r[t] != null && (typeof r[t] !== "number" || !Number.isFinite(r[t]) || r[t] <= 0));
    const absent = TIERS.filter((t) => r[t] == null && !unpriced.includes(t));
    if (bad.length) rateProblems.push(`"${pl.name}" has a non-numeric ${bad.join("/")} rate.`);
    else if (absent.length) rateProblems.push(`"${pl.name}" has no ${absent.join("/")} rate.`);
  }
  check("rates", "Four tier rates", rateProblems, "correct", "EE, ES, EC and FAM on every plan (or confirmed not priced by the carrier).");

  // Provenance: every plan knows where its identity, benefits and rates came
  // from - pages of a PDF, or the sheet and rows of a workbook.
  const noSource = [];
  for (const pl of plans) {
    const s = pl.source;
    if (!s) {
      noSource.push(`"${pl.name}" has no source references.`);
      continue;
    }
    if (textSource) {
      if (!s.sheet && !s.rows) noSource.push(`"${pl.name}" has no sheet or row reference.`);
    } else if (!(s.rates && s.rates.length) || !((s.benefits && s.benefits.length) || (s.identity && s.identity.length))) {
      noSource.push(`"${pl.name}" is missing the page its ${!(s.rates && s.rates.length) ? "rates" : "benefits"} came from.`);
    }
  }
  check("provenance", "Source references", noSource, "read", "Every plan's identity, benefits and rates trace to the source.");

  // Pairing: nothing from another plan mixed in. Every appearance merged into
  // a plan carried that plan's own code (or none), and no two appearances of
  // it disagree on a value that has not been settled against the source.
  const mixed = [];
  for (const pl of plans) {
    const own = normCode(pl.plan_code);
    const codesSeen = (pl.source && Array.isArray(pl.source.codes) ? pl.source.codes : []).filter(Boolean);
    const foreign = codesSeen.filter((c) => c !== own);
    if (foreign.length) mixed.push(`"${pl.name}" [${pl.plan_code || "no code"}] has data from plan code ${foreign.join(", ")}.`);
    for (const k of Array.isArray(pl.conflicts) ? pl.conflicts : []) {
      mixed.push(`"${pl.name}": its appearances disagree on ${k.field} (${k.values.map((v) => `${v.value}${v.pages && v.pages.length ? ` p${[...new Set(v.pages)].join(",")}` : ""}`).join(" vs ")}).`);
    }
  }
  check("pairing", "Plan, benefit and rate pairing", mixed, "correct", "Every plan's benefits and rates come from that plan alone.");

  // Reconciliation: appearances fold into unique plans, EPO exclusions are
  // counted, and what is stored is exactly what is expected.
  const rc = x.reconciliation || null;
  const recon = [];
  if (!rc) recon.push("No plan count reconciliation on the reading.");
  else {
    if (rc.unique_ppo + rc.unique_epo !== rc.unique_plans) recon.push(`Unique plans ${rc.unique_plans} is not PPO ${rc.unique_ppo} + EPO ${rc.unique_epo}.`);
    if (rc.expected !== plans.length) recon.push(`Expected ${rc.expected} plans; the database holds ${plans.length}.`);
    const epoStored = plans.filter(isEpoPlan).length;
    if (epoStored !== rc.unique_epo) recon.push(`${rc.unique_epo} EPO plans counted, ${epoStored} stored.`);
    if (rc.reader_unique_plans != null && rc.reader_unique_plans !== rc.unique_plans) recon.push(`The reader counted ${rc.reader_unique_plans} unique plans on the document; ${rc.unique_plans} were stored.`);
  }
  check(
    "reconciliation",
    "Plan count reconciles",
    recon,
    rc ? "correct" : "read",
    rc ? `${rc.plan_appearances} appearances → ${rc.unique_plans} unique plans (${rc.unique_ppo} PPO, ${rc.unique_epo} EPO) → ${plans.length} stored.` : "",
  );

  const failed = checks.filter((c) => !c.ok);
  // Which repair first: a stale or unsourced reading is extracted again; a
  // duplicate, conflict or count problem is settled against the source; an
  // ID problem is rebuilt.
  const fix = failed.some((c) => c.fix === "read") ? "read" : failed.some((c) => c.fix === "correct") ? "correct" : failed.length ? "refresh" : null;
  return { ok: !failed.length, checks, fix, failures: failed.map((c) => `${c.label}: ${c.note}`) };
}

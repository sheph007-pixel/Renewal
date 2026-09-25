// Deterministic validation of a proposal's canonical plans - everything code
// can check without a model, run before either AI audit. A proposal that
// fails any of these is not audited until it is fixed: there is no point
// asking two models to confirm a reading that already has a duplicate plan,
// a missing rate or a rate set whose provenance points at another plan.
//
// Each check returns { key, label, ok, note, fix } where `fix` is the repair
// the steward should run: "read" (extract again from the source), "correct"
// (settle against the source, targeted), or "refresh" (rebuild what is
// served) or "review" (a person must decide - the one case: a carrier
// printing the same plan name for two different plan codes). No arithmetic,
// count matching, uniqueness or version checking is left to AI.
//
// Identity everywhere is the canonical carrier identity (identityKey in
// plan-canonical.js): the plan code when printed, else the exact printed
// name on its network. Two plans are never judged the same because their
// rates happen to agree.

import { TIERS, identityKey, normCode, exactName, isEpoPlan, canonicalPlans, bracketCore } from "./plan-canonical.js";

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
  const plans = canonicalPlans(x);
  const checks = [];
  const check = (key, label, failures, fix, okNote) => checks.push({ key, label, ok: !failures.length, note: failures.length ? failures.slice(0, 4).join(" ") + (failures.length > 4 ? ` (+${failures.length - 4} more)` : "") : okNote || "", fix: failures.length ? fix : null });

  // Current version: the reading was extracted from the document on file now.
  const ext = x.extraction || {};
  check("version", "Current version", [
    ...(!sourceSha ? ["The source document's hash is not recorded yet."] : []),
    ...(sourceSha && !ext.sourceSha ? ["The reading does not record which version of the document it was extracted from."] : []),
    ...(sourceSha && ext.sourceSha && ext.sourceSha !== sourceSha ? ["The reading was extracted from a different version of the document."] : []),
  ], "read", "The reading is of the document on file now.");

  // Source coverage: every page of a PDF, every sheet of a workbook, every
  // line of a CSV or text file was inspected by the read this plan list came
  // from - recorded by the reader (server/ai.js, server/gravie-parse.js) from
  // what was actually read, and tied to the version of the document on file.
  // A plan list is only as complete as the source it was read from.
  check("coverage", "Source coverage", ...coverageCheck(x.coverage, sourceSha));

  check("plans", "Plans present", plans.length ? [] : ["No plans stored."], "read", plural(plans.length, "plan"));

  // No duplicates: identity, code, name, internal ID.
  const seen = new Map();
  const dupIdentity = [];
  for (const pl of plans) {
    const k = identityKey(pl);
    if (seen.has(k)) dupIdentity.push(`"${pl.name}"${pl.plan_code ? ` [${pl.plan_code}]` : ""} is stored twice.`);
    seen.set(k, true);
  }
  // The same plan stored twice under two spellings of its name - one with a
  // bracketed label the other lacks ("P100i10025B" and "P100i10025B (alt
  // grid base)") - on the same network, with no different codes, and the
  // same deductible, OOP max and four rates. Settled against the source.
  const near = new Map();
  for (const pl of plans) {
    const core = bracketCore(pl.name);
    if (!core) continue;
    const k = `${core}|${String(pl.network || "").replace(/\s+/g, " ").trim().toLowerCase()}|${pl.deductible || ""}|${pl.oop_max || ""}|${TIERS.map((t) => (pl.rates || {})[t] ?? "").join("/")}`;
    near.set(k, [...(near.get(k) || []), pl]);
  }
  for (const group of near.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map((pl) => exactName(pl.name).toLowerCase())).size < 2) continue; // exact repeats: the identity/name checks have them
    const codes = group.map((pl) => normCode(pl.plan_code)).filter(Boolean);
    if (new Set(codes).size > 1) continue; // different printed codes: different plans
    dupIdentity.push(`${group.map((pl) => `"${pl.name}"`).join(" and ")} look like one plan stored twice (same network, deductible, out-of-pocket max and rates).`);
  }
  // A plan with no code whose printed name is another plan's code: the same plan.
  const byCode = new Map(plans.filter((pl) => normCode(pl.plan_code)).map((pl) => [normCode(pl.plan_code), pl]));
  for (const pl of plans) {
    if (normCode(pl.plan_code)) continue;
    const twin = byCode.get(normCode(pl.name));
    if (twin && String(twin.network || "").trim().toLowerCase() === String(pl.network || "").trim().toLowerCase()) dupIdentity.push(`"${pl.name}" is stored without a code and again as "${twin.name}" [${twin.plan_code}].`);
  }
  check("unique", "No duplicate plans", dupIdentity, "correct", "Every plan is stored once.");

  // No carrier plan code on two plans.
  const codes = new Map();
  const dupCodes = [];
  for (const pl of plans) {
    const c = normCode(pl.plan_code);
    if (!c) continue;
    if (codes.has(c)) dupCodes.push(`Plan code ${pl.plan_code} is on two plans.`);
    codes.set(c, true);
  }
  check("codes", "Plan codes unique", dupCodes, "correct", "No plan code is on two plans.");

  // No exact printed name on two plans of one network. Where one of them has no code,
  // nothing printed tells them apart: the same plan read twice - settled
  // against the source. Where every one has its own code, the carrier prints
  // one name for two different plans: never merged, never shown twice
  // silently - flagged for a person to confirm (`review`), unless one has
  // already confirmed exactly these codes share the name
  // (extracted.shared_names_confirmed).
  // Grouped by exact name AND printed network: the same design name on two
  // networks (Gravie prices each design on Open Access Plus and on
  // LocalPlus) is two plans the carrier itself tells apart by network.
  const byName = new Map();
  for (const pl of plans) {
    const n = exactName(pl.name).toLowerCase();
    if (!n) continue;
    const k = `${n}|${String(pl.network || "").replace(/\s+/g, " ").trim().toLowerCase()}`;
    byName.set(k, [...(byName.get(k) || []), pl]);
  }
  const confirmed = Array.isArray(x.shared_names_confirmed) ? x.shared_names_confirmed : [];
  const nameFailures = [];
  let nameFix = null;
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const codesOf = group.map((pl) => normCode(pl.plan_code));
    if (codesOf.some((c) => !c)) {
      nameFailures.push(`"${group[0].name}" appears ${group.length} times with nothing printed to tell them apart.`);
      nameFix = "correct";
      continue;
    }
    if (new Set(codesOf).size < codesOf.length) continue; // a repeated code: the codes check has it
    const ok = confirmed.some((cf) => exactName(cf.name).toLowerCase() === exactName(group[0].name).toLowerCase() && Array.isArray(cf.codes) && [...cf.codes].map(normCode).sort().join("|") === [...codesOf].sort().join("|"));
    if (ok) continue;
    nameFailures.push(`The document's plan name "${group[0].name}" is on ${group.length} different plan codes (${group.map((pl) => pl.plan_code).join(", ")}) - confirm the carrier uses one name for these plans.`);
    nameFix = nameFix || "review";
  }
  check("names", "Plan names unique", nameFailures, nameFix || "correct", "No plan name is on two plans.");

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
    const codesSeen = (pl.source && Array.isArray(pl.source.codes) ? pl.source.codes : []).map(normCode).filter(Boolean);
    const foreign = codesSeen.filter((c) => c !== own);
    if (foreign.length) mixed.push(`"${pl.name}" [${pl.plan_code || "no code"}] has data from plan code ${foreign.join(", ")}.`);
    for (const k of Array.isArray(pl.conflicts) ? pl.conflicts : []) {
      mixed.push(`"${pl.name}": its appearances disagree on ${k.field} (${k.values.map((v) => `${v.value}${v.pages && v.pages.length ? ` p${[...new Set(v.pages)].join(",")}` : ""}`).join(" vs ")}).`);
    }
  }
  check("pairing", "Plan, benefit and rate pairing", mixed, "correct", "Every plan's benefits and rates come from that plan alone.");

  // Reconciliation: appearances fold into unique plans, PPO and EPO are
  // counted, and what is stored - the canonical list, one entry per carrier
  // plan - is exactly what is expected.
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
  // duplicate, conflict or count problem is settled against the source; a
  // name the carrier genuinely prints for two plans goes to a person; an ID
  // problem is rebuilt.
  const order = ["read", "correct", "review", "refresh"];
  const fix = order.find((f) => failed.some((c) => c.fix === f)) || null;
  return { ok: !failed.length, checks, fix, failures: failed.map((c) => `${c.label}: ${c.note}`) };
}

/**
 * The source-coverage check's failures, repair and note. PDF: every page
 * covered - inspected by the page map or deep-read (covered_pages ==
 * total_pages, nothing uncovered). Workbook: every sheet inspected
 * (inspected_sheets == total_sheets). CSV / text: every line of the file
 * read (scanned_lines == total_lines - a file cut at the size limit never
 * passes), every section read. An unrecognized sheet in a workbook read by
 * a code parser goes to a person ("review"); anything else is read again.
 */
export function coverageCheck(cov, sourceSha) {
  if (!cov) return [["The reading does not record that the whole source was inspected."], "read", ""];
  const fail = [];
  let fix = "read";
  if (sourceSha && cov.sourceSha && cov.sourceSha !== sourceSha) fail.push("The coverage was recorded for a different version of the document.");
  if (sourceSha && !cov.sourceSha) fail.push("The coverage record is not tied to the version of the document on file.");
  let note = "";
  if (cov.kind === "pdf" || cov.kind === "image") {
    const total = cov.total_pages;
    if (!Number.isInteger(total) || total < 1) fail.push("The document's page count is unknown, so its coverage cannot be proved.");
    else if (cov.covered_pages !== total || cov.uncovered) fail.push(`${total - (cov.covered_pages || 0)} of ${total} pages were never inspected${cov.uncovered ? ` (pages ${cov.uncovered})` : ""}.`);
    note = `All ${total} page${total === 1 ? "" : "s"} inspected: ${cov.mapped_pages || 0} mapped, ${cov.deep_read_pages || 0} deep-read.`;
  } else if (cov.kind === "sheets") {
    const sheets = Array.isArray(cov.sheets) ? cov.sheets : [];
    if (!Number.isInteger(cov.total_sheets) || cov.total_sheets < 1) fail.push("The workbook's sheets were not enumerated.");
    else if (cov.inspected_sheets !== cov.total_sheets || sheets.length !== cov.total_sheets) {
      const missed = sheets.filter((sh) => sh.status === "not read" || sh.status === "unrecognized");
      fail.push(`${cov.total_sheets - (cov.inspected_sheets || 0)} of ${cov.total_sheets} sheets not inspected${missed.length ? `: ${missed.map((sh) => `"${sh.name}"${sh.status === "unrecognized" ? " (a sheet the parser does not recognize)" : ""}`).join(", ")}` : ""}.`);
      if (cov.parser && missed.some((sh) => sh.status === "unrecognized")) fix = "review";
    }
    if (!cov.parser && Number.isInteger(cov.total_lines) && cov.scanned_lines !== cov.total_lines) fail.push(`${cov.total_lines - (cov.scanned_lines || 0)} of ${cov.total_lines} lines of the workbook were never read (cut at the size limit).`);
    const parsed = sheets.filter((sh) => sh.status === "parsed" || sh.status === "read").length;
    note = `All ${cov.total_sheets} sheet${cov.total_sheets === 1 ? "" : "s"} inspected: ${parsed} ${cov.parser ? "parsed" : "read"}${sheets.length - parsed ? `, ${sheets.length - parsed} ${cov.parser ? "not quote sheets" : "empty"}` : ""}.`;
  } else if (cov.kind === "text") {
    if (!Number.isInteger(cov.total_lines)) fail.push("The file's length was not recorded.");
    else if (cov.scanned_lines !== cov.total_lines) fail.push(`${cov.total_lines - (cov.scanned_lines || 0)} of ${cov.total_lines} lines were never read${cov.total_chars > 300000 ? " (the file is past the size limit)" : ""}.`);
    if (Number.isInteger(cov.total_sections) && cov.sections_read !== cov.total_sections) fail.push(`${cov.total_sections - (cov.sections_read || 0)} of ${cov.total_sections} sections were never read.`);
    note = `All ${cov.total_lines} lines read${Number.isInteger(cov.total_sections) ? ` (${cov.total_sections} section${cov.total_sections === 1 ? "" : "s"})` : ""}.`;
  } else fail.push(`Unknown source kind "${cov.kind}".`);
  return [fail, fix, note];
}

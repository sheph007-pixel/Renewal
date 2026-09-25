// The check behind every filled box on the Proposals grid.
//
// A box is Verified (green, "✓ Verified · 14 plans") only when every one of
// these holds for the proposal on file in it:
//
//   Source         the original document is on file, whole.
//   Extraction     the read finished: plans, each named and rated.
//   Validation     every deterministic check passes (server/plan-validate.js):
//                  current version, no duplicate plans / codes / names / IDs,
//                  required fields, four numeric tier rates, source pages or
//                  sheet rows for identity, benefits and rates, no data mixed
//                  in from another plan code, no unresolved conflicting
//                  appearances, and the plan count reconciled (appearances ->
//                  unique -> PPO + EPO -> every unique plan stored).
//   Claude Audit   Claude counted the plans on the document (found, EPO
//                  and expected), read every stored plan's four rates
//                  off the page, and found nothing - and its count is the
//                  database's.
//   ChatGPT Audit  the same, independently, by a different model family.
//   Grid           the group's Medical Plans grid shows exactly the stored
//                  plans the visibility rules let the client see
//                  (server/plan-visibility.js - EPO hidden), no more, no fewer.
//
// Both audits must be of the exact reading on the grid now (`version`): a
// correction, a re-read or a newer upload makes an older audit stale, and
// a stale, failed or one-model audit is pending, never a pass. No finding
// may be left open. An empty slot is simply blank.
//
// Pure arithmetic over what is stored - no model call - so the whole book is
// checked in milliseconds, and each failing box names the repair (`fix`) the
// server's steward carries out on its own.

import { validatePlans } from "./plan-validate.js";
import { hiddenReason } from "./plan-visibility.js";
import { TIERS, identityKey, canonicalPlans } from "./plan-canonical.js";
import { AUDIT_STANDARD } from "./plan-compare.js";

// Plan identity everywhere below is the canonical carrier identity
// (identityKey: the plan code when printed, else the exact printed name on
// its network). A served plan carries the key the server computed from its
// stored record (`identity`), so stored and served are compared on the one
// definition. Counts are the canonical list's length: once a reading is
// canonicalized and validated, each entry IS one carrier plan - two are
// never taken for one because their rates agree.
const servedKey = (pl) => pl.identity || identityKey({ plan_code: pl.planCode ?? pl.plan_code, name: pl.name, network: pl.network });

/** Keys held by more than one plan in a list. */
const repeated = (keys) => {
  const seen = new Set();
  const dup = new Set();
  for (const k of keys) {
    if (k == null) continue;
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
};

/**
 * How the client's proposalPlans (client/src/lib/model.ts) treats a group's
 * served plans, reduced to counts: shown in the grid - every plan, priced or
 * not for this group's tiers (an unpriced one shows with no monthly figure,
 * never hidden) - or dropped as a repeat of a carrier plan already shown
 * (the same canonical identity; never happens with a validated reading).
 * `unpriced` lists the plans with no rate for a tier the group has people
 * in. Kept in step with that function; test-proposal-verify checks it.
 */
export function gridCounts(plans, slot, tiers) {
  const counts = tiers || {};
  const seen = new Set();
  let shown = 0;
  let repeats = 0;
  const unpriced = [];
  for (const pl of plans || []) {
    const rates = pl.rates || {};
    if (!TIERS.some((t) => rates[t] != null) || TIERS.some((t) => counts[t] && rates[t] == null)) unpriced.push(pl);
    const k = `${slot}|${servedKey(pl)}`;
    if (seen.has(k)) {
      repeats++;
      continue;
    }
    seen.add(k);
    shown++;
  }
  return { shown, repeats, unpriced };
}

const busyRow = (r, reading) => r.status === "analyzing" || reading.has(r.id);

/**
 * The processing state a box's proposal is in: UPLOADED, MAPPING, EXTRACTING,
 * EXTRACTED, VALIDATING, AUDITING, CORRECTING, VERIFIED or NEEDS_REVIEW. Only
 * VERIFIED is ever shown to a client as checked.
 */
function stageOf(c, row, correcting) {
  if (c.state === "verified") return "VERIFIED";
  if (c.state === "stuck" || c.failedAt === "source") return "NEEDS_REVIEW";
  if (c.failedAt === "extraction") return row && (row.stage === "MAPPING" || row.stage === "UPLOADED") && c.state === "working" ? row.stage : "EXTRACTING";
  if (c.failedAt === "validation" || c.failedAt === "grid") return c.fix === "correct" && row && correcting.has(row.id) ? "CORRECTING" : "VALIDATING";
  if (row && correcting.has(row.id)) return "CORRECTING";
  return c.fix === "correct" ? "CORRECTING" : "AUDITING";
}

/**
 * Check every group. `groups`: [{ name, slots, tiers }] - live groups, the
 * slots each is quoted in, and its enrolled count per tier. `rows`: every
 * proposal row as stored. `served(name)`: the proposals the group's own page
 * is given (clientProposals). `isEpoPlan` / `isBlankPlan`: the server's own
 * rules for what is never offered or never a plan. `reading` / `auditing` /
 * `correcting`: ids with that step in flight. `gaveUp(id)`: the steward's
 * note when it has run out of repairs to try on a proposal.
 */
export function verifyProposals({ groups, rows, served, isBlankPlan, reading = new Set(), auditing = new Set(), correcting = new Set(), readingVersion = null, gaveUp = () => null, slotEnabled = () => true }) {
  const out = [];
  for (const g of groups) {
    const mine = rows.filter((r) => r.group_name === g.name && r.status !== "container" && r.kind !== "invoice" && r.kind !== "email");
    const list = served(g.name) || [];
    const cells = [];
    for (const slot of g.slots) {
      const inSlot = mine.filter((r) => r.slot === slot && (r.status === "assigned" || r.status === "analyzing") && !r.superseded_by);
      const sv = list.find((p) => p.slot === slot);
      const row = (sv && inSlot.find((r) => r.id === sv.id)) || null;
      // A newer upload waiting beside the proposal in force: still being
      // read, or its read failed. It takes over only once it reads.
      const waiting = inSlot.filter((r) => !row || r.id !== row.id);
      const steps = { source: null, extraction: null, validation: null, claude: null, chatgpt: null, grid: null };
      const cell = {
        slot,
        proposalId: row ? row.id : null,
        filename: row ? row.filename : null,
        plans: 0,
        counts: { document: null, stored: null, visible: null, hidden: null, grid: null, client: null, audit: null },
        // Kennion's per-group switch: ON shows every Verified plan of this
        // slot to the client, OFF shows none. Verification is the same either way.
        clientEnabled: slotEnabled(g.name, slot),
        steps,
        waiting: waiting.map((r) => ({ id: r.id, filename: r.filename, reading: busyRow(r, reading), error: r.error || null })),
      };
      cells.push(cell);
      const settle = (step, fix, id, busy) => {
        cell.failedAt = step;
        cell.fix = fix;
        cell.fixId = id;
        cell.state = busy ? "working" : "fail";
        const why = gaveUp(id);
        if (!busy && why) {
          cell.state = "stuck";
          cell.stuck = why;
        }
      };

      // 1. On file. An empty slot is simply blank - nothing to check.
      if (!row && !waiting.length) {
        cell.state = "missing";
        continue;
      }
      if (!row) {
        const w = waiting[0];
        steps.source = { ok: true, note: w.filename };
        const busy = busyRow(w, reading);
        steps.extraction = { ok: false, busy, note: busy ? "Being read now." : w.error ? `The read failed: ${w.error}` : "Not read yet." };
        settle("extraction", "read", w.id, busy);
        continue;
      }
      if (!(row.size > 0) || !row.source_sha) {
        steps.source = { ok: false, note: "The original document is not on file." };
        cell.state = "stuck";
        cell.failedAt = "source";
        cell.stuck = row.size > 0 ? "The source document's hash is not recorded yet." : "The original document is missing - upload it again.";
        continue;
      }
      steps.source = { ok: true, note: row.filename };
      const scorecard = slot === "Angle Scorecard";
      const x = row.extracted || {};
      // Every unique plan is stored, EPO included; the client is shown the
      // ones the visibility rules allow.
      const stored = canonicalPlans(x).filter((pl) => !isBlankPlan(pl));
      const storedDistinct = stored.length;
      const hiddenPlans = stored.filter((pl) => hiddenReason(pl));
      cell.counts.stored = storedDistinct;
      cell.counts.hidden = hiddenPlans.length;
      cell.hidden = hiddenPlans.map((pl) => ({ id: pl.option_id || null, name: pl.name, plan_code: pl.plan_code || null, reason: hiddenReason(pl) }));
      cell.plans = storedDistinct;
      const a = row.audit;

      // Extraction.
      const readBusy = busyRow(row, reading) || waiting.some((w) => busyRow(w, reading));
      const failedWaiting = waiting.find((w) => !busyRow(w, reading));
      if (readBusy) {
        steps.extraction = { ok: false, busy: true, note: "Being read now." };
        settle("extraction", "read", row.id, true);
        continue;
      }
      if (!row.extracted || (!scorecard && !stored.length)) {
        steps.extraction = { ok: false, note: row.error ? `The read failed: ${row.error}` : row.extracted ? "The document read with no plans on it." : "Not read yet." };
        settle("extraction", "read", row.id, false);
        continue;
      }
      if (!scorecard) {
        const problems = [];
        const noName = stored.filter((pl) => !String(pl.name || "").trim()).length;
        if (noName) problems.push(`${noName} plan${noName === 1 ? " has" : "s have"} no name.`);
        const noRate = stored.filter((pl) => !TIERS.some((t) => pl.rates && pl.rates[t] != null)).length;
        if (noRate) problems.push(`${noRate} plan${noRate === 1 ? " has" : "s have"} no rate at all.`);
        if (problems.length) {
          steps.extraction = { ok: false, note: problems.join(" ") };
          settle("extraction", "correct", row.id, correcting.has(row.id));
          continue;
        }
      }
      if (failedWaiting) {
        steps.extraction = { ok: false, note: `A newer upload (${failedWaiting.filename}) could not be read${failedWaiting.error ? `: ${failedWaiting.error}` : ""}. This one stays in force until it does.` };
        settle("extraction", "read", failedWaiting.id, false);
        continue;
      }
      steps.extraction = { ok: true, note: scorecard ? "Read." : `${storedDistinct} plan${storedDistinct === 1 ? "" : "s"} read, each named and rated.` };
      if (scorecard) {
        steps.validation = { ok: true, note: "A scorecard carries no plans to validate." };
        steps.claude = { ok: true, note: "A scorecard carries no rates to audit." };
        steps.chatgpt = { ok: true, note: "A scorecard carries no rates to audit." };
        steps.grid = { ok: true, note: "Admin only - not part of the 2027 options." };
        cell.state = "verified";
        continue;
      }

      // Validation: everything code can check, before either model is asked.
      const groupIds = list.filter((pp) => pp.slot !== slot).flatMap((pp) => (pp.plans || []).map((pl) => pl.optionId).filter(Boolean));
      // (served() carries every stored plan, hidden ones too, so no ID can hide from this check.)
      const val = validatePlans({ extracted: x, sourceSha: row.source_sha, groupOptionIds: groupIds, textSource: !/pdf|image/i.test(String(row.mime || "")) });
      steps.validation = val.ok
        ? { ok: true, note: (val.checks.find((c) => c.key === "reconciliation") || {}).note || "Every check passed.", checks: val.checks }
        : { ok: false, busy: correcting.has(row.id), note: val.failures.join(" "), checks: val.checks };
      cell.reconciliation = x.reconciliation || null;
      // What of the source the reading covered (pages / sheets / lines), for the hover.
      const cov = x.coverage || null;
      cell.coverage = cov ? { kind: cov.kind, total_pages: cov.total_pages ?? null, mapped_pages: cov.mapped_pages ?? null, deep_read_pages: cov.deep_read_pages ?? null, covered_pages: cov.covered_pages ?? null, total_sheets: cov.total_sheets ?? null, inspected_sheets: cov.inspected_sheets ?? null, total_lines: cov.total_lines ?? null, scanned_lines: cov.scanned_lines ?? null } : null;
      if (!val.ok) {
        settle("validation", val.fix, row.id, correcting.has(row.id));
        continue;
      }

      // Claude Audit and OpenAI Audit: both, of this exact reading of this exact document.
      if (auditing.has(row.id) || correcting.has(row.id)) {
        const note = correcting.has(row.id) ? "Correcting the database against the document now." : "Auditing against the document now.";
        steps.claude = { ok: false, busy: true, note };
        steps.chatgpt = { ok: false, busy: true, note };
        settle("claude", null, row.id, true);
        continue;
      }
      // Current: of this exact reading, of this exact document, and held to
      // today's audit standard (every field compared, not rates alone).
      const current = !!(a && a.version && readingVersion && a.version === readingVersion(x) && (!a.sourceSha || a.sourceSha === row.source_sha) && (a.standard || 1) >= AUDIT_STANDARD);
      const auditStep = (re) => {
        if (!a) return { ok: false, note: "Not audited yet." };
        if (!current) return { ok: false, note: (a.standard || 1) < AUDIT_STANDARD && a.version === (readingVersion ? readingVersion(x) : null) ? "Audited on rates alone - pending a field-by-field audit." : "Audited an earlier reading - pending a fresh audit of this one." };
        const m = (a.models || []).find((mm) => re.test(mm.model));
        if (!m) return { ok: false, note: "Did not run." };
        const c = m.plansFoundTotal != null ? `${m.planAppearances != null ? `${m.planAppearances} appearances, ` : ""}${m.plansFoundTotal} unique plans on the document (${m.epoExcluded ?? 0} EPO); database ${storedDistinct}` : null;
        if (m.verdict === "pass" && m.documentPlanCount === storedDistinct) return { ok: true, note: `Pass. ${c}; all ${m.of} plans read off the document${m.batches && m.batches.length > 1 ? ` in ${m.batches.length} batches` : ""} - name, code, network, deductible, out-of-pocket max, benefits and four rates compared in code.` };
        if (m.verdict === "off" || m.verdict === "error") return { ok: false, note: `Pending - ${m.verdict === "off" ? "not configured" : "did not complete"}: ${m.notes || ""}` };
        if (m.verdict === "incomplete") return { ok: false, note: `Pending - returned ${m.confirmed} of ${m.of} plans${m.batches && m.batches.length > 1 ? ` (${m.batches.filter((b) => b.verdict !== "pass" && b.verdict !== "issues").length} of ${m.batches.length} batches incomplete)` : ""}.` };
        if (m.verdict === "unreadable") return { ok: false, note: `Could not read the document: ${m.notes || ""}` };
        const n = (a.mismatches || []).filter((mm) => mm.by === m.model).length;
        return { ok: false, note: `${n} finding${n === 1 ? "" : "s"}${c ? ` (${c})` : ""}.`, mismatches: (a.mismatches || []).filter((mm) => mm.by === m.model).slice(0, 12) };
      };
      steps.claude = auditStep(/^claude/i);
      steps.chatgpt = auditStep(/^chatgpt/i);
      const cl = (a && current && (a.models || []).find((mm) => /^claude/i.test(mm.model))) || null;
      const gp = (a && current && (a.models || []).find((mm) => /^chatgpt/i.test(mm.model))) || null;
      cell.counts.document = cl && gp && cl.documentPlanCount === gp.documentPlanCount ? cl.documentPlanCount : null;
      cell.counts.audit = { claude: cl ? { found: cl.plansFoundTotal, epoExcluded: cl.epoExcluded, expected: cl.documentPlanCount } : null, chatgpt: gp ? { found: gp.plansFoundTotal, epoExcluded: gp.epoExcluded, expected: gp.documentPlanCount } : null };
      if (!steps.claude.ok || !steps.chatgpt.ok) {
        // Open findings are corrected against the document; anything else -
        // no audit, a stale one, a model that did not finish - is audited.
        const findings = current && a.status === "issues" && (a.mismatches || []).length > 0;
        settle(!steps.claude.ok ? "claude" : "chatgpt", findings ? "correct" : "audit", row.id, false);
        continue;
      }

      // Grid: the served proposal is this exact reading (every stored plan),
      // and the client is shown exactly the ones the visibility rules allow.
      const servedAll = sv ? sv.plans || [] : [];
      // Same set, by canonical identity, and the same number: a served list
      // holding one carrier plan twice is not the stored list.
      const sameSetOf = (served, st) => {
        const ka = served.map(servedKey);
        const kb = new Set(st.map(identityKey));
        return ka.length === kb.size && new Set(ka).size === ka.length && ka.every((k) => kb.has(k));
      };
      const sentPlans = servedAll.filter((pl) => !pl.hidden);
      const sameSet = sameSetOf(servedAll, stored) && sameSetOf(sentPlans, stored.filter((pl) => !hiddenReason(pl)));
      // No two client-facing plans are one carrier plan, and no BenSync ID
      // is on two of the group's served plans (any slot).
      const dupShown = repeated(sentPlans.map(servedKey));
      const dupIds = repeated(list.filter((pp) => pp.slot !== "Cobalt").flatMap((pp) => (pp.plans || []).map((pl) => pl.optionId || null)));
      const mineIds = new Set(servedAll.map((pl) => pl.optionId).filter(Boolean));
      const dupIdsHere = dupIds.filter((id) => mineIds.has(id));
      const g4 = gridCounts(sentPlans, slot, g.tiers);
      const confirmedUnpriced = g4.unpriced.filter((pl) => Array.isArray(pl.unpriced) && TIERS.some((t) => g.tiers && g.tiers[t] && pl.rates && pl.rates[t] == null && pl.unpriced.includes(t)));
      const unexplained = g4.unpriced.length - confirmedUnpriced.length;
      // Every stored plan is shown when the slot is ON (an advanced per-plan
      // exception is the only thing that could hold one back; there are none).
      const visibleDistinct = stored.filter((pl) => !hiddenReason(pl)).length;
      const expected = visibleDistinct;
      cell.counts.visible = visibleDistinct;
      cell.counts.grid = g4.shown;
      cell.counts.client = cell.clientEnabled ? g4.shown : 0;
      if (dupShown.length || dupIdsHere.length) {
        steps.grid = { ok: false, note: `${dupShown.length ? `${dupShown.length} carrier plan${dupShown.length === 1 ? " is" : "s are"} served to the client twice.` : ""}${dupIdsHere.length ? ` BenSync ID${dupIdsHere.length === 1 ? "" : "s"} ${dupIdsHere.join(", ")} on two of the group's plans.` : ""}`.trim() };
        settle("grid", "refresh", row.id, false);
        continue;
      }
      // Each served plan carries its stored record's values: matched by
      // identity, then compared - the four rates and the BenSync ID.
      const byIdentity = new Map(stored.map((pl) => [identityKey(pl), pl]));
      const drifted = servedAll.filter((pl) => {
        const st = byIdentity.get(servedKey(pl));
        if (!st) return false;
        const r = pl.rates || {};
        const q = st.rates || {};
        return TIERS.some((t) => (r[t] ?? null) !== (q[t] ?? null)) || (pl.optionId !== undefined && (pl.optionId || null) !== (st.option_id || null));
      });
      if (!sv || sv.id !== row.id || !sameSet || drifted.length) {
        steps.grid = { ok: false, note: "The group's page is not showing this exact reading yet." };
        settle("grid", "refresh", row.id, false);
        continue;
      }
      if (unexplained) {
        steps.grid = { ok: false, note: `${unexplained} plan${unexplained === 1 ? " is" : "s are"} missing a rate for a tier this group has people in.` };
        settle("grid", "correct", row.id, false);
        continue;
      }
      if (g4.shown !== expected) {
        steps.grid = { ok: false, note: `${g4.shown} of ${expected} plans in the group's grid.` };
        settle("grid", "refresh", row.id, false);
        continue;
      }
      steps.grid = {
        ok: true,
        note: `Document ${cell.counts.document}, database ${storedDistinct}, grid ${g4.shown}; ${cell.clientEnabled ? `client ON: all ${g4.shown} shown` : "client OFF: none shown (the slot is turned off for this group)"}${hiddenPlans.length ? ` (${hiddenPlans.length} held back by an advanced exception: ${[...new Set(hiddenPlans.map((pl) => hiddenReason(pl)))].join("; ")})` : ""}${confirmedUnpriced.length ? ` (${confirmedUnpriced.length} the carrier does not price for a tier this group has people in: shown without a monthly figure)` : ""}.`,
      };
      cell.state = "verified";
    }
    for (const c of cells) {
      if (c.state === "missing") continue;
      const r = mine.find((rr) => rr.id === (c.proposalId ?? c.fixId));
      c.stage = stageOf(c, r, correcting);
      c.stageReason = c.state === "stuck" ? c.stuck || null : c.failedAt && c.steps[c.failedAt] ? c.steps[c.failedAt].note : null;
    }
    const filed = cells.filter((c) => c.state !== "missing");
    out.push({ group: g.name, cells, filed: filed.length, verified: filed.filter((c) => c.state === "verified").length });
  }
  const all = out.flatMap((g) => g.cells).filter((c) => c.state !== "missing");
  return {
    checkedAt: new Date().toISOString(),
    groups: out,
    totals: {
      filed: all.length,
      verified: all.filter((c) => c.state === "verified").length,
      working: all.filter((c) => c.state === "working").length,
      failing: all.filter((c) => c.state === "fail").length,
      stuck: all.filter((c) => c.state === "stuck").length,
      byStep: Object.fromEntries(["source", "extraction", "validation", "claude", "chatgpt", "grid"].map((k) => [k, all.filter((c) => c.state !== "verified" && c.failedAt === k).length])),
    },
  };
}

// The four-step check behind every filled box on the Proposals grid.
//
// For each live group and each slot that has a proposal on file, the
// proposal is held to four questions, in order, and the box turns green only
// when all four pass - with the plan count, the same at every step:
//
//   1. On file   - a proposal is on file for this group, in this slot.
//   2. Scanned   - the document has been read for its plans and the AI has
//                  counted every plan option it prices (EPO twins aside).
//   3. Database  - the database holds exactly that many plans, and both
//                  audit models agree every stored value matches the page.
//   4. Grid      - every one of those plans is in the group's 2027 Medical
//                  Plans grid, priced at the group's own census.
//
// An empty slot is not checked: it is just blank. Anything that fails names
// the repair that fixes it (`fix`), and the server's steward carries it out
// on its own - read again, audit, or correct against the document.
//
// Pure arithmetic over what is already stored - no model call - so the whole
// book is checked in milliseconds and the answer is the same every time.

const TIERS = ["EE", "ES", "EC", "FAM"];

const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const planKey = (pl) => `${normName(pl.name)}|${TIERS.map((t) => (pl.rates && pl.rates[t] != null ? pl.rates[t] : "")).join(",")}`;

/**
 * How the client's proposalPlans (client/src/lib/model.ts) treats a group's
 * served plans, reduced to counts: shown in the grid, dropped as a repeat of
 * a plan already shown, or dropped for want of a rate on a tier the group
 * has people in. Kept in step with that function; test-proposal-verify
 * checks the two agree.
 */
export function gridCounts(plans, slot, tiers) {
  const counts = tiers || {};
  const seen = new Set();
  let shown = 0;
  let repeats = 0;
  const unpriced = [];
  for (const pl of plans || []) {
    const rates = pl.rates || {};
    if (!TIERS.some((t) => rates[t] != null) || TIERS.some((t) => counts[t] && rates[t] == null)) {
      unpriced.push(pl);
      continue;
    }
    const k = `${slot}|${normName(pl.name)}|${TIERS.map((t) => rates[t] ?? "").join(",")}`;
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
 * Check every group. `groups`: [{ name, slots, tiers }] - live groups, the
 * slots each is quoted in, and its enrolled count per tier. `rows`: every
 * proposal row as stored. `served(name)`: the proposals the group's own page
 * is given (clientProposals). `isEpoPlan` / `isBlankPlan`: the server's own
 * rules for what is never offered or never a plan. `reading` / `auditing` /
 * `correcting`: ids with that step in flight. `gaveUp(id)`: the steward's
 * note when it has run out of repairs to try on a proposal.
 */
export function verifyProposals({ groups, rows, served, isEpoPlan, isBlankPlan, reading = new Set(), auditing = new Set(), correcting = new Set(), gaveUp = () => null }) {
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
      const steps = { filed: null, read: null, audited: null, loaded: null };
      const cell = {
        slot,
        proposalId: row ? row.id : null,
        filename: row ? row.filename : null,
        plans: 0,
        counts: { document: null, stored: null, grid: null },
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
        steps.filed = { ok: true, note: w.filename };
        const busy = busyRow(w, reading);
        steps.read = { ok: false, busy, note: busy ? "Being read now." : w.error ? `The read failed: ${w.error}` : "Not read yet." };
        settle("read", "read", w.id, busy);
        continue;
      }
      steps.filed = { ok: true, note: row.filename };
      const scorecard = slot === "Angle Scorecard";
      const x = row.extracted || {};
      const stored = (Array.isArray(x.plans) ? x.plans : []).filter((pl) => !isBlankPlan(pl) && !isEpoPlan(pl));
      const storedDistinct = new Set(stored.map(planKey)).size;
      cell.counts.stored = storedDistinct;
      cell.plans = storedDistinct;

      // 2. Scanned: read for its plans, and every plan counted on the page.
      const a = row.audit;
      const docCount = a && Number.isInteger(a.documentPlanCount) ? a.documentPlanCount : null;
      cell.counts.document = docCount;
      const readBusy = busyRow(row, reading) || waiting.some((w) => busyRow(w, reading));
      const failedWaiting = waiting.find((w) => !busyRow(w, reading));
      if (readBusy) {
        steps.read = { ok: false, busy: true, note: "Being read now." };
        settle("read", "read", row.id, true);
        continue;
      }
      if (!row.extracted || (!scorecard && !stored.length)) {
        steps.read = { ok: false, note: row.error ? `The read failed: ${row.error}` : row.extracted ? "The document read with no plans on it." : "Not read yet." };
        settle("read", "read", row.id, false);
        continue;
      }
      if (!scorecard) {
        const problems = [];
        const noName = stored.filter((pl) => !String(pl.name || "").trim()).length;
        if (noName) problems.push(`${noName} plan${noName === 1 ? " has" : "s have"} no name.`);
        const noRate = stored.filter((pl) => !TIERS.some((t) => pl.rates && pl.rates[t] != null)).length;
        if (noRate) problems.push(`${noRate} plan${noRate === 1 ? " has" : "s have"} no rate at all.`);
        if (problems.length) {
          steps.read = { ok: false, note: problems.join(" ") };
          settle("read", "correct", row.id, correcting.has(row.id));
          continue;
        }
      }
      if (failedWaiting) {
        steps.read = { ok: false, note: `A newer upload (${failedWaiting.filename}) could not be read${failedWaiting.error ? `: ${failedWaiting.error}` : ""}. This one stays in force until it does.` };
        settle("read", "read", failedWaiting.id, false);
        continue;
      }
      if (scorecard) {
        steps.read = { ok: true, note: "Read." };
        steps.audited = { ok: true, note: "A scorecard carries no rates to check." };
        steps.loaded = { ok: true, note: "Admin only - not part of the 2027 options." };
        cell.state = "verified";
        continue;
      }
      if (docCount == null) {
        const busy = auditing.has(row.id);
        steps.read = { ok: false, busy, note: busy ? "Counting the plans on the document now." : "The plans on the document have not been counted yet." };
        settle("read", "audit", row.id, busy);
        continue;
      }
      steps.read = { ok: true, note: `${docCount} plan${docCount === 1 ? "" : "s"} on the document.` };

      // 3. Database: the same count, and every value agreed by both models.
      if (auditing.has(row.id) || correcting.has(row.id)) {
        steps.audited = { ok: false, busy: true, note: correcting.has(row.id) ? "Correcting the database against the document now." : "Checking the database against the document now." };
        settle("audited", null, row.id, true);
        continue;
      }
      const problems3 = [];
      if (storedDistinct !== docCount) problems3.push(`The document has ${docCount} plan${docCount === 1 ? "" : "s"}; the database has ${storedDistinct}.`);
      if (a.status === "issues") problems3.push(`${(a.mismatches || []).length} value${(a.mismatches || []).length === 1 ? "" : "s"} differ from the document.`);
      if (a.status === "unreadable") problems3.push(a.notes || "The check could not run.");
      if (problems3.length) {
        steps.audited = { ok: false, note: problems3.join(" "), mismatches: (a.mismatches || []).slice(0, 12) };
        settle("audited", a.status === "unreadable" && storedDistinct === docCount ? "audit" : "correct", row.id, false);
        continue;
      }
      steps.audited = { ok: true, note: `${storedDistinct} plan${storedDistinct === 1 ? "" : "s"} in the database, every value matching the document (checked ${String(a.completedAt || "").slice(0, 10)}).` };

      // 4. Grid: every plan in the group's Medical Plans grid. The one plan
      // it may leave out is one the document itself does not price for a
      // tier this group has people in - confirmed against the page.
      const sentPlans = sv ? sv.plans || [] : [];
      const g4 = gridCounts(sentPlans, slot, g.tiers);
      const confirmedUnpriced = g4.unpriced.filter((pl) => Array.isArray(pl.unpriced) && TIERS.some((t) => g.tiers && g.tiers[t] && pl.rates && pl.rates[t] == null && pl.unpriced.includes(t)));
      const unexplained = g4.unpriced.length - confirmedUnpriced.length;
      const expected = storedDistinct - confirmedUnpriced.length;
      cell.counts.grid = g4.shown;
      cell.plans = g4.shown;
      if (sentPlans.length !== stored.length) {
        steps.loaded = { ok: false, note: `${stored.length} stored but ${sentPlans.length} reach the group's page.` };
        settle("loaded", "refresh", row.id, false);
        continue;
      }
      if (unexplained) {
        steps.loaded = { ok: false, note: `${unexplained} plan${unexplained === 1 ? " is" : "s are"} missing a rate for a tier this group has people in.` };
        settle("loaded", "correct", row.id, false);
        continue;
      }
      if (g4.shown !== expected) {
        steps.loaded = { ok: false, note: `${g4.shown} of ${expected} plans in the group's grid.` };
        settle("loaded", "refresh", row.id, false);
        continue;
      }
      steps.loaded = {
        ok: true,
        note: `${g4.shown} plan${g4.shown === 1 ? "" : "s"} in the group's 2027 Medical Plans grid${confirmedUnpriced.length ? ` (${confirmedUnpriced.length} the carrier does not price for a tier this group has people in)` : ""}.`,
      };
      cell.state = "verified";
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
      byStep: {
        read: all.filter((c) => c.state !== "verified" && c.failedAt === "read").length,
        audited: all.filter((c) => c.state !== "verified" && c.failedAt === "audited").length,
        loaded: all.filter((c) => c.state !== "verified" && c.failedAt === "loaded").length,
      },
    },
  };
}

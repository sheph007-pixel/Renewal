// The four-step check behind every filled box on the Proposals grid.
//
// For each live group and each slot it quotes, the proposal on file is taken
// through the same four questions, in order, and the box turns green only
// when all four pass:
//
//   1. Filed    - a proposal is on file for this group, in this slot.
//   2. Read     - its read finished: plans, each with a name and a rate, each
//                 numbered (UH3, GR12...), and no newer upload stuck beside it.
//   3. Audited  - both models checked the stored plans against the document
//                 and found nothing.
//   4. Loaded   - the plans stored are the plans the group's 2027 Medical
//                 Plans grid shows: the same count reaches the group's page,
//                 and every one is priced at the group's own census.
//
// Pure arithmetic over what is already stored - no model call - so the whole
// book is checked in milliseconds and the answer is the same every time.

const TIERS = ["EE", "ES", "EC", "FAM"];

const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

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
    if (!TIERS.some((t) => rates[t] != null)) {
      unpriced.push(pl.name || pl.optionId || "?");
      continue;
    }
    if (TIERS.some((t) => counts[t] && rates[t] == null)) {
      unpriced.push(pl.name || pl.optionId || "?");
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

/**
 * Check every group. `groups`: [{ name, slots, tiers }] - live groups, the
 * slots each is quoted in, and its enrolled count per tier. `rows`: every
 * proposal row as stored. `served(name)`: the proposals the group's own page
 * is given (clientProposals). `isEpoPlan` / `isBlankPlan`: the server's own
 * rules for what is never offered or never a plan. `reading`: ids with a
 * read in flight.
 */
export function verifyProposals({ groups, rows, served, isEpoPlan, isBlankPlan, reading = new Set(), auditing = new Set() }) {
  const out = [];
  for (const g of groups) {
    const mine = rows.filter((r) => r.group_name === g.name && r.status !== "container" && r.kind !== "invoice" && r.kind !== "email");
    const list = served(g.name) || [];
    const cells = [];
    for (const slot of g.slots) {
      const inSlot = mine.filter((r) => r.slot === slot && r.status === "assigned" && !r.superseded_by);
      const sv = list.find((p) => p.slot === slot);
      const row = (sv && inSlot.find((r) => r.id === sv.id)) || null;
      // A newer upload waiting beside the proposal in force: still being
      // read, or its read failed. It takes over only once it reads.
      const waiting = inSlot.filter((r) => !row || r.id !== row.id);
      const steps = { filed: null, read: null, audited: null, loaded: null };
      const cell = { slot, proposalId: row ? row.id : null, filename: row ? row.filename : null, plans: 0, steps, waiting: waiting.map((r) => ({ id: r.id, filename: r.filename, reading: r.status === "analyzing" || reading.has(r.id), error: r.error || null })) };
      cells.push(cell);

      // 1. Filed
      if (!row && !waiting.length) {
        steps.filed = { ok: false, note: "No proposal on file." };
        cell.state = "missing";
        continue;
      }
      if (!row) {
        // Only an upload that has not read yet: filed, but nothing in force.
        const w = waiting[0];
        steps.filed = { ok: true, note: w.filename };
        steps.read = w.status === "analyzing" || reading.has(w.id) ? { ok: false, busy: true, note: "Being read now." } : { ok: false, note: w.error ? `The read failed: ${w.error}` : "Not read yet." };
        cell.state = steps.read.busy ? "working" : "fail";
        cell.failedAt = "read";
        cell.fixId = w.id;
        cell.fix = steps.read.busy ? null : "read";
        continue;
      }
      steps.filed = { ok: true, note: row.filename };

      // 2. Read
      const x = row.extracted || {};
      const stored = (Array.isArray(x.plans) ? x.plans : []).filter((pl) => !isBlankPlan(pl) && !isEpoPlan(pl));
      const scorecard = slot === "Angle Scorecard";
      const readProblems = [];
      if (row.status === "analyzing" || reading.has(row.id)) readProblems.push("Being read now.");
      else if (!row.extracted) readProblems.push(row.error ? `The read failed: ${row.error}` : "Not read yet.");
      else if (!scorecard) {
        if (!stored.length) readProblems.push("The reading has no plans.");
        const noName = stored.filter((pl) => !String(pl.name || "").trim()).length;
        if (noName) readProblems.push(`${noName} plan${noName === 1 ? " has" : "s have"} no name.`);
        const noRate = stored.filter((pl) => !TIERS.some((t) => pl.rates && pl.rates[t] != null)).length;
        if (noRate) readProblems.push(`${noRate} plan${noRate === 1 ? " has" : "s have"} no rate at all.`);
        const noId = stored.filter((pl) => !pl.option_id).length;
        if (noId) readProblems.push(`${noId} plan${noId === 1 ? " is" : "s are"} not numbered.`);
      }
      for (const w of waiting) {
        readProblems.push(
          w.status === "analyzing" || reading.has(w.id)
            ? `A newer upload (${w.filename}) is being read; it replaces this one once it reads.`
            : `A newer upload (${w.filename}) could not be read${w.error ? `: ${w.error}` : ""}. This one stays in force until it does.`,
        );
      }
      const busy = row.status === "analyzing" || reading.has(row.id) || waiting.some((w) => w.status === "analyzing" || reading.has(w.id));
      steps.read = readProblems.length ? { ok: false, busy, note: readProblems.join(" ") } : { ok: true, note: scorecard ? "Read." : `${stored.length} plan${stored.length === 1 ? "" : "s"} read, each named, rated and numbered.` };
      if (!steps.read.ok) {
        cell.state = busy ? "working" : "fail";
        cell.failedAt = "read";
        const failedWaiting = waiting.find((w) => !(w.status === "analyzing" || reading.has(w.id)));
        cell.fixId = !row.extracted || !stored.length ? row.id : failedWaiting ? failedWaiting.id : row.id;
        cell.fix = busy ? null : failedWaiting && row.extracted && stored.length ? "read-waiting" : "read";
        cell.plans = stored.length;
        if (!row.extracted || (!stored.length && !scorecard)) continue;
      }

      // 3. Audited
      const a = row.audit;
      if (scorecard) steps.audited = { ok: true, note: "A scorecard carries no rates to audit." };
      else if (auditing.has(row.id)) steps.audited = { ok: false, busy: true, note: "Being audited now." };
      else if (!a) steps.audited = { ok: false, note: "Not audited yet." };
      else if (a.status === "pass") steps.audited = { ok: true, note: `Both models agree with the document (${String(a.completedAt || "").slice(0, 10)}).` };
      else if (a.status === "issues") steps.audited = { ok: false, note: `${(a.mismatches || []).length} value${(a.mismatches || []).length === 1 ? "" : "s"} the document contradicts.`, mismatches: (a.mismatches || []).slice(0, 12) };
      else steps.audited = { ok: false, note: a.notes || "The audit could not run." };

      // 4. Loaded
      if (scorecard) {
        steps.loaded = { ok: true, note: "Admin only - not part of the 2027 options." };
      } else {
        const sentPlans = sv ? sv.plans || [] : [];
        const g4 = gridCounts(sentPlans, slot, g.tiers);
        const problems = [];
        if (sentPlans.length !== stored.length) problems.push(`${stored.length} stored but ${sentPlans.length} reach the group's page.`);
        if (g4.unpriced.length) problems.push(`${g4.unpriced.length} plan${g4.unpriced.length === 1 ? " lacks" : "s lack"} a rate for a tier this group has people in, so ${g4.unpriced.length === 1 ? "it is" : "they are"} not shown: ${g4.unpriced.slice(0, 4).join(", ")}${g4.unpriced.length > 4 ? "…" : ""}.`);
        if (!g4.shown) problems.push("Nothing shows in the group's grid.");
        cell.plans = g4.shown;
        cell.repeats = g4.repeats;
        steps.loaded = problems.length
          ? { ok: false, note: problems.join(" ") }
          : { ok: true, note: `${g4.shown} plan${g4.shown === 1 ? "" : "s"} in the group's 2027 Medical Plans grid${g4.repeats ? ` (${g4.repeats} printed twice on the quote, shown once)` : ""}.` };
      }

      if (cell.state) continue; // a read problem already decided it
      const order = ["read", "audited", "loaded"];
      const first = order.find((k) => !steps[k].ok);
      if (!first) {
        cell.state = "verified";
      } else {
        cell.state = steps[first].busy ? "working" : "fail";
        cell.failedAt = first;
        cell.fixId = row.id;
        // What one click can do about it: audit an unaudited reading, re-read
        // one the audit found wrong or that does not load. Nothing else.
        cell.fix = steps[first].busy ? null : first === "audited" && (!a || a.status !== "issues") ? "audit" : "read";
      }
    }
    const filed = cells.filter((c) => c.state !== "missing");
    out.push({
      group: g.name,
      cells,
      filed: filed.length,
      verified: filed.filter((c) => c.state === "verified").length,
    });
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
      byStep: {
        read: all.filter((c) => c.state === "fail" && c.failedAt === "read").length,
        audited: all.filter((c) => c.state === "fail" && c.failedAt === "audited").length,
        loaded: all.filter((c) => c.state === "fail" && c.failedAt === "loaded").length,
      },
    },
  };
}

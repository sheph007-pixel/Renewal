// The data check: every group on the roster, checked against itself and
// against every other file the portal holds about it, so a wrong figure is
// found here before a client reads it on a page or hears it from the
// assistant.
//
// The snapshot audit (audit.js) reconciles the three Employee Navigator files
// with each other in aggregate. This one is per company: does the enrolled
// count add up the same way everywhere, does the premium, is there a billed
// rate behind every tier the pages price, is the employer/employee split on
// file, does this month's billing agree, are the 2027 quotes usable, and —
// the check that started it — is the headcount Employee Navigator reports
// for the company a number anyone should repeat. Aggregates only, like
// everything else that leaves the server: no member is named in a result.
import { classifyPlans, premiumBreakdown, tierKeyOf } from "./en-parse.js";

const r2 = (n) => Math.round(n * 100) / 100;
const close = (a, b, tolFrac, tolAbs) => Math.abs(a - b) <= Math.max(tolAbs, tolFrac * Math.abs(b));
const money0 = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const money2 = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TIER_KEYS = ["EE", "ES", "EC", "FAM"];
const TIER_CENSUS = { EE: "Employee", ES: "Employee + Spouse", EC: "Employee + Child(ren)", FAM: "Employee + Family" };
const LEVEL_RANK = { ok: 0, info: 0, warn: 1, fail: 2 };
/** Gravie prices the same designs for every group: 67 on its PPO sheet. */
export const GRAVIE_PPO_PLANS = 67;

/** What each check looks at, in the order the screen lists them. */
export const CHECKS = [
  { key: "count", label: "Enrolled count" },
  { key: "premium", label: "Premium" },
  { key: "tiers", label: "Coverage tiers" },
  { key: "rates", label: "Billed rates" },
  { key: "split", label: "Employer/employee split" },
  { key: "roster", label: "Headcount" },
  { key: "size", label: "Size category" },
  { key: "carrier", label: "Program carrier" },
  { key: "billing", label: "This month's billing" },
  { key: "lines", label: "Supplemental lines" },
  { key: "quotes", label: "2027 quotes" },
  { key: "manager", label: "Account manager" },
  { key: "access", label: "Client access" },
  { key: "import", label: "Import" },
  { key: "identity", label: "Identity" },
];
const LABEL = Object.fromEntries(CHECKS.map((c) => [c.key, c.label]));

/**
 * Active (non-terminated) headcount from a group's stored import
 * diagnostics — every <Employee> in the company's Employee Navigator record
 * whose status is not terminated. Read fresh off the counts kept with the
 * import rather than the value frozen at import time, so a change to the
 * rule applies to every group already in the database. Null when the group
 * was imported before the counts were kept (or is the shipped census).
 *
 * This is NOT an eligible count, and it is never shown to a client or to
 * the assistant: Employee Navigator's "Active" status covers anyone not
 * marked terminated — part-time and PRN staff, people in classes that are
 * not benefit-eligible, and records nobody ever closed — so on some groups
 * it runs to many times the enrolled figure. It is kept for staff to judge.
 */
export function rosterHeadcount(g) {
  const employees = g && g.diagnostics && g.diagnostics.employees;
  if (employees && typeof employees.total === "number") {
    const skipped = Object.values(employees.skipped || {}).reduce((n, x) => n + x, 0);
    return employees.total - skipped;
  }
  return typeof g.medicalEligible === "number" ? g.medicalEligible : null;
}

/**
 * One group. `g` is the server's full group (members, rates, diagnostics);
 * `admin` its staff row (size category and whether staff set it, duplicates,
 * link token); `split` the employer/employee split in force; `proposals` the
 * current 2027 quotes; `billing` this month's funding summary for the group
 * (or null) with `fundingMonth` naming the month on file (or null when no
 * workbook is in); `manager` the account manager key; `latestImportAt` when
 * the newest export was applied.
 */
export function auditGroup({ g, admin = {}, split = null, proposals = [], billing = null, fundingMonth = null, manager = null, latestImportAt = null }) {
  const checks = [];
  const add = (key, level, detail) => checks.push({ key, label: LABEL[key] || key, level, detail });
  const members = Array.isArray(g.members) ? g.members : null;
  // Each plan with its program and whether it is group health, the way the
  // Groups page classifies them; the raw import row carries neither.
  const plans = classifyPlans(g);
  const breakdown = premiumBreakdown(g);
  const enrolled = Number(g.enrolled) || 0;

  // Enrolled: the same number wherever it is added up.
  {
    const fromPlans = plans.reduce((n, p) => n + (Number(p.enrolled) || 0), 0);
    const fromTiers = g.tiers ? TIER_KEYS.reduce((n, k) => n + (Number(g.tiers[k]) || 0), 0) : null;
    const fromMembers = members ? members.length : null;
    const parts = [`${enrolled} enrolled`, `plans add to ${fromPlans}`];
    if (fromTiers != null) parts.push(`tiers add to ${fromTiers}`);
    if (fromMembers != null) parts.push(`${fromMembers} on the census`);
    const off = fromPlans !== enrolled || (fromTiers != null && fromTiers !== enrolled) || (fromMembers != null && fromMembers !== enrolled);
    add("count", off ? "fail" : "ok", off ? `The enrolled count does not add up the same way everywhere: ${parts.join(", ")}. Re-import the group.` : `${parts.join(", ")}; covered lives ${g.lives ?? "—"}.`);
  }

  // Premium: the group total, its plans and its census agree.
  {
    const monthly = Number(g.monthly) || 0;
    const fromPlans = r2(plans.reduce((n, p) => n + (Number(p.monthly) || 0), 0));
    const fromMembers = members ? r2(members.reduce((n, m) => n + (Number(m.premium) || 0), 0)) : null;
    const bad = [];
    if (!close(fromPlans, monthly, 0.001, 1)) bad.push(`plans add to ${money0(fromPlans)}`);
    if (fromMembers != null && !close(fromMembers, monthly, 0.001, 1)) bad.push(`the census adds to ${money0(fromMembers)}`);
    const annual = Number(g.annual);
    if (Number.isFinite(annual) && !close(annual, monthly * 12, 0.001, 1)) bad.push(`annual on file is ${money0(annual)}, not ${money0(monthly * 12)}`);
    add("premium", bad.length ? "fail" : "ok", bad.length ? `Medical premium on file is ${money0(monthly)}/mo but ${bad.join(" and ")}.` : `${money0(monthly)}/mo medical (${money0(monthly * 12)}/yr)${breakdown.supplementalMonthly ? `, ${money0(breakdown.supplementalMonthly)}/mo supplemental` : ""}.`);
  }

  // Tiers: every enrolled person filed under a tier the pages can price.
  if (members) {
    const unmapped = members.filter((m) => !tierKeyOf(m.tier));
    add("tiers", unmapped.length ? "warn" : "ok", unmapped.length ? `${unmapped.length} enrolled on a coverage level the import could not read (filed as employee-only): ${[...new Set(unmapped.map((m) => m.tier || "(blank)"))].join(", ")}.` : `EE ${g.tiers?.EE ?? 0} · ES ${g.tiers?.ES ?? 0} · EC ${g.tiers?.EC ?? 0} · FAM ${g.tiers?.FAM ?? 0}.`);
  } else if (g.tiers) {
    add("tiers", "ok", `EE ${g.tiers.EE ?? 0} · ES ${g.tiers.ES ?? 0} · EC ${g.tiers.EC ?? 0} · FAM ${g.tiers.FAM ?? 0} (no census on this row).`);
  }

  // Heads per plan and tier, from the census — what the pages price and what
  // the month's billing is checked against.
  const counts = {};
  for (const m of members || []) {
    const k = tierKeyOf(m.tier) || "EE";
    const c = (counts[m.plan] = counts[m.plan] || { EE: 0, ES: 0, EC: 0, FAM: 0 });
    c[k]++;
  }

  // Rates: a billed rate for every tier somebody is in, and the rates times
  // the heads coming to what the plan bills.
  {
    const rates = g.rates || {};
    const missing = [];
    const offSchedule = [];
    let billedTiers = 0;
    for (const p of plans) {
      const c = counts[p.plan];
      const pr = rates[p.plan] || {};
      if (!c) continue;
      let expect = 0;
      let complete = true;
      for (const k of TIER_KEYS) {
        if (!c[k]) continue;
        const r = pr[TIER_CENSUS[k]];
        if (r == null) {
          missing.push(`${p.plan} ${k}`);
          complete = false;
          continue;
        }
        billedTiers++;
        expect += Number(r) * c[k];
      }
      if (complete && expect && !close(expect, Number(p.monthly) || 0, 0.01, 5)) offSchedule.push(`${p.plan} bills ${money0(p.monthly)} but its rates × enrolled give ${money0(expect)}`);
    }
    if (!plans.length) add("rates", "warn", "No medical plans on file.");
    else if (missing.length) add("rates", "warn", `No billed rate for ${missing.length} enrolled tier${missing.length === 1 ? "" : "s"} (${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}); the pages show a calculated rate there.`);
    else if (offSchedule.length) add("rates", "warn", `${offSchedule.join("; ")}. Someone on the plan is billed a different amount from the tier rate.`);
    else add("rates", "ok", `${billedTiers} billed tier rate${billedTiers === 1 ? "" : "s"} across ${plans.length} plan${plans.length === 1 ? "" : "s"}, and they reproduce every plan's premium.`);
  }

  // Split: what the employer pays, from payroll — or nothing, and the pages say Pending.
  {
    const n = split && split.plans ? Object.values(split.plans).reduce((s, tiers) => s + Object.keys(tiers).length, 0) : 0;
    add("split", n ? "ok" : "info", n ? `Employer/employee split from Employee Navigator on ${n} plan-tier${n === 1 ? "" : "s"}.` : "No employer/employee split on file: the pages show Pending, and the assistant cannot say what employees pay today.");
  }

  // Headcount: what Employee Navigator lists against what is enrolled.
  const roster = rosterHeadcount(g);
  {
    const heads = g.carrierHeads ? Math.max(0, ...Object.values(g.carrierHeads)) : null;
    if (roster == null) add("roster", "info", "No roster headcount kept for this group (shipped census, or imported before the counts were kept). Only the enrolled figure is on file.");
    else if (roster < enrolled) add("roster", "fail", `Employee Navigator lists ${roster} non-terminated employees but ${enrolled} are enrolled in medical. The import is inconsistent; re-import the group.`);
    else {
      const gap = roster - enrolled;
      const inflated = gap > 20 && roster > enrolled * 3;
      const onAnyLine = heads != null ? ` At least ${heads} are on some benefit line.` : "";
      add(
        "roster",
        inflated ? "warn" : "ok",
        inflated
          ? `Employee Navigator lists ${roster} employees with status Active against ${enrolled} enrolled in medical — ${gap} with no medical at all.${onAnyLine} EN's Active status covers part-time and PRN staff, classes that are not benefit-eligible and records nobody closed, so this is not a headcount anyone should quote. It is not shown to the client or the assistant; if the client needs a true count, it comes from their census.`
          : `${roster} on the Employee Navigator roster, ${enrolled} enrolled in medical.${onAnyLine}`,
      );
    }
  }

  // Size: the ALE bucket the client sees, and whether staff confirmed it.
  {
    const cat = admin.sizeCategory || g.sizeCategory || null;
    const set = !!admin.sizeIsSet;
    const byEnrolled = enrolled >= 51 ? "51+" : "2-50";
    const byRoster = roster != null ? (roster >= 51 ? "51+" : "2-50") : null;
    if (!cat) add("size", "warn", "No size category; the client's pages cannot show Group Size.");
    else if (set) add("size", "ok", `${cat}, set by staff. The client's pages show it as Group Size.`);
    else if (byRoster && byRoster !== byEnrolled) add("size", "warn", `Defaulted to ${cat} from ${enrolled} enrolled, but the Employee Navigator roster has ${roster} — the ALE call could go either way. Set it on the company page; the client's pages show it as Group Size.`);
    else add("size", "info", `Defaulted to ${cat} from ${enrolled} enrolled; not confirmed by staff. The client's pages show it as Group Size.`);
  }

  // Carrier: on a program carrier, with every plan's carrier read.
  {
    const assumed = plans.filter((p) => p.assumed).map((p) => p.plan);
    const unknown = plans.filter((p) => !p.program && !p.assumed).map((p) => `${p.plan} (${p.tpa || "no carrier"})`);
    if (g.eligible === false) add("carrier", "fail", `Not on a program carrier: ${(g.carriersSeen || []).join(", ") || "no carrier read"}. The code is refused at sign-in.`);
    else if (unknown.length) add("carrier", "warn", `${unknown.length} plan${unknown.length === 1 ? "" : "s"} on a carrier the portal does not recognise: ${unknown.join(", ")}.`);
    else if (assumed.length) add("carrier", "warn", `No carrier could be read for ${assumed.join(", ")}; taken as group health because every other plan is.`);
    else add("carrier", "ok", `${(g.programs || []).join(", ") || g.tpa || "—"}${g.tpa && (g.programs || []).length > 1 ? ` (billed under ${g.tpa})` : ""}.`);
  }

  // Billing: this month's funding workbook against the XML for the captive
  // plans — the group's totals, then every billed plan and tier against the
  // census's heads and the XML's billed rate for that tier.
  {
    const xmlN = breakdown.groupHealthEnrolled;
    const xml$ = breakdown.groupHealthMonthly;
    if (!fundingMonth) add("billing", "info", "No funding workbook uploaded yet.");
    else if (!billing) add("billing", xmlN ? "warn" : "info", xmlN ? `No invoice filed under this group in the ${fundingMonth} workbook, though ${xmlN} are enrolled on the captive plans.` : `Nothing billed in ${fundingMonth}; the group has no captive-program medical.`);
    else {
      const billN = billing.medical?.participants || 0;
      const bill$ = billing.medical?.monthly || 0;
      const totalsOk = close(bill$, xml$, 0.01, 50) && close(billN, xmlN, 0.02, 2);
      const inXml = new Map(plans.map((p) => [p.plan, p]));
      const rates = g.rates || {};
      const diffs = [];
      const extra = [];
      let tiersChecked = 0;
      for (const [plan, p] of Object.entries(billing.medical?.byPlan || {})) {
        const xp = inXml.get(plan);
        if (!xp) {
          extra.push(`${plan} (${p.lines} billed)`);
          continue;
        }
        if (!members) {
          // No census on this row: the plan's headcount is all there is to compare.
          if (Math.abs((p.lines || 0) - (xp.enrolled || 0)) > 2) diffs.push(`${plan}: ${p.lines} billed, ${xp.enrolled} in the XML`);
          continue;
        }
        for (const [tier, t] of Object.entries(p.byTier || {})) {
          const k = tierKeyOf(tier);
          if (!k) continue;
          tiersChecked++;
          const xmlHeads = (counts[plan] || {})[k] || 0;
          const xmlRate = rates[plan] ? rates[plan][tier] : null;
          if (Math.abs((t.n || 0) - xmlHeads) > 1) diffs.push(`${plan} ${k}: ${t.n} billed, ${xmlHeads} in the XML`);
          if (t.rate != null && xmlRate != null && Math.abs(Number(t.rate) - Number(xmlRate)) > 0.01) diffs.push(`${plan} ${k}: billed at ${money2(t.rate)}, the XML's rate is ${money2(xmlRate)}`);
        }
      }
      const ok = totalsOk && !diffs.length && !extra.length;
      const head = `${fundingMonth}: ${billN} participants, ${money0(bill$)} billed; the XML has ${xmlN} enrolled at ${money0(xml$)}.`;
      const tail = [
        totalsOk ? null : "The month's total and the export disagree — a hire or termination since the export, or a rate change.",
        diffs.length ? `Plan by plan: ${diffs.slice(0, 8).join("; ")}${diffs.length > 8 ? `; and ${diffs.length - 8} more` : ""}.` : null,
        extra.length ? `Billed but not in this group's XML: ${extra.join(", ")}.` : null,
        ok && tiersChecked ? ` Every billed plan and tier agrees with the census and the XML's rates (${tiersChecked} tier${tiersChecked === 1 ? "" : "s"} checked).` : null,
      ].filter(Boolean);
      add("billing", ok ? "ok" : "warn", [head, ...tail].join(" ").replace(/\s+/g, " "));
    }
  }

  // Supplemental lines.
  {
    const lines = Array.isArray(g.lines) ? g.lines : null;
    if (!lines) add("lines", "info", "Supplemental lines not captured for this group; total premium shows as medical only until the export is re-imported.");
    else add("lines", "ok", lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"} (${[...new Set(lines.map((l) => l.benefit))].slice(0, 6).join(", ")}), ${money0(lines.reduce((n, l) => n + (l.monthly || 0), 0))}/mo.` : "No dental, vision, life or disability in force.");
  }

  // 2027 quotes on file.
  {
    const list = Array.isArray(proposals) ? proposals : [];
    if (!list.length) add("quotes", "info", "No 2027 quotes on file yet; the Options page and the assistant say so.");
    else {
      const problems = [];
      const summary = [];
      for (const pr of list) {
        const pl = pr.plans || [];
        const noRates = pl.filter((x) => !x.rates || TIER_KEYS.every((k) => x.rates[k] == null));
        summary.push(`${pr.carrier || pr.slot} (${pl.length} plan${pl.length === 1 ? "" : "s"})`);
        if (!pl.length) problems.push(`${pr.carrier || pr.slot} has no plans read off it`);
        else if (noRates.length) problems.push(`${pr.carrier || pr.slot}: ${noRates.length} of ${pl.length} plans have no rates`);
        if (pr.enrolledOnDocument != null && enrolled && !close(pr.enrolledOnDocument, enrolled, 0.1, 2)) problems.push(`${pr.carrier || pr.slot} is priced on ${pr.enrolledOnDocument} enrolled; the group has ${enrolled}`);
        // Kennion offers PPO plans only: no EPO twin belongs on any quote,
        // and every group's Gravie quote is the same 67 PPO designs.
        const epo = pl.filter((x) => /\bEPO\b/i.test(`${x.network || ""} ${x.planType || ""} ${x.name || ""}`)).length;
        if (epo) problems.push(`${pr.carrier || pr.slot}: ${epo} EPO plan${epo === 1 ? "" : "s"} stored — Kennion offers PPO only; re-read the proposal`);
        if (pr.slot === "Gravie" && pl.length && pl.length - epo !== GRAVIE_PPO_PLANS) problems.push(`Gravie: ${pl.length - epo} PPO plans stored; every group's Gravie quote is the same ${GRAVIE_PPO_PLANS} designs`);
      }
      add("quotes", problems.length ? "warn" : "ok", `${summary.join(", ")}.${problems.length ? ` ${problems.join("; ")}.` : ""}`);
    }
  }

  // Who looks after it, and whether the client can get in.
  add("manager", manager ? "ok" : "warn", manager ? `${manager}.` : "No account manager assigned; the assistant names the fallback contact.");
  if (g.archived) add("access", "info", "Archived: the code and link are refused.");
  else add("access", admin.linkToken || g.linkToken ? "ok" : "warn", admin.linkToken || g.linkToken ? `Code ${g.code || "—"}; permanent link minted.` : `Code ${g.code || "—"}; no permanent link yet.`);

  // Where the data came from and how fresh it is.
  {
    const at = admin.importedAt || null;
    if (!at) add("import", "info", "Shipped census; never imported from Employee Navigator.");
    else if (latestImportAt && new Date(at).getTime() < new Date(latestImportAt).getTime() - 24 * 3600 * 1000) add("import", "warn", `Imported ${String(at).slice(0, 10)}, but the latest export (${String(latestImportAt).slice(0, 10)}) did not carry this company.`);
    else add("import", "ok", `Imported ${String(at).slice(0, 10)}${g.enName && g.enName !== g.name ? ` as "${g.enName}"` : ""}.`);
  }
  {
    const dupes = admin.duplicateOf || [];
    const contacts = Array.isArray(g.contacts) ? g.contacts.length : 0;
    if (dupes.length) add("identity", "warn", `Looks like the same company as ${dupes.join(", ")}; archive the stale one.`);
    else add("identity", contacts ? "ok" : "info", contacts ? `${contacts} contact${contacts === 1 ? "" : "s"} on file${g.enIdentifier ? `; EN id ${g.enIdentifier}` : ""}.` : "No company contacts in the export.");
  }

  const worst = checks.reduce((w, c) => Math.max(w, LEVEL_RANK[c.level] || 0), 0);
  return {
    name: g.name,
    code: g.code || null,
    archived: !!g.archived,
    eligible: g.eligible !== false,
    status: worst === 2 ? "fail" : worst === 1 ? "warn" : "ok",
    figures: {
      enrolled,
      lives: g.lives ?? null,
      monthly: r2(Number(g.monthly) || 0),
      roster,
      plans: plans.length,
      sizeCategory: admin.sizeCategory || g.sizeCategory || null,
      quotes: Array.isArray(proposals) ? proposals.length : 0,
      manager: manager || null,
      importedAt: admin.importedAt || null,
    },
    checks,
  };
}

/**
 * Every group. `bundles` is one auditGroup input per group; live groups are
 * checked in full, archived and not-in-program ones are listed with a note so
 * the roster is complete but the counts describe what the portal serves.
 */
export function auditData(bundles) {
  const rows = [];
  for (const b of bundles) {
    const live = !b.g.archived && b.g.eligible !== false;
    if (live) rows.push(auditGroup(b));
    else {
      rows.push({
        name: b.g.name,
        code: b.g.code || null,
        archived: !!b.g.archived,
        eligible: b.g.eligible !== false,
        status: "skip",
        figures: { enrolled: Number(b.g.enrolled) || 0, lives: b.g.lives ?? null, monthly: r2(Number(b.g.monthly) || 0), roster: rosterHeadcount(b.g), plans: (b.g.plans || []).length, sizeCategory: null, quotes: 0, manager: b.manager || null, importedAt: (b.admin && b.admin.importedAt) || null },
        checks: [{ key: "carrier", label: LABEL.carrier, level: "info", detail: b.g.archived ? "Archived; not served, not checked." : `Not in the program (${(b.g.carriersSeen || []).join(", ") || "no carrier read"}); not served, not checked.` }],
      });
    }
  }
  rows.sort((a, b) => (LEVEL_RANK[b.status === "skip" ? "ok" : b.status] || 0) - (LEVEL_RANK[a.status === "skip" ? "ok" : a.status] || 0) || (a.status === "skip") - (b.status === "skip") || a.name.localeCompare(b.name));

  const checked = rows.filter((r) => r.status !== "skip");
  const byCheck = {};
  for (const c of CHECKS) byCheck[c.key] = { label: c.label, warn: 0, fail: 0 };
  for (const r of checked) for (const c of r.checks) if (c.level === "warn" || c.level === "fail") byCheck[c.key][c.level]++;
  const counts = {
    checked: checked.length,
    ok: checked.filter((r) => r.status === "ok").length,
    warn: checked.filter((r) => r.status === "warn").length,
    fail: checked.filter((r) => r.status === "fail").length,
    skipped: rows.length - checked.length,
  };
  const top = Object.values(byCheck)
    .map((c) => ({ ...c, n: c.warn + c.fail }))
    .filter((c) => c.n)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((c) => `${c.label.toLowerCase()} (${c.n})`);
  let headline;
  if (!checked.length) headline = "No live groups to check.";
  else if (!counts.warn && !counts.fail) headline = `All ${counts.checked} groups are in order.`;
  else headline = `${counts.ok} of ${counts.checked} groups in order; ${counts.fail ? `${counts.fail} with a problem, ` : ""}${counts.warn} to look at. Most often: ${top.join(", ")}.`;
  return { generated: new Date().toISOString(), headline, counts, byCheck, checks: CHECKS, rows };
}

/**
 * The stored export, re-read, against what the portal holds. `companies` is
 * a fresh parse of the gzip kept with the last import (parseEnStream's
 * output); `groups` the server's groups; `match` finds a group for an
 * export name the way an import does (exact, then normalised). A company
 * whose figures differ from its group is listed field by field, so drift —
 * a partial import, a re-import that skipped it, an edit by hand — shows up
 * as what changed rather than as a bare "differs".
 */
export function compareToExport(companies, groups, match) {
  const seen = new Set();
  const differ = [];
  const missingFromPortal = [];
  let matched = 0;
  for (const c of companies) {
    const x = c.group;
    const g = match(x.name);
    if (!g) {
      missingFromPortal.push({ name: x.name, enrolled: x.enrolled, monthly: r2(x.monthly || 0) });
      continue;
    }
    seen.add(g.name);
    const fields = [];
    if ((x.enrolled || 0) !== (g.enrolled || 0)) fields.push(`enrolled ${g.enrolled} in the portal, ${x.enrolled} in the export`);
    if (!close(x.monthly || 0, g.monthly || 0, 0.001, 1)) fields.push(`medical ${money0(g.monthly)} in the portal, ${money0(x.monthly)} in the export`);
    if ((x.lives || 0) !== (g.lives || 0)) fields.push(`covered lives ${g.lives} / ${x.lives}`);
    const gp = new Map((g.plans || []).map((p) => [p.plan, p]));
    for (const p of x.plans || []) {
      const q = gp.get(p.plan);
      if (!q) fields.push(`plan ${p.plan} (${p.enrolled} enrolled) is in the export, not the portal`);
      else if ((q.enrolled || 0) !== (p.enrolled || 0) || !close(q.monthly || 0, p.monthly || 0, 0.001, 1)) fields.push(`${p.plan}: ${q.enrolled} at ${money0(q.monthly)} in the portal, ${p.enrolled} at ${money0(p.monthly)} in the export`);
      gp.delete(p.plan);
    }
    for (const q of gp.values()) fields.push(`plan ${q.plan} (${q.enrolled} enrolled) is in the portal, not the export`);
    const gl = Array.isArray(g.lines) ? g.lines.length : null;
    const xl = Array.isArray(x.lines) ? x.lines.length : 0;
    if (gl != null && gl !== xl) fields.push(`${gl} supplemental line${gl === 1 ? "" : "s"} in the portal, ${xl} in the export`);
    if (fields.length) differ.push({ name: g.name, fields });
    else matched++;
  }
  const notInFile = groups.filter((g) => !seen.has(g.name) && !g.archived && g.eligible !== false).map((g) => ({ name: g.name, enrolled: g.enrolled || 0 }));
  return { companies: companies.length, matched, differ, missingFromPortal, notInFile };
}

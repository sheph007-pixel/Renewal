// The audit that runs itself once the three Employee Navigator files are in:
// the XML export against the carrier stats report, carrier by carrier on the
// report's own basis, and the month's billing against the XML, group by
// group. One verdict, in plain words, for the top of the Import tab; the
// per-carrier and per-group rows underneath it. Aggregates only.
import { matchCarrier } from "./eligibility.js";

/** Loose equality for carrier names from two sources: case, spacing, punctuation. */
export const carrierKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const r2 = (n) => Math.round(n * 100) / 100;
const close = (a, b, tolFrac, tolAbs) => Math.abs(a - b) <= Math.max(tolAbs, tolFrac * Math.abs(b));

/**
 * Every carrier in the report against what the portal holds, added up the
 * way the report counts: every line a carrier has, distinct employees,
 * archived groups included. A carrier the report names twice is one row.
 */
export function reconcileCarriers(stats, groups) {
  if (!stats) return [];
  const merged = new Map();
  for (const r of stats.rows || []) {
    const k = matchCarrier(r.carrier) || carrierKey(r.carrier);
    const m = merged.get(k);
    if (!m) merged.set(k, { carrier: r.carrier, enrolled: r.enrolled, companies: r.companies, planCosts: r.planCosts, rows: 1 });
    else {
      if (r.planCosts > m.planCosts) m.carrier = r.carrier;
      m.enrolled += r.enrolled;
      m.companies += r.companies;
      m.planCosts += r.planCosts;
      m.rows++;
    }
  }
  return [...merged.values()].map((r) => {
    const program = matchCarrier(r.carrier);
    const key = carrierKey(r.carrier);
    const planMatches = (p) => (program ? p.program === program || (!!p.assumed && program !== "BCBS-AL") : carrierKey(p.tpa) === key);
    const nameMatches = (c) => (program ? matchCarrier(c) === program : carrierKey(c) === key);
    const side = () => ({ heads: 0, headsExact: true, medical: 0, lines: 0, groups: 0 });
    const live = side();
    const archived = side();
    for (const g of groups) {
      const s = g.archived ? archived : live;
      const plans = (g.plans || []).filter(planMatches);
      const lines = (g.lines || []).filter((l) => nameMatches(l.carrier));
      if (!plans.length && !lines.length) continue;
      s.groups++;
      for (const p of plans) s.medical += p.monthly || 0;
      for (const l of lines) s.lines += l.monthly || 0;
      if (g.carrierHeads) {
        for (const [c, n] of Object.entries(g.carrierHeads)) if (nameMatches(c)) s.heads += n;
      } else {
        s.headsExact = false;
        s.heads += plans.reduce((n, p) => n + (p.enrolled || 0), 0) + lines.reduce((n, l) => n + (l.enrolled || 0), 0);
      }
    }
    const portal = r2(live.medical + live.lines + archived.medical + archived.lines);
    const heads = live.heads + archived.heads;
    const headsExact = live.headsExact && archived.headsExact;
    const report = { enrolled: r.enrolled, companies: r.companies, monthly: r2(r.planCosts), rows: r.rows };
    const service = report.monthly === 0 && portal === 0;
    const dollarsOk = close(portal, report.monthly, 0.01, 50);
    // Distinct-employee counts differ by a few people between the two files
    // (a termination with an open line, say); three people or 2% is the same count.
    const headsOk = headsExact ? close(heads, report.enrolled, 0.02, 3) : null;
    return {
      carrier: r.carrier,
      program,
      report,
      portal: { monthly: portal, heads, headsExact, groups: live.groups + archived.groups, archivedMonthly: r2(archived.medical + archived.lines) },
      diff: r2(portal - report.monthly),
      pct: report.monthly ? r2(((portal - report.monthly) / report.monthly) * 100) : null,
      service,
      ok: service ? null : dollarsOk && headsOk !== false,
    };
  });
}

/**
 * Each group's month of billing against its XML: people and premium. The
 * workbook is the two captives' billing - EBPA and HealthEZ - so the XML side
 * is the group's group-health medical; a Blue Cross plan is billed elsewhere
 * and is not expected here.
 */
export function reconcileBilling(funding, groups) {
  if (!funding) return null;
  const rows = [];
  for (const g of groups) {
    if (g.archived || g.eligible === false) continue;
    const f = funding.summary[g.name] || null;
    const gh = (g.plans || []).filter((p) => p.groupHealth);
    const xmlN = g.groupHealthEnrolled ?? gh.reduce((n, p) => n + (p.enrolled || 0), 0);
    const xml$ = g.groupHealthMonthly ?? gh.reduce((n, p) => n + (p.monthly || 0), 0);
    if (!f && !xmlN) continue;
    const billN = f ? f.medical.participants : 0;
    const bill$ = f ? f.medical.monthly : 0;
    const ok = f ? close(bill$, xml$, 0.01, 50) && close(billN, xmlN, 0.02, 2) : null;
    rows.push({ group: g.name, xmlN, xml$: r2(xml$), billN, bill$: r2(bill$), ok, noBilling: !f });
  }
  const unassigned = Object.values(funding.byInvoice || {}).filter((a) => !a.group).length;

  // Where the month's whole billing sits, so the workbook's total and the
  // Groups page tile can be told apart: the tile is live groups on the XML,
  // the workbook bills archived companies and anything not yet filed too.
  const byName = new Map(groups.map((g) => [g.name, g]));
  const coverage = { total: 0, live: 0, archived: 0, unfiled: 0 };
  for (const [name, f] of Object.entries(funding.summary || {})) {
    const amount = f.medical.monthly || 0;
    coverage.total += amount;
    const g = byName.get(name);
    if (g && !g.archived && g.eligible !== false) coverage.live += amount;
    else coverage.archived += amount;
  }
  for (const [inv, a] of Object.entries(funding.byInvoice || {})) {
    if (a.group) continue;
    const amount = (funding.lines || []).filter((l) => l.invoice === inv && l.medical && l.kind === "current").reduce((n, l) => n + l.rate, 0);
    coverage.total += amount;
    coverage.unfiled += amount;
  }

  return {
    month: funding.month,
    groups: rows.length,
    matches: rows.filter((r) => r.ok === true).length,
    differ: rows.filter((r) => r.ok === false).map((r) => r.group),
    noBilling: rows.filter((r) => r.noBilling).map((r) => r.group),
    unassigned,
    coverage: { total: r2(coverage.total), live: r2(coverage.live), archived: r2(coverage.archived), unfiled: r2(coverage.unfiled) },
    rows,
  };
}

/**
 * The whole audit. `files` says what is in; `verdict` is the one line for the
 * top of the page; `carriers` and `billing` are the rows behind it.
 */
export function runAudit({ groups, carrierStats, funding, lastImport }) {
  const files = {
    xml: lastImport ? { filename: lastImport.filename, when: lastImport.uploaded_at, companies: lastImport.companies_applied } : null,
    stats: carrierStats ? { filename: carrierStats.filename, when: carrierStats.uploadedAt, reportDate: carrierStats.reportDate } : null,
    funding: funding ? { filename: funding.filename, when: funding.uploadedAt, month: funding.month } : null,
  };
  const carriers = reconcileCarriers(carrierStats, groups);
  const checked = carriers.filter((c) => c.ok !== null);
  const off = checked.filter((c) => c.ok === false);
  const billing = reconcileBilling(funding, groups);
  const live = groups.filter((g) => !g.archived && g.eligible !== false);
  const portal = {
    groups: live.length,
    enrolled: live.reduce((n, g) => n + (g.enrolled || 0), 0),
    groupHealthMonthly: r2(live.reduce((n, g) => n + (g.groupHealthMonthly || 0), 0)),
    totalMonthly: r2(live.reduce((n, g) => n + (g.totalMonthly || 0), 0)),
  };
  const missing = ["xml", "stats", "funding"].filter((k) => !files[k]);
  const complete = missing.length === 0;

  let verdict;
  if (!files.xml) verdict = { kind: "none", headline: "Nothing to audit yet - the XML export comes first." };
  else if (!complete) {
    const names = { stats: "the carrier stats report", funding: "the funding workbook" };
    verdict = { kind: "none", headline: `Waiting on ${missing.map((k) => names[k]).join(" and ")}.` };
  } else {
    const parts = [];
    parts.push(off.length ? `${checked.length - off.length} of ${checked.length} carriers match Employee Navigator; ${off.map((c) => `${c.carrier} ${c.pct > 0 ? "+" : ""}${c.pct}%`).join(", ")} to check` : `all ${checked.length} carriers match Employee Navigator within 1%`);
    if (billing) {
      parts.push(billing.differ.length ? `${billing.matches} of ${billing.groups} groups bill what the XML says; ${billing.differ.length} differ` : `every group bills what the XML says`);
      if (billing.unassigned) parts.push(`${billing.unassigned} invoice${billing.unassigned === 1 ? " still needs" : "s still need"} a group`);
    }
    const kind = off.length || (billing && (billing.differ.length || billing.unassigned)) ? "warn" : "ok";
    verdict = { kind, headline: parts.join(" · ") + "." };
  }
  return { generated: new Date().toISOString(), complete, files, portal, verdict, carriers, billing };
}

/** Bump when the audit's rules change, so a stored read is not reused for a different comparison. */
export const AUDIT_VERSION = 3;

/** What identifies this audit: the rules, the three uploads and the invoice filings. */
export function auditFingerprint({ carrierStats, funding, lastImport }) {
  const filed = funding ? Object.values(funding.byInvoice || {}).filter((a) => a.group).length : 0;
  return [`v${AUDIT_VERSION}`, lastImport?.uploaded_at || "-", carrierStats?.uploadedAt || "-", funding?.uploadedAt || "-", filed].join("|");
}

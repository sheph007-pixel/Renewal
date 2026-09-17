// Reads Employee Navigator's monthly funding workbook - September's billing,
// one line per participant per product - and files every invoice under the
// group it belongs to.
//
// The workbook names billing divisions ("Taz Bham LLC 101-0002", "116"), not
// companies, so the join to a group goes through the people: each line's
// participant is looked up among the group members the XML import produced,
// and an invoice goes to the group most of its participants belong to. That
// needs no other file and survives a division being renamed.
import * as XLSX from "xlsx";

const num = (v) => {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** "Last, First Middle" → "last, first" for matching; case, accents and suffixes dropped. */
export const nameKey = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z, ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/, ", ")
    .trim();

/** Same key from a member record's first and last names. */
export const memberKey = (m) => nameKey(`${m.last || ""}, ${m.first || ""}`);

/** The tier a funding "Rate Band" means, in the portal's census terms. */
export function bandTier(band) {
  const s = String(band || "").toLowerCase();
  if (!s) return null;
  if (/family/.test(s)) return "Employee + Family";
  if (/spouse|partner/.test(s)) return "Employee + Spouse";
  if (/child/.test(s)) return "Employee + Child(ren)";
  if (/employee|only|single/.test(s)) return "Employee";
  return null;
}

/**
 * Parse the workbook. Returns { month, lines, products } where `lines` is every
 * billing line across the AL and VT sheets, each flagged medical when its
 * product appears on the matching "(HEALTH)" sheet, and `month` is the billing
 * month read off the lines' start dates.
 */
export function parseFunding(buffer, filename = "") {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  } catch (e) {
    throw new Error("Could not open that file as a spreadsheet: " + e.message);
  }
  const sheet = (name) => {
    const ws = wb.Sheets[name];
    return ws ? XLSX.utils.sheet_to_json(ws, { raw: false, defval: null }) : null;
  };
  // Captive sheets: AL and VT carry every line; the (HEALTH) sheets the
  // medical subset. A workbook with different sheet names is not this report.
  const captives = ["AL", "VT"].filter((c) => wb.Sheets[c]);
  if (!captives.length) {
    throw new Error('This does not look like the funding workbook - no "AL" or "VT" sheet.');
  }
  const medicalKeys = new Set();
  for (const c of captives) {
    for (const r of sheet(`${c} (HEALTH)`) || []) {
      medicalKeys.add(`${r.Invoice}||${r["Family Id"]}||${r["Prod Id"]}`);
    }
  }
  const lines = [];
  const monthVotes = {};
  for (const c of captives) {
    for (const r of sheet(c) || []) {
      const invoice = String(r.Invoice || "").trim();
      const participant = String(r.Participant || "").trim();
      if (!invoice || !participant) continue;
      const product = String(r["Prod Id"] || "").trim();
      const start = String(r["Start Date"] || "").trim();
      const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(start);
      if (m) {
        const ym = `${m[3]}-${m[1].padStart(2, "0")}`;
        monthVotes[ym] = (monthVotes[ym] || 0) + 1;
      }
      lines.push({
        captive: c,
        invoice,
        org: String(r["Org Name"] || "").trim(),
        familyId: String(r["Family Id"] || "").trim(),
        participant,
        product,
        start,
        end: String(r["End Date"] || "").trim(),
        band: r["Rate Band"] == null ? null : String(r["Rate Band"]).trim(),
        volume: num(r.Volume),
        rate: num(r.Rate),
        // The (HEALTH) sheets carry EBPA's dental plans too; those are lines,
        // not medical, the same as the XML treats them.
        medical: medicalKeys.has(`${invoice}||${r["Family Id"]}||${product}`) && !/dental|vision/i.test(product),
      });
    }
  }
  if (!lines.length) throw new Error("No billing lines found in the workbook.");
  const month = Object.entries(monthVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // What each line is to the month: the month's own billing ("current"), a
  // prior month billed late ("retro"), or a reversal ("credit"). Enrollment
  // and rates come from current lines only; the rest are adjustments.
  for (const l of lines) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(l.start);
    const ym = m ? `${m[3]}-${m[1].padStart(2, "0")}` : null;
    l.kind = l.rate < 0 ? "credit" : ym && month && ym !== month ? "retro" : "current";
    // A full month runs from the 1st to the month's last day (or has no end).
    // Anything shorter is prorated and must not set the tier's rate.
    const e = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(l.end);
    const lastDay = m ? new Date(Number(m[3]), Number(m[1]), 0).getDate() : null;
    l.full = !!m && Number(m[2]) === 1 && (!e || (Number(e[2]) === lastDay && e[1] === m[1] && e[3] === m[3]));
  }
  const fm = /(\d{2})(\d{2})(\d{2})\d*/.exec(filename.replace(/^.*_(\d{6,})\D*$/, "$1"));
  return { month, lines, fileStamp: fm ? `20${fm[3]}-${fm[1]}-${fm[2]}` : null };
}

/**
 * A plan name reduced to what identifies it: case, punctuation and any plan
 * year dropped. Billing product IDs carry the year mid-string ("EBPA Platinum
 * 150 (MP34/MP92) 2026 - Union and Non") and are cut at 50 characters, so a
 * billed name may also be a prefix of the XML's.
 */
export const planKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The XML plan a billed product is, or the cleaned billed name when none fits. */
export function resolvePlan(product, xmlPlans) {
  const cleaned = product.replace(/\s+(19|20)\d{2}\s*$/, "").trim();
  const k = planKey(product);
  if (!k || !xmlPlans || !xmlPlans.length) return cleaned;
  const exact = xmlPlans.find((x) => planKey(x) === k);
  if (exact) return exact;
  if (k.length >= 12) {
    const pre = xmlPlans.filter((x) => planKey(x).startsWith(k) || k.startsWith(planKey(x)));
    if (pre.length === 1) return pre[0];
  }
  return cleaned;
}

/** Levenshtein distance, for a billing org that is a group's name with a typo. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * File each invoice under a group by majority of its participants' names among
 * the groups' members. Returns { byInvoice, unassigned } where byInvoice maps
 * invoice → { group, votes, total, share }.
 */
export function assignInvoices(lines, groups) {
  const index = new Map();
  for (const g of groups) {
    for (const m of g.members || []) {
      const k = memberKey(m);
      if (!k || k === ",") continue;
      const arr = index.get(k) || [];
      if (!arr.includes(g.name)) arr.push(g.name);
      index.set(k, arr);
    }
  }
  const votes = new Map(); // invoice → { group → count }
  const totals = new Map();
  for (const l of lines) {
    if (!l.medical) continue; // medical lines are one per person and name the group best
    totals.set(l.invoice, (totals.get(l.invoice) || 0) + 1);
    const gs = index.get(nameKey(l.participant));
    if (!gs) continue;
    const v = votes.get(l.invoice) || {};
    for (const g of gs) v[g] = (v[g] || 0) + 1 / gs.length;
    votes.set(l.invoice, v);
  }
  // Invoices with no medical lines at all: vote with every line.
  for (const l of lines) {
    if (totals.has(l.invoice)) continue;
    totals.set(l.invoice, 0);
  }
  for (const l of lines) {
    if (l.medical || (votes.get(l.invoice) && Object.keys(votes.get(l.invoice)).length)) continue;
    totals.set(l.invoice, (totals.get(l.invoice) || 0) + 1);
    const gs = index.get(nameKey(l.participant));
    if (!gs) continue;
    const v = votes.get(l.invoice) || {};
    for (const g of gs) v[g] = (v[g] || 0) + 1 / gs.length;
    votes.set(l.invoice, v);
  }

  // A group's name, loosely: for invoices whose billing org is simply the
  // company name, when none of its people could be matched.
  const loose = (x) =>
    String(x || "")
      .toLowerCase()
      .replace(/\b(llc|inc|co|corp|corporation|company|holdings|the|of|and|ltd|lp|pc|pllc|dba)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const byName = new Map(groups.map((g) => [loose(g.name), g.name]));
  // Billing orgs are truncated now and then ("Worth Industries, In"), so a
  // prefix of eight or more characters is accepted either way round.
  const nameFor = (org) => {
    const k = loose(org);
    if (!k) return null;
    if (byName.has(k)) return byName.get(k);
    if (k.length < 8) return null;
    const hits = [...byName.entries()].filter(([n]) => n.startsWith(k) || k.startsWith(n));
    return hits.length === 1 ? hits[0][1] : null;
  };
  // A billing org that is a group's name outright (a typo or two allowed)
  // says where the invoice belongs, whatever the names vote - sister
  // companies share people, and the org line is the carrier's own filing.
  const namedOutright = (org) => {
    const k = loose(org);
    if (!k || k.length < 8) return null;
    if (byName.has(k)) return byName.get(k);
    const near = [...byName.entries()].filter(([n]) => Math.abs(n.length - k.length) <= 2 && editDistance(n, k) <= 2);
    return near.length === 1 ? near[0][1] : null;
  };

  const byInvoice = {};
  const unassigned = [];
  for (const invoice of new Set(lines.map((l) => l.invoice))) {
    const v = votes.get(invoice) || {};
    const ranked = Object.entries(v).sort((a, b) => b[1] - a[1]);
    const matched = ranked.reduce((a, x) => a + x[1], 0);
    const total = totals.get(invoice) || 0;
    const orgs = [...new Set(lines.filter((l) => l.invoice === invoice).map((l) => l.org))];
    const candidates = ranked.slice(0, 3).map(([g, n]) => ({ group: g, votes: Math.round(n * 100) / 100 }));
    const outright = orgs.map(namedOutright).find(Boolean);
    if (outright) {
      byInvoice[invoice] = { group: outright, votes: Math.round((v[outright] || 0) * 100) / 100, matched: Math.round(matched * 100) / 100, total, orgs, by: "org name", candidates };
      continue;
    }
    // Majority of the people we could place, and at least one whole person.
    if (ranked.length && ranked[0][1] >= 1 && ranked[0][1] / matched >= 0.6) {
      byInvoice[invoice] = { group: ranked[0][0], votes: Math.round(ranked[0][1] * 100) / 100, matched: Math.round(matched * 100) / 100, total, orgs, by: "names", candidates };
      continue;
    }
    // No people placed: does a billing org simply carry the company's name?
    const named = orgs.map(nameFor).find(Boolean);
    if (named) {
      byInvoice[invoice] = { group: named, votes: 0, matched: 0, total, orgs, by: "org name", candidates };
      continue;
    }
    byInvoice[invoice] = { group: null, votes: ranked[0] ? Math.round(ranked[0][1] * 100) / 100 : 0, matched: Math.round(matched * 100) / 100, total, orgs, by: null, candidates };
    unassigned.push(invoice);
  }
  return { byInvoice, unassigned };
}

/**
 * Per-group summary of a month's billing: medical by plan and tier with the
 * billed rate, other products, and totals. No participant names here - this
 * is what the admin screens and the reconciliation use.
 */
export function summariseFunding(lines, byInvoice, xmlPlansByGroup = {}) {
  const groups = {};
  const planNames = new Map(); // group||product → resolved plan
  for (const l of lines) {
    const a = byInvoice[l.invoice];
    if (!a || !a.group) continue;
    const g = (groups[a.group] = groups[a.group] || {
      invoices: new Set(),
      orgs: new Set(),
      medical: { people: new Set(), lines: 0, monthly: 0, adjustments: 0, retro: 0, credits: 0, byPlan: {} },
      other: { lines: 0, monthly: 0, byProduct: {} },
    });
    g.invoices.add(l.invoice);
    g.orgs.add(l.org);
    if (l.medical) {
      const pk = `${a.group}||${l.product}`;
      if (!planNames.has(pk)) planNames.set(pk, resolvePlan(l.product, xmlPlansByGroup[a.group]));
      const plan = planNames.get(pk);
      const p = (g.medical.byPlan[plan] = g.medical.byPlan[plan] || { lines: 0, monthly: 0, adjustments: 0, byTier: {}, unknown: [] });
      let tier = bandTier(l.band);
      if (!tier) {
        // No rate band on the line: settled after the plan's tiers are known.
        p.unknown.push(l);
        continue;
      }
      const t = (p.byTier[tier] = p.byTier[tier] || { n: 0, monthly: 0, adjustments: 0, rates: {}, partial: {}, retro: 0, credits: 0 });
      if (l.kind === "current") {
        // One current line per participant per plan: the month's enrollment.
        g.medical.people.add(l.familyId || l.participant);
        g.medical.lines++;
        g.medical.monthly += l.rate;
        p.lines++;
        p.monthly += l.rate;
        t.n++;
        t.monthly += l.rate;
        // Only a full month's line says what the tier's rate is.
        const rk = l.rate.toFixed(2);
        if (l.full) t.rates[rk] = (t.rates[rk] || 0) + 1;
        else t.partial[rk] = (t.partial[rk] || 0) + 1;
      } else {
        // Retro adds and credits change the invoice, not who is enrolled.
        g.medical.adjustments += l.rate;
        p.adjustments += l.rate;
        t.adjustments += l.rate;
        if (l.kind === "credit") {
          g.medical.credits++;
          t.credits++;
        } else {
          g.medical.retro++;
          t.retro++;
        }
      }
    } else {
      g.other.lines++;
      g.other.monthly += l.rate;
      const o = (g.other.byProduct[l.product] = g.other.byProduct[l.product] || { lines: 0, monthly: 0 });
      o.lines++;
      o.monthly += l.rate;
    }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const modeOf = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const out = {};
  for (const [name, g] of Object.entries(groups)) {
    const byPlan = {};
    for (const [plan, p] of Object.entries(g.medical.byPlan)) {
      // Lines with no rate band: filed under the tier whose full-month rate
      // they carry, when exactly one does; the rest are reported as untiered.
      const untiered = [];
      for (const l of p.unknown) {
        const rk = Math.abs(l.rate).toFixed(2);
        const fits = Object.entries(p.byTier).filter(([, t]) => modeOf(t.rates)[0]?.[0] === rk);
        if (fits.length !== 1) {
          untiered.push(l);
          continue;
        }
        const t = fits[0][1];
        if (l.kind === "current") {
          g.medical.people.add(l.familyId || l.participant);
          g.medical.lines++;
          g.medical.monthly += l.rate;
          p.lines++;
          p.monthly += l.rate;
          t.n++;
          t.monthly += l.rate;
        } else {
          g.medical.adjustments += l.rate;
          p.adjustments += l.rate;
          t.adjustments += l.rate;
          if (l.kind === "credit") {
            g.medical.credits++;
            t.credits++;
          } else {
            g.medical.retro++;
            t.retro++;
          }
        }
      }
      const byTier = {};
      for (const [tier, t] of Object.entries(p.byTier)) {
        // The billed rate for the tier: the amount most full-month lines
        // carry. With none, the most common prorated amount, flagged.
        const ranked = modeOf(t.rates);
        const partial = modeOf(t.partial);
        const lead = ranked[0] || partial[0] || null;
        byTier[tier] = {
          n: t.n,
          monthly: r2(t.monthly),
          adjustments: r2(t.adjustments),
          rate: lead ? Number(lead[0]) : null,
          rateLines: lead ? lead[1] : 0,
          rateProrated: !ranked[0] && !!partial[0],
          otherRates: ranked.slice(1).map(([r, n]) => ({ rate: Number(r), n })),
          partialLines: Object.values(t.partial).reduce((a, b) => a + b, 0),
          retro: t.retro,
          credits: t.credits,
        };
      }
      // Untiered lines still count toward the group's month; they just cannot
      // sit in a tier column.
      let untieredMonthly = 0;
      let untieredCurrent = 0;
      for (const l of untiered) {
        if (l.kind === "current") {
          g.medical.people.add(l.familyId || l.participant);
          g.medical.lines++;
          g.medical.monthly += l.rate;
          p.lines++;
          p.monthly += l.rate;
          untieredCurrent++;
          untieredMonthly += l.rate;
        } else {
          g.medical.adjustments += l.rate;
          p.adjustments += l.rate;
          if (l.kind === "credit") g.medical.credits++;
          else g.medical.retro++;
        }
      }
      byPlan[plan] = {
        lines: p.lines,
        monthly: r2(p.monthly),
        adjustments: r2(p.adjustments),
        byTier,
        untiered: untieredCurrent ? { n: untieredCurrent, monthly: r2(untieredMonthly), rates: [...new Set(untiered.filter((l) => l.kind === "current").map((l) => l.rate))] } : null,
      };
    }
    const medical = {
      participants: g.medical.people.size,
      lines: g.medical.lines,
      monthly: r2(g.medical.monthly),
      adjustments: r2(g.medical.adjustments),
      retro: g.medical.retro,
      credits: g.medical.credits,
      billed: r2(g.medical.monthly + g.medical.adjustments),
      byPlan,
    };
    out[name] = {
      invoices: [...g.invoices],
      orgs: [...g.orgs],
      medical,
      other: { lines: g.other.lines, monthly: r2(g.other.monthly), byProduct: Object.fromEntries(Object.entries(g.other.byProduct).map(([k, v]) => [k, { lines: v.lines, monthly: r2(v.monthly) }])) },
      totalMonthly: r2(g.medical.monthly + g.other.monthly),
      totalBilled: r2(g.medical.monthly + g.medical.adjustments + g.other.monthly),
    };
  }
  return out;
}

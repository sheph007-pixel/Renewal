// Benchmarks: the handful of figures an employer asks about — what a plan
// costs, how much of it the employer pays, the deductible and out-of-pocket
// max, how many take it up, how many plans are offered — from published
// surveys (KFF's Employer Health Benefits Survey, Mercer, SHRM, BLS), kept in
// the database with the source and year on every row, cut by the ACA line
// (2-50 / 51+ employees) and by place (Alabama, the South, national), and
// compared with each group's own numbers. The assistant searches the surveys
// and writes the rows straight in, each citing where it came from; staff can
// fix a figure or add one by hand.
import Anthropic from "@anthropic-ai/sdk";

/**
 * What is measured. `group` computes the group's own value from its figures
 * (null when the figures do not say). `unit`: usd (a year unless noted), pct,
 * or count. `lowerIsBetter` says how a gap reads for the employer.
 */
export const METRICS = [
  { key: "premium_single_annual", label: "Annual premium, employee-only coverage", short: "Premium", unit: "usd", lowerIsBetter: true, group: (m) => m.premiumSingleAnnual },
  { key: "employer_share_single_pct", label: "Employer share of the premium, employee-only", short: "Cost sharing", unit: "pct", lowerIsBetter: null, group: (m) => m.employerShareSingle },
  { key: "deductible_single", label: "Deductible, employee-only", short: "Deductible", unit: "usd", lowerIsBetter: null, group: (m) => m.deductibleSingle },
  { key: "oop_max_single", label: "Out-of-pocket maximum, employee-only", short: "Out-of-pocket max", unit: "usd", lowerIsBetter: null, group: (m) => m.oopSingle },
  { key: "participation_pct", label: "Participation: eligible employees enrolled", short: "Participation", unit: "pct", lowerIsBetter: false, group: (m) => m.participation },
  { key: "plans_offered", label: "Medical plans offered", short: "Plans offered", unit: "count", lowerIsBetter: null, group: (m) => m.plansOffered },
];
export const METRIC_KEYS = METRICS.map((m) => m.key);

/** The ACA line: small group 2-50, large group 51+. */
export const SIZE_BANDS = ["2-50", "51+"];
/** Where: Alabama, the South, or the country; the closest cut on file wins. */
export const REGIONS = ["all", "south", "AL"];
export const REGION_LABEL = { all: "national", south: "the South", AL: "Alabama" };
export const sizeBand = (n) => (n == null ? null : n <= 50 ? "2-50" : "51+");

const TIER_CENSUS = { EE: "Employee", ES: "Employee + Spouse", EC: "Employee + Child(ren)", FAM: "Employee + Family" };
const moneyNum = (s) => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && String(s).match(/\d/) ? n : null;
};

/**
 * The group's own numbers in the surveys' terms: the enrollment-weighted
 * employee-only rate × 12; the employer's share from the Employee Navigator
 * split; deductible and out-of-pocket max from the plan designs on file,
 * weighted by who is on each plan; enrolled over eligible; plans in force.
 */
export function groupMetrics(data) {
  const g = data.group || {};
  const plans = g.plans || [];
  const designs = data.planDesigns || {};
  const design = (plan) => {
    const key = Object.keys(designs).find((k) => plan && plan.indexOf(k) !== -1);
    return key ? designs[key] : null;
  };
  const weightedBy = (valueOf) => {
    let sum = 0;
    let n = 0;
    for (const p of plans) {
      const v = valueOf(p);
      const c = p.enrolled || Object.values((g.planTiers || {})[p.plan] || {}).reduce((a, b) => a + b, 0);
      if (v == null || !c) continue;
      sum += v * c;
      n += c;
    }
    return n ? sum / n : null;
  };
  const eeRate = (p) => {
    const r = ((g.rates || {})[p.plan] || {})[TIER_CENSUS.EE];
    return r == null ? null : Number(r);
  };
  const share = () => {
    const splits = data.splits && data.splits[g.name] && data.splits[g.name].plans;
    if (!splits) return null;
    let er = 0;
    let total = 0;
    for (const p of plans) {
      const s = splits[p.plan] && splits[p.plan][TIER_CENSUS.EE];
      const c = ((g.planTiers || {})[p.plan] || {}).EE || 0;
      if (!s || !s.total || !c) continue;
      er += Number(s.er) * c;
      total += Number(s.total) * c;
    }
    return total ? (er / total) * 100 : null;
  };
  const single = weightedBy(eeRate);
  const eligible = g.medicalEligible ?? null;
  const enrolled = g.enrolled ?? null;
  return {
    enrolled,
    employees: eligible ?? enrolled,
    sizeBand: sizeBand(eligible ?? enrolled),
    premiumSingleAnnual: single == null ? null : single * 12,
    employerShareSingle: share(),
    deductibleSingle: weightedBy((p) => moneyNum((design(p.plan) || {}).Deductible)),
    oopSingle: weightedBy((p) => moneyNum((design(p.plan) || {})["Out-of-Pocket Max"])),
    participation: eligible && enrolled != null ? Math.min(100, (enrolled / eligible) * 100) : null,
    plansOffered: plans.length || null,
  };
}

/** The row that fits a group best: its size band and place first, then broader cuts; newest year wins. */
function pick(rows, metric, band, region) {
  const places = region === "AL" ? ["AL", "south", "all"] : region === "south" ? ["south", "all"] : ["all"];
  const order = [];
  for (const b of [band, "all"]) for (const r of places) order.push([b, r]);
  for (const [b, r] of order) {
    const hits = rows.filter((x) => x.metric === metric && x.sizeBand === b && x.region === r).sort((a, c) => (c.year || 0) - (a.year || 0));
    if (hits.length) return hits[0];
  }
  return null;
}

const fmt = (unit, v) => (v == null ? "—" : unit === "pct" ? `${Math.round(v * 10) / 10}%` : unit === "count" ? String(Math.round(v)) : `$${Math.round(v).toLocaleString("en-US")}`);

/**
 * Group against benchmark, metric by metric. `region` is where the group is;
 * Alabama by default, since that is where Kennion's clients are. Each line
 * says both figures, the gap, and where the benchmark came from.
 */
export function compare(data, rows, { region = "AL" } = {}) {
  const m = groupMetrics(data);
  const band = m.sizeBand || "all";
  const lines = [];
  for (const metric of METRICS) {
    const row = pick(rows, metric.key, band, region);
    if (!row) continue;
    const mine = metric.group(m);
    const diff = mine == null || !row.value ? null : ((mine - row.value) / row.value) * 100;
    let read = null;
    if (diff != null) {
      const abs = Math.abs(Math.round(diff));
      const pts = metric.unit === "pct" ? Math.abs(Math.round(mine - row.value)) : null;
      if ((pts != null ? pts : abs) < 3) read = "In line with the benchmark.";
      else if (metric.unit === "pct") read = `${pts} points ${diff > 0 ? "above" : "below"} the benchmark.`;
      else if (metric.unit === "count") read = `${Math.abs(Math.round(mine - row.value))} ${diff > 0 ? "more" : "fewer"} than the benchmark.`;
      else read = `${abs}% ${diff > 0 ? "above" : "below"} the benchmark.`;
      if (metric.lowerIsBetter === true && abs >= 3) read += diff > 0 ? " Costs more than typical." : " Costs less than typical.";
      if (metric.lowerIsBetter === false && (pts != null ? pts : abs) >= 3) read += diff > 0 ? " Better than typical." : " Lower than typical.";
    }
    lines.push({
      metric: metric.key,
      label: metric.label,
      short: metric.short,
      unit: metric.unit,
      group: mine,
      groupText: fmt(metric.unit, mine),
      benchmark: row.value,
      benchmarkText: fmt(metric.unit, row.value),
      diffPct: diff,
      read,
      year: row.year,
      source: row.source,
      sourceUrl: row.sourceUrl || null,
      sizeBand: row.sizeBand,
      region: row.region,
      note: row.note || null,
    });
  }
  return { sizeBand: m.sizeBand, employees: m.employees, enrolled: m.enrolled, region, lines };
}

/** The comparison as the assistant reads it. */
export function compareText(c) {
  if (!c.lines.length) return "No benchmarks are on file yet for this group's size. Say so plainly; Kennion loads them from /admin/benchmarks.";
  const head = `Benchmarks for employers with ${c.sizeBand ? `${c.sizeBand} employees` : "any headcount"} (${REGION_LABEL[c.region] || c.region}), against this group (${c.employees ?? "?"} employees, ${c.enrolled ?? "?"} enrolled in medical):`;
  const body = c.lines.map((l) => `- ${l.label}: group ${l.groupText}; benchmark ${l.benchmarkText} (${l.source}, ${l.year}${l.sizeBand !== "all" ? `, firms ${l.sizeBand}` : ""}, ${REGION_LABEL[l.region] || l.region}).${l.read ? ` ${l.read}` : ""}`);
  return [head, ...body, "Cite the source and year in words when you use one of these. A group figure of — means its data does not say; do not estimate it."].join("\n");
}

const clean = (r) => ({
  metric: METRIC_KEYS.includes(r.metric) ? r.metric : null,
  sizeBand: SIZE_BANDS.includes(r.sizeBand) ? r.sizeBand : "all",
  region: REGIONS.includes(r.region) ? r.region : "all",
  value: Number.isFinite(Number(r.value)) && r.value !== "" && r.value != null ? Number(r.value) : null,
  year: Number.isInteger(Number(r.year)) && r.year != null && r.year !== "" ? Number(r.year) : null,
  source: String(r.source || "").trim().slice(0, 200),
  sourceUrl: r.sourceUrl ? String(r.sourceUrl).trim().slice(0, 500) : null,
  note: r.note ? String(r.note).trim().slice(0, 500) : null,
});

/** A row as staff or the model supplied it, or null when it cannot be used. */
export function normalizeRow(r) {
  const x = clean(r || {});
  return x.metric && x.value != null && x.source ? x : null;
}

const FAKE_ROWS = [
  { metric: "premium_single_annual", sizeBand: "all", region: "all", value: 9000, year: 2025, source: "Canned (KENNION_FAKE_AI)", note: "stand-in" },
  { metric: "employer_share_single_pct", sizeBand: "2-50", region: "all", value: 83, year: 2025, source: "Canned (KENNION_FAKE_AI)" },
  { metric: "deductible_single", sizeBand: "all", region: "south", value: 1900, year: 2025, source: "Canned (KENNION_FAKE_AI)" },
];

/**
 * Ask the model to search the web for the current published figures and
 * return rows, each with its source and year.
 */
export async function proposeBenchmarks({ apiKey, model = "claude-opus-5", fake = false, onStatus = () => undefined } = {}) {
  if (fake) return FAKE_ROWS.map(normalizeRow).filter(Boolean);
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  const ask = `Find the most recent published employer health benefits benchmarks for U.S. employers and return them as data rows.

Sources to prefer, in order: KFF Employer Health Benefits Survey (latest year), Mercer National Survey of Employer-Sponsored Health Plans, SHRM, the Bureau of Labor Statistics National Compensation Survey, and for Alabama the KFF State Health Facts or the Medical Expenditure Panel Survey Insurance Component (MEPS-IC, AHRQ) state tables. Use the survey's own tables; do not estimate.

Metrics (use these exact keys):
${METRICS.map((m) => `- ${m.key}: ${m.label} (${m.unit === "pct" ? "percent, e.g. 83" : m.unit === "count" ? "a count, e.g. 2" : "dollars per year, e.g. 9000"})`).join("\n")}

Cuts: size bands "2-50" (small firms; use the survey's small-firm cut, e.g. KFF's 3-49 or 3-199, and say which in the note) and "51+" (large firms), plus "all" for all firms. Region: "AL" where a state table exists (MEPS-IC has premiums, contributions, deductibles and offer/participation rates by state), "south" where the survey reports it, else "all".

Return ONLY a JSON array, no prose, of objects: {"metric","sizeBand","region","value","year","source","sourceUrl","note"}. value is a number. year is the survey year. source is the survey name. sourceUrl is the page the figure is on. Include every metric and cut you can find with confidence; leave out anything you cannot source.`;
  onStatus("Searching published surveys…");
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
    messages: [{ role: "user", content: ask }],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("The model did not return a benchmark list.");
  let rows;
  try {
    rows = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("The benchmark list could not be read.");
  }
  return (Array.isArray(rows) ? rows : []).map(normalizeRow).filter(Boolean);
}

// Benchmarks: what employers like this one pay and offer, from published
// surveys (KFF's Employer Health Benefits Survey, Mercer, SHRM, BLS), kept in
// the database with the source and year on every row, and compared with a
// group's own figures. Rows arrive two ways: staff type one in, or the
// assistant searches the web and proposes a set, which staff approve before
// any client or the assistant sees it.
import Anthropic from "@anthropic-ai/sdk";

/**
 * What is measured. `group` computes the group's own value from its figures
 * (null when the figures do not say); `unit` is usd (a year), pct, or usd_month.
 * `lowerIsBetter` says how a difference reads for the employer.
 */
export const METRICS = [
  { key: "premium_single_annual", label: "Annual premium, single coverage", short: "Single premium", unit: "usd", lowerIsBetter: true, group: (m) => m.premiumSingleAnnual },
  { key: "premium_family_annual", label: "Annual premium, family coverage", short: "Family premium", unit: "usd", lowerIsBetter: true, group: (m) => m.premiumFamilyAnnual },
  { key: "employer_share_single_pct", label: "Employer share of premium, single coverage", short: "Employer share, single", unit: "pct", lowerIsBetter: null, group: (m) => m.employerShareSingle },
  { key: "employer_share_family_pct", label: "Employer share of premium, family coverage", short: "Employer share, family", unit: "pct", lowerIsBetter: null, group: (m) => m.employerShareFamily },
  { key: "worker_contribution_single_annual", label: "Worker's annual contribution, single coverage", short: "Worker pays, single", unit: "usd", lowerIsBetter: null, group: (m) => m.workerSingleAnnual },
  { key: "worker_contribution_family_annual", label: "Worker's annual contribution, family coverage", short: "Worker pays, family", unit: "usd", lowerIsBetter: null, group: (m) => m.workerFamilyAnnual },
  { key: "deductible_single", label: "General annual deductible, single coverage", short: "Single deductible", unit: "usd", lowerIsBetter: null, group: () => null },
  { key: "premium_increase_pct", label: "Premium increase, year over year", short: "Annual increase", unit: "pct", lowerIsBetter: true, group: () => null },
  { key: "offer_rate_pct", label: "Employers of this size offering health benefits", short: "Offer rate", unit: "pct", lowerIsBetter: null, group: () => null },
];
export const METRIC_KEYS = METRICS.map((m) => m.key);

/** Firm-size bands as the surveys cut them. */
export const SIZE_BANDS = ["3-49", "50-199", "200-999", "1000+"];
export const REGIONS = ["all", "south"];
export const sizeBand = (n) => (n == null ? null : n < 50 ? "3-49" : n < 200 ? "50-199" : n < 1000 ? "200-999" : "1000+");

const TIER_CENSUS = { EE: "Employee", ES: "Employee + Spouse", EC: "Employee + Child(ren)", FAM: "Employee + Family" };

/**
 * The group's own numbers in the surveys' terms: enrollment-weighted monthly
 * rates × 12 for single and family coverage, and the employer's share of each
 * from the Employee Navigator split when it is on file.
 */
export function groupMetrics(data) {
  const g = data.group || {};
  const plans = g.plans || [];
  const weighted = (tier) => {
    let sum = 0;
    let n = 0;
    for (const p of plans) {
      const r = ((g.rates || {})[p.plan] || {})[TIER_CENSUS[tier]];
      const c = ((g.planTiers || {})[p.plan] || {})[tier] || 0;
      if (r == null || !c) continue;
      sum += Number(r) * c;
      n += c;
    }
    return n ? sum / n : null;
  };
  const share = (tier) => {
    const splits = data.splits && data.splits[g.name] && data.splits[g.name].plans;
    if (!splits) return null;
    let er = 0;
    let total = 0;
    for (const p of plans) {
      const s = splits[p.plan] && splits[p.plan][TIER_CENSUS[tier]];
      const c = ((g.planTiers || {})[p.plan] || {})[tier] || 0;
      if (!s || !s.total || !c) continue;
      er += Number(s.er) * c;
      total += Number(s.total) * c;
    }
    return total ? (er / total) * 100 : null;
  };
  const single = weighted("EE");
  const family = weighted("FAM");
  const shareSingle = share("EE");
  const shareFamily = share("FAM");
  return {
    enrolled: g.enrolled ?? null,
    employees: g.medicalEligible ?? g.enrolled ?? null,
    sizeBand: sizeBand(g.medicalEligible ?? g.enrolled ?? null),
    premiumSingleAnnual: single == null ? null : single * 12,
    premiumFamilyAnnual: family == null ? null : family * 12,
    employerShareSingle: shareSingle,
    employerShareFamily: shareFamily,
    workerSingleAnnual: single == null || shareSingle == null ? null : single * 12 * (1 - shareSingle / 100),
    workerFamilyAnnual: family == null || shareFamily == null ? null : family * 12 * (1 - shareFamily / 100),
  };
}

/** The approved row that fits a group best: its size band and region first, then broader cuts; newest year wins. */
function pick(rows, metric, band, region) {
  const order = [
    [band, region],
    [band, "all"],
    ["all", region],
    ["all", "all"],
  ];
  for (const [b, r] of order) {
    const hits = rows.filter((x) => x.metric === metric && x.status === "approved" && x.sizeBand === b && x.region === r).sort((a, c) => (c.year || 0) - (a.year || 0));
    if (hits.length) return hits[0];
  }
  return null;
}

const fmt = (unit, v) => (v == null ? "—" : unit === "pct" ? `${Math.round(v * 10) / 10}%` : `$${Math.round(v).toLocaleString("en-US")}`);

/**
 * Group against benchmark, metric by metric. `region` defaults to the South,
 * where Kennion's clients are. Each line says both figures, the difference,
 * and where the benchmark came from.
 */
export function compare(data, rows, { region = "south" } = {}) {
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
      if (abs < 3) read = "In line with the benchmark.";
      else if (metric.unit === "pct") read = `${abs} points ${diff > 0 ? "above" : "below"} the benchmark.`;
      else read = `${abs}% ${diff > 0 ? "above" : "below"} the benchmark.`;
      if (metric.lowerIsBetter === true && abs >= 3) read += diff > 0 ? " Costs more than typical." : " Costs less than typical.";
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
  if (!c.lines.length) return "No approved benchmarks are on file yet for this group's size. Say so plainly; Kennion can add them from /admin/benchmarks.";
  const head = `Benchmarks for employers with ${c.sizeBand ? `${c.sizeBand} employees` : "any headcount"} (${c.region === "all" ? "national" : "the South"}), against this group (${c.employees ?? "?"} employees, ${c.enrolled ?? "?"} enrolled in medical):`;
  const body = c.lines.map((l) => `- ${l.label}: group ${l.groupText}; benchmark ${l.benchmarkText} (${l.source}, ${l.year}${l.sizeBand !== "all" ? `, firms ${l.sizeBand}` : ""}).${l.read ? ` ${l.read}` : ""}`);
  return [head, ...body, "Cite the source and year in words when you use one of these. A group figure of — means its data does not say; do not estimate it."].join("\n");
}

const clean = (r) => ({
  metric: METRIC_KEYS.includes(r.metric) ? r.metric : null,
  sizeBand: SIZE_BANDS.includes(r.sizeBand) ? r.sizeBand : "all",
  region: REGIONS.includes(r.region) ? r.region : "all",
  value: Number.isFinite(Number(r.value)) ? Number(r.value) : null,
  year: Number.isInteger(Number(r.year)) ? Number(r.year) : null,
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
  { metric: "premium_family_annual", sizeBand: "3-49", region: "all", value: 26000, year: 2025, source: "Canned (KENNION_FAKE_AI)" },
  { metric: "employer_share_single_pct", sizeBand: "all", region: "all", value: 83, year: 2025, source: "Canned (KENNION_FAKE_AI)" },
];

/**
 * Ask the model to search the web for the current published figures and
 * return rows. Returned as proposed; nothing is used until staff approve it.
 */
export async function proposeBenchmarks({ apiKey, model = "claude-opus-5", fake = false, onStatus = () => undefined } = {}) {
  if (fake) return FAKE_ROWS.map(normalizeRow).filter(Boolean);
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  const ask = `Find the most recent published employer health benefits benchmarks for U.S. employers and return them as data rows.

Sources to prefer, in order: KFF Employer Health Benefits Survey (latest year), Mercer National Survey of Employer-Sponsored Health Plans, SHRM, the Bureau of Labor Statistics National Compensation Survey. Use the survey's own tables; do not estimate.

Metrics (use these exact keys):
${METRICS.map((m) => `- ${m.key}: ${m.label} (${m.unit === "pct" ? "percent, e.g. 83" : "dollars per year, e.g. 9000"})`).join("\n")}

Cuts: size bands ${SIZE_BANDS.join(", ")} where the survey reports them (KFF reports small firms 3-199 and large 200+; when a figure is only for 3-199, give it for both 3-49 and 50-199 with a note), plus "all" for all firms. Region "south" where the survey reports it, else "all".

Return ONLY a JSON array, no prose, of objects: {"metric","sizeBand","region","value","year","source","sourceUrl","note"}. value is a number. year is the survey year. source is the survey name. Include every metric and cut you can find with confidence; leave out anything you cannot source.`;
  onStatus("Searching published surveys…");
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
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

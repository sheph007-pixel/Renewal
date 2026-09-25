// A Gravie rate workbook: the quote Gravie returns for one group, as an
// Excel file. The "EPO" and "PPO" sheets each price the same 67 plan designs
// on Cigna Open Access Plus - the EPO version has no out-of-network cover,
// the PPO does - under a header block (group, effective date, quote number,
// subscribers quoted by tier). Some workbooks also carry a "Narrow Network"
// sheet: the designs priced on Cigna LocalPlus. Every priced plan on all
// three is a quoted medical plan - read, stored, audited and shown. The
// "Benefits Grid (static)" sheet, the same for every group, has no rates.
import * as XLSX from "xlsx";
import { canonicalizePlans } from "./plan-canonical.js";

const TIER_KEYS = { "EE:": "EE", "ES:": "ES", "EC:": "EC", "F:": "FAM", "Total:": "total" };

/** Excel serial or text date -> "yyyy-mm-dd", or null. */
function isoDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "$8000/$16000" -> the individual figure, 8000; anything else null. */
function firstMoney(v) {
  if (typeof v === "number") return v;
  const m = String(v || "").match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** The plan family, from the "Plan Type" column or, failing that, the name. */
function planType(cell, name) {
  const t = String(cell || "").trim();
  if (t) return t.replace(/^Comfort Fit$/i, "ComfortFit");
  const m = String(name).match(/\b(QHDHP|HDHP|ComfortFit|Comfort|Copay)\b/i);
  return m ? m[1] : null;
}

function readHeader(rows) {
  const h = { tiers: {} };
  for (const r of rows.slice(0, 16)) {
    if (!r) continue;
    for (let j = 0; j < r.length; j++) {
      const v = r[j];
      if (typeof v !== "string") continue;
      const next = r[j + 1];
      if (v === "Group Name:") h.group = String(next || "").trim();
      else if (v === "Effective Date") h.effectiveDate = isoDate(next);
      else if (v === "Date Generated:") h.generated = isoDate(next);
      else if (v === "Quote Number:") h.quoteNumber = next == null ? null : String(next).trim();
      else if (v === "Network:") h.network = String(next || "").trim();
      else if (v === "PBM:") h.pbm = String(next || "").trim();
      else if (v === "Stop Loss Carrier:") h.stopLoss = String(next || "").trim();
      else if (v === "Spec Deductible:") h.specDeductible = num(next);
      else if (v === "Contract Type:") h.contractType = String(next || "").trim();
      else if (TIER_KEYS[v] && num(next) != null) h.tiers[TIER_KEYS[v]] = next;
      else if (v === "Contingencies") h.contingencies = [];
    }
    // The contingencies run down column H under the heading.
    if (h.contingencies && typeof r[7] === "string" && r[7] !== "Contingencies") h.contingencies.push(r[7].trim());
  }
  return h;
}

/** The plan rows under a "Plan Name" header on one sheet. */
function readPlans(rows, sheetName, network) {
  const hi = rows.findIndex((r) => r && r[0] === "Plan Name");
  if (hi < 0) return [];
  const head = rows[hi].map((v) => String(v || "").trim());
  const col = (label) => head.indexOf(label);
  const c = {
    type: col("Plan Type"),
    ded: col("Deductible"),
    oop: col("OOPM"),
    coins: col("Coinsurance"),
    EE: col("EE Rate"),
    ES: col("ES Rate"),
    EC: col("EC Rate"),
    FAM: col("F Rate"),
  };
  const out = [];
  for (const [k, r] of rows.slice(hi + 1).entries()) {
    if (!r || typeof r[0] !== "string" || !/^Gravie/.test(r[0])) continue;
    const name = r[0].trim();
    const rates = { EE: num(r[c.EE]), ES: num(r[c.ES]), EC: num(r[c.EC]), FAM: num(r[c.FAM]) };
    if (rates.EE == null) continue;
    const epo = /\bEPO$/.test(name);
    out.push({
      name,
      sheet: sheetName,
      /** The row on the sheet this plan is read from, as Excel numbers it - its provenance. */
      row: hi + 1 + k + 1,
      /** "EPO" or "PPO": the one thing that differs between the two sheets. */
      variant: epo ? "EPO" : "PPO",
      network: `${network} (${epo ? "EPO" : "PPO"})`,
      planType: planType(c.type >= 0 ? r[c.type] : null, name),
      deductible: c.ded >= 0 ? String(r[c.ded] ?? "") : "",
      oopMax: c.oop >= 0 ? String(r[c.oop] ?? "") : "",
      coinsurance: c.coins >= 0 ? num(r[c.coins]) : null,
      rates,
    });
  }
  return out;
}

/**
 * The sheets that make up the quote, each with the network its plans are
 * priced on: Open Access Plus PPO and EPO (the same designs without
 * out-of-network cover), and the Narrow Network sheet on Cigna LocalPlus.
 */
const RATE_SHEETS = /^(PPO|EPO|Narrow Network)$/i;
const sheetNetwork = (name) => (/narrow/i.test(name) ? "Cigna LocalPlus" : "Cigna Open Access Plus");

/**
 * Every sheet in the workbook is enumerated and accounted for: a rate sheet
 * is parsed; a sheet Kennion knowingly does not quote from is recorded with
 * the reason; anything else is "unrecognized" - a sheet no rule covers, so
 * the workbook cannot be Verified until a person looks (a new Gravie layout
 * is never silently half-read).
 */
const KNOWN_SHEETS = [{ test: /benefits?\s*grid/i, reason: "Static benefits grid, the same for every group: no rates" }];
function sheetStatus(name) {
  if (RATE_SHEETS.test(name.trim())) return { status: "parsed" };
  const k = KNOWN_SHEETS.find((x) => x.test.test(name));
  return k ? { status: "not a quote sheet", reason: k.reason } : { status: "unrecognized" };
}

/**
 * Parse one workbook. Returns the header facts, the subscribers quoted by
 * tier, and every priced plan on the PPO, EPO and Narrow Network sheets, in
 * the carrier's order (PPO first, then EPO, then Narrow Network).
 */
export function parseGravieWorkbook(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  let header = null;
  const plans = [];
  // The PPO sheet first, then EPO: the order the plans are listed (and the
  // client-facing designs numbered) in.
  const rank = (n) => (/^PPO$/i.test(n.trim()) ? 0 : /^EPO$/i.test(n.trim()) ? 1 : 2);
  const sheets = wb.SheetNames.filter((n) => RATE_SHEETS.test(n.trim())).sort((a, b) => rank(a) - rank(b));
  for (const sheetName of sheets) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const h = readHeader(rows);
    if (!header && h.group) header = h;
    plans.push(...readPlans(rows, sheetName.trim().toUpperCase(), sheetNetwork(sheetName)));
  }
  if (!header || !header.group) throw new Error("Not a Gravie rate workbook: no group name in a sheet header");
  if (!plans.length) throw new Error("Not a Gravie rate workbook: no priced plans on a PPO or EPO sheet");
  const sheetList = wb.SheetNames.map((name) => ({ name, ...sheetStatus(name), plans: plans.filter((pl) => pl.sheet === name.trim().toUpperCase()).length }));
  return { ...header, plans, sheets: sheetList };
}

/** The rows the carrier_quotes tables take: one per plan, monthly at the quoted tiers. */
export function gravieQuoteRows(p) {
  const t = p.tiers || {};
  return p.plans.map((pl) => ({
    name: pl.name,
    planType: pl.planType,
    // PPO / EPO, and LocalPlus for the Narrow Network sheet's plans.
    network: /LocalPlus/i.test(pl.network) ? `LocalPlus ${pl.variant}` : pl.variant,
    deductible: pl.deductible || null,
    oopMax: pl.oopMax || null,
    coinsurance: pl.coinsurance,
    rates: pl.rates,
    monthly: +(["EE", "ES", "EC", "FAM"].reduce((n, k) => n + (pl.rates[k] || 0) * (t[k] || 0), 0)).toFixed(2),
  }));
}

/**
 * The same facts in the shape a proposal read by Claude carries, so the
 * workbook files under the group's Gravie slot and prices on the Options page
 * like any other proposal.
 */
export function gravieExtracted(p) {
  const t = p.tiers || {};
  const enrolled = ["EE", "ES", "EC", "FAM"].reduce((n, k) => n + (t[k] || 0), 0) || null;
  // Each row is one plan appearance with its sheet and row as provenance;
  // the same canonicalization every other proposal goes through folds them
  // (a design listed twice is one plan) and sets out the reconciliation.
  const appearances = p.plans.map((pl) => {
    const monthly =
      enrolled == null
        ? null
        : +(["EE", "ES", "EC", "FAM"].reduce((n, k) => n + (pl.rates[k] || 0) * (t[k] || 0), 0)).toFixed(2);
    return {
      name: pl.name,
      plan_code: null,
      network: pl.network,
      plan_type: pl.planType,
      deductible: pl.deductible || null,
      oop_max: pl.oopMax || null,
      ...(pl.coinsurance != null ? { benefits: { coinsurance: `${Math.round(pl.coinsurance * (pl.coinsurance <= 1 ? 100 : 1))}%` } } : {}),
      rates: pl.rates,
      monthly_total: monthly,
      source_sheet: pl.sheet,
      source_rows: pl.row ? `row ${pl.row}` : "",
    };
  });
  const canon = canonicalizePlans(appearances);
  const plans = canon.plans;
  const sheets = [...new Set(p.plans.map((pl) => pl.sheet))];
  return {
    carrier: "Gravie",
    funding: "level funded",
    quotes_medical: true,
    quote_id: p.quoteNumber || null,
    group_name_on_document: p.group,
    matched_group: null,
    confidence: 1,
    effective_date: p.effectiveDate || null,
    proposal_type: "new business",
    enrolled_on_document: enrolled,
    plans,
    reconciliation: canon.reconciliation,
    extraction: { method: "parser", model: null, parts: 1, at: new Date().toISOString() },
    // Every sheet enumerated and accounted for (see KNOWN_SHEETS).
    coverage: {
      kind: "sheets",
      parser: "gravie",
      total_sheets: (p.sheets || []).length,
      inspected_sheets: (p.sheets || []).filter((sh) => sh.status !== "unrecognized").length,
      sheets: p.sheets || [],
    },
    total_monthly: null,
    summary:
      `Gravie level-funded rate workbook, quote ${p.quoteNumber || "n/a"}: ${plans.length} plan prices, ` +
      `${sheets.join(" and ")} on Cigna Open Access Plus, priced on ${enrolled ?? "?"} subscribers ` +
      `(EE ${t.EE ?? 0}, ES ${t.ES ?? 0}, EC ${t.EC ?? 0}, F ${t.FAM ?? 0}).`,
    audit_flags: [],
  };
}

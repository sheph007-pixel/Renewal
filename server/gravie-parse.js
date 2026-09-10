// A Gravie rate workbook: the quote Gravie returns for one group, as an
// Excel file. Each sheet prices the same menu on one network — "EPO" and
// "PPO" on Cigna Open Access Plus, and for groups in a LocalPlus area a
// "Narrow Network" sheet with both EPO and PPO rows — under a header block
// (group, effective date, quote number, subscribers quoted by tier). The
// "Benefits Grid (static)" sheet is the same for every group and is skipped.
import * as XLSX from "xlsx";

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
  for (const r of rows.slice(hi + 1)) {
    if (!r || typeof r[0] !== "string" || !/^Gravie/.test(r[0])) continue;
    const name = r[0].trim();
    const rates = { EE: num(r[c.EE]), ES: num(r[c.ES]), EC: num(r[c.EC]), FAM: num(r[c.FAM]) };
    if (rates.EE == null) continue;
    const epo = /\bEPO$/.test(name);
    out.push({
      name,
      sheet: sheetName,
      network: `${network}${epo ? " (EPO)" : " (PPO)"}`,
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
 * Parse one workbook. Returns the header facts, the subscribers quoted by
 * tier, and every priced plan across the rate sheets — one row per plan per
 * network, since an EPO and a PPO of the same design are two prices.
 */
export function parseGravieWorkbook(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  let header = null;
  const plans = [];
  for (const sheetName of wb.SheetNames) {
    if (/benefits grid/i.test(sheetName)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const h = readHeader(rows);
    if (!header && h.group) header = h;
    const network = /narrow/i.test(sheetName) ? "Cigna LocalPlus" : "Cigna Open Access Plus";
    plans.push(...readPlans(rows, sheetName, network));
  }
  if (!header || !header.group) throw new Error("Not a Gravie rate workbook: no group name in a sheet header");
  if (!plans.length) throw new Error("Not a Gravie rate workbook: no priced plans");
  return { ...header, plans };
}

/**
 * The same facts in the shape a proposal read by Claude carries, so the
 * workbook files under the group's Gravie slot and prices on the Options page
 * like any other proposal.
 */
export function gravieExtracted(p) {
  const t = p.tiers || {};
  const enrolled = ["EE", "ES", "EC", "FAM"].reduce((n, k) => n + (t[k] || 0), 0) || null;
  const plans = p.plans.map((pl) => {
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
      rates: pl.rates,
      monthly_total: monthly,
    };
  });
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
    total_monthly: null,
    summary:
      `Gravie level-funded rate workbook, quote ${p.quoteNumber || "n/a"}: ${plans.length} plan prices across ` +
      `${sheets.join(", ")} on ${p.network || "Cigna"}, priced on ${enrolled ?? "?"} subscribers ` +
      `(EE ${t.EE ?? 0}, ES ${t.ES ?? 0}, EC ${t.EC ?? 0}, F ${t.FAM ?? 0}).`,
    audit_flags: [],
  };
}

// A carrier's standard plan designs: the catalogue every group's quote from
// that carrier draws on. Angle Health quotes the same designs to every
// group - ANG TRAD 5000 7000, ANG HDHP 3500 3500 and so on - and only the
// rates differ, so the designs are loaded once, keyed by carrier and plan
// code.
//
// The catalogue is SUPPLEMENTAL data, never proposal data. A quoted plan
// whose code is a catalogue design carries the design alongside it, under
// `design`, labelled with where it came from; the plan's own deductible,
// out-of-pocket maximum, plan type and benefits stay exactly what the
// group's proposal says (null where it says nothing). A screen may show a
// design value in a gap the proposal leaves, marked as the carrier's
// standard design; where the two disagree the proposal wins and the
// disagreement is listed. Nothing here is written to the canonical plan.
//
// A catalogue arrives as a workbook with two sheets, the shape Kennion keeps
// its Angle Health catalogue in (server/data/plan-docs):
//   Plans    - one row per design: source_plan_id, plan_name_code, plan_family,
//              in_network_deductible_individual_usd … oon_coinsurance,
//              deductible_embedded_source, source_pdf_page
//   Benefits - one row per service line: source_plan_id, plan_name_code,
//              service_order, service_label, cost_share_source, cost_share_usd,
//              cost_share_percent, deductible_applies, source_pdf_page
// UnitedHealthcare's and Gravie's catalogues load the same way once they are
// in that shape.
import * as XLSX from "xlsx";

/** The form of a plan code that matching works on: upper case, one space between words. */
export function catalogueKey(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

const FAMILY_NAMES = { TRAD: "Traditional", HDHP: "HDHP", VALUE: "Value", QHDHP: "QHDHP", COPAY: "Copay" };

const num = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const yes = (v) => /^(y|yes|true|1|✔)/i.test(String(v ?? "").trim());
const text = (v) => (v == null ? "" : String(v).trim());

function sheetRows(wb, name) {
  const ws = wb.Sheets[name] || wb.Sheets[Object.keys(wb.Sheets).find((s) => s.toLowerCase() === name.toLowerCase()) || ""];
  if (!ws) throw Object.assign(new Error(`The workbook has no "${name}" sheet.`), { status: 400 });
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

/**
 * Read a catalogue workbook. Returns one design per plan row, each with its
 * service lines in the sheet's order. Throws (status 400) on a workbook that
 * is not a catalogue.
 */
export function parseCatalogueWorkbook(buffer, { carrier, planYear = 2027, source = null } = {}) {
  if (!carrier) throw new Error("A carrier is required.");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const plans = sheetRows(wb, "Plans");
  const benefits = sheetRows(wb, "Benefits");
  const byCode = new Map();
  for (const r of plans) {
    const planCode = text(r.plan_name_code);
    if (!planCode) continue;
    const family = text(r.plan_family).toUpperCase() || null;
    byCode.set(catalogueKey(planCode), {
      carrier,
      planYear,
      planCode,
      planId: text(r.source_plan_id) || null,
      family,
      familyName: family ? FAMILY_NAMES[family] || family : null,
      inNetwork: {
        deductibleIndividual: num(r.in_network_deductible_individual_usd),
        deductibleFamily: num(r.in_network_deductible_family_usd),
        oopMaxIndividual: num(r.in_network_oop_max_individual_usd),
        oopMaxFamily: num(r.in_network_oop_max_family_usd),
      },
      outOfNetwork: {
        deductibleIndividual: num(r.oon_deductible_individual_usd),
        deductibleFamily: num(r.oon_deductible_family_usd),
        oopMaxIndividual: num(r.oon_oop_max_individual_usd),
        oopMaxFamily: num(r.oon_oop_max_family_usd),
        coinsurance: num(r.oon_coinsurance),
      },
      deductibleEmbedded: r.deductible_embedded_source == null ? null : yes(r.deductible_embedded_source),
      services: [],
      source,
      sourcePage: num(r.source_pdf_page),
    });
  }
  if (!byCode.size) throw Object.assign(new Error("The Plans sheet has no plan rows (plan_name_code is empty)."), { status: 400 });
  for (const r of benefits) {
    const d = byCode.get(catalogueKey(r.plan_name_code));
    if (!d) continue;
    const label = text(r.service_label);
    if (!label) continue;
    d.services.push({
      order: num(r.service_order) ?? d.services.length + 1,
      label,
      costShare: text(r.cost_share_source) || null,
      amount: num(r.cost_share_usd),
      percent: num(r.cost_share_percent),
      deductibleApplies: yes(r.deductible_applies),
    });
  }
  for (const d of byCode.values()) d.services.sort((a, b) => a.order - b.order);
  return [...byCode.values()];
}

const money0 = (n) => (n == null ? null : `$${Math.round(n).toLocaleString("en-US")}`);

/** One service line as a client reads it: "$25 copay", "20% after deductible", "No cost". */
export function serviceText(s) {
  if (!s) return null;
  const after = s.deductibleApplies ? " after deductible" : "";
  if (s.amount != null) return s.amount === 0 ? "No cost" : `${money0(s.amount)} copay${after}`;
  if (s.percent != null) {
    if (s.percent === 0) return s.deductibleApplies ? "No cost after deductible" : "No cost";
    return `${Math.round(s.percent * 100)}%${after}`;
  }
  return s.costShare || null;
}

const find = (d, re) => (d.services || []).find((s) => re.test(s.label)) || null;

/**
 * The benefit rows a plan card, the printed proposal and the assistant show,
 * from the catalogue's service lines. Where three lines say the same thing
 * (labs, X-ray and imaging all 20% after deductible) they read as one.
 */
export function designBenefits(d) {
  const t = (re) => serviceText(find(d, re));
  const labs = t(/independent laboratory|^lab/i);
  const xray = t(/diagnostic tests|x-ray/i);
  const imaging = t(/^imaging|advanced imaging|mri/i);
  const img = [...new Set([labs, xray, imaging].filter(Boolean))];
  // Drug tiers read as one line, copays bare ("$20 / $60 / $85 / 20% after
  // deductible"); four tiers that say the same thing say it once.
  const rxText = (s) => (s && s.amount != null && s.amount > 0 ? `${money0(s.amount)}${s.deductibleApplies ? " after deductible" : ""}` : serviceText(s));
  const rxLines = [find(d, /tier 1|generic/i), find(d, /tier 2|preferred brand/i), find(d, /tier 3|non-preferred/i), find(d, /tier 4|specialty/i)].map(rxText).filter(Boolean);
  const rxTiers = new Set(rxLines).size === 1 ? [`${rxLines[0]} (all tiers)`] : rxLines;
  return {
    doctorVisit: t(/primary care/i),
    specialist: t(/specialist/i),
    imaging: img.length === 1 ? img[0] : img.length ? `${labs ?? "-"} labs · ${xray ?? "-"} X-ray · ${imaging ?? "-"} imaging` : null,
    urgentCare: t(/urgent care/i),
    hospital: t(/inpatient/i),
    rx: rxTiers.length ? rxTiers.join(" / ") : null,
    er: t(/emergency/i),
  };
}

/** "$5,000" for the individual in-network deductible; null when the catalogue has none. */
export const designDeductible = (d) => money0(d.inNetwork && d.inNetwork.deductibleIndividual);
export const designOopMax = (d) => money0(d.inNetwork && d.inNetwork.oopMaxIndividual);

/** Every design keyed by carrier and plan code, for lookups. */
export function catalogueIndex(designs) {
  const idx = new Map();
  for (const d of designs || []) idx.set(`${catalogueKey(d.carrier)}|${catalogueKey(d.planCode)}`, d);
  return idx;
}

/** The catalogue design a quoted plan is, by its name or printed code; null when the carrier has no such design. */
export function lookupDesign(index, carrier, plan) {
  if (!index || !carrier || !plan) return null;
  const c = catalogueKey(carrier);
  for (const cand of [plan.planCode, plan.name]) {
    const k = catalogueKey(cand);
    if (k && index.has(`${c}|${k}`)) return index.get(`${c}|${k}`);
  }
  return null;
}

/** The individual in-network figure a proposal prints ("$5,000 / $10,000" -> 5000); null when it cannot be read. */
const firstAmount = (v) => {
  const m = /\$?\s*([\d,]+(?:\.\d+)?)/.exec(String(v ?? ""));
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

/**
 * Where the proposal and the carrier's standard design state different
 * figures for the same thing. The proposal wins; this only says so.
 */
export function designDisagreements(pl, d) {
  const out = [];
  const pairs = [
    ["deductible", pl.deductible, d.inNetwork && d.inNetwork.deductibleIndividual],
    ["oopMax", pl.oopMax, d.inNetwork && d.inNetwork.oopMaxIndividual],
  ];
  for (const [field, stated, standard] of pairs) {
    const a = firstAmount(stated);
    if (a == null || standard == null) continue;
    if (Math.abs(a - standard) > 0.5) out.push({ field, proposal: String(stated), standardDesign: money0(standard) });
  }
  return out;
}

/**
 * The plans of one proposal, each that is a catalogue design carrying that
 * design under `design` - a separate, labelled layer: its source, its own
 * deductible, OOP max, family and benefit rows, every service line, and any
 * figure where it disagrees with the proposal. The plan's own values are
 * left exactly as the proposal states them. A plan the catalogue does not
 * know is returned as it was.
 */
export function applyCatalogue(proposal, index, carrier) {
  if (!proposal || !Array.isArray(proposal.plans) || !index || !index.size) return proposal;
  let touched = false;
  const plans = proposal.plans.map((pl) => {
    const d = lookupDesign(index, carrier, pl);
    if (!d) return pl;
    touched = true;
    return {
      ...pl,
      design: {
        kind: "catalogue",
        source: `${d.carrier} standard plan design ${d.planCode} (Kennion's ${d.carrier} plan catalogue, plan year ${d.planYear})`,
        planCode: d.planCode,
        planId: d.planId,
        family: d.familyName,
        planYear: d.planYear,
        deductible: designDeductible(d),
        oopMax: designOopMax(d),
        benefits: designBenefits(d),
        inNetwork: d.inNetwork,
        outOfNetwork: d.outOfNetwork,
        deductibleEmbedded: d.deductibleEmbedded,
        services: d.services.map((s) => ({ label: s.label, costShare: s.costShare, deductibleApplies: s.deductibleApplies, text: serviceText(s) })),
        disagreements: designDisagreements(pl, d),
        // Whether the carrier's actual SBC/SOB PDF is on file for this design
        // (server/plan-documents.js), so a plan card can offer "View SBC"/"View
        // SOB" only where there is something to open.
        documents: d.documents || null,
      },
    };
  });
  return touched ? { ...proposal, plans } : proposal;
}

/** One line per design for the assistant's figures. */
export function designLine(d) {
  const b = designBenefits(d);
  const oon = d.outOfNetwork || {};
  const parts = [
    `deductible ${designDeductible(d) || "-"} individual / ${money0(d.inNetwork && d.inNetwork.deductibleFamily) || "-"} family`,
    `out-of-pocket max ${designOopMax(d) || "-"} / ${money0(d.inNetwork && d.inNetwork.oopMaxFamily) || "-"}`,
    b.doctorVisit ? `PCP ${b.doctorVisit}` : null,
    b.specialist ? `specialist ${b.specialist}` : null,
    b.urgentCare ? `urgent care ${b.urgentCare}` : null,
    b.er ? `ER ${b.er}` : null,
    b.hospital ? `inpatient ${b.hospital}` : null,
    b.rx ? `Rx ${b.rx}` : null,
    oon.deductibleIndividual != null ? `out-of-network deductible ${money0(oon.deductibleIndividual)}, OOP max ${money0(oon.oopMaxIndividual) || "-"}${oon.coinsurance != null ? `, ${Math.round(oon.coinsurance * 100)}% coinsurance` : ""}` : null,
    d.deductibleEmbedded === false ? "family deductible not embedded" : null,
  ].filter(Boolean);
  return `${d.planCode}${d.familyName ? ` (${d.familyName})` : ""}: ${parts.join("; ")}`;
}

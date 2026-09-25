// Carrier standard plan designs that are not in a plan catalogue workbook:
// today, Gravie's Benefits Grid - the static sheet that is the same in every
// Gravie rate workbook, transcribed once, giving in-network benefits by plan
// family (Comfort, ComfortFit, Copay, QHDHP, HDHP).
//
// SUPPLEMENTAL data, never proposal data. The grid is not priced per plan
// and is not part of any group's quote: a Gravie plan's own values are the
// ones its rate row states (name, network, plan type, deductible, OOP max,
// coinsurance, rates). The grid is attached beside the plan as `design`,
// labelled "Gravie standard plan design", the same carrier-neutral shape a
// catalogue design has (plan-catalogue.js applyCatalogue), so every screen
// treats both one way: shown only where the proposal leaves a gap, and
// marked as the carrier's standard design.

const COINS = "0-20% coins after ded";

export const GRAVIE_BENEFITS_GRID = {
  Comfort: {
    preventive: "No cost",
    pcp: "No cost",
    specialist: "No cost",
    uc: "No cost",
    er: "$500 copay",
    basicLabs: "No cost",
    advancedLabs: "No cost",
    hospital: "No cost after OOPM",
    rxGeneric: "No cost",
    rxPreferredBrand: "$75 copay",
    rxNonPreferredBrand: "$100 copay",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOn; otherwise $250 copay",
  },
  ComfortFit: {
    preventive: "No cost",
    pcp: "No cost",
    specialist: "No cost",
    uc: "No cost",
    er: "$950 copay",
    basicLabs: "No cost",
    advancedLabs: "No cost after OOPM",
    hospital: "No cost after OOPM",
    rxGeneric: "No cost",
    rxPreferredBrand: "$75 copay",
    rxNonPreferredBrand: "$150 copay",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOn; otherwise $500 copay",
  },
  Copay: {
    preventive: "No cost",
    pcp: "No cost through Teladoc; otherwise $25 copay",
    specialist: "$75 copay",
    uc: "No cost through Teladoc; otherwise $75 copay",
    er: "$500 copay",
    basicLabs: COINS,
    advancedLabs: COINS,
    hospital: "0-30% coins after ded",
    rxGeneric: "$10 copay",
    rxPreferredBrand: "$50 copay",
    rxNonPreferredBrand: "$125 copay",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOn; otherwise $350 copay",
  },
  QHDHP: {
    preventive: "No cost",
    pcp: `No cost through Teladoc; otherwise ${COINS}`,
    specialist: COINS,
    uc: `No cost through Teladoc; otherwise ${COINS}`,
    er: COINS,
    basicLabs: COINS,
    advancedLabs: COINS,
    hospital: COINS,
    rxGeneric: COINS,
    rxPreferredBrand: COINS,
    rxNonPreferredBrand: "0-50% coins after ded",
    rxNonPreferredSpecialty: COINS,
  },
  HDHP: {
    preventive: "No cost",
    pcp: "No cost after ded",
    specialist: "No cost after ded",
    uc: "No cost after ded",
    er: "No cost after ded",
    basicLabs: "No cost after ded",
    advancedLabs: "No cost after ded",
    hospital: "No cost after ded",
    rxGeneric: "No cost after ded",
    rxPreferredBrand: "No cost after ded",
    rxNonPreferredBrand: "No cost after ded",
    rxNonPreferredSpecialty: "No cost if enrolled in SaveOnSP; otherwise no cost after ded",
  },
};

export const GRAVIE_GRID_NOTES = [
  "In-network benefits. EPO versions of Gravie plans do not cover out-of-network services.",
  "Teladoc visits are free on QHDHP, Copay, Comfort and ComfortFit plans.",
];

/**
 * The Benefits Grid family a Gravie plan is looked up under: the plan type
 * the rate row prints, else the family word in the plan's printed name. A
 * lookup key into the supplemental grid only - never stored as the plan's
 * type.
 */
export function gravieFamily(planType, name) {
  const t = `${planType || ""} ${name || ""}`;
  if (/\bQHDHP\b/i.test(t)) return "QHDHP";
  if (/\bHDHP\b/i.test(t)) return "HDHP";
  if (/Comfort\s?Fit/i.test(t)) return "ComfortFit";
  if (/\bComfort\b/i.test(t)) return "Comfort";
  if (/\bCopay\b/i.test(t)) return "Copay";
  return null;
}

/** The grid's family as the same benefit rows a catalogue design carries. */
export function gridBenefits(gb) {
  return {
    doctorVisit: gb.pcp,
    specialist: gb.specialist,
    imaging: gb.basicLabs === gb.advancedLabs ? gb.basicLabs : `${gb.basicLabs} basic · ${gb.advancedLabs} advanced`,
    urgentCare: gb.uc,
    er: gb.er,
    hospital: gb.hospital,
    rx: `${gb.rxGeneric} generic · ${gb.rxPreferredBrand} preferred brand · ${gb.rxNonPreferredBrand} non-preferred`,
  };
}

/**
 * The plans of one Gravie proposal, each carrying its family's Benefits
 * Grid under `design` (unless a catalogue design is already attached). The
 * plan's own values are left exactly as its rate row states them.
 */
export function applyBenefitsGrid(proposal, carrier) {
  if (!proposal || !Array.isArray(proposal.plans) || !/gravie/i.test(String(carrier || ""))) return proposal;
  let touched = false;
  const plans = proposal.plans.map((pl) => {
    if (pl.design) return pl;
    const family = gravieFamily(pl.planType, pl.name);
    const gb = family ? GRAVIE_BENEFITS_GRID[family] : null;
    if (!gb) return pl;
    touched = true;
    return {
      ...pl,
      design: {
        kind: "benefits-grid",
        source: `Gravie standard plan design, ${family} family (Gravie's Benefits Grid, the same for every group - not this group's rate sheet)`,
        family,
        deductible: null,
        oopMax: null,
        benefits: gridBenefits(gb),
        notes: GRAVIE_GRID_NOTES,
        disagreements: [],
        documents: null,
      },
    };
  });
  return touched ? { ...proposal, plans } : proposal;
}

// Does a proposal quote medical, or only ancillary lines — dental, vision,
// life, disability? Claude answers that when it reads a document; for the
// ones read before it was asked, the document itself usually says.
const ANCILLARY_WORDS = /\b(dental|vision|life|ad&d|disability|std|ltd|accident|critical illness|hospital indemnity|cancer|eyewear|orthodont\w*|voluntary)\b/i;
const MEDICAL_WORDS = /\b(medical|health|ppo|hmo|epo|hsa|hdhp|qhdhp|copay|deductible|choice|core|navigate|surest|select|gold|silver|bronze|platinum|level.?funded|fully.?insured)\b/i;

/**
 * Whether a proposal quotes medical, decided from the document when Claude
 * was not asked: a plan with a deductible or out-of-pocket max, or a medical
 * word in its name, is group health; a document whose plans and text speak
 * only of dental, vision, life and the like is ancillary. Returns true,
 * false, or null when the document does not say.
 */
export function medicalFromDocument(row) {
  const x = row.extracted;
  if (!x) return null;
  const plans = Array.isArray(x.plans) ? x.plans : [];
  const medicalPlan = plans.some(
    (pl) => (pl.deductible != null && pl.deductible !== "") || (pl.oop_max != null && pl.oop_max !== "") ||
      (MEDICAL_WORDS.test(String(pl.name || "")) && !ANCILLARY_WORDS.test(String(pl.name || ""))),
  );
  if (medicalPlan) return true;
  const text = `${row.filename || ""} ${row.summary || ""} ${x.proposal_type || ""} ${plans.map((pl) => pl.name || "").join(" ")}`;
  if (/\bancillar(y|ies)\b/i.test(text)) return false;
  if (plans.length && plans.every((pl) => ANCILLARY_WORDS.test(String(pl.name || "")))) return false;
  if (ANCILLARY_WORDS.test(text) && !MEDICAL_WORDS.test(text)) return false;
  return null;
}

export function isAncillaryRow(row) {
  const x = row.extracted || {};
  if (typeof x.quotes_medical === "boolean") return !x.quotes_medical;
  return medicalFromDocument(row) === false;
}


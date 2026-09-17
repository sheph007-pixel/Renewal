// Which groups belong in the renewal portal.
//
// The 2027 program covers groups on EBPA, HealthEZ and BCBS of Alabama. A group
// qualifies by having at least one MEDICAL plan from one of those with someone
// actually enrolled in it - a plan on the books with nobody on it is not
// coverage.
//
// Carrier names arrive as free text from the Employee Navigator plan catalog,
// so matching is deliberately tolerant. Anything that does not match is never
// silently dropped: the group stays visible in Rate Administration, flagged,
// with the carriers it does have shown, so an unmatched spelling is obvious
// rather than invisible.

export const CARRIERS = [
  { key: "EBPA", label: "EBPA", test: (s) => /\bebpa\b/i.test(s) },
  { key: "HealthEZ", label: "HealthEZ", test: (s) => /health\s*-?\s*ez/i.test(s) },
  {
    key: "BCBS-AL",
    label: "BCBS of Alabama",
    // "Blue Cross Blue Shield of Alabama", "BCBS AL", and Alabama's own
    // "Blue Secure" / "Blue Choice" product families.
    test: (s) =>
      /\bbcbs\b/i.test(s) ||
      /blue\s*cross/i.test(s) ||
      /blue\s*shield/i.test(s) ||
      /blue\s*(secure|choice|saver|preferred)/i.test(s),
  },
];

export const matchCarrier = (text) => {
  const s = String(text || "");
  const hit = CARRIERS.find((c) => c.test(s));
  return hit ? hit.key : null;
};

/**
 * The program carrier a plan belongs to ("EBPA", "HealthEZ", "BCBS-AL"), or
 * null. The carrier may be named on the plan's TPA field or inside the plan
 * name itself ("Blue Secure Silver for Business" administered through a TPA).
 */
export const programOf = (plan) => matchCarrier(plan.tpa) || matchCarrier(plan.plan);

/**
 * Decide whether a group belongs in the portal.
 *
 * Returns the matched programs and the carriers seen either way, so the reason
 * for an exclusion can be shown rather than guessed at.
 */
export function eligibilityOf(group) {
  const plans = group.plans || [];
  const matched = new Set();
  const seen = new Set();
  let enrolledOnProgram = 0;

  for (const p of plans) {
    const key = programOf(p);
    const label = (p.tpa || "").trim() || "-";
    seen.add(label);
    if (key && (p.enrolled || 0) > 0) {
      matched.add(key);
      enrolledOnProgram += p.enrolled || 0;
    }
  }

  return {
    eligible: matched.size > 0,
    programs: [...matched],
    carriers: [...seen],
    enrolledOnProgram,
  };
}

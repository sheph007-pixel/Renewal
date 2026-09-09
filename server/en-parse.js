// Parser for Employee Navigator Data API XML exports.
//
// Produces the same shape the portal already consumes, so an imported group is
// indistinguishable from one that came out of the original census build.
//
// Deliberate choices, each of which changes the numbers:
//   - Only Benefit=Medical enrollments make up the members, plans and rates the
//     portal prices from. The exports also carry Dental, Vision, Life, Accident
//     and Cancer; those are kept ONLY as per-line premium totals (`lines`) so
//     the Groups dashboard can show total premium next to group health.
//   - Only rows that are EmploymentStatus=Active AND have no EndDate. A
//     terminated employee or a closed enrollment is not current coverage. The
//     same rule applies to every benefit line.
//   - CoverageLevel is used verbatim as the tier; EN's wording already matches
//     the portal's ("Employee + Child(ren)" etc).
//   - A tier's rate is PlanCost for that tier, which EN bills uniformly per
//     plan+tier. Tiers nobody is enrolled in get no rate here; the portal
//     calculates those at the program factors and marks them "calc.".

import { programOf } from "./eligibility.js";

const TIER_ORDER = ["Employee", "Employee + Spouse", "Employee + Child(ren)", "Employee + Family"];
const TIER_KEY = {
  "Employee": "EE",
  "Employee + Spouse": "ES",
  "Employee + Child(ren)": "EC",
  "Employee + Family": "FAM",
};
const TIER_LABEL = { EE: "Employee", ES: "Employee + Spouse", EC: "Employee + Child(ren)", FAM: "Employee + Family" };

/**
 * Employee Navigator spells coverage levels many ways — "Employee Only",
 * "Employee + Child", "Employee + Children", "Employee + Domestic Partner",
 * "Employee + Dependents", "Family". Every active medical enrollment must
 * count, so the level is read loosely; only a level that says nothing at all
 * is left unmapped, and even then the person and their premium are kept.
 */
export function tierKeyOf(level) {
  if (!level) return null;
  if (TIER_KEY[level]) return TIER_KEY[level];
  const s = String(level).toLowerCase();
  const spouse = /spouse|partner|\bsp\b/.test(s);
  const child = /child|\bch\b|kid/.test(s);
  if (/family|\bfam\b|dependents|\bdeps?\b/.test(s) || (spouse && child)) return "FAM";
  if (spouse) return "ES";
  if (child) return "EC";
  if (/\+\s*1\b|plus\s*one/.test(s)) return "ES";
  if (/employee|\bee\b|self|individual|single|only/.test(s)) return "EE";
  return null;
}

const text = (xml, tag) => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? decode(m[1]).trim() : null;
};
const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
const blocks = (xml, tag) => xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g")) || [];
const isNil = (xml, tag) => new RegExp(`<${tag}[^>]*xsi:nil="true"`).test(xml);

/**
 * An enrollment is current when it has not ended: EndDate nil, absent, or
 * still in the future (a scheduled termination is still coverage today).
 */
function isCurrent(en, asOf) {
  if (isNil(en, "EndDate")) return true;
  const end = text(en, "EndDate");
  if (end == null || end === "") return true;
  const d = new Date(end);
  if (isNaN(d)) return true;
  // Coverage runs through the end date, so a line ending today is still on.
  const day = (x) => `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
  return day(d) >= day(asOf);
}

/** Whole years between a date of birth and an as-of date. */
function ageAt(dob, asOf) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  let a = asOf.getFullYear() - d.getFullYear();
  const m = asOf.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < d.getDate())) a--;
  return a;
}

/** EN plan names carry the year ("HealthEZ Saver HSA 2026"); the portal doesn't. */
const cleanPlan = (p) => (p || "").replace(/\s+(19|20)\d{2}\s*$/, "").trim();

const round2 = (n) => Math.round(n * 100) / 100;

/** Programs whose medical premium is "group health": the captive program. BCBS of Alabama is not. */
export const GROUP_HEALTH_PROGRAMS = new Set(["EBPA", "HealthEZ"]);

/**
 * The premium figures the Groups page shows, from a group's `plans` (medical,
 * always present) and `lines` (every other benefit, present only on groups
 * imported since supplemental lines were captured).
 *
 *   groupHealthMonthly  medical plans on EBPA or HealthEZ only
 *   medicalMonthly      every medical plan, BCBS included
 *   supplementalMonthly dental, vision, life, disability … — 0 until loaded
 *   totalMonthly        medical + supplemental
 *   linesLoaded         whether the export this group came from was read for
 *                       supplemental lines at all; false for the shipped
 *                       census and for imports made before that was captured
 */
/**
 * Each medical plan with how it is classified:
 *   program      "EBPA" | "HealthEZ" | "BCBS-AL" | null (carrier not recognised)
 *   groupHealth  counted in the captive group-health figure
 *   assumed      the carrier could not be read, but every recognised plan in
 *                this group is EBPA/HealthEZ and none is BCBS, so it is taken
 *                as group health rather than dropped — and flagged
 */
export function classifyPlans(group) {
  const plans = Array.isArray(group.plans) ? group.plans : [];
  const programs = new Set(plans.map(programOf).filter(Boolean));
  const captiveOnly = programs.size > 0 && [...programs].every((k) => GROUP_HEALTH_PROGRAMS.has(k));
  return plans.map((p) => {
    const program = programOf(p);
    const assumed = !program && captiveOnly;
    return { ...p, program, groupHealth: GROUP_HEALTH_PROGRAMS.has(program) || assumed, assumed };
  });
}

export function premiumBreakdown(group) {
  const plans = classifyPlans(group);
  const lines = Array.isArray(group.lines) ? group.lines : null;
  const sum = (xs) => round2(xs.reduce((s, x) => s + (Number(x.monthly) || 0), 0));
  const count = (xs) => xs.reduce((s, x) => s + (Number(x.enrolled) || 0), 0);
  const gh = plans.filter((p) => p.groupHealth);
  const bcbs = plans.filter((p) => p.program === "BCBS-AL");
  const unknown = plans.filter((p) => !p.program && !p.assumed);
  const medicalMonthly = sum(plans);
  const groupHealthMonthly = sum(gh);
  const supplementalMonthly = lines ? sum(lines) : 0;
  return {
    groupHealthMonthly,
    groupHealthEnrolled: count(gh),
    medicalMonthly,
    bcbsMonthly: sum(bcbs),
    bcbsEnrolled: count(bcbs),
    unrecognizedMonthly: sum(unknown),
    unrecognizedEnrolled: count(unknown),
    assumedMonthly: sum(plans.filter((p) => p.assumed)),
    supplementalMonthly,
    totalMonthly: round2(medicalMonthly + supplementalMonthly),
    linesLoaded: lines !== null,
  };
}

const plan0 = (en) => cleanPlan(text(en, "Plan"));

/** Empty diagnostics; see mergeDiagnostics for the rollup across companies. */
export function newDiagnostics() {
  const bucket = () => ({ n: 0, premium: 0, byProgram: {} });
  return {
    employees: { total: 0, byStatus: {}, skipped: {} },
    medical: {
      kept: { n: 0, premium: 0 },
      excluded: { terminatedEmployee: bucket(), ended: bucket(), waived: bucket() },
      noPremium: { n: 0, byProgram: {} },
      endDates: { nil: 0, absent: 0, past: 0, future: 0 },
    },
    // Every other benefit — dental, vision, life, disability… — by the same
    // rules, so a gap against a carrier's stats can be traced here too.
    lines: {
      kept: { n: 0, premium: 0 },
      excluded: { terminatedEmployee: 0, ended: 0, waived: 0 },
      noPremium: 0,
    },
  };
}

/** Add one company's diagnostics into a running total (a + b, in place on a). */
export function mergeDiagnostics(a, b) {
  if (!b) return a;
  const addMap = (x, y) => {
    for (const [k, v] of Object.entries(y || {})) x[k] = (x[k] || 0) + v;
  };
  a.employees.total += b.employees.total;
  addMap(a.employees.byStatus, b.employees.byStatus);
  addMap(a.employees.skipped, b.employees.skipped);
  a.medical.kept.n += b.medical.kept.n;
  a.medical.kept.premium = round2(a.medical.kept.premium + b.medical.kept.premium);
  for (const r of Object.keys(a.medical.excluded)) {
    const x = a.medical.excluded[r];
    const y = b.medical.excluded[r];
    if (!y) continue;
    x.n += y.n;
    x.premium = round2(x.premium + y.premium);
    for (const [p, v] of Object.entries(y.byProgram || {})) {
      x.byProgram[p] = x.byProgram[p] || { n: 0, premium: 0 };
      x.byProgram[p].n += v.n;
      x.byProgram[p].premium = round2(x.byProgram[p].premium + v.premium);
    }
  }
  a.medical.noPremium.n += b.medical.noPremium.n;
  addMap(a.medical.noPremium.byProgram, b.medical.noPremium.byProgram);
  addMap(a.medical.endDates, b.medical.endDates);
  if (b.lines) {
    a.lines.kept.n += b.lines.kept.n;
    a.lines.kept.premium = round2(a.lines.kept.premium + b.lines.kept.premium);
    addMap(a.lines.excluded, b.lines.excluded);
    a.lines.noPremium += b.lines.noPremium;
  }
  return a;
}

/**
 * The catalog names plans slightly differently from the enrollment rows now
 * and then — a stray space, different case, a year in one place and not the
 * other. Try the exact name, then a loose one, and finally, when the whole
 * catalog is on a single carrier, that carrier.
 */
const loose = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function carrierFor(planCarrier, plan) {
  if (planCarrier.has(plan)) return planCarrier.get(plan);
  const want = loose(plan);
  for (const [name, carrier] of planCarrier) {
    const have = loose(name);
    if (have === want || have.startsWith(want) || want.startsWith(have)) return carrier;
  }
  const all = new Set(planCarrier.values());
  return all.size === 1 ? [...all][0] : null;
}

/**
 * A waived or declined election is not coverage. Employee Navigator may emit
 * such a row as an enrollment whose plan or coverage level says so.
 */
const isWaived = (en) =>
  /waiv|declin/i.test(
    [text(en, "Plan"), text(en, "CoverageLevel"), text(en, "EnrollmentStatus")].filter(Boolean).join(" "),
  );

/** Dental and vision first, then the rest alphabetically. */
const BENEFIT_ORDER = ["Dental", "Vision", "Life", "Disability"];
const benefitRank = (b) => {
  const i = BENEFIT_ORDER.findIndex((x) => new RegExp(x, "i").test(b));
  return i === -1 ? BENEFIT_ORDER.length : i;
};

export function parseEmployeeNavigatorXml(xml) {
  if (typeof xml !== "string" || !/<Employee>/.test(xml)) {
    throw new Error("This does not look like an Employee Navigator XML export.");
  }

  // The company header runs up to the plan catalog; slicing to a fixed length
// used to cut the contact block off on companies with several contacts.
const wholeCompany = blocks(xml, "Company")[0] || xml;
const headEnd = wholeCompany.indexOf("<Classes>");
const companyBlock = wholeCompany.slice(0, headEnd > 0 ? headEnd : 8000);
  const identifier = text(companyBlock, "Identifier");
  const name = text(companyBlock, "Name") || identifier;
  if (!name) throw new Error("No company name found in the export.");

  // The export carries a <Plans> catalog naming the carrier for each plan.
  // That is where the TPA comes from; the enrollment rows themselves do not
  // name a carrier.
  const planCarrier = new Map();
  // Every other benefit's carrier, keyed by benefit + plan so a dental and a
  // vision plan that happen to share a name cannot borrow each other's carrier.
  const lineCarrier = new Map();
  const catalog = blocks(xml, "Plans")[0];
  if (catalog) {
    for (const pl of blocks(catalog, "Plan")) {
      const benefit = text(pl, "Benefit");
      const pn = cleanPlan(text(pl, "PlanName"));
      const carrier = text(pl, "Carrier");
      if (!pn || !carrier) continue;
      if (benefit === "Medical") planCarrier.set(pn, carrier);
      else lineCarrier.set(`${benefit}||${pn}`, carrier);
    }
  }

  // Company contacts sit above the employee records; take them before the
  // employee scan so a group's own people are never mistaken for them.
  const contacts = blocks(companyBlock, "Contact")
    .map((c) => ({
      name: text(c, "Name"),
      phone: text(c, "Phone"),
      email: text(c, "Email"),
    }))
    .filter((c) => c.name || c.email);

  const employees = blocks(xml, "Employee");
  // Every employee the census carries, minus a terminated (or otherwise
  // gone) one — this export has no row at all for someone who declined
  // medical, so this headcount is the only reliable stand-in for eligible.
  let activeEmployees = 0;
  const members = [];
  let pyStart = null;
  let pyEnd = null;
  const carriers = new Map();
  // Supplemental lines, aggregated per benefit + carrier + plan. No member
  // detail is kept for these — only the enrolled count and billed premium.
  const lineAgg = new Map();
  // Coverage levels as the export spelled them, and any that could not be read.
  const levelsSeen = {};
  const unmappedLevels = {};
  const today = new Date();

  // What was left out, and why — so the import can be reconciled to Employee
  // Navigator's own counts and any gap explained rather than guessed at.
  const diag = newDiagnostics();
  const programFor = (plan) => {
    const carrier = carrierFor(planCarrier, plan) || "";
    return programOf({ tpa: carrier, plan }) || "Other";
  };
  const note = (reason, en) => {
    const plan = cleanPlan(text(en, "Plan"));
    const cost = Number(text(en, "PlanCost")) || 0;
    const b = diag.medical.excluded[reason];
    const p = programFor(plan);
    b.n++;
    b.premium = round2(b.premium + cost);
    b.byProgram[p] = b.byProgram[p] || { n: 0, premium: 0 };
    b.byProgram[p].n++;
    b.byProgram[p].premium = round2(b.byProgram[p].premium + cost);
  };
  const endDateKind = (en) => {
    if (isNil(en, "EndDate")) return "nil";
    const end = text(en, "EndDate");
    if (end == null || end === "") return "absent";
    const d = new Date(end);
    return isNaN(d) ? "absent" : d > today ? "future" : "past";
  };

  // Distinct employees on any current line, per carrier as the export named
  // it. Employee Navigator's Carrier Stats report counts people this way —
  // an employee on a carrier's medical and its dental is one person — so the
  // portal can be reconciled to it.
  const heads = new Map();
  const headOf = (carrier, idx) => {
    if (!carrier) return;
    const s = heads.get(carrier) || new Set();
    s.add(idx);
    heads.set(carrier, s);
  };

  for (const [empIdx, emp] of employees.entries()) {
    // Employee Navigator counts anyone still enrolled — on leave, on COBRA,
    // a retiree with coverage — so only a terminated (or otherwise gone)
    // employee is skipped here; their enrollments carry end dates anyway.
    const status = text(emp, "EmploymentStatus") || "";
    diag.employees.total++;
    diag.employees.byStatus[status || "(blank)"] = (diag.employees.byStatus[status || "(blank)"] || 0) + 1;
    const allEnrollments = blocks(emp, "Enrollment");
    for (const en of allEnrollments) {
      if (text(en, "Benefit") !== "Medical") continue;
      diag.medical.endDates[endDateKind(en)]++;
    }
    if (/terminat|inactive|deceased|separat/i.test(status)) {
      diag.employees.skipped[status] = (diag.employees.skipped[status] || 0) + 1;
      // A terminated employee whose medical coverage has not ended is the
      // classic reason EN's count runs higher than ours: record it.
      for (const en of allEnrollments) {
        if (isWaived(en)) continue;
        const medicalLine = text(en, "Benefit") === "Medical";
        const reason = isCurrent(en, today) ? "terminatedEmployee" : "ended";
        if (medicalLine) note(reason, en);
        else diag.lines.excluded[reason]++;
      }
      continue;
    }
    activeEmployees++;
    for (const en of allEnrollments) {
      const medicalLine = text(en, "Benefit") === "Medical";
      if (isWaived(en)) {
        if (medicalLine) note("waived", en);
        else diag.lines.excluded.waived++;
      } else if (!isCurrent(en, today)) {
        if (medicalLine) note("ended", en);
        else diag.lines.excluded.ended++;
      }
    }

    // Same currency rule for every benefit: an enrollment that has not ended,
    // on an active employee.
    const current = blocks(emp, "Enrollment").filter((en) => isCurrent(en, today));

    // Everything but medical goes to the per-line totals. An active employee
    // on dental alone still counts here, even though they have no medical
    // record and so never become a member below.
    for (const en of current) {
      const benefit = text(en, "Benefit");
      if (!benefit || benefit === "Medical" || isWaived(en)) continue;
      const plan = cleanPlan(text(en, "Plan"));
      const carrier = lineCarrier.get(`${benefit}||${plan}`) || "";
      const cost = text(en, "PlanCost");
      const key = `${benefit}||${carrier}||${plan}`;
      const a = lineAgg.get(key) || { benefit, carrier, plan, enrolled: 0, monthly: 0 };
      headOf(carrier, empIdx);
      a.enrolled++;
      const amount = cost == null || cost === "" ? null : Number(cost);
      if (amount == null || !Number.isFinite(amount)) diag.lines.noPremium++;
      a.monthly += amount == null || !Number.isFinite(amount) ? 0 : amount;
      diag.lines.kept.n++;
      diag.lines.kept.premium = round2(diag.lines.kept.premium + (amount == null || !Number.isFinite(amount) ? 0 : amount));
      lineAgg.set(key, a);
    }

    const medical = current.filter((en) => text(en, "Benefit") === "Medical");
    if (!medical.length) continue;

    // Dependents are nested in the employee record; only their ages are used.
    const deps = blocks(emp, "Dependent").map((d) => ({
      rel: text(d, "Relationship"),
      dob: text(d, "DOB"),
    }));

    for (const en of medical) {
      // A waived or declined election is not coverage, whatever its label.
      if (isWaived(en)) continue;
      const level = text(en, "CoverageLevel") || "";
      levelsSeen[level || "(blank)"] = (levelsSeen[level || "(blank)"] || 0) + 1;
      const key = tierKeyOf(level);
      if (!key) unmappedLevels[level || "(blank)"] = (unmappedLevels[level || "(blank)"] || 0) + 1;
      // Never drop a live enrollment over its label: an unreadable level is
      // filed as employee-only for the tier counts, kept out of the rate
      // derivation, and reported in the stats.
      const tier = TIER_LABEL[key || "EE"];
      const tierKnown = !!key;
      {
        const cost = text(en, "PlanCost");
        if (cost == null || cost === "") {
          diag.medical.noPremium.n++;
          const p = programFor(plan0(en));
          diag.medical.noPremium.byProgram[p] = (diag.medical.noPremium.byProgram[p] || 0) + 1;
        } else {
          diag.medical.kept.n++;
          diag.medical.kept.premium = round2(diag.medical.kept.premium + (Number(cost) || 0));
        }
      }

      const starts = text(en, "PlanStarts");
      const ends = text(en, "PlanEnds");
      if (starts && (!pyStart || starts < pyStart)) pyStart = starts;
      if (ends && (!pyEnd || ends > pyEnd)) pyEnd = ends;

      const plan = cleanPlan(text(en, "Plan"));
      if (!carriers.has(plan)) {
        const carrier = carrierFor(planCarrier, plan);
        if (carrier) carriers.set(plan, carrier);
      }
      headOf(carriers.get(plan) || "", empIdx);

      // Ages are as of the plan-year start, so they don't drift with the clock.
      const asOf = starts ? new Date(starts) : new Date();
      const num = (f) => {
        const v = text(en, f);
        return v == null || v === "" ? null : Number(v);
      };

      members.push({
        first: text(emp, "FirstName") || "",
        last: text(emp, "LastName") || "",
        gender: text(emp, "Gender") || null,
        age: ageAt(text(emp, "DOB"), asOf),
        zip: (text(emp, "ZIP") || "").split("-")[0] || null,
        tier,
        tierKnown,
        coverageLevel: level,
        plan,
        premium: num("PlanCost"),
        employeeCost: num("EmployeeCost"),
        employerCost: num("EmployerCost"),
        spAges: deps.filter((d) => d.rel === "Spouse").map((d) => ageAt(d.dob, asOf)).filter((a) => a != null),
        chAges: deps.filter((d) => d.rel === "Child").map((d) => ageAt(d.dob, asOf)).filter((a) => a != null),
      });
    }
  }

  // A company with no medical but with dental, vision or life in force is
  // still a company Employee Navigator reports on. It is kept — with no
  // members, no plans and no access to the portal — so its lines count in
  // the premium totals and the carrier reconciliation.
  const ancillaryOnly = !members.length && lineAgg.size > 0;
  if (!members.length && !ancillaryOnly) {
    throw new Error("No current enrollments found for this company.");
  }

  // Rates and splits: EN bills one amount per plan + tier.
  const rates = {};
  const splitPlans = {};
  const planAgg = new Map();

  for (const m of members) {
    (rates[m.plan] = rates[m.plan] || {});
    if (m.tierKnown && m.premium != null && rates[m.plan][m.tier] == null) rates[m.plan][m.tier] = m.premium;

    if (m.tierKnown && m.employerCost != null && m.employeeCost != null && m.premium != null) {
      const sp = (splitPlans[m.plan] = splitPlans[m.plan] || {});
      if (!sp[m.tier]) sp[m.tier] = { total: m.premium, er: m.employerCost, ee: m.employeeCost };
    }

    const a = planAgg.get(m.plan) || { enrolled: 0, monthly: 0 };
    a.enrolled++;
    a.monthly += m.premium || 0;
    planAgg.set(m.plan, a);
  }

  const tiers = { EE: 0, ES: 0, EC: 0, FAM: 0 };
  members.forEach((m) => tiers[TIER_KEY[m.tier]]++);

  const plans = [...planAgg.entries()]
    .map(([plan, a]) => ({
      plan,
      tpa: carriers.get(plan) || "",
      enrolled: a.enrolled,
      monthly: round2(a.monthly),
    }))
    .sort((x, y) => y.enrolled - x.enrolled);

  const monthly = round2(members.reduce((s, m) => s + (m.premium || 0), 0));
  const lives =
    members.length + members.reduce((s, m) => s + m.spAges.length + m.chAges.length, 0);
  const tpa = plans[0] ? plans[0].tpa : "";

  const lines = [...lineAgg.values()]
    .map((a) => ({ ...a, monthly: round2(a.monthly) }))
    .sort(
      (x, y) =>
        benefitRank(x.benefit) - benefitRank(y.benefit) ||
        x.benefit.localeCompare(y.benefit) ||
        y.monthly - x.monthly,
    );

  // Strip the working fields the portal does not consume.
  const cleanMembers = members.map((m) => ({
    first: m.first,
    last: m.last,
    gender: m.gender,
    age: m.age,
    zip: m.zip,
    tier: m.tier,
    plan: m.plan,
    tpa: carriers.get(m.plan) || tpa,
    premium: m.premium,
    spAges: m.spAges,
    chAges: m.chAges,
  }));

  const day = (s) => (s ? s.slice(0, 10) : null);

  return {
    group: {
      name,
      /** Employee Navigator's own company identifier, whatever it is set to. */
      enIdentifier: identifier || null,
      address1: text(companyBlock, "Address1"),
      city: text(companyBlock, "City"),
      zip: (text(companyBlock, "ZIP") || "").split("-")[0] || null,
      taxId: text(companyBlock, "TaxID"),
      phone: text(companyBlock, "VoiceNumber"),
      situsState: text(companyBlock, "SitusState"),
      corporationType: text(companyBlock, "CorporationType"),
      contacts,
      state: text(companyBlock, "State") || text(companyBlock, "SitusState"),
      sic: text(companyBlock, "SICCode"),
      pyStart: day(pyStart),
      pyEnd: day(pyEnd),
      tpa,
      enrolled: members.length,
      /**
       * Every active employee on the census, whether or not they show up
       * in a medical enrollment. A declined election has no row of its own
       * in this export — an employee who waives simply never appears under
       * Medical — so `enrolled` plus a waived count would silently equal
       * `enrolled` on every group. The employee roster itself is the only
       * count this file gives that does not depend on that.
       */
      medicalEligible: activeEmployees,
      lives,
      tiers,
      monthly,
      annual: round2(monthly * 12),
      plans,
      /** Every non-medical benefit in force — dental, vision, life, disability … — with no member detail. */
      lines,
      /** Distinct employees on any line, per carrier as the export named it. */
      carrierHeads: Object.fromEntries([...heads].map(([c, s]) => [c, s.size])),
      /** No medical in force; kept for its other lines. Not a portal group. */
      ancillaryOnly,
      ...premiumBreakdown({ plans, lines }),
      members: cleanMembers,
      rates,
    },
    split: Object.keys(splitPlans).length
      ? {
          source: `Employee Navigator XML import — employer/employee cost as configured in payroll`,
          plans: splitPlans,
        }
      : null,
    stats: {
      employeesInFile: employees.length,
      coverageLevels: levelsSeen,
      unmappedLevels,
      diagnostics: diag,
      tierCounts: TIER_ORDER.reduce((o, t) => ({ ...o, [t]: members.filter((m) => m.tier === t).length }), {}),
      ratesFound: Object.values(rates).reduce((n, r) => n + Object.keys(r).length, 0),
      splitsFound: Object.values(splitPlans).reduce((n, r) => n + Object.keys(r).length, 0),
      linesFound: lines.length,
    },
  };
}

/**
 * Stream a (possibly very large, multi-company) Employee Navigator export.
 *
 * The document root is <Company>, with that company's plan catalog and all of
 * its employees nested inside, so a full Data API export is simply a run of
 * <Company> blocks. They are extracted and parsed one at a time and then
 * discarded, so peak memory is one company — not the whole file, which can run
 * to hundreds of megabytes.
 */
export async function parseEnStream(readable) {
  const OPEN = "<Company>";
  const CLOSE = "</Company>";
  const companies = [];
  const failures = [];
  let buf = "";
  let sawAny = false;

  const drain = () => {
    for (;;) {
      const start = buf.indexOf(OPEN);
      if (start === -1) {
        // Nothing pending; keep only a tag's worth of tail for a split boundary.
        if (buf.length > OPEN.length) buf = buf.slice(-OPEN.length);
        return;
      }
      const end = buf.indexOf(CLOSE, start);
      if (end === -1) {
        if (start > 0) buf = buf.slice(start);
        return;
      }
      const block = buf.slice(start, end + CLOSE.length);
      buf = buf.slice(end + CLOSE.length);
      sawAny = true;
      try {
        companies.push(parseEmployeeNavigatorXml(block));
      } catch (e) {
        const m = /<Name>([^<]*)<\/Name>/.exec(block) || /<Identifier>([^<]*)<\/Identifier>/.exec(block);
        failures.push({ name: m ? m[1] : "(unnamed company)", reason: e.message });
      }
    }
  };

  readable.setEncoding("utf8");
  for await (const chunk of readable) {
    buf += chunk;
    if (buf.length > 1e6) drain();
  }
  drain();

  if (!sawAny) {
    throw new Error("This does not look like an Employee Navigator XML export — no <Company> record found.");
  }
  if (!companies.length) {
    throw new Error(
      failures.length
        ? `Found ${failures.length} company record(s) but none had active medical enrollments. First: ${failures[0].reason}`
        : "No companies could be read from that export.",
    );
  }
  return { companies, failures };
}

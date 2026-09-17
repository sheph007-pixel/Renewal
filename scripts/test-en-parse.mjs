// Feeds a minimal hand-written Employee Navigator export through the parser
// and checks the premium breakdown. Run with: node scripts/test-en-parse.mjs
//
// One company, five employees:
//   Ann   Active   medical EBPA (EE, $500)      + dental Guardian ($40) + vision VSP ($12)
//   Bob   Active   medical BCBS AL (ES, $1,100) + dental Guardian ($40)
//   Cal   Active   dental TERMINATED (has an EndDate, $40) - excluded
//   Dee   Active   medical WAIVED - excluded
//   Eve   Terminated employee with an open medical + dental - excluded
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseEnStream, premiumBreakdown } from "../server/en-parse.js";

const enrollment = (o) => `
        <Enrollment>
          <Benefit>${o.benefit}</Benefit>
          <Plan>${o.plan}</Plan>
          <CoverageLevel>${o.tier}</CoverageLevel>
          <PlanStarts>2026-01-01T00:00:00</PlanStarts>
          <PlanEnds>2026-12-31T00:00:00</PlanEnds>
          ${o.endDate ? `<EndDate>${o.endDate}</EndDate>` : `<EndDate xsi:nil="true" />`}
          <PlanCost>${o.cost}</PlanCost>
          <EmployeeCost>${o.ee ?? 0}</EmployeeCost>
          <EmployerCost>${o.cost - (o.ee ?? 0)}</EmployerCost>
        </Enrollment>`;

const employee = (first, status, enrollments) => `
      <Employee>
        <FirstName>${first}</FirstName>
        <LastName>Test</LastName>
        <Gender>F</Gender>
        <DOB>1980-06-15T00:00:00</DOB>
        <ZIP>35203</ZIP>
        <EmploymentStatus>${status}</EmploymentStatus>
        <Enrollments>${enrollments.map(enrollment).join("")}
        </Enrollments>
        <Dependents></Dependents>
      </Employee>`;

const xml = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfCompany xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Company>
  <Identifier>TEST001</Identifier>
  <Name>Test Company, LLC</Name>
  <Address1>1 Main St</Address1>
  <City>Birmingham</City>
  <State>AL</State>
  <ZIP>35203</ZIP>
  <SitusState>AL</SitusState>
  <Contacts>
    <Contact><Name>Pat Owner</Name><Email>pat@example.com</Email><Phone>205-555-0100</Phone></Contact>
  </Contacts>
  <Classes></Classes>
  <Plans>
    <Plan><Benefit>Medical</Benefit><PlanName>EBPA Preferred Silver 2026</PlanName><Carrier>EBPA</Carrier></Plan>
    <Plan><Benefit>Medical</Benefit><PlanName>Blue Secure Gold 2026</PlanName><Carrier>Blue Cross Blue Shield of Alabama</Carrier></Plan>
    <Plan><Benefit>Dental</Benefit><PlanName>Guardian Dental PPO 2026</PlanName><Carrier>Guardian</Carrier></Plan>
    <Plan><Benefit>Vision</Benefit><PlanName>VSP Choice 2026</PlanName><Carrier>VSP</Carrier></Plan>
  </Plans>
  <Employees>
    ${employee("Ann", "Active", [
      { benefit: "Medical", plan: "EBPA Preferred Silver 2026", tier: "Employee", cost: 500, ee: 100 },
      { benefit: "Dental", plan: "Guardian Dental PPO 2026", tier: "Employee", cost: 40, ee: 40 },
      { benefit: "Vision", plan: "VSP Choice 2026", tier: "Employee", cost: 12, ee: 12 },
    ])}
    ${employee("Bob", "Active", [
      { benefit: "Medical", plan: "Blue Secure Gold 2026", tier: "Employee + Spouse", cost: 1100, ee: 400 },
      { benefit: "Dental", plan: "Guardian Dental PPO 2026", tier: "Employee", cost: 40, ee: 40 },
    ])}
    ${employee("Cal", "Active", [
      { benefit: "Dental", plan: "Guardian Dental PPO 2026", tier: "Employee", cost: 40, ee: 40, endDate: "2026-05-31T00:00:00" },
    ])}
    ${employee("Dee", "Active", [
      { benefit: "Medical", plan: "Waive", tier: "Waived", cost: 0 },
    ])}
    ${employee("Eve", "Terminated", [
      { benefit: "Medical", plan: "EBPA Preferred Silver 2026", tier: "Employee", cost: 500, ee: 100 },
      { benefit: "Dental", plan: "Guardian Dental PPO 2026", tier: "Employee", cost: 40, ee: 40 },
    ])}
  </Employees>
</Company>
</ArrayOfCompany>
`;

// parseEnStream consumes a byte stream (an HTTP request in production).
const { companies, failures } = await parseEnStream(Readable.from([Buffer.from(xml, "utf8")], { objectMode: false }));
assert.equal(failures.length, 0, JSON.stringify(failures));
assert.equal(companies.length, 1);
const g = companies[0].group;

// Existing medical semantics are untouched: two active medical employees.
assert.equal(g.enrolled, 2, "enrolled = active medical employees");
assert.equal(g.lives, 2);
assert.equal(g.monthly, 1600, "monthly = every active medical premium");
assert.deepEqual(
  g.plans.map((p) => [p.plan, p.tpa, p.enrolled, p.monthly]).sort(),
  [
    ["Blue Secure Gold", "Blue Cross Blue Shield of Alabama", 1, 1100],
    ["EBPA Preferred Silver", "EBPA", 1, 500],
  ],
);
assert.equal(g.members.length, 2);
const diag = companies[0].stats.diagnostics;
assert.deepEqual(diag.lines, { kept: { n: 3, premium: 92 }, excluded: { terminatedEmployee: 1, ended: 1, waived: 0 }, noPremium: 0 }, "non-medical lines are accounted for too");
assert.ok(!g.members.some((m) => m.first === "Dee" || m.first === "Eve"), "waived and terminated never become members");

// Supplemental lines: only the open enrollments on active employees.
assert.deepEqual(g.lines, [
  { benefit: "Dental", carrier: "Guardian", plan: "Guardian Dental PPO", enrolled: 2, monthly: 80 },
  { benefit: "Vision", carrier: "VSP", plan: "VSP Choice", enrolled: 1, monthly: 12 },
]);

// The breakdown.
assert.equal(g.groupHealthMonthly, 500, "group health = EBPA medical only, BCBS excluded");
assert.equal(g.medicalMonthly, 1600, "medical = EBPA + BCBS");
assert.equal(g.supplementalMonthly, 92, "supplemental = active dental + vision");
assert.equal(g.totalMonthly, 1692, "total = medical + supplemental");
assert.equal(g.linesLoaded, true);
assert.equal(companies[0].stats.linesFound, 2);

// The helper on a stored group with no `lines` (census, or an older import).
const legacy = premiumBreakdown({ plans: g.plans });
assert.deepEqual(legacy, {
  groupHealthMonthly: 500,
  groupHealthEnrolled: 1,
  medicalMonthly: 1600,
  bcbsMonthly: 1100,
  bcbsEnrolled: 1,
  unrecognizedMonthly: 0,
  unrecognizedEnrolled: 0,
  assumedMonthly: 0,
  supplementalMonthly: 0,
  totalMonthly: 1600,
  linesLoaded: false,
});

// A plan whose carrier could not be read, in a group that is otherwise all
// EBPA: counted as group health and flagged as assumed …
const assumed = premiumBreakdown({
  plans: [
    { plan: "EBPA Freedom Gold", tpa: "EBPA", enrolled: 3, monthly: 1500 },
    { plan: "Freedom Silver", tpa: "", enrolled: 2, monthly: 800 },
  ],
});
assert.equal(assumed.groupHealthMonthly, 2300, "unnamed carrier in an all-EBPA group counts");
assert.equal(assumed.assumedMonthly, 800);
assert.equal(assumed.unrecognizedMonthly, 0);
assert.equal(assumed.groupHealthEnrolled, 5);

// … but not when the group also has BCBS: then it is unrecognised and excluded.
const mixed = premiumBreakdown({
  plans: [
    { plan: "EBPA Freedom Gold", tpa: "EBPA", enrolled: 3, monthly: 1500 },
    { plan: "Blue Secure Silver", tpa: "BCBS AL", enrolled: 1, monthly: 900 },
    { plan: "Freedom Silver", tpa: "", enrolled: 2, monthly: 800 },
  ],
});
assert.equal(mixed.groupHealthMonthly, 1500);
assert.equal(mixed.bcbsMonthly, 900);
assert.equal(mixed.unrecognizedMonthly, 800);
assert.equal(mixed.unrecognizedEnrolled, 2);

console.log("en-parse: all assertions passed");
console.log({
  enrolled: g.enrolled,
  groupHealthMonthly: g.groupHealthMonthly,
  medicalMonthly: g.medicalMonthly,
  supplementalMonthly: g.supplementalMonthly,
  totalMonthly: g.totalMonthly,
  lines: g.lines,
});

// Distinct employees per carrier, the way the Carrier Stats report counts:
// Ann is on EBPA medical, Guardian dental and VSP vision; Bob on BCBS medical
// and Guardian dental - Guardian has two people, every other carrier one.
assert.deepEqual(g.carrierHeads, { EBPA: 1, Guardian: 2, VSP: 1, "Blue Cross Blue Shield of Alabama": 1 });
assert.equal(g.ancillaryOnly, false);
console.log("en-parse: carrier head counts ok", g.carrierHeads);

// Coverage runs through its end date: a medical line ending today is still on.
const today = new Date().toISOString().slice(0, 10);
const xmlToday = xml.replace(/<Employees>[\s\S]*<\/Employees>/, `<Employees>${employee("Fay", "Active", [
  { benefit: "Medical", plan: "EBPA Preferred Silver 2026", tier: "Employee", cost: 500, ee: 100, endDate: today + "T00:00:00" },
])}${employee("Gus", "Active", [
  { benefit: "Medical", plan: "EBPA Preferred Silver 2026", tier: "Employee", cost: 500, ee: 100, endDate: "2026-01-31T00:00:00" },
])}</Employees>`);
const todayRun = await parseEnStream(Readable.from([Buffer.from(xmlToday, "utf8")], { objectMode: false }));
assert.equal(todayRun.companies.length, 1, JSON.stringify(todayRun.failures));
assert.equal(todayRun.companies[0].group.enrolled, 1, "Fay (ends today) counts, Gus (ended in January) does not");
console.log("en-parse: end-date-today check passed");

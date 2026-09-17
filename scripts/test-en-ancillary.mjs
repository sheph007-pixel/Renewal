// A company with no medical but dental in force is kept - no members, no
// plans, no portal access - so its lines count toward the premium totals and
// the carrier reconciliation. A company with nothing current at all is not.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseEnStream } from "../server/en-parse.js";

const company = (name, enrollments) => `
<Company>
  <Identifier>${name}</Identifier>
  <Name>${name}</Name>
  <Plans>
    <Plan><Benefit>Dental</Benefit><PlanName>Guardian Dental PPO 2026</PlanName><Carrier>Guardian</Carrier></Plan>
  </Plans>
  <Employees>
    <Employee>
      <FirstName>Ann</FirstName><LastName>Test</LastName><DOB>1980-06-15T00:00:00</DOB>
      <EmploymentStatus>Active</EmploymentStatus>
      <Enrollments>${enrollments}</Enrollments>
      <Dependents></Dependents>
    </Employee>
  </Employees>
</Company>`;
const dental = `
        <Enrollment>
          <Benefit>Dental</Benefit><Plan>Guardian Dental PPO 2026</Plan><CoverageLevel>Employee</CoverageLevel>
          <PlanStarts>2026-01-01T00:00:00</PlanStarts><PlanEnds>2026-12-31T00:00:00</PlanEnds>
          <EndDate xsi:nil="true" /><PlanCost>40</PlanCost><EmployeeCost>10</EmployeeCost><EmployerCost>30</EmployerCost>
        </Enrollment>`;
const ended = dental.replace('<EndDate xsi:nil="true" />', "<EndDate>2025-12-31T00:00:00</EndDate>");

const xml = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfCompany xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${company("Dental Only Co", dental)}${company("Nothing Current Co", ended)}
</ArrayOfCompany>`;

const { companies, failures } = await parseEnStream(Readable.from([xml]));
assert.equal(companies.length, 1, "the dental-only company is kept");
const g = companies[0].group;
assert.equal(g.name, "Dental Only Co");
assert.equal(g.ancillaryOnly, true);
assert.equal(g.enrolled, 0);
assert.deepEqual(g.plans, []);
assert.equal(g.lines.length, 1);
assert.equal(g.supplementalMonthly, 40);
assert.equal(g.totalMonthly, 40);
assert.deepEqual(g.carrierHeads, { Guardian: 1 });
assert.equal(failures.length, 1, "the company with nothing current is reported, not imported");
assert.match(failures[0].reason, /No current enrollments/);
console.log("en-ancillary: all assertions passed", { kept: g.name, failed: failures[0].name });

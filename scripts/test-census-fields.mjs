// The parser keeps what the Census page shows: each member's date of birth
// and each dependant's name, gender, relationship and date of birth.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseEnStream } from "../server/en-parse.js";

const xml = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfCompany>
<Company>
  <Identifier>C1</Identifier>
  <Name>Census Test Co</Name>
  <Employees>
    <Employee>
      <FirstName>QUANIA</FirstName><LastName>ANDERSON</LastName><Gender>Female</Gender><DOB>1963-05-21</DOB><ZIP>77043</ZIP>
      <Dependents>
        <Dependent><FirstName>Kevin</FirstName><LastName>Anderson</LastName><Gender>Male</Gender><Relationship>Spouse</Relationship><DOB>11/28/2011</DOB></Dependent>
        <Dependent><FirstName>Lauren</FirstName><LastName>Anderson</LastName><Gender>Female</Gender><Relationship>Child</Relationship><DOB>2015-02-20</DOB></Dependent>
      </Dependents>
      <Enrollments>
        <Enrollment><Benefit>Medical</Benefit><Plan>HealthEZ Classic Silver</Plan><CoverageLevel>Employee + Family</CoverageLevel><PlanCost>1500</PlanCost><PlanStarts>2026-01-01</PlanStarts><PlanEnds>2026-12-31</PlanEnds><Status>Active</Status></Enrollment>
      </Enrollments>
    </Employee>
  </Employees>
</Company>
</ArrayOfCompany>`;
const { companies } = await parseEnStream(Readable.from([xml]));
const g = companies[0]?.group;
assert.ok(g, "a company parsed");
const m = g.members[0];
assert.equal(m.dob, "1963-05-21");
assert.equal(m.deps.length, 2);
assert.deepEqual(m.deps[0], { first: "Kevin", last: "Anderson", gender: "Male", rel: "Spouse", dob: "2011-11-28" });
assert.equal(m.deps[1].dob, "2015-02-20");
assert.equal(m.spAges.length, 1, "ages still feed the tiers");
console.log("ok - census fields kept:", m.first, m.dob, m.deps.length, "dependants");

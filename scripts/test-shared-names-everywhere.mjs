// A shared plan name confirmed once covers every proposal: the same carrier
// name on the same codes on another group's quote passes the "Plan names
// unique" check; a code no one confirmed still asks for a person.
import assert from "node:assert/strict";
import { validatePlans, setSharedNameConfirmations } from "../server/plan-validate.js";

const plan = (code, name = "Surest PPO") => ({
  name,
  plan_code: code,
  network: "Surest",
  plan_type: "PPO",
  deductible: "$1,000",
  oop_max: "$5,000",
  benefits: { doctor_visit: "$30", specialist: "$60", imaging: "", urgent_care: "$75", emergency_room: "$350", hospital: "20%", rx: "$10 / $40 / $80", coinsurance: "", hsa_eligible: "no" },
  rates: { EE: 600, ES: 1200, EC: 1080, FAM: 1800 },
  monthly_total: null,
  source: { identity: [3], benefits: [3], rates: [13], sheet: "", rows: "", appearances: 1, codes: [code] },
});
const reading = (codes) => ({ carrier: "UnitedHealthcare", plans: codes.map((c) => plan(c)), extraction: { sourceSha: "sha" } });
const names = (codes) => validatePlans({ extracted: reading(codes), sourceSha: "sha" }).checks.find((c) => c.key === "names");

const A = "SurestPH105002027RXALT3";
const B = "SurestPE60002027RXALT2";
const C = "SurestPG95002027RXALT2";

assert.equal(names([A, B]).ok, false, "unconfirmed: flagged");
assert.equal(names([A, B]).fix, "review");

setSharedNameConfirmations([{ name: "Surest PPO", codes: [A, B, C], carrier: "UnitedHealthcare" }]);
assert.equal(names([A, B]).ok, true, "another proposal with confirmed codes passes");
assert.equal(names([A, B, C]).ok, true, "all confirmed codes pass");
assert.equal(names([A, "SurestNEW0002027RXALT9"]).ok, false, "an unconfirmed code still asks");
assert.equal(names([A, B].map((c) => c.toLowerCase())).ok, true, "codes compare as the carrier prints them, case aside");

setSharedNameConfirmations([]);
assert.equal(names([A, B]).ok, false, "cleared: flagged again");
console.log("shared names everywhere: one confirmation covers the same name and codes on every proposal; a new code still asks - ok");

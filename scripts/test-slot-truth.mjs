// Slots follow the document, end to end (canned reader, KENNION_FAKE_AI):
// a UHC slot guessed only from "FI" / "LF" in a filename gives way to what
// the document itself says - an Aetna quote named "... FI" leaves the slot
// and never replaces the group's real UHC proposal; a UHC quote of the other
// funding moves; a UHC reading with its funding unclear keeps the guess. A
// slot staff chose stands. "Angle" is matched as a word (never "Triangle"),
// and UnitedHealthcare's brands - All Savers (level funded), UMR, Golden
// Rule - are UHC, never discarded as untracked.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 5093;
const CODE = "slot-truth-code";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
server.stdout.on("data", (d) => logs.push(String(d)));
process.on("exit", () => server.kill());
server.stderr.on("data", (d) => process.stderr.write(d));

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
const groups = staff.groups.filter((g) => !g.archived && g.eligible !== false && !/church|presbyterian|baptist|methodist|ministr/i.test(g.name));
assert.ok(groups.length >= 3, "need three groups");
const [G1, G2, G3] = groups;

const plan = (name, code, ee) => ({ name, plan_code: code, network: "Choice Plus", plan_type: "PPO", deductible: "$4,000", oop_max: "$8,150", benefits: {}, rates: { EE: ee, ES: ee * 2, EC: ee * 1.8, FAM: ee * 3 }, monthly_total: null });
const reading = (carrier, funding, g, plans = [plan("Plan A", "A1", 600)]) => ({ carrier, funding, quotes_medical: true, matched_group: g.name, confidence: 0.95, effective_date: "2027-01-01", proposal_type: "renewal", enrolled_on_document: g.enrolled, plans, total_monthly: null, summary: "Canned." });
const upload = async (filename, body, g, slot = "") => {
  const r = await fetch(`${base}/api/admin/proposals?filename=${encodeURIComponent(filename)}&group=${encodeURIComponent(g.name)}${slot ? `&slot=${encodeURIComponent(slot)}` : ""}`, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.text());
};
const rows = async () => (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals || [];
const settled = async (filename) => {
  for (let i = 0; i < 120; i++) {
    await wait(250);
    const row = (await rows()).find((r) => r.filename === filename);
    if (row && row.status !== "analyzing" && row.extracted) return row;
  }
  throw new Error(`${filename} never settled`);
};

// The group's real UHC fully insured proposal, filed in its slot by staff.
await upload("real uhc.json", reading("UnitedHealthcare", "fully insured", G1, [plan("EZ18 Open Access", "EZ18", 700)]), G1, "UHC Fully Insured");
const real = await settled("real uhc.json");
assert.equal(real.slot, "UHC Fully Insured");

// 1. "FI" in the name, but the document is Aetna's: out of the UHC slot, the real one stays current.
await upload("Acme Aetna FI.json", reading("Aetna", "fully insured", G1), G1);
let aetna = await settled("Acme Aetna FI.json");
assert.equal(aetna.slot, null, "the document's carrier overrides the filename guess");
await upload("later uhc lf.json", reading("UnitedHealthcare", "level funded", G1), G1, "UHC Level Funded"); // another change: the slots are settled again
await settled("later uhc lf.json");
const all = await rows();
aetna = all.find((r) => r.filename === "Acme Aetna FI.json");
assert.ok(aetna, "kept on file, not deleted");
assert.equal(aetna.slot, null, "and not put back in the UHC slot by a later filename guess");
const realNow = all.find((r) => r.id === real.id);
assert.equal(realNow.slot, "UHC Fully Insured");
assert.ok(!realNow.superseded_by, "the group's real UHC proposal is still the current one");
assert.ok(logs.join("").includes("not the \"UHC Fully Insured\" its filename suggested - taken out of the slot"), "said in the log");

// 2. "FI" in the name, but the document is UHC level funded: it moves to Level Funded.
await upload("Beta UHC FI.json", reading("UnitedHealthcare", "level funded", G2), G2);
assert.equal((await settled("Beta UHC FI.json")).slot, "UHC Level Funded");

// 3. "LF" in the name, UHC with its funding unclear: the guess stands.
await upload("Gamma LF.json", reading("UnitedHealthcare", "unknown", G3), G3);
assert.equal((await settled("Gamma LF.json")).slot, "UHC Level Funded");

// 4. A slot staff chose stands, whatever the reading says.
await upload("staff choice.json", reading("Aetna", "fully insured", G3), G3, "UHC Fully Insured");
assert.equal((await settled("staff choice.json")).slot, "UHC Fully Insured");

// 5. "Angle" as a word: Angle Health fills the Angle slot; Triangle does not.
await upload("angle quote.json", reading("Angle Health", "level funded", G2), G2);
assert.equal((await settled("angle quote.json")).slot, "Angle");
await upload("tri quote.json", reading("Triangle Benefit Services", "level funded", G2), G2);
const tri = await settled("tri quote.json").catch(() => null);
assert.ok(!tri || tri.slot !== "Angle", "Triangle never lands in the Angle slot");

// 6. UnitedHealthcare's brands.
await upload("savers quote.json", reading("All Savers", "unknown", G3), G3);
assert.equal((await settled("savers quote.json")).slot, "UHC Level Funded", "All Savers is UHC level funded");
await upload("umr quote.json", reading("UMR", "level funded", G1), G1);
assert.equal((await settled("umr quote.json")).slot, "UHC Level Funded", "UMR is UHC");
await upload("golden quote.json", reading("Golden Rule Insurance Company", "fully insured", G2), G2);
assert.equal((await settled("golden quote.json")).slot, "UHC Fully Insured", "Golden Rule is UHC");
await upload("umr unclear.json", reading("UMR", "unknown", G2), G2);
const umr = await settled("umr unclear.json").catch(() => null);
assert.ok(umr, "a UMR quote with its funding unclear is kept for staff, never discarded as untracked");
assert.equal(umr.slot, null);

server.kill();
console.log("slot truth: the document's carrier and funding override a UHC slot guessed from the filename; staff choices stand; Angle is a word; All Savers, UMR and Golden Rule are UHC - ok");
process.exit(0);

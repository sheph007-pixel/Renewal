// Get Plan Recommendations: the assistant is handed the group's census as
// aggregates only - average age, range, age bands, dependants - never a
// name or one person's age; its instructions carry the Lower Cost / Best
// Fit / Richer Benefits rule; the page's request goes through the chat like
// any other question and is answered in a new conversation; and the picks
// are published to the Medical Plans page through the recommend_plans tool
// - resolved against the quotes on file, one record per group, replaced on
// the next answer, and never from a staff trial. Runs with
// `node scripts/test-recommendations.mjs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecommendations, PICK_TIERS } from "../server/assistant.js";

// The tool's input as the page's record, without a server.
{
  const proposals = [
    { slot: "Gravie", carrier: "Gravie", plans: [{ optionId: "GR1", name: "Copay 1500", monthlyTotal: 20000 }, { optionId: "GR2", name: "HSA 3000", planCode: "G-HSA-3000", monthlyTotal: 18000 }] },
    { slot: "Angle", carrier: "Angle Health", plans: [{ optionId: "AN1", name: "Angle 2000", monthlyTotal: 17000 }] },
  ];
  const { record, unknown } = buildRecommendations(
    {
      summary: "  A young   group. ",
      start_with: "gr2",
      start_with_reason: "Mid-range.",
      picks: [
        { carrier: "Gravie", tier: "richer_benefits", option_id: "GR1", reason: "Rich." },
        { carrier: "Gravie", tier: "best_fit", option_id: "G-HSA-3000", reason: "By plan code." },
        { carrier: "Gravie", tier: "best_fit", option_id: "GR1", reason: "Duplicate tier, dropped." },
        { carrier: "Angle Health", tier: "lower_cost", option_id: "AN1", reason: "Cheapest." },
        { carrier: "Angle Health", tier: "best_fit", option_id: "AN99", reason: "Not quoted." },
        { carrier: "Angle Health", tier: "sideways", option_id: "AN1", reason: "Bad tier." },
      ],
    },
    proposals,
  );
  assert.equal(record.summary, "A young group.");
  assert.equal(record.startWith, "GR2", "start_with resolves case-insensitively and must be among the picks");
  assert.deepEqual(unknown, ["AN99", "AN1"]);
  assert.deepEqual(
    record.picks.map((p) => [p.carrier, p.tier, p.optionId, p.plan]),
    [
      ["Angle Health", "lower_cost", "AN1", "Angle 2000"],
      ["Gravie", "best_fit", "GR2", "HSA 3000"],
      ["Gravie", "richer_benefits", "GR1", "Copay 1500"],
    ],
    "carrier then tier order; a plan code resolves; a second pick for the same tier or plan is dropped",
  );
  assert.equal(buildRecommendations({ summary: "", start_with: "", start_with_reason: "", picks: [] }, proposals).record.picks.length, 0);
  // UnitedHealthcare quotes fully insured and level funded: one lineup each, three picks each - the same tier twice is not a duplicate across fundings.
  const uhc = [
    { slot: "UHC Fully Insured", carrier: "UnitedHealthcare", plans: [{ optionId: "UH1", name: "FI 1", monthlyTotal: 30000 }, { optionId: "UH2", name: "FI 2", monthlyTotal: 32000 }] },
    { slot: "UHC Level Funded", carrier: "UnitedHealthcare", plans: [{ optionId: "UH3", name: "LF 1", monthlyTotal: 28000 }, { optionId: "UH4", name: "LF 2", monthlyTotal: 29000 }] },
  ];
  const both = buildRecommendations(
    { summary: "", start_with: "UH3", start_with_reason: "", picks: [
      { carrier: "UnitedHealthcare", tier: "best_fit", option_id: "UH1", reason: "FI." },
      { carrier: "UnitedHealthcare", tier: "best_fit", option_id: "UH3", reason: "LF." },
      { carrier: "UnitedHealthcare", tier: "lower_cost", option_id: "UH4", reason: "LF cheap." },
      { carrier: "UnitedHealthcare", tier: "best_fit", option_id: "UH2", reason: "Second FI best fit: dropped." },
    ] },
    uhc,
  ).record;
  assert.deepEqual(
    both.picks.map((p) => [p.funding, p.tier, p.optionId]),
    [["Fully Insured", "best_fit", "UH1"], ["Level Funded", "lower_cost", "UH4"], ["Level Funded", "best_fit", "UH3"]],
    "a Best Fit for each UnitedHealthcare funding; a second for the same funding is dropped; funding then tier order",
  );
  assert.equal(buildRecommendations({ summary: "", start_with: "ZZ", start_with_reason: "", picks: [{ carrier: "Gravie", tier: "lower_cost", option_id: "GR1", reason: "" }] }, proposals).record.startWith, "GR1", "an unknown start falls back to the first pick");
  assert.deepEqual(PICK_TIERS, ["lower_cost", "best_fit", "richer_benefits"]);
}

const PORT = 5093;
const CODE = "recs-test-code";
const data = JSON.parse(readFileSync(new URL("../server/data/kennion.json", import.meta.url), "utf8"));
const g = data.groups.find((x) => Array.isArray(x.members) && x.members.length >= 5);
assert.ok(g, "a group with a census");

// Two carriers' quotes for the group, on file before the server boots.
const rates = (ee) => ({ EE: ee, ES: ee * 2, EC: ee * 1.8, FAM: ee * 3 });
// Every plan carries its benefits: a proposal without them is re-read from its file at boot, and a seeded row has no file.
const plan = (option_id, name, deductible, oop_max, ee, plan_type = "PPO") => ({ option_id, name, plan_type, network: "Cigna", deductible, oop_max, rates: rates(ee), monthly_total: ee * 40, benefits: { doctor_visit: "$30", specialist: "$60", imaging: null, urgent_care: "$75", hospital: null, rx: "$10 / $35 / $70" } });
const seed = join(mkdtempSync(join(tmpdir(), "recs-")), "proposals.json");
writeFileSync(
  seed,
  JSON.stringify([
    { group_name: g.name, slot: "Gravie", carrier: "Gravie", extracted: { carrier: "Gravie", funding: "Level Funded", quotes_medical: true, plans: [plan("GR1", "Gravie Copay 1500", "$1,500", "$5,000", 600), plan("GR2", "Gravie HSA 3000", "$3,000", "$6,000", 520), plan("GR3", "Gravie Copay 500", "$500", "$3,000", 700)] } },
    { group_name: g.name, slot: "Angle", carrier: "Angle Health", extracted: { carrier: "Angle Health", funding: "Level Funded", quotes_medical: true, plans: [plan("AN1", "Angle 2000", "$2,000", "$6,000", 480), plan("AN2", "Angle 1000", "$1,000", "$4,500", 560)] } },
  ]),
);

const server = spawn("node", ["server/index.js"], { env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "", KENNION_SEED_PROPOSALS: seed, KENNION_CLIENT_VERIFIED_ONLY: "0" }, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => server.kill();
process.on("exit", stop);
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

const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };

// The briefing: aggregates, matching the census file, and nobody named.
const { briefing } = await (await fetch(`${base}/api/admin/data-audit/${encodeURIComponent(g.name)}`, { headers: auth })).json();
const ages = g.members.map((m) => Number(m.age)).filter((a) => a > 0);
const avg = Math.round(ages.reduce((s, a) => s + a, 0) / ages.length);
assert.match(briefing, new RegExp(`Census profile \\(aggregates[^\\n]*${ages.length} enrolled employees, average age ${avg}, median \\d+, youngest ${Math.min(...ages)}, oldest ${Math.max(...ages)}; the age range is (narrow|moderate|wide)`));
assert.match(briefing, /By age: under 30: \d+; 30-44: \d+; 45-54: \d+; 55 and over: \d+\. \d+ cover a spouse; \d+ cover children \(\d+ children in all\)/);
for (const m of g.members) if (m.last && m.last.length > 2) assert.ok(!briefing.includes(m.last), `no surname in the briefing (${m.last})`);

// The rule the assistant answers the button with: the picks go through the tool, the chat stays short.
const src = readFileSync(new URL("../server/assistant.js", import.meta.url), "utf8");
assert.match(src, /Give three picks - Lower Cost, Best Fit, Richer Benefits - and when more than one carrier has quoted, give the three for each carrier/);
assert.match(src, /Publish the picks with the recommend_plans tool/);
assert.match(src, /name: "recommend_plans"/);

// The group signs in; its quotes are on the page, with option IDs.
const r0 = await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: staff.groups.find((x) => x.name === g.name).code }) });
const cookie = (r0.headers.get("set-cookie") || "").split(";")[0];
const payload = await r0.json();
const quoted = (payload.proposals || []).flatMap((pr) => pr.plans.map((pl) => pl.optionId));
assert.deepEqual(quoted.sort(), ["AN1", "AN2", "GR1", "GR2", "GR3"], "the seeded quotes reach the group's page with their option IDs");

// Nothing recommended yet.
const none = await (await fetch(`${base}/api/chat/recommendations`, { headers: { cookie } })).json();
assert.equal(none.recommendations, null);

// The page's request is an ordinary question in a new conversation; the
// answer places picks on the page - streamed to the box, and on file after.
const ask = "Please give me your plan recommendations for my group: a Lower Cost, a Best Fit and a Richer Benefits option, for each carrier that quoted us - and for UnitedHealthcare, for each funding it quoted.";
const r = await fetch(`${base}/api/chat/send`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ threadId: null, content: ask, page: "plans", compact: true, title: "Plan recommendations" }) });
const body = await r.text();
assert.equal(r.status, 200, body);
assert.match(body, /event: thread/);
assert.match(body, /event: recommendations/);
assert.match(body, /event: done/);
const threadId = JSON.parse(body.split("event: thread\ndata: ")[1].split("\n")[0]).id;
const { recommendations: rec } = await (await fetch(`${base}/api/chat/recommendations`, { headers: { cookie } })).json();
assert.ok(rec, "picks on file");
assert.equal(rec.threadId, threadId, "the picks remember the conversation they came from");
assert.ok(rec.createdAt);
assert.ok(rec.summary);
assert.deepEqual(
  rec.picks.map((p) => [p.carrier, p.tier, p.optionId]),
  [
    ["Angle Health", "lower_cost", "AN1"],
    ["Angle Health", "richer_benefits", "AN2"],
    ["Gravie", "lower_cost", "GR2"],
    ["Gravie", "best_fit", "GR1"],
    ["Gravie", "richer_benefits", "GR3"],
  ],
  "three picks per carrier where three plans exist (two where two do), by monthly total; every one a quoted option",
);
assert.ok(rec.picks.every((p) => quoted.includes(p.optionId) && p.plan && p.reason));
assert.equal(rec.startWith, "GR1", "the fake picks start with a Best Fit");
const done = JSON.parse(body.split("event: done\ndata: ")[1].split("\n")[0]).message;
assert.match(done.content, /on the Medical Plans page/, "the chat answer points at the page rather than listing the picks");

// Asked again: the record is replaced, not stacked.
const again = await fetch(`${base}/api/chat/send`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ threadId, content: "Please recommend again.", page: "plans", compact: true }) });
assert.equal(again.status, 200);
await again.text();
const { recommendations: rec2 } = await (await fetch(`${base}/api/chat/recommendations`, { headers: { cookie } })).json();
assert.equal(rec2.picks.length, 5);
assert.ok(new Date(rec2.createdAt) >= new Date(rec.createdAt));

// A staff member trying the assistant as the group publishes nothing to the client's page.
const trial = await fetch(`${base}/api/admin/chat/send`, { method: "POST", headers: { ...json, ...auth }, body: JSON.stringify({ group: g.name, content: "Please recommend plans.", page: "admin" }) });
assert.equal(trial.status, 200);
const trialBody = await trial.text();
assert.doesNotMatch(trialBody, /event: recommendations/);
const { recommendations: rec3 } = await (await fetch(`${base}/api/chat/recommendations`, { headers: { cookie } })).json();
assert.equal(rec3.createdAt, rec2.createdAt, "the staff trial left the client's picks alone");

// No session, no picks.
assert.equal((await fetch(`${base}/api/chat/recommendations`)).status, 401);

console.log("plan recommendations: census as aggregates in the briefing, the rule in place, the button's question answered, picks published to the page - ok", { group: g.name, employees: ages.length, average: avg, picks: rec.picks.length });
stop();

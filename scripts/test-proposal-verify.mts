// The four-step check behind the Proposals grid (server/proposal-verify.js),
// and the rule that a newer upload which has not read never replaces one
// that has - the Boss Logistics UHC Level Funded case, where a re-upload that
// failed to read deleted the good reading and emptied the slot.
// Runs with `node --experimental-strip-types`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { gridCounts, verifyProposals } from "../server/proposal-verify.js";
import { applyCorrection, offeredCount, readingVersion, auditProposal, auditForClient, shape } from "../server/proposal-audit.js";
import { proposalPlans, type KennionData, type Group, type GroupProposal } from "../client/src/lib/model.ts";

// --- The check's count is the client's count --------------------------------
const tiers = { EE: 5, ES: 2, EC: 0, FAM: 1 };
const plans = [
  { name: "Choice Plus 1000", rates: { EE: 600, ES: 1200, EC: 1100, FAM: 1700 } },
  { name: "Choice Plus 1000", rates: { EE: 600, ES: 1200, EC: 1100, FAM: 1700 } }, // printed twice on the quote
  { name: "Choice Plus 2000", rates: { EE: 500, ES: null, EC: 900, FAM: 1500 } }, // no ES rate, and ES has people
  { name: "Choice Plus 3000", rates: { EE: 450, ES: 900, EC: null, FAM: 1300 } }, // no EC rate, but EC is empty
  { name: "Unpriced", rates: { EE: null, ES: null, EC: null, FAM: null } },
];
const counts = gridCounts(plans, "UHC Level Funded", tiers);
assert.equal(counts.shown, 2);
assert.equal(counts.repeats, 1);
assert.deepEqual(counts.unpriced.map((p) => p.name), ["Choice Plus 2000", "Unpriced"]);
const pr = { id: 1, slot: "UHC Level Funded", carrier: "UnitedHealthcare", plans: plans.map((p) => ({ ...p, planType: "PPO" })), uploadedAt: "2026-09-01" } as unknown as GroupProposal;
const g = { name: "X", tiers } as unknown as Group;
assert.equal(proposalPlans({ proposals: [pr] } as unknown as KennionData, g).length, counts.shown, "the check counts exactly the plans the client's grid shows");

// --- The check, pure: Verified needs both auditors on this exact reading --
const isEpoPlan = (pl: { name?: string }) => /\bEPO\b/.test(pl.name || "");
const isBlankPlan = (pl: { name?: string }) => !pl || !pl.name;
const src = { identity: [2], benefits: [3], rates: [9], sheet: "", rows: "", appearances: 3, codes: [] };
const canon = (plans: object[]) => ({
  plans,
  excluded: [{ name: "Copay 1500 EPO", plan_code: null, network: null, reason: "EPO - Kennion offers PPO plans only" }],
  reconciliation: { plan_appearances: plans.length * 3 + 1, unique_plans: plans.length + 1, unique_ppo: plans.length, unique_epo: 1, excluded: 1, expected: plans.length, reader_unique_plans: plans.length + 1 },
  extraction: { sourceSha: "sha-acme" },
});
const plan1 = (over = {}) => ({ name: "Copay 1500 PPO", option_id: "GR1", deductible: "$1,500", oop_max: "$5,000", rates: { EE: 1, ES: 2, EC: 3, FAM: 4 }, source: src, ...over });
const reading1 = canon([plan1()]);
const passModel = (model: string, extra = {}) => ({ model, verdict: "pass", plansFoundTotal: 2, epoExcluded: 1, documentPlanCount: 1, confirmed: 1, of: 1, mismatches: [], notes: "", ...extra });
const dualPass = (extracted = reading1) => ({ status: "pass", completedAt: "2026-09-25T00:00:00Z", version: readingVersion(extracted), mismatches: [], models: [passModel("Claude (claude-sonnet-5)"), passModel("ChatGPT (gpt-5)")] });
const good = { id: 10, group_name: "Acme", slot: "Gravie", status: "assigned", superseded_by: null, size: 1000, mime: "application/pdf", source_sha: "sha-acme", filename: "acme gravie.pdf", extracted: reading1, audit: { ...dualPass(), sourceSha: "sha-acme" } };
const served = (rows: { id: number; slot: string; extracted: { plans: { name: string; option_id?: string; rates: object; unpriced?: string[] }[] } }[]) => () =>
  rows.map((r) => ({ id: r.id, slot: r.slot, plans: r.extracted.plans.filter((p) => !isEpoPlan(p)).map((p) => ({ name: p.name, optionId: p.option_id, rates: p.rates, unpriced: p.unpriced })) }));
const run = (rows: unknown[], srv: () => unknown[], gaveUp: (id: number) => string | null = () => null) =>
  verifyProposals({ groups: [{ name: "Acme", slots: ["Gravie", "Nationwide"], tiers: { EE: 1, ES: 1, EC: 1, FAM: 1 } }], rows, served: srv, isEpoPlan, isBlankPlan, readingVersion, gaveUp });
const cellOf = (v: ReturnType<typeof run>) => v.groups[0].cells[0];

let v = run([good], served([good]));
let cell = cellOf(v);
assert.equal(cell.state, "verified", JSON.stringify(cell.steps));
assert.equal(cell.plans, 1);
assert.deepEqual([cell.counts.document, cell.counts.stored, cell.counts.grid], [1, 1, 1], "document, database and grid: one number");
assert.deepEqual(cell.counts.audit.claude, { found: 2, epoExcluded: 1, expected: 1 }, "the EPO plan left out is on the record");
assert.equal(cell.stage, "VERIFIED");
assert.equal(cell.reconciliation.unique_epo, 1);
assert.equal(cell.excluded[0].name, "Copay 1500 EPO", "the EPO exclusion is visible, not silent");
assert.ok(cell.steps.validation.checks.every((k: { ok: boolean }) => k.ok));

// Validation runs before either audit: a duplicate, a conflict or a missing
// source page stops the box there, whatever the audits said.
const dupReading = canon([plan1(), plan1({ option_id: "GR2" })]);
let dup = { ...good, extracted: dupReading, audit: { ...dualPass(dupReading), sourceSha: "sha-acme" } };
cell = cellOf(run([dup], served([dup])));
assert.equal(cell.failedAt, "validation");
assert.equal(cell.fix, "correct");
assert.equal(cell.stage, "VALIDATING");
const conflictReading = canon([plan1({ conflicts: [{ field: "FAM", values: [{ value: 4, pages: [9] }, { value: 5, pages: [30] }] }] })]);
dup = { ...good, extracted: conflictReading, audit: { ...dualPass(conflictReading), sourceSha: "sha-acme" } };
assert.equal(cellOf(run([dup], served([dup]))).failedAt, "validation", "two appearances that disagree are never waved through");
const noSource = canon([plan1({ source: undefined })]);
dup = { ...good, extracted: noSource, audit: { ...dualPass(noSource), sourceSha: "sha-acme" } };
cell = cellOf(run([dup], served([dup])));
assert.equal(cell.fix, "read", "a reading without provenance is extracted again");

// An audit of another version of the document is stale.
cell = cellOf(run([{ ...good, audit: { ...good.audit, sourceSha: "sha-older" } }], served([good])));
assert.equal(cell.failedAt, "claude");
assert.equal(cell.fix, "audit");
assert.equal(v.groups[0].cells.find((c: { slot: string }) => c.slot === "Nationwide").state, "missing", "an empty slot is just blank");

// Never one-model green: ChatGPT did not complete -> pending, audit again.
const oneModel = { ...good, audit: { ...dualPass(), status: "pending", models: [passModel("Claude (claude-sonnet-5)"), { model: "ChatGPT (gpt-5)", verdict: "error", mismatches: [], notes: "fetch failed" }] } };
cell = cellOf(run([oneModel], served([oneModel])));
assert.equal(cell.state, "fail");
assert.equal(cell.failedAt, "chatgpt");
assert.equal(cell.fix, "audit");
assert.equal(cell.steps.claude.ok, true);

// A model that skipped a plan's rates is pending too.
const skipped = { ...good, audit: { ...dualPass(), status: "pending", models: [passModel("Claude (claude-sonnet-5)", { verdict: "incomplete", confirmed: 0 }), passModel("ChatGPT (gpt-5)")] } };
cell = cellOf(run([skipped], served([skipped])));
assert.equal(cell.failedAt, "claude");
assert.match(cell.steps.claude.note, /confirmed the rates of 0 of 1/);

// An audit of an earlier reading does not count: stale -> audit again.
const changed = canon([plan1({ rates: { EE: 9, ES: 2, EC: 3, FAM: 4 } })]);
const stale = { ...good, extracted: changed, audit: dualPass(reading1) };
cell = cellOf(run([stale], served([stale])));
assert.equal(cell.state, "fail");
assert.equal(cell.fix, "audit");
assert.match(cell.steps.claude.note, /earlier reading/);

// An open finding - even one model's - is corrected, never waved through.
const finding = { ...good, audit: { ...dualPass(), status: "issues", mismatches: [{ plan: "Copay 1500 PPO", field: "rate EE", stored: "1", onDocument: "2", by: "ChatGPT (gpt-5)" }], models: [passModel("Claude (claude-sonnet-5)"), passModel("ChatGPT (gpt-5)", { verdict: "issues" })] } };
cell = cellOf(run([finding], served([finding])));
assert.equal(cell.failedAt, "chatgpt");
assert.equal(cell.fix, "correct");

// A count that is not the database's fails the audit step.
const shortCount = { ...good, audit: { ...dualPass(), models: [passModel("Claude (claude-sonnet-5)", { documentPlanCount: 3 }), passModel("ChatGPT (gpt-5)")] } };
assert.equal(cellOf(run([shortCount], served([shortCount]))).failedAt, "claude");

// Grid: the page must show this exact reading.
cell = cellOf(run([good], () => [{ id: 10, slot: "Gravie", plans: [] }]));
assert.equal(cell.failedAt, "grid");
assert.equal(cell.fix, "refresh");
cell = cellOf(run([good], () => [{ id: 10, slot: "Gravie", plans: [{ name: "Copay 1500 PPO", rates: { EE: 7, ES: 2, EC: 3, FAM: 4 } }] }]));
assert.equal(cell.failedAt, "grid", "the grid showing other rates than the database is caught");

// Grid: a plan missing a tier rate the group needs - correct it, unless the
// document itself leaves that tier unpriced.
const noEsReading = canon([plan1({ rates: { EE: 1, ES: null, EC: 3, FAM: 4 } })]);
const noEs = { ...good, extracted: noEsReading, audit: dualPass(noEsReading) };
cell = cellOf(run([noEs], served([noEs])));
assert.equal(cell.failedAt, "validation", "a missing tier rate fails validation before any audit");
assert.equal(cell.fix, "correct");
const confirmedReading = canon([plan1({ rates: { EE: 1, ES: null, EC: 3, FAM: 4 }, unpriced: ["ES"] })]);
const confirmed = { ...good, extracted: confirmedReading, audit: dualPass(confirmedReading) };
assert.equal(cellOf(run([confirmed], served([confirmed]))).state, "verified", "a tier the carrier does not price is not a failure once confirmed");

// A newer upload that failed to read, waiting beside the good one.
const failed = { ...good, id: 11, extracted: null, audit: null, error: "This proposal is longer than one reading can hold", filename: "acme gravie v2.pdf" };
cell = cellOf(run([failed, good], served([good])));
assert.equal(cell.proposalId, 10, "the good reading stays in force");
assert.equal(cell.failedAt, "extraction");
assert.equal(cell.fix, "read");
assert.equal(cell.fixId, 11);
cell = cellOf(run([failed], () => []));
assert.equal(cell.proposalId, null);
assert.equal(cell.fixId, 11);

// The steward has run out of repairs: the box needs a person, and says why.
cell = cellOf(run([{ ...good, audit: null }], served([good]), () => "tried three times"));
assert.equal(cell.state, "stuck");
assert.equal(cell.stuck, "tried three times");

// --- Corrections: applied exactly, logged, repeats and EPO kept out ---------
const reading0 = {
  plans: [
    { name: "Choice Plus 1000", option_id: "UH1", rates: { EE: 600, ES: 1200, EC: 1100, FAM: null }, deductible: "$1,000", benefits: { rx: "$10" } },
    { name: "Choice Plus 2000", option_id: "UH2", rates: { EE: 500, ES: 1000, EC: 900, FAM: 1500 } },
    { name: "Not On Paper", option_id: "UH3", rates: { EE: 1, ES: 1, EC: 1, FAM: 1 } },
  ],
};
assert.equal(offeredCount(reading0), 3);
const fixed = applyCorrection(reading0, {
  fixes: [
    { index: 0, field: "EE", verdict: "fix", value: "$612.45" },
    { index: 0, field: "deductible", verdict: "fix", value: "$1,500" },
    { index: 0, field: "rx", verdict: "fix", value: "$15" },
    { index: 1, field: "ES", verdict: "stored_is_correct", value: "" },
  ],
  add: [
    { name: "Choice Plus 3000", rates: { EE: 450, ES: 900, EC: 800, FAM: 1300 } },
    { name: "Choice Plus 3000 EPO", rates: { EE: 400, ES: 800, EC: 700, FAM: 1200 } },
    { name: "Choice Plus 2000", rates: { EE: 500, ES: 1000, EC: 900, FAM: 1500 } },
  ],
  remove: [2],
  unpriced: [{ index: 0, tier: "FAM" }],
});
assert.deepEqual(fixed.extracted.plans.map((p) => p.name), ["Choice Plus 1000", "Choice Plus 2000", "Choice Plus 3000"], "wrong plan out, missing plan in, EPO and repeats never added");
assert.equal(fixed.extracted.plans[0].rates.EE, 612.45);
assert.equal(fixed.extracted.plans[0].deductible, "$1,500");
assert.equal(fixed.extracted.plans[0].benefits.rx, "$15");
assert.deepEqual(fixed.extracted.plans[0].unpriced, ["FAM"]);
assert.equal(fixed.extracted.plans[0].option_id, "UH1", "a plan keeps its number through a correction");
assert.equal(fixed.log.length, 6, "every change logged: 3 values, 1 unpriced tier, 1 removed, 1 added");
assert.equal(reading0.plans[0].rates.EE, 600, "the stored reading is not mutated");

// A plan "removed and added" under the same carrier code is one plan renamed
// in place - it keeps its BenSync ID and never leaves the grid.
const labelled = { plans: [{ name: "Option 1 - EZ2I (Open Access HSA) Rx plan: E04X", plan_code: "EZ2I", option_id: "UH4", rates: { EE: 1, ES: 2, EC: 3, FAM: 4 } }] };
const renamed = applyCorrection(labelled, { fixes: [], unpriced: [], remove: [0], add: [{ name: "EZ2I Open Access HSA", plan_code: "EZ2I", rates: { EE: 1, ES: 2, EC: 3, FAM: 4 }, source_pages: { identity: [4], benefits: [4], rates: [9] } }] }, { proposalId: 40, version: "v1", by: "test" });
assert.equal(renamed.extracted.plans.length, 1);
assert.equal(renamed.extracted.plans[0].option_id, "UH4", "the ID stays with the plan");
assert.equal(renamed.extracted.plans[0].name, "EZ2I Open Access HSA");
assert.deepEqual(renamed.log.map((l: { field: string }) => l.field), ["name"], "logged as a name correction, not a removal and an addition");
assert.equal(renamed.log[0].proposalId, 40);
assert.equal(renamed.log[0].optionId, "UH4");

// --- An auditor's answer is checked in code, not taken on its word ---------
const storedTwo = [
  { name: "A", rates: { EE: 100, ES: 200, EC: 180, FAM: 300 } },
  { name: "B", rates: { EE: 110, ES: 220, EC: 190, FAM: 320 } },
];
const says = (confirmations: object[]) => ({ verdict: "pass", plans_found_total: 2, epo_excluded: 0, document_plan_count: 2, rate_confirmations: confirmations, mismatches: [], notes: "" });
let sh = shape("ChatGPT (gpt-5)", says([{ index: 0, on_document: true, EE: 100, ES: 200, EC: 180, FAM: 300 }, { index: 1, on_document: true, EE: 110, ES: 220, EC: 190, FAM: 320 }]), storedTwo);
assert.equal(sh.verdict, "pass");
sh = shape("ChatGPT (gpt-5)", says([{ index: 0, on_document: true, EE: 100, ES: 200, EC: 180, FAM: 300 }, { index: 1, on_document: true, EE: 111.5, ES: 220, EC: 190, FAM: 320 }]), storedTwo);
assert.equal(sh.verdict, "issues", "a rate the auditor read differently is a finding even when it said pass");
assert.deepEqual(sh.mismatches, [{ plan: "B", field: "rate EE", stored: "110", onDocument: "111.5" }]);
sh = shape("ChatGPT (gpt-5)", says([{ index: 0, on_document: true, EE: 100, ES: 200, EC: 180, FAM: 300 }]), storedTwo);
assert.equal(sh.verdict, "incomplete", "a plan the auditor did not confirm keeps it from passing");
sh = shape("ChatGPT (gpt-5)", says([{ index: 0, on_document: true, EE: 100, ES: 200, EC: 180, FAM: 300 }, { index: 1, on_document: false, EE: null, ES: null, EC: null, FAM: null }]), storedTwo);
assert.equal(sh.mismatches[0].field, "missing_plan");

// --- The audit record: both models, counts, version; clients see only a current pass
process.env.KENNION_FAKE_AI = "1";
const au = await auditProposal({ filename: "x.pdf", mime: "application/pdf", buffer: Buffer.from(""), extracted: reading0 });
assert.equal(au.status, "pass");
assert.equal(au.models.length, 2);
assert.ok(au.models.every((m: { verdict: string; confirmed: number; of: number }) => m.verdict === "pass" && m.confirmed === m.of));
assert.equal(au.version, readingVersion(reading0));
assert.equal(au.counts.stored, 3);
assert.deepEqual(auditForClient(au, reading0), { status: "pass", completedAt: au.completedAt });
assert.equal(auditForClient(au, fixed.extracted), null, "an audit of another reading is no audit for the client");
delete process.env.KENNION_FAKE_AI;

// --- End to end: the server keeps the good reading --------------------------
const PORT = 5091;
const CODE = "verify-test-code";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
const mine = staff.groups.find((x: { archived?: boolean; eligible?: boolean }) => !x.archived && x.eligible !== false);

const reading = (ee: number, n = 1) => ({
  carrier: "Nationwide",
  funding: "level funded",
  quotes_medical: true,
  matched_group: mine.name,
  confidence: 0.95,
  effective_date: "2027-01-01",
  proposal_type: "renewal",
  enrolled_on_document: mine.enrolled,
  plans: Array.from({ length: n }, (_, i) => ({ name: `Nationwide PPO ${i + 1}`, plan_code: `NW${i + 1}`, network: "Cigna", plan_type: "PPO", deductible: "$1,000", oop_max: "$5,000", benefits: {}, rates: { EE: ee + i, ES: ee * 2, EC: ee * 2, FAM: ee * 3 }, monthly_total: null })),
  total_monthly: null,
  summary: "Canned Nationwide quote.",
});
const upload = async (filename: string, body: unknown) => {
  const r = await fetch(`${base}/api/admin/proposals?filename=${encodeURIComponent(filename)}&group=${encodeURIComponent(mine.name)}&slot=Nationwide`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "text/plain" },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, await r.text());
};
const list = async () => ((await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals || []) as { id: number; filename: string; status: string; audit: unknown; extracted: unknown }[];
const settle = async (filename: string, audited = true) => {
  for (let i = 0; i < 80; i++) {
    await wait(250);
    const r = (await list()).find((x) => x.filename === filename);
    if (r && r.status !== "analyzing" && (!audited || r.audit)) return r;
  }
  throw new Error(`${filename} never settled`);
};
const check = async () => {
  const v = await (await fetch(`${base}/api/admin/proposals/verify`, { headers: auth })).json();
  return v.groups.find((x: { group: string }) => x.group === mine.name).cells.find((c: { slot: string }) => c.slot === "Nationwide");
};

await upload("nw v1.json", reading(500, 3));
const first = await settle("nw v1.json");
let c = await check();
assert.equal(c.state, "verified", JSON.stringify(c.steps));
assert.equal(c.proposalId, first.id);

// A re-upload that reads no plans (a failed or cut-off read) does not replace it.
await upload("nw v2.json", { ...reading(600), plans: [] });
await settle("nw v2.json", false);
await wait(300);
const rows = await list();
assert.ok(rows.some((r) => r.id === first.id), "the good reading is not deleted by an upload that did not read");
c = await check();
assert.equal(c.proposalId, first.id, "and it stays the one in force");
assert.equal(c.failedAt, "extraction");
assert.equal(c.waiting.length, 1);
// The steward reads the unread upload again, twice, then hands it to a person.
for (let i = 0; i < 80 && c.state !== "stuck"; i++) {
  await wait(250);
  c = await check();
}
assert.equal(c.state, "stuck", JSON.stringify(c));
assert.match(c.stuck, /would not read into plans in 2 tries/);
assert.equal(c.proposalId, first.id, "the good reading is still in force");

// The group's own page still carries the good plans.
const cookie = ((await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: mine.code }) })).headers.get("set-cookie") || "").split(";")[0];
const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
const nw = (page.proposals || []).find((p: { slot: string }) => p.slot === "Nationwide");
assert.equal(nw.id, first.id);
assert.equal(nw.plans.length, 3);

// A newer upload that does read takes over, and both older ones go.
await upload("nw v3.json", reading(700, 2));
const third = await settle("nw v3.json");
await wait(300);
const after = await list();
assert.ok(!after.some((r) => r.id === first.id), "the replaced reading is deleted once the new one reads");
assert.ok(!after.some((r) => r.filename === "nw v2.json"), "and the unread upload with it");
c = await check();
assert.equal(c.proposalId, third.id);
assert.equal(c.state, "verified");
assert.equal(c.plans, 2);

assert.deepEqual([c.counts.document, c.counts.stored, c.counts.grid], [2, 2, 2]);
assert.ok((await fetch(`${base}/api/admin/proposals/fix`, { method: "POST", headers: auth })).ok, "staff can ask the steward to try again");
assert.equal((await fetch(`${base}/api/admin/proposals/verify`)).status, 401, "staff only");

console.log("proposal verify: Verified only on a dual audit of the exact reading on the grid, one plan count at every step, rates checked in code, corrections applied and logged, the steward repairs or hands over, an unread upload never replaces a read one - ok");
stop();

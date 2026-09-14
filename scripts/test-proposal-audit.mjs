// The proposal audit, end to end (canned models, KENNION_FAKE_AI): a
// proposal uploaded into a group's slot is read, then checked against its
// document; the result rides to the client's page and the plan cards; the
// client can open the document behind a plan, and only its own group's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 5086;
const CODE = "audit-test-code";
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const staffAuth = { Authorization: `Bearer ${staff.token}` };
const [mine, other] = staff.groups.filter((g) => !g.archived && g.eligible !== false);
const cookieFor = async (code) => {
  const r = await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code }) });
  return (r.headers.get("set-cookie") || "").split(";")[0];
};
const cookie = await cookieFor(mine.code);
const otherCookie = await cookieFor(other.code);

// A canned proposal: in fake mode the reader takes the JSON as its reading.
const reading = {
  carrier: "Gravie",
  funding: "level funded",
  quotes_medical: true,
  matched_group: mine.name,
  confidence: 0.95,
  effective_date: "2027-01-01",
  proposal_type: "renewal",
  enrolled_on_document: mine.enrolled,
  plans: [
    { name: "Gravie Copay 1500 PPO", plan_code: "G1500", network: "Cigna OAP (PPO)", plan_type: "PPO", deductible: "$1,500", oop_max: "$5,000", benefits: {}, rates: { EE: 610, ES: 1250, EC: 1150, FAM: 1800 }, monthly_total: null },
    { name: "Gravie Copay 1500 EPO", plan_code: "G1500E", network: "Cigna OAP (EPO)", plan_type: "EPO", deductible: "$1,500", oop_max: "$5,000", benefits: {}, rates: { EE: 590, ES: 1210, EC: 1110, FAM: 1750 }, monthly_total: null },
  ],
  total_monthly: null,
  summary: "Canned Gravie quote.",
};
const up = await fetch(`${base}/api/admin/proposals?filename=${encodeURIComponent("gravie-quote.json")}&group=${encodeURIComponent(mine.name)}&slot=Gravie`, {
  method: "POST",
  headers: { ...staffAuth, "Content-Type": "text/plain" },
  body: JSON.stringify(reading),
});
assert.equal(up.status, 200, await up.text());

// The read and then the audit run in the background; wait for both.
let row;
for (let i = 0; i < 80; i++) {
  await wait(250);
  const list = (await (await fetch(`${base}/api/admin/proposals`, { headers: staffAuth })).json()).proposals || [];
  row = list.find((r) => r.filename === "gravie-quote.json");
  if (row && row.status !== "analyzing" && row.audit) break;
}
assert.ok(row, "the proposal is on file");
assert.equal(row.status, "assigned");
assert.equal(row.slot, "Gravie");
assert.ok(row.audit, "the audit ran after the read");
assert.equal(row.audit.status, "pass");
assert.equal(row.audit.models.length, 2, "two models checked it");
assert.ok(row.audit.models.every((m) => m.verdict === "pass"));

// The client's page: the proposal carries the audit outcome, never the notes,
// and the EPO twin is not offered.
const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
const pr = (page.proposals || []).find((p) => p.slot === "Gravie");
assert.ok(pr, "the client sees its Gravie proposal");
assert.equal(pr.id, row.id);
assert.deepEqual(Object.keys(pr.audit).sort(), ["completedAt", "status"], "the client is told the outcome and when, nothing about who checked");
assert.equal(pr.audit.status, "pass");
assert.deepEqual(
  pr.plans.map((p) => p.name),
  ["Gravie Copay 1500 PPO"],
  "PPO only: the EPO version never reaches the client",
);

// The carrier's document stays with staff: no client route serves it.
assert.equal((await fetch(`${base}/api/group/proposals/${row.id}/file`, { headers: { cookie } })).status, 404);
assert.equal((await fetch(`${base}/api/admin/proposals/${row.id}/file`, { headers: { cookie } })).status, 401, "the staff route needs a staff token");

// Run it again on demand, and for everything at once.
assert.equal((await fetch(`${base}/api/admin/proposals/${row.id}/audit`, { method: "POST", headers: staffAuth })).status, 200);
const all = await (await fetch(`${base}/api/admin/proposals/audit?all=1`, { method: "POST", headers: staffAuth })).json();
assert.ok(all.queued >= 1);
await wait(600);
const again = ((await (await fetch(`${base}/api/admin/proposals`, { headers: staffAuth })).json()).proposals || []).find((r) => r.id === row.id);
assert.ok(again.audit && again.audit.completedAt >= row.audit.completedAt);

console.log("proposal audit: read, then checked by two models; outcome on the client's page; document behind the plan — ok", { group: mine.name });
stop();

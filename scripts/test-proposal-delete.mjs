// Stored vs shown, and delete, end to end (no database, KENNION_FAKE_AI):
// a Gravie workbook's every plan - PPO and EPO - is stored on the proposal
// and as quote rows; the client is shown every one of them; deleting the
// proposal takes everything read from it, so the group's data matches the
// proposals on file and nothing else.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { parseGravieWorkbook, gravieExtracted, gravieDrift } from "../server/gravie-parse.js";

const PORT = 5091;
const CODE = "delete-test-code";
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
const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
const g = staff.groups.filter((x) => !x.archived && x.eligible !== false)[0];
const cookie = ((await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: g.code }) })).headers.get("set-cookie") || "").split(";")[0];
const clientGravie = async () => {
  const page = await (await fetch(`${base}/api/signin`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).json();
  const pr = (page.proposals || []).find((p) => p.slot === "Gravie");
  return pr ? pr.plans.map((p) => p.name) : [];
};

// A workbook laid out the way Gravie sends one, for this group.
const sheet = (rows) =>
  XLSX.utils.aoa_to_sheet([
    ["Gravie", "comfort"],
    ["Group Name:", g.name, null, "Subscribers Quoted by Tier"],
    ["Effective Date", 46388, null, "EE:", 10],
    ["Date Generated:", 46273, null, "ES:", 2],
    ["Quote Number:", "00012345", null, "EC:", 1],
    ["Network:", "Cigna Healthcare Open Access Plus Network", null, "F:", 3],
    [],
    ["Plan Name", "Plan Type", "Deductible", "OOPM", "Coinsurance", "Column1", "EE Rate", "ES Rate", "EC Rate", "F Rate"],
    ...rows,
  ]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet([
  ["Gravie QHDHP $5,000 Ded/$5,000 OOPM EPO", "QHDHP", "$5000/$10000", "$5000/$10000", 0, 0, 350, 700, 600, 1000],
  ["Gravie Comfort $2,500 OOPM EPO", "Comfort", "$2500/$5000", "$2500/$5000", 0, 0, 500, 1000, 900, 1500],
]), "EPO");
XLSX.utils.book_append_sheet(wb, sheet([
  ["Gravie QHDHP $5,000 Ded/$5,000 OOPM", "QHDHP", "$5000/$10000", "$5000/$10000", 0, 0, 360, 720, 620, 1030],
  ["Gravie Comfort $2,500 OOPM", "Comfort", "$2500/$5000", "$2500/$5000", 0, 0, 510, 1020, 910, 1520],
]), "PPO");
const zip = new JSZip();
zip.file("Example Gravie Quote.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
const up = await fetch(`${base}/api/admin/proposals/gravie-batch`, { method: "POST", headers: { ...auth, "Content-Type": "application/zip" }, body: await zip.generateAsync({ type: "nodebuffer" }) });
const got = await up.json();
assert.equal(up.status, 200, JSON.stringify(got));
assert.equal(got.stored, 1, JSON.stringify(got));

// Stored: every plan, EPO included, on the proposal and as quote rows.
const rows = (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals;
const row = rows.find((r) => r.group_name === g.name && r.slot === "Gravie");
const id = row.id;
assert.equal(row.extracted.plans.length, 4, "all four plans stored");
// The stored reading is exactly what the workbook says: the boot check
// (settleGravieQuotes) finds no drift, so it never re-parses a good reading.
const wbBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
assert.equal(gravieDrift(row.extracted.plans, gravieExtracted(parseGravieWorkbook(wbBuf)).plans), null);
// A correction that rewrote a network is drift: the workbook wins.
assert.match(gravieDrift(row.extracted.plans.map((pl, i) => (i ? pl : { ...pl, network: "Cigna Healthcare LocalPlus Cigna Healthcare Open Access Plus" })), gravieExtracted(parseGravieWorkbook(wbBuf)).plans), /1 plan\(s\) differ/);
assert.deepEqual(
  { u: row.extracted.reconciliation.unique_plans, ppo: row.extracted.reconciliation.unique_ppo, epo: row.extracted.reconciliation.unique_epo, exp: row.extracted.reconciliation.expected },
  { u: 4, ppo: 2, epo: 2, exp: 4 },
);
const quote = await (await fetch(`${base}/api/admin/quotes/Gravie/${encodeURIComponent(g.name)}`, { headers: auth })).json();
assert.equal(quote.plans.length, 4, "every plan as a quote row");

// Shown: every plan, numbered in document order.
// The client is shown a proposal once it is Verified: every plan of it.
let shown = [];
for (let i = 0; i < 120 && shown.length === 0; i++) {
  shown = await clientGravie();
  if (!shown.length) await new Promise((r) => setTimeout(r, 250));
}
assert.deepEqual(shown, ["Gravie QHDHP $5,000 Ded/$5,000 OOPM", "Gravie Comfort $2,500 OOPM", "Gravie QHDHP $5,000 Ded/$5,000 OOPM EPO", "Gravie Comfort $2,500 OOPM EPO"], "every quoted plan shown: 4 stored, 4 on the client's grid");
await new Promise((r) => setTimeout(r, 500));
const numbered = (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals.find((r) => r.id === id);
assert.deepEqual(
  numbered.extracted.plans.map((p) => `${p.option_id}:${/EPO$/.test(p.name) ? "EPO" : "PPO"}`).sort(),
  ["GR1:PPO", "GR2:PPO", "GR3:EPO", "GR4:EPO"],
  "numbered in document order",
);

// Deleted: the proposal and every row read from it.
assert.equal((await fetch(`${base}/api/admin/proposals/${id}`, { method: "DELETE", headers: auth })).status, 200);
const after = (await (await fetch(`${base}/api/admin/proposals`, { headers: auth })).json()).proposals;
assert.ok(!after.some((r) => r.id === id), "the proposal is gone");
const q2 = await fetch(`${base}/api/admin/quotes/Gravie/${encodeURIComponent(g.name)}`, { headers: auth });
assert.equal(q2.status, 404, "its quote rows are gone");
const list = await (await fetch(`${base}/api/admin/quotes?carrier=Gravie`, { headers: auth })).json();
assert.ok(!(list.quotes || []).some((q) => q.groupName === g.name), "no quote left for the group");
assert.deepEqual(await clientGravie(), [], "the client sees nothing from it");

console.log("proposal delete: every plan stored and shown (EPO included), and a delete takes everything read from the proposal - ok");
stop();

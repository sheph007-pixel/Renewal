// Benchmarks end to end: staff propose (canned, KENNION_FAKE_AI), approve,
// add and fix rows; the client's page compares its group; the assistant's
// tool reads only approved rows; nothing shows without a session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 5083;
const CODE = "bench-test-code";
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
const staffAuth = { Authorization: `Bearer ${staff.token}` };
const mine = staff.groups.filter((g) => !g.archived && g.eligible !== false)[0];
const r0 = await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: mine.code }) });
const cookie = (r0.headers.get("set-cookie") || "").split(";")[0];

// No session, nothing. With one, nothing yet approved.
assert.equal((await fetch(`${base}/api/benchmarks`)).status, 401);
assert.equal((await fetch(`${base}/api/admin/benchmarks`)).status, 401);
let page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.deepEqual(page.comparison.lines, []);
assert.ok(page.metrics.length >= 8);

// The assistant proposes; nothing is in use until approved.
let admin = await (await fetch(`${base}/api/admin/benchmarks/refresh`, { method: "POST", headers: staffAuth })).json();
assert.equal(admin.rows.length, 3);
assert.ok(admin.rows.every((r) => r.status === "proposed"));
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.deepEqual(page.comparison.lines, [], "proposed rows do not reach the client");

// Approve one: the client sees it, with the group's own figure beside it.
const single = admin.rows.find((r) => r.metric === "premium_single_annual");
const ok = await (await fetch(`${base}/api/admin/benchmarks/${single.id}`, { method: "PATCH", headers: { ...json, ...staffAuth }, body: JSON.stringify({ status: "approved" }) })).json();
assert.equal(ok.row.status, "approved");
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.equal(page.comparison.lines.length, 1);
const line = page.comparison.lines[0];
assert.equal(line.metric, "premium_single_annual");
assert.equal(line.benchmark, 9000);
assert.match(line.source, /Canned/);
assert.ok(line.group == null || line.group > 0, "the group's figure is its EE rate × 12 when rates are on file");

// A row for another firm size does not apply to this group.
const family = admin.rows.find((r) => r.metric === "premium_family_annual");
await fetch(`${base}/api/admin/benchmarks/${family.id}`, { method: "PATCH", headers: { ...json, ...staffAuth }, body: JSON.stringify({ status: "approved" }) });
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.equal(page.comparison.lines.length, page.comparison.sizeBand === "3-49" ? 2 : 1, "a 3-49 row applies only to a 3-49 group");
await fetch(`${base}/api/admin/benchmarks/${family.id}`, { method: "PATCH", headers: { ...json, ...staffAuth }, body: JSON.stringify({ status: "proposed" }) });

// A refresh replaces the old proposals but leaves approved rows alone.
admin = await (await fetch(`${base}/api/admin/benchmarks/refresh`, { method: "POST", headers: staffAuth })).json();
let all = (await (await fetch(`${base}/api/admin/benchmarks`, { headers: staffAuth })).json()).rows;
assert.equal(all.filter((r) => r.status === "approved").length, 1);
assert.equal(all.filter((r) => r.status === "proposed").length, 3);
assert.ok(!all.some((r) => r.id === family.id), "the unapproved family row was replaced by the refresh");

// Staff add a row by hand, fix a value, and remove one.
const added = await (await fetch(`${base}/api/admin/benchmarks`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ metric: "deductible_single", sizeBand: "all", region: "south", value: 2500, year: 2025, source: "KFF EHBS" }) })).json();
assert.equal(added.rows[0].status, "approved");
assert.equal((await fetch(`${base}/api/admin/benchmarks`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ metric: "nope", value: 1, source: "x" }) })).status, 400);
const fixed = await (await fetch(`${base}/api/admin/benchmarks/${added.rows[0].id}`, { method: "PATCH", headers: { ...json, ...staffAuth }, body: JSON.stringify({ value: 2600 }) })).json();
assert.equal(fixed.row.value, 2600);
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.equal(page.comparison.lines.length, 2);
assert.equal((await fetch(`${base}/api/admin/benchmarks/${added.rows[0].id}`, { method: "DELETE", headers: staffAuth })).status, 200);
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.equal(page.comparison.lines.length, 1);

// The preview shows staff a group's page as the client sees it.
const preview = await (await fetch(`${base}/api/admin/benchmarks/preview?group=${encodeURIComponent(mine.name)}`, { headers: staffAuth })).json();
assert.equal(preview.comparison.lines.length, 1);
assert.equal((await fetch(`${base}/api/admin/benchmarks/preview?group=No%20Such`, { headers: staffAuth })).status, 404);

console.log("benchmarks: propose, approve, add, fix, remove, compare per group — ok", { group: mine.name, band: page.comparison.sizeBand });
stop();

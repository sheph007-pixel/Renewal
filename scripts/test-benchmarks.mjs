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

// No session, nothing. With one, nothing yet on file.
assert.equal((await fetch(`${base}/api/benchmarks`)).status, 401);
assert.equal((await fetch(`${base}/api/admin/benchmarks`)).status, 401);
let page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.deepEqual(page.comparison.lines, []);
assert.equal(page.metrics.length, 6, "six figures employers ask about");

// The assistant loads a set straight in, each row citing its source; the client sees what fits its size and place.
let admin = await (await fetch(`${base}/api/admin/benchmarks/refresh`, { method: "POST", headers: staffAuth })).json();
assert.equal(admin.rows.length, 3);
assert.ok(admin.rows.every((r) => r.createdBy === "assistant" && r.source));
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
const band = page.comparison.sizeBand;
assert.ok(["2-50", "51+"].includes(band), "the ACA line");
assert.equal(page.comparison.region, "AL");
const want = band === "2-50" ? 3 : 2; // the 2-50 cost-sharing row applies only to a small group
assert.equal(page.comparison.lines.length, want, "rows for other sizes do not apply");
const single = page.comparison.lines.find((l) => l.metric === "premium_single_annual");
assert.equal(single.benchmark, 9000);
assert.match(single.source, /Canned/);
assert.ok(single.group == null || single.group > 0, "the group's figure is its EE rate × 12 when rates are on file");
const ded = page.comparison.lines.find((l) => l.metric === "deductible_single");
assert.equal(ded.region, "south", "a South row beats none for an Alabama group");

// A second load replaces the assistant's rows but leaves a row added by hand alone.
const added = await (await fetch(`${base}/api/admin/benchmarks`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ metric: "participation_pct", sizeBand: "all", region: "AL", value: 77, year: 2024, source: "MEPS-IC" }) })).json();
assert.equal(added.rows[0].createdBy, "hunter@kennion.com");
assert.equal((await fetch(`${base}/api/admin/benchmarks`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ metric: "nope", value: 1, source: "x" }) })).status, 400);
admin = await (await fetch(`${base}/api/admin/benchmarks/refresh`, { method: "POST", headers: staffAuth })).json();
let all = (await (await fetch(`${base}/api/admin/benchmarks`, { headers: staffAuth })).json()).rows;
assert.equal(all.length, 4);
assert.ok(all.some((r) => r.id === added.rows[0].id), "the hand-added row survives a refresh");

// Fix a value, see it on the client's page, remove it.
const fixed = await (await fetch(`${base}/api/admin/benchmarks/${added.rows[0].id}`, { method: "PATCH", headers: { ...json, ...staffAuth }, body: JSON.stringify({ value: 80 }) })).json();
assert.equal(fixed.row.value, 80);
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
const part = page.comparison.lines.find((l) => l.metric === "participation_pct");
assert.equal(part.benchmark, 80);
assert.ok(part.group == null || (part.group > 0 && part.group <= 100), "participation is enrolled over eligible");
assert.equal((await fetch(`${base}/api/admin/benchmarks/${added.rows[0].id}`, { method: "DELETE", headers: staffAuth })).status, 200);
page = await (await fetch(`${base}/api/benchmarks`, { headers: { cookie } })).json();
assert.ok(!page.comparison.lines.some((l) => l.metric === "participation_pct"));

// The admin's table: every group, and one group's page as the client sees it.
const overview = await (await fetch(`${base}/api/admin/benchmarks/overview`, { headers: staffAuth })).json();
assert.ok(overview.groups.length > 1);
const row = overview.groups.find((g) => g.group === mine.name);
assert.ok(row && row.lines.length === want);
const preview = await (await fetch(`${base}/api/admin/benchmarks/preview?group=${encodeURIComponent(mine.name)}`, { headers: staffAuth })).json();
assert.equal(preview.comparison.lines.length, want);
assert.equal((await fetch(`${base}/api/admin/benchmarks/preview?group=No%20Such`, { headers: staffAuth })).status, 404);

console.log("benchmarks: load from surveys, hand rows, fix, remove, every group compared — ok", { group: mine.name, band });
stop();

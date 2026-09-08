// What a signed-in group may see of the portal: itself, and nothing else.
// Runs the real server on a spare port and reads two groups' payloads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 5077;
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), KENNION_FAKE_AI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const stop = () => server.kill();
process.on("exit", stop);

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${base}/healthz`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const staff = await (
  await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "hunter@kennion.com", code: "87878787" }),
  })
).json();
const roster = staff.groups.filter((g) => !g.archived && g.eligible !== false);
assert.ok(roster.length > 5, "a roster to test against");

const mine = roster[0];
const payload = await (
  await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: mine.code }),
  })
).json();
assert.equal(payload.group.name, mine.name);

// 1. No census. Not one employee record, anywhere in the payload.
assert.equal(payload.group.members, undefined, "the census does not leave the server");
const blob = JSON.stringify(payload);
for (const key of ["\"first\"", "\"last\"", "\"spAges\"", "\"chAges\"", "\"zip\"", "\"gender\""]) {
  assert.ok(!blob.includes(key), `no member field ${key} in a group payload`);
}

// 2. The tier counts the pages price from are there instead, and add up.
const tiers = payload.group.tiers;
assert.ok(tiers && typeof tiers.EE === "number", "tier counts sent");
const perPlan = payload.group.planTiers || {};
const summed = Object.values(perPlan).reduce(
  (a, c) => ({ EE: a.EE + c.EE, ES: a.ES + c.ES, EC: a.EC + c.EC, FAM: a.FAM + c.FAM }),
  { EE: 0, ES: 0, EC: 0, FAM: 0 },
);
assert.deepEqual(summed, tiers, "per-plan tier counts sum to the group's");
assert.equal(
  tiers.EE + tiers.ES + tiers.EC + tiers.FAM,
  payload.group.enrolled,
  "and to the enrolled count on the page",
);

// 3. No other company. Not a name, not a premium, not a note.
for (const other of roster.filter((g) => g.name !== mine.name)) {
  assert.ok(!blob.includes(other.name), `no sign of ${other.name} in ${mine.name}'s payload`);
}
assert.deepEqual(payload.uhc.summary, {}, "no other group's UHC summary");
assert.deepEqual(Object.keys(payload.uhc.detail).filter((n) => n !== mine.name), [], "only this group's UHC rows");
assert.deepEqual(Object.keys(payload.splits).filter((n) => n !== mine.name), [], "only this group's split");

// 4. The reference used to price an un-quoted group is a number, not a group.
assert.ok(
  payload.uhc.refEE == null || typeof payload.uhc.refEE === "number",
  "the benchmark is a scalar, carrying no other company's rows",
);

// 5. A group's token reaches only that group.
const other = roster.find((g) => g.name !== mine.name && g.linkToken);
if (other) {
  const byToken = await (
    await fetch(`${base}/api/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: other.linkToken }),
    })
  ).json();
  assert.equal(byToken.group.name, other.name, "a token opens its own group");
  assert.equal(byToken.group.members, undefined, "and no census with it");
}

// 6. Nothing on the admin side answers to a group's credentials.
for (const path of ["/api/admin/session", "/api/admin/proposals", "/api/admin/reconcile/export"]) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${mine.code}` } });
  assert.equal(r.status, 401, `${path} refuses a group code as a token`);
}

console.log("group payload: all assertions passed", {
  group: mine.name,
  enrolled: payload.group.enrolled,
  bytes: blob.length,
  otherCompanies: 0,
});
stop();

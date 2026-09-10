// What a signed-in group may see of the portal: itself, and nothing else.
// Runs the real server on a spare port and reads two groups' payloads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 5077;
// A code for this run only. The server refuses anything published in the repo.
const CODE = "test-only-code-not-in-repo";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1" },
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
    body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }),
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

// 6. Kennion's own bookkeeping stays on the admin side.
for (const field of ["broker", "manager", "renewal", "sic", "sicDesc", "divisionCode", "taxId", "contacts", "archived", "eligible"]) {
  assert.equal(payload.group[field], undefined, `${field} is not a client's business`);
}

// 7. Codes are guessable by design, so guessing is throttled.
const guess = (code, ip) =>
  fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ code }),
  });
const attacker = "198.51.100.7";
const codes = [];
for (let i = 0; i < 12; i++) codes.push((await guess(`ZZZ${i}2027`, attacker)).status);
assert.ok(codes.slice(0, 10).every((c) => c === 404), "the first attempts answer normally");
assert.ok(codes.slice(10).every((c) => c === 429), "then the guessing is cut off");
assert.equal((await guess(mine.code, attacker)).status, 429, "a real code does not slip through the block");
assert.equal((await guess(mine.code, "203.0.113.4")).status, 200, "and another caller is unaffected");

// 8. Nothing on the admin side answers to a group's credentials.
for (const path of ["/api/admin/session", "/api/admin/proposals", "/api/admin/reconcile/export"]) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${mine.code}` } });
  assert.equal(r.status, 401, `${path} refuses a group code as a token`);
}

// 8b. The cookie session behind a group's short address. Signing in sets an
// HttpOnly cookie; that cookie alone signs the browser in again, with the
// slug its short address is built from; without it there is no session, and
// a guessless miss is not counted against the caller; sign-out clears it.
{
  const r = await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: mine.code }),
  });
  const setCookie = r.headers.get("set-cookie") || "";
  assert.match(setCookie, /^kennion_group=/, "sign-in sets the group session cookie");
  assert.match(setCookie, /HttpOnly/, "the cookie is HttpOnly");
  assert.match(setCookie, /SameSite=Lax/, "and SameSite");
  const cookie = setCookie.split(";")[0];
  const again = await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: "{}",
  });
  assert.equal(again.status, 200, "the cookie alone signs the group in again");
  const p2 = await again.json();
  assert.equal(p2.group.name, mine.name, "as the same group");
  assert.match(p2.slug, /^[a-z0-9-]+$/, "with the slug its short address is built from");
  assert.ok(p2.slug.endsWith(mine.code.toLowerCase()), "the slug ends in the group's code");
  const page = await fetch(`${base}/${p2.slug}/options`);
  assert.equal(page.status, 200, "the short address serves the app");
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  const none = await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(none.status, 401, "no cookie, no session");
  const forged = await fetch(`${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `kennion_group=${mine.linkToken}.forged` },
    body: "{}",
  });
  assert.equal(forged.status, 401, "a cookie with a bad signature is no session");
  const out = await fetch(`${base}/api/signout`, { method: "POST", headers: { cookie } });
  assert.match(out.headers.get("set-cookie") || "", /kennion_group=;.*Max-Age=0/, "sign-out clears the cookie");
  console.log("cookie session: sign-in sets it, it signs in alone, forgeries and absence do not — ok");
}

// 9. Every response carries the headers that keep a token out of a referrer.
const headers = (await fetch(`${base}/healthz`)).headers;
assert.equal(headers.get("referrer-policy"), "no-referrer", "a group's token never rides a Referer header");
assert.equal(headers.get("x-frame-options"), "DENY");
assert.equal(headers.get("x-content-type-options"), "nosniff");

console.log("group payload: all assertions passed", {
  group: mine.name,
  enrolled: payload.group.enrolled,
  bytes: blob.length,
  otherCompanies: 0,
});
// An API path no route claimed answers 404 JSON, not the app. Falling through
// to the SPA turned a mistyped endpoint into 200 and a page of HTML, which a
// caller can only meet as a JSON parse error.
{
  const r = await fetch(`${base}/api/admin/does-not-exist`);
  assert.equal(r.status, 404, "an unknown API path is a 404");
  assert.match(r.headers.get("content-type") || "", /application\/json/, "and it is JSON");
  assert.match((await r.json()).error, /No such endpoint/);

  const page = await fetch(`${base}/admin/groups`);
  assert.equal(page.status, 200, "a real page still comes back");
  assert.match(page.headers.get("content-type") || "", /text\/html/, "as the app");
  console.log("unknown API paths 404 as JSON, pages still serve the app — ok");
}

stop();


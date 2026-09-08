// The staff sign-in flow with two factors: enrol, sign in, recovery, refusal.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { totp } from "../server/totp.js";

const PORT = 5078;
const CODE = "test-only-code-not-in-repo";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
process.on("exit", () => server.kill());
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}
const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
const signIn = (ip = "203.0.113.1") =>
  post("/api/signin", { email: "hunter@kennion.com", code: CODE }, { "X-Forwarded-For": ip });

// 1. With nothing enrolled, the code alone signs in — and says so.
let r = await signIn();
let j = await r.json();
assert.equal(r.status, 200);
assert.equal(j.twoFactor, "not-set-up", "an un-enrolled session is told to set it up");
const token = j.token;
const auth = { Authorization: `Bearer ${token}` };

assert.deepEqual(await (await fetch(`${base}/api/admin/2fa`, { headers: auth })).json(), {
  on: false,
  started: false,
  recoveryLeft: 0,
});

// 2. Enrol: a secret to scan, then a code from it.
const start = await (await post("/api/admin/2fa/start", {}, auth)).json();
assert.equal(start.secret.length, 32);
assert.ok(start.otpauth.startsWith("otpauth://totp/"), "a URL an authenticator can scan");
assert.ok(start.otpauth.includes(start.secret));

assert.equal((await post("/api/admin/2fa/confirm", { code: "000000" }, auth)).status, 400, "a wrong code does not enrol");
const confirmed = await (await post("/api/admin/2fa/confirm", { code: totp(start.secret) }, auth)).json();
assert.equal(confirmed.ok, true);
assert.equal(confirmed.recovery.length, 10, "ten recovery codes, shown once");

// 3. Now the code alone is not enough.
r = await signIn("203.0.113.2");
j = await r.json();
assert.equal(j.kind, "staff-2fa", "the second factor is owed");
assert.ok(j.pending, "with a ticket to redeem it");
assert.equal(j.token, undefined, "and no session yet");

// 4. A wrong six digits is refused; the right ones sign in.
assert.equal((await post("/api/signin/2fa", { pending: j.pending, code: "000000" })).status, 401);
const auth2 = await (await post("/api/signin/2fa", { pending: j.pending, code: totp(start.secret) })).json();
assert.ok(auth2.token, "the second factor completes the sign-in");
assert.equal(auth2.kind, "admin");

// 5. A pending ticket is single use.
assert.equal((await post("/api/signin/2fa", { pending: j.pending, code: totp(start.secret) })).status, 401);
// …and an invented one is refused.
assert.equal((await post("/api/signin/2fa", { pending: "made-up", code: totp(start.secret) })).status, 401);

// 6. A recovery code works once, then never again.
r = await signIn("203.0.113.3");
j = await r.json();
const recovered = await (await post("/api/signin/2fa", { pending: j.pending, code: confirmed.recovery[0] })).json();
assert.ok(recovered.token, "a recovery code stands in for the phone");
assert.equal(recovered.recoveryLeft, 9);

r = await signIn("203.0.113.4");
j = await r.json();
assert.equal(
  (await post("/api/signin/2fa", { pending: j.pending, code: confirmed.recovery[0] })).status,
  401,
  "the same recovery code cannot be used twice",
);

// 7. Nothing admin answers to a first-factor-only sign-in.
r = await signIn("203.0.113.5");
j = await r.json();
for (const path of ["/api/admin/session", "/api/admin/proposals"]) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${j.pending}` } });
  assert.equal(res.status, 401, `${path} does not accept a pending ticket as a session`);
}

// 8. Turning it off returns to a single factor.
assert.equal((await post("/api/admin/2fa/off", {}, { Authorization: `Bearer ${auth2.token}` })).status, 200);
r = await signIn("203.0.113.6");
j = await r.json();
assert.ok(j.token, "with two-factor off, the code signs in again");

console.log("2fa: all assertions passed");
server.kill();

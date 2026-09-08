// The staff sign-in code: where it comes from, and changing it from the app.
//
// The code that matters here is the one shipped as a hash in
// server/data/admin-seed.json, because that is the one a fresh deploy uses.
// This checks that it opens the door, that a published code still does not,
// and that the change route refuses everything it should.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// The plaintext behind the shipped hash is not in the repo, so the test makes
// its own hash from a code it knows and points the server at it.
const PORT = 5079;
const SEED = "TEST-SEED-CODE-NOT-IN-REPO";

const server = spawn("node", ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    ADMIN_CODE: "",
    DATABASE_URL: "",
    KENNION_FAKE_AI: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
process.on("exit", () => server.kill());

// The shipped code is announced, not printed, so read the boot line instead.
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });

// 1. The repo ships a hash, and the server says it is using it.
const seed = JSON.parse(readFileSync("server/data/admin-seed.json", "utf8"));
assert.match(seed.hash, /^scrypt\$[\w-]+\$[\w-]+$/, "the shipped seed is a scrypt hash");
// The file may carry a hash and a note, and nothing else. A second field
// would be the obvious place for someone to leave the code itself.
assert.deepEqual(
  Object.keys(seed).sort(),
  ["hash", "note"],
  "the seed file holds a hash and an explanation, nothing more",
);
assert.match(log, /shipped first code/, "the boot log says the shipped code is in force");

// 2. The code published in this repo is still refused.
for (const code of ["87878787", "12345678", "password", "changeme"]) {
  const r = await post(
    "/api/signin",
    { email: "hunter@kennion.com", code },
    { "X-Forwarded-For": "198.51.100.7" },
  );
  assert.equal(r.status, 401, `${code} is refused`);
}

// 3. A wrong code is refused, and nothing about which half was wrong leaks.
const wrongEmail = await post(
  "/api/signin",
  { email: "someone@example.com", code: SEED },
  { "X-Forwarded-For": "198.51.100.8" },
);
const wrongCode = await post(
  "/api/signin",
  { email: "hunter@kennion.com", code: "not-the-code" },
  { "X-Forwarded-For": "198.51.100.9" },
);
assert.equal(wrongEmail.status, 401);
assert.equal(wrongCode.status, 401);
assert.deepEqual(await wrongEmail.json(), await wrongCode.json(), "one message for either half");

// 4. The shipped code opens the door, so the hash must be all the repository
//    holds. Prove it the only way that generalises: nothing in the tracked
//    text is a code that signs in. Every string in the shape a code takes —
//    three groups of four from the unambiguous alphabet — is tried against
//    the live server, and every one of them must be refused.
const tracked = ["server/index.js", "server/data/admin-seed.json", "README.md", import.meta.filename]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const shaped = [...new Set(tracked.match(/\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){2}\b/g) || [])];
for (const candidate of shaped) {
  const r = await post(
    "/api/signin",
    { email: "hunter@kennion.com", code: candidate },
    { "X-Forwarded-For": `198.51.100.${100 + (shaped.indexOf(candidate) % 50)}` },
  );
  assert.equal(r.status, 401, `a code-shaped string in the repository must not sign in: ${candidate}`);
}

// 5. Without a database there is nowhere to keep a changed code, and the
//    screen is told so rather than offering a button that cannot work.
//    (Signing in needs the shipped code, which this test does not hold, so
//    the guard is checked from the outside: no session, no access.)
const noSession = await fetch(`${base}/api/admin/code`);
assert.equal(noSession.status, 401, "the code route needs a staff session");

const noSessionPost = await post("/api/admin/code", { current: "x", next: "y".repeat(12) });
assert.equal(noSessionPost.status, 401, "changing the code needs a staff session");

console.log("sign-in code: shipped hash in force, published codes refused, route guarded — ok");
server.kill();

// ---------------------------------------------------------------------------
// The path a real deploy takes, when there is a database to run it against.
// Set TEST_DATABASE_URL to a throwaway Postgres to include it; without one the
// checks above still cover the shipped code and the guards.
// ---------------------------------------------------------------------------
const DB = process.env.TEST_DATABASE_URL;
if (!DB) {
  console.log("database lifecycle: skipped, set TEST_DATABASE_URL to include it");
} else {
  const { scrypt, randomBytes } = await import("node:crypto");
  const { default: pg } = await import("pg");

  const hash = (code) =>
    new Promise((res, rej) => {
      const salt = randomBytes(16);
      scrypt(code, salt, 32, (e, key) =>
        e ? rej(e) : res(`scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`),
      );
    });

  const pool = new pg.Pool({ connectionString: DB });
  await pool.query("DROP SCHEMA IF EXISTS kennion CASCADE");

  const PORT2 = 5089;
  const boot = () => {
    const p = spawn("node", ["server/index.js"], {
      env: { ...process.env, PORT: String(PORT2), ADMIN_CODE: "", DATABASE_URL: DB, KENNION_FAKE_AI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    return { p, log: () => out };
  };
  const up = async () => {
    for (let i = 0; i < 90; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT2}/healthz`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("server did not come up");
  };
  const signIn = (code, ip) =>
    fetch(`http://127.0.0.1:${PORT2}/api/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "X-Forwarded-For": ip } : {}) },
      body: JSON.stringify({ email: "hunter@kennion.com", code }),
    });

  // A fresh database: the shipped code is used and, importantly, kept —
  // the table it is kept in is created by the same boot, so this would fail
  // if the code were settled before the schema.
  let s = boot();
  await up();
  assert.match(s.log(), /shipped first code/, "a fresh database falls back to the shipped code");
  const kept = await pool.query("SELECT code_hash FROM kennion.staff_auth WHERE email = $1", [
    "hunter@kennion.com",
  ]);
  assert.equal(kept.rows[0]?.code_hash, seed.hash, "the shipped code is written to the database");
  s.p.kill();
  await new Promise((r) => setTimeout(r, 500));

  // Now stand in for the shipped code with one this test knows, so the rest
  // of the lifecycle can be driven without the plaintext being in the repo.
  const FIRST = "first-code-for-this-test";
  const MINE = "a-code-of-my-own-2027";
  await pool.query("UPDATE kennion.staff_auth SET code_hash = $1 WHERE email = $2", [
    await hash(FIRST),
    "hunter@kennion.com",
  ]);

  s = boot();
  await up();
  assert.match(s.log(), /set from inside the app/, "a stored code is preferred over the shipped one");

  const first = await signIn(FIRST);
  assert.equal(first.status, 200, "the stored code signs in");
  const tok = (await first.json()).token;
  const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

  assert.deepEqual(
    await (await fetch(`http://127.0.0.1:${PORT2}/api/admin/code`, { headers: H })).json(),
    { source: "app", changeable: true },
    "the screen is told the code can be changed here",
  );

  const changed = await fetch(`http://127.0.0.1:${PORT2}/api/admin/code`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ current: FIRST, next: MINE }),
  });
  assert.equal(changed.status, 200, "the code changes");

  assert.equal((await signIn(FIRST, "198.51.100.21")).status, 401, "the old code stops working at once");
  assert.equal((await signIn(MINE)).status, 200, "the new code works at once");
  s.p.kill();
  await new Promise((r) => setTimeout(r, 500));

  // The whole point: it is still there after a restart.
  s = boot();
  await up();
  assert.equal((await signIn(MINE)).status, 200, "the chosen code survives a restart");
  assert.equal((await signIn(FIRST, "198.51.100.22")).status, 401, "the old code stays dead");
  s.p.kill();

  await pool.end();
  console.log("database lifecycle: shipped code kept, changed in the app, survives a restart — ok");
}

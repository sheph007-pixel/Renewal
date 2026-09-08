// The audit round trip: the workbook goes out, comes back with corrections
// keyed into it, and the portal takes them on — or refuses, and says why.
//
// The workbook is built by the very code the button uses and read by the very
// code the upload uses, so this is the real path, not a re-implementation of
// it. Runs with `npx tsx`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import xlsx from "xlsx";
import { buildAuditWorkbook, rowKey, KEY_HEADER } from "../client/src/lib/worksheet.ts";
import { type Group, type Overrides } from "../client/src/lib/model.ts";

const PORT = 5088;
const CODE = "test-only-code-not-in-repo";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, DATABASE_URL: "", KENNION_FAKE_AI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
process.on("exit", () => server.kill());

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const signIn = async () =>
  (
    await fetch(`${base}/api/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }),
    })
  ).json();

let payload = await signIn();
const token = payload.token;
const auth = { Authorization: `Bearer ${token}` };
const groups: Group[] = payload.groups;
const overrides: Overrides = payload.overrides || {};

const send = (buf: Buffer, apply: boolean) =>
  fetch(`${base}/api/admin/rates-workbook?apply=${apply ? 1 : 0}&filename=audit.xlsx`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(buf),
  });

const toBuffer = (book: xlsx.WorkBook): Buffer =>
  xlsx.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;

/** Fill in a Correct column the way an auditor would, by row key. */
function correct(
  book: xlsx.WorkBook,
  edits: Array<{ key: string; column: string; value: string | number }>,
) {
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
    if (!rows.length || !(KEY_HEADER in rows[0])) continue;
    let touched = false;
    for (const row of rows) {
      // Every edit for this row, not just the first: a row can carry a
      // correction in more than one tier.
      for (const hit of edits.filter((e) => e.key === row[KEY_HEADER])) {
        row[hit.column] = hit.value;
        touched = true;
      }
    }
    if (touched) {
      const rebuilt = xlsx.utils.json_to_sheet(rows, { header: Object.keys(rows[0]) });
      book.Sheets[name] = rebuilt;
    }
  }
  return book;
}

// A plan to correct, and the rate it currently carries.
const target = groups.find((g) => (g.plans || []).length && !(g as unknown as { archived?: boolean }).archived)!;
const plan = target.plans![0].plan;
const key = rowKey(target.name, plan);

// 1. An untouched workbook is a no-op. Sending back what was sent out must not
//    invent a single change, whatever Excel did to the formatting.
let book = await buildAuditWorkbook(groups, overrides);
let r = await send(toBuffer(book), false);
let j = await r.json();
assert.equal(r.status, 200);
assert.ok(j.sheetsRead >= 1, "the manager sheets are found");
assert.ok(j.rowsRead > 100, `every row is read: ${j.rowsRead}`);
assert.deepEqual(j.changes, [], "an untouched workbook changes nothing");
assert.deepEqual(j.problems, [], "and reports no problems");

// 2. A correction is read, reported against what was there, and not yet applied.
book = correct(await buildAuditWorkbook(groups, overrides), [
  { key, column: "Correct Employee", value: 123.45 },
]);
r = await send(toBuffer(book), false);
j = await r.json();
assert.equal(j.changes.length, 1, "one correction read");
assert.equal(j.changes[0].group, target.name);
assert.equal(j.changes[0].plan, plan);
assert.equal(j.changes[0].censusTier, "Employee");
assert.equal(j.changes[0].rate, 123.45);
assert.equal(j.applied, false, "reading does not write");

const stillClean = await (await fetch(`${base}/api/admin/rates-lock`, { headers: auth })).json();
assert.equal(stillClean.locked, false, "rates start unlocked");
payload = await signIn();
assert.equal(payload.overrides[`${target.name}||${plan}||Employee`], undefined, "nothing written yet");

// 3. Money as a person types it: "$1,234.56" is a rate, "n/a" is not.
book = correct(await buildAuditWorkbook(groups, overrides), [
  { key, column: "Correct Employee", value: "$1,234.56" },
  { key, column: "Correct Employee + Family", value: "n/a" },
]);
j = await (await send(toBuffer(book), false)).json();
assert.equal(j.changes.length, 1, "the money string is read as a rate");
assert.equal(j.changes[0].rate, 1234.56);
assert.equal(j.problems.length, 1, "the unreadable one is reported, not guessed at");
assert.match(j.problems[0].reason, /not a rate/);

// 4. A rate of zero or less is refused rather than written.
book = correct(await buildAuditWorkbook(groups, overrides), [
  { key, column: "Correct Employee", value: 0 },
]);
j = await (await send(toBuffer(book), false)).json();
assert.equal(j.changes.length, 0);
assert.equal(j.problems.length, 1);
assert.match(j.problems[0].reason, /more than zero/);

// 5. Applying writes it, and the portal serves the new rate.
book = correct(await buildAuditWorkbook(groups, overrides), [
  { key, column: "Correct Employee", value: 123.45 },
]);
j = await (await send(toBuffer(book), true)).json();
assert.equal(j.applied, true);
assert.equal(j.appliedCount, 1, "one correction applied");
assert.deepEqual(j.failed, [], "none failed");
payload = await signIn();
assert.equal(
  payload.overrides[`${target.name}||${plan}||Employee`],
  "123.45",
  "the corrected rate is on file",
);

// 6. Sending the same workbook again is not a second change: the rate now
//    matches what is on file, so there is nothing to do.
book = correct(await buildAuditWorkbook(payload.groups, payload.overrides), [
  { key, column: "Correct Employee", value: 123.45 },
]);
j = await (await send(toBuffer(book), false)).json();
assert.deepEqual(j.changes, [], "re-sending the same corrections is a no-op");

// 7. A file that is not the audit workbook is refused with something useful.
const stranger = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(stranger, xlsx.utils.aoa_to_sheet([["Group", "Rate"], ["Someone", 10]]), "Sheet1");
r = await send(toBuffer(stranger), false);
assert.equal(r.status, 400);
assert.match((await r.json()).error, /Row Key/, "the error says what is missing");

// 8. Locking. With the rates locked nothing lands — not the workbook, not a
//    single override by hand — and both say so with 423 rather than pretending.
let lock = await (
  await fetch(`${base}/api/admin/rates-lock`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ locked: true }),
  })
).json();
assert.equal(lock.locked, true);
assert.ok(lock.at, "the lock records when");

book = correct(await buildAuditWorkbook(payload.groups, payload.overrides), [
  { key, column: "Correct Employee", value: 999.99 },
]);
r = await send(toBuffer(book), true);
assert.equal(r.status, 423, "a locked portal refuses the workbook");

const byHand = await fetch(`${base}/api/admin/override`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ group: target.name, plan, censusTier: "Employee", rate: 555 }),
});
assert.equal(byHand.status, 423, "a locked portal refuses a rate keyed by hand");

payload = await signIn();
assert.equal(
  payload.overrides[`${target.name}||${plan}||Employee`],
  "123.45",
  "and the audited rate is untouched",
);

// 9. Reading a workbook while locked is still allowed — seeing what would
//    change is not changing anything.
r = await send(toBuffer(book), false);
assert.equal(r.status, 200, "a locked portal will still tell you what would change");
assert.equal((await r.json()).changes.length, 1);

// 10. Unlocking lets work resume.
lock = await (
  await fetch(`${base}/api/admin/rates-lock`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ locked: false }),
  })
).json();
assert.equal(lock.locked, false);
r = await send(toBuffer(book), true);
assert.equal(r.status, 200, "and the workbook lands again");
assert.equal((await r.json()).appliedCount, 1);

console.log(
  "rates audit: workbook out, corrections back, money strings read, bad rates refused, lock holds — ok",
);
server.kill();

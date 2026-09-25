// The nightly backup (server/backup.js), end to end against a real Postgres:
// every table of the app's schema - proposals with their original file
// bytes and readings, audit jobs that reference them, settings - backed up
// to a folder, restored into a second, empty database, and compared row for
// row; serial ids continue after the restored ones; a folder without a
// manifest is never restored; old backups are pruned.
//
//   BACKUP_TEST_SRC=postgres://…/src BACKUP_TEST_DST=postgres://…/dst node scripts/test-backup.mjs
// Skipped (exit 0) when the two URLs are not set.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createDb } from "../server/db.js";
import { dirStore, runBackup, restoreBackup, listBackups, pruneBackups } from "../server/backup.js";

const SRC = process.env.BACKUP_TEST_SRC;
const DST = process.env.BACKUP_TEST_DST;
if (!SRC || !DST) {
  console.log("backup: skipped (set BACKUP_TEST_SRC and BACKUP_TEST_DST to two empty Postgres databases)");
  process.exit(0);
}
const pool = (url) => new pg.Pool({ connectionString: url, max: 2, ssl: false });
const quiet = () => undefined;

// A source database with the app's own schema and data in it.
const src = createDb(SRC);
await src.init();
const file = crypto.randomBytes(200_000); // a PDF's worth of bytes, not text
const id = await src.addProposal({ group_name: "Acme Co", carrier: "UnitedHealthcare", filename: "Acme UHC LF.pdf", mime: "application/pdf", size: file.length, data: file, status: "assigned" });
const pid = typeof id === "object" ? id.id : id;
await src.updateProposal(pid, { extracted: { plans: [{ name: "EZ18 Open Access", plan_code: "EZ18", rates: { EE: 612.45, ES: 1300.1, EC: 1100, FAM: 1800 }, benefits: { rx: "$10 / $40 / $80 / 20% after deductible" } }], note: "quotes \" and \\ back\\slashes, tabs\tand\nnewlines" }, slot: "UHC Level Funded" });
await src.saveAuditJob(pid, "claude:doc", { key: "k1", answer: { verdict: "pass" } });
await src.setSetting("backup.test", { ok: true, list: [1, 2, 3] }, "test");
const sp = pool(SRC);
const before = async (p) => {
  const tables = (await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema='kennion' AND table_type='BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name);
  const out = {};
  for (const t of tables) {
    const { rows } = await p.query(`SELECT md5(coalesce(string_agg(md5(x::text), ',' ORDER BY md5(x::text)), '')) AS h, count(*)::int AS n FROM kennion."${t}" x`);
    out[t] = rows[0];
  }
  return out;
};
const srcState = await before(sp);
assert.equal(srcState.proposals.n, 1);
assert.equal(srcState.proposal_audit_jobs.n, 1);

// Back up to a folder standing in for the bucket.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
const store = dirStore(dir);
const m = await runBackup({ pool: sp, store, stamp: "2026-09-26", log: quiet });
assert.equal(m.tables.find((t) => t.table === "proposals").rows, 1);
assert.ok(m.tables.length >= 20, `every table backed up (${m.tables.length})`);
assert.deepEqual(await listBackups(store), ["2026-09-26"]);

// Restore into an empty database: identical, row for row, bytes included.
const dp = pool(DST);
const dst = createDb(DST);
await restoreBackup({ pool: dp, store, stamp: "2026-09-26", init: () => dst.init(), log: quiet });
const dstState = await before(dp);
for (const t of Object.keys(srcState)) assert.deepEqual(dstState[t], srcState[t], `${t} restored exactly`);
const back = await dst.getProposalFile(pid);
assert.ok(Buffer.from(back.data).equals(file), "the original file's bytes come back exactly");
// New rows continue after the restored ids.
const next = await dst.addProposal({ group_name: "Acme Co", carrier: "Gravie", filename: "g.xlsx", mime: "application/vnd.ms-excel", size: 1, data: Buffer.from("x"), status: "assigned" });
assert.ok(Number(typeof next === "object" ? next.id : next) > Number(pid), "serial ids continue after the restored ones");

// Restoring again over data replaces it (no duplicates).
await restoreBackup({ pool: dp, store, stamp: "2026-09-26", init: () => dst.init(), log: quiet });
assert.deepEqual((await before(dp)).proposals, srcState.proposals);

// A folder without a manifest is an unfinished run: not listed, not restorable.
fs.mkdirSync(path.join(dir, "backups", "2026-09-27"), { recursive: true });
fs.writeFileSync(path.join(dir, "backups", "2026-09-27", "proposals.copy.gz"), "partial");
assert.deepEqual(await listBackups(store), ["2026-09-26"]);
await assert.rejects(restoreBackup({ pool: dp, store, stamp: "2026-09-27", log: quiet }));

// Pruning keeps the newest N finished backups.
await runBackup({ pool: sp, store, stamp: "2026-09-28", log: quiet });
await runBackup({ pool: sp, store, stamp: "2026-09-29", log: quiet });
const gone = await pruneBackups(store, 2, quiet);
assert.deepEqual(await listBackups(store), ["2026-09-29", "2026-09-28"]);
assert.ok(gone.includes("2026-09-26") && gone.includes("2026-09-27"));

await sp.end();
await dp.end();
if (src.close) await src.close();
if (dst.close) await dst.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`backup: ${m.tables.length} tables backed up and restored row for row (file bytes, JSON, foreign keys, serial ids), unfinished runs ignored, old backups pruned - ok`);

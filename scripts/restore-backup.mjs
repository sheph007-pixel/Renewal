// Put a nightly backup (server/backup.js) back into a database.
//
//   S3_BUCKET=… S3_ENDPOINT=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
//   DATABASE_URL=postgres://… node scripts/restore-backup.mjs --list
//       the backups in the bucket, newest first
//
//   … node scripts/restore-backup.mjs --date 2026-09-26 --yes
//       restore that night's backup into DATABASE_URL: the app's tables are
//       created if missing, then EVERY TABLE IN THE BACKUP IS EMPTIED and
//       loaded from it. Without --yes nothing is changed.
//
//   --dir ./backup-copy   read from a downloaded copy of the bucket's
//                         backups/ folder instead of the bucket
//
// Safest: restore into a new, empty Postgres first, check it, then point the
// app's DATABASE_URL at it.
import pg from "pg";
import { createDb } from "../server/db.js";
import { s3Store, dirStore, listBackups, restoreBackup } from "../server/backup.js";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(name);

const store = arg("--dir") ? dirStore(arg("--dir")) : s3Store();
if (!store) {
  console.error("No bucket: set S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or pass --dir.");
  process.exit(1);
}
const backups = await listBackups(store);
if (has("--list") || !arg("--date")) {
  console.log(backups.length ? `Backups in ${store.name}, newest first:\n${backups.join("\n")}` : `No finished backups in ${store.name}.`);
  process.exit(0);
}
const stamp = arg("--date");
if (!backups.includes(stamp)) {
  console.error(`No finished backup for ${stamp}. Run with --list to see them.`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the database to restore into.");
  process.exit(1);
}
if (!has("--yes")) {
  console.error(`This empties every table in the backup in ${url.replace(/\/\/[^@]*@/, "//…@")} and loads ${stamp}. Run again with --yes to go ahead.`);
  process.exit(1);
}
const ssl = /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? false : { rejectUnauthorized: false };
const pool = new pg.Pool({ connectionString: url, max: 1, ssl });
const db = createDb(url);
try {
  await restoreBackup({ pool, store, stamp, init: () => db.init() });
} finally {
  await pool.end();
  if (db.close) await db.close();
}
process.exit(0);

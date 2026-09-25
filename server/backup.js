// Nightly backup of the whole database to the Railway storage bucket.
//
// The Railway plan BenSync runs on keeps no volume backups, so the app keeps
// its own: every table in the kennion schema - proposals and their original
// files, plans, rates, audits, settings, everything - is exported with
// Postgres's own COPY format, gzipped, and put in the bucket under
// backups/<yyyy-mm-dd>/, with a manifest naming each table, its columns and
// its row count. The last BACKUP_KEEP_DAYS nights are kept. A run starts at
// boot when the newest backup is older than a day, and is checked hourly.
//
// Restore (scripts/restore-backup.mjs) creates the tables the app's own
// schema creates, then COPYs each table back in by its named columns.
//
// Nothing here writes to the database except the one settings row that
// records the last run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { to as copyTo, from as copyFrom } from "pg-copy-streams";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

export const SCHEMA_NAME = "kennion";
export const BACKUP_PREFIX = "backups/";
export const BACKUP_KEEP_DAYS = Number(process.env.KENNION_BACKUP_KEEP_DAYS || 14);
const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** The bucket BenSync already uses (server/inbox.js), or null when none is configured. */
export function s3Store(env = process.env) {
  if (!env.S3_BUCKET) return null;
  const s3 = new S3Client({
    region: env.S3_REGION || "auto",
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  const Bucket = env.S3_BUCKET;
  return {
    name: `bucket ${Bucket}`,
    async putFile(key, file) {
      const { size } = await fs.promises.stat(file);
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: fs.createReadStream(file), ContentLength: size }));
    },
    async putText(key, text) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: text, ContentType: "application/json" }));
    },
    async getStream(key) {
      return (await s3.send(new GetObjectCommand({ Bucket, Key: key }))).Body;
    },
    async list(prefix) {
      const out = [];
      let token;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents || []) out.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
      }
    },
  };
}

/** A directory standing in for the bucket: tests, and a restore from a downloaded copy. */
export function dirStore(dir) {
  const at = (key) => path.join(dir, key);
  return {
    name: `folder ${dir}`,
    async putFile(key, file) {
      await fs.promises.mkdir(path.dirname(at(key)), { recursive: true });
      await fs.promises.copyFile(file, at(key));
    },
    async putText(key, text) {
      await fs.promises.mkdir(path.dirname(at(key)), { recursive: true });
      await fs.promises.writeFile(at(key), text);
    },
    async getStream(key) {
      return fs.createReadStream(at(key));
    },
    async list(prefix) {
      const out = [];
      const walk = async (d) => {
        for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else out.push(path.relative(dir, p).split(path.sep).join("/"));
        }
      };
      await walk(dir);
      return out.filter((k) => k.startsWith(prefix)).sort();
    },
    async remove(keys) {
      for (const k of keys) await fs.promises.rm(at(k), { force: true });
    },
  };
}

/** Every table in the schema, with its columns in order. */
async function tablesOf(client) {
  const { rows } = await client.query(
    `SELECT c.table_name, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
      GROUP BY c.table_name ORDER BY c.table_name`,
    [SCHEMA_NAME],
  );
  return rows.map((r) => ({ table: r.table_name, columns: r.columns }));
}

/**
 * One backup: every table to `backups/<stamp>/<table>.copy.gz`, then the
 * manifest last - a folder without a manifest is an unfinished run and is
 * never restored from. `pool` is a pg.Pool; `store` is s3Store / dirStore.
 */
export async function runBackup({ pool, store, stamp = new Date().toISOString().slice(0, 10), log = console.log }) {
  const started = Date.now();
  const folder = `${BACKUP_PREFIX}${stamp}/`;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bensync-backup-"));
  const client = await pool.connect();
  const tables = [];
  try {
    // One snapshot for every table, so the files agree with one another.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const { table, columns } of await tablesOf(client)) {
      const cols = columns.map(quoteIdent).join(", ");
      const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${SCHEMA_NAME}.${quoteIdent(table)}`);
      const file = path.join(tmp, `${table}.copy.gz`);
      await pipeline(client.query(copyTo(`COPY ${SCHEMA_NAME}.${quoteIdent(table)} (${cols}) TO STDOUT`)), zlib.createGzip(), fs.createWriteStream(file));
      const { size } = await fs.promises.stat(file);
      await store.putFile(`${folder}${table}.copy.gz`, file);
      await fs.promises.rm(file, { force: true });
      tables.push({ table, columns, rows: Number(rows[0].n), bytes: size });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
  const manifest = { version: 1, schema: SCHEMA_NAME, stamp, at: new Date().toISOString(), tables, rows: tables.reduce((n, t) => n + t.rows, 0), bytes: tables.reduce((n, t) => n + t.bytes, 0), seconds: Math.round((Date.now() - started) / 1000) };
  await store.putText(`${folder}manifest.json`, JSON.stringify(manifest, null, 2));
  log(`backup: ${tables.length} tables, ${manifest.rows} rows, ${(manifest.bytes / 1e6).toFixed(1)} MB gzipped to ${store.name} ${folder} in ${manifest.seconds}s`);
  return manifest;
}

/** The dated folders that hold a finished backup (a manifest), newest first. */
export async function listBackups(store) {
  const keys = await store.list(BACKUP_PREFIX);
  return [...new Set(keys.filter((k) => k.endsWith("/manifest.json")).map((k) => k.slice(BACKUP_PREFIX.length).split("/")[0]))].sort().reverse();
}

/** Keep the newest `keep` finished backups; remove older folders (finished or not). */
export async function pruneBackups(store, keep = BACKUP_KEEP_DAYS, log = console.log) {
  const finished = await listBackups(store);
  if (finished.length <= keep) return [];
  const oldestKept = finished[keep - 1];
  const keys = (await store.list(BACKUP_PREFIX)).filter((k) => k.slice(BACKUP_PREFIX.length).split("/")[0] < oldestKept);
  if (keys.length) await store.remove(keys);
  const gone = [...new Set(keys.map((k) => k.slice(BACKUP_PREFIX.length).split("/")[0]))];
  if (gone.length) log(`backup: removed ${gone.length} backup(s) older than the newest ${keep}: ${gone.join(", ")}`);
  return gone;
}

/** The tables ordered so each comes after every table its foreign keys reference. */
async function parentsFirst(client, tables) {
  const { rows } = await client.query(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_class p ON p.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND n.nspname = $1 AND c.relname <> p.relname`,
    [SCHEMA_NAME],
  );
  const parents = new Map();
  for (const r of rows) parents.set(r.child, [...(parents.get(r.child) || []), r.parent]);
  const byName = new Map(tables.map((t) => [t.table, t]));
  const out = [];
  const seen = new Set();
  const visit = (name, depth = 0) => {
    if (seen.has(name) || !byName.has(name) || depth > tables.length) return;
    for (const p of parents.get(name) || []) visit(p, depth + 1);
    seen.add(name);
    out.push(byName.get(name));
  };
  for (const t of tables) visit(t.table);
  return out;
}

async function readJson(store, key) {
  const chunks = [];
  for await (const c of await store.getStream(key)) chunks.push(Buffer.from(c));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Put a backup back into a database. `init` creates the tables (the app's
 * own schema - db.init()). In one transaction, every table in the backup is
 * emptied and COPYed back by its named columns - a table before the tables
 * whose foreign keys point at it - and each serial id sequence is moved
 * past the highest id restored. Refuses a folder without a manifest.
 */
export async function restoreBackup({ pool, store, stamp, init, log = console.log }) {
  const manifest = await readJson(store, `${BACKUP_PREFIX}${stamp}/manifest.json`);
  if (init) await init();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const names = manifest.tables.map((t) => `${SCHEMA_NAME}.${quoteIdent(t.table)}`).join(", ");
    await client.query(`TRUNCATE ${names} CASCADE`);
    for (const t of await parentsFirst(client, manifest.tables)) {
      const cols = t.columns.map(quoteIdent).join(", ");
      const src = await store.getStream(`${BACKUP_PREFIX}${stamp}/${t.table}.copy.gz`);
      await pipeline(src, zlib.createGunzip(), client.query(copyFrom(`COPY ${SCHEMA_NAME}.${quoteIdent(t.table)} (${cols}) FROM STDIN`)));
      const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${SCHEMA_NAME}.${quoteIdent(t.table)}`);
      if (Number(rows[0].n) !== t.rows) throw new Error(`${t.table}: restored ${rows[0].n} rows, the backup holds ${t.rows}`);
    }
    // Serial ids continue after the highest restored.
    const { rows: seqs } = await client.query(
      `SELECT table_name, column_name, pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS seq
         FROM information_schema.columns WHERE table_schema = $1 AND column_default LIKE 'nextval(%'`,
      [SCHEMA_NAME],
    );
    for (const s of seqs) {
      if (!s.seq) continue;
      await client.query(`SELECT setval($1, COALESCE((SELECT max(${quoteIdent(s.column_name)}) FROM ${SCHEMA_NAME}.${quoteIdent(s.table_name)}), 0) + 1, false)`, [s.seq]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  log(`restore: ${manifest.tables.length} tables, ${manifest.rows} rows from ${store.name} ${BACKUP_PREFIX}${stamp}/`);
  return manifest;
}

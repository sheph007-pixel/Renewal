// A private inbox: files the app ingests at boot, from a Railway storage
// bucket or from a URL. Anything too large or too binary to travel through a
// chat or an env var — a zip of client invoices, a carrier report — is put
// where the app can fetch it, and it lands in Postgres on the next boot with
// INBOX_INGEST set.
//
//   INBOX_PRESIGN=inbox/a.zip,inbox/b.xls   log a presigned bucket PUT URL per key (one hour)
//   INBOX_PUBKEY=1                          log the inbox public key (see envelope below)
//   INBOX_INGEST=inbox/a.zip,https://…/b.xls.enc
//                                           fetch each entry (bucket key or URL) and ingest it
//   INBOX_MONTH=2026-09                     the invoice month for any zip ingested
//
// Files may be sealed to the app: an ".enc" entry is a KBA1 envelope, a
// random AES-256-GCM key wrapped with RSA-OAEP to the app's public key. The
// private key lives only in kennion.settings, so the ciphertext can sit
// anywhere public for the minute it takes the app to fetch it.
import crypto from "node:crypto";
import pg from "pg";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function client() {
  if (!process.env.S3_BUCKET) return null;
  return new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
}

const keys = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

// ---- settings (the key pair) ---------------------------------------------

let pool = null;
function settingsPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  return pool;
}

async function getSetting(key) {
  const p = settingsPool();
  if (!p) return null;
  const { rows } = await p.query("SELECT value FROM kennion.settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value, by) {
  const p = settingsPool();
  if (!p) return;
  await p.query(
    `INSERT INTO kennion.settings (key, value, updated_at, updated_by)
     VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), by || null],
  );
}

/**
 * The app's inbox key pair, made once and kept in settings. Returns the
 * record ({ publicKey, privateKey } PEMs) or null without a database.
 */
export async function ensureInboxKey() {
  if (!settingsPool()) return null;
  let rec = await getSetting("inboxKey");
  if (!rec || !rec.privateKey) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    rec = { publicKey, privateKey, createdAt: new Date().toISOString() };
    await setSetting("inboxKey", rec, "system");
  }
  return rec;
}

/**
 * Print a one-hour upload URL for each key in INBOX_PRESIGN, and the inbox
 * public key (one base64 line of SPKI DER) when INBOX_PUBKEY is set.
 */
export async function logPresignedUploads() {
  if (process.env.INBOX_PUBKEY) {
    try {
      const rec = await ensureInboxKey();
      if (rec) {
        const der = crypto.createPublicKey(rec.publicKey).export({ type: "spki", format: "der" });
        console.log(`[inbox] PUBLIC KEY ${der.toString("base64")}`);
      }
    } catch (e) {
      console.log(`[inbox] key: FAILED ${e.message}`);
    }
  }
  const s3 = client();
  const list = keys(process.env.INBOX_PRESIGN);
  if (!s3 || !list.length) return;
  for (const Key of list) {
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key }), { expiresIn: 3600 });
    console.log(`[inbox] PUT ${Key}\n${url}`);
  }
}

/** Fetch one entry as a Buffer: a URL, or a key in the bucket. */
export async function fetchEntry(entry) {
  if (/^https?:\/\//.test(entry)) {
    const r = await fetch(entry);
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${entry}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const s3 = client();
  if (!s3) throw new Error("no bucket configured");
  const r = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: entry }));
  return Buffer.from(await r.Body.transformToByteArray());
}

/** Keep a copy of an ingested file in the bucket, if there is one. */
export async function archiveToBucket(name, buf) {
  const s3 = client();
  if (!s3) return false;
  await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `archive/${name}`, Body: buf }));
  return true;
}

// ---- sealed envelope -------------------------------------------------------

const MAGIC = Buffer.from("KBA1");

/** Seal a file to a public key (SPKI PEM or base64 DER). */
export function seal(buf, publicKey) {
  const pub =
    typeof publicKey === "string" && !publicKey.includes("-----")
      ? crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
      : crypto.createPublicKey(publicKey);
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const wrapped = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(wrapped.length);
  return Buffer.concat([MAGIC, len, wrapped, iv, c.getAuthTag(), body]);
}

/** Open a sealed envelope with the private key (PKCS8 PEM). */
export function open(env, privateKeyPem) {
  if (!env.subarray(0, 4).equals(MAGIC)) throw new Error("not a sealed inbox file");
  const wl = env.readUInt16BE(4);
  const wrapped = env.subarray(6, 6 + wl);
  const iv = env.subarray(6 + wl, 18 + wl);
  const tag = env.subarray(18 + wl, 34 + wl);
  const body = env.subarray(34 + wl);
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

/**
 * Ingest every entry in INBOX_INGEST. `handlers` maps a file extension to an
 * async (buf, filename) => summary; each result is logged, never thrown.
 */
export async function ingestInbox(handlers) {
  const list = keys(process.env.INBOX_INGEST);
  if (!list.length) return;
  let privateKeyPem = null;
  for (const entry of list) {
    let name = decodeURIComponent(entry.split("?")[0].split("/").pop() || entry);
    try {
      let buf = await fetchEntry(entry);
      if (/\.enc$/i.test(name)) {
        if (!privateKeyPem) privateKeyPem = (await ensureInboxKey())?.privateKey || null;
        if (!privateKeyPem) throw new Error("sealed file but no inbox key");
        buf = open(buf, privateKeyPem);
        name = name.replace(/\.enc$/i, "");
      }
      const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
      const handler = handlers[ext];
      if (!handler) {
        console.log(`[inbox] ${name}: no handler for .${ext}`);
        continue;
      }
      const summary = await handler(buf, name);
      const archived = await archiveToBucket(name, buf).catch((e) => `archive failed: ${e.message}`);
      console.log(`[inbox] ${name}: ${buf.length} bytes -> ${JSON.stringify(summary)} (archived: ${archived})`);
    } catch (e) {
      console.log(`[inbox] ${name}: FAILED ${e.message}`);
    }
  }
}

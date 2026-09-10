// A private inbox: a Railway storage bucket the app reads files from at boot.
// Anything too large or too binary to travel through a chat or an env var —
// a zip of client invoices, a carrier report — is put in the bucket and the
// app ingests it into Postgres the next time it starts with INBOX_INGEST set.
//
//   INBOX_PRESIGN=inbox/a.zip,inbox/b.xls   log a presigned PUT URL per key (valid one hour)
//   INBOX_INGEST=inbox/a.zip,inbox/b.xls    fetch each key and hand it to the ingester
//   INBOX_MONTH=2026-09                     the invoice month for any zip ingested
//
// Nothing here runs unless S3_BUCKET is set.
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

/** Print a one-hour upload URL for each key in INBOX_PRESIGN. */
export async function logPresignedUploads() {
  const s3 = client();
  const list = keys(process.env.INBOX_PRESIGN);
  if (!s3 || !list.length) return;
  for (const Key of list) {
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key }), { expiresIn: 3600 });
    console.log(`[inbox] PUT ${Key}\n${url}`);
  }
}

/** Fetch one object as a Buffer. */
export async function fetchObject(Key) {
  const s3 = client();
  const r = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

/**
 * Ingest every key in INBOX_INGEST. `handlers` maps a file extension to an
 * async (buf, filename) => summary; each result is logged, never thrown.
 */
export async function ingestInbox(handlers) {
  const s3 = client();
  const list = keys(process.env.INBOX_INGEST);
  if (!s3 || !list.length) return;
  for (const Key of list) {
    const base = Key.split("/").pop() || Key;
    const ext = (base.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
    const handler = handlers[ext];
    if (!handler) {
      console.log(`[inbox] ${Key}: no handler for .${ext}`);
      continue;
    }
    try {
      const buf = await fetchObject(Key);
      const summary = await handler(buf, base);
      console.log(`[inbox] ${Key}: ${buf.length} bytes -> ${JSON.stringify(summary)}`);
    } catch (e) {
      console.log(`[inbox] ${Key}: FAILED ${e.message}`);
    }
  }
}

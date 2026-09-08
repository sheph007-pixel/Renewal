// Time-based one-time passwords (RFC 6238) and single-use recovery codes, on
// node's own crypto — no dependency, and no secret ever leaves the server.
//
// A staff member scans the otpauth URL into Google Authenticator, 1Password,
// Authy or the like; the app then asks for the six digits after the sign-in
// code, so a leaked code alone opens nothing.
import crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 (RFC 4648, no padding) — the encoding authenticator apps expect. */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret: 20 bytes, the length RFC 4226 recommends for HMAC-SHA1. */
export const newSecret = () => base32Encode(crypto.randomBytes(20));

/**
 * The code for one time step. `t0` is the Unix time in seconds; the counter is
 * that divided by the step, big-endian over eight bytes.
 */
export function totp(secret, t0 = Math.floor(Date.now() / 1000), step = 30, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t0 / step)));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  // Dynamic truncation: the low nibble of the last byte picks the offset.
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Is this what the authenticator is showing? One step either side is allowed,
 * for clocks that drift and for a code typed as it turns over.
 */
export function verifyTotp(secret, code, { at = Date.now() / 1000, window = 1, step = 30 } = {}) {
  const given = String(code || "").replace(/\D/g, "");
  if (given.length !== 6) return false;
  for (let i = -window; i <= window; i++) {
    const expected = totp(secret, Math.floor(at) + i * step, step);
    // Constant time, so a near-miss is not distinguishable by how long it took.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return true;
  }
  return false;
}

/** The URL an authenticator app scans. Neither issuer nor label is a secret. */
export const otpauthUrl = (secret, account, issuer = "Kennion Renewal Portal") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/**
 * Recovery codes, for a lost phone. Ten of them, shown once and stored only as
 * hashes, so the list in the database is no use to anyone who reads it.
 */
export function newRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export const hashCode = (code) =>
  crypto.createHash("sha256").update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

/** Spend a recovery code: returns the remaining hashes, or null if it was not one. */
export function spendRecovery(hashes, code) {
  const h = hashCode(code);
  if (!hashes.includes(h)) return null;
  return hashes.filter((x) => x !== h);
}

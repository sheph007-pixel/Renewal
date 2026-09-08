// TOTP against the RFC 6238 test vectors, plus the recovery codes.
import assert from "node:assert/strict";
import { base32Encode, base32Decode, totp, verifyTotp, newSecret, otpauthUrl, newRecoveryCodes, hashCode, spendRecovery } from "../server/totp.js";

// RFC 4648 base32 round trip.
const hello = Buffer.from("Hello!\xDE\xAD\xBE\xEF", "binary");
assert.equal(base32Encode(hello), "JBSWY3DPEHPK3PXP");
assert.equal(base32Decode("JBSWY3DPEHPK3PXP").toString("hex"), hello.toString("hex"));

// RFC 6238 appendix B: seed "12345678901234567890" (ASCII), SHA-1, 8 digits.
// Checked here at 6 digits, which is what authenticator apps show.
const seed = base32Encode(Buffer.from("12345678901234567890"));
assert.equal(totp(seed, 59), "287082");
assert.equal(totp(seed, 1111111109), "081804");
assert.equal(totp(seed, 1111111111), "050471");
assert.equal(totp(seed, 1234567890), "005924");
assert.equal(totp(seed, 2000000000), "279037");

// Verification allows one step either side, and nothing else.
assert.equal(verifyTotp(seed, "050471", { at: 1111111111 }), true);
assert.equal(verifyTotp(seed, "050471", { at: 1111111111 + 30 }), true, "one step late still passes");
assert.equal(verifyTotp(seed, "050471", { at: 1111111111 - 30 }), true, "one step early still passes");
assert.equal(verifyTotp(seed, "050471", { at: 1111111111 + 120 }), false, "four steps late does not");
assert.equal(verifyTotp(seed, "000000", { at: 1111111111 }), false);
assert.equal(verifyTotp(seed, "5047", { at: 1111111111 }), false, "a short code is not padded into a match");
assert.equal(verifyTotp(seed, "", { at: 1111111111 }), false);
assert.equal(verifyTotp(seed, null, { at: 1111111111 }), false);

// A fresh secret is 32 base32 characters (20 bytes) and works end to end.
const s = newSecret();
assert.equal(s.length, 32);
assert.equal(verifyTotp(s, totp(s)), true);
assert.ok(otpauthUrl(s, "hunter@kennion.com").startsWith("otpauth://totp/Kennion%20Renewal%20Portal:hunter%40kennion.com?secret=" + s));

// Recovery codes: ten, single use, stored only as hashes.
const codes = newRecoveryCodes();
assert.equal(codes.length, 10);
assert.equal(new Set(codes).size, 10, "no duplicates");
let hashes = codes.map(hashCode);
assert.ok(!hashes.includes(codes[0]), "the code itself is never stored");
const left = spendRecovery(hashes, codes[3]);
assert.equal(left.length, 9, "spending one leaves nine");
assert.equal(spendRecovery(left, codes[3]), null, "and it cannot be spent twice");
assert.equal(spendRecovery(hashes, "AAAAA-BBBBB"), null, "an invented code is refused");
assert.deepEqual(
  spendRecovery(hashes, codes[3].toLowerCase().replace("-", " ")),
  left,
  "case and punctuation are forgiven",
);

console.log("totp: all assertions passed");

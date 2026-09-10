// Seal a file to the app's inbox public key, so it can sit anywhere public
// (a bucket, a paste, a URL) until the app fetches it at boot.
//
//   node scripts/inbox-seal.mjs <public key base64|pem file> <in> [out]
//
// The public key is the one line the app logs at boot as "[inbox] PUBLIC KEY".
// The output is <in>.enc unless given; the app strips ".enc" and ingests the
// file by its remaining extension (.zip, .xls, .xlsx).
import fs from "node:fs";
import { seal, open } from "../server/inbox.js";

const [keyArg, input, output] = process.argv.slice(2);
if (!keyArg || !input) {
  console.error("usage: node scripts/inbox-seal.mjs <public key base64|pem file> <in> [out]");
  process.exit(2);
}
const pub = fs.existsSync(keyArg) ? fs.readFileSync(keyArg, "utf8") : keyArg;
const buf = fs.readFileSync(input);
const env = seal(buf, pub);
const out = output || `${input}.enc`;
fs.writeFileSync(out, env);
console.log(`${out}: ${buf.length} -> ${env.length} bytes`);
export { open };

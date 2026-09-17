// The rule: nothing the app shows or writes uses an em dash, an en dash or
// a minus sign; a comma, a colon, a period or a plain hyphen instead. The
// PDFs' standard fonts print them as boxes, and the client asked for none.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".mts", ".css", ".html", ".json"]);
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ([...EXT].some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
};
const files = [...walk("client/src"), ...walk("server"), ...walk("scripts"), "client/index.html"];
// Built from code points so this file stays clean itself.
const DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013, 0x2212)}]`);
const bad = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (DASHES.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
  });
}
if (bad.length) {
  console.error(`em dash / en dash / minus sign found in ${bad.length} line(s):\n` + bad.join("\n"));
  process.exit(1);
}
console.log(`no em dash: ${files.length} files clean`);

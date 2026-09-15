// Get Plan Recommendations: the assistant is handed the group's census as
// aggregates only — average age, range, age bands, dependants — never a
// name or one person's age; its instructions carry the Lower Cost / Best
// Fit / Richer Benefits rule; and the page's request goes through the chat
// like any other question and is answered in a new conversation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 5093;
const CODE = "recs-test-code";
const server = spawn("node", ["server/index.js"], { env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => server.kill();
process.on("exit", stop);
server.stderr.on("data", (d) => process.stderr.write(d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const json = { "Content-Type": "application/json" };
const staff = await (await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ email: "hunter@kennion.com", code: CODE }) })).json();
const auth = { Authorization: `Bearer ${staff.token}` };
const data = JSON.parse(readFileSync(new URL("../server/data/kennion.json", import.meta.url), "utf8"));
const g = data.groups.find((x) => Array.isArray(x.members) && x.members.length >= 5);
assert.ok(g, "a group with a census");

// The briefing: aggregates, matching the census file, and nobody named.
const { briefing } = await (await fetch(`${base}/api/admin/data-audit/${encodeURIComponent(g.name)}`, { headers: auth })).json();
const ages = g.members.map((m) => Number(m.age)).filter((a) => a > 0);
const avg = Math.round(ages.reduce((s, a) => s + a, 0) / ages.length);
assert.match(briefing, new RegExp(`Census profile \\(aggregates[^\\n]*${ages.length} enrolled employees, average age ${avg}, median \\d+, youngest ${Math.min(...ages)}, oldest ${Math.max(...ages)}; the age range is (narrow|moderate|wide)`));
assert.match(briefing, /By age: under 30: \d+; 30–44: \d+; 45–54: \d+; 55 and over: \d+\. \d+ cover a spouse; \d+ cover children \(\d+ children in all\)/);
for (const m of g.members) if (m.last && m.last.length > 2) assert.ok(!briefing.includes(m.last), `no surname in the briefing (${m.last})`);

// The rule the assistant answers the button with.
assert.match(readFileSync(new URL("../server/assistant.js", import.meta.url), "utf8"), /Give three picks — Lower Cost, Best Fit, Richer Benefits — and when more than one carrier has quoted, give the three for each carrier/);

// The page's request is an ordinary question in a new conversation.
const r0 = await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code: staff.groups.find((x) => x.name === g.name).code }) });
const cookie = (r0.headers.get("set-cookie") || "").split(";")[0];
const r = await fetch(`${base}/api/chat/send`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ threadId: null, content: "Please give me your plan recommendations for my group: a Lower Cost, a Best Fit and a Richer Benefits option, for each carrier that quoted us.", page: "plans", compact: true }) });
const body = await r.text();
assert.equal(r.status, 200, body);
assert.match(body, /event: thread/);
assert.match(body, /event: done/);

console.log("plan recommendations: census as aggregates in the briefing, the rule in place, the button's question answered — ok", { group: g.name, employees: ages.length, average: avg });
stop();

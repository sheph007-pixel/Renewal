// The assistant, end to end on the real server: a group's conversations are
// its own, a question opens a thread and streams a reply, the reply is kept,
// and nothing answers without the session cookie.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 5078;
const CODE = "test-only-code-not-in-repo";
const server = spawn("node", ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_CODE: CODE, KENNION_FAKE_AI: "1", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
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
const roster = staff.groups.filter((g) => !g.archived && g.eligible !== false);
const [mine, other] = roster;

async function cookieFor(code) {
  const r = await fetch(`${base}/api/signin`, { method: "POST", headers: json, body: JSON.stringify({ code }) });
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(p.assistant, true, "the payload says the assistant is on");
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
const cookie = await cookieFor(mine.code);
const otherCookie = await cookieFor(other.code);

// No session, no conversations.
assert.equal((await fetch(`${base}/api/chat/threads`)).status, 401);
assert.equal((await fetch(`${base}/api/chat/send`, { method: "POST", headers: json, body: JSON.stringify({ content: "hi" }) })).status, 401);

// Nothing yet.
let list = await (await fetch(`${base}/api/chat/threads`, { headers: { cookie } })).json();
assert.deepEqual(list.threads, []);

// A first question opens a thread, announces it, streams text, and finishes.
async function send(body, c = cookie) {
  const r = await fetch(`${base}/api/chat/send`, { method: "POST", headers: { ...json, cookie: c }, body: JSON.stringify(body) });
  if (!r.ok) return { status: r.status, body: await r.json() };
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const events = [];
  for (const frame of (await r.text()).split("\n\n")) {
    if (!frame.trim()) continue;
    const event = frame.match(/^event: (.*)$/m)[1];
    const data = JSON.parse(frame.match(/^data: (.*)$/m)[1]);
    events.push({ event, data });
  }
  return { status: 200, events };
}
const first = await send({ content: "What do we spend on medical today?", page: "current" });
assert.equal(first.events[0].event, "thread");
const tid = first.events[0].data.id;
assert.ok(Number.isInteger(tid) && tid > 0);
assert.equal(first.events[0].data.title, "What do we spend on medical today?");
const texts = first.events.filter((e) => e.event === "text");
assert.ok(texts.length > 3, "the reply streams in pieces");
const done = first.events[first.events.length - 1];
assert.equal(done.event, "done");
assert.equal(done.data.message.role, "assistant");
assert.equal(done.data.message.content, texts.map((e) => e.data.text).join("").trim(), "the stored reply is what streamed");

// It is listed, and reads back with both turns.
list = await (await fetch(`${base}/api/chat/threads`, { headers: { cookie } })).json();
assert.equal(list.threads.length, 1);
assert.equal(list.threads[0].id, tid);
const thread = await (await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie } })).json();
assert.equal(thread.messages.length, 2);
assert.equal(thread.messages[0].role, "user");
assert.equal(thread.messages[0].page, "current");
assert.equal(thread.messages[1].role, "assistant");

// A second question on the same thread appends.
const second = await send({ threadId: tid, content: "And per employee?", page: "options" });
assert.equal(second.events[0].data.id, tid);
assert.equal((await (await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie } })).json()).messages.length, 4);

// Another group sees none of it.
assert.deepEqual((await (await fetch(`${base}/api/chat/threads`, { headers: { cookie: otherCookie } })).json()).threads, []);
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie: otherCookie } })).status, 404);
assert.equal((await send({ threadId: tid, content: "hello" }, otherCookie)).status, 404);
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { method: "DELETE", headers: { cookie: otherCookie } })).status, 404);

// Bad input.
assert.equal((await send({ content: "   " })).status, 400);
assert.equal((await send({ content: "x".repeat(4001) })).status, 400);
assert.equal((await send({ threadId: 999999, content: "hi" })).status, 404);

// Documents: a comparison comes back as a file on the answer, downloadable
// by the group's cookie alone; a memo as Word.
const cmp = await send({ threadId: tid, content: "Give me a side-by-side comparison as a spreadsheet", page: "options" });
const cmpFiles = cmp.events.filter((e) => e.event === "file").map((e) => e.data.file);
assert.equal(cmpFiles.length, 1, "one file event for the comparison");
assert.match(cmpFiles[0].filename, /\.xlsx$/);
const cmpDone = cmp.events[cmp.events.length - 1];
assert.equal(cmpDone.event, "done");
assert.deepEqual(cmpDone.data.message.files, cmpFiles, "the stored answer carries the file");
const xlsx = await fetch(`${base}/api/chat/files/${cmpFiles[0].id}`, { headers: { cookie } });
assert.equal(xlsx.status, 200);
assert.match(xlsx.headers.get("content-type") || "", /spreadsheetml/);
assert.match(xlsx.headers.get("content-disposition") || "", /attachment/);
assert.ok((await xlsx.arrayBuffer()).byteLength > 1000, "a real workbook");
assert.equal((await fetch(`${base}/api/chat/files/${cmpFiles[0].id}`)).status, 401, "no cookie, no file");
assert.equal((await fetch(`${base}/api/chat/files/${cmpFiles[0].id}`, { headers: { cookie: otherCookie } })).status, 404, "another group cannot fetch it");
const memo = await send({ threadId: tid, content: "Write a summary memo for leadership in Word", page: "assistant" });
const memoFile = memo.events.find((e) => e.event === "file").data.file;
assert.match(memoFile.filename, /\.docx$/);
const docx = await fetch(`${base}/api/chat/files/${memoFile.id}`, { headers: { cookie } });
assert.equal(docx.status, 200);
assert.equal(new Uint8Array(await docx.arrayBuffer())[0], 0x50, "a zip (docx) starts with P");
const pdf = await send({ threadId: tid, content: "Compare my options", page: "options" });
const pdfFile = pdf.events.find((e) => e.event === "file").data.file;
assert.match(pdfFile.filename, /\.pdf$/);
const pdfBytes = new Uint8Array(await (await fetch(`${base}/api/chat/files/${pdfFile.id}`, { headers: { cookie } })).arrayBuffer());
assert.equal(String.fromCharCode(...pdfBytes.slice(0, 4)), "%PDF");
const withFiles = await (await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie } })).json();
assert.equal(withFiles.messages.filter((m) => (m.files || []).length).length, 3, "three answers carry a document when read back");
console.log("assistant: comparison (xlsx, pdf) and memo (docx) come back as downloadable files — ok");

// The admin: every conversation, transcripts, flags, the playbook, a staff trial.
const staffAuth = { Authorization: `Bearer ${staff.token}` };
assert.equal((await fetch(`${base}/api/admin/chat/threads`, { headers: { cookie } })).status, 401, "a group cannot read the admin log");
let log = await (await fetch(`${base}/api/admin/chat/threads`, { headers: staffAuth })).json();
assert.equal(log.threads.length, 1);
assert.equal(log.threads[0].groupName, mine.name);
assert.equal(log.threads[0].messages, 10);
assert.equal(log.threads[0].preview, "What do we spend on medical today?");
assert.equal(log.stats.groups, 1);
const transcript = await (await fetch(`${base}/api/admin/chat/threads/${tid}`, { headers: staffAuth })).json();
assert.equal(transcript.messages.length, 10);
assert.equal(transcript.thread.groupName, mine.name);
const adminFile = await fetch(`${base}/api/admin/chat/files/${pdfFile.id}`, { headers: staffAuth });
assert.equal(adminFile.status, 200, "staff can open a client's document");
const flagged = await (await fetch(`${base}/api/admin/chat/threads/${tid}/flag`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ flagged: true, note: "Wants a Gravie quote" }) })).json();
assert.ok(flagged.thread.flaggedAt);
assert.equal(flagged.thread.flagNote, "Wants a Gravie quote");
log = await (await fetch(`${base}/api/admin/chat/threads?flagged=1`, { headers: staffAuth })).json();
assert.equal(log.threads.length, 1);
assert.equal(log.stats.flagged, 1);
log = await (await fetch(`${base}/api/admin/chat/threads?q=${encodeURIComponent("per employee")}`, { headers: staffAuth })).json();
assert.equal(log.threads.length, 1, "search reaches into the messages");
log = await (await fetch(`${base}/api/admin/chat/threads?q=zzzz-nothing`, { headers: staffAuth })).json();
assert.equal(log.threads.length, 0);

const pb = await (await fetch(`${base}/api/admin/assistant/playbook`, { headers: staffAuth })).json();
assert.ok(pb.persona.length > 50 && pb.defaults.persona === pb.persona, "the playbook starts at the defaults");
assert.equal(pb.updatedAt, null);
const saved = await (await fetch(`${base}/api/admin/assistant/playbook`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ persona: pb.persona, rules: "- Never call it a rate increase.", faq: "Q: Who is the TPA?\nA: HealthEZ." }) })).json();
assert.equal(saved.rules, "- Never call it a rate increase.");
assert.ok(saved.updatedAt && saved.updatedBy === "hunter@kennion.com");
assert.equal(saved.history.length, 1, "the previous version is kept");
assert.equal((await fetch(`${base}/api/admin/assistant/playbook`, { method: "POST", headers: { ...json, cookie }, body: "{}" })).status, 401, "a group cannot edit the playbook");

// A staff trial as the group: kept, marked staff, invisible to the client.
const trial = await (async () => {
  const r = await fetch(`${base}/api/admin/chat/send`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ group: mine.name, content: "What is level funded?" }) });
  assert.equal(r.status, 200);
  const frames = (await r.text()).split("\n\n").filter((f) => f.trim());
  return frames.map((f) => ({ event: f.match(/^event: (.*)$/m)[1], data: JSON.parse(f.match(/^data: (.*)$/m)[1]) }));
})();
assert.equal(trial[0].event, "thread");
assert.equal(trial[trial.length - 1].event, "done");
const trialId = trial[0].data.id;
assert.equal((await (await fetch(`${base}/api/chat/threads`, { headers: { cookie } })).json()).threads.length, 1, "the client still sees only its own thread");
assert.equal((await fetch(`${base}/api/chat/threads/${trialId}`, { headers: { cookie } })).status, 404, "and cannot open the staff trial");
log = await (await fetch(`${base}/api/admin/chat/threads`, { headers: staffAuth })).json();
assert.equal(log.threads.length, 2);
assert.equal(log.threads.find((t) => t.id === trialId).staff, true);
assert.equal(log.stats.groups, 1, "staff trials do not count as a group asking");
assert.equal((await fetch(`${base}/api/admin/chat/send`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ group: "No Such Co", content: "hi" }) })).status, 404);
assert.equal((await fetch(`${base}/api/admin/chat/threads/${trialId}`, { method: "DELETE", headers: staffAuth })).status, 200);
console.log("assistant admin: log, transcript, flag, search, playbook and staff trials — ok");

// Rename, then delete.
const renamed = await (await fetch(`${base}/api/chat/threads/${tid}`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ title: "Medical spend" }) })).json();
assert.equal(renamed.thread.title, "Medical spend");
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { method: "DELETE", headers: { cookie } })).status, 200);
assert.deepEqual((await (await fetch(`${base}/api/chat/threads`, { headers: { cookie } })).json()).threads, []);
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie } })).status, 404);
assert.equal((await fetch(`${base}/api/chat/files/${pdfFile.id}`, { headers: { cookie } })).status, 404, "its documents go with it");

console.log("assistant: threads are per group, questions stream and are kept, rename and delete work — ok", { group: mine.name });
stop();

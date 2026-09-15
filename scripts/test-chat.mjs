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
async function send(body, c = cookie, extra = {}) {
  const r = await fetch(`${base}/api/chat/send`, { method: "POST", headers: { ...json, cookie: c, ...extra }, body: JSON.stringify(body) });
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

// Attachments: a client uploads a file, sends it with a question, and it is
// on the question for good; nobody else's message can claim it.
{
  const csv = "Plan,EE,ES\nOther Broker Silver,510.00,1020.00\n";
  const up = await fetch(`${base}/api/chat/attachments?filename=${encodeURIComponent("other broker.csv")}`, { method: "POST", headers: { cookie, "Content-Type": "text/csv" }, body: csv });
  assert.equal(up.status, 200);
  const { file: att } = await up.json();
  assert.match(att.filename, /other broker\.csv/);
  assert.equal(att.size, csv.length);
  assert.equal((await fetch(`${base}/api/chat/attachments?filename=x.csv`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: csv })).status, 401, "no cookie, no upload");
  const bad = await fetch(`${base}/api/chat/attachments?filename=${encodeURIComponent("archive.zip")}`, { method: "POST", headers: { cookie, "Content-Type": "application/zip" }, body: "PK" });
  assert.equal(bad.status, 400, "a zip is refused");
  // Another group cannot send it.
  const theirs = await send({ content: "What is this?", attachments: [att.id] }, otherCookie);
  const theirQ = theirs.events.find((e) => e.event === "question");
  assert.equal(theirQ, undefined, "another group's message does not pick up the file");
  const theirDone = theirs.events[theirs.events.length - 1];
  assert.equal(theirDone.event, "done");
  // The owner sends it.
  const r = await send({ threadId: tid, content: "How does this other quote compare?", attachments: [att.id], page: "options" });
  const q = r.events.find((e) => e.event === "question");
  assert.ok(q, "the question is echoed back with its attachment");
  assert.deepEqual(q.data.message.files.map((f) => f.id), [att.id]);
  const reply = r.events.filter((e) => e.event === "text").map((e) => e.data.text).join("");
  assert.match(reply, /I read other broker\.csv/, "the model was given the attachment");
  // Once claimed it cannot be claimed again, and it downloads by the owner's cookie.
  const again = await send({ threadId: tid, content: "again", attachments: [att.id] });
  assert.equal(again.events.find((e) => e.event === "question"), undefined, "a claimed file is not attached twice");
  const dl = await fetch(`${base}/api/chat/files/${att.id}`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), csv);
  assert.equal((await fetch(`${base}/api/chat/files/${att.id}`, { headers: { cookie: otherCookie } })).status, 404);
  const back = await (await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie } })).json();
  const qm = back.messages.find((m) => m.role === "user" && m.files.length);
  assert.ok(qm && qm.files[0].id === att.id, "the attachment reads back on the question");
  // Clean up the other group's stray thread so later counts hold.
  const otherList = await (await fetch(`${base}/api/chat/threads`, { headers: { cookie: otherCookie } })).json();
  for (const t of otherList.threads) await fetch(`${base}/api/chat/threads/${t.id}`, { method: "DELETE", headers: { cookie: otherCookie } });
  console.log("assistant: attachments upload, attach to the question, reach the model, stay with the owner — ok");
}

// The admin: every conversation, transcripts, flags, the playbook, a staff trial.
const staffAuth = { Authorization: `Bearer ${staff.token}` };
assert.equal((await fetch(`${base}/api/admin/chat/threads`, { headers: { cookie } })).status, 401, "a group cannot read the admin log");
let log = await (await fetch(`${base}/api/admin/chat/threads`, { headers: staffAuth })).json();
assert.equal(log.threads.length, 1);
assert.equal(log.threads[0].groupName, mine.name);
assert.equal(log.threads[0].messages, 14);
assert.equal(log.threads[0].preview, "What do we spend on medical today?");
assert.equal(log.stats.groups, 1);
const transcript = await (await fetch(`${base}/api/admin/chat/threads/${tid}`, { headers: staffAuth })).json();
assert.equal(transcript.messages.length, 14);
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
assert.ok(Array.isArray(pb.rules) && pb.rules.length >= 3 && pb.rules.every((r) => r.id && r.text && r.on === true), "rules are a list of switchable lines");
assert.ok(Array.isArray(pb.suggestions) && pb.suggestions.length > 3, "common rules are offered");
assert.equal(pb.updatedAt, null);
// The old free-text shape still saves, and comes back as lists.
let saved = await (await fetch(`${base}/api/admin/assistant/playbook`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ persona: pb.persona, rules: "- Never call it a rate increase.\n- Always mention the refund.", faq: "Q: Who is the TPA?\nA: HealthEZ." }) })).json();
assert.deepEqual(saved.rules.map((r) => r.text), ["Never call it a rate increase.", "Always mention the refund."]);
assert.deepEqual(saved.faq.map((f) => [f.q, f.a]), [["Who is the TPA?", "HealthEZ."]]);
assert.ok(saved.updatedAt && saved.updatedBy === "hunter@kennion.com");
assert.equal(saved.history.length, 1, "the previous version is kept");
// The structured shape: an item switched off stays but is not used; empty and junk items are dropped.
saved = await (await fetch(`${base}/api/admin/assistant/playbook`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ persona: pb.persona, rules: [{ id: "r1", text: "Keep it short.", on: true }, { id: "r2", text: "Off for now.", on: false }, { text: "   " }], facts: [{ text: "Open enrollment runs November 1-15." }], faq: [{ q: "Who is the TPA?", a: "HealthEZ." }, { q: "no answer" }] }) })).json();
assert.deepEqual(saved.rules.map((r) => [r.text, r.on]), [["Keep it short.", true], ["Off for now.", false]]);
assert.equal(saved.facts.length, 1);
assert.equal(saved.faq.length, 1, "a question without an answer is dropped");
assert.equal(saved.history.length, 2);
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

// Memory: a stated preference is kept for the group, shown to the client,
// visible and editable by staff, and gone when either side removes it.
assert.equal((await fetch(`${base}/api/chat/memory`)).status, 401);
assert.deepEqual((await (await fetch(`${base}/api/chat/memory`, { headers: { cookie } })).json()).memory, []);
const memTurn = await send({ threadId: tid, content: "Please remember that we want to keep the employer's monthly spend under $20,000.", page: "assistant" });
const memEvent = memTurn.events.find((e) => e.event === "memory");
assert.ok(memEvent, "the turn announces the remembered line");
assert.equal(memEvent.data.memory.length, 1);
assert.match(memEvent.data.memory[0].text, /under \$20,000/);
let mem = (await (await fetch(`${base}/api/chat/memory`, { headers: { cookie } })).json()).memory;
assert.equal(mem.length, 1);
assert.equal(mem[0].source, "client");
assert.deepEqual((await (await fetch(`${base}/api/chat/memory`, { headers: { cookie: otherCookie } })).json()).memory, [], "memory is per group");
mem = (await (await fetch(`${base}/api/admin/chat/memory?group=${encodeURIComponent(mine.name)}`, { headers: staffAuth })).json()).memory;
assert.equal(mem.length, 1);
mem = (await (await fetch(`${base}/api/admin/chat/memory`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ group: mine.name, add: ["Prefers the Cigna network."] }) })).json()).memory;
assert.equal(mem.length, 2);
assert.equal(mem[1].source, "staff");
mem = (await (await fetch(`${base}/api/chat/memory/${mem[0].id}`, { method: "DELETE", headers: { cookie } })).json()).memory;
assert.equal(mem.length, 1, "the client can forget a line");
mem = (await (await fetch(`${base}/api/admin/chat/memory`, { method: "POST", headers: { ...json, ...staffAuth }, body: JSON.stringify({ group: mine.name, removeIds: [mem[0].id] }) })).json()).memory;
assert.equal(mem.length, 0, "and so can staff");
// The client can add a line of its own from the Memory panel.
const added = await fetch(`${base}/api/chat/memory`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ text: "  Wants dental kept with   Guardian. " }) });
assert.equal(added.status, 200);
mem = (await added.json()).memory;
assert.equal(mem.length, 1);
assert.equal(mem[0].text, "Wants dental kept with Guardian.");
assert.equal(mem[0].source, "client");
assert.equal((await fetch(`${base}/api/chat/memory`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ text: "   " }) })).status, 400, "an empty line is refused");
assert.equal((await fetch(`${base}/api/chat/memory`, { method: "POST", headers: json, body: JSON.stringify({ text: "x" }) })).status, 401, "and nobody adds without a session");
mem = (await (await fetch(`${base}/api/chat/memory/${mem[0].id}`, { method: "DELETE", headers: { cookie } })).json()).memory;
assert.equal(mem.length, 0);
console.log("assistant memory: preferences are kept per group, shown, addable and removable by client or staff — ok");

// Two groups open in one browser: the cookie is the other group's (it signed
// in last), but the page names its own group in a header, and that wins.
// A header naming no real group is refused rather than falling back.
const tokenHeader = mine.linkToken ? { "X-Kennion-Group-Token": mine.linkToken } : { "X-Kennion-Group-Code": mine.code };
let cross = await (await fetch(`${base}/api/chat/threads`, { headers: { cookie: otherCookie, ...tokenHeader } })).json();
assert.ok(cross.threads.some((t) => t.id === tid), "the header's group's threads come back, not the cookie's");
const crossTurn = await send({ threadId: tid, content: "Which company am I?", page: "home" }, otherCookie, tokenHeader);
assert.equal(crossTurn.status, 200);
assert.equal(crossTurn.events[0].data.id, tid, "the turn lands on the header's group's thread");
assert.equal((await fetch(`${base}/api/chat/threads`, { headers: { cookie: otherCookie, "X-Kennion-Group-Code": "KEN-NOPE-0000" } })).status, 401, "a bad header is refused, not ignored");
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie: otherCookie } })).status, 404, "the cookie alone still cannot reach another group's thread");
console.log("assistant isolation: a page's own group header beats a cookie left by another group's sign-in — ok");

// Rename, then delete.
const renamed = await (await fetch(`${base}/api/chat/threads/${tid}`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ title: "Medical spend" }) })).json();
assert.equal(renamed.thread.title, "Medical spend");
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { method: "DELETE", headers: { cookie } })).status, 200);
assert.deepEqual((await (await fetch(`${base}/api/chat/threads`, { headers: { cookie } })).json()).threads, []);
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie } })).status, 404);
assert.equal((await fetch(`${base}/api/chat/files/${pdfFile.id}`, { headers: { cookie } })).status, 404, "its documents go with it");

console.log("assistant: threads are per group, questions stream and are kept, rename and delete work — ok", { group: mine.name });
stop();

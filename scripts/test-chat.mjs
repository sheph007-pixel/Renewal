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

// Rename, then delete.
const renamed = await (await fetch(`${base}/api/chat/threads/${tid}`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ title: "Medical spend" }) })).json();
assert.equal(renamed.thread.title, "Medical spend");
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { method: "DELETE", headers: { cookie } })).status, 200);
assert.deepEqual((await (await fetch(`${base}/api/chat/threads`, { headers: { cookie } })).json()).threads, []);
assert.equal((await fetch(`${base}/api/chat/threads/${tid}`, { headers: { cookie } })).status, 404);

console.log("assistant: threads are per group, questions stream and are kept, rename and delete work — ok", { group: mine.name });
stop();

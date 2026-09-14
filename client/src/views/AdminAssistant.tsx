import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { C, chip, panel, primaryBtn, smallPrimaryBtn, textInput, th } from "@/lib/ui";
import { readEvents, type ChatFile, type ChatMessage } from "@/lib/chat";
import Markdown from "@/views/Markdown";
import { FileChips } from "@/views/ChatPanel";

interface Props {
  token: string;
  /** Whether the server has an Anthropic key. */
  ai: boolean;
  /** Live group names, for the filter and for trying the assistant as one. */
  groups: string[];
}

interface AdminThread {
  id: number;
  groupName: string;
  title: string | null;
  staff: boolean;
  flaggedAt: string | null;
  flagNote: string | null;
  messages: number;
  preview: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Stats {
  threads: number;
  messages: number;
  groups: number;
  thisWeek: number;
  flagged: number;
}

interface Playbook {
  persona: string;
  rules: string;
  faq: string;
  defaults: { persona: string; rules: string; faq: string };
  updatedAt: string | null;
  updatedBy: string | null;
  history: { updatedAt: string | null; updatedBy: string | null; persona: string; rules: string; faq: string }[];
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ ...panel, padding: "12px 16px", minWidth: 130, flex: "1 1 130px" }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.4px", textTransform: "uppercase", color: C.faint }}>{label}</div>
      <div style={{ marginTop: 2, fontSize: 22, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

/** One turn as it reads in the admin — the client's question, the assistant's answer with its documents. */
function Transcript({ messages }: { messages: ChatMessage[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: "85%", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ padding: "8px 12px", borderRadius: 12, borderBottomRightRadius: 4, background: C.navy, color: "#fff", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{m.content}</div>
            <FileChips files={m.files || []} href={(f) => `/api/admin/chat/files/${f.id}`} align="right" />
          </div>
        ) : (
          <div key={m.id} style={{ fontSize: 13, lineHeight: 1.55, color: C.ink, padding: "2px 0" }}>
            <Markdown text={m.content} />
            <FileChips files={m.files || []} href={(f) => `/api/admin/chat/files/${f.id}`} />
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Try the assistant as one group, with the playbook as it stands right now.
 * The conversation is kept, marked as staff's, and never shown to the client.
 */
function TryIt({ token, groups, ai, onActivity }: { token: string; groups: string[]; ai: boolean; onActivity: () => void }) {
  const [group, setGroup] = useState(groups[0] || "");
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<{ text: string; status: string; files: ChatFile[] } | null>(null);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const reset = () => {
    setThreadId(null);
    setMessages([]);
    setStreaming(null);
    setError("");
  };

  const ask = async () => {
    const content = draft.trim();
    if (!content || streaming || !group) return;
    setDraft("");
    setError("");
    setMessages((ms) => [...ms, { id: -Date.now(), role: "user", content, createdAt: new Date().toISOString() }]);
    let text = "";
    let status = "";
    const files: ChatFile[] = [];
    setStreaming({ text, status, files });
    try {
      const r = await fetch("/api/admin/chat/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ group, threadId, content }),
      });
      if (!r.ok || !r.body) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Request failed (${r.status})`);
      let failed: string | null = null;
      await readEvents(r.body, (event, raw) => {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (event === "thread") setThreadId((data as { id: number }).id);
        else if (event === "text") text += (data as { text: string }).text;
        else if (event === "status") status = (data as { text: string }).text;
        else if (event === "file") {
          files.push((data as { file: ChatFile }).file);
          status = "";
        } else if (event === "done") setMessages((ms) => [...ms, (data as { message: ChatMessage }).message]);
        else if (event === "error") failed = (data as { error: string }).error;
        setStreaming({ text, status, files: [...files] });
      });
      if (failed) throw new Error(failed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStreaming(null);
      onActivity();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask();
    }
  };

  return (
    <div style={{ ...panel, marginTop: 16, display: "flex", flexDirection: "column", height: 520 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.hairline}` }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>Try it as a group</div>
          <div style={{ fontSize: 12, color: C.muted }}>Uses the playbook as saved. The client never sees these conversations.</div>
        </div>
        <select
          value={group}
          onChange={(e) => {
            setGroup(e.target.value);
            reset();
          }}
          style={{ ...textInput, marginLeft: "auto", fontSize: 13, padding: "7px 10px", maxWidth: 340 }}
        >
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <button onClick={reset} style={chip(false)}>
          New conversation
        </button>
      </div>
      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px" }}>
        {!ai && <div style={{ fontSize: 13, color: C.amber }}>No Anthropic key is set, so the assistant cannot answer here or for clients.</div>}
        {ai && !messages.length && !streaming && <div style={{ fontSize: 13, color: C.muted }}>Ask what a client would ask — a comparison, a summary for leadership, what level funded means for them — and see what the assistant says with this playbook.</div>}
        <Transcript messages={messages} />
        {streaming && (
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.55, color: C.ink }}>
            {streaming.text ? <Markdown text={streaming.text} /> : null}
            {(streaming.status || !streaming.text) && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>{streaming.status || "Thinking…"}</div>}
            <FileChips files={streaming.files} href={(f) => `/api/admin/chat/files/${f.id}`} />
          </div>
        )}
        {error && <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: C.red }}>{error}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px 14px", borderTop: `1px solid ${C.hairline}` }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={1} placeholder={`Ask as ${group || "a group"}…`} disabled={!ai} style={{ ...textInput, flex: 1, resize: "none", fontSize: 13 }} />
        <button onClick={() => void ask()} disabled={!ai || !!streaming || !draft.trim()} style={{ ...smallPrimaryBtn, opacity: !ai || streaming || !draft.trim() ? 0.5 : 1 }}>
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * The admin's side of the assistant: what clients are asking, a place to
 * follow up, and the playbook — who the assistant is, Kennion's rules, the
 * house answers — that every reply is written by.
 */
export default function AdminAssistant({ token, ai, groups }: Props) {
  const auth = { Authorization: `Bearer ${token}` };

  // ---- playbook
  const [pb, setPb] = useState<Playbook | null>(null);
  const [persona, setPersona] = useState("");
  const [rules, setRules] = useState("");
  const [faq, setFaq] = useState("");
  const [pbState, setPbState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pbError, setPbError] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    void fetch("/api/admin/assistant/playbook", { headers: auth })
      .then((r) => r.json())
      .then((p: Playbook) => {
        setPb(p);
        setPersona(p.persona);
        setRules(p.rules);
        setFaq(p.faq);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const dirty = !!pb && (persona !== pb.persona || rules !== pb.rules || faq !== pb.faq);
  const savePlaybook = async () => {
    setPbState("saving");
    setPbError("");
    try {
      const r = await fetch("/api/admin/assistant/playbook", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ persona, rules, faq }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Could not save");
      const p = (await r.json()) as Playbook;
      setPb(p);
      setPersona(p.persona);
      setRules(p.rules);
      setFaq(p.faq);
      setPbState("saved");
    } catch (e) {
      setPbState("error");
      setPbError((e as Error).message);
    }
  };

  // ---- conversations
  const [threads, setThreads] = useState<AdminThread[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [group, setGroup] = useState("");
  const [q, setQ] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [showStaff, setShowStaff] = useState(false);
  const [open, setOpen] = useState<{ thread: AdminThread; messages: ChatMessage[] } | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (group) params.set("group", group);
      if (q.trim()) params.set("q", q.trim());
      if (flaggedOnly) params.set("flagged", "1");
      const r = await fetch(`/api/admin/chat/threads?${params}`, { headers: auth });
      if (!r.ok) return;
      const p = (await r.json()) as { threads: AdminThread[]; stats: Stats };
      setThreads(p.threads);
      setStats(p.stats);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, group, q, flaggedOnly]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const openThread = async (t: AdminThread) => {
    const r = await fetch(`/api/admin/chat/threads/${t.id}`, { headers: auth });
    if (!r.ok) return;
    const p = (await r.json()) as { thread: AdminThread; messages: ChatMessage[] };
    setOpen({ thread: { ...t, ...p.thread }, messages: p.messages });
    setNote(p.thread.flagNote || t.flagNote || "");
  };

  const flag = async (t: AdminThread, flagged: boolean) => {
    const r = await fetch(`/api/admin/chat/threads/${t.id}/flag`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ flagged, note }) });
    if (!r.ok) return;
    const p = (await r.json()) as { thread: AdminThread };
    setThreads((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...p.thread } : x)));
    setOpen((o) => (o && o.thread.id === t.id ? { ...o, thread: { ...o.thread, ...p.thread } } : o));
    if (stats) setStats({ ...stats, flagged: stats.flagged + (flagged ? 1 : -1) });
  };

  const remove = async (t: AdminThread) => {
    if (!window.confirm(`Delete this conversation with ${t.groupName}? The client will no longer see it either.`)) return;
    const r = await fetch(`/api/admin/chat/threads/${t.id}`, { method: "DELETE", headers: auth });
    if (!r.ok) return;
    setThreads((ts) => ts.filter((x) => x.id !== t.id));
    if (open && open.thread.id === t.id) setOpen(null);
  };

  const shown = threads.filter((t) => showStaff || !t.staff);
  const ta = { ...textInput, width: "100%", fontSize: 13, lineHeight: 1.5, resize: "vertical" as const, fontFamily: "inherit" };

  return (
    <>
      {!ai && (
        <div style={{ marginTop: 16, fontSize: 13, color: C.amber, lineHeight: 1.6, maxWidth: 840 }}>
          No Anthropic key is set, so the assistant is off: clients do not see the chat box, and nothing below can answer. Set <code>ANTHROPIC_API_KEY</code> in Railway to turn it on.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
        <Stat label="Conversations" value={stats ? stats.threads : "—"} />
        <Stat label="Active this week" value={stats ? stats.thisWeek : "—"} />
        <Stat label="Groups asking" value={stats ? stats.groups : "—"} />
        <Stat label="Messages" value={stats ? stats.messages : "—"} />
        <Stat label="Flagged for follow-up" value={stats ? stats.flagged : "—"} />
      </div>

      {/* ---- playbook */}
      <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: "1 1 420px" }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>Playbook</h2>
            <div style={{ marginTop: 4, fontSize: 13, color: C.muted, lineHeight: 1.6, maxWidth: 760 }}>
              How the assistant is told to behave, in plain English. It reads this on every question, so a change takes effect the next time anyone asks — no deploy. Write rules the way you would brief a new advisor: what to say, what not to say, how to position the program.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
            <span style={{ fontSize: 12.5, color: pbState === "error" ? C.red : pbState === "saved" && !dirty ? C.green : C.faint }}>
              {pbState === "saving" ? "Saving…" : pbState === "error" ? pbError || "Not saved" : pbState === "saved" && !dirty ? "Saved" : pb?.updatedAt ? `Last saved ${when(pb.updatedAt)}${pb.updatedBy ? ` by ${pb.updatedBy}` : ""}` : "Defaults — never edited"}
            </span>
            <button onClick={() => void savePlaybook()} disabled={!pb || !dirty || pbState === "saving"} style={{ ...primaryBtn, opacity: !pb || !dirty || pbState === "saving" ? 0.5 : 1 }}>
              Save playbook
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: 16, marginTop: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Who it is</div>
            <div style={{ fontSize: 12, color: C.muted, margin: "2px 0 6px" }}>The persona: role, expertise, tone.</div>
            <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={7} style={ta} />
            {pb && persona !== pb.defaults.persona && (
              <button onClick={() => setPersona(pb.defaults.persona)} style={{ marginTop: 6, background: "none", border: "none", padding: 0, fontSize: 12, color: C.blue, cursor: "pointer" }}>
                Reset to the default
              </button>
            )}
          </label>
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Rules</div>
            <div style={{ fontSize: 12, color: C.muted, margin: "2px 0 6px" }}>One per line. &ldquo;Never describe 2027 as a rate increase.&rdquo; &ldquo;Always mention the level-funded refund.&rdquo;</div>
            <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={7} style={ta} placeholder="- Never …&#10;- Always …&#10;- When a client asks about …, say …" />
          </label>
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>House answers</div>
            <div style={{ fontSize: 12, color: C.muted, margin: "2px 0 6px" }}>Questions with the answer you want given, in your words. Put the question on one line and the answer under it.</div>
            <textarea value={faq} onChange={(e) => setFaq(e.target.value)} rows={7} style={ta} placeholder="Q: Who is our stop-loss carrier?&#10;A: …&#10;&#10;Q: When does open enrollment run?&#10;A: …" />
          </label>
        </div>

        {pb && pb.history.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setShowHistory((v) => !v)} style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}>
              {showHistory ? "Hide" : "Show"} earlier versions ({pb.history.length})
            </button>
            {showHistory && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {pb.history.map((h, i) => (
                  <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 12.5, color: C.body, padding: "6px 10px", borderRadius: 6, background: C.zebra }}>
                    <span>{h.updatedAt ? `${when(h.updatedAt)}${h.updatedBy ? ` by ${h.updatedBy}` : ""}` : "The defaults"}</span>
                    <button
                      onClick={() => {
                        setPersona(h.persona);
                        setRules(h.rules);
                        setFaq(h.faq);
                      }}
                      style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}
                    >
                      Load into the editor
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <TryIt token={token} groups={groups} ai={ai} onActivity={() => void load()} />

      {/* ---- conversations */}
      <div style={{ ...panel, marginTop: 16, padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink, flex: "0 0 auto" }}>Conversations</h2>
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ ...textInput, fontSize: 13, padding: "7px 10px", maxWidth: 300 }}>
          <option value="">Every group</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions and answers" style={{ ...textInput, flex: 1, minWidth: 220, fontSize: 13, padding: "7px 10px" }} />
        <button onClick={() => setFlaggedOnly((v) => !v)} style={chip(flaggedOnly)}>
          Flagged
        </button>
        <button onClick={() => setShowStaff((v) => !v)} style={chip(showStaff)} title="Conversations staff had while trying the assistant">
          Staff trials
        </button>
        <span style={{ fontSize: 12.5, color: C.faint, marginLeft: "auto" }}>{loading ? "Loading…" : `${shown.length} conversation${shown.length === 1 ? "" : "s"}`}</span>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 16, alignItems: "flex-start" }}>
        <div style={{ ...panel, flex: open ? "0 0 46%" : "1 1 auto", minWidth: 0, padding: "4px 18px 12px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ ...th, padding: "12px 8px 11px 0" }}>Group</th>
                <th style={th}>First question</th>
                <th style={{ ...th, textAlign: "right" }}>Turns</th>
                <th style={th}>Last active</th>
                <th style={{ ...th, padding: "12px 0 11px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {!shown.length && (
                <tr>
                  <td colSpan={5} style={{ padding: "14px 0", color: C.faint }}>
                    {loading ? "Loading…" : "No conversations yet."}
                  </td>
                </tr>
              )}
              {shown.map((t) => {
                const on = open?.thread.id === t.id;
                return (
                  <tr key={t.id} className="rowlink" onClick={() => void openThread(t)} style={{ cursor: "pointer", background: on ? C.blueTint : undefined }}>
                    <td style={{ padding: "8px 8px 8px 0", borderBottom: `1px solid ${C.hairline}`, color: C.ink, whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t.groupName}
                      {t.staff && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: C.faint, textTransform: "uppercase", letterSpacing: "0.3px" }}>staff</span>}
                    </td>
                    <td style={{ padding: 8, borderBottom: `1px solid ${C.hairline}`, color: C.body, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.preview || ""}>
                      {t.flaggedAt && (
                        <span aria-label="Flagged" title={t.flagNote || "Flagged for follow-up"} style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: C.orange, marginRight: 7, verticalAlign: "middle" }} />
                      )}
                      {t.preview || t.title || "—"}
                    </td>
                    <td style={{ padding: 8, borderBottom: `1px solid ${C.hairline}`, textAlign: "right", color: C.body, fontVariantNumeric: "tabular-nums" }}>{Math.ceil(t.messages / 2)}</td>
                    <td style={{ padding: 8, borderBottom: `1px solid ${C.hairline}`, color: C.body, whiteSpace: "nowrap" }}>{when(t.updatedAt)}</td>
                    <td style={{ padding: "8px 0 8px 8px", borderBottom: `1px solid ${C.hairline}`, textAlign: "right" }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(t);
                        }}
                        title="Delete"
                        style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: C.faint, cursor: "pointer" }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {open && (
          <div style={{ ...panel, flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", maxHeight: "80vh", position: "sticky", top: 16 }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.hairline}`, display: "flex", alignItems: "flex-start", gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{open.thread.groupName}</div>
                <div style={{ fontSize: 12, color: C.muted }}>
                  {open.thread.title || "Conversation"} · started {when(open.thread.createdAt)}
                  {open.thread.staff ? " · a staff trial" : ""}
                </div>
              </div>
              <button onClick={() => setOpen(null)} aria-label="Close" style={{ background: "none", border: "none", fontSize: 18, lineHeight: 1, color: C.muted, cursor: "pointer" }}>
                &times;
              </button>
            </div>
            <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.hairline}`, background: open.thread.flaggedAt ? C.amberTint : C.zebra, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for follow-up — what the account manager should do" style={{ ...textInput, flex: 1, minWidth: 200, fontSize: 12.5, padding: "6px 9px" }} />
              {open.thread.flaggedAt ? (
                <>
                  <button onClick={() => void flag(open.thread, true)} style={chip(false)}>
                    Save note
                  </button>
                  <button onClick={() => void flag(open.thread, false)} style={chip(true)}>
                    Clear flag
                  </button>
                </>
              ) : (
                <button onClick={() => void flag(open.thread, true)} style={chip(false)}>
                  Flag for follow-up
                </button>
              )}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px" }}>
              <Transcript messages={open.messages} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
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

interface Line {
  id: string;
  text: string;
  on: boolean;
}
interface Answer {
  id: string;
  q: string;
  a: string;
  on: boolean;
}
interface PlaybookBody {
  persona: string;
  rules: Line[];
  facts: Line[];
  faq: Answer[];
}
interface Playbook extends PlaybookBody {
  defaults: PlaybookBody;
  suggestions: string[];
  updatedAt: string | null;
  updatedBy: string | null;
  history: (PlaybookBody & { updatedAt: string | null; updatedBy: string | null })[];
}

const newId = () => Math.random().toString(36).slice(2, 10);
const same = (a: PlaybookBody, b: PlaybookBody) => JSON.stringify([a.persona, a.rules, a.facts, a.faq]) === JSON.stringify([b.persona, b.rules, b.facts, b.faq]);

const rowBtn = { display: "grid", placeItems: "center", width: 24, height: 24, border: "none", borderRadius: 5, background: "transparent", color: C.faint, cursor: "pointer", flex: "none" } as const;

/** One editable line in a list: on/off, the text, remove. Every line carries the same weight. */
function LineRow({ line, onChange, onRemove }: { line: Line; onChange: (l: Line) => void; onRemove: () => void }) {
  return (
    <div className="pb-row" style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 6px 6px 8px", borderRadius: 7, background: line.on ? "transparent" : C.zebra }}>
      <input type="checkbox" checked={line.on} onChange={(e) => onChange({ ...line, on: e.target.checked })} title={line.on ? "On — the assistant follows this" : "Off — kept but not used"} style={{ marginTop: 5, accentColor: C.blue, cursor: "pointer" }} />
      <textarea
        value={line.text}
        onChange={(e) => onChange({ ...line, text: e.target.value.replace(/\n/g, " ") })}
        rows={1}
        ref={(el) => {
          if (el) {
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }
        }}
        style={{ flex: 1, minWidth: 0, resize: "none", border: "1px solid transparent", borderRadius: 5, padding: "4px 8px", fontSize: 13.5, lineHeight: 1.5, color: line.on ? C.ink : C.muted, background: "transparent", outline: "none", fontFamily: "inherit", textDecoration: line.on ? "none" : "line-through" }}
        onFocus={(e) => (e.currentTarget.style.borderColor = C.inputEdge)}
        onBlur={(e) => (e.currentTarget.style.borderColor = "transparent")}
      />
      <span className="pb-tools" style={{ display: "flex", gap: 2, marginTop: 2 }}>
        <button onClick={onRemove} title="Remove" aria-label="Remove" style={rowBtn}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </span>
    </div>
  );
}

/** A list of lines with a box to add one, and optionally a menu of common ones. */
function LineList({ title, hint, lines, onChange, placeholder, suggestions }: { title: string; hint: string; lines: Line[]; onChange: (l: Line[]) => void; placeholder: string; suggestions?: string[] }) {
  const [draft, setDraft] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const add = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    onChange([...lines, { id: newId(), text: t, on: true }]);
    setDraft("");
  };
  const unused = (suggestions || []).filter((s) => !lines.some((l) => l.text === s));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        {title && <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{title}</div>}
        <div style={{ fontSize: 11.5, color: C.faint }}>{lines.filter((l) => l.on).length} on{lines.some((l) => !l.on) ? `, ${lines.filter((l) => !l.on).length} off` : ""}</div>
      </div>
      {hint && <div style={{ fontSize: 12, color: C.muted, margin: "2px 0 6px" }}>{hint}</div>}
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.card }}>
        {!lines.length && <div style={{ padding: "10px 12px", fontSize: 12.5, color: C.faint }}>None yet.</div>}
        {lines.map((l) => (
          <LineRow key={l.id} line={l} onChange={(nl) => onChange(lines.map((x) => (x.id === l.id ? nl : x)))} onRemove={() => onChange(lines.filter((x) => x.id !== l.id))} />
        ))}
        <div style={{ display: "flex", gap: 6, padding: 6, borderTop: lines.length ? `1px solid ${C.hairline}` : "none" }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(draft);
              }
            }}
            placeholder={placeholder}
            style={{ ...textInput, flex: 1, fontSize: 13, padding: "7px 9px" }}
          />
          <button onClick={() => add(draft)} disabled={!draft.trim()} style={{ ...chip(false), opacity: draft.trim() ? 1 : 0.5 }}>
            Add
          </button>
        </div>
      </div>
      {unused.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <button onClick={() => setShowSuggest((v) => !v)} style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: C.blue, cursor: "pointer" }}>
            {showSuggest ? "Hide" : "Add a common one"} ({unused.length})
          </button>
          {showSuggest && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {unused.map((sug) => (
                <button key={sug} onClick={() => add(sug)} title="Add this rule" style={{ fontSize: 12, padding: "5px 10px", borderRadius: 999, border: `1px solid ${C.blueEdge}`, background: C.blueTint, color: C.blueInk, cursor: "pointer", textAlign: "left", textTransform: "none" }}>
                  + {sug}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Question-and-answer pairs the assistant gives verbatim. */
function AnswerList({ items, onChange }: { items: Answer[]; onChange: (a: Answer[]) => void }) {
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const add = () => {
    if (!q.trim() || !a.trim()) return;
    onChange([...items, { id: newId(), q: q.trim(), a: a.trim(), on: true }]);
    setQ("");
    setA("");
  };
  const field = { ...textInput, width: "100%", fontSize: 13, padding: "6px 8px", fontFamily: "inherit" } as const;
  return (
    <div>
      <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 6 }}>{items.filter((x) => x.on).length} on</div>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        {items.map((it) => (
          <div key={it.id} className="pb-row" style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", background: it.on ? C.card : C.zebra, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={it.on} onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, on: e.target.checked } : x)))} title={it.on ? "On" : "Off — kept but not used"} style={{ accentColor: C.blue, cursor: "pointer" }} />
              <input value={it.q} onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, q: e.target.value } : x)))} placeholder="Question" style={{ ...field, fontWeight: 600 }} />
              <button onClick={() => onChange(items.filter((x) => x.id !== it.id))} title="Remove" aria-label="Remove" style={rowBtn}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <textarea value={it.a} onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, a: e.target.value } : x)))} placeholder="Answer" rows={3} style={{ ...field, resize: "vertical", lineHeight: 1.5 }} />
          </div>
        ))}
        <div style={{ border: `1px dashed ${C.inputEdge}`, borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="A question clients ask — e.g. Who is our stop-loss carrier?" style={{ ...field, fontWeight: 600 }} />
          <textarea value={a} onChange={(e) => setA(e.target.value)} placeholder="The answer, in your words" rows={3} style={{ ...field, resize: "vertical", lineHeight: 1.5 }} />
          <div>
            <button onClick={add} disabled={!q.trim() || !a.trim()} style={{ ...chip(false), opacity: q.trim() && a.trim() ? 1 : 0.5 }}>
              Add answer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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
function Transcript({ messages, token, onAdopt }: { messages: ChatMessage[]; token: string; onAdopt?: (q: string, a: string) => void }) {
  const headers = { Authorization: `Bearer ${token}` };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {messages.map((m, i) =>
        m.role === "user" ? (
          <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: "85%", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ padding: "8px 12px", borderRadius: 12, borderBottomRightRadius: 4, background: C.navy, color: "#fff", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{m.content}</div>
            <FileChips files={m.files || []} href={(f) => `/api/admin/chat/files/${f.id}`} align="right" headers={headers} />
          </div>
        ) : (
          <div key={m.id} style={{ fontSize: 13, lineHeight: 1.55, color: C.ink, padding: "2px 0" }}>
            <Markdown text={m.content} />
            <FileChips files={m.files || []} href={(f) => `/api/admin/chat/files/${f.id}`} headers={headers} />
            {onAdopt && i > 0 && messages[i - 1].role === "user" && (
              <button
                onClick={() => onAdopt(messages[i - 1].content, m.content)}
                title="Turn this question and answer into a house answer you can edit, so the assistant gives it every time"
                style={{ marginTop: 4, background: "none", border: `1px solid ${C.blueEdge}`, borderRadius: 999, padding: "3px 10px", fontSize: 11.5, fontWeight: 600, color: C.blueInk, cursor: "pointer" }}
              >
                + Add To House Answers
              </button>
            )}
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
function TryIt({ token, groups, ai, onActivity, dirty }: { token: string; groups: string[]; ai: boolean; onActivity: () => void; dirty: boolean }) {
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
    <div style={{ ...panel, marginTop: 16, display: "flex", flexDirection: "column", height: "calc(100vh - 260px)", minHeight: 480 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.hairline}` }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>Try it as a group</div>
          <div style={{ fontSize: 12, color: dirty ? C.amber : C.muted }}>{dirty ? "You have unsaved playbook changes — save them first to test them here." : "Uses the playbook as saved. The client never sees these conversations."}</div>
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
        <Transcript messages={messages} token={token} />
        {streaming && (
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.55, color: C.ink }}>
            {streaming.text ? <Markdown text={streaming.text} /> : null}
            {(streaming.status || !streaming.text) && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>{streaming.status || "Thinking…"}</div>}
            <FileChips files={streaming.files} href={(f) => `/api/admin/chat/files/${f.id}`} headers={{ Authorization: `Bearer ${token}` }} />
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
  const [draft, setDraft] = useState<PlaybookBody>({ persona: "", rules: [], facts: [], faq: [] });
  const [pbState, setPbState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pbError, setPbError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const body = (p: PlaybookBody): PlaybookBody => ({ persona: p.persona, rules: p.rules, facts: p.facts, faq: p.faq });

  useEffect(() => {
    void fetch("/api/admin/assistant/playbook", { headers: auth })
      .then((r) => r.json())
      .then((p: Playbook) => {
        setPb(p);
        setDraft(body(p));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const dirty = !!pb && !same(draft, pb);
  const savePlaybook = async () => {
    setPbState("saving");
    setPbError("");
    try {
      const r = await fetch("/api/admin/assistant/playbook", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Could not save");
      const p = (await r.json()) as Playbook;
      setPb(p);
      setDraft(body(p));
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

  // ---- the three jobs on this page, one at a time
  const [view, setView] = useState<"playbook" | "test" | "conversations">("playbook");
  const answersRef = useRef<HTMLDivElement>(null!);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  /** A question and answer from a real conversation become an editable house answer. */
  const adopt = (qText: string, aText: string) => {
    setDraft((d) => ({ ...d, faq: [...d.faq, { id: newId(), q: qText.trim().slice(0, 300), a: aText.trim().slice(0, 3000), on: true }] }));
    setView("playbook");
    setTimeout(() => answersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const tabBtn = (key: typeof view, label: string, badge?: number) => (
    <button
      key={key}
      role="tab"
      aria-selected={view === key}
      onClick={() => setView(key)}
      style={{
        padding: "9px 16px",
        fontSize: 13.5,
        fontWeight: 600,
        color: view === key ? C.ink : C.muted,
        background: "none",
        border: "none",
        borderBottom: `3px solid ${view === key ? C.blue : "transparent"}`,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {label}
      {badge != null && badge > 0 && <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: C.amberTint, color: C.amber, border: `1px solid ${C.amberEdge}` }}>{badge}</span>}
    </button>
  );

  const section = (title: string, hint: string, children: ReactNode, ref?: RefObject<HTMLDivElement>) => (
    <div ref={ref} style={{ ...panel, padding: "16px 20px" }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>{title}</h3>
      <div style={{ fontSize: 12.5, color: C.muted, margin: "3px 0 12px", lineHeight: 1.55 }}>{hint}</div>
      {children}
    </div>
  );

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

      <div role="tablist" style={{ display: "flex", gap: 4, marginTop: 18, borderBottom: `1px solid ${C.border}` }}>
        {tabBtn("playbook", "Playbook")}
        {tabBtn("test", "Test It")}
        {tabBtn("conversations", "Conversations", stats?.flagged)}
      </div>

      {view === "playbook" && (
        <>
          {/* Sticky save bar: the one place the playbook is saved from, always in view. */}
          <div style={{ position: "sticky", top: 0, zIndex: 5, ...panel, marginTop: 14, padding: "10px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, borderColor: dirty ? C.amberEdge : undefined, background: dirty ? C.amberTint : C.card }}>
            <div style={{ fontSize: 13, color: C.body, lineHeight: 1.5, flex: "1 1 360px" }}>
              The assistant reads all of this on every question, so a saved change takes effect immediately. Untick an item to keep it without using it.
            </div>
            <span style={{ fontSize: 12.5, color: pbState === "error" ? C.red : pbState === "saved" && !dirty ? C.green : dirty ? C.amber : C.faint }}>
              {pbState === "saving" ? "Saving…" : pbState === "error" ? pbError || "Not saved" : dirty ? "Unsaved changes" : pbState === "saved" ? "Saved" : pb?.updatedAt ? `Last saved ${when(pb.updatedAt)}${pb.updatedBy ? ` by ${pb.updatedBy}` : ""}` : "Defaults — never edited"}
            </span>
            {dirty && pb && (
              <button onClick={() => setDraft(body(pb))} style={chip(false)}>
                Discard
              </button>
            )}
            <button onClick={() => void savePlaybook()} disabled={!pb || !dirty || pbState === "saving"} style={{ ...primaryBtn, opacity: !pb || !dirty || pbState === "saving" ? 0.5 : 1 }}>
              Save Playbook
            </button>
          </div>

          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            {section(
              "1 · Who It Is",
              "Role, expertise, tone — one short paragraph, as if briefing a new hire.",
              <>
                <textarea value={draft.persona} onChange={(e) => setDraft({ ...draft, persona: e.target.value })} rows={5} style={{ ...textInput, width: "100%", fontSize: 13.5, lineHeight: 1.55, resize: "vertical", fontFamily: "inherit" }} />
                {pb && draft.persona !== pb.defaults.persona && (
                  <button onClick={() => setDraft({ ...draft, persona: pb.defaults.persona })} style={{ marginTop: 6, background: "none", border: "none", padding: 0, fontSize: 12, color: C.blue, cursor: "pointer" }}>
                    Reset to the default
                  </button>
                )}
              </>,
            )}
            {section(
              "2 · Rules",
              "What to always do, never do, or say a certain way. One rule per line; they all carry the same weight.",
              <LineList title="" hint="" lines={draft.rules} onChange={(rules) => setDraft({ ...draft, rules })} placeholder="e.g. Never describe the move as a rate increase." suggestions={pb?.suggestions || []} />,
            )}
            {section(
              "3 · Facts About The Program",
              "Things the assistant should know that are not in a group's figures: the stop-loss carrier, when open enrollment runs, how billing works.",
              <LineList title="" hint="" lines={draft.facts} onChange={(facts) => setDraft({ ...draft, facts })} placeholder="e.g. Open enrollment runs November 1–15; changes take effect January 1." />,
            )}
            {section(
              "4 · House Answers",
              "When a client asks something like the question, the assistant answers in these words. Add them here, or from any conversation with Add To House Answers.",
              <AnswerList items={draft.faq} onChange={(faq) => setDraft({ ...draft, faq })} />,
              answersRef,
            )}
          </div>

          {pb && pb.history.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <button onClick={() => setShowHistory((v) => !v)} style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}>
                {showHistory ? "Hide" : "Show"} earlier versions ({pb.history.length})
              </button>
              {showHistory && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  {pb.history.map((h, i) => (
                    <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 12.5, color: C.body, padding: "6px 10px", borderRadius: 6, background: C.zebra }}>
                      <span>{h.updatedAt ? `${when(h.updatedAt)}${h.updatedBy ? ` by ${h.updatedBy}` : ""}` : "The defaults"}</span>
                      <span style={{ color: C.faint }}>
                        {h.rules.length} rule{h.rules.length === 1 ? "" : "s"}, {h.facts.length} fact{h.facts.length === 1 ? "" : "s"}, {h.faq.length} answer{h.faq.length === 1 ? "" : "s"}
                      </span>
                      <button onClick={() => setDraft(body(h))} style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}>
                        Load into the editor
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {view === "test" && <TryIt token={token} groups={groups} ai={ai} onActivity={() => void load()} dirty={dirty} />}

      {view === "conversations" && (
        <>
          <div style={{ ...panel, marginTop: 14, padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
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
              Staff Trials
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
              <Transcript messages={open.messages} token={token} onAdopt={adopt} />
            </div>
          </div>
        )}
      </div>
        </>
      )}
    </>
  );
}

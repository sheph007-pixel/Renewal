import { useEffect, useRef, useState, type CSSProperties } from "react";
import { C, panel } from "@/lib/ui";
import Link from "@/lib/Link";
import { navigate } from "@/lib/router";
import { ATTACHMENT_ACCEPT, deleteFile, deleteThread, downloadFile, forgetMemory, loadFiles, loadMemory, loadThreads, rememberMemory, renameThread, uploadDocument, useChat, type ChatFile, type ChatThread, type MemoryLine } from "@/lib/chat";
import ChatPanel, { kindOf, sizeOf } from "@/views/ChatPanel";

interface Props {
  /** The conversation open, from the address; undefined is a fresh one. */
  threadId: number | undefined;
  /** The address of a conversation (or, with nothing, of a fresh one). */
  hrefFor: (thread?: number | null) => string;
}

/** "Today", "Yesterday", "This week", "Earlier" - how the list is grouped. */
function bucket(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  if (diff < 31) return "This month";
  return "Earlier";
}

function ThreadRow({ t, on, href, onRename, onDelete }: { t: ChatThread; on: boolean; href: string; onRename: (title: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title || "");
  useEffect(() => setTitle(t.title || ""), [t.title]);
  const commit = () => {
    setEditing(false);
    const v = title.trim();
    if (v && v !== t.title) onRename(v);
    else setTitle(t.title || "");
  };
  if (editing) {
    return (
      <div style={{ padding: "4px 6px" }}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setTitle(t.title || "");
              setEditing(false);
            }
          }}
          maxLength={120}
          style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", border: `1px solid ${C.blue}`, borderRadius: 6, outline: "none" }}
        />
      </div>
    );
  }
  return (
    <div className={`chat-thread${on ? " on" : ""}`} style={{ display: "flex", alignItems: "center", borderRadius: 7, background: on ? C.blueTint : "transparent" }}>
      <Link href={href} title={t.title || "Conversation"} style={{ flex: 1, minWidth: 0, display: "block", padding: "8px 10px", fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? C.blueInk : C.ink, textDecoration: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {t.title || "Conversation"}
      </Link>
      <span className="chat-thread-tools" style={{ display: "flex", flex: "none", paddingRight: 4 }}>
        <button onClick={() => setEditing(true)} title="Rename" aria-label="Rename" className="chat-tool">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
          </svg>
        </button>
        <button onClick={onDelete} title="Delete" aria-label="Delete" className="chat-tool">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </svg>
        </button>
      </span>
    </div>
  );
}

/**
 * The Assistant page: every conversation the group has had down the left,
 * the one open on the right, with room to read a comparison table. The
 * corner box on the other pages is the same conversations, smaller.
 */
/** A small head-and-spark mark for Memory, the way an assistant's memory is usually shown. */
function MemoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.5 3.5a4 4 0 0 0-4 4v1.2A3.5 3.5 0 0 0 4 12a3.5 3.5 0 0 0 1.5 2.9V16a4 4 0 0 0 4 4h.5V3.5h-.5Z" />
      <path d="M14.5 3.5a4 4 0 0 1 4 4v1.2A3.5 3.5 0 0 1 20 12a3.5 3.5 0 0 1-1.5 2.9V16a4 4 0 0 1-4 4H14V3.5h.5Z" />
      <path d="M12 3.5V20" />
    </svg>
  );
}

/**
 * Memory: what the assistant keeps in mind about the group between
 * conversations - the preferences the client has stated, and anything they
 * add here themselves. A button in the rail with a count; it opens a panel
 * listing every line with a way to remove it, and a box to add one. The
 * assistant records lines on its own as the client talks; this is where the
 * client sees, adds to and prunes them.
 */
function MemoryButton({ lines }: { lines: MemoryLine[] }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rememberMemory(text);
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={box} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="What the assistant remembers about you"
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${open ? C.blueEdge : C.hairline}`, background: open ? C.blueTint : C.card, color: C.ink, fontSize: 13, fontWeight: 500, cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ display: "grid", placeItems: "center", color: C.blue }}>
          <MemoryIcon />
        </span>
        <span style={{ flex: 1 }}>Memory</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: lines.length ? C.blueInk : C.faint, background: lines.length ? C.blueTint : C.zebra, border: `1px solid ${lines.length ? C.blueEdge : C.hairline}`, borderRadius: 10, padding: "1px 7px" }}>{lines.length}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Memory" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, width: 340, maxWidth: "calc(100vw - 32px)", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(11,33,56,0.18)", padding: "12px 12px 10px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>What the assistant remembers about you</div>
          <div style={{ marginTop: 2, fontSize: 11.5, color: C.faint, lineHeight: 1.45 }}>Its answers and recommendations follow these. It adds lines as you talk; you can add or remove any.</div>
          <div style={{ marginTop: 8, maxHeight: 260, overflowY: "auto" }}>
            {lines.length === 0 && <div style={{ padding: "8px 2px", fontSize: 12.5, color: C.muted }}>Nothing yet. Tell it what matters to you, or add a line below.</div>}
            {lines.map((m) => (
              <div key={m.id} className="chat-thread" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "5px 4px 5px 8px", borderRadius: 6, fontSize: 12.5, lineHeight: 1.45, color: C.body }}>
                <span style={{ flex: 1, minWidth: 0 }}>{m.text}</span>
                <button className="chat-tool chat-thread-tools" onClick={() => void forgetMemory(m.id)} title="Remove" aria-label="Remove" style={{ flex: "none" }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            style={{ marginTop: 8, display: "flex", gap: 6 }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add something to remember…"
              maxLength={300}
              aria-label="Add a memory"
              style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: "7px 10px", border: `1px solid ${C.inputEdge}`, borderRadius: 7, outline: "none" }}
            />
            <button type="submit" disabled={!draft.trim() || busy} style={{ padding: "7px 12px", fontSize: 12.5, fontWeight: 600, borderRadius: 7, border: `1px solid ${C.blue}`, background: C.blue, color: "#fff", cursor: draft.trim() && !busy ? "pointer" : "default", opacity: draft.trim() && !busy ? 1 : 0.5 }}>
              Add
            </button>
          </form>
          {error && <div style={{ marginTop: 6, fontSize: 12, color: C.red }}>{error}</div>}
        </div>
      )}
    </div>
  );
}

type Tab = "chat" | "documents";

/**
 * Documents: everything the assistant has made for the group - comparisons,
 * memos - and every file the group has attached or added here, in one
 * place, newest first, to download or remove. A file made in a
 * conversation links back to it.
 */
function Documents({ hrefFor }: { hrefFor: (thread?: number | null) => string }) {
  const chat = useChat();
  const [files, setFiles] = useState<ChatFile[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => loadFiles().then(setFiles).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  // A reply that just finished may have made a document.
  useEffect(() => {
    if (!chat.streaming) void refresh();
  }, [chat.streaming]);

  const add = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setBusy(true);
    setError("");
    try {
      for (const f of Array.from(list)) await uploadDocument(f);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = (f: ChatFile) => {
    if (!window.confirm(`Remove "${f.filename}"? This cannot be undone.`)) return;
    void deleteFile(f.id)
      .then(refresh)
      .catch((e: Error) => setError(e.message));
  };
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
  const from = (f: ChatFile) => (f.role === "assistant" ? "Made by the assistant" : f.threadId != null ? "Attached to a question" : "Added here");

  const th: CSSProperties = { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.4px", textTransform: "uppercase", color: C.faint, borderBottom: `1px solid ${C.hairline}`, whiteSpace: "nowrap" };
  const td: CSSProperties = { padding: "10px 12px", fontSize: 13, borderBottom: `1px solid ${C.hairline}`, verticalAlign: "middle" };
  const tool: CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: "6px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.card, color: C.blueInk, cursor: "pointer" };
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${C.hairline}` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>Documents</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>Everything the assistant has made for you, and anything you have added - kept here, to open any time.</div>
        </div>
        <input ref={input} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden onChange={(e) => void add(e.target.files)} />
        <button onClick={() => input.current?.click()} disabled={busy} style={{ ...tool, background: C.blue, color: "#fff", border: "none", padding: "8px 14px", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Adding…" : "+ Add a document"}
        </button>
      </div>
      {error && <div style={{ margin: "10px 18px 0", padding: "8px 12px", borderRadius: 7, background: C.redTint, color: C.red, fontSize: 12.5 }}>{error}</div>}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {files && files.length === 0 && (
          <div style={{ padding: "28px 18px", fontSize: 13, lineHeight: 1.6, color: C.muted }}>
            Nothing yet. A comparison or memo the assistant builds for you lands here, as does any file you attach to a question or add with the button above.
          </div>
        )}
        {files && files.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Document</th>
                <th style={th}>From</th>
                <th style={th}>Date</th>
                <th style={{ ...th, textAlign: "right" }}>Size</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td style={td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0, maxWidth: "100%" }}>
                      <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none", width: 30, height: 30, borderRadius: 6, background: C.blueTint, color: C.blueInk, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.3px" }}>{kindOf(f)}</span>
                      <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 420 }}>{f.filename}</span>
                    </span>
                  </td>
                  <td style={{ ...td, color: C.muted, fontSize: 12.5 }}>
                    {from(f)}
                    {f.threadId != null && (
                      <>
                        {" · "}
                        <Link href={hrefFor(f.threadId)} style={{ color: C.blueInk }}>{f.threadTitle || "Conversation"}</Link>
                      </>
                    )}
                  </td>
                  <td style={{ ...td, color: C.muted, fontSize: 12.5, whiteSpace: "nowrap" }}>{when(f.createdAt)}</td>
                  <td style={{ ...td, color: C.muted, fontSize: 12.5, textAlign: "right", whiteSpace: "nowrap" }}>{sizeOf(f.size)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button onClick={() => void downloadFile(`/api/chat/files/${f.id}`, f.filename).catch((e: Error) => setError(e.message))} style={tool}>Download</button>
                      <button onClick={() => remove(f)} style={{ ...tool, color: C.red }}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function Assistant({ threadId, hrefFor }: Props) {
  const chat = useChat();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("chat");
  // Opening a conversation (from a document's link, say) shows the chat.
  useEffect(() => setTab("chat"), [threadId]);

  useEffect(() => {
    loadThreads().catch(() => undefined);
    loadMemory().catch(() => undefined);
  }, []);

  // A thread that is gone (deleted here, or a stale link) falls back to a fresh one.
  useEffect(() => {
    if (threadId != null && chat.loaded && !chat.threads.some((t) => t.id === threadId)) navigate(hrefFor(null), { replace: true });
  }, [threadId, chat.loaded, chat.threads, hrefFor]);

  const q = query.trim().toLowerCase();
  const shown = q ? chat.threads.filter((t) => (t.title || "").toLowerCase().includes(q)) : chat.threads;
  const groups: { label: string; items: ChatThread[] }[] = [];
  for (const t of shown) {
    const label = bucket(t.updatedAt);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(t);
    else groups.push({ label, items: [t] });
  }

  const remove = (t: ChatThread) => {
    if (!window.confirm(`Delete "${t.title || "this conversation"}"? This cannot be undone.`)) return;
    void deleteThread(t.id).then(() => {
      if (t.id === threadId) navigate(hrefFor(null), { replace: true });
    });
  };

  // Two plain buttons side by side, the open one filled: both read as
  // clickable, and which is open is obvious at a glance.
  const tabStyle = (on: boolean): CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 22px", fontSize: 14, fontWeight: 600, color: on ? "#fff" : C.ink, background: on ? C.blue : C.card, border: `1px solid ${on ? C.blue : C.border}`, borderRadius: 8, cursor: "pointer", boxShadow: on ? "none" : "0 1px 2px rgba(16,24,40,0.05)" });
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div role="tablist" aria-label="Chat or Documents" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")} style={tabStyle(tab === "chat")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z" />
          </svg>
          Chat
        </button>
        <button role="tab" aria-selected={tab === "documents"} onClick={() => setTab("documents")} style={tabStyle(tab === "documents")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5M9 13h6M9 17h6" />
          </svg>
          Documents
        </button>
      </div>
    <div className="chat-page" style={{ ...panel, display: tab === "chat" ? "flex" : "none", overflow: "hidden", height: "calc(100vh - 200px)", minHeight: 480 }}>
      <aside className="chat-list" style={{ width: 260, flex: "none", display: "flex", flexDirection: "column", borderRight: `1px solid ${C.hairline}`, background: C.zebra }}>
        <div style={{ padding: "12px 12px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          <Link
            href={hrefFor(null)}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "9px 12px", borderRadius: 8, background: threadId == null ? C.blueInk : C.blue, color: "#fff", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Conversation
          </Link>
          <MemoryButton lines={chat.memory} />
          {chat.threads.length > 6 && (
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search conversations" style={{ fontSize: 12.5, padding: "7px 10px", border: `1px solid ${C.inputEdge}`, borderRadius: 7, outline: "none", background: C.card }} />
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px 12px" }}>
          {chat.loaded && chat.threads.length === 0 && (
            <div style={{ padding: "10px 8px", fontSize: 12.5, lineHeight: 1.55, color: C.muted }}>
              Nothing yet. Your conversations will be kept here, so you can pick one back up any time.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} style={{ marginTop: 8 }}>
              <div style={{ padding: "4px 10px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.4px", textTransform: "uppercase", color: C.faint }}>{g.label}</div>
              {g.items.map((t) => (
                <ThreadRow key={t.id} t={t} on={t.id === threadId} href={hrefFor(t.id)} onRename={(title) => void renameThread(t.id, title).catch(() => undefined)} onDelete={() => remove(t)} />
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <ChatPanel
          key={threadId ?? "new"}
          threadId={threadId ?? null}
          page="assistant"
          onThread={(id) => navigate(hrefFor(id), { replace: true })}
          autoFocus
          welcome="How can I help you?"
        />
      </div>
    </div>
      {tab === "documents" && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", overflow: "hidden", height: "calc(100vh - 200px)", minHeight: 480 }}>
          <Documents hrefFor={(t) => hrefFor(t)} />
        </div>
      )}
    </div>
  );
}

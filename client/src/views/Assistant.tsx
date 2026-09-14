import { useEffect, useState } from "react";
import { C, panel } from "@/lib/ui";
import Link from "@/lib/Link";
import { navigate } from "@/lib/router";
import { deleteThread, loadThreads, renameThread, useChat, type ChatThread } from "@/lib/chat";
import ChatPanel from "@/views/ChatPanel";

interface Props {
  /** The conversation open, from the address; undefined is a fresh one. */
  threadId: number | undefined;
  /** The address of a conversation (or, with nothing, of a fresh one). */
  hrefFor: (thread?: number | null) => string;
  groupName: string;
}

/** "Today", "Yesterday", "This week", "Earlier" — how the list is grouped. */
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
export default function Assistant({ threadId, hrefFor, groupName }: Props) {
  const chat = useChat();
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadThreads().catch(() => undefined);
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

  return (
    <div className="chat-page" style={{ ...panel, display: "flex", overflow: "hidden", height: "calc(100vh - 150px)", minHeight: 480 }}>
      <aside className="chat-list" style={{ width: 260, flex: "none", display: "flex", flexDirection: "column", borderRight: `1px solid ${C.hairline}`, background: C.zebra }}>
        <div style={{ padding: "12px 12px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          <Link
            href={hrefFor(null)}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "9px 12px", borderRadius: 8, background: threadId == null ? C.blueInk : C.blue, color: "#fff", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New conversation
          </Link>
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
          welcome={`Hi ${groupName} team — I'm the BenSync Assistant, part of your Kennion team. I have your current plans, the carriers' quotes and this month's billing in front of me. What would you like to know?`}
        />
      </div>
    </div>
  );
}

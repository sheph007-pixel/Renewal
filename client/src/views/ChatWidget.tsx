import { useEffect, useState } from "react";
import { C } from "@/lib/ui";
import Link from "@/lib/Link";
import { loadThreads, useChat } from "@/lib/chat";
import ChatPanel from "@/views/ChatPanel";

interface Props {
  /** Which portal page is open, passed to the assistant as context. */
  page: string;
  /** The Assistant page's address, for the "open in full" link. */
  assistantHref: (thread?: number | null) => string;
}

/** Where the box remembers being open, per browser. */
const OPEN_KEY = "kennion.chat.open";

const SUGGEST = ["What's changing for my group in 2027?", "Which quoted option is closest to what we have now?", "What do we spend on medical today?"];

/**
 * The chat box in the corner of every page. It opens on the most recent
 * conversation, so a question from one page can be carried on from the next,
 * and a new one is a click away. The Assistant page is the same
 * conversations with room to read.
 */
export default function ChatWidget({ page, assistantHref }: Props) {
  const chat = useChat();
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** Null: the newest thread, or a fresh one when there is none. */
  const [threadId, setThreadId] = useState<number | null | "new">(null);

  useEffect(() => {
    if (open && !chat.loaded) loadThreads().catch(() => undefined);
  }, [open, chat.loaded]);

  const toggle = () => {
    setOpen((v) => {
      try {
        sessionStorage.setItem(OPEN_KEY, v ? "0" : "1");
      } catch {
        // Storage blocked: the box still opens for this page load.
      }
      return !v;
    });
  };

  const current: number | null = threadId === "new" ? null : threadId != null ? threadId : chat.threads[0]?.id ?? null;
  const title = current != null ? chat.threads.find((t) => t.id === current)?.title || "Conversation" : "New conversation";

  return (
    <>
      {open && (
        <div className="chat-box noprint" role="dialog" aria-label="BenSync Assistant" style={{ background: C.card, border: `1px solid ${C.border}`, boxShadow: "0 16px 48px rgba(15,42,71,0.22)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 10px 14px", borderBottom: `1px solid ${C.hairline}`, background: C.navy, color: "#fff" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>Assistant</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
            </div>
            <button className="chat-hbtn" onClick={() => setThreadId("new")} title="New conversation" aria-label="New conversation">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <Link className="chat-hbtn" href={assistantHref(current)} title="Open the Assistant page" aria-label="Open the Assistant page" onClick={() => setOpen(false)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 4h6v6M20 4l-9 9M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
              </svg>
            </Link>
            <button className="chat-hbtn" onClick={toggle} title="Close" aria-label="Close">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ChatPanel
              key={current ?? "new"}
              threadId={current}
              page={page}
              onThread={(id) => setThreadId(id)}
              suggestions={SUGGEST}
              compact
              autoFocus
              welcome="Hi — I'm the BenSync Assistant, part of your Kennion team. Ask me anything about your plans, your 2027 options, or your renewal."
            />
          </div>
        </div>
      )}
      <button
        className="chat-fab noprint"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? "Close the assistant" : "Ask the assistant"}
        title={open ? "Close" : "Ask the assistant"}
        style={{ background: C.navy, color: "#fff", boxShadow: "0 8px 24px rgba(15,42,71,0.32)" }}
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z" />
            <path d="M8.5 8.5h7M8.5 11.5h4.5" />
          </svg>
        )}
      </button>
    </>
  );
}

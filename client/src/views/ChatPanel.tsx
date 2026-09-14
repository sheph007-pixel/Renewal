import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { C } from "@/lib/ui";
import { loadThread, sendMessage, useChat, type ChatFile, type ChatMessage } from "@/lib/chat";
import Markdown from "@/views/Markdown";

const KIND: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
};
const sizeOf = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

/** A document the assistant made, as a download. */
export function FileChips({ files, href }: { files: ChatFile[]; href: (f: ChatFile) => string }) {
  if (!files.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {files.map((f) => (
        <a key={f.id} className="chat-file" href={href(f)} download={f.filename} style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "7px 12px 7px 9px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.card, color: C.ink, textDecoration: "none", maxWidth: "100%" }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none", width: 28, height: 28, borderRadius: 6, background: C.blueTint, color: C.blueInk, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.3px" }}>
            {KIND[f.mime] || "FILE"}
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }}>{f.filename}</span>
            <span style={{ display: "block", fontSize: 11, color: C.muted }}>{sizeOf(f.size)} · Download</span>
          </span>
        </a>
      ))}
    </div>
  );
}

interface Props {
  /** The conversation shown; null is a fresh one, opened on the first question. */
  threadId: number | null;
  /** Which portal page the question is asked from, for the assistant's context. */
  page: string;
  /** The server opened a thread for a first question: show it. */
  onThread: (id: number) => void;
  /** Questions offered on an empty conversation. */
  suggestions?: string[];
  /** The corner box: tighter type and spacing than the full page. */
  compact?: boolean;
  /** Something to say above the first question, when the thread is empty. */
  welcome?: string;
  /** Where the composer's focus starts. */
  autoFocus?: boolean;
}

/** A small "N" mark, the assistant's avatar beside its answers. */
function Mark({ size = 22 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{ display: "grid", placeItems: "center", flex: "none", width: size, height: size, borderRadius: "50%", background: C.navy, color: C.teal, fontSize: size * 0.5, fontWeight: 700, letterSpacing: "0.3px" }}
    >
      B
    </span>
  );
}

function Typing() {
  return (
    <span className="chat-typing" aria-label="Thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * One conversation: the turns so far, the answer streaming in, and the
 * composer. Shared by the corner box and the Assistant page, so a thread
 * reads the same in both.
 */
export default function ChatPanel({ threadId, page, onThread, suggestions = [], compact = false, welcome, autoFocus }: Props) {
  const chat = useChat();
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const messages: ChatMessage[] = threadId != null ? chat.messages[threadId] || [] : [];
  const streaming = chat.streaming && chat.streaming.threadId === threadId ? chat.streaming : chat.streaming && threadId == null && chat.streaming.threadId == null ? chat.streaming : null;
  const busy = !!chat.streaming;
  const loading = threadId != null && !chat.messages[threadId];

  useEffect(() => {
    if (threadId == null) return;
    setLoadError("");
    loadThread(threadId).catch((e: Error) => setLoadError(e.message));
  }, [threadId]);

  // Keep the newest text in view as it arrives.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming?.text, threadId]);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus, threadId]);

  const ask = (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    setDraft("");
    void sendMessage(threadId, content, page, onThread).catch(() => undefined);
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(draft);
    }
  };

  const fs = compact ? 13 : 14;
  const empty = !loading && messages.length === 0 && !streaming;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div ref={scroller} className="chat-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: compact ? "14px 14px 6px" : "18px 22px 8px" }}>
        {loading && !loadError && <div style={{ fontSize: 12.5, color: C.muted, padding: "8px 0" }}>Opening the conversation…</div>}
        {loadError && <div style={{ fontSize: 12.5, color: C.red, padding: "8px 0" }}>{loadError}</div>}
        {empty && (
          <div style={{ padding: compact ? "4px 0 8px" : "10px 0 14px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <Mark size={compact ? 24 : 28} />
              <div style={{ fontSize: fs, lineHeight: 1.55, color: C.body, maxWidth: 560 }}>
                {welcome || "Ask about your plans today, your options, what a contribution change would cost, or anything else about your renewal."}
              </div>
            </div>
            {suggestions.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12, paddingLeft: compact ? 0 : 38 }}>
                {suggestions.map((s) => (
                  <button key={s} className="chat-suggest" onClick={() => ask(s)} disabled={busy} style={{ fontSize: compact ? 12 : 12.5, padding: "6px 11px", borderRadius: 999, border: `1px solid ${C.blueEdge}`, background: C.blueTint, color: C.blueInk, cursor: "pointer", textAlign: "left" }}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} style={{ display: "flex", justifyContent: "flex-end", margin: "10px 0" }}>
              <div style={{ maxWidth: "85%", padding: compact ? "8px 12px" : "9px 14px", borderRadius: 14, borderBottomRightRadius: 4, background: C.navy, color: "#fff", fontSize: fs, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, margin: "12px 0" }}>
              <Mark size={compact ? 22 : 26} />
              <div className="chat-answer" style={{ minWidth: 0, flex: 1, fontSize: fs, lineHeight: 1.55, color: C.ink }}>
                <Markdown text={m.content} />
                <FileChips files={m.files || []} href={(f) => `/api/chat/files/${f.id}`} />
              </div>
            </div>
          ),
        )}
        {streaming && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, margin: "12px 0" }}>
            <Mark size={compact ? 22 : 26} />
            <div className="chat-answer" style={{ minWidth: 0, flex: 1, fontSize: fs, lineHeight: 1.55, color: C.ink }}>
              {streaming.text ? <Markdown text={streaming.text} /> : !streaming.status ? <Typing /> : null}
              {streaming.status && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: streaming.text ? 8 : 0, fontSize: 12.5, color: C.muted }}>
                  <Typing />
                  {streaming.status}
                </div>
              )}
              <FileChips files={streaming.files} href={(f) => `/api/chat/files/${f.id}`} />
            </div>
          </div>
        )}
        {chat.error && !streaming && (
          <div role="alert" style={{ margin: "8px 0", padding: "8px 12px", borderRadius: 8, background: C.redTint, border: `1px solid ${C.redEdge}`, color: C.red, fontSize: 12.5 }}>
            {chat.error}
          </div>
        )}
      </div>
      <div style={{ flex: "none", padding: compact ? "8px 12px 12px" : "10px 22px 16px", borderTop: `1px solid ${C.hairline}` }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, border: `1px solid ${C.inputEdge}`, borderRadius: 12, padding: "6px 6px 6px 12px", background: C.card }}>
          <textarea
            ref={input}
            className="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={messages.length ? "Keep the conversation going…" : "Ask a question…"}
            rows={1}
            maxLength={4000}
            disabled={busy && threadId == null}
            style={{ flex: 1, resize: "none", border: "none", outline: "none", background: "transparent", fontSize: fs, lineHeight: 1.45, color: C.ink, maxHeight: 140, padding: "6px 0" }}
          />
          <button
            onClick={() => ask(draft)}
            disabled={busy || !draft.trim()}
            aria-label="Send"
            title="Send (Enter)"
            style={{ flex: "none", width: 32, height: 32, borderRadius: 9, border: "none", background: busy || !draft.trim() ? C.hairline : C.blue, color: busy || !draft.trim() ? C.ghost : "#fff", cursor: busy || !draft.trim() ? "default" : "pointer", display: "grid", placeItems: "center" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
        {!compact && (
          <div style={{ marginTop: 6, fontSize: 11, color: C.faint }}>
            Answers come from your group&rsquo;s own figures on this site. For a decision, loop in your account manager.
          </div>
        )}
      </div>
    </div>
  );
}

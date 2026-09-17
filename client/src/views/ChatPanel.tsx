import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { C } from "@/lib/ui";
import { ATTACHMENT_ACCEPT, loadThread, sendMessage, uploadAttachment, useChat, type ChatFile, type ChatMessage } from "@/lib/chat";
import Markdown from "@/views/Markdown";
import { groupHeaders } from "@/lib/session";

const KIND: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
};
export const sizeOf = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

export const kindOf = (f: ChatFile) => KIND[f.mime] || (/^image\//.test(f.mime) ? "IMG" : /csv|text\/plain/.test(f.mime) ? "TXT" : "FILE");

/**
 * Fetch a file with extra headers and hand it to the browser as a download - 
 * for the admin, whose routes want the staff token a plain link cannot send.
 */
async function downloadWith(url: string, filename: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Could not download (${r.status})`);
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** A document the assistant made, or one the client attached, as a download. */
export function FileChips({ files, href, align = "left", headers }: { files: ChatFile[]; href: (f: ChatFile) => string; align?: "left" | "right"; headers?: Record<string, string> }) {
  if (!files.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, justifyContent: align === "right" ? "flex-end" : "flex-start" }}>
      {files.map((f) => (
        <a key={f.id} className="chat-file" href={href(f)} download={f.filename} onClick={headers ? (e) => {
          e.preventDefault();
          void downloadWith(href(f), f.filename, headers).catch((err: Error) => window.alert(err.message));
        } : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "7px 12px 7px 9px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.card, color: C.ink, textDecoration: "none", maxWidth: "100%" }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none", width: 28, height: 28, borderRadius: 6, background: C.blueTint, color: C.blueInk, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.3px" }}>
            {kindOf(f)}
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

/** A file waiting to go with the next question, with a way to take it back. */
function PendingChip({ f, uploading, onRemove }: { f: { name: string; size: number }; uploading: boolean; onRemove: () => void }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 6px 5px 10px", borderRadius: 8, border: `1px solid ${C.blueEdge}`, background: C.blueTint, color: C.blueInk, fontSize: 12, maxWidth: "100%" }}>
      <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>{f.name}</span>
      <span style={{ color: C.muted, flex: "none" }}>{uploading ? "uploading…" : sizeOf(f.size)}</span>
      <button onClick={onRemove} aria-label={`Remove ${f.name}`} title="Remove" style={{ flex: "none", width: 20, height: 20, borderRadius: 5, border: "none", background: "transparent", color: C.blueInk, cursor: "pointer", display: "grid", placeItems: "center" }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </span>
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
  /** Files picked for the next question: uploaded as soon as they are chosen. */
  const [pending, setPending] = useState<{ key: number; name: string; size: number; file: ChatFile | null; error?: string }[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

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

  const uploading = pending.some((p) => !p.file && !p.error);
  const attachments = pending.map((p) => p.file).filter((f): f is ChatFile => !!f);

  const pick = (list: FileList | null) => {
    if (!list) return;
    const room = Math.max(0, 5 - pending.length);
    Array.from(list)
      .slice(0, room)
      .forEach((file) => {
        const key = Date.now() + Math.random();
        setPending((ps) => [...ps, { key, name: file.name, size: file.size, file: null }]);
        uploadAttachment(file)
          .then((f) => setPending((ps) => ps.map((p) => (p.key === key ? { ...p, file: f } : p))))
          .catch((e: Error) => setPending((ps) => ps.map((p) => (p.key === key ? { ...p, error: e.message } : p))));
      });
    if (picker.current) picker.current.value = "";
  };

  const ask = (text: string) => {
    const content = text.trim();
    if ((!content && !attachments.length) || busy || uploading) return;
    setDraft("");
    setPending([]);
    void sendMessage(threadId, content || `Please look at ${attachments.map((f) => f.filename).join(", ")}.`, page, onThread, compact, attachments).catch(() => undefined);
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
            <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", margin: "6px 0" }}>
              <div className="chat-bubble me" style={{ maxWidth: "80%", padding: compact ? "8px 13px" : "9px 15px", borderRadius: 18, borderBottomRightRadius: 5, background: "#0B84FE", color: "#fff", fontSize: fs, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {m.content}
              </div>
              <FileChips files={m.files || []} href={(f) => `/api/chat/files/${f.id}`} align="right" headers={groupHeaders()} />
            </div>
          ) : (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", margin: "6px 0" }}>
              <div className="chat-answer chat-bubble them" style={{ maxWidth: "85%", minWidth: 0, padding: compact ? "8px 13px" : "9px 15px", borderRadius: 18, borderBottomLeftRadius: 5, background: "#E9E9EB", fontSize: fs, lineHeight: 1.45, color: "#1c1c1e", wordBreak: "break-word" }}>
                <Markdown text={m.content} />
              </div>
              <FileChips files={m.files || []} href={(f) => `/api/chat/files/${f.id}`} headers={groupHeaders()} />
            </div>
          ),
        )}
        {streaming && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", margin: "6px 0" }}>
            <div className="chat-answer chat-bubble them" style={{ maxWidth: "85%", minWidth: 0, padding: compact ? "8px 13px" : "9px 15px", borderRadius: 18, borderBottomLeftRadius: 5, background: "#E9E9EB", fontSize: fs, lineHeight: 1.45, color: "#1c1c1e", wordBreak: "break-word" }}>
              {streaming.text ? <Markdown text={streaming.text} /> : !streaming.status ? <Typing /> : null}
              {streaming.status && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: streaming.text ? 8 : 0, fontSize: 12.5, color: C.muted }}>
                  <Typing />
                  {streaming.status}
                </div>
              )}
            </div>
            <FileChips files={streaming.files} href={(f) => `/api/chat/files/${f.id}`} headers={groupHeaders()} />
          </div>
        )}
        {chat.error && !streaming && (
          <div role="alert" style={{ margin: "8px 0", padding: "8px 12px", borderRadius: 8, background: C.redTint, border: `1px solid ${C.redEdge}`, color: C.red, fontSize: 12.5 }}>
            {chat.error}
          </div>
        )}
      </div>
      <div style={{ flex: "none", padding: compact ? "8px 12px 12px" : "10px 22px 16px", borderTop: `1px solid ${C.hairline}`, background: "#F6F6F7" }}>
        {pending.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {pending.map((p) =>
              p.error ? (
                <span key={p.key} role="alert" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 10px", borderRadius: 8, border: `1px solid ${C.redEdge}`, background: C.redTint, color: C.red, fontSize: 12 }}>
                  {p.error}
                  <button onClick={() => setPending((ps) => ps.filter((x) => x.key !== p.key))} aria-label="Dismiss" style={{ border: "none", background: "transparent", color: C.red, cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}>
                    &times;
                  </button>
                </span>
              ) : (
                <PendingChip key={p.key} f={p} uploading={!p.file} onRemove={() => setPending((ps) => ps.filter((x) => x.key !== p.key))} />
              ),
            )}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, border: "1px solid #D5D5DA", borderRadius: 22, padding: 5, background: "#fff" }}>
          <input ref={picker} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden onChange={(e) => pick(e.target.files)} />
          <button
            onClick={() => picker.current?.click()}
            disabled={busy || pending.length >= 5}
            aria-label="Attach a file"
            title="Attach a file - a quote, a spreadsheet, a screenshot"
            style={{ flex: "none", width: 34, height: 34, borderRadius: "50%", border: "none", background: "transparent", color: busy ? C.ghost : C.muted, cursor: busy ? "default" : "pointer", display: "grid", placeItems: "center" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a1.5 1.5 0 0 1-2.1-2.1L16 6.7" />
            </svg>
          </button>
          <textarea
            ref={input}
            className="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            aria-label="Message"
            rows={1}
            maxLength={4000}
            disabled={busy && threadId == null}
            style={{ flex: 1, resize: "none", border: "none", outline: "none", background: "transparent", fontSize: fs + 1, lineHeight: 1.5, color: C.ink, minHeight: 36, maxHeight: 180, padding: "7px 8px" }}
          />
          <button
            onClick={() => ask(draft)}
            disabled={busy || uploading || (!draft.trim() && !attachments.length)}
            aria-label="Send"
            title="Send (Enter)"
            style={(() => {
              const off = busy || uploading || (!draft.trim() && !attachments.length);
              return { flex: "none", width: 34, height: 34, borderRadius: "50%", border: "none", background: off ? "#D5D5DA" : "#0B84FE", color: off ? C.ghost : "#fff", cursor: off ? "default" : "pointer", display: "grid", placeItems: "center" };
            })()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
        <div style={{ textAlign: "center", fontSize: compact ? 10.5 : 11.5, color: C.faint, marginTop: 6, lineHeight: 1.3 }}>AI can make mistakes. Please verify important information.</div>
      </div>
    </div>
  );
}

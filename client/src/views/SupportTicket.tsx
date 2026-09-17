import { useEffect, useRef, useState } from "react";
import { groupHeaders } from "@/lib/session";
import { C, h2, panel, primaryBtn, textInput } from "@/lib/ui";

const PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const;
const MAX_FILE = 8 * 1024 * 1024;

/**
 * A support ticket without leaving the portal: priority, the email we should
 * reply to, a subject, a description and one optional attachment. It posts
 * to the server, which stores it and emails Kennion. The group is known from
 * the session, so the client never has to say who they are.
 */
export default function SupportTicket({ onClose }: { onClose: () => void }) {
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("Low");
  const [requester, setRequester] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<{ name: string; base64: string; size: number } | null>(null);
  const [fileError, setFileError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ ref: string } | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requester.trim());
  const canSend = emailOk && subject.trim() && description.trim() && !busy;

  const pick = (f: File | undefined) => {
    setFileError("");
    if (!f) return setFile(null);
    if (f.size > MAX_FILE) return setFileError("Attachments up to 8 MB.");
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      setFile({ name: f.name, base64: url.slice(url.indexOf(",") + 1), size: f.size });
    };
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/group/support", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...groupHeaders() },
        body: JSON.stringify({ priority, requester: requester.trim(), subject: subject.trim(), description: description.trim(), file: file ? { name: file.name, base64: file.base64 } : null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not send that. Try again.");
      setDone({ ref: body.ref || `BS-${1000 + Number(body.id || 0)}` });
    } catch (e) {
      setError((e as Error).message || "Could not send that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const label = { display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 } as const;
  const field = { ...textInput, width: "100%", fontSize: 13.5 } as const;

  return (
    <div role="dialog" aria-modal="true" aria-label="Submit A Ticket" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(11,33,56,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, width: "min(540px, 100%)", maxHeight: "92vh", overflow: "auto", padding: "22px 24px 24px", position: "relative", color: C.ink }}>
        <button onClick={onClose} aria-label="Close" style={{ position: "absolute", top: 10, right: 12, background: "none", border: "none", fontSize: 22, lineHeight: 1, color: C.muted, cursor: "pointer" }}>
          ×
        </button>
        {done ? (
          <div style={{ textAlign: "center", padding: "18px 6px 8px" }}>
            <div style={{ fontSize: 34, color: C.blue }}>✓</div>
            <h2 style={{ ...h2, margin: "6px 0 6px", fontSize: 19 }}>Ticket Sent</h2>
            <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
              Reference <b>{done.ref}</b>. We will reply to {requester.trim()}.
            </p>
            <button onClick={onClose} style={{ ...primaryBtn, marginTop: 18 }}>
              Done
            </button>
          </div>
        ) : (
          <>
            <h2 style={{ ...h2, margin: "0 0 2px", fontSize: 19 }}>Submit A Ticket</h2>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Goes straight to your Kennion team. We reply by email.</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label htmlFor="ticket-priority" style={label}>
                  Priority
                </label>
                <select id="ticket-priority" value={priority} onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])} style={{ ...field, height: 38 }}>
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ticket-email" style={label}>
                  Your Email <span style={{ color: C.red }}>*</span>
                </label>
                <input ref={first} id="ticket-email" type="email" autoComplete="email" value={requester} onChange={(e) => setRequester(e.target.value)} placeholder="you@company.com" style={field} />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <label htmlFor="ticket-subject" style={label}>
                Subject <span style={{ color: C.red }}>*</span>
              </label>
              <input id="ticket-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="What do you need help with?" style={field} />
            </div>

            <div style={{ marginTop: 12 }}>
              <label htmlFor="ticket-description" style={label}>
                Description <span style={{ color: C.red }}>*</span>
              </label>
              <textarea id="ticket-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} placeholder="The more detail, the faster we can help." style={{ ...field, resize: "vertical", lineHeight: 1.5 }} />
            </div>

            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label style={{ ...primaryBtn, background: C.card, color: C.blue, border: `1px solid ${C.blueEdge}`, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}>
                {file ? "Change File" : "Attach A File"}
                <input type="file" onChange={(e) => pick(e.target.files?.[0])} style={{ display: "none" }} />
              </label>
              {file && (
                <span style={{ fontSize: 12.5, color: C.body }}>
                  {file.name} · {(file.size / 1024).toFixed(0)} KB{" "}
                  <button onClick={() => setFile(null)} style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 12.5, padding: 0 }}>
                    Remove
                  </button>
                </span>
              )}
              {fileError && <span style={{ fontSize: 12.5, color: C.red }}>{fileError}</span>}
            </div>

            {error && (
              <div role="alert" style={{ marginTop: 12, padding: "9px 12px", background: C.redTint, border: `1px solid ${C.redEdge}`, borderRadius: 6, fontSize: 13, color: C.red }}>
                {error}
              </div>
            )}

            <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ ...primaryBtn, background: C.card, color: C.body, border: `1px solid ${C.inputEdge}` }}>
                Cancel
              </button>
              <button onClick={submit} disabled={!canSend} style={{ ...primaryBtn, opacity: canSend ? 1 : 0.55 }}>
                {busy ? "Sending…" : "Submit"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

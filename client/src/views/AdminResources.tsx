import { useEffect, useRef, useState } from "react";
import { C, panel, th, td } from "@/lib/ui";

/** The vendors Claude files a resource under; kept in sync with CARRIERS in server/index.js. */
const CARRIERS = ["UnitedHealthcare", "Gravie", "Nationwide", "Angle Health", "Cobalt", "Optimyl Health", "HealthEZ", "EBPA", "BCBS of Alabama", "Guardian", "VSP", "Other"];

interface Resource {
  id: number;
  carrier: string;
  title: string;
  summary: string | null;
  filename: string;
  mime: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: string;
}

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const fmtWhen = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * One resource, editable in place: a title box and a carrier dropdown that
 * post a correction the moment they change, and a delete button. Nothing
 * here needs a save button - the same immediate-write pattern the plan
 * catalogue and carrier logos already use.
 */
function ResourceRow({ r, token, onChanged }: { r: Resource; token: string; onChanged: () => void }) {
  const [title, setTitle] = useState(r.title);
  const [busy, setBusy] = useState(false);

  async function patch(fields: Partial<Pick<Resource, "carrier" | "title">>) {
    setBusy(true);
    try {
      await fetch(`/api/admin/resources/${r.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove "${r.title}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/resources/${r.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr style={{ opacity: busy ? 0.6 : 1 }}>
      <td style={td}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== r.title && void patch({ title: title.trim() })}
          disabled={busy}
          style={{ width: "100%", padding: "4px 6px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 3 }}
        />
        {r.summary && <div style={{ marginTop: 2, fontSize: 11.5, color: C.faint }}>{r.summary}</div>}
      </td>
      <td style={td}>
        <select value={r.carrier} disabled={busy} onChange={(e) => void patch({ carrier: e.target.value })} style={{ padding: "4px 6px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 3 }}>
          {CARRIERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td style={{ ...td, color: C.faint }}>
        <a href={`/api/resources/${r.id}/file`} target="_blank" rel="noreferrer" style={{ color: C.blue }}>
          {r.filename}
        </a>{" "}
        ({fmtSize(r.size)})
      </td>
      <td style={{ ...td, color: C.faint, whiteSpace: "nowrap" }}>
        {fmtWhen(r.uploadedAt)}
        {r.uploadedBy ? ` · ${r.uploadedBy}` : ""}
      </td>
      <td style={td}>
        <button type="button" onClick={() => void remove()} disabled={busy} style={{ background: "none", border: 0, color: C.red, cursor: "pointer", fontSize: 13, padding: 0 }}>
          Remove
        </button>
      </td>
    </tr>
  );
}

/**
 * Resources: marketing material for the client-facing Resources page - not
 * a plan document or a proposal. Upload a file and Claude reads it, says
 * which vendor it is for and gives it a title, and it is live on the shared
 * page immediately; a wrong guess is fixed right here, in the row.
 */
export default function AdminResources({ token }: { token: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function load() {
    const r = await fetch("/api/resources");
    if (r.ok) setResources((await r.json()).resources);
  }
  useEffect(() => {
    void load();
  }, []);

  async function upload(f: File) {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const r = await fetch(`/api/admin/resources?filename=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": f.type || "application/octet-stream" },
        body: f,
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      if (!r.ok) throw new Error(j.error || `Server returned ${r.status}.`);
      setDone(`"${j.title}" filed under ${j.carrier}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <div style={{ ...panel, marginTop: 16, padding: "14px 22px" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>Resources</div>
      <div style={{ marginTop: 6, fontSize: 13, color: C.body, lineHeight: 1.6, maxWidth: 840 }}>
        Marketing material for the client-facing Resources page - broker decks, one-pagers, FAQs. Upload a file and
        Claude reads it, says which vendor it is for and gives it a short title, and it goes live on that page
        immediately - the same page every group sees. Fix a wrong guess right in the row below, or remove it.
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, color: C.body }}>
        <input ref={ref} type="file" aria-label="Marketing material" disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        {busy && <span style={{ color: C.faint }}>Reading…</span>}
        {done && <span style={{ color: C.green }}>{done}</span>}
        {error && <span style={{ color: C.red }}>{error}</span>}
      </div>
      {resources && !resources.length && <div style={{ marginTop: 10, fontSize: 13, color: C.faint }}>Nothing uploaded yet.</div>}
      {resources && resources.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr>
              <th style={th}>Title</th>
              <th style={th}>Vendor</th>
              <th style={th}>File</th>
              <th style={th}>Uploaded</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <ResourceRow key={r.id} r={r} token={token} onChanged={() => void load()} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

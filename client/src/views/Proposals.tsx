import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { C, money0, panel } from "@/lib/importui";
import { pill } from "@/lib/ui";
import Link from "@/lib/Link";
import { PATHS, groupPath } from "@/lib/router";
import type { AdminGroup } from "@/views/GroupsTable";

/** One uploaded carrier proposal, as the server lists it (no file bytes). */
export interface Proposal {
  id: number;
  group_name: string | null;
  carrier: string | null;
  filename: string;
  mime: string;
  size: number;
  extracted: Extraction | null;
  summary: string | null;
  confidence: number | null;
  status: "analyzing" | "assigned" | "suggested" | "unassigned" | "container";
  assigned_by: string | null;
  error: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  updated_at: string;
  /** file: uploaded directly · email: an uploaded email · attachment: pulled out of one */
  kind?: "file" | "email" | "attachment";
  /** Which of the group's proposal slots this fills. */
  slot?: string | null;
  /** Set when a newer proposal in the same slot replaced this one. */
  superseded_by?: number | null;
  parent_id?: number | null;
  context?: { subject?: string; from?: string; date?: string | null; body?: string; emailFilename?: string } | null;
}

interface Extraction {
  carrier?: string;
  /** False for an ancillary-only document — it fills no slot. */
  quotes_medical?: boolean;
  group_name_on_document?: string | null;
  matched_group?: string | null;
  confidence?: number;
  effective_date?: string | null;
  proposal_type?: string;
  enrolled_on_document?: number | null;
  quote_id?: string | null;
  plans?: {
    name: string;
    /** The carrier's code for the plan, where one is printed. */
    plan_code?: string | null;
    /** The network it is priced on, where the quote distinguishes them. */
    network?: string | null;
    plan_type?: string | null;
    deductible?: string | null;
    oop_max?: string | null;
    rates?: { EE?: number | null; ES?: number | null; EC?: number | null; FAM?: number | null };
    monthly_total?: number | null;
  }[];
  total_monthly?: number | null;
  summary?: string;
  audit_flags?: string[];
}

const ACCEPT =
  ".pdf,.eml,.msg,.xlsx,.xlsm,.xls,.csv,.txt,.docx,.png,.jpg,.jpeg,.gif,.webp,application/pdf,message/rfc822,application/vnd.ms-outlook,text/csv,text/plain,image/*";

/** Rows that are proposals in their own right — not an email wrapper. */
const isProposal = (p: Proposal) => p.status !== "container";

/** The slots a group can hold; the first four are the ones tracked per group. */
/**
 * The medical proposals a group can hold, one per slot, and nothing else.
 * Surest is a UnitedHealthcare product, so a Surest quote is that group's UHC
 * proposal; an ancillary-only document fills no slot. A newer proposal in a
 * slot replaces the older one, which is kept for the record.
 */
export const SLOTS = ["UHC Fully Insured", "UHC Level Funded", "Gravie", "Nationwide", "Angle", "Cobalt"] as const;
const TRACKED = SLOTS;
const isCurrent = (p: Proposal) => p.status === "assigned" && !p.superseded_by;

/**
 * An ancillary proposal — dental, vision, life, disability — quotes no medical
 * rates, so it fills no slot and is kept apart from the group health quotes
 * the 2027 options are built from.
 */
const isAncillary = (p: Proposal) => {
  const x = p.extracted;
  if (!x) return false;
  if (typeof x.quotes_medical === "boolean") return !x.quotes_medical;
  // Read before the question was asked: the document itself is the evidence.
  const text = `${p.filename} ${p.summary || ""} ${x.proposal_type || ""}`;
  if (/\bancillar(y|ies)\b/i.test(text)) return true;
  const rated = (x.plans || []).some((pl) => Object.values(pl.rates || {}).some((v) => v != null));
  return !rated && /\b(dental|vision|life|ad&d|disability|std|ltd|accident|critical illness|hospital indemnity)\b/i.test(text);
};
/** A group health proposal that has been read but has no slot: staff say which. */
const needsSlot = (p: Proposal) =>
  p.status === "assigned" && !!p.group_name && !p.slot && !isAncillary(p) && !!p.extracted;

/** "2027-01-01" → "1/1/27", for a grid cell. */
const fmtDay = (s: string) => {
  const d = new Date(`${s.slice(0, 10)}T00:00:00`);
  return isNaN(+d) ? s : d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
};

const gridTh: CSSProperties = {
  padding: "8px 6px",
  fontSize: 11.5,
  fontWeight: 600,
  color: C.muted,
  textTransform: "uppercase",
  letterSpacing: ".3px",
  textAlign: "center",
  borderBottom: `1px solid ${C.border}`,
  whiteSpace: "nowrap",
};

const gridFilter: CSSProperties = {
  padding: "7px 10px",
  fontSize: 13,
  color: C.ink,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
};

const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
const fmtWhen = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const money = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(2)}`);

/** The status pill: who assigned it, or what is still needed. */
function StatusPill({ p }: { p: Proposal }) {
  if (p.status === "container") return <span style={pill(C.body, "#f2f4f5", "#e0e4e6")}>Email</span>;
  if (p.status === "analyzing") return <span style={pill(C.blue, C.blueTint, C.blueEdge)}>Reading…</span>;
  if (p.superseded_by) return <span style={pill(C.faint, "#f2f4f5", "#e0e4e6")}>Superseded</span>;
  if (p.error && !p.group_name) return <span style={pill(C.red, C.redTint, C.redEdge)}>Could not read</span>;
  if (p.status === "unassigned") return <span style={pill(C.amber, C.amberTint, C.amberEdge)}>Needs assignment</span>;
  if (p.status === "suggested") return <span style={pill(C.amber, C.amberTint, C.amberEdge)}>AI suggests — confirm</span>;
  if (p.assigned_by === "ai") return <span style={pill(C.green, C.greenTint, C.greenEdge)}>Assigned by AI</span>;
  return <span style={pill(C.green, C.greenTint, C.greenEdge)}>Assigned</span>;
}

/** Upload files one at a time; the server stores each and reads it after. */
async function uploadFiles(
  files: File[],
  token: string,
  group: string | null,
  onEach: (name: string, ok: boolean, msg?: string) => void,
  slot?: string | null,
) {
  for (const f of files) {
    const mime = f.type || (f.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");
    const q = new URLSearchParams({ filename: f.name });
    if (group) q.set("group", group);
    if (group && slot) q.set("slot", slot);
    try {
      const r = await fetch(`/api/admin/proposals?${q}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
        body: f,
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      const n = Array.isArray(j.proposals) ? j.proposals.filter((p: Proposal) => p.status !== "container").length : 1;
      const note = r.ok
        ? (j.proposals?.some((p: Proposal) => p.kind === "email")
            ? `email opened · ${n} attachment${n === 1 ? "" : "s"} to read`
            : "uploaded") + (j.skipped?.length ? ` · skipped ${j.skipped.join(", ")}` : "")
        : j.error;
      onEach(f.name, r.ok, note);
    } catch (e) {
      onEach(f.name, false, (e as Error).message);
    }
  }
}

const dropZone = (active: boolean): CSSProperties => ({
  border: `2px dashed ${active ? C.blue : C.inputEdge}`,
  background: active ? C.blueTint : "#fff",
  borderRadius: 6,
  padding: "22px 20px",
  textAlign: "center",
  cursor: "pointer",
  transition: "background .1s",
});

const selectStyle: CSSProperties = {
  padding: "6px 9px",
  fontSize: 12.5,
  color: C.ink,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: 4,
  background: "#fff",
  maxWidth: 260,
};

const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  fontSize: 12.5,
  color: C.blue,
  cursor: "pointer",
};

/** Open the stored file in a new tab, sending the staff token with the request. */
async function openFile(id: number, token: string) {
  const r = await fetch(`/api/admin/proposals/${id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function useProposals(token: string, group?: string) {
  const [items, setItems] = useState<Proposal[]>([]);
  const [ai, setAi] = useState<boolean | null>(null);
  const [durable, setDurable] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const q = group ? `?group=${encodeURIComponent(group)}` : "";
    const r = await fetch(`/api/admin/proposals${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      setError("Could not load proposals — sign in again.");
      return;
    }
    const j = await r.json();
    setItems(j.proposals || []);
    setAi(!!j.ai);
    setDurable(!!j.durable);
    setError("");
  }, [token, group]);

  useEffect(() => {
    void load();
  }, [load]);

  // While anything is being read, ask again every few seconds.
  const busy = items.some((p) => p.status === "analyzing");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  return { items, ai, durable, error, load, setError };
}

/** Plans and rates Claude read off the document, as a small table. */
function Extracted({ x }: { x: Extraction }) {
  const all = x.plans || [];
  // A UHC quote can run to dozens of plans over many pages; show the first
  // dozen and let the rest open, so Details stays a glance not a scroll.
  const [showAll, setShowAll] = useState(false);
  const plans = showAll ? all : all.slice(0, 12);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12.5, color: C.body, lineHeight: 1.6 }}>
        {x.group_name_on_document && (
          <>
            On the document: <strong style={{ color: C.ink }}>{x.group_name_on_document}</strong>
          </>
        )}
        {x.quote_id && ` · quote ${x.quote_id}`}
        {x.effective_date && ` · effective ${x.effective_date}`}
        {x.proposal_type && x.proposal_type !== "unknown" && ` · ${x.proposal_type}`}
        {x.enrolled_on_document != null && ` · priced on ${x.enrolled_on_document} enrolled`}
        {x.total_monthly != null && ` · ${money0(x.total_monthly)} / mo total`}
      </div>
      {plans.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12.5, minWidth: 520 }}>
            <thead>
              <tr>
                {["Plan", "Network", "Deductible", "OOP max", "EE", "EE+SP", "EE+CH", "Family", "Monthly"].map((h, i) => (
                  <th
                    key={h}
                    style={{
                      textAlign: i >= 4 ? "right" : "left",
                      padding: "5px 8px 5px 0",
                      fontWeight: 600,
                      color: C.muted,
                      borderBottom: `1px solid ${C.border}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plans.map((p, i) => (
                <tr key={i}>
                  <td style={{ padding: "5px 8px 5px 0", color: C.ink, borderBottom: `1px solid ${C.hairline}` }}>
                    {p.name}
                    {p.plan_type && <span style={{ color: C.ghost }}> · {p.plan_type}</span>}
                    {p.plan_code && <div style={{ fontSize: 11.5, color: C.ghost }}>{p.plan_code}</div>}
                  </td>
                  <td style={{ padding: "5px 8px 5px 0", color: C.body, borderBottom: `1px solid ${C.hairline}` }}>{p.network || "—"}</td>
                  <td style={{ padding: "5px 8px 5px 0", color: C.body, borderBottom: `1px solid ${C.hairline}` }}>{p.deductible || "—"}</td>
                  <td style={{ padding: "5px 8px 5px 0", color: C.body, borderBottom: `1px solid ${C.hairline}` }}>{p.oop_max || "—"}</td>
                  {(["EE", "ES", "EC", "FAM"] as const).map((t) => (
                    <td
                      key={t}
                      style={{ padding: "5px 8px 5px 0", textAlign: "right", color: C.ink, borderBottom: `1px solid ${C.hairline}`, fontVariantNumeric: "tabular-nums" }}
                    >
                      {money(p.rates?.[t])}
                    </td>
                  ))}
                  <td style={{ padding: "5px 0", textAlign: "right", color: C.ink, fontWeight: 600, borderBottom: `1px solid ${C.hairline}`, fontVariantNumeric: "tabular-nums" }}>
                    {p.monthly_total == null ? "—" : money0(p.monthly_total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {all.length > plans.length && (
            <button onClick={() => setShowAll(true)} style={{ ...linkBtn, fontSize: 12.5, marginTop: 6 }}>
              Show all {all.length} plans
            </button>
          )}
        </div>
      )}
      {!!x.audit_flags?.length && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, color: C.amber, lineHeight: 1.6 }}>
          {x.audit_flags.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RowProps {
  p: Proposal;
  token: string;
  groups: AdminGroup[];
  onChanged: () => void;
  /** When set, the row is on that company's page: no group column. */
  fixedGroup?: string;
  /** For an email row: how many proposals came out of it. */
  children?: number;
}

function ProposalRow({ p, token, groups, onChanged, fixedGroup, children: childCount }: RowProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const post = async (path: string, body?: unknown, method = "POST") => {
    setBusy(true);
    try {
      const r = await fetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.ok) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const x = p.extracted;
  const conf = p.confidence != null ? `${Math.round(p.confidence * 100)}%` : null;
  // Read, but not one of the four medical proposals: an ancillary-only
  // document, or a carrier the portal does not track. Kept, never in a slot.
  const ancillary = isAncillary(p);
  const untracked = !!x && !p.slot && (ancillary || !/united|uhc|surest|optum|gravie|nationwide|angle|cobalt/i.test(p.carrier || x.carrier || ""));

  // An email wrapper: the subject, who sent it, what came out of it.
  if (p.status === "container") {
    return (
      <div style={{ padding: "10px 0", borderBottom: `1px solid ${C.hairline}`, opacity: busy ? 0.6 : 1 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px" }}>
          <StatusPill p={p} />
          <button onClick={() => void openFile(p.id, token)} style={{ ...linkBtn, fontSize: 13, fontWeight: 500, color: C.body }} title="Open the email">
            {p.context?.subject || p.filename}
          </button>
          <span style={{ fontSize: 12, color: C.ghost }}>
            {p.context?.from ? `from ${p.context.from} · ` : ""}
            {childCount ?? 0} attachment{childCount === 1 ? "" : "s"} listed below · {fmtWhen(p.uploaded_at)}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {confirmDelete ? (
              <>
                <button onClick={() => void post(`/api/admin/proposals/${p.id}`, undefined, "DELETE")} style={{ ...linkBtn, color: C.red, fontWeight: 600 }}>
                  Delete email and its attachments
                </button>
                <button onClick={() => setConfirmDelete(false)} style={linkBtn}>
                  Keep
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmDelete(true)} style={{ ...linkBtn, color: C.faint }}>
                Delete
              </button>
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 0", borderBottom: `1px solid ${C.hairline}`, opacity: busy ? 0.6 : 1 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px" }}>
        <StatusPill p={p} />
        <button onClick={() => void openFile(p.id, token)} style={{ ...linkBtn, fontSize: 13.5, fontWeight: 500 }} title="Open the file">
          {p.filename}
        </button>
        <span style={{ fontSize: 12, color: C.ghost }} title={`${fmtSize(p.size)}${p.uploaded_by ? ` · uploaded by ${p.uploaded_by}` : ""}`}>
          {p.carrier || "Carrier unknown"} · {fmtWhen(p.uploaded_at)}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {p.status !== "analyzing" && (
            <select
              value={p.slot || ""}
              onChange={(e) => void post(`/api/admin/proposals/${p.id}`, { slot: e.target.value || null })}
              aria-label={`Slot for ${p.filename}`}
              title="Which of the group's proposals this is"
              style={{ ...selectStyle, maxWidth: 180, borderColor: p.slot ? C.inputEdge : untracked ? C.inputEdge : C.amber }}
            >
              <option value="">{ancillary ? "— ancillary, no slot —" : untracked ? "— not a tracked carrier —" : "— which proposal? —"}</option>
              {SLOTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
          {!fixedGroup && (
            <select
              value={p.group_name || ""}
              onChange={(e) => void post(`/api/admin/proposals/${p.id}`, { group: e.target.value || null })}
              aria-label={`Group for ${p.filename}`}
              style={{
                ...selectStyle,
                borderColor: p.status === "suggested" ? C.amberEdge : p.group_name ? C.inputEdge : C.amber,
                background: p.status === "suggested" ? C.amberTint : "#fff",
              }}
            >
              <option value="">— assign to a group —</option>
              {groups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {p.status === "suggested" && (
            <button onClick={() => void post(`/api/admin/proposals/${p.id}`, { confirm: true })} style={{ ...linkBtn, fontWeight: 600 }}>
              Confirm{conf ? ` (${conf})` : ""}
            </button>
          )}
          {x && (
            <button onClick={() => setOpen((v) => !v)} style={linkBtn}>
              {open ? "Hide details" : "Details"}
            </button>
          )}
          <button onClick={() => void post(`/api/admin/proposals/${p.id}/analyze`)} style={linkBtn} disabled={p.status === "analyzing"}>
            Re-read
          </button>
          {confirmDelete ? (
            <>
              <button onClick={() => void post(`/api/admin/proposals/${p.id}`, undefined, "DELETE")} style={{ ...linkBtn, color: C.red, fontWeight: 600 }}>
                Delete for good
              </button>
              <button onClick={() => setConfirmDelete(false)} style={linkBtn}>
                Keep
              </button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={{ ...linkBtn, color: C.faint }}>
              Delete
            </button>
          )}
        </span>
      </div>
      {!fixedGroup && p.group_name && p.status !== "analyzing" && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: C.body }}>
          <Link href={groupPath(p.group_name)}>{p.group_name}</Link>
          {p.assigned_by === "ai" && conf && <span style={{ color: C.ghost }}> · matched by AI at {conf}</span>}
          {p.assigned_by && p.assigned_by !== "ai" && p.assigned_by !== "filename" && (
            <span style={{ color: C.ghost }}> · assigned by {p.assigned_by}</span>
          )}
          {p.assigned_by === "filename" && <span style={{ color: C.ghost }}> · guessed from the filename</span>}
        </div>
      )}
      {p.context && (p.kind === "attachment" || p.kind === "email") && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: C.faint }}>
          ✉ {p.kind === "attachment" ? "Attached to" : "Email"}: <span style={{ color: C.body }}>{p.context.subject || p.context.emailFilename || "(no subject)"}</span>
          {p.context.from ? ` — from ${p.context.from}` : ""}
          {p.parent_id != null && (
            <>
              {" · "}
              <button onClick={() => void openFile(p.parent_id!, token)} style={linkBtn}>
                open the email
              </button>
            </>
          )}
        </div>
      )}
      {p.superseded_by != null && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: C.faint }}>
          Replaced by a newer {p.slot} proposal for this group. Kept for the record.
        </div>
      )}
      {untracked && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: C.faint }}>
          {ancillary
            ? "Ancillary proposal — no medical rates quoted. Kept on file, out of the group’s 2027 options."
            : "Not one of the tracked carriers. Kept on file, out of the group’s 2027 options."}
        </div>
      )}
      {open && p.summary && p.status !== "analyzing" && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted, lineHeight: 1.55, maxWidth: 900 }}>{p.summary}</div>
      )}
      {p.error && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: C.red }}>{p.error}</div>
      )}
      {!open && !!x?.audit_flags?.length && p.status !== "analyzing" && (
        <div style={{ marginTop: 4, fontSize: 12.5, color: C.amber }}>
          ⚠ {x.audit_flags.length === 1 ? x.audit_flags[0] : `${x.audit_flags.length} things to check`}
        </div>
      )}
      {open && x && <Extracted x={x} />}
    </div>
  );
}

/** Which of the tracked slots a group has a current proposal in. */
function SlotChips({ rows }: { rows: Proposal[] }) {
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, marginLeft: 4 }} aria-label="Proposal slots">
      {TRACKED.map((s) => {
        const have = rows.some((p) => p.slot === s && isCurrent(p));
        return (
          <span
            key={s}
            title={have ? `${s}: current proposal on file` : `${s}: nothing yet`}
            style={{
              ...(have ? pill(C.green, C.greenTint, C.greenEdge) : pill(C.ghost, "#fff", C.border)),
              fontWeight: 500,
            }}
          >
            {have ? "✓ " : "○ "}
            {s.replace("UHC ", "UHC ")}
          </span>
        );
      })}
    </span>
  );
}

/** Drop zone plus hidden multi-file input. */
function Uploader({
  token,
  group,
  onDone,
  compact,
}: {
  token: string;
  group: string | null;
  onDone: () => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [log, setLog] = useState<{ name: string; ok: boolean; msg?: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const send = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setLog([]);
    await uploadFiles(files, token, group, (name, ok, msg) => setLog((l) => [...l, { name, ok, msg }]));
    setBusy(false);
    onDone();
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void send(Array.from(e.dataTransfer.files));
        }}
        style={{ ...dropZone(drag), padding: compact ? "14px 16px" : "22px 20px" }}
      >
        <div style={{ fontSize: compact ? 13 : 14, fontWeight: 500, color: C.ink }}>
          {busy ? "Uploading…" : group ? `Drop proposals or emails for ${group} here, or click to choose` : "Drop proposals or emails here, or click to choose"}
        </div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: C.faint }}>
          PDF, email (.eml or .msg), Excel, Word, CSV or a picture of a rate sheet · several at once is fine ·
          attachments are pulled out of emails · each is read and {group ? "filed under this group" : "matched to its group"}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(e) => void send(Array.from(e.target.files || []))}
          aria-label={group ? `Upload proposals for ${group}` : "Upload proposals"}
          style={{ display: "none" }}
        />
      </div>
      {log.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
          {log.map((l, i) => (
            <li key={i} style={{ color: l.ok ? C.green : C.red }}>
              {l.name}: {l.ok ? l.msg || "uploaded" : l.msg || "failed"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One cell of the grid: the group's current proposal in that slot, or an empty
 * box that takes a file straight into it. Uploading over a filled slot is the
 * ordinary way to replace one — the newer proposal supersedes the older.
 */
function SlotCell({
  group,
  slot,
  current,
  token,
  onChanged,
}: {
  group: string;
  slot: string;
  current: Proposal | undefined;
  token: string;
  onChanged: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const send = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    await uploadFiles(files, token, group, () => undefined, slot);
    setBusy(false);
    onChanged();
    if (ref.current) ref.current.value = "";
  };
  const plans = current?.extracted?.plans?.length || 0;
  const when = current?.extracted?.effective_date || current?.uploaded_at?.slice(0, 10) || "";
  const quote = current?.extracted?.quote_id;

  return (
    <td style={{ padding: "5px 6px", borderBottom: `1px solid ${C.hairline}`, verticalAlign: "top" }}>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void send(Array.from(e.dataTransfer.files));
        }}
        style={{
          border: `1px solid ${current ? C.greenEdge : C.border}`,
          background: current ? C.greenTint : "#fff",
          borderRadius: 4,
          padding: "6px 8px",
          minHeight: 40,
          opacity: busy ? 0.6 : 1,
        }}
      >
        <input
          ref={ref}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label={`${slot} proposal for ${group}`}
          onChange={(e) => void send(Array.from(e.target.files || []))}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
        />
        {current ? (
          <>
            <button
              onClick={() => void openFile(current.id, token)}
              title={`${current.filename}${quote ? ` · quote ${quote}` : ""}`}
              style={{ ...linkBtn, fontSize: 12.5, fontWeight: 600, color: C.green, textAlign: "left", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}
            >
              ✓ {plans ? `${plans} plan${plans === 1 ? "" : "s"}` : "on file"}
            </button>
            <div style={{ fontSize: 11, color: C.ghost, display: "flex", gap: 8 }}>
              <span>{when ? fmtDay(when) : ""}</span>
              <button onClick={() => ref.current?.click()} style={{ ...linkBtn, fontSize: 11 }} disabled={busy}>
                {busy ? "…" : "replace"}
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={() => ref.current?.click()}
            disabled={busy}
            style={{ ...linkBtn, fontSize: 12, color: C.faint }}
            title={`Upload the ${slot} proposal for ${group}`}
          >
            {busy ? "uploading…" : "+ add"}
          </button>
        )}
      </div>
    </td>
  );
}

/** A named group of proposals under the grid; the quiet ones start folded. */
function Bucket({
  title,
  note,
  rows,
  tone,
  collapsed,
  token,
  groups,
  onChanged,
}: {
  title: string;
  note?: string;
  rows: Proposal[];
  tone: string;
  collapsed?: boolean;
  token: string;
  groups: AdminGroup[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(!collapsed);
  if (!rows.length) return null;
  return (
    <section style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ background: "none", border: "none", padding: 0, fontSize: 14, fontWeight: 600, color: tone, cursor: "pointer" }}
      >
        {title} · {rows.length} {open ? "▾" : "▸"}
      </button>
      {note && <div style={{ marginTop: 4, fontSize: 12.5, color: C.faint, maxWidth: 820 }}>{note}</div>}
      {open && rows.map((p) => <ProposalRow key={p.id} p={p} token={token} groups={groups} onChanged={onChanged} />)}
    </section>
  );
}

interface Props {
  token: string;
  /** Live roster: what a proposal can be assigned to. */
  groups: AdminGroup[];
}

/** The Proposals tab: upload in bulk, review what the AI matched, assign the rest. */
export default function Proposals({ token, groups }: Props) {
  const { items, ai, durable, error, load } = useProposals(token);
  const [view, setView] = useState<"all" | "queue" | "assigned">("all");
  const [layout, setLayout] = useState<"grid" | "list" | "groups">("grid");
  const [query, setQuery] = useState("");
  const [manager, setManager] = useState<"All" | "debbie" | "tracy">("All");
  const [need, setNeed] = useState<"All" | "missing" | "complete" | string>("All");

  const q = query.trim().toLowerCase();
  const matches = (p: Proposal) =>
    !q ||
    `${p.filename} ${p.carrier || ""} ${p.group_name || ""} ${p.summary || ""} ${p.context?.subject || ""} ${p.context?.from || ""}`
      .toLowerCase()
      .includes(q);
  const rows = items.filter(
    (p) =>
      (view === "all" ||
        (view === "queue" ? isProposal(p) && p.status !== "assigned" : p.status === "assigned")) &&
      matches(p),
  );
  const proposals = items.filter(isProposal);
  const counts = {
    health: proposals.filter((p) => !isAncillary(p) && (!!p.slot || !!p.extracted)).length,
    ancillary: proposals.filter(isAncillary).length,
    noSlot: proposals.filter(needsSlot).length,
    // Read before the current questions were asked; a re-read settles them.
    queue: proposals.filter((p) => p.status === "unassigned" || p.status === "suggested").length,
    reading: proposals.filter((p) => p.status === "analyzing").length,
    assigned: proposals.filter((p) => p.status === "assigned").length,
  };
  const childCounts: Record<number, number> = {};
  items.forEach((p) => {
    if (p.parent_id != null) childCounts[p.parent_id] = (childCounts[p.parent_id] || 0) + 1;
  });

  const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));

  // By group: every roster group with its proposals attached, the unassigned
  // ones first, and the groups still waiting on a proposal at the end.
  const byGroup = sortedGroups.map((g) => ({
    g,
    rows: proposals.filter((p) => p.group_name === g.name && matches(p)),
  }));
  const unassignedRows = proposals.filter((p) => !p.group_name && matches(p));

  // The grid: one row per group, one column per slot, holding that group's
  // current proposal in it. Everything the page is for, on one screen.
  const currentBySlot = new Map<string, Proposal>();
  proposals.forEach((p) => {
    if (isCurrent(p) && p.group_name && p.slot) currentBySlot.set(`${p.group_name}||${p.slot}`, p);
  });
  const gridRows = sortedGroups
    .map((g) => {
      // Cobalt quotes only a handful of groups, so a row's slots are its own.
      const applies = new Set<string>(g.slots || SLOTS);
      const slots = SLOTS.map((s) => (applies.has(s) ? currentBySlot.get(`${g.name}||${s}`) : undefined));
      return { g, slots, applies, have: slots.filter(Boolean).length, of: applies.size };
    })
    .filter(({ g, applies, have, of }) => {
      if (q && !`${g.name} ${g.code ?? ""}`.toLowerCase().includes(q)) return false;
      if (manager !== "All" && g.manager !== manager) return false;
      if (need === "missing" && have === of) return false;
      if (need === "complete" && have !== of) return false;
      if (SLOTS.includes(need as (typeof SLOTS)[number])) {
        // A slot that does not apply to the group is not "missing" from it.
        if (!applies.has(need)) return false;
        if (currentBySlot.get(`${g.name}||${need}`)) return false;
      }
      return true;
    });
  const filled = gridRows.reduce((n, r) => n + r.have, 0);
  const slotsInPlay = gridRows.reduce((n, r) => n + r.of, 0);
  // Everything the grid cannot hold, in three plain buckets: a group health
  // proposal still waiting for a slot (staff say which), an ancillary
  // proposal, and a carrier the portal does not track.
  const slotlessRows = proposals.filter((p) => needsSlot(p) && matches(p));
  const ancillaryRows = proposals.filter((p) => p.group_name && isAncillary(p) && matches(p));
  const otherRows = proposals.filter(
    (p) => p.group_name && !p.slot && p.status !== "analyzing" && !isAncillary(p) && !needsSlot(p) && matches(p),
  );
  const withRows = byGroup.filter((x) => x.rows.length);
  const without = byGroup.filter((x) => !x.rows.length && !proposals.some((p) => p.group_name === x.g.name));

  return (
    <>
      <div style={{ ...panel, padding: "20px 22px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 23, fontWeight: 600, color: C.ink, letterSpacing: "-0.2px" }}>
            Proposals
          </h1>
          <span style={{ fontSize: 12.5, color: C.faint }}>
            {counts.health} group health · {counts.ancillary} ancillary
            {counts.noSlot ? ` · ${counts.noSlot} waiting for a slot` : ""}
            {counts.queue ? ` · ${counts.queue} to assign` : ""}
            {counts.reading ? ` · ${counts.reading} being read` : ""}
          </span>
        </div>
        {ai === false && (
          <div
            style={{
              marginTop: 12,
              padding: "9px 12px",
              background: C.amberTint,
              border: `1px solid ${C.amberEdge}`,
              borderRadius: 4,
              fontSize: 12.5,
              color: C.amber,
              lineHeight: 1.55,
            }}
          >
            <strong>AI reading is off.</strong> Set <code>ANTHROPIC_API_KEY</code> (or <code>CLAUDE</code>)
            in Railway and redeploy, and files will be read and matched automatically. Until then, uploads are stored and you assign each
            group by hand; a filename that names a group is used as a hint.
          </div>
        )}
        {!durable && (
          <div
            style={{
              marginTop: 12,
              padding: "9px 12px",
              background: C.amberTint,
              border: `1px solid ${C.amberEdge}`,
              borderRadius: 4,
              fontSize: 12.5,
              color: C.amber,
              lineHeight: 1.55,
            }}
          >
            <strong>No database is connected</strong>, so proposals are held in memory and will be lost
            on the next deploy. Set <code>DATABASE_URL</code> to keep them.
          </div>
        )}
        <div style={{ marginTop: 16 }}>
          <Uploader token={token} group={null} onDone={load} />
        </div>
      </div>

      <div style={{ ...panel, marginTop: 16, padding: "14px 22px 6px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, paddingBottom: 10, borderBottom: `1px solid ${C.border}` }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search file, carrier or group"
            aria-label="Search proposals"
            style={{ flex: "1 1 240px", minWidth: 200, padding: "8px 11px", fontSize: 13.5, color: C.ink, border: `1px solid ${C.inputEdge}`, borderRadius: 4, outline: "none" }}
          />
          <div style={{ display: "flex", gap: 2 }} role="group" aria-label="Layout">
            {(
              [
                ["grid", "Grid"],
                ["list", "List"],
                ["groups", "By group"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setLayout(k)}
                aria-pressed={layout === k}
                style={{
                  padding: "7px 13px",
                  fontSize: 13,
                  borderRadius: 4,
                  cursor: "pointer",
                  ...(layout === k
                    ? { color: "#fff", background: C.headerBg, border: `1px solid ${C.headerBg}`, fontWeight: 500 }
                    : { color: C.body, background: "#fff", border: `1px solid ${C.inputEdge}` }),
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {layout === "grid" && (
            <>
              <select aria-label="Account manager" value={manager} onChange={(e) => setManager(e.target.value as typeof manager)} style={gridFilter}>
                <option value="All">All managers</option>
                <option value="debbie">Debbie</option>
                <option value="tracy">Tracy</option>
              </select>
              <select aria-label="Which groups" value={need} onChange={(e) => setNeed(e.target.value)} style={gridFilter}>
                <option value="All">All groups</option>
                <option value="missing">Missing a proposal</option>
                <option value="complete">Every quote in</option>
                {SLOTS.map((sl) => (
                  <option key={sl} value={sl}>
                    Missing {sl}
                  </option>
                ))}
              </select>
            </>
          )}
          {layout === "list" && (
            <div style={{ display: "flex", gap: 2 }} role="group" aria-label="Which proposals">
              {(
                [
                  ["all", `All (${proposals.length})`],
                  ["queue", `To assign (${counts.queue + counts.reading})`],
                  ["assigned", `Assigned (${counts.assigned})`],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setView(k)}
                  aria-pressed={view === k}
                  style={{
                    padding: "7px 13px",
                    fontSize: 13,
                    borderRadius: 4,
                    cursor: "pointer",
                    ...(view === k
                      ? { color: "#fff", background: C.blue, border: `1px solid ${C.blue}`, fontWeight: 500 }
                      : { color: C.body, background: "#fff", border: `1px solid ${C.inputEdge}` }),
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {error && (
          <div role="alert" style={{ margin: "12px 0", fontSize: 13, color: C.red }}>
            {error}
          </div>
        )}
        {layout === "grid" ? (
          <div>
            <div style={{ margin: "4px 0 10px", fontSize: 12.5, color: C.faint }}>
              {gridRows.length} group{gridRows.length === 1 ? "" : "s"} · {filled} of {slotsInPlay} slots filled.
              Drop a file on any box, or on the batch uploader above — a newer proposal replaces the one in that slot and the old one is kept.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 880 }}>
                <thead>
                  <tr>
                    <th style={{ ...gridTh, textAlign: "left", paddingLeft: 0 }}>Group</th>
                    {SLOTS.map((sl) => (
                      <th key={sl} style={gridTh}>
                        {sl}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {gridRows.map(({ g, slots, applies, have, of }) => (
                    <tr key={g.name}>
                      <td style={{ padding: "5px 8px 5px 0", borderBottom: `1px solid ${C.hairline}`, verticalAlign: "top" }}>
                        <Link href={groupPath(g.name)} style={{ fontWeight: 500 }}>
                          {g.name}
                        </Link>
                        <div style={{ fontSize: 11.5, color: C.ghost }}>
                          {g.enrolled} enrolled
                          {g.manager ? ` · ${g.manager === "debbie" ? "Debbie" : "Tracy"}` : ""}
                          {` · ${have} of ${of}`}
                        </div>
                      </td>
                      {SLOTS.map((sl, i) =>
                        applies.has(sl) ? (
                          <SlotCell key={sl} group={g.name} slot={sl} current={slots[i]} token={token} onChanged={() => void load()} />
                        ) : (
                          <td key={sl} style={{ padding: "5px 6px", borderBottom: `1px solid ${C.hairline}`, textAlign: "center", color: C.ghost, fontSize: 12 }} title={`${sl} is not quoted for this group`}>
                            —
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!gridRows.length && (
              <div style={{ padding: "26px 0", textAlign: "center", fontSize: 13, color: C.faint }}>Nothing matches.</div>
            )}
            <Bucket title="To Assign" rows={unassignedRows} tone={C.amber} token={token} groups={sortedGroups} onChanged={() => void load()} />
            <Bucket title="Group Health, Waiting For A Slot" rows={slotlessRows} tone={C.amber} token={token} groups={sortedGroups} onChanged={() => void load()} />
            <Bucket
              title="Ancillary Proposals"
              note="Dental, vision, life and disability. No medical rates, so they fill no slot and stay out of the 2027 options."
              rows={ancillaryRows}
              tone={C.faint}
              collapsed
              token={token}
              groups={sortedGroups}
              onChanged={() => void load()}
            />
            <Bucket title="Other Carriers" rows={otherRows} tone={C.faint} collapsed token={token} groups={sortedGroups} onChanged={() => void load()} />
          </div>
        ) : layout === "groups" ? (
          <div>
            {unassignedRows.length > 0 && (
              <section style={{ padding: "12px 0 4px" }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.amber }}>
                  Not Yet Assigned <span style={{ fontWeight: 400, color: C.faint }}>· {unassignedRows.length}</span>
                </h2>
                {unassignedRows.map((p) => (
                  <ProposalRow key={p.id} p={p} token={token} groups={sortedGroups} onChanged={() => void load()} />
                ))}
              </section>
            )}
            {withRows.map(({ g, rows: rs }) => (
              <section key={g.name} style={{ padding: "12px 0 4px" }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.ink, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <Link href={groupPath(g.name)}>{g.name}</Link>
                  <span style={{ fontWeight: 400, fontSize: 12.5, color: C.faint }}>
                    {g.enrolled} enrolled · {g.tpa || "—"} · {rs.length} proposal{rs.length === 1 ? "" : "s"}
                  </span>
                  <SlotChips rows={rs} />
                </h2>
                {[...rs]
                  .sort((a, b) => Number(!!a.superseded_by) - Number(!!b.superseded_by))
                  .map((p) => (
                    <ProposalRow key={p.id} p={p} token={token} groups={sortedGroups} onChanged={() => void load()} fixedGroup={g.name} />
                  ))}
              </section>
            ))}
            {!withRows.length && !unassignedRows.length && (
              <div style={{ padding: "26px 0", textAlign: "center", fontSize: 13, color: C.faint }}>
                {items.length ? "Nothing matches." : "No proposals yet. Drop the first batch above."}
              </div>
            )}
            {without.length > 0 && !q && (
              <section style={{ padding: "14px 0 10px", borderTop: `1px solid ${C.border}`, marginTop: 8 }}>
                <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: C.faint }}>
                  No Proposal Yet · {without.length} group{without.length === 1 ? "" : "s"}
                </h2>
                <div style={{ marginTop: 6, fontSize: 12.5, color: C.faint, lineHeight: 1.8 }}>
                  {without.map(({ g }, i) => (
                    <span key={g.name}>
                      <Link href={groupPath(g.name)} style={{ color: C.body }}>
                        {g.name}
                      </Link>
                      {i < without.length - 1 ? " · " : ""}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : !rows.length ? (
          <div style={{ padding: "26px 0", textAlign: "center", fontSize: 13, color: C.faint }}>
            {items.length ? "Nothing matches." : "No proposals yet. Drop the first batch above."}
          </div>
        ) : (
          rows.map((p) => (
            <ProposalRow key={p.id} p={p} token={token} groups={sortedGroups} onChanged={() => void load()} children={childCounts[p.id]} />
          ))
        )}
      </div>
    </>
  );
}

/** The proposals panel on a company page: what is filed here, and a way to add more. */
export function GroupProposals({ group, token }: { group: string; token: string }) {
  const { items, error, load } = useProposals(token, group);
  return (
    <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>Proposals</h3>
        <span style={{ fontSize: 12.5, color: C.faint }}>
          {items.filter(isProposal).length ? `${items.filter(isProposal).length} on file` : "none yet"} ·{" "}
          <Link href={PATHS.proposals}>all proposals</Link>
        </span>
        <SlotChips rows={items} />
      </div>
      {error && (
        <div role="alert" style={{ marginTop: 10, fontSize: 13, color: C.red }}>
          {error}
        </div>
      )}
      {items.map((p) => (
        <ProposalRow
          key={p.id}
          p={p}
          token={token}
          groups={[]}
          onChanged={() => void load()}
          fixedGroup={group}
          children={items.filter((c) => c.parent_id === p.id).length}
        />
      ))}
      <div style={{ marginTop: 12 }}>
        <Uploader token={token} group={group} onDone={load} compact />
      </div>
    </div>
  );
}

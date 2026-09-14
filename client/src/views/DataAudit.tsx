import { Fragment, useEffect, useMemo, useState } from "react";
import { C, num, panel, pill, th } from "@/lib/ui";
import { money0 } from "@/lib/model";
import Link from "@/lib/Link";
import { groupPath } from "@/lib/router";
import AuditPanel from "@/views/AuditPanel";

type Level = "ok" | "info" | "warn" | "fail";
type Status = Level | "skip";

interface Check {
  key: string;
  label: string;
  level: Level;
  detail: string;
}

interface Row {
  name: string;
  code: string | null;
  archived: boolean;
  eligible: boolean;
  status: Status;
  figures: {
    enrolled: number;
    lives: number | null;
    monthly: number;
    roster: number | null;
    plans: number;
    sizeCategory: string | null;
    quotes: number;
    manager: string | null;
    importedAt: string | null;
  };
  checks: Check[];
}

interface DataAuditResult {
  generated: string;
  headline: string;
  counts: { checked: number; ok: number; warn: number; fail: number; skipped: number };
  byCheck: Record<string, { label: string; warn: number; fail: number }>;
  checks: { key: string; label: string }[];
  rows: Row[];
}

/** The stored Employee Navigator export, re-read and set against what the portal holds. */
interface XmlVerify {
  filename: string | null;
  uploadedAt: string;
  ranAt: string;
  ranBy: string | null;
  rawSize: number | null;
  companies: number;
  matched: number;
  differ: { name: string; fields: string[] }[];
  missingFromPortal: { name: string; enrolled: number; monthly: number }[];
  notInFile: { name: string; enrolled: number }[];
  rejected: { name: string; reason: string }[];
  /** A newer export has been imported since this was run. */
  stale: boolean;
  running: boolean;
}

interface Props {
  token: string;
  /** Whether the server has an Anthropic key — the assistant's briefing only matters when it does. */
  ai: boolean;
}

const when = (s: string) => new Date(s).toLocaleString();
const mb = (n: number | null) => (n ? `${(n / 1048576).toFixed(1)} MB gzipped` : "");

/**
 * The stored export re-read against the portal: is what clients are served
 * still what Employee Navigator's file says? Run on request (a full export
 * takes a little while to parse); the last result is kept in the database.
 */
function StoredExport({ token, xml, onResult }: { token: string; xml: XmlVerify | null; onResult: (x: XmlVerify) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/data-audit/verify-xml", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      onResult(j.xml);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const problems = xml ? xml.differ.length + xml.missingFromPortal.length + xml.notInFile.length : 0;
  const status: Status = !xml ? "skip" : problems ? "warn" : "ok";
  return (
    <section style={{ ...panel, marginTop: 16, padding: "18px 22px", borderLeft: `4px solid ${status === "ok" ? C.green : status === "warn" ? C.amber : C.hairline}` }} aria-label="Stored export">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>The Stored Export, Re-read</h2>
        {xml && <span style={{ ...tone(status), marginLeft: "auto" }}>{status === "ok" ? "Matches" : "Needs a look"}</span>}
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 13.5, color: C.body, lineHeight: 1.6, maxWidth: 900 }}>
        The Employee Navigator XML is kept in the database with every import. This reads that file again from scratch and sets
        every company in it against the group the portal serves &mdash; enrolled, premium, each plan, supplemental lines &mdash; so a
        company the import skipped, a partial apply or a figure changed since is caught against the source itself.
      </p>
      {xml ? (
        <>
          <p style={{ margin: "10px 0 0", fontSize: 14, color: C.ink, lineHeight: 1.6 }}>
            {xml.matched} of {xml.companies} companies in <strong>{xml.filename || "the export"}</strong> match the portal exactly
            {xml.differ.length ? `; ${xml.differ.length} differ` : ""}
            {xml.missingFromPortal.length ? `; ${xml.missingFromPortal.length} in the file but not in the portal` : ""}
            {xml.notInFile.length ? `; ${xml.notInFile.length} served by the portal but not in the file` : ""}.
          </p>
          <div style={{ marginTop: 4, fontSize: 12.5, color: C.muted }}>
            Export imported {when(xml.uploadedAt)}{xml.rawSize ? ` · ${mb(xml.rawSize)}` : ""} · re-read {when(xml.ranAt)}{xml.ranBy ? ` by ${xml.ranBy}` : ""}
            {xml.stale && <span style={{ ...pill(C.amber, C.amberTint, C.amberEdge), marginLeft: 8 }}>A newer export has been imported since — run again</span>}
          </div>
          {xml.differ.length > 0 && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
              {xml.differ.map((d) => (
                <li key={d.name}>
                  <Link href={groupPath(d.name)} style={{ color: C.blue, fontWeight: 500 }}>{d.name}</Link>: {d.fields.join("; ")}
                </li>
              ))}
            </ul>
          )}
          {xml.missingFromPortal.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 13, color: C.body }}>
              In the file, not in the portal: {xml.missingFromPortal.map((m) => `${m.name} (${m.enrolled} enrolled)`).join(", ")}.
            </div>
          )}
          {xml.notInFile.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 13, color: C.body }}>
              Served by the portal, not in the file: {xml.notInFile.map((m) => `${m.name} (${m.enrolled} enrolled)`).join(", ")}. A company that has left should be archived.
            </div>
          )}
          {xml.rejected.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: C.muted }}>
              Company records the parser could not use: {xml.rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}.
            </div>
          )}
        </>
      ) : (
        <p style={{ margin: "10px 0 0", fontSize: 13, color: C.faint }}>Not run yet.</p>
      )}
      <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={() => void run()}
          disabled={busy}
          style={{ padding: "7px 14px", fontSize: 13, borderRadius: 4, cursor: busy ? "default" : "pointer", color: "#fff", background: C.blue, border: `1px solid ${C.blue}`, fontWeight: 500 }}
        >
          {busy ? "Re-reading the export…" : xml ? "Re-read the stored export again" : "Re-read the stored export"}
        </button>
        {error && <span style={{ fontSize: 13, color: C.red }}>{error}</span>}
      </div>
    </section>
  );
}

const tone = (s: Status) =>
  s === "ok"
    ? pill(C.green, C.greenTint, C.greenEdge)
    : s === "warn"
      ? pill(C.amber, C.amberTint, C.amberEdge)
      : s === "fail"
        ? pill(C.red, C.redTint, C.redEdge)
        : pill(C.muted, C.zebra, C.hairline);
const STATUS_WORD: Record<Status, string> = { ok: "In order", info: "Note", warn: "Look", fail: "Problem", skip: "Not served" };
const LEVEL_WORD: Record<Level, string> = { ok: "OK", info: "Note", warn: "Look", fail: "Problem" };

const cell = { padding: "8px 8px", borderBottom: `1px solid ${C.hairline}`, fontSize: 13, verticalAlign: "top" as const };

/**
 * One group opened: every check with its verdict, and the briefing the
 * assistant is handed — fetched when opened, since it is the full text.
 */
function GroupChecks({ row, token, ai }: { row: Row; token: string; ai: boolean }) {
  const [briefing, setBriefing] = useState<string | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setShowBriefing((s) => !s);
    if (briefing != null) return;
    try {
      const r = await fetch(`/api/admin/data-audit/${encodeURIComponent(row.name)}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setBriefing(j.briefing);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div style={{ padding: "10px 8px 14px 28px" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%", maxWidth: 1100 }}>
        <tbody>
          {row.checks.map((c) => (
            <tr key={c.key}>
              <td style={{ padding: "5px 8px 5px 0", width: 150, color: C.ink, fontWeight: 500, verticalAlign: "top" }}>{c.label}</td>
              <td style={{ padding: "5px 8px", width: 80, verticalAlign: "top" }}>
                <span style={tone(c.level)}>{LEVEL_WORD[c.level]}</span>
              </td>
              <td style={{ padding: "5px 0", color: c.level === "fail" ? C.red : c.level === "warn" ? C.ink : C.body, lineHeight: 1.55 }}>{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", fontSize: 13 }}>
        <Link href={groupPath(row.name)} style={{ color: C.blue }}>
          Open the company page
        </Link>
        {row.status !== "skip" && (
          <button
            onClick={() => void load()}
            aria-expanded={showBriefing}
            style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" }}
          >
            {showBriefing ? "Hide what the assistant is told" : "Show what the assistant is told"}
          </button>
        )}
      </div>
      {showBriefing && (
        <div style={{ marginTop: 8, maxWidth: 1100 }}>
          {!ai && (
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 6 }}>
              AI is off on this server (no API key); this is the briefing it would get.
            </div>
          )}
          {error ? (
            <div style={{ fontSize: 13, color: C.red }}>Could not load the briefing: {error}</div>
          ) : briefing == null ? (
            <div style={{ fontSize: 13, color: C.faint }}>Loading…</div>
          ) : (
            <pre
              style={{
                margin: 0,
                padding: "12px 14px",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                background: C.zebra,
                border: `1px solid ${C.hairline}`,
                borderRadius: 4,
                color: C.ink,
                maxHeight: 520,
                overflow: "auto",
              }}
            >
              {briefing}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Data Check tab: every group's figures checked against themselves and
 * against every file the portal holds about the group, computed on the
 * server on request. Groups that need a look come first; the rest can be
 * shown; archived and not-in-program companies are listed on request so
 * the roster is complete.
 */
export default function DataAudit({ token, ai }: Props) {
  const [audit, setAudit] = useState<DataAuditResult | null>(null);
  const [xml, setXml] = useState<XmlVerify | null>(null);
  const [read, setRead] = useState<{ text: string; at: string } | null>(null);
  const [secondRead, setSecondRead] = useState<{ text: string; at: string } | null>(null);
  const [chatgpt, setChatgpt] = useState(false);
  const [reading, setReading] = useState<"" | "claude" | "chatgpt">("");
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [issuesOnly, setIssuesOnly] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** Bumped with every run so the three-file audit at the top re-reads too. */
  const [version, setVersion] = useState(0);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/data-audit", { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setAudit(j.audit);
      setXml(j.xml || null);
      setRead(j.read || null);
      setSecondRead(j.secondRead || null);
      setChatgpt(!!j.chatgpt);
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const ask = async (who: "claude" | "chatgpt") => {
    setReading(who);
    setReadError(null);
    try {
      const r = await fetch(`/api/admin/data-audit/read${who === "chatgpt" ? "?by=chatgpt" : ""}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (who === "chatgpt") setSecondRead(j.read);
      else setRead(j.read);
    } catch (e) {
      setReadError((e as Error).message);
    } finally {
      setReading("");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const rows = useMemo(() => {
    if (!audit) return [];
    const q = query.trim().toLowerCase();
    return audit.rows.filter((r) => {
      if (r.status === "skip" && !showSkipped) return false;
      if (issuesOnly && r.status === "ok") return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [audit, issuesOnly, showSkipped, query]);

  const toggle = (name: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const overall: Status = !audit ? "skip" : audit.counts.fail ? "fail" : audit.counts.warn ? "warn" : "ok";
  const worst = Object.entries(audit?.byCheck || {})
    .map(([key, c]) => ({ key, ...c, n: c.warn + c.fail }))
    .filter((c) => c.n)
    .sort((a, b) => b.n - a.n);

  return (
    <>
      <AuditPanel token={token} version={version} ai={ai} />

      <StoredExport
        token={token}
        xml={xml}
        onResult={(x) => {
          setXml(x);
          setRead(null);
        }}
      />

      <section
        style={{ ...panel, marginTop: 16, padding: "18px 22px", borderLeft: `4px solid ${overall === "ok" ? C.green : overall === "warn" ? C.amber : overall === "fail" ? C.red : C.hairline}` }}
        aria-label="Data check"
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>Every Group, Checked</h2>
          {audit && <span style={{ ...tone(overall), marginLeft: "auto" }}>{STATUS_WORD[overall]}</span>}
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 13.5, color: C.body, lineHeight: 1.6, maxWidth: 900 }}>
          Each company&rsquo;s figures against themselves and against every file the portal holds about it: the enrolled
          count wherever it is added up, the premium, a billed rate behind every tier the pages price, the employer/employee
          split, the Employee Navigator headcount against who is enrolled, the size category the client sees, this month&rsquo;s
          billing, the 2027 quotes, and who looks after it. Open a group to read every check and the exact briefing the
          assistant answers from.
        </p>
        {error && <div style={{ marginTop: 10, fontSize: 13, color: C.red }}>Could not run the check: {error}</div>}
        {audit && (
          <>
            <p style={{ margin: "10px 0 0", fontSize: 14, color: C.ink, lineHeight: 1.6, maxWidth: 900 }}>{audit.headline}</p>
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12.5, color: C.muted }}>
              <span style={pill(C.green, C.greenTint, C.greenEdge)}>{audit.counts.ok} in order</span>
              <span style={pill(C.amber, C.amberTint, C.amberEdge)}>{audit.counts.warn} to look at</span>
              <span style={pill(C.red, C.redTint, C.redEdge)}>{audit.counts.fail} with a problem</span>
              {audit.counts.skipped > 0 && <span style={pill(C.muted, C.zebra, C.hairline)}>{audit.counts.skipped} not served</span>}
              <span>· run {new Date(audit.generated).toLocaleString()}</span>
              <button
                onClick={() => void load()}
                disabled={loading}
                style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: loading ? "default" : "pointer" }}
              >
                {loading ? "Running…" : "Run again"}
              </button>
            </div>
            {worst.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, fontSize: 12 }}>
                {worst.map((c) => (
                  <span key={c.key} style={pill(c.fail ? C.red : C.amber, c.fail ? C.redTint : C.amberTint, c.fail ? C.redEdge : C.amberEdge)}>
                    {c.label}: {c.n}
                  </span>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.hairline}` }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Claude&rsquo;s Read</span>
                {ai ? (
                  <button
                    onClick={() => void ask("claude")}
                    disabled={!!reading}
                    style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: reading ? "default" : "pointer" }}
                  >
                    {reading === "claude" ? "Reading the findings…" : read ? "Read again" : "Ask Claude what to look at first"}
                  </button>
                ) : (
                  <span style={{ fontSize: 12.5, color: C.faint }}>AI is off on this server (no API key); the checks above stand on their own.</span>
                )}
                {read && <span style={{ fontSize: 12, color: C.faint }}>read {when(read.at)} · kept in the database for this state of the data</span>}
              </div>
              {readError && <div style={{ marginTop: 6, fontSize: 13, color: C.red }}>Could not get a read: {readError}</div>}
              {read && <div style={{ marginTop: 8, fontSize: 13, color: C.body, lineHeight: 1.65, whiteSpace: "pre-wrap", maxWidth: 900 }}>{read.text}</div>}
              {!read && ai && (
                <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted, maxWidth: 900 }}>
                  The numbers above are arithmetic done on the server against the three Employee Navigator files. Claude reads
                  the findings and says which groups to look at first and why; it does not decide a figure.
                </div>
              )}
              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Second Read (ChatGPT)</span>
                {chatgpt ? (
                  <button
                    onClick={() => void ask("chatgpt")}
                    disabled={!!reading}
                    style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: reading ? "default" : "pointer" }}
                  >
                    {reading === "chatgpt" ? "Reading the findings…" : secondRead ? "Read again" : "Ask ChatGPT for a second, independent read"}
                  </button>
                ) : (
                  <span style={{ fontSize: 12.5, color: C.faint }}>No ChatGPT key on this server.</span>
                )}
                {secondRead && <span style={{ fontSize: 12, color: C.faint }}>read {when(secondRead.at)} · kept in the database for this state of the data</span>}
              </div>
              {secondRead && <div style={{ marginTop: 8, fontSize: 13, color: C.body, lineHeight: 1.65, whiteSpace: "pre-wrap", maxWidth: 900 }}>{secondRead.text}</div>}
              {!secondRead && chatgpt && (
                <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted, maxWidth: 900 }}>
                  The same findings, read by ChatGPT without seeing Claude&rsquo;s answer. Two readers that agree on what to look at
                  first are worth more than one; where they differ, the checks above are the record.
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {audit && (
        <section style={{ ...panel, marginTop: 16, padding: "14px 22px 8px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.body, cursor: "pointer" }}>
              <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} /> Only groups that need a look
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.body, cursor: "pointer" }}>
              <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Include archived and not in program
            </label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a company"
              aria-label="Find a company"
              style={{ marginLeft: "auto", padding: "6px 10px", fontSize: 13, border: `1px solid ${C.inputEdge}`, borderRadius: 4, minWidth: 200 }}
            />
          </div>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Group</th>
                  <th style={{ ...th, textAlign: "right" }} title="Employees enrolled in medical">Enrolled</th>
                  <th style={{ ...th, textAlign: "right" }} title="Medical premium per month">Medical / mo</th>
                  <th style={{ ...th, textAlign: "right" }} title="Employees with status Active on the Employee Navigator roster — not an eligible count">EN roster</th>
                  <th style={{ ...th, textAlign: "left" }}>Size</th>
                  <th style={{ ...th, textAlign: "right" }}>Quotes</th>
                  <th style={{ ...th, textAlign: "left" }}>Manager</th>
                  <th style={{ ...th, textAlign: "left" }}>Status</th>
                  <th style={{ ...th, textAlign: "left" }}>Needs a look</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ ...cell, color: C.faint, textAlign: "center", padding: 18 }}>
                      {issuesOnly ? "Nothing needs a look." : "No groups match."}
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const flagged = r.checks.filter((c) => c.level === "warn" || c.level === "fail");
                  const isOpen = open.has(r.name);
                  return (
                    <Fragment key={r.name}>
                      <tr
                        onClick={() => toggle(r.name)}
                        style={{ cursor: "pointer", background: isOpen ? C.zebra : undefined, color: r.status === "skip" ? C.faint : C.ink }}
                      >
                        <td style={{ ...cell, fontWeight: 500 }}>
                          <span aria-hidden="true" style={{ display: "inline-block", width: 14, color: C.muted }}>{isOpen ? "▾" : "▸"}</span>
                          {r.name}
                          {r.archived && <span style={{ ...pill(C.muted, C.zebra, C.hairline), marginLeft: 8 }}>Archived</span>}
                          {!r.archived && !r.eligible && <span style={{ ...pill(C.muted, C.zebra, C.hairline), marginLeft: 8 }}>Not in program</span>}
                        </td>
                        <td style={{ ...cell, textAlign: "right", ...num }}>{r.figures.enrolled}</td>
                        <td style={{ ...cell, textAlign: "right", ...num }}>{money0(r.figures.monthly)}</td>
                        <td style={{ ...cell, textAlign: "right", ...num, color: r.figures.roster != null && r.figures.roster > r.figures.enrolled * 3 && r.figures.roster - r.figures.enrolled > 20 ? C.amber : undefined }}>
                          {r.figures.roster ?? "—"}
                        </td>
                        <td style={cell}>{r.figures.sizeCategory || "—"}</td>
                        <td style={{ ...cell, textAlign: "right", ...num }}>{r.figures.quotes}</td>
                        <td style={cell}>{r.figures.manager || "—"}</td>
                        <td style={cell}>
                          <span style={tone(r.status)}>{STATUS_WORD[r.status]}</span>
                        </td>
                        <td style={{ ...cell, color: C.body }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {flagged.map((c) => (
                              <span key={c.key} style={pill(c.level === "fail" ? C.red : C.amber, c.level === "fail" ? C.redTint : C.amberTint, c.level === "fail" ? C.redEdge : C.amberEdge)}>
                                {c.label}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ background: C.zebra }}>
                          <td colSpan={9} style={{ padding: 0, borderBottom: `1px solid ${C.hairline}` }}>
                            <GroupChecks row={r} token={token} ai={ai} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

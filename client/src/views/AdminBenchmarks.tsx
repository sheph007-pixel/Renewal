import { useCallback, useEffect, useState } from "react";
import { C, chip, num, panel, textInput } from "@/lib/ui";
import { BenchmarkCard, type Comparison } from "@/views/Benchmarking";

interface Row {
  id: number;
  metric: string;
  sizeBand: string;
  region: string;
  value: number;
  year: number | null;
  source: string;
  sourceUrl: string | null;
  note: string | null;
  status: "approved" | "proposed";
  createdBy: string | null;
  updatedAt: string;
}
interface Metric {
  key: string;
  label: string;
  short: string;
  unit: "usd" | "pct";
}

const band = (b: string) => (b === "all" ? "All sizes" : `${b} employees`);

/**
 * Benchmarks for staff: what is on file from published surveys, what the
 * assistant has proposed and is waiting for approval, a way to add or fix a
 * row by hand, and a preview of any group's page.
 */
export default function AdminBenchmarks({ token, ai, groups }: { token: string; ai: boolean; groups: string[] }) {
  const auth = { Authorization: `Bearer ${token}` };
  const [rows, setRows] = useState<Row[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [bands, setBands] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [previewGroup, setPreviewGroup] = useState("");
  const [preview, setPreview] = useState<Comparison | null>(null);
  const [draft, setDraft] = useState({ metric: "", sizeBand: "all", region: "all", value: "", year: String(new Date().getFullYear()), source: "", sourceUrl: "", note: "" });

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/benchmarks", { headers: auth });
    if (!r.ok) return;
    const p = (await r.json()) as { rows: Row[]; metrics: Metric[]; sizeBands: string[]; regions: string[] };
    setRows(p.rows);
    setMetrics(p.metrics);
    setBands(["all", ...p.sizeBands]);
    setRegions(p.regions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!previewGroup) return setPreview(null);
    let live = true;
    void fetch(`/api/admin/benchmarks/preview?group=${encodeURIComponent(previewGroup)}`, { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => live && p && setPreview((p as { comparison: Comparison }).comparison));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewGroup, rows]);

  const call = async (label: string, url: string, init: RequestInit) => {
    setBusy(label);
    setError("");
    try {
      const r = await fetch(url, { ...init, headers: { ...auth, "Content-Type": "application/json", ...(init.headers || {}) } });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Failed (${r.status})`);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const refresh = () => call("refresh", "/api/admin/benchmarks/refresh", { method: "POST" });
  const setStatus = (r: Row, status: Row["status"]) => call(`row-${r.id}`, `/api/admin/benchmarks/${r.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  const patch = (r: Row, body: Partial<Row>) => call(`row-${r.id}`, `/api/admin/benchmarks/${r.id}`, { method: "PATCH", body: JSON.stringify(body) });
  const remove = (r: Row) => {
    if (!window.confirm("Remove this benchmark?")) return;
    void call(`row-${r.id}`, `/api/admin/benchmarks/${r.id}`, { method: "DELETE" });
  };
  const approveAll = async () => {
    for (const r of rows.filter((x) => x.status === "proposed")) await setStatus(r, "approved");
  };
  const add = async () => {
    const ok = await call("add", "/api/admin/benchmarks", { method: "POST", body: JSON.stringify({ ...draft, value: Number(draft.value), year: Number(draft.year) }) });
    if (ok) setDraft({ ...draft, value: "", note: "" });
  };

  const metricOf = (key: string) => metrics.find((m) => m.key === key);
  const proposed = rows.filter((r) => r.status === "proposed");
  const approved = rows.filter((r) => r.status === "approved");

  const table = (list: Row[], proposedView: boolean) => (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.3px" }}>
            {["Metric", "Firm size", "Region", "Value", "Year", "Source", "Note", ""].map((h, i) => (
              <th key={h || i} style={{ textAlign: i === 3 ? "right" : "left", padding: "6px 8px", borderBottom: `1px solid ${C.hairline}`, fontWeight: 600 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((r) => {
            const m = metricOf(r.metric);
            return (
              <tr key={r.id} style={{ borderBottom: `1px solid ${C.hairline}` }}>
                <td style={{ padding: "7px 8px", color: C.ink }}>{m ? m.label : r.metric}</td>
                <td style={{ padding: "7px 8px", color: C.body, whiteSpace: "nowrap" }}>{band(r.sizeBand)}</td>
                <td style={{ padding: "7px 8px", color: C.body }}>{r.region === "all" ? "National" : "South"}</td>
                <td style={{ padding: "7px 8px", textAlign: "right" }}>
                  <input
                    defaultValue={r.value}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v !== r.value) void patch(r, { value: v });
                    }}
                    style={{ ...textInput, ...num, width: 92, padding: "4px 6px", fontSize: 12.5, textAlign: "right" }}
                    aria-label="Value"
                  />
                  <span style={{ marginLeft: 4, color: C.faint }}>{m ? (m.unit === "pct" ? "%" : "/yr") : ""}</span>
                </td>
                <td style={{ padding: "7px 8px", ...num, color: C.body }}>{r.year ?? "—"}</td>
                <td style={{ padding: "7px 8px", color: C.body, maxWidth: 260 }}>
                  {r.sourceUrl ? (
                    <a href={r.sourceUrl} target="_blank" rel="noreferrer">
                      {r.source}
                    </a>
                  ) : (
                    r.source
                  )}
                </td>
                <td style={{ padding: "7px 8px", color: C.muted, maxWidth: 220, fontSize: 12 }}>{r.note || ""}</td>
                <td style={{ padding: "7px 8px", whiteSpace: "nowrap", textAlign: "right" }}>
                  {proposedView ? (
                    <button onClick={() => void setStatus(r, "approved")} disabled={busy === `row-${r.id}`} style={{ ...chip(true), padding: "4px 10px", fontSize: 12 }}>
                      Approve
                    </button>
                  ) : (
                    <button onClick={() => void setStatus(r, "proposed")} disabled={busy === `row-${r.id}`} title="Take it out of use without deleting it" style={{ ...chip(false), padding: "4px 10px", fontSize: 12 }}>
                      Unapprove
                    </button>
                  )}
                  <button onClick={() => remove(r)} disabled={busy === `row-${r.id}`} style={{ ...chip(false), padding: "4px 10px", fontSize: 12, marginLeft: 4, color: C.red }}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
          {!list.length && (
            <tr>
              <td colSpan={8} style={{ padding: "12px 8px", color: C.faint }}>
                {proposedView ? "Nothing waiting." : "None approved yet. Approve the proposed rows, or add one below."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ ...panel, padding: "18px 22px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div style={{ flex: "1 1 420px" }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>Benchmarks</h2>
            <div style={{ marginTop: 4, fontSize: 13, color: C.muted, lineHeight: 1.6, maxWidth: 760 }}>
              Published survey figures (KFF, Mercer, SHRM, BLS) the clients&rsquo; Benchmarking page and the assistant compare each group against, cut by firm size. The assistant can search for the latest and propose a set; nothing is used until you approve it. Every row keeps its source and year.
            </div>
          </div>
          <button onClick={() => void refresh()} disabled={!ai || busy === "refresh"} title={ai ? "Search the surveys and propose a fresh set" : "Needs the Anthropic key"} style={{ ...chip(true), padding: "9px 16px", fontSize: 13 }}>
            {busy === "refresh" ? "Searching the surveys…" : "Find the latest figures"}
          </button>
        </div>
        {error && (
          <div role="alert" style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: C.redTint, border: `1px solid ${C.redEdge}`, color: C.red, fontSize: 12.5 }}>
            {error}
          </div>
        )}
      </div>

      {proposed.length > 0 && (
        <div style={{ ...panel, padding: "16px 22px", borderColor: C.amberEdge, background: C.amberTint }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, flex: 1 }}>Proposed · {proposed.length} waiting for approval</div>
            <button onClick={() => void approveAll()} disabled={busy != null} style={{ ...chip(true), padding: "6px 12px", fontSize: 12.5 }}>
              Approve all
            </button>
          </div>
          {table(proposed, true)}
        </div>
      )}

      <div style={{ ...panel, padding: "16px 22px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Approved · in use ({approved.length})</div>
        {table(approved, false)}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.hairline}` }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Add a figure by hand</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <select value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })} style={{ ...textInput, fontSize: 12.5, padding: "6px 8px", minWidth: 260 }}>
              <option value="">Metric…</option>
              {metrics.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
            <select value={draft.sizeBand} onChange={(e) => setDraft({ ...draft, sizeBand: e.target.value })} style={{ ...textInput, fontSize: 12.5, padding: "6px 8px" }}>
              {bands.map((b) => (
                <option key={b} value={b}>
                  {band(b)}
                </option>
              ))}
            </select>
            <select value={draft.region} onChange={(e) => setDraft({ ...draft, region: e.target.value })} style={{ ...textInput, fontSize: 12.5, padding: "6px 8px" }}>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r === "all" ? "National" : "South"}
                </option>
              ))}
            </select>
            <input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder={draft.metric && metricOf(draft.metric)?.unit === "pct" ? "Percent" : "Dollars per year"} style={{ ...textInput, ...num, width: 130, fontSize: 12.5, padding: "6px 8px" }} />
            <input value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} placeholder="Year" style={{ ...textInput, ...num, width: 70, fontSize: 12.5, padding: "6px 8px" }} />
            <input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="Source, e.g. KFF Employer Health Benefits Survey" style={{ ...textInput, flex: "1 1 240px", fontSize: 12.5, padding: "6px 8px" }} />
            <input value={draft.sourceUrl} onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })} placeholder="Link (optional)" style={{ ...textInput, flex: "1 1 200px", fontSize: 12.5, padding: "6px 8px" }} />
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Note (optional)" style={{ ...textInput, flex: "1 1 200px", fontSize: 12.5, padding: "6px 8px" }} />
            <button onClick={() => void add()} disabled={!draft.metric || !draft.value || !draft.source || busy === "add"} style={{ ...chip(true), padding: "7px 14px", fontSize: 12.5 }}>
              Add
            </button>
          </div>
        </div>
      </div>

      <div style={{ ...panel, padding: "16px 22px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>Preview a group&rsquo;s page</div>
          <select value={previewGroup} onChange={(e) => setPreviewGroup(e.target.value)} style={{ ...textInput, fontSize: 12.5, padding: "6px 8px", minWidth: 280 }}>
            <option value="">Pick a group…</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          {preview && (
            <span style={{ fontSize: 12.5, color: C.muted }}>
              {preview.employees ?? "—"} employees · band {preview.sizeBand || "all"} · {preview.lines.length} benchmark{preview.lines.length === 1 ? "" : "s"} apply
            </span>
          )}
        </div>
        {preview && preview.lines.length > 0 && (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {preview.lines.map((l) => (
              <BenchmarkCard key={l.metric} l={l} />
            ))}
          </div>
        )}
        {preview && !preview.lines.length && <div style={{ fontSize: 12.5, color: C.faint }}>No approved benchmark fits this group yet.</div>}
      </div>
    </div>
  );
}

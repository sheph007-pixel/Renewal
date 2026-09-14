import { useCallback, useEffect, useState } from "react";
import { C, chip, num, panel, textInput } from "@/lib/ui";
import { BenchmarkCard, bandLabel, regionLabel, type Comparison } from "@/views/Benchmarking";

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
  createdBy: string | null;
  updatedAt: string;
}
interface Metric {
  key: string;
  label: string;
  short: string;
  unit: "usd" | "pct" | "count";
}
interface OverviewRow {
  group: string;
  employees: number | null;
  sizeBand: string | null;
  lines: { metric: string; groupText: string; benchmarkText: string; diffPct: number | null; read: string | null }[];
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * Benchmarks for staff: the figures on file from published surveys, a button
 * that has the assistant fetch the latest set, a row to add or fix one by
 * hand, and every group against the benchmarks in one table.
 */
export default function AdminBenchmarks({ token, ai }: { token: string; ai: boolean; groups: string[] }) {
  const auth = { Authorization: `Bearer ${token}` };
  const [rows, setRows] = useState<Row[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [bands, setBands] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [overview, setOverview] = useState<OverviewRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Comparison | null>(null);
  const [draft, setDraft] = useState({ metric: "", sizeBand: "all", region: "AL", value: "", year: String(new Date().getFullYear()), source: "", sourceUrl: "", note: "" });

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([fetch("/api/admin/benchmarks", { headers: auth }), fetch("/api/admin/benchmarks/overview", { headers: auth })]);
    if (a.ok) {
      const p = (await a.json()) as { rows: Row[]; metrics: Metric[]; sizeBands: string[]; regions: string[] };
      setRows(p.rows);
      setMetrics(p.metrics);
      setBands(["all", ...p.sizeBands]);
      setRegions(p.regions);
    }
    if (b.ok) setOverview(((await b.json()) as { groups: OverviewRow[] }).groups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return setDetail(null);
    let live = true;
    void fetch(`/api/admin/benchmarks/preview?group=${encodeURIComponent(open)}`, { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => live && p && setDetail((p as { comparison: Comparison }).comparison));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows]);

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
  const patch = (r: Row, body: Partial<Row>) => call(`row-${r.id}`, `/api/admin/benchmarks/${r.id}`, { method: "PATCH", body: JSON.stringify(body) });
  const remove = (r: Row) => {
    if (!window.confirm("Remove this benchmark?")) return;
    void call(`row-${r.id}`, `/api/admin/benchmarks/${r.id}`, { method: "DELETE" });
  };
  const add = async () => {
    const ok = await call("add", "/api/admin/benchmarks", { method: "POST", body: JSON.stringify({ ...draft, value: Number(draft.value), year: Number(draft.year) }) });
    if (ok) setDraft({ ...draft, value: "", note: "" });
  };

  const metricOf = (key: string) => metrics.find((m) => m.key === key);
  const latest = rows.reduce<string | null>((acc, r) => (acc && acc > r.updatedAt ? acc : r.updatedAt), null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ ...panel, padding: "18px 22px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div style={{ flex: "1 1 420px" }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>Benchmarks</h2>
            <div style={{ marginTop: 4, fontSize: 13, color: C.muted, lineHeight: 1.6, maxWidth: 760 }}>
              Six figures employers ask about, from published surveys (KFF, Mercer, SHRM, BLS, MEPS-IC), cut by the ACA line (2-50, 51+) and by place (Alabama, the South, national). Every group&rsquo;s Benchmarking page and the assistant compare against these. Each row cites its source and year.
              {latest ? ` Last updated ${when(latest)}.` : ""}
            </div>
          </div>
          <button onClick={() => void refresh()} disabled={!ai || busy === "refresh"} title={ai ? "Have the assistant search the surveys and load the latest figures" : "Needs the Anthropic key"} style={{ ...chip(true), padding: "9px 16px", fontSize: 13 }}>
            {busy === "refresh" ? "Searching the surveys…" : "Update from the surveys"}
          </button>
        </div>
        {error && (
          <div role="alert" style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: C.redTint, border: `1px solid ${C.redEdge}`, color: C.red, fontSize: 12.5 }}>
            {error}
          </div>
        )}
      </div>

      <div style={{ ...panel, padding: "16px 22px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Every group against the benchmarks</div>
        {!rows.length && <div style={{ fontSize: 12.5, color: C.faint }}>Nothing on file yet. Click Update from the surveys.</div>}
        {rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.3px" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: `1px solid ${C.hairline}`, fontWeight: 600 }}>Group</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: `1px solid ${C.hairline}`, fontWeight: 600 }}>Size</th>
                  {metrics.map((m) => (
                    <th key={m.key} style={{ textAlign: "right", padding: "6px 8px", borderBottom: `1px solid ${C.hairline}`, fontWeight: 600, whiteSpace: "nowrap" }}>
                      {m.short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {overview.map((o) => (
                  <tr key={o.group} className="rowlink" onClick={() => setOpen(open === o.group ? null : o.group)} style={{ cursor: "pointer", background: open === o.group ? C.blueTint : undefined }}>
                    <td style={{ padding: "7px 8px", borderBottom: `1px solid ${C.hairline}`, color: C.ink, whiteSpace: "nowrap", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{o.group}</td>
                    <td style={{ padding: "7px 8px", borderBottom: `1px solid ${C.hairline}`, color: C.body, whiteSpace: "nowrap" }}>
                      {o.employees ?? "—"} · {o.sizeBand || "—"}
                    </td>
                    {metrics.map((m) => {
                      const l = o.lines.find((x) => x.metric === m.key);
                      const tone = !l || l.diffPct == null ? C.faint : l.read && /Costs more|Lower than/.test(l.read) ? C.orangeInk : l.read && /Costs less|Better than/.test(l.read) ? C.green : C.body;
                      return (
                        <td key={m.key} title={l ? `Benchmark ${l.benchmarkText}${l.read ? ` — ${l.read}` : ""}` : "No benchmark fits"} style={{ padding: "7px 8px", borderBottom: `1px solid ${C.hairline}`, textAlign: "right", ...num, color: tone, whiteSpace: "nowrap" }}>
                          {l ? l.groupText : "—"}
                          {l && l.diffPct != null && Math.abs(l.diffPct) >= 3 && <span style={{ marginLeft: 4, fontSize: 11 }}>{l.diffPct > 0 ? "▲" : "▼"}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open && detail && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.hairline}` }}>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 8 }}>
              {open} as the client sees it · {detail.employees ?? "—"} employees · {bandLabel(detail.sizeBand)} · {regionLabel(detail.region)}
            </div>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
              {detail.lines.map((l) => (
                <BenchmarkCard key={l.metric} l={l} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ ...panel, padding: "16px 22px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Figures on file ({rows.length})</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.3px" }}>
                {["Metric", "Firm size", "Place", "Value", "Year", "Source", "Note", ""].map((h, i) => (
                  <th key={h || i} style={{ textAlign: i === 3 ? "right" : "left", padding: "6px 8px", borderBottom: `1px solid ${C.hairline}`, fontWeight: 600 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const m = metricOf(r.metric);
                return (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${C.hairline}` }}>
                    <td style={{ padding: "7px 8px", color: C.ink }}>{m ? m.label : r.metric}</td>
                    <td style={{ padding: "7px 8px", color: C.body, whiteSpace: "nowrap" }}>{bandLabel(r.sizeBand)}</td>
                    <td style={{ padding: "7px 8px", color: C.body }}>{regionLabel(r.region)}</td>
                    <td style={{ padding: "7px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <input
                        defaultValue={r.value}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v !== r.value) void patch(r, { value: v });
                        }}
                        style={{ ...textInput, ...num, width: 92, padding: "4px 6px", fontSize: 12.5, textAlign: "right" }}
                        aria-label="Value"
                      />
                      <span style={{ marginLeft: 4, color: C.faint }}>{m ? (m.unit === "pct" ? "%" : m.unit === "count" ? "" : "/yr") : ""}</span>
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
                      {r.createdBy && r.createdBy !== "assistant" && <span style={{ marginLeft: 6, fontSize: 10.5, color: C.faint }}>by hand</span>}
                    </td>
                    <td style={{ padding: "7px 8px", color: C.muted, maxWidth: 220, fontSize: 12 }}>{r.note || ""}</td>
                    <td style={{ padding: "7px 8px", whiteSpace: "nowrap", textAlign: "right" }}>
                      <button onClick={() => remove(r)} disabled={busy === `row-${r.id}`} style={{ ...chip(false), padding: "4px 10px", fontSize: 12, color: C.red }}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={8} style={{ padding: "12px 8px", color: C.faint }}>
                    None yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
                  {bandLabel(b)}
                </option>
              ))}
            </select>
            <select value={draft.region} onChange={(e) => setDraft({ ...draft, region: e.target.value })} style={{ ...textInput, fontSize: 12.5, padding: "6px 8px" }}>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {regionLabel(r)}
                </option>
              ))}
            </select>
            <input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder={metricOf(draft.metric)?.unit === "pct" ? "Percent" : metricOf(draft.metric)?.unit === "count" ? "Count" : "Dollars per year"} style={{ ...textInput, ...num, width: 130, fontSize: 12.5, padding: "6px 8px" }} />
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
    </div>
  );
}

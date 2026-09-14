import { useEffect, useState } from "react";
import { C, num, panel } from "@/lib/ui";
import { groupHeaders } from "@/lib/session";

export interface BenchmarkLine {
  metric: string;
  label: string;
  short: string;
  unit: "usd" | "pct";
  group: number | null;
  groupText: string;
  benchmark: number;
  benchmarkText: string;
  diffPct: number | null;
  read: string | null;
  year: number | null;
  source: string;
  sourceUrl: string | null;
  sizeBand: string;
  region: string;
  note: string | null;
}

export interface Comparison {
  sizeBand: string | null;
  employees: number | null;
  enrolled: number | null;
  region: string;
  lines: BenchmarkLine[];
}

const bandLabel = (b: string | null) => (b && b !== "all" ? `${b} employees` : "all employers");

/**
 * One metric: the group's figure beside the benchmark, with a bar for each so
 * the gap reads at a glance, and the source under it. A metric the group's
 * data cannot supply shows the benchmark alone.
 */
export function BenchmarkCard({ l }: { l: BenchmarkLine }) {
  const max = Math.max(l.group ?? 0, l.benchmark, 1);
  const bar = (v: number | null, color: string) => (
    <div style={{ height: 8, borderRadius: 4, background: C.hairline, overflow: "hidden" }}>
      {v != null && <div style={{ width: `${Math.max(2, (v / max) * 100)}%`, height: "100%", background: color, borderRadius: 4 }} />}
    </div>
  );
  const tone = l.diffPct == null || Math.abs(l.diffPct) < 3 ? C.muted : l.read && /Costs more/.test(l.read) ? C.orangeInk : l.read && /Costs less/.test(l.read) ? C.green : C.body;
  return (
    <div style={{ ...panel, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{l.label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "92px 1fr auto", alignItems: "center", gap: "6px 10px", fontSize: 12.5 }}>
        <span style={{ color: C.muted }}>Your group</span>
        {bar(l.group, C.blue)}
        <span style={{ ...num, fontWeight: 700, color: C.ink, minWidth: 64, textAlign: "right" }}>{l.groupText}</span>
        <span style={{ color: C.muted }}>Benchmark</span>
        {bar(l.benchmark, C.ghost)}
        <span style={{ ...num, fontWeight: 600, color: C.body, minWidth: 64, textAlign: "right" }}>{l.benchmarkText}</span>
      </div>
      <div style={{ fontSize: 12.5, color: tone, minHeight: 18 }}>{l.read || (l.group == null ? "Your figures do not include this yet." : "")}</div>
      <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>
        {l.sourceUrl ? (
          <a href={l.sourceUrl} target="_blank" rel="noreferrer">
            {l.source}
          </a>
        ) : (
          l.source
        )}
        {l.year ? `, ${l.year}` : ""} · {bandLabel(l.sizeBand)}
        {l.region !== "all" ? ", the South" : ", national"}
        {l.note ? ` · ${l.note}` : ""}
      </div>
    </div>
  );
}

/**
 * The client's Benchmarking page: their group against what employers of the
 * same size pay and offer, from surveys Kennion has reviewed. Nothing shows
 * until Kennion has approved benchmarks.
 */
export default function Benchmarking() {
  const [c, setC] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/benchmarks", { headers: groupHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error("Benchmarks could not be loaded.");
        setC(((await r.json()) as { comparison: Comparison }).comparison);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <div style={{ ...panel, padding: 20, color: C.red }}>{error}</div>;
  if (!c) return <div style={{ ...panel, padding: 20, color: C.muted, fontSize: 13 }}>Loading…</div>;
  if (!c.lines.length) {
    return (
      <div style={{ ...panel, padding: "22px 24px", maxWidth: 720 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Benchmarks are on the way</div>
        <div style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
          Kennion is loading the latest published survey figures for employers of your size. Once they are in, this page shows how your premiums, employer contribution and plan design compare, and the assistant can use them in its recommendations.
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ ...panel, padding: "14px 18px", marginBottom: 14, display: "flex", flexWrap: "wrap", gap: "6px 22px", alignItems: "baseline", fontSize: 13, color: C.body }}>
        <span>
          Compared with employers of <strong style={{ color: C.ink }}>{bandLabel(c.sizeBand)}</strong>
          {c.region !== "all" ? " in the South" : ""}
        </span>
        <span>
          Your group: <strong style={{ ...num, color: C.ink }}>{c.employees ?? "—"}</strong> employees, <strong style={{ ...num, color: C.ink }}>{c.enrolled ?? "—"}</strong> enrolled in medical
        </span>
        <span style={{ color: C.faint, fontSize: 12 }}>Benchmarks are survey averages reviewed by Kennion; ask the assistant what they mean for you.</span>
      </div>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        {c.lines.map((l) => (
          <BenchmarkCard key={l.metric} l={l} />
        ))}
      </div>
    </div>
  );
}

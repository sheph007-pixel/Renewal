import { useEffect, useState } from "react";
import { type Group } from "@/lib/model";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";
import { downloadCensusCsv, loadCensus, type CensusMember } from "@/lib/chat";
import { C, chip, panel } from "@/lib/ui";
import { TIER_NAMES } from "@/views/PlanCard";

/**
 * Census: who is enrolled, from the Employee Navigator data on file - the
 * people every rate on the site is priced on. Name, age, coverage tier, plan
 * and dependants' ages; nothing else about anyone. Just the table, a CSV of
 * it and the link to Employee Navigator, where the census itself lives.
 */
export default function Census({ g }: { g: Group }) {
  const [rows, setRows] = useState<CensusMember[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    loadCensus()
      .then((c) => live && setRows(c.members))
      .catch((e: Error) => live && setError(e.message || "Could not load the census."));
    return () => {
      live = false;
    };
  }, [g.name]);
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      await downloadCensusCsv(g.name);
    } catch (e) {
      setError((e as Error).message || "Could not build the file.");
    } finally {
      setBusy(false);
    }
  };
  const th = { padding: "10px 12px", fontSize: 12.5, fontWeight: 700, color: C.onColor, background: C.headerBg, textAlign: "left" as const, whiteSpace: "nowrap" as const };
  const td = { padding: "9px 12px", fontSize: 13, color: C.ink, borderBottom: `1px solid ${C.hairline}`, verticalAlign: "top" as const };
  return (
    <div style={{ maxWidth: 1000 }}>
      {/* One line: what this is and where it came from; the file; the source. The table says the rest. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: C.muted }}>
          Illustrative only, from the Employee Navigator data on file{rows ? ` · ${rows.length} enrolled` : ""}. Final rates are set by the Carrier/TPA on the final census at enrollment.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a href={NAVIGATOR_URL} target="_blank" rel="noreferrer" style={{ ...chip(false), fontWeight: 600, textDecoration: "none" }}>
            Employee Navigator ↗
          </a>
          <button onClick={() => void download()} disabled={busy || !rows?.length} style={{ ...chip(false), fontWeight: 700, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Building…" : "Download CSV"}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ marginBottom: 12, fontSize: 13, color: C.red }}>
          {error}
        </div>
      )}

      <div className="panel" style={{ ...panel, padding: 0, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
          <thead>
            <tr>
              {["Employee", "Age", "Coverage Tier", "Plan", "Spouse Age", "Child Ages"].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows === null && !error && (
              <tr>
                <td colSpan={6} style={{ ...td, color: C.muted, textAlign: "center", padding: 28 }}>
                  Loading the census…
                </td>
              </tr>
            )}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...td, color: C.muted, textAlign: "center", padding: 28 }}>
                  No enrollment on file yet.
                </td>
              </tr>
            )}
            {(rows || []).map((r, i) => (
              <tr key={`${r.name}-${i}`} style={{ background: i % 2 ? C.zebra : C.card }}>
                <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
                <td style={td}>{r.age ?? "-"}</td>
                <td style={td}>{r.tier ? TIER_NAMES[r.tier] : r.tierLabel || "-"}</td>
                <td style={{ ...td, color: C.body }}>{r.plan || "-"}</td>
                <td style={td}>{r.spouseAges.length ? r.spouseAges.join(" / ") : "-"}</td>
                <td style={td}>{r.childAges.length ? r.childAges.join(" / ") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

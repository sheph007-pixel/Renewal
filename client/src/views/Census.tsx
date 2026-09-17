import { useEffect, useState } from "react";
import { type Group } from "@/lib/model";
import { downloadCensusCsv, loadCensus, type CensusRow } from "@/lib/chat";
import { C, chip, panel } from "@/lib/ui";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";

/**
 * Census: who is enrolled, from the Employee Navigator data on file - the
 * people every rate on the site is priced on, one row per person in the
 * census's own columns. Just the table, a CSV of it and the link to
 * Employee Navigator, where the census itself lives.
 */
const COLUMNS = ["First Name", "Last Name", "Relationship", "Gender", "Date of Birth", "Zip Code", "Tier"];

/** "QUANIA" reads as "Quania"; a name already in mixed case is left as typed. */
const nameCase = (s: string) => (s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, p, c) => p + c.toUpperCase()) : s);
const usDate = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "");
const cap = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "");

export default function Census({ g }: { g: Group }) {
  const [rows, setRows] = useState<CensusRow[] | null>(null);
  const [enrolled, setEnrolled] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    loadCensus()
      .then((c) => {
        if (!live) return;
        setRows(c.rows);
        setEnrolled(c.enrolled);
      })
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
  const td = { padding: "8px 12px", fontSize: 13, color: C.ink, borderBottom: `1px solid ${C.hairline}`, whiteSpace: "nowrap" as const };
  return (
    <div style={{ maxWidth: 1000 }}>
      {/* One line: what this is and where it came from; the file; the source. The table says the rest. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: C.muted }}>
          Illustrative only, from the Employee Navigator data on file{rows ? ` · ${enrolled} enrolled` : ""}. Final rates are set by the Carrier/TPA on the final census at enrollment.
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
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
          <thead>
            <tr>
              {COLUMNS.map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows === null && !error && (
              <tr>
                <td colSpan={COLUMNS.length} style={{ ...td, color: C.muted, textAlign: "center", padding: 28 }}>
                  Loading the census…
                </td>
              </tr>
            )}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} style={{ ...td, color: C.muted, textAlign: "center", padding: 28 }}>
                  No enrollment on file yet.
                </td>
              </tr>
            )}
            {(rows || []).map((r, i) => {
              const employee = r.relationship === "employee";
              return (
                <tr key={i} style={{ background: employee ? C.card : C.zebra }}>
                  <td style={{ ...td, fontWeight: employee ? 600 : 400 }}>{nameCase(r.first) || "-"}</td>
                  <td style={{ ...td, fontWeight: employee ? 600 : 400 }}>{nameCase(r.last) || "-"}</td>
                  <td style={{ ...td, color: C.body }}>{r.relationship}</td>
                  <td style={{ ...td, color: C.body }}>{cap(r.gender) || "-"}</td>
                  <td style={{ ...td, color: C.body, fontVariantNumeric: "tabular-nums" }}>{usDate(r.dob) || (r.age != null ? `age ${r.age}` : "-")}</td>
                  <td style={{ ...td, color: C.body, fontVariantNumeric: "tabular-nums" }}>{r.zip || "-"}</td>
                  <td style={{ ...td, color: C.body }}>{r.tier || "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

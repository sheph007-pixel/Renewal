import { useEffect, useState } from "react";
import { TIERS, type AccountManager, type Group, type TierKey } from "@/lib/model";
import { downloadCensusCsv, loadCensus, type CensusMember } from "@/lib/chat";
import { C, chip, panel } from "@/lib/ui";
import { TIER_NAMES } from "@/views/PlanCard";

/**
 * Census: who is enrolled, from the enrollment data on file - the people
 * every rate on the site is priced on. Name, age, coverage tier, plan and
 * dependants' ages; nothing else about anyone. Read only: a correction goes
 * to the Kennion team, whose import is the source of truth, and the final
 * rates are set by the Carrier/TPA on the final census at enrollment.
 */
export default function Census({ g, manager }: { g: Group; manager: AccountManager | null }) {
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
  const counts: Record<TierKey, number> = { EE: 0, ES: 0, EC: 0, FAM: 0 };
  for (const r of rows || []) if (r.tier) counts[r.tier]++;
  const ages = (rows || []).map((r) => r.age).filter((a): a is number => a != null);
  const avg = ages.length ? Math.round(ages.reduce((s, a) => s + a, 0) / ages.length) : null;
  const spouses = (rows || []).filter((r) => r.spouseAges.length).length;
  const children = (rows || []).reduce((n, r) => n + r.childAges.length, 0);
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
      <div className="panel" style={{ ...panel, padding: "16px 20px", marginBottom: 14, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 13.5, color: C.body, lineHeight: 1.55, flex: "1 1 420px" }}>
          The people every rate on BenSync is priced on, from the enrollment data on file: name, age, coverage tier, plan and dependants&apos; ages, nothing more. Rates are illustrative until the Carrier/TPA sets final rates on the final census at enrollment. If something here is off, tell {manager?.name ? manager.name : "your Kennion team"}
          {manager?.email ? (
            <>
              {" "}
              (<a href={`mailto:${manager.email}`} style={{ color: C.blue, textDecoration: "none" }}>{manager.email}</a>)
            </>
          ) : null}
          ; Kennion corrects the record and every figure follows.
        </div>
        <button onClick={() => void download()} disabled={busy || !rows?.length} style={{ ...chip(false), fontWeight: 700, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Building…" : "Download CSV"}
        </button>
      </div>

      {rows && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          {[
            ["Enrolled", String(rows.length)],
            ...TIERS.map((t) => [TIER_NAMES[t.key], String(counts[t.key])] as [string, string]),
            ["Average age", avg == null ? "-" : String(avg)],
            ["Spouses", String(spouses)],
            ["Children", String(children)],
          ].map(([label, value]) => (
            <div key={label} style={{ ...panel, padding: "8px 12px", minWidth: 110 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: C.faint, textTransform: "uppercase", letterSpacing: "0.4px" }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.navy }}>{value}</div>
            </div>
          ))}
        </div>
      )}

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

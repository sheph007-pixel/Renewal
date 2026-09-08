import { useEffect, useRef, useState } from "react";
import { C, panel } from "@/lib/importui";
import type { Group, Overrides } from "@/lib/model";

/**
 * The Rates page header: where the plans stand, and the three things anyone
 * does here.
 *
 * Getting the rates right is a job with an end. Send the workbook out, take it
 * back with the corrections in, lock it. Rates can equally be typed into the
 * grid below one at a time. Nothing else belongs at the top of this page.
 */

interface Change {
  group: string;
  plan: string;
  censusTier: string;
  was: number | null;
  rate: number;
}
interface Problem {
  sheet: string;
  group?: string;
  plan?: string;
  tier?: string;
  reason: string;
}
interface Read {
  changes: Change[];
  problems: Problem[];
  rowsRead: number;
  filename: string;
  applied: boolean;
  appliedCount?: number;
  overrides?: Record<string, string>;
}
export interface RatesLock {
  locked: boolean;
  by?: string | null;
  at?: string | null;
}
export interface Progress {
  groups: number;
  plans: number;
  cells: number;
  confirmed: number;
  calculated: number;
  offSchedule: number;
  /** Plans on some other administrator, which this page does not rate. */
  outside: number;
}

const money = (n: number | null) => (n == null ? "—" : n.toFixed(2));

export default function RatesAudit({
  token,
  groups,
  overrides,
  onOverrides,
  onLock,
  progress,
}: {
  token: string;
  groups: Group[];
  overrides: Overrides;
  onOverrides: (o: Record<string, string>) => void;
  /** So the rate cells below can go read-only the moment the lock goes on. */
  onLock: (locked: boolean) => void;
  progress: Progress;
}) {
  const [lock, setLock] = useState<RatesLock>({ locked: false });
  const [preview, setPreview] = useState<Read | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const auth = { Authorization: `Bearer ${token}` };
  useEffect(() => {
    let live = true;
    void fetch("/api/admin/rates-lock", { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j) return;
        setLock(j);
        onLock(!!j.locked);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const download = async () => {
    setBusy("Building…");
    setError("");
    try {
      const { downloadAuditWorkbook } = await import("@/lib/worksheet");
      await downloadAuditWorkbook(groups, overrides);
    } catch (e) {
      setError((e as Error).message || "Could not build the workbook.");
    } finally {
      setBusy("");
    }
  };

  const send = async (f: File, apply: boolean) => {
    setBusy(apply ? "Applying…" : "Reading…");
    setError("");
    setDone("");
    try {
      const r = await fetch(
        `/api/admin/rates-workbook?apply=${apply ? 1 : 0}&filename=${encodeURIComponent(f.name)}`,
        { method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: f },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not read that workbook.");
      if (apply) {
        if (j.overrides) onOverrides(j.overrides);
        setDone(`${j.appliedCount} rate${j.appliedCount === 1 ? "" : "s"} corrected.`);
        setFile(null);
        setPreview(null);
        if (input.current) input.current.value = "";
      } else {
        setPreview(j);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const setLocked = async (locked: boolean) => {
    setBusy(locked ? "Locking…" : "Unlocking…");
    setError("");
    try {
      const r = await fetch("/api/admin/rates-lock", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ locked }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not change the lock.");
      setLock(j);
      onLock(!!j.locked);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const solid = {
    padding: "8px 16px",
    fontSize: 13.5,
    fontWeight: 500,
    color: "#fff",
    background: C.blue,
    border: `1px solid ${C.blue}`,
    borderRadius: 4,
    cursor: "pointer",
  };
  const plain = { ...solid, color: C.ink, background: "#fff", border: `1px solid ${C.border}` };
  const link = { background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" };

  return (
    <section style={{ ...panel, padding: "18px 22px" }} aria-label="Existing rates">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.ink, letterSpacing: "-0.2px" }}>
          Existing 2026 Rates
        </h1>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          {/* Taking a copy out changes nothing, so it stays available locked. */}
          <button onClick={() => void download()} disabled={!!busy} style={solid}>
            {busy === "Building…" ? "Building…" : "Download Workbook"}
          </button>
          {lock.locked ? (
            <>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: 3,
                  color: C.green,
                  background: C.greenTint,
                  border: `1px solid ${C.greenEdge}`,
                }}
              >
                Locked
              </span>
              <button onClick={() => void setLocked(false)} disabled={!!busy} style={link}>
                Unlock
              </button>
            </>
          ) : (
            <>
              <button onClick={() => input.current?.click()} disabled={!!busy} style={plain}>
                Upload Corrected
              </button>
              <button onClick={() => void setLocked(true)} disabled={!!busy} style={plain}>
                Lock The Rates
              </button>
              <input
                ref={input}
                type="file"
                accept=".xlsx,.xlsm,.xls"
                aria-label="The corrected workbook"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  setFile(f);
                  setPreview(null);
                  setDone("");
                  if (f) void send(f, false);
                }}
              />
            </>
          )}
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 13, color: C.body, lineHeight: 1.6 }}>
        {progress.plans} EBPA and HealthEZ plans across {progress.groups} groups.{" "}
        <strong style={{ color: C.ink }}>
          {progress.confirmed} of {progress.cells} rates confirmed
        </strong>
        {progress.calculated > 0 &&
          `; ${progress.calculated} still calculated at the tier schedule (1.00 · 1.85 · 2.00 · 2.85)`}
        {progress.offSchedule > 0 &&
          `, and ${progress.offSchedule} plan${progress.offSchedule === 1 ? " is" : "s are"} priced off it`}
        .{" "}
        {progress.outside > 0 &&
          ` ${progress.outside} plan${progress.outside === 1 ? " on another administrator is" : "s on other administrators are"} not shown — the program does not rate them.`}
        {" "}
        {lock.locked
          ? `Locked${lock.at ? ` ${new Date(lock.at).toLocaleDateString()}` : ""}${lock.by ? ` by ${lock.by}` : ""} — no rate can change until it is unlocked.`
          : "Correct them one at a time below, or in bulk with the workbook."}
      </div>

      {busy && busy !== "Building…" && (
        <div style={{ marginTop: 10, fontSize: 13, color: C.body }}>{busy}</div>
      )}
      {done && <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600, color: C.green }}>{done}</div>}

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: C.body }}>
            {preview.filename} — read {preview.rowsRead} rows.{" "}
            <strong style={{ color: C.ink }}>
              {preview.changes.length} rate{preview.changes.length === 1 ? "" : "s"} would change
            </strong>
            {preview.problems.length > 0 && (
              <>
                , and{" "}
                <strong style={{ color: C.amber }}>{preview.problems.length} could not be read</strong>
              </>
            )}
            .
          </div>

          {preview.changes.length > 0 && (
            <div
              style={{
                marginTop: 10,
                maxHeight: 320,
                overflow: "auto",
                border: `1px solid ${C.hairline}`,
                borderRadius: 4,
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr>
                    {["Group", "Plan", "Tier", "Was", "Becomes"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: h === "Was" || h === "Becomes" ? "right" : "left",
                          padding: "7px 10px",
                          fontWeight: 600,
                          color: C.ink,
                          position: "sticky",
                          top: 0,
                          background: C.zebra,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.hairline}` }}>
                      <td style={{ padding: "6px 10px" }}>{c.group}</td>
                      <td style={{ padding: "6px 10px" }}>{c.plan}</td>
                      <td style={{ padding: "6px 10px" }}>{c.censusTier}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: C.body }}>
                        {money(c.was)}
                      </td>
                      <td
                        style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: C.blue }}
                      >
                        {money(c.rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.problems.length > 0 && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12.5, color: C.body, lineHeight: 1.7 }}>
              {preview.problems.slice(0, 15).map((p, i) => (
                <li key={i}>
                  {[p.group, p.plan, p.tier].filter(Boolean).join(" · ") || p.sheet} — {p.reason}
                </li>
              ))}
              {preview.problems.length > 15 && <li>…and {preview.problems.length - 15} more.</li>}
            </ul>
          )}

          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 14 }}>
            {preview.changes.length > 0 && (
              <button onClick={() => file && void send(file, true)} disabled={!!busy || !file} style={solid}>
                Apply {preview.changes.length} Correction{preview.changes.length === 1 ? "" : "s"}
              </button>
            )}
            <button
              onClick={() => {
                setPreview(null);
                setFile(null);
                if (input.current) input.current.value = "";
              }}
              style={link}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 10, fontSize: 13, color: C.red }}>
          {error}
        </div>
      )}
    </section>
  );
}

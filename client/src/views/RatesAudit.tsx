import { useEffect, useRef, useState } from "react";
import { C, panel } from "@/lib/importui";

/**
 * The audit round trip, on the Rates tab: send the workbook out to the account
 * managers, take it back with their corrections, and lock the rates once they
 * are the answer.
 *
 * Reading and applying are two steps on purpose. A workbook can come back with
 * a hundred corrections in it, and seeing what would change — and what could
 * not be read — before any of it lands is the whole point of an audit.
 */

interface Change {
  group: string;
  plan: string;
  censusTier: string;
  was: number | null;
  rate: number;
  notes?: string;
}
interface Problem {
  sheet: string;
  group?: string;
  plan?: string;
  tier?: string;
  key?: string;
  reason: string;
}
interface Read {
  changes: Change[];
  problems: Problem[];
  rowsRead: number;
  sheetsRead: number;
  filename: string;
  applied: boolean;
  appliedCount?: number;
}
export interface RatesLock {
  locked: boolean;
  by?: string | null;
  at?: string | null;
}

const money = (n: number | null) => (n == null ? "—" : n.toFixed(2));

export default function RatesAudit({
  token,
  onOverrides,
  onLock,
}: {
  token: string;
  onOverrides: (o: Record<string, string>) => void;
  /** So the rate cells above can go read-only the moment the lock goes on. */
  onLock: (locked: boolean) => void;
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
      setPreview(j);
      if (apply) {
        if (j.overrides) onOverrides(j.overrides);
        setDone(
          `${j.appliedCount} correction${j.appliedCount === 1 ? "" : "s"} applied from ${j.filename}.`,
        );
        setFile(null);
        if (input.current) input.current.value = "";
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

  const link = { background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" };
  const button = (primary: boolean) => ({
    padding: primary ? "8px 16px" : "6px 13px",
    fontSize: 13,
    fontWeight: 600 as const,
    color: primary ? "#fff" : C.ink,
    background: primary ? C.blue : "#fff",
    border: `1px solid ${primary ? C.blue : C.border}`,
    borderRadius: 4,
    cursor: "pointer",
  });

  return (
    <section style={{ ...panel, marginTop: 16, padding: "18px 22px" }} aria-label="Rates audit">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>
          Audited Rates Coming Back
        </h2>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "3px 9px",
            borderRadius: 3,
            color: lock.locked ? C.green : C.body,
            background: lock.locked ? C.greenTint : C.zebra,
            border: `1px solid ${lock.locked ? C.greenEdge : C.hairline}`,
          }}
        >
          {lock.locked ? "Locked" : "Open For Changes"}
        </span>
      </div>

      <p style={{ margin: "8px 0 0", fontSize: 13, color: C.body, lineHeight: 1.6, maxWidth: 760 }}>
        {lock.locked ? (
          <>
            The rates are locked, so nothing can change them — not this workbook and not a rate keyed
            by hand.{" "}
            {lock.at && <>Locked {new Date(lock.at).toLocaleString()}{lock.by ? ` by ${lock.by}` : ""}. </>}
            <button onClick={() => void setLocked(false)} disabled={!!busy} style={link}>
              Unlock them
            </button>
          </>
        ) : (
          <>
            Send back the workbook Debbie or Tracy filled in. Nothing is written until you have seen
            what would change.
          </>
        )}
      </p>

      {!lock.locked && (
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <input
            ref={input}
            type="file"
            accept=".xlsx,.xlsm,.xls"
            aria-label="The audited workbook"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setFile(f);
              setPreview(null);
              setDone("");
              if (f) void send(f, false);
            }}
            style={{ fontSize: 13 }}
          />
          {busy && <span style={{ fontSize: 13, color: C.body }}>{busy}</span>}
        </div>
      )}

      {done && (
        <div style={{ marginTop: 10, fontSize: 13, color: C.green, fontWeight: 600 }}>{done}</div>
      )}

      {preview && !preview.applied && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: C.body }}>
            Read {preview.rowsRead} row{preview.rowsRead === 1 ? "" : "s"} across{" "}
            {preview.sheetsRead} sheet{preview.sheetsRead === 1 ? "" : "s"}.{" "}
            <strong style={{ color: C.ink }}>
              {preview.changes.length} rate{preview.changes.length === 1 ? "" : "s"} would change
            </strong>
            {preview.problems.length > 0 && (
              <>
                , and{" "}
                <strong style={{ color: C.amber }}>
                  {preview.problems.length} cell{preview.problems.length === 1 ? "" : "s"} could not be
                  read
                </strong>
              </>
            )}
            .
          </div>

          {preview.changes.length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 340, overflow: "auto", border: `1px solid ${C.hairline}`, borderRadius: 4 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: C.zebra }}>
                    {["Group", "Plan", "Tier", "Was", "Becomes", "Notes"].map((h) => (
                      <th key={h} style={{ textAlign: h === "Was" || h === "Becomes" ? "right" : "left", padding: "7px 10px", fontWeight: 600, color: C.ink, position: "sticky", top: 0, background: C.zebra }}>
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
                      <td style={{ padding: "6px 10px", textAlign: "right", color: C.body }}>{money(c.was)}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: C.blue }}>{money(c.rate)}</td>
                      <td style={{ padding: "6px 10px", color: C.body }}>{c.notes || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.problems.length > 0 && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12.5, color: C.body, lineHeight: 1.7 }}>
              {preview.problems.slice(0, 25).map((p, i) => (
                <li key={i}>
                  {[p.group, p.plan, p.tier].filter(Boolean).join(" · ") || p.key || p.sheet} — {p.reason}
                </li>
              ))}
              {preview.problems.length > 25 && <li>…and {preview.problems.length - 25} more.</li>}
            </ul>
          )}

          {preview.changes.length > 0 && (
            <button
              onClick={() => file && void send(file, true)}
              disabled={!!busy || !file}
              style={{ ...button(true), marginTop: 14 }}
            >
              Apply {preview.changes.length} Correction{preview.changes.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}

      {!lock.locked && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.hairline}` }}>
          <div style={{ fontSize: 13, color: C.body, lineHeight: 1.6, maxWidth: 760 }}>
            When the audit is finished and the rates are right, lock them. Nothing can change a rate
            while the lock is on, and it can be lifted from here.
          </div>
          <button onClick={() => void setLocked(true)} disabled={!!busy} style={{ ...button(false), marginTop: 10 }}>
            Lock The Rates
          </button>
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

import { useRef, useState } from "react";
import ImportSection from "@/views/ImportSection";
import { C } from "@/lib/importui";

interface BatchResult {
  month: string;
  stored: number;
  groups: string[];
  unmatched: string[];
  /** Groups whose invoice did not tie out: product rows vs. Total Due vs. the amount billed. */
  check: string[];
}

interface Props {
  token: string;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

/**
 * Fourth upload on the Import tab: Employee Navigator's monthly invoice
 * export, one zip with a PDF per group. Matched to groups by name on the
 * server and filed under each one — nothing here to review row by row,
 * just where the file goes in and what came back unmatched, if anything.
 */
export default function InvoicesPanel({ token }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [month, setMonth] = useState(thisMonth());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BatchResult | null>(null);

  async function upload(f: File) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/invoices/batch?month=${encodeURIComponent(month)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": f.type || "application/zip" },
        body: f,
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      if (!r.ok) setError(j.error || "Could not read the zip.");
      else setResult(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <ImportSection
      step={4}
      title="Client invoices"
      what="Invoices.zip — one PDF per group, from Employee Navigator"
      accept=".zip,application/zip,application/x-zip-compressed"
      ariaLabel="Upload the monthly invoices zip"
      inputRef={ref}
      disabled={busy}
      onFile={(f) => void upload(f)}
      busy={busy ? "Reading…" : ""}
      last={result ? { filename: `${result.stored} invoice${result.stored === 1 ? "" : "s"} — ${result.month}`, when: new Date().toISOString() } : null}
      status={
        !result
          ? { kind: "none", label: "Not uploaded yet" }
          : result.unmatched.length || result.check.length
            ? { kind: "warn", label: `${result.unmatched.length + result.check.length} to check` }
            : { kind: "ok", label: `${result.stored} filed` }
      }
      error={error}
      open={!!(result?.unmatched.length || result?.check.length)}
    >
      <div style={{ marginBottom: 10, fontSize: 13, color: C.body }}>
        Month this invoice covers:{" "}
        <input
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          placeholder="2026-09"
          style={{ width: 90, padding: "4px 6px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 3 }}
        />
      </div>
      {result && (
        <div style={{ fontSize: 13, color: C.body, lineHeight: 1.6 }}>
          Filed {result.stored} invoice{result.stored === 1 ? "" : "s"} under {result.month}.
          {result.unmatched.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, color: C.amber }}>
                {result.unmatched.length} file{result.unmatched.length === 1 ? "" : "s"} didn&rsquo;t match a group by name:
              </div>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {result.unmatched.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          {result.check.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, color: C.amber }}>
                {result.check.length} invoice{result.check.length === 1 ? "" : "s"} did not tie out (product rows vs. the amount billed):
              </div>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {result.check.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ImportSection>
  );
}

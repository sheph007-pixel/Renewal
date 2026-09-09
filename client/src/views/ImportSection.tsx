import { useState, type ReactNode, type Ref } from "react";
import { C, panel } from "@/lib/importui";
import { pill } from "@/lib/ui";

export interface LastUpload {
  filename: string | null;
  when: string;
  by?: string | null;
}

export type SectionStatus = { kind: "ok" | "warn" | "none"; label: string };

interface Props {
  step: number;
  title: string;
  /** What to upload, in one line: the file as Employee Navigator names it. */
  what: string;
  accept: string;
  ariaLabel: string;
  inputRef: Ref<HTMLInputElement>;
  disabled?: boolean;
  onFile: (f: File) => void;
  busy?: string;
  last: LastUpload | null;
  status: SectionStatus;
  /** The one line of figures that says the upload did its job. */
  summary?: ReactNode;
  error?: string;
  done?: string;
  /** Keep the details open (an import waiting to be confirmed, say). */
  open?: boolean;
  children?: ReactNode;
}

/**
 * One upload on the Import tab: what goes here, the button, when it was last
 * done, and whether it is in order. Everything else — tables, diagnostics,
 * per-group checks — sits behind "Show details".
 */
export default function ImportSection({ step, title, what, accept, ariaLabel, inputRef, disabled, onFile, busy, last, status, summary, error, done, open, children }: Props) {
  const [show, setShow] = useState(false);
  const isOpen = !!open || show;
  // Once the file is in and nothing is happening, the section is one line:
  // what is in, when, the result, and a way to replace it.
  const settled = !!last && !busy && !error && !done && !open;
  const tone =
    status.kind === "ok"
      ? pill(C.green, C.greenTint, C.greenEdge)
      : status.kind === "warn"
        ? pill(C.amber, C.amberTint, C.amberEdge)
        : pill(C.muted, C.zebra, C.hairline);

  return (
    <section style={{ ...panel, marginTop: 16, padding: "18px 22px" }} aria-label={title}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <span
          aria-hidden
          style={{ width: 26, height: 26, borderRadius: 13, background: C.headerBg, color: "#fff", fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
        >
          {step}
        </span>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>{title}</h2>
        <span style={{ ...tone, marginLeft: "auto" }}>{status.label}</span>
      </div>

      <div style={{ marginTop: settled ? 8 : 12, display: "grid", gridTemplateColumns: settled ? "1fr" : "110px 1fr", rowGap: 6, columnGap: 12, fontSize: 13, alignItems: "center" }}>
        {!settled && <span style={{ color: C.muted, fontWeight: 600 }}>Upload</span>}
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, order: settled ? 3 : 0 }}>
          <label
            title={what}
            style={
              settled
                ? { fontSize: 12.5, color: C.blue, cursor: disabled ? "default" : "pointer" }
                : {
                    padding: "7px 14px",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "#fff",
                    background: disabled ? C.muted : C.blue,
                    border: `1px solid ${disabled ? C.muted : C.blue}`,
                    borderRadius: 4,
                    cursor: disabled ? "default" : "pointer",
                  }
            }
          >
            {settled ? "Replace file…" : "Choose file…"}
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              aria-label={ariaLabel}
              disabled={disabled}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
              style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
            />
          </label>
          {!settled && <span style={{ color: busy ? C.blue : C.body }}>{busy || what}</span>}
          {settled && children && (
            <button
              onClick={() => setShow((v) => !v)}
              aria-expanded={isOpen}
              style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}
            >
              {isOpen ? "Hide details" : "Details"}
            </button>
          )}
        </span>

        {!settled && <span style={{ color: C.muted, fontWeight: 600 }}>Last Upload</span>}
        <span style={{ color: last ? C.ink : C.faint }}>
          {last
            ? `${last.filename || "(unnamed)"} · ${new Date(last.when).toLocaleString()}${last.by ? ` · ${last.by}` : ""}`
            : "Never"}
        </span>

        {summary && (
          <>
            {!settled && <span style={{ color: C.muted, fontWeight: 600 }}>Result</span>}
            <span style={{ color: settled ? C.body : C.ink }}>{summary}</span>
          </>
        )}
      </div>

      {error && (
        <div role="alert" style={{ marginTop: 12, padding: "9px 12px", background: C.redTint, border: `1px solid ${C.redEdge}`, borderRadius: 4, fontSize: 13, color: C.red }}>
          {error}
        </div>
      )}
      {done && (
        <div style={{ marginTop: 12, padding: "9px 12px", background: C.greenTint, border: `1px solid ${C.greenEdge}`, borderRadius: 4, fontSize: 13, color: C.green }}>
          {done}
        </div>
      )}

      {children && (
        <div style={{ marginTop: settled ? 0 : 12 }}>
          {!open && !settled && (
            <button
              onClick={() => setShow((s) => !s)}
              aria-expanded={isOpen}
              style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" }}
            >
              {isOpen ? "Hide details" : "Show details"}
            </button>
          )}
          {isOpen && <div style={{ marginTop: open ? 0 : 10, paddingTop: 12, borderTop: `1px solid ${C.hairline}` }}>{children}</div>}
        </div>
      )}
    </section>
  );
}

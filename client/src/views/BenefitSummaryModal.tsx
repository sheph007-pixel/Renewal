import { useState } from "react";
import CarrierMark, { CarrierSiteLink, FindADoctorLink } from "@/views/CarrierMark";
import { C, h2, panel } from "@/lib/ui";
import { useNarrow } from "@/lib/narrow";
import { labelFor, lineValue, type BenefitSummary } from "@/lib/benefit-summaries";

/** A value long enough to need its own line under the label, rather than sitting beside it. */
const isLong = (s: string) => s.length > 42;

/**
 * The quick-reference popup for one Supplemental Package row: the same idea
 * as Medical Plans' own plan-card popup (click a row, see every detail), but
 * for a standardized dental/vision/supplemental product instead of a quoted
 * medical plan. Leads with the headline figures a carrier's own consumer
 * site would show - what it costs to use, what it's worth, how to sign up -
 * with the full line-by-line schedule available but collapsed by default, so
 * a quick glance stays quick. The carrier's raw legal notes (exclusions,
 * contract numbers, underwriting language) never render here; that detail
 * belongs in the certificate of coverage, not a summary popup - the AI
 * assistant still has it server-side for a specific question.
 */
export default function BenefitSummaryModal({ entry, onClose }: { entry: BenefitSummary; onClose: () => void }) {
  const narrow = useNarrow();
  const [showDetail, setShowDetail] = useState(false);
  const summaryEntries = Object.entries(entry.summary || {}).filter(([, v]) => v != null && v !== "");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${entry.name} benefit summary`}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,24,28,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: narrow ? 8 : 16, zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...panel, width: "min(640px, 100%)", maxHeight: "90vh", overflow: "auto", position: "relative", padding: narrow ? "18px 16px" : "22px 26px" }}
      >
        <button onClick={onClose} aria-label="Close" style={{ position: "absolute", top: 10, right: 10, width: 30, height: 30, display: "grid", placeItems: "center", fontSize: 20, color: C.muted, background: "transparent", border: "none", borderRadius: 8, cursor: "pointer" }}>
          ×
        </button>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 4, paddingRight: 30 }}>
          <div>
            <h2 style={{ ...h2, fontSize: 19 }}>{entry.name}</h2>
            <div style={{ marginTop: 4 }}>
              <CarrierMark name={entry.carrier} size={22} fontSize={13} color={C.body} />
            </div>
          </div>
          <div className="noprint" style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, flex: "none" }}>
            <CarrierSiteLink name={entry.carrier} />
            <FindADoctorLink name={entry.carrier} />
          </div>
        </div>

        {entry.status === "legacy" && (
          <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, color: C.amber, background: C.amberTint, border: `1px solid ${C.amberEdge}`, borderRadius: 6, padding: "6px 10px" }}>
            Prior plan{entry.effectiveThrough ? ` - ends ${entry.effectiveThrough}` : ""}, kept here for reference only.
          </div>
        )}

        {summaryEntries.length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: "10px 20px", padding: "12px 14px", background: C.zebra, border: `1px solid ${C.hairline}`, borderRadius: 8 }}>
            {summaryEntries.map(([k, v]) => (
              <div key={k} style={{ gridColumn: !narrow && isLong(v) ? "1 / -1" : undefined, fontSize: 13 }}>
                <div style={{ color: C.muted, marginBottom: 2 }}>{labelFor(k)}</div>
                <div style={{ fontWeight: 600, color: C.ink, lineHeight: 1.4 }}>{v}</div>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowDetail((s) => !s)}
          style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: C.blueInk, background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
        >
          <span style={{ display: "inline-block", transform: showDetail ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>›</span>
          {showDetail ? "Hide Full Benefit Detail" : "See Full Benefit Detail"}
        </button>

        {showDetail && (
          <div style={{ marginTop: 8 }}>
            {entry.lines.map((l, i) => {
              const value = lineValue(l);
              const extra = l.description || l.note;
              const stacked = isLong(value);
              return (
                <div key={`${l.label}-${i}`} style={{ padding: "8px 0", borderBottom: i < entry.lines.length - 1 ? `1px solid ${C.hairline}` : "none" }}>
                  <div style={{ display: "flex", flexDirection: stacked ? "column" : "row", justifyContent: "space-between", gap: stacked ? 2 : 14 }}>
                    <div style={{ fontSize: 13.5, color: C.ink, flex: stacked ? undefined : "1 1 auto", minWidth: 0 }}>{l.label}</div>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, textAlign: stacked ? "left" : "right", flex: stacked ? undefined : "0 0 auto" }}>{value}</div>
                  </div>
                  {(extra || l.frequency) && (
                    <div style={{ fontSize: 12, color: C.faint, marginTop: 2, lineHeight: 1.4 }}>
                      {[extra, l.frequency].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p style={{ marginTop: 14, fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>
          This is a brief summary. Your certificate of coverage governs full terms, exclusions and state variations.
        </p>
      </div>
    </div>
  );
}

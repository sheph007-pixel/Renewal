import CarrierMark, { CarrierSiteLink, FindADoctorLink } from "@/views/CarrierMark";
import { C, h2, panel } from "@/lib/ui";
import { useNarrow } from "@/lib/narrow";
import { labelFor, lineValue, type BenefitSummary } from "@/lib/benefit-summaries";

/**
 * The quick-reference popup for one Supplemental Package row: the same idea
 * as Medical Plans' own plan-card popup (click a row, see every detail), but
 * for a standardized dental/vision/supplemental product instead of a quoted
 * medical plan - headline figures first, then every benefit line, with the
 * carrier's Website and Find A Doctor links right in the header where the
 * client's next question ("is my dentist in network?") already is.
 */
export default function BenefitSummaryModal({ entry, onClose }: { entry: BenefitSummary; onClose: () => void }) {
  const narrow = useNarrow();
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
        style={{ ...panel, width: "min(720px, 100%)", maxHeight: "90vh", overflow: "auto", position: "relative", padding: narrow ? "18px 16px" : "22px 26px" }}
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
              <div key={k} style={{ gridColumn: !narrow && v.length > 50 ? "1 / -1" : undefined, fontSize: 13 }}>
                <div style={{ color: C.muted, marginBottom: 2 }}>{labelFor(k)}</div>
                <div style={{ fontWeight: 600, color: C.ink, lineHeight: 1.4 }}>{v}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          {entry.lines.map((l, i) => (
            <div key={`${l.label}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 14, padding: "8px 0", borderBottom: i < entry.lines.length - 1 ? `1px solid ${C.hairline}` : "none" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: C.ink }}>{l.label}</div>
                {(l.description || l.note) && <div style={{ fontSize: 12, color: C.faint, marginTop: 2, lineHeight: 1.4 }}>{l.description || l.note}</div>}
              </div>
              <div style={{ flex: "none", textAlign: "right" }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, whiteSpace: "nowrap" }}>{lineValue(l)}</div>
                {l.frequency && <div style={{ fontSize: 12, color: C.faint, marginTop: 2 }}>{l.frequency}</div>}
              </div>
            </div>
          ))}
        </div>

        {entry.notes && <div style={{ marginTop: 14, fontSize: 12, color: C.faint, lineHeight: 1.5, paddingTop: 10, borderTop: `1px solid ${C.hairline}` }}>{entry.notes}</div>}
      </div>
    </div>
  );
}

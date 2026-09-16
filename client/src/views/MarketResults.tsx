import { useMemo } from "react";
import { MARKET_RESULTS_NOTE, marketResults, marketResultsSentences, type MarketPlan } from "@/lib/model";
import { C, panel } from "@/lib/ui";
import InfoTip from "@/views/InfoTip";

/**
 * "Your Market Results": three or four sentences on what Kennion received
 * after taking this group to market — plan count, partners, the lowest
 * average employee-only cost at a fixed 50% employer contribution, the widest
 * selection, the networks, and any reference-based pricing options. A fixed
 * template over every quoted plan (never the filtered grid), recomputed
 * whenever the plans change, and unmoved by the Employer Contribution
 * controls above it. Each value populated from the data is bold and
 * underlined, so what is dynamic reads as dynamic.
 */
export default function MarketResults({ plans }: { plans: MarketPlan[] }) {
  const sentences = useMemo(() => marketResultsSentences(marketResults(plans)), [plans]);
  if (!sentences.length) return null;
  return (
    <section className="panel noprint" aria-label="Your Market Results" style={{ ...panel, padding: "14px 16px", marginBottom: 14, borderLeft: `4px solid ${C.blue}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.navy, lineHeight: 1.2 }}>Your Market Results</div>
        <InfoTip text={MARKET_RESULTS_NOTE} place="below" />
      </div>
      <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.7, overflowWrap: "anywhere" }}>
        {sentences.map((sent, i) => (
          <span key={i}>
            {i > 0 ? " " : ""}
            {sent.map((seg, j) =>
              seg.value ? (
                <strong key={j} style={{ color: C.ink, fontWeight: 600, textDecoration: "underline", textDecorationColor: C.blueEdge, textUnderlineOffset: 2 }}>
                  {seg.text}
                </strong>
              ) : (
                <span key={j}>{seg.text}</span>
              ),
            )}
          </span>
        ))}
      </p>
      <div style={{ marginTop: 6, fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>{MARKET_RESULTS_NOTE}</div>
    </section>
  );
}

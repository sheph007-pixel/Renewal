import { useMemo, type ReactNode } from "react";
import { MARKET_RESULTS_TIP, marketResults, marketResultsSentences, type MarketPlan } from "@/lib/model";
import { C, panel } from "@/lib/ui";
import InfoTip from "@/views/InfoTip";

/**
 * "Your Market Results": what Kennion did for this group and what to do on
 * this page. Three or four sentences on what came back from market — plan
 * count per partner, the lowest average employee-only cost at a fixed 50%
 * employer contribution, the widest selection, the networks, and any
 * reference-based pricing — then what to do next, with the assistant's
 * recommendations button beside it. A fixed template over every quoted plan
 * (never the filtered grid), recomputed whenever the plans change, and
 * unmoved by the Employer Contribution controls beneath it. Each value
 * populated from the data is bold and underlined, so what is dynamic reads
 * as dynamic. The 50% assumption is stated once, in the sentence that uses
 * it; the ⓘ says what Kennion did for the client.
 */
export default function MarketResults({ plans, action }: { plans: MarketPlan[]; action?: ReactNode }) {
  const sentences = useMemo(() => marketResultsSentences(marketResults(plans)), [plans]);
  if (!sentences.length) return null;
  return (
    <section className="panel noprint" aria-label="Your Market Results" style={{ ...panel, padding: "18px 20px 16px", marginBottom: 18, borderLeft: `4px solid ${C.blue}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: C.navy, lineHeight: 1.2 }}>Your Market Results</div>
        <InfoTip text={MARKET_RESULTS_TIP} place="below" />
      </div>
      <p style={{ margin: 0, fontSize: 15, color: C.ink, lineHeight: 1.75, overflowWrap: "anywhere" }}>
        {sentences.map((sent, i) => (
          <span key={i}>
            {i > 0 ? " " : ""}
            {sent.map((seg, j) =>
              seg.value ? (
                <strong key={j} style={{ color: C.navy, fontWeight: 700, textDecoration: "underline", textDecorationColor: C.blueEdge, textUnderlineOffset: 3 }}>
                  {seg.text}
                </strong>
              ) : (
                <span key={j}>{seg.text}</span>
              ),
            )}
          </span>
        ))}
      </p>
      {/* One line on what to do, and the one action. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 14, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.hairline}` }}>
        <p style={{ margin: 0, flex: "1 1 320px", minWidth: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>
          Every plan below is priced for your group. Set your contribution, browse, and heart the ones you want Kennion to price{action ? " — or let the assistant narrow it down first." : "."}
        </p>
        {action && <div style={{ flex: "none" }}>{action}</div>}
      </div>
    </section>
  );
}

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
      {/* What to do on this page. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 14, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.hairline}` }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.navy, marginBottom: 4 }}>What To Do Next</div>
          <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.65 }}>
            Every plan is priced for your group below. Under Browse All Plans, set your monthly Employer Contribution to see what your company and your employees would pay on each one, and filter by Carrier/TPA, network, funding, deductible or cost. Click a row for the full details, tap the heart to add a plan to your favorites, or the plus to compare plans side by side.
            {action ? " Or let the assistant narrow it down for you first." : ""}
          </p>
        </div>
        {action && <div style={{ flex: "none" }}>{action}</div>}
      </div>
    </section>
  );
}

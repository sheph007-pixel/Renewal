import { useMemo, useState } from "react";
import { MARKET_RESULTS_TIP, marketResults, marketResultsSentences, type MarketPlan } from "@/lib/model";
import { C, panel } from "@/lib/ui";
import InfoTip from "@/views/InfoTip";

/**
 * "Your Market Results": what Kennion did for this group and what to do on
 * this page. A few sentences on what came back from market - plan count per
 * partner, the lowest average employee-only cost at a fixed 50% employer
 * contribution, the widest selection, the networks each tied to the
 * Carrier/TPA whose plans are on them, and any reference-based pricing -
 * then what to do next, with the assistant's
 * recommendations button beside it. A fixed template over every quoted plan
 * (never the filtered grid), recomputed whenever the plans change, and
 * unmoved by the Employer Contribution controls beneath it. Each value
 * populated from the data is bold and underlined, so what is dynamic reads
 * as dynamic. The 50% assumption is stated once, in the sentence that uses
 * it; the ⓘ says what Kennion did for the client.
 */
export default function MarketResults({ plans }: { plans: MarketPlan[] }) {
  const sentences = useMemo(() => marketResultsSentences(marketResults(plans)), [plans]);
  // Open by default - it's the first thing worth reading on the page - but a
  // client who has already read it can fold it up for room to work the grid.
  const [open, setOpen] = useState(true);
  if (!sentences.length) return null;
  // The closing sentence is fixed, partner-count-agnostic copy - always last,
  // so it's split out to render bold on its own line below the data-backed
  // sentences, which stay inline in their own paragraph as before.
  const lead = sentences.slice(0, -1);
  const closing = sentences[sentences.length - 1];
  return (
    <section className="panel noprint" aria-label="Your Market Results" style={{ ...panel, padding: "14px 20px", marginBottom: 18, borderLeft: `4px solid ${C.blue}` }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: open ? "0 0 8px" : 0, background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 18, fontWeight: 600, color: C.navy, lineHeight: 1.2 }}>Your Market Results</span>
          <InfoTip text={MARKET_RESULTS_TIP} place="below" />
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.blueInk, background: C.blueTint, border: `1px solid ${C.blueEdge}`, borderRadius: 6, padding: "4px 11px", whiteSpace: "nowrap" }}>
          {open ? "Collapse ▴" : "Show ▾"}
        </span>
      </button>
      {open && (
        <>
          {lead.length > 0 && (
            <p style={{ margin: 0, fontSize: 15, color: C.ink, lineHeight: 1.75, overflowWrap: "anywhere" }}>
              {lead.map((sent, i) => (
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
          )}
          <p style={{ margin: lead.length > 0 ? "10px 0 0" : 0, fontSize: 15, color: C.ink, fontWeight: 700, lineHeight: 1.75, overflowWrap: "anywhere" }}>
            {closing.map((seg, j) => (
              <span key={j}>{seg.text}</span>
            ))}
          </p>
        </>
      )}
    </section>
  );
}

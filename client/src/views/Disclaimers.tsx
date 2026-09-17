import { RATE_DISCLAIMER, groupSizeNote, type Group } from "@/lib/model";
import { C, h2, panel } from "@/lib/ui";

/**
 * Disclaimers: the full text behind every "View Disclaimers" link. One page,
 * plain, so the short line under a rate can stay short. Kennion is the
 * broker; nothing here is legal, tax or coverage advice.
 */
export default function Disclaimers({ g }: { g: Group }) {
  const size = groupSizeNote(g);
  const section = { ...panel, padding: "18px 22px", marginBottom: 14 } as const;
  const p = { margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.65, color: C.body } as const;
  return (
    <div style={{ maxWidth: 860 }}>
      <section style={section}>
        <h2 style={{ ...h2, margin: 0, fontSize: 16 }}>Rates and benefits</h2>
        <p style={p}>{RATE_DISCLAIMER}</p>
      </section>

      <section style={section}>
        <h2 style={{ ...h2, margin: 0, fontSize: 16 }}>Illustrative quotes</h2>
        <p style={p}>
          Every 2027 rate shown on BenSync, on a plan card, in the grid, in a comparison or in a downloaded file, is an illustrative quote read from the Carrier/TPA's document or built from it. It is not a proposal, an offer or a guarantee of coverage. Benefits are shown as printed on the Carrier/TPA's quote; the plan documents issued at enrollment govern.
        </p>
      </section>

      <section style={section}>
        <h2 style={{ ...h2, margin: 0, fontSize: 16 }}>Group size and the employer mandate</h2>
        <p style={p}>
          {size ||
            "Group size is based on the enrollment data on file for your group; tell us if your full-time equivalent count differs. At 50 or more full-time equivalent employees, the Affordable Care Act's employer mandate applies; under 50 it does not. The 50% starting point on the Medical Plans page is the Carrier/TPA's minimum contribution requirement, not an ACA affordability determination. The AI Assistant and your Kennion team can help you work through what applies before you decide."}
        </p>
        <p style={p}>BenSync does not determine whether a contribution or a plan is affordable or compliant under the Affordable Care Act. That determination is yours to make, with your Kennion team and your own advisors.</p>
      </section>

      <section style={section}>
        <h2 style={{ ...h2, margin: 0, fontSize: 16 }}>The AI Assistant and AI Picks</h2>
        <p style={p}>
          The AI Assistant and AI Picks work from the quotes, enrollment and census on file for your group. They can make mistakes. Their answers, picks and reasons are for discussion with your Kennion team, not advice, and nothing they say is an offer, a guarantee of coverage, or a legal, tax or compliance determination. Verify important information before you act on it.
        </p>
      </section>

      <section style={section}>
        <h2 style={{ ...h2, margin: 0, fontSize: 16 }}>Kennion Benefit Advisors</h2>
        <p style={p}>
          Kennion Benefit Advisors is your broker. BenSync is the platform Kennion built to present the market's options for your renewal; coverage is issued by the Carrier/TPA you enroll with, on that Carrier/TPA's terms. Your Kennion account manager is the person to call with any question about what is shown here.
        </p>
      </section>
    </div>
  );
}

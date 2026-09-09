import { useMemo } from "react";
import {
  hasDirectQuote,
  marketSummary,
  money,
  money0,
  type Group,
  type KennionData,
  type PlanRow,
} from "@/lib/model";
import { C, h2, num, panel, sectionHead } from "@/lib/ui";
import Link from "@/lib/Link";

interface Props {
  data: KennionData;
  g: Group;
  rows: PlanRow[];
  totals: { total: number };
  optionsHref: string;
  signUpHref: string;
}

/**
 * The first stop after Welcome: what actually changes on January 1, 2027,
 * before the full grid of every priced option. Same headline figure Your
 * New 2027 Medical Options builds (`marketSummary`, shared rather than recomputed), read
 * in one line instead of found by scanning a table.
 */
export default function WhatsChanging({ data, g, rows, totals, optionsHref, signUpHref }: Props) {
  const summary = useMemo(() => marketSummary(data, g, rows, totals.total), [data, g, rows, totals.total]);
  const direct = hasDirectQuote(data, g);

  const card = { ...panel, padding: "18px 20px" };

  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>What&rsquo;s Changing For 2027</h2>
      </div>

      <div style={card}>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65, color: C.body, textWrap: "pretty" as const }}>
          Your 2026 program ends December 31. For 2027, we took {g.name}&rsquo;s census to
          UnitedHealthcare, Surest and Gravie and priced every plan on their menus —{" "}
          {summary.pricedCount} option{summary.pricedCount === 1 ? "" : "s"} in all, effective January 1, 2027.
          {!direct && " Underwriting for your group is still open, so figures below are indicative until firm rates arrive."}
        </p>

        <div
          style={{
            marginTop: 16,
            display: "flex",
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            overflow: "hidden",
            width: "fit-content",
          }}
        >
          <div style={{ padding: "14px 22px", borderRight: `1px solid ${C.border}`, background: C.zebra }}>
            <div style={{ fontSize: 12.5, color: C.muted }}>Today</div>
            <div style={{ marginTop: 6, fontSize: 22, fontWeight: 600, color: C.ink, letterSpacing: "-0.4px", ...num }}>
              {money(totals.total)}
            </div>
            <div style={{ fontSize: 12, color: C.faint }}>per month</div>
          </div>
          <div style={{ padding: "14px 22px", background: C.zebra }}>
            <div style={{ fontSize: 12.5, color: C.muted }}>2027, plans mapped 1-for-1</div>
            <div style={{ marginTop: 6, fontSize: 22, fontWeight: 600, color: C.ink, letterSpacing: "-0.4px", ...num }}>
              {summary.mappedTotal ? money0(summary.mappedTotal) : "In progress"}
            </div>
            <div style={{ fontSize: 12, color: C.faint }}>
              {summary.delta == null
                ? "quotes arriving"
                : `${summary.delta >= 0 ? "+" : "−"}${money0(Math.abs(summary.delta))} / mo vs today${direct ? "" : " (indicative)"}`}
            </div>
          </div>
        </div>

        <p style={{ margin: "14px 0 0", fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
          This maps each current plan to its closest 2027 match. It is not a recommendation — see Your 2027
          Options for the full menu, including the plans we&rsquo;d actually suggest for your group.
        </p>
      </div>

      <div className="cardgrid" style={{ marginTop: 16 }}>
        <Link href={optionsHref} style={{ ...card, display: "block", color: "inherit", textDecoration: "none" }}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: C.blue }}>See New 2027 Medical Options &rarr;</div>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
            Every priced plan, side by side with what you pay now, plus what we&rsquo;d recommend for {g.name}.
          </p>
        </Link>
        <Link href={signUpHref} style={{ ...card, display: "block", color: "inherit", textDecoration: "none" }}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: C.green }}>Ready To Move Forward? &rarr;</div>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
            Shortlist plans and send them in, or get a kickoff call on the calendar — both live on Sign Up.
          </p>
        </Link>
      </div>
    </div>
  );
}
